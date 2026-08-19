const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `
You are a specialized medical OCR extraction assistant for prescription digitization.
Your job is to read the provided image of a prescription and output strictly structured JSON.

CRITICAL SAFETY RULES:
1. Extract ONLY information that is literally visible in the image.
2. NEVER fill in a "typical", "standard", or "suggested" dosage or timing if the text is unclear or omitted. Return null for that field.
3. NEVER add drug-interaction warnings, side effects, alternative brand names, or medical advice not printed on the prescription slip.
4. If handwriting or text is illegible, mark the specific field confidence as "low" and set value to null.
5. Provide a per-field confidence rating ("high", "medium", "low") and an overall confidence rating.

Output MUST follow this exact JSON schema:
{
  "diagnosis": "string or null",
  "follow_up_date": "YYYY-MM-DD or null",
  "medicines": [
    {
      "name": "string",
      "dosage": "string or null",
      "frequency": "string or null",
      "timing": "string or null (e.g. before food, after food)",
      "duration": "string or null",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "overall_confidence": "high" | "medium" | "low",
  "illegible_notes_flag": boolean
}
`;

/**
 * Processes a prescription image buffer/URL via Claude Vision
 * @param {string} imageBase64 - Base64 encoded image string
 * @param {string} mediaType - MIME type (e.g. 'image/jpeg', 'image/png')
 */
async function processPrescriptionOCR(imageBase64, mediaType = 'image/jpeg') {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: 'Extract the prescription details from this image according to the system instructions.',
          },
        ],
      },
    ],
  });

  const responseText = response.content[0].text;

  try {
    const structuredData = JSON.parse(responseText);

    // Safety check: force manual verification if overall confidence isn't high or illegible notes exist
    const requiresVerification =
      structuredData.overall_confidence !== 'high' ||
      structuredData.illegible_notes_flag === true;

    return {
      rawText: responseText,
      structuredData,
      ocrConfidence: structuredData.overall_confidence,
      requiresVerification
    };
  } catch (err) {
    // Fail-safe: parsing error defaults to low confidence requiring human review
    return {
      rawText: responseText,
      structuredData: null,
      ocrConfidence: 'low',
      requiresVerification: true
    };
  }
}

module.exports = { processPrescriptionOCR };
