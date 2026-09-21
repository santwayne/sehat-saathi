const axios = require('axios');
const { pool } = require('../db');

// Fallback for single-clinic / local-dev deployments and for any clinic row
// that hasn't had its own WABA credentials backfilled yet (see migration
// 002's backfill note). Once a clinic has its own whatsapp_phone_number_id +
// whatsapp_access_token in the DB, those take priority over these globals.
const GLOBAL_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLOBAL_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const GRAPH_VERSION = 'v18.0';

// Small in-process cache so a burst of messages for the same clinic (e.g. a
// scheduler scan sending 50 check-ins) doesn't re-query clinics for every one.
// Cleared entries just get refetched — safe to keep short.
const credCache = new Map();
const CRED_CACHE_TTL_MS = 60_000;

/**
 * Resolves the WhatsApp credentials to use for a given clinic. Falls back to
 * the global env vars when the clinic has no credentials of its own, or when
 * no clinicId is given at all (legacy call sites mid-migration).
 */
async function resolveClinicCredentials(clinicId) {
  if (!clinicId) {
    return { phoneNumberId: GLOBAL_PHONE_NUMBER_ID, accessToken: GLOBAL_TOKEN, clinicId: null };
  }

  const cached = credCache.get(clinicId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { rows } = await pool.query(
    'SELECT whatsapp_phone_number_id, whatsapp_access_token FROM clinics WHERE id = $1',
    [clinicId]
  );
  const clinic = rows[0];

  const value = {
    phoneNumberId: clinic?.whatsapp_phone_number_id || GLOBAL_PHONE_NUMBER_ID,
    accessToken: clinic?.whatsapp_access_token || GLOBAL_TOKEN,
    clinicId,
  };

  credCache.set(clinicId, { value, expiresAt: Date.now() + CRED_CACHE_TTL_MS });
  return value;
}

function apiUrlFor(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

// Strip everything except digits — WhatsApp expects e.g. 917087064479 (no +, no spaces)
function normalizePhone(phone) {
  return String(phone).replace(/\D/g, '');
}

// Bug 6 fix: nothing previously checked that a "WhatsApp number" was
// actually phone-shaped — any non-empty, not-already-used string (e.g.
// "12345") was accepted and enrolled permanently. E.164 numbers are at
// most 15 digits; 10 is the shortest plausible number including a country
// code (e.g. a US number with no leading '1'). This intentionally doesn't
// try to validate per-country length/prefix rules — just rejects
// obviously-not-a-phone-number input, on the already-normalized digits.
function isValidPhone(digitsOnly) {
  return /^\d{10,15}$/.test(digitsOnly);
}

/**
 * Send text message via WhatsApp API (only valid as a reply within a 24h
 * customer window). `clinicId` selects which hospital's WABA number/token to
 * send from — omit only for legacy/single-clinic call sites still being migrated.
 */
async function sendWhatsAppMessage(toPhone, text, clinicId) {
  const { phoneNumberId, accessToken } = await resolveClinicCredentials(clinicId);
  try {
    const response = await axios.post(
      apiUrlFor(phoneNumberId),
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizePhone(toPhone),
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Failed to send WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Send an approved WhatsApp template (required for all business-initiated messages)
 * @param {string} toPhone - recipient phone (with or without leading +)
 * @param {string} templateName - approved template name e.g. 'patient_welcome'
 * @param {string} languageCode - e.g. 'en', 'hi', 'pa'
 * @param {string[]} bodyParams - ordered list of {{1}}, {{2}} … substitution values
 * @param {string} [clinicId] - which hospital's WABA number/token to send from
 */
async function sendWhatsAppTemplate(toPhone, templateName, languageCode, bodyParams = [], clinicId) {
  const { phoneNumberId, accessToken } = await resolveClinicCredentials(clinicId);
  const components = bodyParams.length > 0
    ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })) }]
    : [];

  try {
    const response = await axios.post(
      apiUrlFor(phoneNumberId),
      {
        messaging_product: 'whatsapp',
        to: normalizePhone(toPhone),
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Failed to send WhatsApp template:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Download incoming media (e.g. prescription image, voice note) from WhatsApp
 * media URL. `clinicId` picks whose access token to use — media belongs to
 * the WABA number it was received on, not necessarily the global default.
 */
async function downloadWhatsAppMedia(mediaId, clinicId) {
  const { accessToken } = await resolveClinicCredentials(clinicId);

  const mediaRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const fileRes = await axios.get(mediaRes.data.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer',
  });

  const base64 = Buffer.from(fileRes.data, 'binary').toString('base64');
  const mimeType = fileRes.headers['content-type'] || mediaRes.data.mime_type || 'application/octet-stream';

  // Keep both the new generic names and the old image-specific ones so
  // existing callers (whatsapp.routes.js's image branch) don't need to change.
  return { base64, base64Image: base64, mimeType, mediaUrl: mediaRes.data.url };
}

module.exports = {
  normalizePhone,
  isValidPhone,
  resolveClinicCredentials,
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  downloadWhatsAppMedia,
};
