const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { downloadWhatsAppMedia, sendWhatsAppMessage, normalizePhone } = require('../services/whatsapp.service');
const { processPrescriptionOCR } = require('../services/ocr.service');
const { processInboundMessage, logConversation } = require('../services/conversation.service');
const { createEscalationFlag } = require('../services/escalation.service');
const { handleSelfEnrollment } = require('../services/enrollment.service');
const { matchDoctor, logMatchAttempt } = require('../services/doctor-match.service');
const { transcribeAudio } = require('../services/azure-speech.service');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// Meta Webhook Verification Endpoint
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming Message Webhook Handler
router.post('/webhook', async (req, res) => {
  // Always return 200 immediately to acknowledge WhatsApp
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    // Super Admin Part B (multi-hospital WhatsApp routing): Meta's payload
    // tells us exactly which hospital's number this message arrived on,
    // *before* we even look at the sender — resolve that first. One Meta app
    // can have many hospital numbers subscribed to this same webhook URL.
    const incomingPhoneNumberId = value?.metadata?.phone_number_id;
    const clinicRes = await pool.query(
      'SELECT id, name, status FROM clinics WHERE whatsapp_phone_number_id = $1',
      [incomingPhoneNumberId]
    );
    const clinic = clinicRes.rows[0];

    if (!clinic) {
      console.error(`Webhook hit for unregistered phone_number_id ${incomingPhoneNumberId} — no clinic has this WhatsApp number configured.`);
      return;
    }

    if (clinic.status === 'suspended') {
      console.log(`Message for suspended clinic ${clinic.id} ignored.`);
      return;
    }

    const senderPhone = normalizePhone(message.from);
    const messageType = message.type;

    // Scoped to this clinic (B5 fix): without this, a phone number enrolled
    // at two different clinics would be ambiguous — not possible today with
    // one deployment, but very possible now that multiple hospitals share
    // this one webhook.
    const patientRes = await pool.query(
      'SELECT id, language_pref, kill_switch_active, assigned_doctor_id, consent_given FROM patients WHERE phone = $1 AND clinic_id = $2',
      [senderPhone, clinic.id]
    );
    const patient = patientRes.rows[0];

    // QR self-enrollment (QR_SELF_ENROLLMENT_BUILD_SPEC.md, Section 3): an
    // unrecognized sender is no longer silently ignored — they've scanned
    // the hospital's QR and are starting (or continuing) self-enrollment.
    if (!patient) {
      await handleSelfEnrollment({ clinicId: clinic.id, senderPhone, messageType, message });
      return;
    }

    // Defense-in-depth for Bug 5: enrollment now requires consent_given
    // (both the staff-form path and the new self-enrollment path above), so
    // this should be unreachable for any newly-enrolled patient — kept as a
    // second gate in case a pre-existing row without consent is still in the DB.
    if (!patient.consent_given) {
      console.log(`Message from ${senderPhone} ignored: consent not on file.`);
      return;
    }

    if (patient.kill_switch_active) {
      console.log(`Message from ${senderPhone} ignored: kill switch active.`);
      return;
    }

    // Handle incoming image (prescription/lab report photo)
    if (messageType === 'image') {
      const inboundConversationId = await logConversation(patient.id, 'inbound', '[Document photo received]', 'prescription_image');

      const mediaId = message.image.id;
      let downloaded;
      try {
        downloaded = await downloadWhatsAppMedia(mediaId, clinic.id);
      } catch (err) {
        // Media download can fail independently of OCR (expired token, media
        // ID no longer valid, network error) — image_url is NOT NULL on
        // prescriptions, so there's no row we can safely insert here. Raise
        // a flag instead so staff know a photo arrived and needs manual
        // follow-up, rather than the message vanishing with only a server
        // log line no one will see.
        console.error('Failed to download WhatsApp media:', err.message);
        await createEscalationFlag({
          patientId: patient.id,
          conversationId: inboundConversationId,
          flagType: 'ocr_low_confidence',
          priority: 'normal',
          assignedDoctorId: patient.assigned_doctor_id,
          reason: `Document photo received but could not be downloaded from WhatsApp: ${err.message}`,
        });
        await sendWhatsAppMessage(
          senderPhone,
          'Thank you. We received your image but had trouble processing it — our team has been notified and will follow up.',
          clinic.id
        );
        return;
      }
      const { base64, mimeType, mediaUrl } = downloaded;

      // Trigger OCR service — never throws now (see ocr.service.js), always
      // returns a safe fail-safe result on failure, so no separate
      // try/catch is needed here.
      const ocrResult = await processPrescriptionOCR(base64, mimeType);

      // Persist immediately with verified_by_staff = false — nothing derived from this
      // reaches the patient until staff verify it (Section 4.1, step 3).
      const insertedRes = await pool.query(
        `INSERT INTO prescriptions (patient_id, document_type, image_url, ocr_raw_text, structured_json, ocr_confidence, verified_by_staff)
         VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
        [patient.id, ocrResult.documentType, mediaUrl, ocrResult.rawText, ocrResult.structuredData, ocrResult.ocrConfidence]
      );

      // Doctor re-identification for an already-enrolled patient (Section
      // 4.4 / Section 7): a fresh document can update assigned_doctor_id if
      // the patient wasn't assigned yet, but a confident match to a
      // *different* doctor than the one already on file never silently
      // overwrites it — staff confirm which is correct instead.
      if (ocrResult.doctorName && ocrResult.doctorNameConfidence !== 'low') {
        const match = await matchDoctor({ clinicId: clinic.id, rawInput: ocrResult.doctorName });
        await logMatchAttempt({
          clinicId: clinic.id,
          patientId: patient.id,
          source: 'ocr',
          rawInput: ocrResult.doctorName,
          matchedDoctorId: match.candidate?.id,
          matchConfidence: match.status === 'no_match' ? null : (match.status === 'high_confidence' ? 'high' : 'low'),
        });

        if (match.status === 'high_confidence') {
          if (!patient.assigned_doctor_id) {
            await pool.query('UPDATE patients SET assigned_doctor_id = $1 WHERE id = $2', [match.candidate.id, patient.id]);
            await pool.query('UPDATE prescriptions SET doctor_id = $1 WHERE id = $2', [match.candidate.id, insertedRes.rows[0].id]);
          } else if (match.candidate.id !== patient.assigned_doctor_id) {
            await createEscalationFlag({
              patientId: patient.id,
              conversationId: inboundConversationId,
              flagType: 'doctor_match_conflict',
              priority: 'normal',
              assignedDoctorId: patient.assigned_doctor_id,
              reason: `New document names ${match.candidate.name}, but this patient is currently assigned to a different doctor. Please confirm which is correct.`,
            });
          }
        }
      }

      await sendWhatsAppMessage(
        senderPhone,
        'Thank you. We have received your image. Our team is reviewing it to ensure complete accuracy.',
        clinic.id
      );
    }
    // Handle incoming voice note
    else if (messageType === 'audio') {
      await logConversation(patient.id, 'inbound', '[Voice note received]', 'other');

      const mediaId = message.audio.id;
      let downloaded;
      try {
        downloaded = await downloadWhatsAppMedia(mediaId, clinic.id);
      } catch (err) {
        console.error('Failed to download WhatsApp voice note:', err.message);
        await sendWhatsAppMessage(senderPhone, 'Thank you. We received your voice note but had trouble processing it — please try again.', clinic.id);
        return;
      }

      const { transcript } = await transcribeAudio(
        Buffer.from(downloaded.base64, 'base64'),
        downloaded.mimeType,
        patient.language_pref
      );

      if (!transcript) {
        await sendWhatsAppMessage(senderPhone, "Sorry, we couldn't quite make that out. Could you send it as a text message instead?", clinic.id);
        return;
      }

      await logConversation(patient.id, 'inbound', `[Voice transcript] ${transcript}`, 'other');

      // Route the transcript through the same conversation engine as a text
      // message — an already-enrolled patient's voice note is most often a
      // question or check-in response, same handling either way.
      const result = await processInboundMessage(patient.id, transcript);
      if (result && result.replyText) {
        await sendWhatsAppMessage(senderPhone, result.replyText, clinic.id);
      }
    }
    // Handle incoming text (questions / check-in responses)
    else if (messageType === 'text') {
      const textContent = message.text.body;

      // Pass to Conversation Engine handler, scoped to this patient's own record
      const result = await processInboundMessage(patient.id, textContent);
      if (result && result.replyText) {
        await sendWhatsAppMessage(senderPhone, result.replyText, clinic.id);
      }
    }
  } catch (error) {
    console.error('Error handling webhook payload:', error);
  }
});

module.exports = router;
