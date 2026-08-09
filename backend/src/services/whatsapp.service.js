const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

/**
 * Send text message via WhatsApp API
 */
async function sendWhatsAppMessage(toPhone, text) {
  try {
    const response = await axios.post(
      API_URL,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
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
  downloadWhatsAppMedia,
};
