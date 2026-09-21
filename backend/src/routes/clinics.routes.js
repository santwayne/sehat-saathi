const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole, hashPassword } = require('../services/auth.service');

/**
 * GET /api/clinics
 * Lists every clinic with summary stats, for the Super Admin console
 * (SuperAdminClinics.tsx). Super admin only.
 */
router.get('/', requireRole('super_admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id, c.name, c.address, c.whatsapp_number, c.whatsapp_phone_number_id,
        c.status, c.created_at,
        (SELECT COUNT(*) FROM patients p WHERE p.clinic_id = c.id) AS patient_count,
        (SELECT COUNT(*) FROM flags f JOIN patients p ON f.patient_id = p.id WHERE p.clinic_id = c.id AND f.status = 'open') AS open_flag_count,
        (SELECT COUNT(*) FROM doctors d WHERE d.clinic_id = c.id) AS doctor_count
      FROM clinics c
      ORDER BY c.created_at DESC;
    `);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to list clinics:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/clinics
 * Onboards a new hospital: registers the clinic row (including the WABA
 * number/phone_number_id Meta already issued for it — see
 * SUPER_ADMIN_BUILD_SPEC.md Part B, this does NOT provision a WhatsApp
 * number itself, that's a real-world Meta Business Manager step done
 * separately) and creates its first admin account in the same transaction,
 * so there's no second chicken-and-egg problem per hospital (A7).
 * Super admin only.
 */
router.post('/', requireRole('super_admin'), async (req, res) => {
  const {
    name, address, whatsapp_number, whatsapp_phone_number_id, whatsapp_access_token,
    admin_name, admin_phone, admin_password,
  } = req.body;

  if (!name || !whatsapp_number) {
    return res.status(400).json({ error: 'name and whatsapp_number are required.' });
  }
  if (!admin_name || !admin_phone || !admin_password) {
    return res.status(400).json({ error: "The hospital's first admin account (admin_name, admin_phone, admin_password) is required." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const clinicRes = await client.query(
      `INSERT INTO clinics (name, address, whatsapp_number, whatsapp_phone_number_id, whatsapp_access_token, status)
       VALUES ($1, $2, $3, $4, $5, 'onboarding')
       RETURNING id, name, address, whatsapp_number, whatsapp_phone_number_id, status, created_at`,
      [name, address || null, whatsapp_number, whatsapp_phone_number_id || null, whatsapp_access_token || null]
    );
    const clinic = clinicRes.rows[0];

    const passwordHash = await hashPassword(admin_password);
    const adminRes = await client.query(
      `INSERT INTO staff_users (clinic_id, name, role, phone, password_hash)
       VALUES ($1, $2, 'admin', $3, $4)
       RETURNING id, clinic_id, name, role, phone, created_at`,
      [clinic.id, admin_name, admin_phone, passwordHash]
    );

    await client.query('COMMIT');
    return res.status(201).json({ success: true, data: { clinic, admin: adminRes.rows[0] } });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A clinic with this WhatsApp number/phone_number_id, or a staff account with this admin phone, already exists.' });
    }
    console.error('Failed to create clinic:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/clinics/:id
 * Read-only clinic info for the Settings page.
 */
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, address, whatsapp_number, whatsapp_phone_number_id, status, created_at FROM clinics WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Clinic not found.' });
    }
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to fetch clinic:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/clinics/:id/summary
 * Aggregate counts for the clinic-switcher view. Super admin can view any
 * clinic; other staff only their own.
 */
router.get('/:id/summary', async (req, res) => {
  const { id } = req.params;
  const isSuperAdmin = req.user?.role === 'super_admin';

  if (!isSuperAdmin && req.user?.clinic_id !== id) {
    return res.status(403).json({ error: 'Insufficient permissions.' });
  }

  try {
    const [patients, openFlags, pendingPrescriptions, doctors] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM patients WHERE clinic_id = $1', [id]),
      pool.query(
        `SELECT COUNT(*) FROM flags f JOIN patients p ON f.patient_id = p.id WHERE p.clinic_id = $1 AND f.status = 'open'`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(*) FROM prescriptions pr JOIN patients p ON pr.patient_id = p.id WHERE p.clinic_id = $1 AND pr.verified_by_staff = false`,
        [id]
      ),
      pool.query('SELECT COUNT(*) FROM doctors WHERE clinic_id = $1', [id]),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        patient_count: Number(patients.rows[0].count),
        open_flag_count: Number(openFlags.rows[0].count),
        pending_prescription_count: Number(pendingPrescriptions.rows[0].count),
        doctor_count: Number(doctors.rows[0].count),
      },
    });
  } catch (error) {
    console.error('Failed to fetch clinic summary:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/clinics/:id
 * Updates name/address/status (e.g. suspending a hospital) or WhatsApp
 * credentials. Super admin only.
 */
router.patch('/:id', requireRole('super_admin'), async (req, res) => {
  const { id } = req.params;
  const { name, address, status, whatsapp_number, whatsapp_phone_number_id, whatsapp_access_token } = req.body;

  const setClauses = [];
  const values = [];
  let i = 1;

  if (name !== undefined) { setClauses.push(`name = $${i++}`); values.push(name); }
  if (address !== undefined) { setClauses.push(`address = $${i++}`); values.push(address); }
  if (status !== undefined) {
    if (!['active', 'suspended', 'onboarding'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active', 'suspended', or 'onboarding'." });
    }
    setClauses.push(`status = $${i++}`);
    values.push(status);
  }
  if (whatsapp_number !== undefined) { setClauses.push(`whatsapp_number = $${i++}`); values.push(whatsapp_number); }
  if (whatsapp_phone_number_id !== undefined) { setClauses.push(`whatsapp_phone_number_id = $${i++}`); values.push(whatsapp_phone_number_id); }
  if (whatsapp_access_token !== undefined) { setClauses.push(`whatsapp_access_token = $${i++}`); values.push(whatsapp_access_token); }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'No fields provided to update.' });
  }

  values.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE clinics SET ${setClauses.join(', ')} WHERE id = $${i}
       RETURNING id, name, address, whatsapp_number, whatsapp_phone_number_id, status, created_at`,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Clinic not found.' });
    }
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Another clinic already uses this WhatsApp number/phone_number_id.' });
    }
    console.error('Failed to update clinic:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
