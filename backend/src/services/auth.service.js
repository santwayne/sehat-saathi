const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '12h';

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 10);
}

async function verifyPassword(plainPassword, passwordHash) {
  return bcrypt.compare(plainPassword, passwordHash);
}

function issueToken(staff) {
  return jwt.sign(
    { id: staff.id, role: staff.role, clinic_id: staff.clinic_id, name: staff.name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Attaches req.user if a valid Bearer token is present. Does not reject
 * requests without one — routes that require auth check req.user themselves,
 * so existing role/staff_id-query-param callers keep working unmodified.
 */
function attachUser(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = verifyToken(header.slice(7));
    } catch (err) {
      // invalid/expired token: proceed unauthenticated rather than hard-fail,
      // callers that require auth will reject via requireRole below
    }
  }
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (allowedRoles.length && !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, attachUser, requireRole };
