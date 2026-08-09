const { pool } = require('../db');
const { sendWhatsAppMessage } = require('./whatsapp.service');

// Vercel serverless functions can't host a long-lived BullMQ Worker (see
// scheduler.service.js, used on the AWS/persistent-process deployment instead).
// This does the same due-checkin scan and send, synchronously, for a
// cron-triggered HTTP endpoint.

const MESSAGES = {
  hi: 'नमस्ते! यह आपके क्लिनिक से चेक-इन है। क्या आपने आज अपनी दवाइयां समय पर ली हैं? उत्तर दें: 1 (हाँ), 2 (नहीं/खुराक छूट गई)।',
  pa: 'ਸਤਿ ਸ਼੍ਰੀ ਅਕਾਲ! ਇਹ ਤੁਹਾਡੇ ਕਲਿਨਿਕ ਤੋਂ ਚੈੱਕ-ਇਨ ਹੈ। ਕੀ ਤੁਸੀਂ ਅੱਜ ਆਪਣੀਆਂ ਦਵਾਈਆਂ ਸਮੇਂ ਸਿਰ ਲਈਆਂ ਹਨ? ਜਵਾਬ ਦਿਓ: 1 (ਹਾਂ), 2 (ਨਹੀਂ)।',
  en: 'Hello! This is a check-in from your clinic. Did you take your prescribed medicines today on time? Reply: 1 (Yes), 2 (No/Missed dose).'
};

async function sendDueCheckinsDirectly() {
  const { rows } = await pool.query(`
    SELECT cs.id AS schedule_id, cs.patient_id, p.phone, p.language_pref
    FROM checkin_schedules cs
    JOIN patients p ON cs.patient_id = p.id
    WHERE cs.active = true
      AND cs.next_checkin_at <= NOW()
      AND p.kill_switch_active = false
      AND p.consent_given = true;
  `);

  let sent = 0;
  for (const row of rows) {
    const textPrompt = MESSAGES[row.language_pref] || MESSAGES.hi;
    try {
      await sendWhatsAppMessage(row.phone, textPrompt);

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
