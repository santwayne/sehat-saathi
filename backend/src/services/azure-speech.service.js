const axios = require('axios');
const FormData = require('form-data');

const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION;

// Section 6.1: chosen for Hindi/Punjabi patient voice notes specifically —
// this is a general-capability claim, NOT yet validated against this
// product's real-world audio (accented, phone-mic, background clinic noise).
// See Section 6.5 — re-verify with a real sample batch before trusting this
// in production without the low-confidence confirmation step.
const LOCALE_MAP = { hi: 'hi-IN', pa: 'pa-IN', en: 'en-IN' };
const ALL_LOCALES = Object.values(LOCALE_MAP);

/**
 * Transcribes a short WhatsApp voice note via Azure's fast-transcription
 * REST API (batch/long-form transcription would add latency a patient
 * waiting for a WhatsApp reply shouldn't have to sit through).
 *
 * @param {Buffer} audioBuffer
 * @param {string} mimeType - e.g. 'audio/ogg; codecs=opus' (WhatsApp voice notes)
 * @param {string} [languageHint] - 'hi' | 'pa' | 'en'; when absent, auto-detects across all three
 */
async function transcribeAudio(audioBuffer, mimeType, languageHint) {
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    console.error('Azure Speech not configured (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION missing).');
    return { transcript: null, error: 'not_configured' };
  }

  const locales = (languageHint && LOCALE_MAP[languageHint]) ? [LOCALE_MAP[languageHint]] : ALL_LOCALES;
  const url = `https://${AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;

  const form = new FormData();
  form.append('audio', audioBuffer, { filename: 'voice-note', contentType: mimeType || 'audio/ogg' });
  form.append('definition', JSON.stringify({ locales, profanityFilterMode: 'None' }));

  try {
    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const transcript =
      response.data?.combinedPhrases?.map((p) => p.text).join(' ').trim() ||
      response.data?.phrases?.map((p) => p.text).join(' ').trim() ||
      null;

    const detectedLocale = response.data?.phrases?.[0]?.locale || null;

    return { transcript, detectedLocale, raw: response.data };
  } catch (error) {
    console.error('Azure transcription failed:', error.response?.data || error.message);
    return { transcript: null, error: error.response?.data?.error?.message || error.message };
  }
}

module.exports = { transcribeAudio };
