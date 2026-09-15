const { pool } = require('../db');
const { sendWhatsAppMessage, downloadWhatsAppMedia } = require('./whatsapp.service');
const { processPrescriptionOCR } = require('./ocr.service');
const { transcribeAudio } = require('./azure-speech.service');
const { matchDoctor, logMatchAttempt, recordResolution } = require('./doctor-match.service');
const { createEscalationFlag } = require('./escalation.service');

// QR hospital-wide self-enrollment (QR_SELF_ENROLLMENT_BUILD_SPEC.md, Section 4).
// Drives an unregistered WhatsApp sender through: name -> explicit consent ->
// doctor identification (photo OCR or voice note) -> patients row created.
// Nothing is written to `patients` until both name and consent are captured
// (Section 4.1) — every existing assumption elsewhere in the codebase that
// "a patients row = a consenting, enrolled patient" keeps holding.

const AFFIRMATIVE = /^(yes|y|yeah|yup|haan|ha+n?|han+ji|ji( haan)?|ok(ay)?|sure|theek( hai)?|thik( hai)?)\b/i;
const NEGATIVE = /^(no|nahi+n?|na|nope|nah)\b/i;

const MESSAGES = {
  welcome: (hospitalName) => `Welcome to ${hospitalName} on Sehat Saathi. What's your name?`,
  consent: (name) => `Thanks, ${name}. Reply YES to receive your prescription updates, reminders, and check-ins on this WhatsApp number.`,
  consentUnclear: "Sorry, I didn't quite get that. Please reply YES if you'd like to be enrolled and receive updates on WhatsApp.",
  askDoctorSignal: 'Got it. Please send a photo of the prescription or report you received today, or a short voice note telling us which doctor you saw.',
  confirmDoctor: (name) => `We think you saw Dr. ${name} — is that right? (Yes/No)`,
  confirmDoctorRetry: 'Sorry, please reply Yes or No — did you see that doctor?',
  noDoctorSignal: "We couldn't quite match that to a doctor here. Please try sending a clearer photo of the prescription/report, or a voice note naming your doctor — our team has also been notified.",
  enrolled: (doctorName, hospitalName) => `You're all set. You're connected with Dr. ${doctorName} at ${hospitalName}.`,
  mediaDownloadFailed: "Thanks — we received that but had trouble processing it. Please try sending it again, or a voice note naming your doctor.",
};

async function getPending(clinicId, phone) {
  const { rows } = await pool.query(
    'SELECT * FROM pending_enrollments WHERE clinic_id = $1 AND phone = $2',
    [clinicId, phone]
  );
  return rows[0] || null;
}

async function createPending(clinicId, phone) {
  const { rows } = await pool.query(
    `INSERT INTO pending_enrollments (clinic_id, phone, stage) VALUES ($1, $2, 'awaiting_name') RETURNING *`,
    [clinicId, phone]
  );
  return rows[0];
}

async function updatePending(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(`UPDATE pending_enrollments SET ${setClauses} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

async function getClinic(clinicId) {
  const { rows } = await pool.query('SELECT id, name FROM clinics WHERE id = $1', [clinicId]);
  return rows[0];
}

/**
 * Creates the `patients` row (the actual moment of enrollment), attaches any
 * document collected during the doctor-signal step, and clears the pending row.
 */
async function completeEnrollment({ pending, clinicId, doctorId }) {
  const { rows } = await pool.query(
    `INSERT INTO patients (clinic_id, name, phone, language_pref, consent_given, assigned_doctor_id)
     VALUES ($1, $2, $3, $4, true, $5) RETURNING *`,
    [clinicId, pending.name, pending.phone, pending.language_pref || 'hi', doctorId || null]
  );
  const patient = rows[0];

  if (pending.candidate_document_id) {
    await pool.query(
      'UPDATE prescriptions SET patient_id = $1, doctor_id = $2 WHERE id = $3',
      [patient.id, doctorId || null, pending.candidate_document_id]
    );
  }

  await pool.query('DELETE FROM pending_enrollments WHERE id = $1', [pending.id]);
  return patient;
}

/**
 * Runs the shared matching engine (Section 6.4) against a raw doctor-name
 * signal and either completes enrollment, asks for a Yes/No confirmation, or
 * flags staff when nothing matches.
 */
async function resolveDoctorSignal({ pending, clinic, source, rawInput }) {
  const match = await matchDoctor({ clinicId: clinic.id, rawInput });
  const matchLogId = await logMatchAttempt({
    clinicId: clinic.id,
    patientId: null,
    source,
    rawInput,
    matchedDoctorId: match.candidate?.id,
    matchConfidence: match.status === 'no_match' ? null : (match.status === 'high_confidence' ? 'high' : 'low'),
  });

  if (match.status === 'high_confidence') {
    if (!match.viaAlias) {
      await recordResolution({ matchLogId, resolvedDoctorId: match.candidate.id, rawInput, learnedFrom: 'confirmed_match' });
    }
    const patient = await completeEnrollment({ pending, clinicId: clinic.id, doctorId: match.candidate.id });
    await sendWhatsAppMessage(pending.phone, MESSAGES.enrolled(match.candidate.name, clinic.name), clinic.id);
    return { completed: true, patient };
  }

  if (match.status === 'low_confidence') {
    await updatePending(pending.id, { candidate_doctor_id: match.candidate.id, candidate_match_log_id: matchLogId });
    await sendWhatsAppMessage(pending.phone, MESSAGES.confirmDoctor(match.candidate.name), clinic.id);
    return { completed: false, awaitingConfirmation: true };
  }

  await createEscalationFlag({
    patientId: null,
    conversationId: null,
    flagType: 'doctor_match_failed',
    priority: 'normal',
    assignedDoctorId: null,
    reason: `Self-enrolling patient ${pending.phone} at clinic ${clinic.id} sent a ${source} signal ("${rawInput}") that couldn't be matched to any doctor. Needs manual assignment once they complete enrollment.`,
  });
  await sendWhatsAppMessage(pending.phone, MESSAGES.noDoctorSignal, clinic.id);
  return { completed: false, awaitingConfirmation: false };
}

async function handleImageSignal({ pending, clinic, mediaId }) {
  let downloaded;
  try {
    downloaded = await downloadWhatsAppMedia(mediaId, clinic.id);
  } catch (err) {
    console.error('Enrollment: failed to download image:', err.message);
    await sendWhatsAppMessage(pending.phone, MESSAGES.mediaDownloadFailed, clinic.id);
    return;
  }

  const ocrResult = await processPrescriptionOCR(downloaded.base64, downloaded.mimeType);

  // Save the document now (patient_id NULL is fine — see schema) so it isn't
  // lost even if doctor resolution needs another round-trip.
  const docRes = await pool.query(
    `INSERT INTO prescriptions (document_type, image_url, ocr_raw_text, structured_json, ocr_confidence, verified_by_staff)
     VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
    [ocrResult.documentType, downloaded.mediaUrl, ocrResult.rawText, ocrResult.structuredData, ocrResult.ocrConfidence]
  );
  await updatePending(pending.id, { candidate_document_id: docRes.rows[0].id });
  pending.candidate_document_id = docRes.rows[0].id;

  if (!ocrResult.doctorName || ocrResult.doctorNameConfidence === 'low') {
    await sendWhatsAppMessage(pending.phone, MESSAGES.noDoctorSignal, clinic.id);
    return;
  }

  await resolveDoctorSignal({ pending, clinic, source: 'ocr', rawInput: ocrResult.doctorName });
}

async function handleAudioSignal({ pending, clinic, mediaId }) {
  let downloaded;
  try {
    downloaded = await downloadWhatsAppMedia(mediaId, clinic.id);
  } catch (err) {
    console.error('Enrollment: failed to download audio:', err.message);
    await sendWhatsAppMessage(pending.phone, MESSAGES.mediaDownloadFailed, clinic.id);
    return;
  }

  const { transcript } = await transcribeAudio(Buffer.from(downloaded.base64, 'base64'), downloaded.mimeType, pending.language_pref);

  if (!transcript) {
    await sendWhatsAppMessage(pending.phone, MESSAGES.noDoctorSignal, clinic.id);
    return;
  }

  await resolveDoctorSignal({ pending, clinic, source: 'voice', rawInput: transcript });
}

async function handleConfirmationReply({ pending, clinic, text }) {
  if (AFFIRMATIVE.test(text)) {
    const docRes = await pool.query('SELECT name FROM doctors WHERE id = $1', [pending.candidate_doctor_id]);
    const doctorName = docRes.rows[0]?.name || 'your doctor';
    await recordResolution({
      matchLogId: pending.candidate_match_log_id,
      resolvedDoctorId: pending.candidate_doctor_id,
      rawInput: doctorName,
      learnedFrom: 'confirmed_match',
    });
    await completeEnrollment({ pending, clinicId: clinic.id, doctorId: pending.candidate_doctor_id });
    await sendWhatsAppMessage(pending.phone, MESSAGES.enrolled(doctorName, clinic.name), clinic.id);
    return;
  }

  if (NEGATIVE.test(text)) {
    await updatePending(pending.id, { candidate_doctor_id: null, candidate_match_log_id: null });
    await createEscalationFlag({
      patientId: null,
      conversationId: null,
      flagType: 'doctor_match_failed',
      priority: 'normal',
      assignedDoctorId: null,
      reason: `Self-enrolling patient ${pending.phone} at clinic ${clinic.id} rejected the suggested doctor match. Needs manual assignment.`,
    });
    await sendWhatsAppMessage(pending.phone, MESSAGES.noDoctorSignal, clinic.id);
    return;
  }

  await sendWhatsAppMessage(pending.phone, MESSAGES.confirmDoctorRetry, clinic.id);
}

/**
 * Entry point called from the webhook whenever an inbound message's sender
 * doesn't match any enrolled `patients` row for this clinic.
 */
async function handleSelfEnrollment({ clinicId, senderPhone, messageType, message }) {
  const clinic = await getClinic(clinicId);
  if (!clinic) return;

  let pending = await getPending(clinicId, senderPhone);

  if (!pending) {
    pending = await createPending(clinicId, senderPhone);
    await sendWhatsAppMessage(senderPhone, MESSAGES.welcome(clinic.name), clinic.id);
    return;
  }
  pending.phone = senderPhone;

  if (pending.stage === 'awaiting_name') {
    const name = messageType === 'text' ? message.text?.body?.trim() : '';
    if (!name) {
      await sendWhatsAppMessage(senderPhone, MESSAGES.welcome(clinic.name), clinic.id);
      return;
    }
    await updatePending(pending.id, { name: name.slice(0, 255), stage: 'awaiting_consent' });
    await sendWhatsAppMessage(senderPhone, MESSAGES.consent(name), clinic.id);
    return;
  }

  if (pending.stage === 'awaiting_consent') {
    const text = messageType === 'text' ? (message.text?.body || '').trim() : '';
    if (AFFIRMATIVE.test(text)) {
      await updatePending(pending.id, { consent_given: true, stage: 'awaiting_doctor_signal' });
      await sendWhatsAppMessage(senderPhone, MESSAGES.askDoctorSignal, clinic.id);
    } else {
      // Never silently advance on an ambiguous/negative reply (spec 4.2 step 3) — re-ask once.
      await sendWhatsAppMessage(senderPhone, MESSAGES.consentUnclear, clinic.id);
    }
    return;
  }

  if (pending.stage === 'awaiting_doctor_signal') {
    // A pending Yes/No confirmation on a low-confidence guess takes priority
    // over treating this message as a fresh signal.
    if (pending.candidate_doctor_id && messageType === 'text') {
      await handleConfirmationReply({ pending, clinic, text: (message.text?.body || '').trim() });
      return;
    }

    if (messageType === 'image') {
      await handleImageSignal({ pending, clinic, mediaId: message.image.id });
      return;
    }

    if (messageType === 'audio') {
      await handleAudioSignal({ pending, clinic, mediaId: message.audio.id });
      return;
    }

    await sendWhatsAppMessage(senderPhone, MESSAGES.askDoctorSignal, clinic.id);
  }
}

module.exports = { handleSelfEnrollment };
