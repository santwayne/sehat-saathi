const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { validateLLMOutput, isUrgentKeywordPresent } = require('./safety.service');
const { createEscalationFlag } = require('./escalation.service');
const { t, languageName } = require('./i18n');

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
async function logConversation(patientId, direction, text, intentType, senderType, channel = 'whatsapp') {
  const { rows } = await pool.query(
    `INSERT INTO conversations (patient_id, channel, direction, message_text, intent_type, sender_type)
     VALUES ($1, $6, $2, $3, $4, $5) RETURNING id`,
    [patientId, direction, text, intentType || null, senderType || null, channel]
  );
  return rows[0].id;
}

/**
 * Handles inbound patient text messages.
 * @param {string} patientId - UUID of the patient (NOT their phone number)
 * @param {string} messageText
 * @param {{senderType?: 'patient'|'family'}} [options] - 'family' for a message
 *   from an opted-in family member asking on the patient's behalf. Same
 *   prescription-scoped engine and safety rules, but never counted as a
 *   check-in response / missed-dose signal (only the patient's own replies are).
 */
async function processInboundMessage(patientId, messageText, { senderType = 'patient', channel = 'whatsapp' } = {}) {
  const isFamily = senderType === 'family';
  // 1. Fetch patient details and active prescription
  const patientQuery = `
    SELECT
      p.id, p.phone, p.language_pref, p.kill_switch_active, p.consent_given, p.assigned_doctor_id,
      pr.structured_json
    FROM patients p
    LEFT JOIN prescriptions pr ON pr.patient_id = p.id AND pr.verified_by_staff = true
    WHERE p.id = $1
    ORDER BY pr.created_at DESC LIMIT 1;
  `;
  const { rows } = await pool.query(patientQuery, [patientId]);
  const patient = rows[0];

  // Same defense-in-depth as whatsapp.routes.js's webhook handler (Bug 5) —
  // scheduler.service.js already gated its own outbound check-ins on
  // consent_given; this was the one remaining automated-reply path that
  // didn't.
  if (!patient || patient.kill_switch_active || !patient.consent_given) {
    console.log(`Message ignored for patient ${patientId}: kill switch active, consent missing, or patient not found.`);
    return null;
  }

  // 2. Check for explicit urgent symptom keywords first (code-level check)
  if (isUrgentKeywordPresent(messageText)) {
    const conversationId = await logConversation(patient.id, 'inbound', messageText, 'symptom_report', senderType, channel);

    const flagId = await createEscalationFlag({
      patientId: patient.id,
      conversationId,
      flagType: 'symptom_reported',
      priority: 'urgent',
      assignedDoctorId: patient.assigned_doctor_id,
      reason: `Urgent keyword detected in message: "${messageText}"`
    });

    const replyText = t('urgent', patient.language_pref);

    await logConversation(patient.id, 'outbound', replyText, 'symptom_report', senderType, channel);

    return { replyText, flagged: true, flagId };
  }

  const inboundConversationId = await logConversation(patient.id, 'inbound', messageText, 'other', senderType, channel);

  // 3. Call Claude with patient's prescription scope
  const promptContent = `
Patient Language Preference: ${languageName(patient.language_pref)}
Verified Prescription Context: ${JSON.stringify(patient.structured_json || {})}
Message Sender: ${isFamily ? "a family member of the patient, asking on the patient's behalf" : 'the patient'}
Message: "${messageText}"
  `;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
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

  // A family member's reply is never a check-in response.
  if (isFamily && parsedResponse.intent === 'checkin_response') {
    parsedResponse.intent = 'question';
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

    const fallbackReply = t('forwarded', patient.language_pref);

    await logConversation(patient.id, 'outbound', fallbackReply, flagType, senderType, channel);

    return { replyText: fallbackReply, flagged: true };
  }

  // 5. Check missed-dose reports to trigger escalation if repeated
  if (parsedResponse.detected_missed_dose && !isFamily) {
    // Check if a previous check-in response was also a missed dose
    const recentMissedDoses = await pool.query(
      `SELECT id FROM conversations
       WHERE patient_id = $1 AND intent_type = 'checkin_response'
         AND (sender_type IS NULL OR sender_type = 'patient')
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

  await logConversation(patient.id, 'outbound', parsedResponse.reply_text, parsedResponse.intent, senderType, channel);

  return { replyText: parsedResponse.reply_text, flagged: false };
}

module.exports = { processInboundMessage, logConversation };
