const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword, requireRole, forgetStaffStatus } = require('../services/auth.service');
const { logAudit } = require('../services/audit.service');
const { previewStaff, removeStaff, sendError } = require('../services/staff-removal.service');
const {
  AccountError, ROLES, clean, readPhone, readPassword, temporaryPassword, findByPhone,
  assertNoDuplicateDoctor, createStaffLogin, inTransaction, sendAccountError,
} = require('../services/staff-accounts.service');

const STAFF_COLUMNS = 'id, clinic_id, name, role, phone, notify_on_flag, created_at, last_login_at, deactivated_at';

/**
 * GET /api/staff?clinic_id=&include_inactive=1
 * Lists staff accounts for a clinic (Settings page). Requires
 * authentication. Super admin can omit clinic_id (sees every clinic) or pass
 * any clinic_id; everyone else is pinned to their own clinic. Deactivated
 * staff are listed only with include_inactive=1 (admins), so they can be
 * brought back.
 */
router.get('/', requireRole('admin', 'coordinator', 'nurse', 'doctor', 'super_admin'), async (req, res) => {
  const isSuperAdmin = req.user.role === 'super_admin';
  const clinic_id = isSuperAdmin ? req.query.clinic_id : req.user.clinic_id;
  const withInactive = ['1', 'true'].includes(String(req.query.include_inactive)) && ['admin', 'super_admin'].includes(req.user.role);
  const active = withInactive ? 'TRUE' : 'deactivated_at IS NULL';

  try {
    const query = clinic_id
      ? { text: `SELECT ${STAFF_COLUMNS} FROM staff_users WHERE clinic_id = $1 AND ${active} ORDER BY (deactivated_at IS NULL) DESC, name`, values: [clinic_id] }
      : { text: `SELECT ${STAFF_COLUMNS} FROM staff_users WHERE ${active} ORDER BY name`, values: [] };

    const { rows } = await pool.query(query.text, query.values);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch staff:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/staff
 * Creates a staff login. Phone is saved in the one canonical format
 * ("91XXXXXXXXXX"). Role Doctor also creates the linked Doctors-list record
 * in the same transaction; a doctor whose name is already on the list gets a
 * 409 DUPLICATE_DOCTOR warning unless allow_duplicate is true. Re-adding the
 * phone of a REMOVED staff member of the same hospital brings that login back.
 * Response: { data: staff, doctor?: doctorRow, reactivated?: true }
 */
router.post('/', requireRole('admin', 'super_admin'), async (req, res) => {
  const clinic_id = req.user.role === 'super_admin' ? req.body.clinic_id : req.user.clinic_id;
  const name = clean(req.body.name);
  const role = clean(req.body.role);

  if (!clinic_id || !name || !role || !req.body.phone || !req.body.password) {
    return res.status(400).json({ error: 'clinic_id, name, role, phone, and password are required.' });
  }

  try {
    const { staff, doctor, reactivated } = await inTransaction(pool, async (db) => {
      if (role === 'doctor') await assertNoDuplicateDoctor(db, { clinicId: clinic_id, name, allowDuplicate: req.body.allow_duplicate === true });
      return createStaffLogin(db, {
        clinicId: clinic_id, name, role, phone: req.body.phone, password: req.body.password,
        notifyOnFlag: req.body.notify_on_flag ?? true, specialty: clean(req.body.specialty) || null,
      });
    });
    forgetStaffStatus(staff.id);
    await logAudit(req, reactivated ? 'staff.reactivate' : 'staff.create', { targetType: 'staff', targetId: staff.id, clinicId: clinic_id, details: { name, role } });
    return res.status(reactivated ? 200 : 201).json({ success: true, data: staff, doctor, ...(reactivated ? { reactivated: true } : {}) });
  } catch (error) {
    return sendAccountError(res, error, 'create staff account');
  }
});

/** Loads a staff row the caller (admin of that hospital, or super admin) may manage. */
async function manageable(req, id) {
  const { rows: [s] } = await pool.query(`SELECT ${STAFF_COLUMNS} FROM staff_users WHERE id = $1`, [id]);
  if (!s || (req.user.role !== 'super_admin' && s.clinic_id !== req.user.clinic_id)) throw new AccountError(404, 'Staff member not found.');
  return s;
}

/**
 * PATCH /api/staff/:id  { name?, phone?, role?, specialty? }
 * Edit a staff member (bug list #2, #8) — e.g. fix a mistyped login phone.
 * Rules: you can't change your own role (no locking yourself out); a doctor's
 * role isn't changed here (Deactivate them so their patients are reassigned,
 * then add them again); making someone a doctor adds them to the Doctors list.
 */
router.patch('/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const s = await manageable(req, req.params.id);
    const sets = []; const params = [s.id]; const changed = [];
    let name = s.name; let role = s.role;

    if (req.body.name !== undefined) {
      name = clean(req.body.name);
      if (!name) throw new AccountError(400, 'Name cannot be empty.');
      params.push(name); sets.push(`name = $${params.length}`); changed.push('name');
    }
    if (req.body.phone !== undefined) {
      const phone = readPhone(req.body.phone);
      const other = await findByPhone(pool, phone);
      if (other && other.id !== s.id) throw new AccountError(409, `This phone is already the login of ${other.name}${other.deactivated_at ? ' (deactivated)' : ''}.`);
      params.push(phone); sets.push(`phone = $${params.length}`); changed.push('phone');
    }
    if (req.body.role !== undefined && req.body.role !== s.role) {
      role = clean(req.body.role);
      if (!ROLES.includes(role)) throw new AccountError(400, 'Role must be admin, coordinator, nurse or doctor.');
      if (s.id === req.user.id) throw new AccountError(400, "You can't change your own role.");
      if (s.role === 'doctor') throw new AccountError(400, "A doctor's role can't be changed here. Deactivate them (their patients get reassigned), then add them again with the new role.");
      params.push(role); sets.push(`role = $${params.length}`); changed.push('role');
    }
    if (!sets.length && req.body.specialty === undefined) throw new AccountError(400, 'Nothing to change.');

    const staff = await inTransaction(pool, async (db) => {
      let row = s;
      if (sets.length) ({ rows: [row] } = await db.query(`UPDATE staff_users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${STAFF_COLUMNS}`, params));
      if (role === 'doctor') {
        const specialty = req.body.specialty !== undefined ? clean(req.body.specialty) || null : null;
        const { rows: [doc] } = await db.query('SELECT id FROM doctors WHERE staff_user_id = $1 AND removed_at IS NULL LIMIT 1', [s.id]);
        if (doc) await db.query('UPDATE doctors SET name = $2, specialty = coalesce($3, specialty) WHERE id = $1', [doc.id, name, specialty]);
        else await db.query('INSERT INTO doctors (clinic_id, name, specialty, staff_user_id) VALUES ($1, $2, $3, $4)', [s.clinic_id, name, specialty, s.id]);
      }
      return row;
    });
    forgetStaffStatus(s.id);
    await logAudit(req, 'staff.update', { targetType: 'staff', targetId: s.id, clinicId: s.clinic_id, details: { fields: changed } });
    return res.json({ success: true, data: staff });
  } catch (error) {
    return sendAccountError(res, error, 'update staff member');
  }
});

/**
 * POST /api/staff/:id/reset-password  { password? }
 * Admin sets a new temporary password for a staff member who forgot theirs
 * (bug list #2, #8, #9). Without `password` one is generated and returned
 * once, for the admin to pass on. For your own password use
 * /api/auth/change-password.
 */
router.post('/:id/reset-password', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const s = await manageable(req, req.params.id);
    if (s.id === req.user.id) throw new AccountError(400, 'Change your own password from your profile.');
    const generated = !req.body?.password;
    const password = generated ? temporaryPassword() : readPassword(req.body.password);
    await pool.query('UPDATE staff_users SET password_hash = $2 WHERE id = $1', [s.id, await hashPassword(password)]);
    await logAudit(req, 'staff.password_reset', { targetType: 'staff', targetId: s.id, clinicId: s.clinic_id });
    return res.json({ success: true, data: { id: s.id, name: s.name, phone: s.phone, ...(generated ? { temporary_password: password } : {}) } });
  } catch (error) {
    return sendAccountError(res, error, 'reset staff password');
  }
});

/**
 * POST /api/staff/:id/reactivate
 * Brings a deactivated staff member back (login works again; a doctor's
 * Doctors-list record returns). Their patients are not moved back.
 */
router.post('/:id/reactivate', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const s = await manageable(req, req.params.id);
    if (!s.deactivated_at) return res.json({ success: true, data: s });
    const staff = await inTransaction(pool, async (db) => {
      const { rows: [row] } = await db.query(
        `UPDATE staff_users SET deactivated_at = NULL, deactivated_by = NULL WHERE id = $1 RETURNING ${STAFF_COLUMNS}`, [s.id]);
      if (s.role === 'doctor') {
        await db.query(
          `UPDATE doctors SET removed_at = NULL WHERE id = (
             SELECT id FROM doctors WHERE staff_user_id = $1 ORDER BY created_at DESC LIMIT 1)`, [s.id]);
      }
      return row;
    });
    forgetStaffStatus(s.id);
    await logAudit(req, 'staff.reactivate', { targetType: 'staff', targetId: s.id, clinicId: s.clinic_id, details: { name: s.name } });
    return res.json({ success: true, data: staff });
  } catch (error) {
    return sendAccountError(res, error, 'reactivate staff member');
  }
});

/**
 * GET /api/staff/:id/removal
 * What "Deactivate" will affect: the linked doctor record, how many patients
 * are assigned to it, and the doctors they can be moved to.
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
 * Deactivates a staff member (never a hard delete): the login cannot sign in,
 * tokens stop working, the row is kept for the audit log; their doctor record
 * is retired and their patients move to reassign_to (or become unassigned).
 * POST /:id/reactivate undoes it.
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
