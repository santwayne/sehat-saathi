const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { recordResolution } = require('../services/doctor-match.service');
const { completeEnrollment } = require('../services/enrollment.service');
const { sendWhatsAppMessage } = require('../services/whatsapp.service');
const { logConversation } = require('../services/conversation.service');
const { requireRole } = require('../services/auth.service');

/**
 * GET /api/flags
 * Fetches flags filtered by role and clinic. Requires authentication —
 * scoping comes entirely from the verified JWT (req.user), never from
 * client-supplied staff_id/role query params (previously trusted directly:
 * any signed-in staff member could omit staff_id, or a doctor could pass a
 * different staff_id, to read another clinic's or another doctor's flags).
 */
router.get('/', requireRole('admin', 'coordinator', 'nurse', 'doctor', 'super_admin'), async (req, res) => {
  const { status = 'open', clinic_id } = req.query;

  try {
    // LEFT JOIN, not JOIN: an enrollment-time 'doctor_match_failed' flag
    // (Section 6.4) has no patient yet — f.clinic_id/f.context_phone carry
    // what an inner join on patients would have dropped entirely.
    let query = `
      SELECT
        f.id, f.flag_type, f.priority, f.status, f.created_at,
        f.clinic_id AS enrollment_clinic_id, f.context_phone,
        p.id AS patient_id, p.name AS patient_name, p.phone AS patient_phone,
        d.name AS doctor_name
      FROM flags f
      LEFT JOIN patients p ON f.patient_id = p.id
      LEFT JOIN doctors d ON p.assigned_doctor_id = d.id
      WHERE f.status = $1
    `;
    const params = [status];
    // A flag's clinic is the patient's clinic normally, or f.clinic_id
    // directly for the patient-less enrollment case above.
    const flagClinicExpr = 'COALESCE(p.clinic_id, f.clinic_id)';

    if (req.user.role === 'super_admin') {
      // No clinic filter by default — accept ?clinic_id= to view one clinic specifically.
      if (clinic_id) {
        params.push(clinic_id);
        query += ` AND ${flagClinicExpr} = $${params.length}`;
      }
    } else {
      params.push(req.user.clinic_id);
      query += ` AND ${flagClinicExpr} = $${params.length}`;

      if (req.user.role === 'doctor') {
        // Multi-doctor filtering: doctors only see their own assigned patients
        // (enrollment-time flags have no assigned doctor yet, so they never
        // show up in a doctor's own queue — only admins/coordinators/nurses
        // see those, which is intentional).
        params.push(req.user.id);
        query += ` AND (f.assigned_to = $${params.length} OR p.assigned_doctor_id = (SELECT id FROM doctors WHERE staff_user_id = $${params.length}))`;
      }
    }

    query += ` ORDER BY CASE WHEN f.priority = 'urgent' THEN 1 ELSE 2 END, f.created_at DESC;`;

    const { rows } = await pool.query(query, params);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch flags:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/flags/:id/resolve
 * Marks a flag as resolved
 */
router.patch('/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { staff_id } = req.body;

  try {
    const query = `
      UPDATE flags
      SET status = 'resolved', resolved_at = NOW(), assigned_to = $1
      WHERE id = $2 RETURNING *;
    `;
    const { rows } = await pool.query(query, [staff_id, id]);
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to resolve flag' });
  }
});

/**
 * PATCH /api/flags/:id/resolve-doctor-match
 * Resolves a 'doctor_match_conflict' flag (Section 7: a new document/voice
 * note named a different doctor than the one already assigned) by staff
 * picking the correct doctor. Reassigns the patient AND feeds the
 * correction back into the matching engine's learning loop (Section 8.2) —
 * the raw phrase that was mismatched becomes a known alias for whichever
 * doctor staff actually picked, via the most recent unresolved
 * doctor_match_log row for this patient.
 */
router.patch('/:id/resolve-doctor-match', async (req, res) => {
  const { id } = req.params;
  const { staff_id, doctor_id } = req.body;

  if (!doctor_id) {
    return res.status(400).json({ error: 'doctor_id is required.' });
  }

  try {
    const flagRes = await pool.query('SELECT id, patient_id FROM flags WHERE id = $1', [id]);
    const flag = flagRes.rows[0];
    if (!flag) {
      return res.status(404).json({ error: 'Flag not found.' });
    }
    if (!flag.patient_id) {
      return res.status(400).json({ error: 'This flag has no associated patient yet — resolve it by enrolling the patient manually instead.' });
    }

    await pool.query('UPDATE patients SET assigned_doctor_id = $1 WHERE id = $2', [doctor_id, flag.patient_id]);

    const logRes = await pool.query(
      `SELECT id, raw_input FROM doctor_match_log
       WHERE patient_id = $1 AND staff_corrected_to IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [flag.patient_id]
    );
    const lastMatch = logRes.rows[0];
    if (lastMatch) {
      await recordResolution({
        matchLogId: lastMatch.id,
        resolvedDoctorId: doctor_id,
        rawInput: lastMatch.raw_input,
        learnedFrom: 'staff_correction',
      });
    }

    const { rows } = await pool.query(
      `UPDATE flags SET status = 'resolved', resolved_at = NOW(), assigned_to = $1 WHERE id = $2 RETURNING *`,
      [staff_id || null, id]
    );

    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to resolve doctor-match flag:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/flags/:id/resolve-enrollment
 * Resolves a 'doctor_match_failed' flag raised *during self-enrollment*
 * (QR spec Section 6.4/3's no-match / patient-rejected-the-guess paths) —
 * these have no patient yet, only clinic_id + context_phone on the flag
 * itself. Staff pick the correct doctor, which completes the enrollment on
 * the patient's behalf (same as if they'd sent a confident signal
 * themselves), notifies them over WhatsApp, marks the flag resolved, and
 * feeds the correction into the alias-learning loop.
 */
router.patch('/:id/resolve-enrollment', async (req, res) => {
  const { id } = req.params;
  const { staff_id, doctor_id } = req.body;

  if (!doctor_id) {
    return res.status(400).json({ error: 'doctor_id is required.' });
  }

  try {
    const flagRes = await pool.query('SELECT * FROM flags WHERE id = $1', [id]);
    const flag = flagRes.rows[0];
    if (!flag) {
      return res.status(404).json({ error: 'Flag not found.' });
    }
    if (flag.patient_id || !flag.clinic_id || !flag.context_phone) {
      return res.status(400).json({ error: 'This flag already has a patient — resolve it via PATCH /:id/resolve-doctor-match instead.' });
    }

    const pendingRes = await pool.query(
      'SELECT * FROM pending_enrollments WHERE clinic_id = $1 AND phone = $2',
      [flag.clinic_id, flag.context_phone]
    );
    const pending = pendingRes.rows[0];
    if (!pending) {
      return res.status(409).json({
        error: "This patient isn't mid-enrollment anymore — they may have already completed enrollment on their own, or never replied again. Check the Patients list before picking a doctor here.",
      });
    }

    const patient = await completeEnrollment({ pending, clinicId: flag.clinic_id, doctorId: doctor_id });

    const doctorRes = await pool.query('SELECT name FROM doctors WHERE id = $1', [doctor_id]);
    const clinicRes = await pool.query('SELECT name FROM clinics WHERE id = $1', [flag.clinic_id]);
    const doctorName = doctorRes.rows[0]?.name || 'your doctor';
    const clinicName = clinicRes.rows[0]?.name || 'your hospital';
    // doctorName is doctors.name, which already includes "Dr." by convention
    // (see Settings.tsx's placeholder) — don't prepend it again here.
    const confirmationText = `You're all set. You're connected with ${doctorName} at ${clinicName}.`;
    logConversation(patient.id, 'outbound', confirmationText, 'enrollment').catch((err) =>
      console.error('Failed to log enrollment confirmation:', err.message)
    );
    sendWhatsAppMessage(patient.phone, confirmationText, flag.clinic_id).catch((err) =>
      console.error('Failed to notify patient after resolve-enrollment:', err.message)
    );

    // Feed the correction back into the alias table (Section 8.2), same as
    // the patient-facing confirmation/rejection paths do.
    const logRes = await pool.query(
      `SELECT id, raw_input FROM doctor_match_log
       WHERE clinic_id = $1 AND context_phone = $2 AND staff_corrected_to IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [flag.clinic_id, flag.context_phone]
    );
    if (logRes.rows[0]) {
      await recordResolution({
        matchLogId: logRes.rows[0].id,
        resolvedDoctorId: doctor_id,
        rawInput: logRes.rows[0].raw_input,
        learnedFrom: 'staff_correction',
      });
    }

    const { rows } = await pool.query(
      `UPDATE flags SET status = 'resolved', resolved_at = NOW(), assigned_to = $1 WHERE id = $2 RETURNING *`,
      [staff_id || null, id]
    );

    return res.status(200).json({ success: true, data: { flag: rows[0], patient } });
  } catch (error) {
    console.error('Failed to resolve enrollment flag:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/flags/patients/:id/kill-switch
 * Instant kill switch to block/resume all automated outbound messages (Section 6.3)
 */
router.post('/patients/:id/kill-switch', async (req, res) => {
  const { id } = req.params;
  const { active } = req.body; // boolean

  try {
    const query = `UPDATE patients SET kill_switch_active = $1 WHERE id = $2 RETURNING id, kill_switch_active;`;
    const { rows } = await pool.query(query, [active, id]);
    return res.status(200).json({
      success: true,
      message: `Kill switch set to ${active}`,
      patient: rows[0]
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to toggle kill switch' });
  }
});

module.exports = router;
