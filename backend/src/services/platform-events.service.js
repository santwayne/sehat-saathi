const { pool } = require('../db');

const SOURCES = ['webhook', 'queue', 'ocr', 'whatsapp_send', 'voice', 'media', 'integration', 'other'];

/**
 * Records an operational error for the Super Admin "Platform Health" page.
 * Never throws. Callers must keep patient data out of `message`/`details`:
 * pass ids and error text, never a name, phone number or message body.
 */
async function recordPlatformEvent({ source, message, clinicId = null, details = null, severity = 'error' }) {
  try {
    await pool.query(
      `INSERT INTO platform_events (source, severity, clinic_id, message, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        SOURCES.includes(source) ? source : 'other',
        severity === 'warning' ? 'warning' : 'error',
        clinicId,
        String(message || 'Unknown error').slice(0, 1000),
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    console.error('Failed to record platform event:', err.message);
  }
}

module.exports = { recordPlatformEvent, SOURCES };
