const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyPassword, issueToken } = require('../services/auth.service');

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
    const { rows } = await pool.query(
      `SELECT id, clinic_id, name, role, phone, password_hash
       FROM staff_users WHERE phone = $1`,
      [phone]
    );
    const staff = rows[0];

    if (!staff || !(await verifyPassword(password, staff.password_hash))) {
      return res.status(401).json({ error: 'Invalid phone or password.' });
    }

    const token = issueToken(staff);
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
      'SELECT id, clinic_id, name, role, phone, notify_on_flag FROM staff_users WHERE id = $1',
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

module.exports = router;
