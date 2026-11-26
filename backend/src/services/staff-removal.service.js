const { pool } = require('../db');
const { logAudit } = require('./audit.service');
const { forgetStaffStatus } = require('./auth.service');

/**
 * Removing a staff member (Settings → Clinic staff → Remove, or Doctors → delete).
 *
 * "Add staff member" with role Doctor makes TWO rows: a staff_users login and a
 * doctors record (Doctors list, patient assignment). The old delete removed only
 * the doctors row, so the login stayed and could still sign in. Now one action
 * handles both, and nothing is hard-deleted:
 *
 *   - the login is DEACTIVATED (deactivated_at): cannot sign in, existing tokens
 *     stop working (attachUser checks it), no flag notifications — but the row
 *     stays, so the audit log, prescriptions and flags still name a real person;
 *   - the linked doctor record is RETIRED (removed_at): gone from the Doctors list,
 *     the assignment dropdowns and OCR doctor matching;
 *   - that doctor's patients go to the doctor the admin picks, or become
 *     unassigned; open flags follow them (to the new doctor's login, else the
 *     coordinator queue).
 */

class RemovalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Admins manage their own clinic; super admin any clinic. */
function assertClinic(req, clinicId) {
  if (req.user.role === 'super_admin') return;
  if (!clinicId || clinicId !== req.user.clinic_id) throw new RemovalError(404, 'Not found.');
}

async function loadStaff(db, id) {
  const { rows: [s] } = await db.query(
    'SELECT id, clinic_id, name, role, phone, deactivated_at FROM staff_users WHERE id = $1', [id]);
  return s || null;
}

async function activeDoctorsOfStaff(db, staffId) {
  const { rows } = await db.query(
    'SELECT id, clinic_id, name, specialty FROM doctors WHERE staff_user_id = $1 AND removed_at IS NULL', [staffId]);
  return rows;
}

async function patientCount(db, doctorIds) {
  if (!doctorIds.length) return 0;
  const { rows: [r] } = await db.query(
    'SELECT COUNT(*)::int AS n FROM patients WHERE assigned_doctor_id = ANY($1::uuid[])', [doctorIds]);
  return r.n;
}

async function otherDoctors(db, clinicId, excludeIds) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.specialty FROM doctors d
       LEFT JOIN staff_users s ON s.id = d.staff_user_id
      WHERE d.clinic_id = $1 AND d.removed_at IS NULL AND NOT (d.id = ANY($2::uuid[]))
        AND (s.id IS NULL OR s.deactivated_at IS NULL)
      ORDER BY d.name`, [clinicId, excludeIds]);
  return rows;
}

/** What removing this staff member affects — shown in the confirm dialog. */
async function previewStaff(req, staffId) {
  const s = await loadStaff(pool, staffId);
  if (!s) throw new RemovalError(404, 'Staff member not found.');
  assertClinic(req, s.clinic_id);
  const docs = await activeDoctorsOfStaff(pool, s.id);
  const ids = docs.map((d) => d.id);
  return {
    staff: { id: s.id, name: s.name, role: s.role, phone: s.phone, deactivated: !!s.deactivated_at },
    doctors: docs,
    patient_count: await patientCount(pool, ids),
    reassign_options: await otherDoctors(pool, s.clinic_id, ids),
  };
}

/** Same, starting from a Doctors-list row (may or may not have a login). */
async function previewDoctor(req, doctorId) {
  const { rows: [d] } = await pool.query('SELECT id, clinic_id, name, specialty, staff_user_id FROM doctors WHERE id = $1 AND removed_at IS NULL', [doctorId]);
  if (!d) throw new RemovalError(404, 'Doctor not found.');
  assertClinic(req, d.clinic_id);
  if (d.staff_user_id) {
    const s = await loadStaff(pool, d.staff_user_id);
    if (s && !s.deactivated_at) return previewStaff(req, s.id);
  }
  return {
    staff: null,
    doctors: [{ id: d.id, clinic_id: d.clinic_id, name: d.name, specialty: d.specialty }],
    patient_count: await patientCount(pool, [d.id]),
    reassign_options: await otherDoctors(pool, d.clinic_id, [d.id]),
  };
}

/** Moves patients (and their open flags) off the given doctors. */
async function reassignPatients(db, clinicId, doctorIds, reassignTo) {
  if (!doctorIds.length) return { moved: 0, to: null };
  let target = null;
  if (reassignTo) {
    const { rows: [t] } = await db.query(
      `SELECT d.id, d.name, d.staff_user_id FROM doctors d LEFT JOIN staff_users s ON s.id = d.staff_user_id
        WHERE d.id = $1 AND d.clinic_id = $2 AND d.removed_at IS NULL AND (s.id IS NULL OR s.deactivated_at IS NULL)`,
      [reassignTo, clinicId]);
    if (!t || doctorIds.includes(t.id)) throw new RemovalError(400, 'Pick an active doctor of this hospital to take over the patients.');
    target = t;
  }
  const { rowCount } = await db.query(
    'UPDATE patients SET assigned_doctor_id = $2 WHERE assigned_doctor_id = ANY($1::uuid[])', [doctorIds, target?.id || null]);
  return { moved: rowCount, to: target };
}

/**
 * Remove a staff member: deactivate the login, retire their doctor record(s),
 * move their patients. One transaction.
 */
async function removeStaff(req, staffId, { reassignTo = null } = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [s] } = await db.query(
      'SELECT id, clinic_id, name, role, phone, deactivated_at FROM staff_users WHERE id = $1 FOR UPDATE', [staffId]);
    if (!s) throw new RemovalError(404, 'Staff member not found.');
    assertClinic(req, s.clinic_id);
    if (s.id === req.user.id) throw new RemovalError(400, 'You cannot remove your own account.');
    if (s.role === 'super_admin') throw new RemovalError(403, 'A Super Admin account cannot be removed here.');
    if (s.deactivated_at) throw new RemovalError(409, `${s.name} is already removed.`);
    if (s.role === 'admin') {
      const { rows: [a] } = await db.query(
        "SELECT COUNT(*)::int AS n FROM staff_users WHERE clinic_id = $1 AND role = 'admin' AND deactivated_at IS NULL AND id <> $2", [s.clinic_id, s.id]);
      if (!a.n) throw new RemovalError(400, 'This is the last administrator of the hospital. Add another administrator first.');
    }

    const docs = await activeDoctorsOfStaff(db, s.id);
    const doctorIds = docs.map((d) => d.id);
    const moved = await reassignPatients(db, s.clinic_id, doctorIds, reassignTo);

    // Open flags waiting on this person: to the new doctor's login, else the coordinator queue.
    const { rowCount: flagsMoved } = await db.query(
      "UPDATE flags SET assigned_to = $2 WHERE assigned_to = $1 AND status <> 'resolved'", [s.id, moved.to?.staff_user_id || null]);
    if (doctorIds.length) await db.query('UPDATE doctors SET removed_at = now() WHERE id = ANY($1::uuid[])', [doctorIds]);
    await db.query(
      'UPDATE staff_users SET deactivated_at = now(), deactivated_by = $2, notify_on_flag = false WHERE id = $1', [s.id, req.user.id]);
    await db.query('COMMIT');
    forgetStaffStatus(s.id);

    const result = {
      staff: { id: s.id, name: s.name, role: s.role },
      doctors_removed: docs.map((d) => d.name),
      patients_moved: moved.moved,
      patients_assigned_to: moved.to ? moved.to.name : null,
      open_flags_moved: flagsMoved,
    };
    await logAudit(req, 'staff.deactivate', { targetType: 'staff', targetId: s.id, clinicId: s.clinic_id, details: { name: s.name, role: s.role, ...result } });
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Doctors-list delete: with a live login → removeStaff; without → retire the record only. */
async function removeDoctor(req, doctorId, { reassignTo = null } = {}) {
  const { rows: [d] } = await pool.query('SELECT id, clinic_id, name, staff_user_id FROM doctors WHERE id = $1 AND removed_at IS NULL', [doctorId]);
  if (!d) throw new RemovalError(404, 'Doctor not found.');
  assertClinic(req, d.clinic_id);
  if (d.staff_user_id) {
    const s = await loadStaff(pool, d.staff_user_id);
    if (s && !s.deactivated_at) return removeStaff(req, s.id, { reassignTo });
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const moved = await reassignPatients(db, d.clinic_id, [d.id], reassignTo);
    await db.query('UPDATE doctors SET removed_at = now() WHERE id = $1', [d.id]);
    await db.query('COMMIT');
    const result = { staff: null, doctors_removed: [d.name], patients_moved: moved.moved, patients_assigned_to: moved.to ? moved.to.name : null, open_flags_moved: 0 };
    await logAudit(req, 'doctor.remove', { targetType: 'doctor', targetId: d.id, clinicId: d.clinic_id, details: result });
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Express helper: RemovalError → its status, anything else → 500. */
function sendError(res, err, what) {
  if (err instanceof RemovalError) return res.status(err.status).json({ error: err.message });
  if (err.code === '22P02') return res.status(400).json({ error: 'Invalid id.' });
  console.error(`Failed to ${what}:`, err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { clean, previewStaff, previewDoctor, removeStaff, removeDoctor, sendError, RemovalError };
