const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { sendWhatsAppTemplate, normalizePhone, isValidPhone } = require('../services/whatsapp.service');
const { requireRole, canAccessClinic } = require('../services/auth.service');
const { isSupportedLanguage } = require('../services/i18n');
const { inviteFamilyMember } = require('../services/family.service');
const abdm = require('../services/abdm.service');

/**
 * GET /api/patients
 * Role-scoped, searchable patient roster. Doctors see only their own assigned
 * patients; admins/coordinators/nurses see every patient in their clinic.
 * Requires authentication — clinic (and, for doctors, patient) scoping comes
 * entirely from the verified JWT (req.user), never from client-supplied
 * staff_id/role query params, which used to be trusted directly: any signed-
 * in doctor could pass a different staff_id and read another doctor's — or
 * with no staff_id/clinic_id at all, every clinic's — patients.
 */
router.get('/', requireRole('admin', 'coordinator', 'nurse', 'doctor', 'super_admin'), async (req, res) => {
  const { search, clinic_id } = req.query;

  try {
    let query = `
      SELECT
        p.id, p.name, p.phone, p.language_pref, p.preferred_channel,
        p.consent_given, p.kill_switch_active, p.assigned_doctor_id, p.created_at,
        d.name AS doctor_name, b.label AS bed_label
      FROM patients p
      LEFT JOIN doctors d ON p.assigned_doctor_id = d.id
      LEFT JOIN beds b ON p.bed_id = b.id
      WHERE 1=1
    `;
    const params = [];

    // Super admin sees across every clinic by default; ?clinic_id= narrows
    // to one (the clinic-switcher view). Everyone else is pinned to their
    // own clinic from the token, full stop.
    if (req.user.role === 'super_admin') {
      if (clinic_id) {
        params.push(clinic_id);
        query += ` AND p.clinic_id = $${params.length}`;
      }
    } else {
      params.push(req.user.clinic_id);
      query += ` AND p.clinic_id = $${params.length}`;

      if (req.user.role === 'doctor') {
        params.push(req.user.id);
        query += ` AND p.assigned_doctor_id = (SELECT id FROM doctors WHERE staff_user_id = $${params.length})`;
      }
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

// Must stay above '/:id' or it would be captured as an id.
router.get('/abdm-status', requireRole('admin', 'coordinator', 'nurse', 'doctor', 'super_admin'), (req, res) =>
  res.status(200).json({ configured: abdm.isConfigured() }));

/**
 * GET /api/patients/:id
 * Full patient detail: profile, prescriptions, check-in schedule, and recent
 * conversation history — backs the Patients page detail drawer.
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const patientRes = await pool.query(
      `SELECT p.*, d.name AS doctor_name, b.label AS bed_label
       FROM patients p
       LEFT JOIN doctors d ON p.assigned_doctor_id = d.id
       LEFT JOIN beds b ON p.bed_id = b.id
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
        `SELECT id, channel, direction, message_text, intent_type, sender_type, created_at
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
  if (language_pref !== undefined && !isSupportedLanguage(language_pref)) {
    return res.status(400).json({ error: 'Unsupported language.' });
  }
  if (preferred_channel !== undefined && !['whatsapp', 'voice'].includes(preferred_channel)) {
    return res.status(400).json({ error: 'preferred_channel must be whatsapp or voice.' });
  }

  // Normalize to digits-only so DB matches WhatsApp sender IDs (e.g. "917087064479")
  const cleanPhone = normalizePhone(phone);

  // Bug 6 fix: previously any non-empty string reached here and got
  // enrolled (e.g. "12345") — no format check existed at all. Checked
  // after normalization, before the duplicate-number check (unchanged).
  if (!isValidPhone(cleanPhone)) {
    return res.status(400).json({ error: 'Enter a valid WhatsApp number, including country code (e.g. +919876543210).' });
  }

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
          return sendWhatsAppTemplate(cleanPhone, 'patient_welcome', 'en', [patient.name, clinicName], clinic_id);
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

/**
 * PATCH /api/patients/:id
 * Edits an already-enrolled patient's details. Previously nothing in the
 * API surface allowed this at all (Bugs 2 & 3) — a typo'd name/phone, a
 * wrong language, or a wrong assigned doctor picked at enrollment was
 * permanent from the UI's perspective. Only touches fields actually sent,
 * so a partial edit (e.g. just reassigning the doctor) doesn't require
 * resending the whole record.
 */
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, language_pref, preferred_channel, assigned_doctor_id } = req.body;

  const setClauses = [];
  const values = [];
  let i = 1;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
    setClauses.push(`name = $${i++}`);
    values.push(name);
  }
  if (phone !== undefined) {
    const cleanPhone = normalizePhone(phone);
    if (!isValidPhone(cleanPhone)) {
      return res.status(400).json({ error: 'Enter a valid WhatsApp number, including country code (e.g. +919876543210).' });
    }
    setClauses.push(`phone = $${i++}`);
    values.push(cleanPhone);
  }
  if (language_pref !== undefined) {
    if (!isSupportedLanguage(language_pref)) return res.status(400).json({ error: 'Unsupported language.' });
    setClauses.push(`language_pref = $${i++}`);
    values.push(language_pref);
  }
  if (preferred_channel !== undefined) {
    if (!['whatsapp', 'voice'].includes(preferred_channel)) return res.status(400).json({ error: 'preferred_channel must be whatsapp or voice.' });
    setClauses.push(`preferred_channel = $${i++}`);
    values.push(preferred_channel);
  }
  if (assigned_doctor_id !== undefined) {
    setClauses.push(`assigned_doctor_id = $${i++}`);
    values.push(assigned_doctor_id || null);
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'No fields provided to update.' });
  }

  values.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE patients SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found.' });
    }
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Another patient is already enrolled with this phone number.' });
    }
    console.error('Failed to update patient:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Loads a patient and checks the signed-in staff member may act on their clinic.
// Sends the 404/403 itself and returns null when access is not allowed.
async function loadAccessiblePatient(req, res) {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS clinic_name FROM patients p JOIN clinics c ON c.id = p.clinic_id WHERE p.id = $1`,
    [req.params.id]
  );
  const patient = rows[0];
  if (!patient) {
    res.status(404).json({ error: 'Patient not found.' });
    return null;
  }
  if (!canAccessClinic(req, patient.clinic_id)) {
    res.status(403).json({ error: 'Insufficient permissions.' });
    return null;
  }
  return patient;
}

const STAFF_ROLES = ['admin', 'coordinator', 'nurse', 'doctor', 'super_admin'];
const WRITE_ROLES = ['admin', 'coordinator', 'nurse', 'super_admin'];

/**
 * Family accounts (V2 spec Section 2).
 * GET lists a patient's family members; POST adds one and sends the WhatsApp
 * opt-in request (nothing else is sent until they reply YES); DELETE removes.
 */
router.get('/:id/family-members', requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const patient = await loadAccessiblePatient(req, res);
    if (!patient) return;
    const { rows } = await pool.query(
      `SELECT id, name, phone, relationship, status, invited_at, opted_in_at
       FROM family_members WHERE patient_id = $1 ORDER BY invited_at DESC`,
      [patient.id]
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to list family members:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/family-members', requireRole(...WRITE_ROLES), async (req, res) => {
  const { name, phone, relationship } = req.body;
  if (!name || !name.trim() || !phone) {
    return res.status(400).json({ error: 'name and phone are required.' });
  }
  const cleanPhone = normalizePhone(phone);
  if (!isValidPhone(cleanPhone)) {
    return res.status(400).json({ error: 'Enter a valid WhatsApp number, including country code (e.g. +919876543210).' });
  }

  try {
    const patient = await loadAccessiblePatient(req, res);
    if (!patient) return;
    if (!patient.consent_given || patient.kill_switch_active) {
      return res.status(409).json({ error: 'Family members can only be added for patients with consent on file and automation enabled.' });
    }
    if (cleanPhone === patient.phone) {
      return res.status(400).json({ error: "That is the patient's own number." });
    }
    // Their number must not already be an enrolled patient: the webhook checks
    // patients first, so they would never be treated as family.
    const clash = await pool.query('SELECT 1 FROM patients WHERE phone = $1 AND clinic_id = $2', [cleanPhone, patient.clinic_id]);
    if (clash.rows.length > 0) {
      return res.status(409).json({ error: 'That number belongs to an enrolled patient and cannot be added as a family member.' });
    }

    const { member, delivered } = await inviteFamilyMember({
      patient, clinicName: patient.clinic_name, name: name.trim(), phone: cleanPhone, relationship,
    });
    return res.status(201).json({ success: true, data: member, invite_delivered: delivered });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This family member has already been added for this patient.' });
    }
    console.error('Failed to add family member:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/family-members/:memberId', requireRole(...WRITE_ROLES), async (req, res) => {
  try {
    const patient = await loadAccessiblePatient(req, res);
    if (!patient) return;
    const { rowCount } = await pool.query('DELETE FROM family_members WHERE id = $1 AND patient_id = $2', [req.params.memberId, patient.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Family member not found.' });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to remove family member:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * ABHA link (V2 spec Section 3 — staff-recorded version).
 * Records the patient's ABHA number/address after they've consented. This does
 * NOT call ABDM: live OTP verification and care-context push need HFR/HPR
 * registration and sandbox credentials first, so abha_linked_at here means
 * "recorded by staff", not "verified by ABDM". abdm_consent_artefact_id stays
 * empty until the real Consent Manager flow exists.
 */
const ABHA_NUMBER_RE = /^\d{2}-?\d{4}-?\d{4}-?\d{4}$/;
const ABHA_ADDRESS_RE = /^[a-z0-9._]{3,}@(abdm|sbx)$/i;

router.post('/:id/abha', requireRole(...WRITE_ROLES), async (req, res) => {
  const { abha_number, abha_address, patient_consented } = req.body;
  if (patient_consented !== true) {
    return res.status(400).json({ error: 'The patient must consent to linking their ABHA before it is recorded.' });
  }
  if (!abha_number && !abha_address) {
    return res.status(400).json({ error: 'Provide an ABHA number and/or ABHA address.' });
  }
  if (abha_number && !ABHA_NUMBER_RE.test(abha_number.trim())) {
    return res.status(400).json({ error: 'ABHA number must be 14 digits (e.g. 12-3456-7890-1234).' });
  }
  if (abha_address && !ABHA_ADDRESS_RE.test(abha_address.trim())) {
    return res.status(400).json({ error: 'ABHA address must look like name@abdm.' });
  }

  try {
    const patient = await loadAccessiblePatient(req, res);
    if (!patient) return;
    const number = abha_number ? abha_number.replace(/\D/g, '').replace(/^(\d{2})(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3-$4') : null;
    const { rows } = await pool.query(
      `UPDATE patients SET abha_number = $1, abha_address = $2, abha_linked_at = NOW(), abha_verified_by_abdm = false
       WHERE id = $3 RETURNING id, abha_number, abha_address, abha_linked_at, abha_verified_by_abdm`,
      [number, abha_address ? abha_address.trim().toLowerCase() : null, patient.id]
    );
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to record ABHA:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Real ABHA creation through ABDM (Aadhaar OTP). The Aadhaar number is passed
 * straight to ABDM and never stored or logged. 503 until ABDM credentials are
 * configured, so the manual /abha route above remains the fallback.
 */
function sendAbdmError(res, err) {
  if (err instanceof abdm.AbdmError) return res.status(err.status || 502).json({ error: err.message });
  console.error('ABDM enrolment failed:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
}

router.post('/:id/abha/link-init', requireRole(...WRITE_ROLES), async (req, res) => {
  if (req.body.patient_consented !== true) {
    return res.status(400).json({ error: 'The patient must consent to creating/linking their ABHA.' });
  }
  try {
    const patient = await loadAccessiblePatient(req, res);
    if (!patient) return;
    return res.status(200).json({ success: true, ...(await abdm.initiateAbhaEnrolment(patient.id, req.body.aadhaar)) });
  } catch (err) {
    return sendAbdmError(res, err);
  }
});

router.post('/:id/abha/verify-otp', requireRole(...WRITE_ROLES), async (req, res) => {
  try {
    const patient = await loadAccessiblePatient(req, res);
    if (!patient) return;
    const mobile = req.body.mobile ? normalizePhone(req.body.mobile).slice(-10) : undefined;
    return res.status(200).json({ success: true, data: await abdm.verifyAbhaOtp(patient.id, req.body.otp, mobile) });
  } catch (err) {
    return sendAbdmError(res, err);
  }
});

router.delete('/:id/abha', requireRole(...WRITE_ROLES), async (req, res) => {
  try {
    const patient = await loadAccessiblePatient(req, res);
    if (!patient) return;
    await pool.query(
      `UPDATE patients SET abha_number = NULL, abha_address = NULL, abha_linked_at = NULL, abha_verified_by_abdm = false, abdm_consent_artefact_id = NULL WHERE id = $1`,
      [patient.id]
    );
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to unlink ABHA:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/patients/:id
 * Permanently removes a patient. Conversations, flags, prescriptions, and
 * check-in schedules all cascade via existing ON DELETE CASCADE foreign
 * keys (schema.sql) — no orphaned rows left behind. Admin-only: this is
 * destructive and unlike PATCH can't be corrected by editing again, so it
 * gets the same requireRole('admin', 'super_admin') gate as creating staff/doctor
 * accounts, rather than the open access enrollment itself uses.
 */
router.delete('/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query('DELETE FROM patients WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found.' });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to delete patient:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
