const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { sendWhatsAppTemplate, normalizePhone } = require('../services/whatsapp.service');

/**
 * GET /api/patients
 * Role-scoped, searchable patient roster. Doctors see only their own assigned
 * patients; admins/coordinators/nurses see every patient in their clinic.
 */
router.get('/', async (req, res) => {
  const { staff_id, role, search } = req.query;

  try {
    let query = `
      SELECT
        p.id, p.name, p.phone, p.language_pref, p.preferred_channel,
        p.consent_given, p.kill_switch_active, p.assigned_doctor_id, p.created_at,
        d.name AS doctor_name
      FROM patients p
      LEFT JOIN doctors d ON p.assigned_doctor_id = d.id
      WHERE 1=1
    `;
    const params = [];

    if (staff_id) {
      params.push(staff_id);
      query += ` AND p.clinic_id = (SELECT clinic_id FROM staff_users WHERE id = $${params.length})`;
    }

    if (role === 'doctor' && staff_id) {
      query += ` AND p.assigned_doctor_id = (SELECT id FROM doctors WHERE staff_user_id = $1)`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.phone ILIKE $${params.length})`;
    }

    query += ' ORDER BY p.created_at DESC;';

    const { rows } = await pool.query(query, params);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch patients:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/patients/:id
 * Full patient detail: profile, prescriptions, check-in schedule, and recent
 * conversation history — backs the Patients page detail drawer.
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const patientRes = await pool.query(
      `SELECT p.*, d.name AS doctor_name
       FROM patients p
       LEFT JOIN doctors d ON p.assigned_doctor_id = d.id
       WHERE p.id = $1`,
      [id]
    );
    const patient = patientRes.rows[0];
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found.' });
    }

    const [prescriptions, schedules, conversations] = await Promise.all([
      pool.query(
        `SELECT id, image_url, structured_json, ocr_confidence, verified_by_staff, created_at
         FROM prescriptions WHERE patient_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT id, frequency_days, channel_pref, next_checkin_at, active
         FROM checkin_schedules WHERE patient_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT id, channel, direction, message_text, intent_type, created_at
         FROM conversations WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id]
      ),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        ...patient,
        prescriptions: prescriptions.rows,
        checkin_schedules: schedules.rows,
        conversations: conversations.rows,
      },
    });
  } catch (error) {
    console.error('Failed to fetch patient detail:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/patients
 * Enrolls a new patient. Consent must be explicitly captured here (DPDP Act
 * requirement, Section 6.3) before the WhatsApp webhook will ever respond to
 * this phone number.
 */
router.post('/', async (req, res) => {
  const {
    clinic_id, name, phone, language_pref, preferred_channel,
    assigned_doctor_id, consent_given,
  } = req.body;

  if (!clinic_id || !name || !phone) {
    return res.status(400).json({ error: 'clinic_id, name, and phone are required.' });
  }

  // Bug 5 fix: this was previously only captured, never enforced — a
  // submission with the consent checkbox left unticked was enrolled
  // successfully anyway (consent_given === true simply evaluated to false
  // and got silently stored as-is). The form's own copy already promises
  // "Patient must give verbal consent before being enrolled"; now it's
  // actually blocked here the same way a missing name/phone already is.
  if (consent_given !== true) {
    return res.status(400).json({ error: 'Patient consent must be given before enrollment.' });
  }

  // Normalize to digits-only so DB matches WhatsApp sender IDs (e.g. "917087064479")
  const cleanPhone = normalizePhone(phone);

  try {
    const { rows } = await pool.query(
      `INSERT INTO patients (clinic_id, name, phone, language_pref, preferred_channel, assigned_doctor_id, consent_given)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        clinic_id, name, cleanPhone,
        language_pref || 'en',
        preferred_channel || 'whatsapp',
        assigned_doctor_id || null,
        consent_given === true,
      ]
    );
    const patient = rows[0];

    // Send welcome template — {{1}} = patient name, {{2}} = clinic name
    if (patient.consent_given) {
      pool.query('SELECT name FROM clinics WHERE id = $1', [clinic_id])
        .then(({ rows: cr }) => {
          const clinicName = cr[0]?.name || 'your clinic';
          return sendWhatsAppTemplate(cleanPhone, 'patient_welcome', 'en', [patient.name, clinicName]);
        })
        .catch((err) => console.error('Welcome template failed:', err.message));
    }

    return res.status(201).json({ success: true, data: patient });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A patient with this phone number is already enrolled.' });
    }
    console.error('Failed to enroll patient:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
