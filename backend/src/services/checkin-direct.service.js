const { pool } = require('../db');
const { sendWhatsAppMessage } = require('./whatsapp.service');
const { t } = require('./i18n');
const voice = require('./voice.service');

// Vercel serverless functions can't host a long-lived BullMQ Worker (see
// scheduler.service.js, used on the AWS/persistent-process deployment instead).
// This does the same due-checkin scan and send, synchronously, for a
// cron-triggered HTTP endpoint.

async function sendDueCheckinsDirectly() {
  const { rows } = await pool.query(`
    SELECT cs.id AS schedule_id, cs.patient_id, p.phone, p.language_pref, p.clinic_id, p.preferred_channel
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
      // Patients who prefer voice get a call when Twilio is set up; if the call
      // can't be placed (or voice isn't configured) they still get the WhatsApp
      // check-in rather than silently missing it.
      let calledInstead = false;
      if (row.preferred_channel === 'voice' && voice.isConfigured()) {
        try {
          await voice.placeCheckinCall({ id: row.patient_id, phone: row.phone, language_pref: row.language_pref });
          calledInstead = true;
        } catch (callErr) {
          console.error(`Voice check-in call failed for patient ${row.patient_id}, falling back to WhatsApp:`, callErr.message);
        }
      }
      if (!calledInstead) await sendWhatsAppMessage(row.phone, textPrompt, row.clinic_id);

      await pool.query(
        `UPDATE checkin_schedules
         SET next_checkin_at = NOW() + (frequency_days || ' days')::INTERVAL
         WHERE id = $1`,
        [row.schedule_id]
      );

      if (!calledInstead) {
        await pool.query(
          `INSERT INTO conversations (patient_id, channel, direction, message_text, intent_type)
           VALUES ($1, 'whatsapp', 'outbound', $2, 'checkin_response')`,
          [row.patient_id, textPrompt]
        );
      }
      sent += 1;
    } catch (err) {
      console.error(`Failed to send check-in for schedule ${row.schedule_id}:`, err);
    }
  }
  return { scanned: rows.length, sent };
}

module.exports = { sendDueCheckinsDirectly };
