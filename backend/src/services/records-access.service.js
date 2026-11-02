const { pool } = require('../db');

/**
 * Who may open patient records (patients, prescriptions, flags, refills,
 * adherence analytics):
 *
 *  - Super Admin: NEVER. It is a platform operator, not a care provider.
 *    There is no override, approval or emergency path.
 *  - Hospital staff: only when their hospital is on a "with patient records"
 *    plan AND has been approved by Super Admin (clinics.status = 'active').
 *  - Hospitals on a "without patient records" plan: nobody. No patient
 *    records are stored for them (see whatsapp.routes.js).
 */

const CACHE_MS = 30_000;
const cache = new Map();

async function clinicAccessInfo(clinicId) {
  if (!clinicId) return null;
  const hit = cache.get(clinicId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const { rows } = await pool.query('SELECT id, status, records_mode FROM clinics WHERE id = $1', [clinicId]);
  const value = rows[0] || null;
  cache.set(clinicId, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

function clearClinicAccessCache(clinicId) {
  if (clinicId) cache.delete(clinicId);
  else cache.clear();
}

/**
 * 'enabled' | 'not_in_plan' | 'awaiting_approval' | 'suspended' | 'super_admin' | 'no_clinic'
 */
function recordsAccessFor(role, clinic) {
  if (role === 'super_admin') return 'super_admin';
  if (!clinic) return 'no_clinic';
  if (clinic.records_mode !== 'with_records') return 'not_in_plan';
  if (clinic.status === 'suspended') return 'suspended';
  if (clinic.status !== 'active') return 'awaiting_approval';
  return 'enabled';
}

const MESSAGES = {
  super_admin: { code: 'SUPER_ADMIN_NO_PATIENT_DATA', error: 'Super Admin never has access to patient records.' },
  not_in_plan: { code: 'RECORDS_NOT_IN_PLAN', error: "Your hospital's plan does not include patient records." },
  awaiting_approval: { code: 'HOSPITAL_NOT_APPROVED', error: 'Patient records open once Sehat Saathi approves your hospital.' },
  suspended: { code: 'HOSPITAL_SUSPENDED', error: 'This hospital is suspended.' },
  no_clinic: { code: 'NO_CLINIC', error: 'Your account is not linked to a hospital.' },
};

/** Mount in front of every patient-record router. */
async function patientRecordsGuard(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const access = recordsAccessFor(req.user.role, await clinicAccessInfo(req.user.clinic_id));
    if (access === 'enabled') return next();
    return res.status(403).json(MESSAGES[access]);
  } catch (err) {
    console.error('Records access check failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Switches a hospital's record mode. Moving to without_records is refused
 * while patient records are still stored for it: Super Admin cannot see or
 * delete them, so the hospital must first deal with its own data.
 */
async function setRecordsMode(clinicId, mode) {
  if (mode === 'without_records') {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM patients WHERE clinic_id = $1', [clinicId]);
    if (rows[0].n > 0) {
      throw Object.assign(
        new Error(`This hospital still has ${rows[0].n} stored patient record(s). It can't move to a "without patient records" plan until the hospital has removed them.`),
        { status: 409 }
      );
    }
  }
  await pool.query('UPDATE clinics SET records_mode = $2 WHERE id = $1', [clinicId, mode]);
  clearClinicAccessCache(clinicId);
}

module.exports = { patientRecordsGuard, clinicAccessInfo, recordsAccessFor, clearClinicAccessCache, setRecordsMode };

