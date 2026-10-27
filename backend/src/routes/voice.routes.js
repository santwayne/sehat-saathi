const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const voice = require('../services/voice.service');
const { t } = require('../services/i18n');
const { sendWhatsAppMessage } = require('../services/whatsapp.service');
const { processInboundMessage, logConversation } = require('../services/conversation.service');
const { createEscalationFlag } = require('../services/escalation.service');

// Twilio webhooks for voice check-ins. Twilio posts form-encoded bodies and
// signs every request; unsigned/forged requests are rejected, and the whole
// router answers 503 until Twilio is configured.
router.use(express.urlencoded({ extended: false }));

function requireTwilio(req, res, next) {
  if (!voice.isConfigured()) return res.status(503).type('text/plain').send('Voice calls are not configured.');
  const url = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}${req.originalUrl}`;
  if (!voice.validTwilioSignature(url, req.body, req.get('X-Twilio-Signature'))) {
    return res.status(403).type('text/plain').send('Invalid signature.');
  }
  next();
}
router.use(requireTwilio);

const xml = (res, body) => res.status(200).type('text/xml').send(body);

// Same gates as every other outbound path: consent on file, kill switch off.
async function loadPatient(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { rows } = await pool.query(
    'SELECT id, phone, name, language_pref, clinic_id, assigned_doctor_id, consent_given, kill_switch_active FROM patients WHERE id = $1',
    [id]
  );
  const p = rows[0];
  return p && p.consent_given && !p.kill_switch_active ? p : null;
}

router.post('/twiml/checkin', async (req, res) => {
  try {
    const patient = await loadPatient(req.query.patient_id);
    if (!patient) return xml(res, voice.twiml('<Hangup/>'));
    return xml(res, voice.checkinTwiml(patient.language_pref, patient.id));
  } catch (err) {
    console.error('Voice check-in TwiML failed:', err.message);
    return xml(res, voice.twiml('<Hangup/>'));
  }
});

router.post('/twiml/response', async (req, res) => {
  try {
    const patient = await loadPatient(req.query.patient_id);
    if (!patient) return xml(res, voice.twiml('<Hangup/>'));
    const lang = patient.language_pref;
    const digit = (req.body.Digits || '').trim();
    const speech = (req.body.SpeechResult || '').trim();

    if (digit === '1' || digit === '2') {
      const missed = digit === '2';
      const convId = await logConversation(patient.id, 'inbound', missed ? '[Voice] Missed a dose' : '[Voice] Took medicines', 'checkin_response', 'patient', 'voice');
      if (missed) {
        // Don't stack duplicates: one open missed-dose flag per patient is enough for staff.
        const open = await pool.query(`SELECT 1 FROM flags WHERE patient_id = $1 AND flag_type = 'missed_dose' AND status = 'open'`, [patient.id]);
        if (open.rows.length === 0) {
          await createEscalationFlag({
            patientId: patient.id, conversationId: convId, flagType: 'missed_dose', priority: 'normal',
            assignedDoctorId: patient.assigned_doctor_id, reason: 'Patient reported a missed dose on a voice check-in call.',
          });
        }
      }
      await logConversation(patient.id, 'outbound', t('voiceThanks', lang), 'checkin_response', null, 'voice');
      return xml(res, voice.sayAndHangup(t('voiceThanks', lang), lang));
    }

    if (speech) {
      // Free speech goes through the same prescription-bounded, safety-checked
      // engine as a WhatsApp message (urgent keywords still escalate).
      const result = await processInboundMessage(patient.id, speech, { channel: 'voice' });
      return xml(res, voice.sayAndHangup(result?.replyText || t('voiceThanks', lang), lang));
    }

    return xml(res, voice.sayAndHangup(t('voiceThanks', lang), lang));
  } catch (err) {
    console.error('Voice response handling failed:', err.message);
    return xml(res, voice.twiml('<Hangup/>'));
  }
});

// Call was answered but nothing was pressed or said: fall back to the WhatsApp check-in.
router.post('/twiml/no-input', async (req, res) => {
  try {
    const patient = await loadPatient(req.query.patient_id);
    if (!patient) return xml(res, voice.twiml('<Hangup/>'));
    await sendWhatsAppMessage(patient.phone, t('checkin', patient.language_pref), patient.clinic_id).catch((e) => console.error('WhatsApp fallback failed:', e.message));
    return xml(res, voice.sayAndHangup(t('voiceThanks', patient.language_pref), patient.language_pref));
  } catch (err) {
    console.error('Voice no-input handling failed:', err.message);
    return xml(res, voice.twiml('<Hangup/>'));
  }
});

// Unanswered / busy / failed calls: send the same check-in on WhatsApp instead.
router.post('/status', async (req, res) => {
  try {
    if (['no-answer', 'busy', 'failed'].includes(req.body.CallStatus)) {
      const patient = await loadPatient(req.query.patient_id);
      if (patient) {
        const text = t('checkin', patient.language_pref);
        await sendWhatsAppMessage(patient.phone, text, patient.clinic_id);
        // Prefixed so reports don't count it as a second check-in: it is the
        // fallback for the call already logged, and a reply to it still counts
        // as that check-in being answered.
        await logConversation(patient.id, 'outbound', `[WhatsApp fallback] ${text}`, 'checkin_response');
      }
    }
  } catch (err) {
    console.error('Voice status handling failed:', err.message);
  }
  return res.sendStatus(204);
});

module.exports = router;
