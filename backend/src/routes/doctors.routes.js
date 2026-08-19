const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole } = require('../services/auth.service');

/**
 * GET /api/doctors?clinic_id=
 * Lists doctors (Settings page, and assigned-doctor dropdowns on patient enrollment).
 */
router.get('/', async (req, res) => {
  const { clinic_id } = req.query;

  try {
    const query = clinic_id
      ? { text: `SELECT d.id, d.clinic_id, d.name, d.specialty, d.staff_user_id, s.phone AS staff_phone
                 FROM doctors d LEFT JOIN staff_users s ON d.staff_user_id = s.id
                 WHERE d.clinic_id = $1 ORDER BY d.name`, values: [clinic_id] }
      : { text: `SELECT d.id, d.clinic_id, d.name, d.specialty, d.staff_user_id, s.phone AS staff_phone
                 FROM doctors d LEFT JOIN staff_users s ON d.staff_user_id = s.id
                 ORDER BY d.name`, values: [] };

    const { rows } = await pool.query(query.text, query.values);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch doctors:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/doctors
 * Registers a doctor, optionally linked to a staff_users login so flags route
 * to them directly (Section 5). Requires an authenticated admin.
 */
router.post('/', requireRole('admin'), async (req, res) => {
  const { clinic_id, name, specialty, staff_user_id } = req.body;

  if (!clinic_id || !name) {
    return res.status(400).json({ error: 'clinic_id and name are required.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO doctors (clinic_id, name, specialty, staff_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [clinic_id, name, specialty || null, staff_user_id || null]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to create doctor:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/doctors/:id
 * Removes a doctor record. Any patient currently assigned to this doctor
 * keeps their record — assigned_doctor_id falls back to NULL via the
 * existing ON DELETE SET NULL foreign key (schema.sql), it just shows as
 * unassigned rather than being blocked or cascaded away. Admin-only,
 * matching POST above.
 */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query('DELETE FROM doctors WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Doctor not found.' });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to delete doctor:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
