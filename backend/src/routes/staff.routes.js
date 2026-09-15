const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword, requireRole } = require('../services/auth.service');

/**
 * GET /api/staff?clinic_id=
 * Lists staff accounts for a clinic (Settings page). Requires
 * authentication — this used to be reachable with no token at all, trusting
 * whatever clinic_id (or none) the caller passed; harmless with one clinic
 * in the deployment, a real cross-tenant leak once there's more than one.
 * Super admin can omit clinic_id (sees every clinic) or pass any clinic_id
 * (clinic-switcher view); everyone else is pinned to their own clinic
 * regardless of what clinic_id they pass.
 */
router.get('/', requireRole('admin', 'coordinator', 'nurse', 'doctor', 'super_admin'), async (req, res) => {
  const isSuperAdmin = req.user.role === 'super_admin';
  const clinic_id = isSuperAdmin ? req.query.clinic_id : req.user.clinic_id;

  try {
    const query = clinic_id
      ? { text: 'SELECT id, clinic_id, name, role, phone, notify_on_flag, created_at FROM staff_users WHERE clinic_id = $1 ORDER BY name', values: [clinic_id] }
      : { text: 'SELECT id, clinic_id, name, role, phone, notify_on_flag, created_at FROM staff_users ORDER BY name', values: [] };

    const { rows } = await pool.query(query.text, query.values);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch staff:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/staff
 * Creates a new staff account. Requires an authenticated admin.
 */
router.post('/', requireRole('admin', 'super_admin'), async (req, res) => {
  const { clinic_id, name, role, phone, password, notify_on_flag = true } = req.body;

  if (!clinic_id || !name || !role || !phone || !password) {
    return res.status(400).json({ error: 'clinic_id, name, role, phone, and password are required.' });
  }

  try {
    const password_hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO staff_users (clinic_id, name, role, phone, password_hash, notify_on_flag)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, clinic_id, name, role, phone, notify_on_flag, created_at`,
      [clinic_id, name, role, phone, password_hash, notify_on_flag]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A staff account with this phone number already exists.' });
    }
    console.error('Failed to create staff account:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
