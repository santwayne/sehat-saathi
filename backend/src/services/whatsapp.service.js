const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

function normalizePhone(phone) {
  return String(phone).replace(/^\+/, '');
}

/**
 * Send text message via WhatsApp API (only valid as a reply within a 24h customer window)
 */
async function sendWhatsAppMessage(toPhone, text) {
  try {
    const response = await axios.post(
      API_URL,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizePhone(toPhone),
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
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
 */
async function sendWhatsAppTemplate(toPhone, templateName, languageCode, bodyParams = []) {
  const components = bodyParams.length > 0
    ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })) }]
    : [];

  try {
    const response = await axios.post(
      API_URL,
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
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
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
 * Download incoming media (e.g. prescription image) from WhatsApp media URL
 */
async function downloadWhatsAppMedia(mediaId) {
  const mediaRes = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  const imageRes = await axios.get(mediaRes.data.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: 'arraybuffer',
  });

  const base64Image = Buffer.from(imageRes.data, 'binary').toString('base64');
  const mimeType = imageRes.headers['content-type'] || 'image/jpeg';

  return { base64Image, mimeType, mediaUrl: mediaRes.data.url };
}

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  downloadWhatsAppMedia,
};
