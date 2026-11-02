const { pool } = require('../db');

/**
 * Writes one row to audit_log. Never throws: an audit write failing must not
 * break the action being audited, so failures are logged and swallowed.
 *
 * @param {object} req      Express request (actor comes from req.user, ip from headers)
 * @param {string} action   dot-separated verb, e.g. 'clinic.update', 'invoice.create'
 * @param {object} [opts]   { targetType, targetId, clinicId, details, actor }
 */
async function logAudit(req, action, opts = {}) {
  const actor = opts.actor || req?.user || {};
  const ip =
    (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
    req?.socket?.remoteAddress ||
    null;
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, target_type, target_id, clinic_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        actor.id || null,
        actor.name || null,
        actor.role || null,
        action,
        opts.targetType || null,
        opts.targetId ? String(opts.targetId) : null,
        opts.clinicId || null,
        opts.details ? JSON.stringify(opts.details) : null,
        ip,
      ]
    );
  } catch (err) {
    console.error(`Audit log write failed (${action}):`, err.message);
  }
}

module.exports = { logAudit };
