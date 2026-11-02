const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyPassword, issueToken, hashPassword } = require('../services/auth.service');
const { logAudit } = require('../services/audit.service');

/**
 * POST /api/auth/login
 * Staff login by phone + password. Returns a bearer token plus the staff profile
 * used to drive role-scoped views on the dashboard.
 */
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password are required.' });
  }

  try {
    // Match on digits only, and treat a bare 10-digit number and the same
    // number with an India country code (91) as equal — an account created as
    // "+919876543210" must still sign in with "9876543210" (and vice versa).
    // An exact match wins if several rows qualify.
    const digits = String(phone).replace(/\D/g, '');
    const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
    const { rows } = await pool.query(
      `SELECT id, clinic_id, name, role, phone, password_hash
       FROM staff_users
       WHERE regexp_replace(phone, '\\D', '', 'g') IN ($1, $2, $3)
       ORDER BY (phone = $4) DESC
       LIMIT 1`,
      [digits, national, `91${national}`, phone]
    );
    const staff = rows[0];

    if (!staff || !(await verifyPassword(password, staff.password_hash))) {
      return res.status(401).json({ error: 'Invalid phone or password.' });
    }

    const token = issueToken(staff);
    await logAudit(req, 'auth.login', { actor: staff, targetType: 'staff', targetId: staff.id, clinicId: staff.clinic_id });
    return res.status(200).json({
      success: true,
      token,
      staff: { id: staff.id, clinic_id: staff.clinic_id, name: staff.name, role: staff.role, phone: staff.phone },
    });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/auth/me
 * Returns the profile for the currently authenticated staff member (from bearer token).
 */
router.get('/me', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, clinic_id, name, role, phone, email, notify_on_flag FROM staff_users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Staff account not found.' });
    }
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to fetch current staff profile:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/auth/me
 * Updates the signed-in user's own profile: name, phone (their login id) and email.
 */
router.patch('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const { name, phone, email } = req.body || {};
  const sets = [];
  const params = [];

  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
    params.push(String(name).trim()); sets.push(`name = $${params.length}`);
  }
  if (phone !== undefined) {
    const digits = String(phone).replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(digits)) return res.status(400).json({ error: 'Enter a valid phone number (10–15 digits).' });
    params.push(String(phone).trim()); sets.push(`phone = $${params.length}`);
  }
  if (email !== undefined) {
    const e = String(email || '').trim();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: 'Enter a valid email address.' });
    params.push(e || null); sets.push(`email = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields provided to update.' });

  params.push(req.user.id);
  try {
    const { rows } = await pool.query(
      `UPDATE staff_users SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, clinic_id, name, role, phone, email`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Staff account not found.' });
    await logAudit(req, 'profile.update', {
      targetType: 'staff',
      targetId: req.user.id,
      clinicId: req.user.clinic_id,
      details: { fields: Object.keys(req.body || {}).filter((k) => ['name', 'phone', 'email'].includes(k)) },
    });
    // Name is embedded in the token, so hand back a fresh one.
    return res.status(200).json({ success: true, data: rows[0], token: issueToken(rows[0]) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Another account already uses this phone number.' });
    console.error('Failed to update profile:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/change-password
 * Body: { current_password, new_password }. Requires the current password.
 */
router.post('/change-password', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (String(new_password).length < 10) {
    return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  }
  if (current_password === new_password) {
    return res.status(400).json({ error: 'New password must be different from the current one.' });
  }
  try {
    const { rows } = await pool.query('SELECT password_hash FROM staff_users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Staff account not found.' });
    if (!(await verifyPassword(current_password, rows[0].password_hash))) {
      await logAudit(req, 'auth.password_change_failed', { targetType: 'staff', targetId: req.user.id, clinicId: req.user.clinic_id });
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    await pool.query('UPDATE staff_users SET password_hash = $1 WHERE id = $2', [await hashPassword(new_password), req.user.id]);
    await logAudit(req, 'auth.password_change', { targetType: 'staff', targetId: req.user.id, clinicId: req.user.clinic_id });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to change password:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
