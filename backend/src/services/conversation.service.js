const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { validateLLMOutput, isUrgentKeywordPresent } = require('./safety.service');
const { createEscalationFlag } = require('./escalation.service');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CONVERSATION_SYSTEM_PROMPT = `
You are Sehat Saathi, an AI patient companion working with the patient's clinic.
Your job is to answer questions strictly about the provided prescription record in the patient's preferred language.

STRICT SAFETY CONSTRAINTS:
1. You may ONLY reference details present in the provided prescription JSON.
2. NEVER suggest starting, stopping, increasing, or decreasing a medication or dose.
3. NEVER comment on drug interactions, offer diagnoses, or interpret whether a symptom is "normal" or "serious".
4. If a question cannot be directly answered using only the literal prescription text, set "can_answer": false.
5. On the first contact or intro, clearly identify yourself as an AI assistant associated with their clinic.

OUTPUT SCHEMA (JSON):
{
  "can_answer": boolean,
  "reply_text": "string (localized answer or polite fallback referring to clinic)",
  "intent": "checkin_response" | "question" | "symptom_report" | "other",
  "detected_missed_dose": boolean
}
`;

/**
 * Logs a conversation turn to the audit trail (Section 6.3 requirement).
 */
async function logConversation(patientId, direction, text, intentType) {
  const { rows } = await pool.query(
    `INSERT INTO conversations (patient_id, channel, direction, message_text, intent_type)
     VALUES ($1, 'whatsapp', $2, $3, $4) RETURNING id`,
    [patientId, direction, text, intentType || null]
  );
  return rows[0].id;
}

/**
 * Handles inbound patient text messages.
 * @param {string} patientId - UUID of the patient (NOT their phone number)
 * @param {string} messageText
 */
async function processInboundMessage(patientId, messageText) {
  // 1. Fetch patient details and active prescription
  const patientQuery = `
    SELECT
      p.id, p.phone, p.language_pref, p.kill_switch_active, p.assigned_doctor_id,
      pr.structured_json
    FROM patients p
    LEFT JOIN prescriptions pr ON pr.patient_id = p.id AND pr.verified_by_staff = true
    WHERE p.id = $1
    ORDER BY pr.created_at DESC LIMIT 1;
  `;
  const { rows } = await pool.query(patientQuery, [patientId]);
  const patient = rows[0];

  if (!patient || patient.kill_switch_active) {
    console.log(`Message ignored for patient ${patientId}: Kill switch active or patient not found.`);
    return null;
  }

  // 2. Check for explicit urgent symptom keywords first (code-level check)
  if (isUrgentKeywordPresent(messageText)) {
    const conversationId = await logConversation(patient.id, 'inbound', messageText, 'symptom_report');

    const flagId = await createEscalationFlag({
      patientId: patient.id,
      conversationId,
      flagType: 'symptom_reported',
      priority: 'urgent',
      assignedDoctorId: patient.assigned_doctor_id,
      reason: `Urgent keyword detected in message: "${messageText}"`
    });

    const replyText = patient.language_pref === 'pa'
      ? 'ਤੁਹਾਡਾ ਸੁਨੇਹਾ ਕਲਿਨਿਕ ਦੀ ਟੀਮ ਨੂੰ ਭੇਜ ਦਿੱਤਾ ਗਿਆ ਹੈ। ਜੇਕਰ ਇਹ ਇਮਰਜੈਂਸੀ ਹੈ, ਤਾਂ ਕਿਰਪਾ ਕਰਕੇ ਤੁਰੰਤ ਕਲਿਨਿਕ ਨਾਲ ਸੰਪਰਕ ਕਰੋ।'
      : patient.language_pref === 'hi'
      ? 'आपका संदेश क्लिनिक टीम को भेज दिया गया है। यदि यह आपातकालीन स्थिति है, तो कृपया तुरंत क्लिनिक से संपर्क करें।'
      : 'Your message has been escalated to the clinic team. If this is an emergency, please contact the clinic immediately.';

    await logConversation(patient.id, 'outbound', replyText, 'symptom_report');

    return { replyText, flagged: true, flagId };
  }

  const inboundConversationId = await logConversation(patient.id, 'inbound', messageText, 'other');

  // 3. Call Claude with patient's prescription scope
  const promptContent = `
Patient Language Preference: ${patient.language_pref}
Verified Prescription Context: ${JSON.stringify(patient.structured_json || {})}
Patient Message: "${messageText}"
  `;

  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 800,
    system: CONVERSATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: promptContent }]
  });

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(response.content[0].text);
  } catch (err) {
    // Parsing fallback: mark unanswerable
    parsedResponse = {
      can_answer: false,
      reply_text: 'I have logged your request and forwarded it to your clinic coordinator.',
      intent: 'question'
    };
  }

  // 4. Validate output against safety rules (banned phrase check)
  const safetyCheck = validateLLMOutput(parsedResponse.reply_text);
  if (!safetyCheck.safe || !parsedResponse.can_answer) {
    // Route unanswerable or blocked responses to clinic escalation queue
    const flagType = parsedResponse.intent === 'symptom_report' ? 'symptom_reported' : 'unanswerable_question';

    await createEscalationFlag({
      patientId: patient.id,
      conversationId: inboundConversationId,
      flagType,
      priority: 'normal',
      assignedDoctorId: patient.assigned_doctor_id,
      reason: safetyCheck.reason || 'Query outside prescription scope'
    });

    const fallbackReply = patient.language_pref === 'pa'
      ? 'ਮੈਂ ਇਹ ਜਾਣਕਾਰੀ ਤੁਹਾਡੇ ਕਲਿਨਿਕ ਦੇ ਡਾਕਟਰ ਨਾਲ ਸਾਂਝੀ ਕਰ ਦਿੱਤੀ ਹੈ। ਉਹ ਜਲਦੀ ਹੀ ਤੁਹਾਡੇ ਨਾਲ ਸੰਪਰਕ ਕਰਨਗੇ।'
      : patient.language_pref === 'hi'
      ? 'मैंने यह प्रश्न आपके क्लिनिक डॉक्टर को भेज दिया है। वे जल्द ही आपसे संपर्क करेंगे।'
      : 'I have forwarded this question to your clinic doctor. They will respond to you shortly.';

    await logConversation(patient.id, 'outbound', fallbackReply, flagType);

    return { replyText: fallbackReply, flagged: true };
  }

  // 5. Check missed-dose reports to trigger escalation if repeated
  if (parsedResponse.detected_missed_dose) {
    // Check if a previous check-in response was also a missed dose
    const recentMissedDoses = await pool.query(
      `SELECT id FROM conversations
       WHERE patient_id = $1 AND intent_type = 'checkin_response'
       ORDER BY created_at DESC LIMIT 2`,
      [patient.id]
    );

    if (recentMissedDoses.rows.length >= 1) {
      await createEscalationFlag({
        patientId: patient.id,
        conversationId: inboundConversationId,
        flagType: 'missed_dose',
        priority: 'normal',
        assignedDoctorId: patient.assigned_doctor_id,
        reason: 'Multiple consecutive missed doses reported.'
      });
    }
  }

  await logConversation(patient.id, 'outbound', parsedResponse.reply_text, parsedResponse.intent);

  return { replyText: parsedResponse.reply_text, flagged: false };
}

module.exports = { processInboundMessage };
