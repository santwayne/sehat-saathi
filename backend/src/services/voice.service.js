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
async function placeCheckinCall(patient) {
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

module.exports = { isConfigured, validTwilioSignature, xmlEscape, say, twiml, checkinTwiml, sayAndHangup, placeCheckinCall };
