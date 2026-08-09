const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { pool } = require('../db');
const { sendWhatsAppMessage } = require('./whatsapp.service');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

// Define BullMQ Queue for Check-ins
const checkinQueue = new Queue('patient-checkins', { connection });

/**
 * BullMQ Worker: Processes individual check-in jobs
 */
const checkinWorker = new Worker(
  'patient-checkins',
  async (job) => {
    const { scheduleId, patientId, phone, languagePref } = job.data;

    // Verify patient hasn't activated the kill switch (Section 6.3)
    const patientCheck = await pool.query(
      'SELECT kill_switch_active, consent_given FROM patients WHERE id = $1',
      [patientId]
    );

    const patient = patientCheck.rows[0];
    if (!patient || patient.kill_switch_active || !patient.consent_given) {
      console.log(`Skipping check-in for patient ${patientId}: Kill switch active or consent revoked.`);
      return;
    }

    // Localized message content
    const messages = {
      hi: 'नमस्ते! यह आपके क्लिनिक से चेक-इन है। क्या आपने आज अपनी दवाइयां समय पर ली हैं? उत्तर दें: 1 (हाँ), 2 (नहीं/खुराक छूट गई)।',
      pa: 'ਸਤਿ ਸ਼੍ਰੀ ਅਕਾਲ! ਇਹ ਤੁਹਾਡੇ ਕਲਿਨਿਕ ਤੋਂ ਚੈੱਕ-ਇਨ ਹੈ। ਕੀ ਤੁਸੀਂ ਅੱਜ ਆਪਣੀਆਂ ਦਵਾਈਆਂ ਸਮੇਂ ਸਿਰ ਲਈਆਂ ਹਨ? ਜਵਾਬ ਦਿਓ: 1 (ਹਾਂ), 2 (ਨਹੀਂ)।',
      en: 'Hello! This is a check-in from your clinic. Did you take your prescribed medicines today on time? Reply: 1 (Yes), 2 (No/Missed dose).'
    };

    const textPrompt = messages[languagePref] || messages['hi'];

    // Send WhatsApp check-in
    await sendWhatsAppMessage(phone, textPrompt);

    // Update DB: bump next_checkin_at by frequency_days
    await pool.query(
      `UPDATE checkin_schedules
       SET next_checkin_at = NOW() + (frequency_days || ' days')::INTERVAL
       WHERE id = $1`,
      [scheduleId]
    );

    // Record outgoing checkin conversation entry
    await pool.query(
      `INSERT INTO conversations (patient_id, channel, direction, message_text, intent_type)
       VALUES ($1, 'whatsapp', 'outbound', $2, 'checkin_response')`,
      [patientId, textPrompt]
    );
  },
  { connection }
);

checkinWorker.on('failed', (job, err) => {
  console.error(`Check-in job ${job?.id} failed:`, err);
});

/**
 * Cron Job / Periodic Scanner: Searches for due check-ins and pushes to queue
 */
async function scanAndScheduleDueCheckins() {
  try {
    const query = `
      SELECT
        cs.id AS schedule_id,
        cs.patient_id,
        p.phone,
        p.language_pref,
        pr.structured_json
      FROM checkin_schedules cs
      JOIN patients p ON cs.patient_id = p.id
      JOIN prescriptions pr ON cs.prescription_id = pr.id
      WHERE cs.active = true
        AND cs.next_checkin_at <= NOW()
        AND p.kill_switch_active = false;
    `;

    const { rows } = await pool.query(query);

    for (const row of rows) {
      await checkinQueue.add(
        'send-checkin',
        {
          scheduleId: row.schedule_id,
          patientId: row.patient_id,
          phone: row.phone,
          languagePref: row.language_pref,
          medicines: row.structured_json?.medicines || [],
        },
        { jobId: `checkin-${row.schedule_id}-${Date.now()}` }
      );
    }
  } catch (err) {
    console.error('Error scanning due check-ins:', err);
  }
}

module.exports = {
  checkinQueue,
  checkinWorker,
  scanAndScheduleDueCheckins,
};
