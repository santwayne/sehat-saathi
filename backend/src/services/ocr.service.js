const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Generalized beyond prescriptions (QR self-enrollment spec, Section 5.2/5.3)
// — a patient self-enrolling might send a lab report instead of a
// prescription, and either document type may carry the doctor's name needed
// to auto-assign them. document_type/doctor_name are read for every
// document; the medicine/test-result fields stay type-specific.
const SYSTEM_PROMPT = `
You are a specialized medical OCR extraction assistant for clinical document digitization.
Your job is to read the provided image of a clinical document (a prescription or a lab/diagnostic report) and output strictly structured JSON.

CRITICAL SAFETY RULES:
1. Extract ONLY information that is literally visible in the image.
2. NEVER fill in a "typical", "standard", or "suggested" dosage, timing, or test reference range if the text is unclear or omitted. Return null for that field.
3. NEVER add drug-interaction warnings, side effects, alternative brand names, or medical advice not printed on the document.
4. If handwriting or text is illegible, mark the specific field confidence as "low" and set value to null.
5. Provide a per-field confidence rating ("high", "medium", "low") and an overall confidence rating.
6. doctor_name: read ONLY from a letterhead, stamp, or signature block that names a doctor. Do NOT infer or guess a name from handwriting style. If no doctor name is clearly legible, set it to null with "low" confidence rather than guessing.

Output MUST follow this exact JSON schema:
{
  "document_type": "prescription" | "lab_report" | "other",
  "doctor_name": "string or null",
  "doctor_name_confidence": "high" | "medium" | "low",
  "diagnosis": "string or null (prescription only)",
  "follow_up_date": "YYYY-MM-DD or null (prescription only)",
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
  "lab_tests": [
    {
      "test_name": "string",
      "value": "string or null",
      "unit": "string or null",
      "reference_range": "string or null",
      "flag": "high" | "low" | "normal" | null,
      "confidence": "high" | "medium" | "low"
    }
  ],
  "overall_confidence": "high" | "medium" | "low",
  "illegible_notes_flag": boolean
}

"medicines" only applies when document_type is "prescription" (return an empty array otherwise). "lab_tests" only applies when document_type is "lab_report" (return an empty array otherwise).
`;

/**
 * Processes a clinical document image via Claude Vision. Handles both
 * prescriptions and lab reports (document_type in the response says which).
 * @param {string} imageBase64 - Base64 encoded image string
 * @param {string} mediaType - MIME type (e.g. 'image/jpeg', 'image/png')
 */
async function processPrescriptionOCR(imageBase64, mediaType = 'image/jpeg') {
  // The whole call — not just the JSON.parse below — is wrapped in the
  // fail-safe. An API-level failure (model retirement, rate limit, network
  // error) must never lose the document — every path through this function
  // returns a safe result the caller can always insert as a prescriptions row.
  let response;
  try {
    response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1800,
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
              text: 'Extract the clinical document details from this image according to the system instructions.',
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('OCR API call failed:', err.message);
    return {
      rawText: `[OCR request failed: ${err.message}]`,
      structuredData: null,
      ocrConfidence: 'low',
      documentType: 'other',
      doctorName: null,
      doctorNameConfidence: 'low',
      requiresVerification: true,
    };
  }

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
      documentType: ['prescription', 'lab_report', 'other'].includes(structuredData.document_type)
        ? structuredData.document_type
        : 'other',
      doctorName: structuredData.doctor_name || null,
      doctorNameConfidence: structuredData.doctor_name_confidence || 'low',
      requiresVerification,
    };
  } catch (err) {
    // Fail-safe: parsing error defaults to low confidence requiring human review
    return {
      rawText: responseText,
      structuredData: null,
      ocrConfidence: 'low',
      documentType: 'other',
      doctorName: null,
      doctorNameConfidence: 'low',
      requiresVerification: true,
    };
  }
}

module.exports = { processPrescriptionOCR };
