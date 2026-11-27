const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
// No expiry, by explicit request — a leaked token never auto-expires, so
// rotate JWT_SECRET (invalidates every issued token) if one is ever suspected
// of being compromised.

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 10);
}

async function verifyPassword(plainPassword, passwordHash) {
  return bcrypt.compare(plainPassword, passwordHash);
}

function issueToken(staff) {
  return jwt.sign(
    { id: staff.id, role: staff.role, clinic_id: staff.clinic_id, name: staff.name },
    JWT_SECRET
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Is this staff login still active? Tokens never expire, so a removed
 * (deactivated) staff member's token must be refused here. Cached for 30 s per
 * staff id to keep it to one small query per person, and dropped immediately
 * when someone is removed (forgetStaffStatus).
 */
const statusCache = new Map(); // id -> { active, role, at }
const STATUS_TTL_MS = 30_000;
async function staffStatus(id) {
  const hit = statusCache.get(id);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit;
  const { rows } = await pool.query('SELECT deactivated_at, role FROM staff_users WHERE id = $1', [id]);
  const value = { active: !!rows[0] && !rows[0].deactivated_at, role: rows[0]?.role ?? null, at: Date.now() };
  statusCache.set(id, value);
  if (statusCache.size > 5000) statusCache.clear();
  return value;
}
function forgetStaffStatus(id) { statusCache.delete(id); }

/**
 * Attaches req.user if a valid Bearer token is present AND the staff login is
 * still active. Does not reject requests without one — routes that require
 * auth check req.user themselves, so existing role/staff_id-query-param
 * callers keep working unmodified.
 */
async function attachUser(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    let user = null;
    try {
      user = verifyToken(header.slice(7));
    } catch (err) {
      // invalid/expired token: proceed unauthenticated rather than hard-fail,
      // callers that require auth will reject via requireRole below
    }
    if (user?.id) {
      try {
        const status = await staffStatus(user.id);
        // Tokens never expire, so the role in an old token can be stale after
        // an admin edits someone's role (Settings → Edit staff): trust the DB.
        if (status.active) req.user = status.role && user.role !== 'super_admin' ? { ...user, role: status.role } : user;
        else req.authError = 'This account has been deactivated. Contact your hospital administrator.';
      } catch (err) {
        // DB hiccup: don't lock everyone out over the status check.
        console.error('Staff status check failed:', err.message);
        req.user = user;
      }
    }
  }
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: req.authError || 'Authentication required.' });
    }
    if (allowedRoles.length && !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

function isSuperAdmin(req) {
  return req.user?.role === 'super_admin';
}

// Hospital staff: only their own clinic (from the token). Super Admin may
// manage any clinic's platform resources (beds, pharmacy partners) — but never
// patient records: patientRecordsGuard rejects Super Admin on every
// patient-record route before this is ever consulted.
function canAccessClinic(req, clinicId) {
  if (!req.user) return false;
  if (isSuperAdmin(req)) return true;
  return !!clinicId && req.user.clinic_id === clinicId;
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, attachUser, requireRole, isSuperAdmin, canAccessClinic, forgetStaffStatus };
