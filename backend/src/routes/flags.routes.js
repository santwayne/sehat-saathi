const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { recordResolution } = require('../services/doctor-match.service');

/**
 * GET /api/flags
 * Fetches flags filtered by role and staff permissions
 */
router.get('/', async (req, res) => {
  const { staff_id, role, status = 'open' } = req.query;

  try {
    let query = `
      SELECT
        f.id, f.flag_type, f.priority, f.status, f.created_at,
        p.id AS patient_id, p.name AS patient_name, p.phone AS patient_phone,
        d.name AS doctor_name
      FROM flags f
      JOIN patients p ON f.patient_id = p.id
      LEFT JOIN doctors d ON p.assigned_doctor_id = d.id
      WHERE f.status = $1
    `;
    const params = [status];

    // Multi-doctor filtering: Doctors only see their assigned patients, admins/coordinators see all
    if (role === 'doctor' && staff_id) {
      query += ` AND (f.assigned_to = $2 OR p.assigned_doctor_id = (SELECT id FROM doctors WHERE staff_user_id = $2))`;
      params.push(staff_id);
    }

    query += ` ORDER BY CASE WHEN f.priority = 'urgent' THEN 1 ELSE 2 END, f.created_at DESC;`;

    const { rows } = await pool.query(query, params);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch flags:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/flags/:id/resolve
 * Marks a flag as resolved
 */
router.patch('/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { staff_id } = req.body;

  try {
    const query = `
      UPDATE flags
      SET status = 'resolved', resolved_at = NOW(), assigned_to = $1
      WHERE id = $2 RETURNING *;
    `;
    const { rows } = await pool.query(query, [staff_id, id]);
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to resolve flag' });
  }
});

/**
 * PATCH /api/flags/:id/resolve-doctor-match
 * Resolves a 'doctor_match_conflict' flag (Section 7: a new document/voice
 * note named a different doctor than the one already assigned) by staff
 * picking the correct doctor. Reassigns the patient AND feeds the
 * correction back into the matching engine's learning loop (Section 8.2) —
 * the raw phrase that was mismatched becomes a known alias for whichever
 * doctor staff actually picked, via the most recent unresolved
 * doctor_match_log row for this patient.
 */
router.patch('/:id/resolve-doctor-match', async (req, res) => {
  const { id } = req.params;
  const { staff_id, doctor_id } = req.body;

  if (!doctor_id) {
    return res.status(400).json({ error: 'doctor_id is required.' });
  }

  try {
    const flagRes = await pool.query('SELECT id, patient_id FROM flags WHERE id = $1', [id]);
    const flag = flagRes.rows[0];
    if (!flag) {
      return res.status(404).json({ error: 'Flag not found.' });
    }
    if (!flag.patient_id) {
      return res.status(400).json({ error: 'This flag has no associated patient yet — resolve it by enrolling the patient manually instead.' });
    }

    await pool.query('UPDATE patients SET assigned_doctor_id = $1 WHERE id = $2', [doctor_id, flag.patient_id]);

    const logRes = await pool.query(
      `SELECT id, raw_input FROM doctor_match_log
       WHERE patient_id = $1 AND staff_corrected_to IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [flag.patient_id]
    );
    const lastMatch = logRes.rows[0];
    if (lastMatch) {
      await recordResolution({
        matchLogId: lastMatch.id,
        resolvedDoctorId: doctor_id,
        rawInput: lastMatch.raw_input,
        learnedFrom: 'staff_correction',
      });
    }

    const { rows } = await pool.query(
      `UPDATE flags SET status = 'resolved', resolved_at = NOW(), assigned_to = $1 WHERE id = $2 RETURNING *`,
      [staff_id || null, id]
    );

    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to resolve doctor-match flag:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/flags/patients/:id/kill-switch
 * Instant kill switch to block/resume all automated outbound messages (Section 6.3)
 */
router.post('/patients/:id/kill-switch', async (req, res) => {
  const { id } = req.params;
  const { active } = req.body; // boolean

  try {
    const query = `UPDATE patients SET kill_switch_active = $1 WHERE id = $2 RETURNING id, kill_switch_active;`;
    const { rows } = await pool.query(query, [active, id]);
    return res.status(200).json({
      success: true,
      message: `Kill switch set to ${active}`,
      patient: rows[0]
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to toggle kill switch' });
  }
});

module.exports = router;
