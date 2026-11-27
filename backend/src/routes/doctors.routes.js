const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole, forgetStaffStatus } = require('../services/auth.service');
const { logAudit } = require('../services/audit.service');
const { previewDoctor, removeDoctor, sendError } = require('../services/staff-removal.service');
const {
  AccountError, clean, assertNoDuplicateDoctor, createStaffLogin, inTransaction, sendAccountError,
} = require('../services/staff-accounts.service');

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
      ? { text: `SELECT d.id, d.clinic_id, d.name, d.specialty, d.staff_user_id, CASE WHEN s.deactivated_at IS NULL THEN s.phone END AS staff_phone
                 FROM doctors d LEFT JOIN staff_users s ON d.staff_user_id = s.id
                 WHERE d.clinic_id = $1 AND d.removed_at IS NULL ORDER BY d.name`, values: [clinic_id] }
      : { text: `SELECT d.id, d.clinic_id, d.name, d.specialty, d.staff_user_id, CASE WHEN s.deactivated_at IS NULL THEN s.phone END AS staff_phone
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
 * Adds a doctor (Settings → Doctors → Add doctor). Bug list 27 Nov 2026 #1/#12:
 * this used to save only name + specialty, so the doctor had no login and
 * testers couldn't sign in as them. Now:
 *   { name, specialty?, login: { phone, password } }  → staff login (role
 *       doctor) + Doctors-list record, together — same as Add staff → Doctor;
 *   { name, specialty? } without `login`             → list entry only (a
 *       visiting doctor who never signs in); "Create login" can add one later.
 * Same name as an active doctor → 409 DUPLICATE_DOCTOR unless allow_duplicate.
 */
router.post('/', requireRole('admin', 'super_admin'), async (req, res) => {
  const clinic_id = req.user.role === 'super_admin' ? req.body.clinic_id : req.user.clinic_id;
  const name = clean(req.body.name);
  const specialty = clean(req.body.specialty) || null;
  const login = req.body.login;

  if (!clinic_id || !name) {
    return res.status(400).json({ error: 'clinic_id and name are required.' });
  }

  try {
    const out = await inTransaction(pool, async (db) => {
      await assertNoDuplicateDoctor(db, { clinicId: clinic_id, name, allowDuplicate: req.body.allow_duplicate === true });
      if (login) {
        if (!login.phone || !login.password) throw new AccountError(400, 'Phone and temporary password are required for login access.');
        return createStaffLogin(db, { clinicId: clinic_id, name, role: 'doctor', phone: login.phone, password: login.password, specialty });
      }
      const { rows } = await db.query(
        'INSERT INTO doctors (clinic_id, name, specialty) VALUES ($1, $2, $3) RETURNING *', [clinic_id, name, specialty]);
      return { doctor: rows[0], staff: null };
    });
    if (out.staff) {
      forgetStaffStatus(out.staff.id);
      await logAudit(req, out.reactivated ? 'staff.reactivate' : 'staff.create', { targetType: 'staff', targetId: out.staff.id, clinicId: clinic_id, details: { name, role: 'doctor' } });
    }
    return res.status(201).json({ success: true, data: { ...out.doctor, staff_phone: out.staff?.phone ?? null }, staff: out.staff });
  } catch (error) {
    return sendAccountError(res, error, 'create doctor');
  }
});

/**
 * POST /api/doctors/:id/login  { phone, password }
 * "Create login" for a doctor added without one: makes the staff login and
 * links it to this Doctors-list record (no second doctor is created).
 */
router.post('/:id/login', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { rows: [doc] } = await pool.query('SELECT * FROM doctors WHERE id = $1 AND removed_at IS NULL', [req.params.id]);
    if (!doc || (req.user.role !== 'super_admin' && doc.clinic_id !== req.user.clinic_id)) throw new AccountError(404, 'Doctor not found.');
    if (doc.staff_user_id) throw new AccountError(409, 'This doctor already has a login.');
    const { phone, password } = req.body || {};
    if (!phone || !password) throw new AccountError(400, 'Phone and temporary password are required.');
    const out = await inTransaction(pool, (db) => createStaffLogin(db, {
      clinicId: doc.clinic_id, name: doc.name, role: 'doctor', phone, password, linkDoctorId: doc.id,
    }));
    forgetStaffStatus(out.staff.id);
    await logAudit(req, 'staff.create', { targetType: 'staff', targetId: out.staff.id, clinicId: doc.clinic_id, details: { name: doc.name, role: 'doctor', doctorId: doc.id } });
    return res.status(201).json({ success: true, data: { ...out.doctor, staff_phone: out.staff.phone }, staff: out.staff });
  } catch (error) {
    return sendAccountError(res, error, 'create doctor login');
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
