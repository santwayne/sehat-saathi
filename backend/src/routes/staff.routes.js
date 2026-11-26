const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword, requireRole, forgetStaffStatus } = require('../services/auth.service');
const { logAudit } = require('../services/audit.service');
const { clean, previewStaff, removeStaff, sendError } = require('../services/staff-removal.service');

/**
 * GET /api/staff?clinic_id=
 * Lists staff accounts for a clinic (Settings page). Requires
 * authentication — this used to be reachable with no token at all, trusting
 * whatever clinic_id (or none) the caller passed; harmless with one clinic
 * in the deployment, a real cross-tenant leak once there's more than one.
 * Super admin can omit clinic_id (sees every clinic) or pass any clinic_id
 * (clinic-switcher view); everyone else is pinned to their own clinic
 * regardless of what clinic_id they pass.
 */
router.get('/', requireRole('admin', 'coordinator', 'nurse', 'doctor', 'super_admin'), async (req, res) => {
  const isSuperAdmin = req.user.role === 'super_admin';
  const clinic_id = isSuperAdmin ? req.query.clinic_id : req.user.clinic_id;

  try {
    const query = clinic_id
      ? { text: 'SELECT id, clinic_id, name, role, phone, notify_on_flag, created_at FROM staff_users WHERE clinic_id = $1 AND deactivated_at IS NULL ORDER BY name', values: [clinic_id] }
      : { text: 'SELECT id, clinic_id, name, role, phone, notify_on_flag, created_at FROM staff_users WHERE deactivated_at IS NULL ORDER BY name', values: [] };

    const { rows } = await pool.query(query.text, query.values);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch staff:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/staff
 * Creates a staff login. Requires an authenticated admin. Name and phone are
 * trimmed (a trailing space in "dr priya " broke exact-name lookups).
 * Role Doctor also creates the linked Doctors-list record, in the same
 * transaction (it used to be a second call from the browser that could fail
 * on its own). Re-adding the phone of a REMOVED staff member of the same
 * hospital brings that login back (phones are unique), with the new details.
 * Response: { data: staff, doctor?: doctorRow, reactivated?: true }
 */
router.post('/', requireRole('admin', 'super_admin'), async (req, res) => {
  const { password, notify_on_flag = true } = req.body;
  const clinic_id = req.user.role === 'super_admin' ? req.body.clinic_id : req.user.clinic_id;
  const name = clean(req.body.name);
  const role = clean(req.body.role);
  const phone = String(req.body.phone ?? '').trim();
  const specialty = clean(req.body.specialty) || null;

  if (!clinic_id || !name || !role || !phone || !password) {
    return res.status(400).json({ error: 'clinic_id, name, role, phone, and password are required.' });
  }
  if (!['admin', 'coordinator', 'nurse', 'doctor'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin, coordinator, nurse or doctor.' });
  }
  if (!/^\+?[\d\s-]{10,20}$/.test(phone) || !/^\d{10,15}$/.test(phone.replace(/\D/g, ''))) {
    return res.status(400).json({ error: 'Enter a valid phone number (10–15 digits).' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const password_hash = await hashPassword(password);
    const digits = phone.replace(/\D/g, '');
    const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
    const { rows: [old] } = await db.query(
      `SELECT id, clinic_id, deactivated_at FROM staff_users
        WHERE regexp_replace(phone, '\\D', '', 'g') IN ($1, $2, $3)
        ORDER BY (deactivated_at IS NULL) DESC LIMIT 1`, [digits, national, `91${national}`]);

    let staff; let reactivated = false;
    if (old && !(old.deactivated_at && old.clinic_id === clinic_id)) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: old.deactivated_at ? 'This phone belongs to a removed account of another hospital.' : 'A staff account with this phone number already exists.' });
    }
    if (old) {
      ({ rows: [staff] } = await db.query(
        `UPDATE staff_users SET name = $2, role = $3, phone = $4, password_hash = $5, notify_on_flag = $6, deactivated_at = NULL, deactivated_by = NULL
          WHERE id = $1 RETURNING id, clinic_id, name, role, phone, notify_on_flag, created_at`,
        [old.id, name, role, phone, password_hash, notify_on_flag]));
      reactivated = true;
    } else {
      ({ rows: [staff] } = await db.query(
        `INSERT INTO staff_users (clinic_id, name, role, phone, password_hash, notify_on_flag)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, clinic_id, name, role, phone, notify_on_flag, created_at`,
        [clinic_id, name, role, phone, password_hash, notify_on_flag]));
    }

    let doctor = null;
    if (role === 'doctor') {
      // A returning doctor gets their old record back (old prescriptions stay linked).
      const { rows: [prev] } = await db.query(
        'SELECT id FROM doctors WHERE staff_user_id = $1 ORDER BY (removed_at IS NULL) DESC, created_at DESC LIMIT 1', [staff.id]);
      ({ rows: [doctor] } = prev
        ? await db.query('UPDATE doctors SET name = $2, specialty = coalesce($3, specialty), removed_at = NULL WHERE id = $1 RETURNING *', [prev.id, name, specialty])
        : await db.query('INSERT INTO doctors (clinic_id, name, specialty, staff_user_id) VALUES ($1, $2, $3, $4) RETURNING *', [clinic_id, name, specialty, staff.id]));
    }
    await db.query('COMMIT');
    forgetStaffStatus(staff.id);
    await logAudit(req, reactivated ? 'staff.reactivate' : 'staff.create', { targetType: 'staff', targetId: staff.id, clinicId: clinic_id, details: { name, role } });
    return res.status(reactivated ? 200 : 201).json({ success: true, data: staff, doctor, ...(reactivated ? { reactivated: true } : {}) });
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A staff account with this phone number already exists.' });
    }
    console.error('Failed to create staff account:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    db.release();
  }
});

/**
 * GET /api/staff/:id/removal
 * What "Remove" will affect: the linked doctor record, how many patients are
 * assigned to it, and the doctors they can be moved to.
 */
router.get('/:id/removal', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    return res.json({ success: true, data: await previewStaff(req, req.params.id) });
  } catch (err) {
    return sendError(res, err, 'preview staff removal');
  }
});

/**
 * DELETE /api/staff/:id?reassign_to=<doctorId>
 * Removes a staff member: deactivates the login (cannot sign in, tokens stop
 * working; row kept for the audit log), retires their doctor record, and moves
 * their patients to reassign_to (or leaves them unassigned when omitted).
 */
router.delete('/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const result = await removeStaff(req, req.params.id, { reassignTo: req.query.reassign_to || null });
    return res.json({ success: true, data: result });
  } catch (err) {
    return sendError(res, err, 'remove staff');
  }
});

module.exports = router;
