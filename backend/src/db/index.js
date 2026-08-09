const { Pool } = require('pg');

// Neon (and most managed Postgres) require SSL; local dev Postgres usually doesn't support it.
const requiresSSL =
  process.env.NODE_ENV === 'production' ||
  (process.env.DATABASE_URL || '').includes('neon.tech');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: requiresSSL ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
