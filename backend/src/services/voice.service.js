const axios = require('axios');
const crypto = require('crypto');
const { pool } = require('../db');
const { LANGUAGES, t, VOICE_CHECKIN_LOG_PREFIX } = require('./i18n');

// Voice check-in calls (roadmap "Later"). Twilio places the call and does the
// speech-to-text / text-to-speech itself (<Gather>/<Say>), so there is no media
// streaming here — Twilio just calls our TwiML webhooks (routes/voice.routes.js).
// Off unless TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VOICE_NUMBER and
// PUBLIC_BASE_URL are set; check-ins then keep going out on WhatsApp.
//
// Not yet run against a real Twilio account. Voice names default to Twilio's
// Google voices ("Google.<locale>-Standard-A"); override per language with
// TWILIO_VOICE_<LANG> (e.g. TWILIO_VOICE_TA) if a voice isn't available.

const cfg = () => ({
  sid: process.env.TWILIO_ACCOUNT_SID,
  token: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_VOICE_NUMBER,
  baseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
});

function isConfigured() {
  const c = cfg();
  return !!(c.sid && c.token && c.from && c.baseUrl);
}

/** Twilio's request signature: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)). */
function validTwilioSignature(url, params, signature) {
  const token = cfg().token;
  if (!token || !signature) return false;
  const data = Object.keys(params || {}).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function localeFor(lang) {
  return (LANGUAGES[lang] || LANGUAGES.en).azure; // BCP-47, same codes Twilio uses
}

function voiceFor(lang) {
  const code = LANGUAGES[lang] ? lang : 'en';
  return process.env[`TWILIO_VOICE_${code.toUpperCase()}`] || `Google.${localeFor(code)}-Standard-A`;
}

function say(text, lang) {
  return `<Say language="${localeFor(lang)}" voice="${xmlEscape(voiceFor(lang))}">${xmlEscape(text)}</Say>`;
}

const twiml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** TwiML that asks the check-in question and listens for a keypress or speech. */
function checkinTwiml(lang, patientId) {
  const base = cfg().baseUrl;
  const q = `patient_id=${encodeURIComponent(patientId)}`;
  return twiml(
    `<Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" language="${localeFor(lang)}" method="POST" action="${xmlEscape(`${base}/api/voice/twiml/response?${q}`)}">` +
      say(t('checkinVoice', lang), lang) +
    `</Gather><Redirect method="POST">${xmlEscape(`${base}/api/voice/twiml/no-input?${q}`)}</Redirect>`
  );
}

const sayAndHangup = (text, lang) => twiml(`${say(text, lang)}<Hangup/>`);

/**
 * Places the check-in call. Resolves once Twilio accepts it; the conversation
 * itself happens through the webhooks. Throws on any Twilio error so callers
 * can fall back to WhatsApp.
 */
async function placeCheckinCall(patient, clinicId) {
  if (clinicId && (await callRoute(clinicId)) === 'waynering') return placeWayneRingCall(patient, clinicId);
  const c = cfg();
  const body = new URLSearchParams({
    To: `+${String(patient.phone).replace(/\D/g, '')}`,
    From: c.from,
    Url: `${c.baseUrl}/api/voice/twiml/checkin?patient_id=${encodeURIComponent(patient.id)}`,
    StatusCallback: `${c.baseUrl}/api/voice/status?patient_id=${encodeURIComponent(patient.id)}`,
    Timeout: '25',
  });
  const { data } = await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Calls.json`, body.toString(), {
    auth: { username: c.sid, password: c.token },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  await pool.query(
    `INSERT INTO conversations (patient_id, channel, direction, message_text, intent_type, external_id)
     VALUES ($1, 'voice', 'outbound', $2, 'checkin_response', $3)`,
    [patient.id, `${VOICE_CHECKIN_LOG_PREFIX}${t('checkinVoice', patient.language_pref)}`, data.sid || null]
  );
  return data.sid;
}

/**
 * Loopdesk bundle rule: a hospital made by Loopdesk only gets voice calls when
 * WayneRing is in its package; otherwise check-ins stay on WhatsApp. Hospitals
 * made by hand are unaffected.
 */
async function allowedForClinic(clinicId) {
  const { hubInfoFor, voiceAllowed } = require('./hub.service');
  return voiceAllowed(await hubInfoFor(clinicId));
}

// ---------------------------------------------------------------------------
// WayneRing (Loopdesk's AI calling product). Bundle rule: a Loopdesk hospital's
// calls go only through WayneRing. Same outbound-call contract as Loyvexa
// (src/services/calls/providers.js there):
//   POST {WAYNERING_BASE_URL}/api/v1/outbound-calls   Bearer WAYNERING_API_KEY
//   { to, language, first_message, instructions, variables, metadata, webhook_url } → { id | call_id }
//   webhook  POST /api/voice/waynering/webhook, header x-waynering-signature =
//            hex HMAC-SHA256(CALL_WEBHOOK_SECRET, raw body)
//   { id|call_id, status, outcome|disposition, summary, transcript, metadata }
// Confirm field names against the WayneRing API before going live.
// ---------------------------------------------------------------------------
const wr = () => ({
  base: (process.env.WAYNERING_BASE_URL || '').replace(/\/$/, ''),
  key: process.env.WAYNERING_API_KEY || '',
  secret: process.env.CALL_WEBHOOK_SECRET || '',
  publicBase: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
});
const wayneRingConfigured = () => { const c = wr(); return !!(c.base && c.key && c.secret && c.publicBase); };

/** May this hospital's patients get a voice check-in right now, and through what? */
async function callRoute(clinicId) {
  const { hubInfoFor, isHubClinic, voiceAllowed } = require('./hub.service');
  const info = await hubInfoFor(clinicId);
  if (isHubClinic(info)) return voiceAllowed(info) && wayneRingConfigured() ? 'waynering' : null;
  return isConfigured() ? 'twilio' : null;
}
const canCall = async (clinicId) => !!(await callRoute(clinicId));

const LANG_NAMES = { hi: 'Hindi', pa: 'Punjabi', en: 'English' };

function wayneRingInstructions(lang, clinicName) {
  const language = LANG_NAMES[lang] || 'Hindi';
  return [
    `You are Sehat Saathi, the patient follow-up assistant of ${clinicName || 'the hospital'}. Speak only ${language}, simply and politely.`,
    'Ask one thing: did the patient take today\'s medicines as the doctor prescribed?',
    'Never give medical advice, never tell anyone to start, stop, skip, change or substitute any medicine or dose, and never diagnose.',
    'If the patient mentions any new or worse symptom, pain, bleeding, breathing trouble, fainting or anything worrying, say the hospital team will contact them soon, and end the call.',
    'Keep the call under one minute. Set the disposition to TOOK_MEDICINE, MISSED_DOSE, SYMPTOM or NO_ANSWER.',
  ].join(' ');
}

async function placeWayneRingCall(patient, clinicId) {
  const c = wr();
  const { rows: [clinic] } = await pool.query('SELECT name FROM clinics WHERE id = $1', [clinicId]);
  const firstMessage = t('checkinVoice', patient.language_pref);
  const { data } = await axios.post(`${c.base}/api/v1/outbound-calls`, {
    to: `+${String(patient.phone).replace(/\D/g, '')}`,
    language: patient.language_pref || 'hi',
    first_message: firstMessage,
    instructions: wayneRingInstructions(patient.language_pref, clinic?.name),
    variables: { clinic: clinic?.name || '' },
    metadata: { sehat_saathi_patient_id: patient.id, clinic_id: clinicId },
    webhook_url: `${c.publicBase}/api/voice/waynering/webhook`,
  }, {
    headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `ss-${patient.id}-${new Date().toISOString().slice(0, 13)}` },
    timeout: 20_000,
  });
  const callId = data?.id || data?.call_id || null;
  await pool.query(
    `INSERT INTO conversations (patient_id, channel, direction, message_text, intent_type, external_id)
     VALUES ($1, 'voice', 'outbound', $2, 'checkin_response', $3)`,
    [patient.id, `${VOICE_CHECKIN_LOG_PREFIX}${firstMessage}`, callId]
  );
  return callId;
}

/** Verifies the WayneRing webhook signature over the raw body. */
function validWayneRingSignature(rawBody, signature) {
  const secret = wr().secret;
  if (!secret || !signature || typeof rawBody !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, allowedForClinic, callRoute, canCall, wayneRingConfigured, placeWayneRingCall, validWayneRingSignature, wayneRingInstructions, validTwilioSignature, xmlEscape, say, twiml, checkinTwiml, sayAndHangup, placeCheckinCall };
