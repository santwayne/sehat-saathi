const { pool } = require('../db');
const { logAudit } = require('./audit.service');

/**
 * Super Admin is a platform operator, not a care provider: by default it gets
 * NO access to patient data (patients, prescriptions, flags, refills).
 *
 * The only way in is break-glass: Super Admin raises a request for one
 * hospital with a reason, that hospital's admin approves it, and for the
 * approved window Super Admin gets READ-ONLY access to that hospital only.
 * Every request made under a grant is written to audit_log.
 */

async function activeGrantClinicIds(staffId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT clinic_id FROM break_glass_requests
     WHERE requested_by = $1 AND status = 'approved' AND expires_at > NOW()`,
    [staffId]
  );
  return rows.map((r) => r.clinic_id);
}

/**
 * Mount in front of every patient-data router.
 *  - Unauthenticated requests are rejected (several of these routes used to
 *    rely on the caller checking req.user themselves).
 *  - Hospital staff pass straight through; their own routes scope them.
 *  - Super Admin is blocked unless it holds an approved, unexpired grant; then
 *    only GET is allowed and only for the granted hospital(s).
 */
async function patientDataGuard(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  if (req.user.role !== 'super_admin') return next();

  try {
    const grants = await activeGrantClinicIds(req.user.id);
    if (grants.length === 0) {
      return res.status(403).json({
        error: 'Super Admin does not have access to patient data. Raise a break-glass request from Audit Log if this is an emergency.',
        code: 'BREAK_GLASS_REQUIRED',
      });
    }
    if (req.method !== 'GET') {
      return res.status(403).json({ error: 'Break-glass access is read-only.', code: 'BREAK_GLASS_READ_ONLY' });
    }

    const requested = req.query.clinic_id;
    if (requested && !grants.includes(requested)) {
      return res.status(403).json({ error: 'No active break-glass grant for this hospital.', code: 'BREAK_GLASS_REQUIRED' });
    }
    if (!requested) {
      // List endpoints show every clinic to super_admin when no clinic_id is
      // given — pin them to the granted hospital instead.
      if (grants.length > 1) {
        return res.status(400).json({ error: 'Pass clinic_id: you hold break-glass grants for more than one hospital.' });
      }
      req.query.clinic_id = grants[0];
    }

    // canAccessClinic() honours this for routes keyed by a record id.
    req.breakGlassClinicIds = grants;
    await logAudit(req, 'break_glass.access', {
      targetType: 'route',
      targetId: req.originalUrl.split('?')[0].slice(0, 64),
      clinicId: req.query.clinic_id,
      details: { method: req.method, path: req.originalUrl.split('?')[0] },
    });
    return next();
  } catch (err) {
    console.error('Break-glass check failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { activeGrantClinicIds, patientDataGuard };
