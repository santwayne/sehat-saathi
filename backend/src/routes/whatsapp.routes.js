const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { downloadWhatsAppMedia, sendWhatsAppMessage, normalizePhone } = require('../services/whatsapp.service');
const { processPrescriptionOCR } = require('../services/ocr.service');
const { processInboundMessage } = require('../services/conversation.service');

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

    const senderPhone = normalizePhone(message.from);
    const messageType = message.type;

    // Every inbound sender must already exist as an enrolled, consenting patient
    // (Section 6.3: explicit consent capture happens via the clinic dashboard, not over WhatsApp).
    const patientRes = await pool.query(
      'SELECT id, language_pref, kill_switch_active FROM patients WHERE phone = $1',
      [senderPhone]
    );
    const patient = patientRes.rows[0];

    if (!patient) {
      console.log(`Message from unregistered number ${senderPhone} ignored.`);
      return;
    }

    if (patient.kill_switch_active) {
      console.log(`Message from ${senderPhone} ignored: kill switch active.`);
      return;
    }

    // Handle incoming image (prescription photo sent by patient or staff)
    if (messageType === 'image') {
      const mediaId = message.image.id;
      const { base64Image, mimeType, mediaUrl } = await downloadWhatsAppMedia(mediaId);

      // Trigger OCR service
      const ocrResult = await processPrescriptionOCR(base64Image, mimeType);

      // Persist immediately with verified_by_staff = false — nothing derived from this
      // reaches the patient until staff verify it (Section 4.1, step 3).
      await pool.query(
        `INSERT INTO prescriptions (patient_id, image_url, ocr_raw_text, structured_json, ocr_confidence, verified_by_staff)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [patient.id, mediaUrl, ocrResult.rawText, ocrResult.structuredData, ocrResult.ocrConfidence]
      );

      await sendWhatsAppMessage(
        senderPhone,
        'Thank you. We have received your prescription image. Our team is reviewing it to ensure complete accuracy.'
      );
    }
    // Handle incoming text (questions / check-in responses)
    else if (messageType === 'text') {
      const textContent = message.text.body;

      // Pass to Conversation Engine handler, scoped to this patient's own record
      const result = await processInboundMessage(patient.id, textContent);
      if (result && result.replyText) {
        await sendWhatsAppMessage(senderPhone, result.replyText);
      }
    }
  } catch (error) {
    console.error('Error handling webhook payload:', error);
  }
});

module.exports = router;
