const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole } = require('../services/auth.service');
const { clean, previewDoctor, removeDoctor, sendError } = require('../services/staff-removal.service');

/**
 * GET /api/doctors?clinic_id=
 * Lists doctors (Settings page, and assigned-doctor dropdowns on patient
 * enrollment). Requires authentication — same reasoning and the same
 * super-admin-can-see-any-clinic / everyone-else-pinned-to-their-own-clinic
 * rule as GET /api/staff.
 */
router.get('/', requireRole('admin', 'coordinator', 'nurse', 'doctor', 'super_admin'), async (req, res) => {
  const isSuperAdmin = req.user.role === 'super_admin';
  const clinic_id = isSuperAdmin ? req.query.clinic_id : req.user.clinic_id;

  try {
    const query = clinic_id
      ? { text: `SELECT d.id, d.clinic_id, d.name, d.specialty, d.staff_user_id, s.phone AS staff_phone
                 FROM doctors d LEFT JOIN staff_users s ON d.staff_user_id = s.id
                 WHERE d.clinic_id = $1 AND d.removed_at IS NULL ORDER BY d.name`, values: [clinic_id] }
      : { text: `SELECT d.id, d.clinic_id, d.name, d.specialty, d.staff_user_id, s.phone AS staff_phone
                 FROM doctors d LEFT JOIN staff_users s ON d.staff_user_id = s.id
                 WHERE d.removed_at IS NULL ORDER BY d.name`, values: [] };

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
router.post('/', requireRole('admin', 'super_admin'), async (req, res) => {
  const { staff_user_id } = req.body;
  const clinic_id = req.user.role === 'super_admin' ? req.body.clinic_id : req.user.clinic_id;
  const name = clean(req.body.name);
  const specialty = clean(req.body.specialty);

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
 * GET /api/doctors/:id/removal — what removing this doctor affects (see staff).
 */
router.get('/:id/removal', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    return res.json({ success: true, data: await previewDoctor(req, req.params.id) });
  } catch (err) {
    return sendError(res, err, 'preview doctor removal');
  }
});

/**
 * DELETE /api/doctors/:id?reassign_to=<doctorId>
 * Retires the doctor record (hidden from lists, kept for old prescriptions).
 * If the doctor has a staff login, that login is deactivated too — removing
 * only the record used to leave a login that could still sign in. Patients
 * move to reassign_to, or become unassigned when it is omitted.
 */
router.delete('/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const result = await removeDoctor(req, req.params.id, { reassignTo: req.query.reassign_to || null });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendError(res, err, 'remove doctor');
  }
});

module.exports = router;
