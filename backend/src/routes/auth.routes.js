const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyPassword, issueToken, hashPassword } = require('../services/auth.service');
const { logAudit } = require('../services/audit.service');
const { clinicAccessInfo, recordsAccessFor } = require('../services/records-access.service');
const { normalizePhone, isValidPhone, phoneVariants } = require('../services/phone');

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
    // Any stored form of the number matches ("919876543210", "9876543210",
    // "+91 98765 43210", "09876543210") — bug list #3. Active account first.
    const { rows } = await pool.query(
      `SELECT s.id, s.clinic_id, s.name, s.role, s.phone, s.password_hash, s.deactivated_at, c.name AS clinic_name
       FROM staff_users s LEFT JOIN clinics c ON c.id = s.clinic_id
       WHERE regexp_replace(s.phone, '\\D', '', 'g') = ANY($1::text[])
       ORDER BY (s.deactivated_at IS NULL) DESC, (s.phone = $2) DESC
       LIMIT 1`,
      [phoneVariants(phone), normalizePhone(phone)]
    );
    const staff = rows[0];

    // One message for "no such number" and "wrong password" on purpose (no
    // probing which numbers have accounts); the login page explains what to
    // check and how to get a reset (bug list #9).
    if (!staff || !(await verifyPassword(password, staff.password_hash))) {
      return res.status(401).json({ error: 'Invalid phone or password.', code: 'INVALID_CREDENTIALS' });
    }
    // Removed staff keep their row (audit history) but cannot sign in.
    if (staff.deactivated_at) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact your hospital administrator.' });
    }

    const token = issueToken(staff);
    await pool.query('UPDATE staff_users SET last_login_at = NOW() WHERE id = $1', [staff.id]);
    await logAudit(req, 'auth.login', { actor: staff, targetType: 'staff', targetId: staff.id, clinicId: staff.clinic_id });
    return res.status(200).json({
      success: true,
      token,
      staff: {
        id: staff.id, clinic_id: staff.clinic_id, clinic_name: staff.clinic_name, name: staff.name, role: staff.role, phone: staff.phone,
        // Drives which pages the UI shows; the API enforces it independently.
        records_access: recordsAccessFor(staff.role, await clinicAccessInfo(staff.clinic_id)),
      },
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
      `SELECT s.id, s.clinic_id, c.name AS clinic_name, s.name, s.role, s.phone, s.email, s.notify_on_flag
         FROM staff_users s LEFT JOIN clinics c ON c.id = s.clinic_id WHERE s.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Staff account not found.' });
    }
    const records_access = recordsAccessFor(rows[0].role, await clinicAccessInfo(rows[0].clinic_id));
    return res.status(200).json({ success: true, data: { ...rows[0], records_access } });
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
    params.push(String(name).trim().replace(/\s+/g, ' ')); sets.push(`name = $${params.length}`);
  }
  if (phone !== undefined) {
    const canonical = normalizePhone(phone);
    if (!isValidPhone(canonical)) return res.status(400).json({ error: 'Enter a valid mobile number: 10 digits, or with country code.' });
    params.push(canonical); sets.push(`phone = $${params.length}`);
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
       RETURNING id, clinic_id, (SELECT c.name FROM clinics c WHERE c.id = staff_users.clinic_id) AS clinic_name, name, role, phone, email`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Staff account not found.' });
    // A doctor's name also shows on the Doctors list / patient assignment: keep it the same.
    if (name !== undefined) await pool.query('UPDATE doctors SET name = $2 WHERE staff_user_id = $1 AND removed_at IS NULL', [req.user.id, rows[0].name]);
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
