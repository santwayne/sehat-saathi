const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db');
const { requireRole, canAccessClinic } = require('../services/auth.service');

// Per-bed QR codes (roadmap "QR code at every hospital bed"). Each bed gets an
// unguessable code; its QR opens the hospital's WhatsApp with that code
// prefilled, so the patient is tied to their bed from the first message.
// The QR image itself is drawn client-side from `link`.

// No 0/O/1/I — same alphabet the webhook's BED_CODE_RE accepts.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `BED-${out}`;
}

function linkFor(whatsappNumber, code) {
  const digits = String(whatsappNumber || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(code)}` : null;
}

async function resolveClinic(req, res, clinicId) {
  if (!clinicId) {
    res.status(400).json({ error: 'clinic_id is required.' });
    return null;
  }
  if (!canAccessClinic(req, clinicId)) {
    res.status(403).json({ error: 'Insufficient permissions.' });
    return null;
  }
  const { rows } = await pool.query('SELECT id, name, whatsapp_number FROM clinics WHERE id = $1', [clinicId]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Clinic not found.' });
    return null;
  }
  return rows[0];
}

/** GET /api/beds?clinic_id= — beds with their scan link and current occupant count. */
router.get('/', requireRole('admin', 'coordinator', 'nurse', 'super_admin'), async (req, res) => {
  try {
    const clinic = await resolveClinic(req, res, req.query.clinic_id || req.user.clinic_id);
    if (!clinic) return;
    const { rows } = await pool.query(
      `SELECT b.id, b.label, b.ward, b.code, b.active, b.created_at,
              (SELECT p.name FROM patients p WHERE p.bed_id = b.id ORDER BY p.created_at DESC LIMIT 1) AS patient_name
       FROM beds b WHERE b.clinic_id = $1 AND b.active = true ORDER BY b.ward NULLS LAST, b.label`,
      [clinic.id]
    );
    return res.status(200).json({
      success: true,
      data: rows.map((b) => ({ ...b, link: linkFor(clinic.whatsapp_number, b.code) })),
    });
  } catch (error) {
    console.error('Failed to list beds:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/beds — create beds. Either { clinic_id, labels: ["A-1","A-2"] }
 * or { clinic_id, prefix: "A-", from: 1, to: 20 } for a numbered range.
 */
router.post('/', requireRole('admin', 'super_admin'), async (req, res) => {
  const { prefix, from, to, ward } = req.body;
  let labels = req.body.labels;

  if (!Array.isArray(labels)) {
    const start = Number(from);
    const end = Number(to);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      return res.status(400).json({ error: 'Provide labels[], or prefix with a valid from/to range.' });
    }
    labels = [];
    for (let n = start; n <= end; n += 1) labels.push(`${prefix || ''}${n}`);
  }
  labels = [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))];
  if (labels.length === 0) return res.status(400).json({ error: 'No bed labels given.' });
  if (labels.length > 500 || labels.some((l) => l.length > 50)) {
    return res.status(400).json({ error: 'At most 500 beds per request, labels up to 50 characters.' });
  }

  try {
    const clinic = await resolveClinic(req, res, req.body.clinic_id || req.user.clinic_id);
    if (!clinic) return;

    const created = [];
    for (const label of labels) {
      // Retry on the (astronomically unlikely) code collision; the label
      // conflict means the bed already exists, which is skipped, not an error.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const { rows } = await pool.query(
            `INSERT INTO beds (clinic_id, label, ward, code) VALUES ($1, $2, $3, $4)
             ON CONFLICT (clinic_id, label) DO NOTHING
             RETURNING id, label, ward, code, active`,
            [clinic.id, label, ward || null, generateCode()]
          );
          if (rows[0]) created.push({ ...rows[0], link: linkFor(clinic.whatsapp_number, rows[0].code) });
          break;
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
    }
    return res.status(201).json({ success: true, data: created, skipped: labels.length - created.length });
  } catch (error) {
    console.error('Failed to create beds:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** DELETE /api/beds/:id — retires a bed (its printed QR stops working); patients keep history. */
router.delete('/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT clinic_id FROM beds WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Bed not found.' });
    if (!canAccessClinic(req, rows[0].clinic_id)) return res.status(403).json({ error: 'Insufficient permissions.' });
    await pool.query('UPDATE beds SET active = false WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to retire bed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
