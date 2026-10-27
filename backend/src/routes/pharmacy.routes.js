const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole, canAccessClinic } = require('../services/auth.service');
const { normalizePhone, isValidPhone } = require('../services/whatsapp.service');

// Pharmacy partners + refill-reminder queue (V2 spec Section 4).

const ALL_STAFF = ['admin', 'coordinator', 'nurse', 'doctor', 'super_admin'];
const STATUSES = ['flagged', 'offered', 'ordered', 'fulfilled', 'cancelled'];

function clinicIdFor(req) {
  return req.user.role === 'super_admin' ? req.query.clinic_id || req.body?.clinic_id : req.user.clinic_id;
}

router.get('/pharmacy-partners', requireRole(...ALL_STAFF), async (req, res) => {
  try {
    const clinicId = clinicIdFor(req);
    const params = [];
    let where = '';
    if (clinicId) { params.push(clinicId); where = 'WHERE clinic_id = $1'; }
    const { rows } = await pool.query(
      `SELECT id, clinic_id, name, whatsapp_catalog_id, whatsapp_business_phone, address, created_at
       FROM pharmacy_partners ${where} ORDER BY created_at`, params);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to list pharmacy partners:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/pharmacy-partners', requireRole('admin', 'super_admin'), async (req, res) => {
  const { name, whatsapp_catalog_id, whatsapp_business_phone, address } = req.body;
  const clinicId = clinicIdFor(req);
  if (!clinicId || !name || !name.trim()) {
    return res.status(400).json({ error: 'clinic_id and name are required.' });
  }
  let phone = null;
  if (whatsapp_business_phone) {
    phone = normalizePhone(whatsapp_business_phone);
    if (!isValidPhone(phone)) return res.status(400).json({ error: 'Enter a valid pharmacy WhatsApp number, including country code.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO pharmacy_partners (clinic_id, name, whatsapp_catalog_id, whatsapp_business_phone, address)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [clinicId, name.trim(), whatsapp_catalog_id || null, phone, address || null]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to create pharmacy partner:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/pharmacy-partners/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT clinic_id FROM pharmacy_partners WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Pharmacy partner not found.' });
    if (!canAccessClinic(req, rows[0].clinic_id)) return res.status(403).json({ error: 'Insufficient permissions.' });
    await pool.query('DELETE FROM pharmacy_partners WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to delete pharmacy partner:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /api/refill-orders?status=flagged — staff-facing refill queue, clinic-scoped. */
router.get('/refill-orders', requireRole(...ALL_STAFF), async (req, res) => {
  const { status } = req.query;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    const params = [];
    const where = [];
    if (req.user.role === 'super_admin') {
      if (req.query.clinic_id) { params.push(req.query.clinic_id); where.push(`p.clinic_id = $${params.length}`); }
    } else {
      params.push(req.user.clinic_id); where.push(`p.clinic_id = $${params.length}`);
    }
    if (status) { params.push(status); where.push(`ro.status = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT ro.id, ro.status, ro.due_date, ro.medicine_names, ro.reminded_at, ro.created_at,
              p.id AS patient_id, p.name AS patient_name, p.phone AS patient_phone,
              pp.name AS pharmacy_name
       FROM refill_orders ro
       JOIN patients p ON p.id = ro.patient_id
       LEFT JOIN pharmacy_partners pp ON pp.id = ro.pharmacy_partner_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ro.due_date NULLS LAST, ro.created_at DESC`,
      params
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to list refill orders:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** PATCH /api/refill-orders/:id { status } — staff moves an order along the pipeline. */
router.patch('/refill-orders/:id', requireRole('admin', 'coordinator', 'nurse', 'super_admin'), async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    const { rows } = await pool.query(
      'SELECT p.clinic_id FROM refill_orders ro JOIN patients p ON p.id = ro.patient_id WHERE ro.id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Refill order not found.' });
    if (!canAccessClinic(req, rows[0].clinic_id)) return res.status(403).json({ error: 'Insufficient permissions.' });
    const upd = await pool.query('UPDATE refill_orders SET status = $1 WHERE id = $2 RETURNING id, status', [status, req.params.id]);
    return res.status(200).json({ success: true, data: upd.rows[0] });
  } catch (error) {
    console.error('Failed to update refill order:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
