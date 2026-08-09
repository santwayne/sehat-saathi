const express = require('express');
const router = express.Router();
const { pool } = require('../db');

/**
 * GET /api/prescriptions/pending
 * Fetches prescriptions requiring manual staff verification
 */
router.get('/pending', async (req, res) => {
  try {
    const query = `
      SELECT
        p.id,
        p.image_url,
        p.ocr_raw_text,
        p.structured_json,
        p.ocr_confidence,
        p.created_at,
        pat.name AS patient_name,
        pat.phone AS patient_phone,
        pat.language_pref
      FROM prescriptions p
      JOIN patients pat ON p.patient_id = pat.id
      WHERE p.verified_by_staff = false
      ORDER BY p.created_at ASC;
    `;
    const { rows } = await pool.query(query);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch pending prescriptions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/prescriptions/:id/verify
 * Allows staff to correct/approve the structured prescription data
 */
router.post('/:id/verify', async (req, res) => {
  const { id } = req.params;
  const { structured_json, staff_user_id } = req.body;

  if (!structured_json || !staff_user_id) {
    return res.status(400).json({ error: 'Missing required payload fields.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Mark prescription as verified and store human-verified JSON
    const updatePrescription = `
      UPDATE prescriptions
      SET
        structured_json = $1,
        verified_by_staff = true,
        verified_by = $2
      WHERE id = $3
      RETURNING *;
    `;
    const prescriptionRes = await client.query(updatePrescription, [
      JSON.stringify(structured_json),
      staff_user_id,
      id,
    ]);

    if (prescriptionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Prescription record not found.' });
    }

    const prescription = prescriptionRes.rows[0];

    // 2. Initialize or refresh the check-in schedule (default 1-day check-in cadence).
    // Upserts on (patient_id, prescription_id) so re-verifying doesn't spawn duplicate schedules.
    const upsertSchedule = `
      INSERT INTO checkin_schedules (patient_id, prescription_id, frequency_days, next_checkin_at, active)
      VALUES ($1, $2, 1, NOW() + INTERVAL '1 day', true)
      ON CONFLICT (patient_id, prescription_id)
      DO UPDATE SET active = true, next_checkin_at = NOW() + INTERVAL '1 day';
    `;
    await client.query(upsertSchedule, [prescription.patient_id, prescription.id]);

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: 'Prescription verified and schedule activated.',
      prescription: prescriptionRes.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to verify prescription:', error);
    return res.status(500).json({ error: 'Failed to update prescription.' });
  } finally {
    client.release();
  }
});

module.exports = router;
