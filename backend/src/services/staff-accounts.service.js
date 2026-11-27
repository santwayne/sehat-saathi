const crypto = require('crypto');
const { hashPassword } = require('./auth.service');
const { normalizePhone, isValidPhone, phoneVariants } = require('./phone');

/**
 * Creating staff logins — one place for "Add staff", "Add doctor" (with login
 * access) and "Create login" on an existing doctor (bug list 27 Nov 2026,
 * #1 and #12). A doctor is always a staff account with role doctor plus its
 * Doctors-list record; the only doctor without a login is one added with
 * "Give login access" switched off.
 */

class AccountError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const ROLES = ['admin', 'coordinator', 'nurse', 'doctor'];
const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Checks + normalises a phone typed by an admin. */
function readPhone(input) {
  const phone = normalizePhone(input);
  if (!isValidPhone(phone)) {
    throw new AccountError(400, 'Enter a valid mobile number: 10 digits (e.g. 9876543210), or with country code.');
  }
  return phone;
}

function readPassword(p, min = 8) {
  if (!p || String(p).length < min) throw new AccountError(400, `Password must be at least ${min} characters.`);
  return String(p);
}

/** A readable temporary password: no 0/O/1/l/I, 10 characters. */
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** The staff row using this phone, in any stored form (active first). */
async function findByPhone(db, phone) {
  const { rows: [row] } = await db.query(
    `SELECT id, clinic_id, name, role, deactivated_at FROM staff_users
      WHERE regexp_replace(phone, '\\D', '', 'g') = ANY($1::text[])
      ORDER BY (deactivated_at IS NULL) DESC LIMIT 1`,
    [phoneVariants(phone)]);
  return row || null;
}

/**
 * Duplicate-doctor warning (#12): an active doctor with the same name, or a
 * login with the same phone, in this hospital. Throws 409 code
 * DUPLICATE_DOCTOR unless the admin confirmed (allowDuplicate).
 */
async function assertNoDuplicateDoctor(db, { clinicId, name, excludeDoctorId = null, allowDuplicate = false }) {
  if (allowDuplicate) return;
  const { rows } = await db.query(
    `SELECT d.id, d.name FROM doctors d
      WHERE d.clinic_id = $1 AND d.removed_at IS NULL AND lower(d.name) = lower($2)
        AND ($3::uuid IS NULL OR d.id <> $3)
      LIMIT 1`, [clinicId, name, excludeDoctorId]);
  if (rows[0]) {
    throw new AccountError(409, `A doctor named "${rows[0].name}" is already on the Doctors list. Add anyway?`, 'DUPLICATE_DOCTOR');
  }
}

/**
 * Creates (or brings back) a staff login. Runs inside the caller's
 * transaction (`db` is a checked-out client after BEGIN).
 *   linkDoctorId: an existing Doctors-list row to attach the new login to
 *                 ("Create login" on a doctor) instead of making a new record.
 * Returns { staff, doctor, reactivated }.
 */
async function createStaffLogin(db, { clinicId, name, role, phone, password, notifyOnFlag = true, specialty = null, linkDoctorId = null }) {
  name = clean(name);
  if (!clinicId || !name) throw new AccountError(400, 'Name is required.');
  if (!ROLES.includes(role)) throw new AccountError(400, 'Role must be admin, coordinator, nurse or doctor.');
  phone = readPhone(phone);
  const passwordHash = await hashPassword(readPassword(password));

  const old = await findByPhone(db, phone);
  if (old && !(old.deactivated_at && old.clinic_id === clinicId)) {
    throw new AccountError(409, old.deactivated_at
      ? 'This phone belongs to a removed account of another hospital.'
      : `This phone is already the login of ${old.name}.`);
  }

  let staff; let reactivated = false;
  if (old) {
    ({ rows: [staff] } = await db.query(
      `UPDATE staff_users SET name = $2, role = $3, phone = $4, password_hash = $5, notify_on_flag = $6, deactivated_at = NULL, deactivated_by = NULL
        WHERE id = $1 RETURNING id, clinic_id, name, role, phone, notify_on_flag, created_at, last_login_at`,
      [old.id, name, role, phone, passwordHash, notifyOnFlag]));
    reactivated = true;
  } else {
    ({ rows: [staff] } = await db.query(
      `INSERT INTO staff_users (clinic_id, name, role, phone, password_hash, notify_on_flag)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, clinic_id, name, role, phone, notify_on_flag, created_at, last_login_at`,
      [clinicId, name, role, phone, passwordHash, notifyOnFlag]));
  }

  let doctor = null;
  if (role === 'doctor') {
    if (linkDoctorId) {
      ({ rows: [doctor] } = await db.query(
        `UPDATE doctors SET staff_user_id = $2, specialty = coalesce($3, specialty)
          WHERE id = $1 AND clinic_id = $4 AND removed_at IS NULL AND staff_user_id IS NULL RETURNING *`,
        [linkDoctorId, staff.id, specialty, clinicId]));
      if (!doctor) throw new AccountError(409, 'This doctor already has a login.');
    } else {
      // A returning doctor gets their old record back (old prescriptions stay linked).
      const { rows: [prev] } = await db.query(
        'SELECT id FROM doctors WHERE staff_user_id = $1 ORDER BY (removed_at IS NULL) DESC, created_at DESC LIMIT 1', [staff.id]);
      ({ rows: [doctor] } = prev
        ? await db.query('UPDATE doctors SET name = $2, specialty = coalesce($3, specialty), removed_at = NULL WHERE id = $1 RETURNING *', [prev.id, name, specialty])
        : await db.query('INSERT INTO doctors (clinic_id, name, specialty, staff_user_id) VALUES ($1, $2, $3, $4) RETURNING *', [clinicId, name, specialty, staff.id]));
    }
  }
  return { staff, doctor, reactivated };
}

/** Runs fn(client) in a transaction. */
async function inTransaction(pool, fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

function sendAccountError(res, err, what) {
  if (err instanceof AccountError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  if (err.status && err.message) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'A staff account with this phone number already exists.' });
  if (err.code === '22P02') return res.status(400).json({ error: 'Invalid id.' });
  console.error(`Failed to ${what}:`, err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = {
  AccountError, ROLES, clean, readPhone, readPassword, temporaryPassword, findByPhone,
  assertNoDuplicateDoctor, createStaffLogin, inTransaction, sendAccountError,
};
