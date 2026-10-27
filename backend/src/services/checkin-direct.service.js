const { pool } = require('../db');
const { sendWhatsAppMessage } = require('./whatsapp.service');
const { t } = require('./i18n');

// Vercel serverless functions can't host a long-lived BullMQ Worker (see
// scheduler.service.js, used on the AWS/persistent-process deployment instead).
// This does the same due-checkin scan and send, synchronously, for a
// cron-triggered HTTP endpoint.

async function sendDueCheckinsDirectly() {
  const { rows } = await pool.query(`
    SELECT cs.id AS schedule_id, cs.patient_id, p.phone, p.language_pref, p.clinic_id
    FROM checkin_schedules cs
    JOIN patients p ON cs.patient_id = p.id
    WHERE cs.active = true
      AND cs.next_checkin_at <= NOW()
      AND p.kill_switch_active = false
      AND p.consent_given = true;
  `);

  let sent = 0;
  for (const row of rows) {
    const textPrompt = t('checkin', row.language_pref);
    try {
      await sendWhatsAppMessage(row.phone, textPrompt, row.clinic_id);

      await pool.query(
        `UPDATE checkin_schedules
         SET next_checkin_at = NOW() + (frequency_days || ' days')::INTERVAL
         WHERE id = $1`,
        [row.schedule_id]
      );

      await pool.query(
        `INSERT INTO conversations (patient_id, channel, direction, message_text, intent_type)
         VALUES ($1, 'whatsapp', 'outbound', $2, 'checkin_response')`,
        [row.patient_id, textPrompt]
      );
      sent += 1;
    } catch (err) {
      console.error(`Failed to send check-in for schedule ${row.schedule_id}:`, err);
    }
  }
  return { scanned: rows.length, sent };
}

module.exports = { sendDueCheckinsDirectly };
