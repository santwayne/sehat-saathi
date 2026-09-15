require('dotenv').config();
const { pool } = require('../src/db');
const { hashPassword } = require('../src/services/auth.service');

// Bootstraps the very first super_admin account (Super Admin spec, A6).
// There's no public signup, and creating a staff account normally requires
// an existing admin's token — this is the one-time chicken-and-egg breaker,
// run directly against the database rather than as an API route.
//
// Usage: node scripts/seed-super-admin.js
// Reads SUPER_ADMIN_PHONE / SUPER_ADMIN_PASSWORD from env (.env or the
// environment). Safe to re-run: upserts on phone.

async function main() {
  const phone = process.env.SUPER_ADMIN_PHONE;
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!phone || !password) {
    console.error('SUPER_ADMIN_PHONE and SUPER_ADMIN_PASSWORD must be set (in .env or the environment).');
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);

  const { rows } = await pool.query(
    `INSERT INTO staff_users (clinic_id, name, role, phone, password_hash)
     VALUES (NULL, 'Super Admin', 'super_admin', $1, $2)
     ON CONFLICT (phone) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'super_admin', clinic_id = NULL
     RETURNING id, name, role, phone, created_at`,
    [phone, passwordHash]
  );

  console.log('Super admin ready:', rows[0]);
}

main()
  .catch((err) => {
    console.error('Failed to seed super admin:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
