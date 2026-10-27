const { pool } = require('../db');
const {
  sendWhatsAppMessage,
  sendTemplateWithTextFallback,
} = require('./whatsapp.service');
const { processInboundMessage } = require('./conversation.service');
const { CHECKIN_PROMPT_TEXTS, CHECKIN_TEMPLATE_LOG_PATTERN, VOICE_CHECKIN_LOG_PREFIX } = require('./i18n');

// Family accounts (V2_FEATURE_HANDOVER.md, Section 2). A family member is
// invited by staff, must reply YES (explicit opt-in), and from then on gets
// the weekly digest and can ask prescription-bounded questions on the
// patient's behalf. They never count as the patient: their replies are never
// check-in responses, and they have no way to reach the kill switch.

const AFFIRMATIVE = /^(yes|y|yeah|yup|haan|ha+n?|han+ji|ji( haan)?|ok(ay)?|sure|theek( hai)?|thik( hai)?|हाँ|हां|ਹਾਂ)\b/i;
const STOP_ONLY = /^(stop|unsubscribe)\s*[.!]*$/i;
const NEGATIVE_OR_STOP = /^(no|nahi+n?|na|nope|nah|stop|unsubscribe|नहीं|ਨਹੀਂ)\b/i;

const T = {
  invite: {
    en: (fam, pat, clinic) => `Hello ${fam}, ${clinic} would like to add you to ${pat}'s care updates on WhatsApp (medicine explanations, a weekly summary, and flagged concerns). Reply YES to agree, or NO to decline.`,
    hi: (fam, pat, clinic) => `नमस्ते ${fam}, ${clinic} आपको ${pat} की देखभाल के अपडेट WhatsApp पर भेजना चाहता है (दवाइयों की जानकारी, साप्ताहिक सारांश और ज़रूरी चेतावनियाँ)। सहमत हों तो YES लिखें, न हों तो NO।`,
    pa: (fam, pat, clinic) => `ਸਤਿ ਸ਼੍ਰੀ ਅਕਾਲ ${fam}, ${clinic} ਤੁਹਾਨੂੰ ${pat} ਦੀ ਦੇਖਭਾਲ ਦੇ ਅਪਡੇਟ WhatsApp 'ਤੇ ਭੇਜਣਾ ਚਾਹੁੰਦਾ ਹੈ। ਸਹਿਮਤ ਹੋ ਤਾਂ YES ਲਿਖੋ, ਨਹੀਂ ਤਾਂ NO।`,
  },
  optedIn: {
    en: (pat) => `Thank you. You'll now receive updates about ${pat}'s care, and you can message here to ask about their prescription. Reply STOP any time to opt out.`,
    hi: (pat) => `धन्यवाद। अब आपको ${pat} की देखभाल के अपडेट मिलेंगे, और आप उनकी दवाइयों के बारे में यहाँ पूछ सकते हैं। कभी भी बंद करने के लिए STOP लिखें।`,
    pa: (pat) => `ਧੰਨਵਾਦ। ਹੁਣ ਤੁਹਾਨੂੰ ${pat} ਦੀ ਦੇਖਭਾਲ ਦੇ ਅਪਡੇਟ ਮਿਲਣਗੇ। ਬੰਦ ਕਰਨ ਲਈ ਕਦੇ ਵੀ STOP ਲਿਖੋ।`,
  },
  optedOut: {
    en: "Okay, you won't receive any more updates. Thank you.",
    hi: 'ठीक है, अब आपको कोई अपडेट नहीं मिलेगा। धन्यवाद।',
    pa: 'ਠੀਕ ਹੈ, ਹੁਣ ਤੁਹਾਨੂੰ ਕੋਈ ਅਪਡੇਟ ਨਹੀਂ ਮਿਲੇਗਾ। ਧੰਨਵਾਦ।',
  },
  reask: {
    en: (pat) => `Please reply YES to receive updates about ${pat}'s care, or NO to decline.`,
    hi: (pat) => `${pat} की देखभाल के अपडेट पाने के लिए YES लिखें, या मना करने के लिए NO।`,
    pa: (pat) => `${pat} ਦੀ ਦੇਖਭਾਲ ਦੇ ਅਪਡੇਟ ਲਈ YES ਲਿਖੋ, ਜਾਂ ਮਨ੍ਹਾ ਕਰਨ ਲਈ NO।`,
  },
  textOnly: {
    en: 'Please send your question as a text message.',
    hi: 'कृपया अपना सवाल टेक्स्ट संदेश में भेजें।',
    pa: 'ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਸਵਾਲ ਟੈਕਸਟ ਸੁਨੇਹੇ ਵਿੱਚ ਭੇਜੋ।',
  },
  digest: {
    en: (s) => `In the last 7 days: ${s.checkinsSent} check-in(s) sent, ${s.replies} reply(ies) from ${s.patient}, ${s.missed} missed-dose alert(s), ${s.concerns} concern(s) flagged to the clinic.`,
    hi: (s) => `पिछले 7 दिनों में: ${s.checkinsSent} चेक-इन भेजे गए, ${s.patient} के ${s.replies} जवाब आए, ${s.missed} खुराक छूटने की सूचना, क्लिनिक को ${s.concerns} चिंता की सूचना।`,
    pa: (s) => `ਪਿਛਲੇ 7 ਦਿਨਾਂ ਵਿੱਚ: ${s.checkinsSent} ਚੈੱਕ-ਇਨ ਭੇਜੇ, ${s.patient} ਦੇ ${s.replies} ਜਵਾਬ, ${s.missed} ਖੁਰਾਕ ਖੁੰਝਣ ਦੀ ਸੂਚਨਾ, ਕਲਿਨਿਕ ਨੂੰ ${s.concerns} ਚਿੰਤਾ ਦੀ ਸੂਚਨਾ।`,
  },
};

function pick(group, lang) {
  return group[lang] || group.en;
}

/**
 * Staff action: add a family member and send the opt-in request. The row is
 * created first so the invite is on record even if WhatsApp delivery fails.
 */
async function inviteFamilyMember({ patient, clinicName, name, phone, relationship }) {
  const { rows } = await pool.query(
    `INSERT INTO family_members (patient_id, name, phone, relationship)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [patient.id, name || null, phone, relationship || null]
  );
  const member = rows[0];

  const lang = patient.language_pref || 'hi';
  const fam = name || 'there';
  const text = pick(T.invite, lang)(fam, patient.name, clinicName);
  let delivered = true;
  try {
    await sendTemplateWithTextFallback(phone, 'family_invite', lang, [fam, patient.name, clinicName], text, patient.clinic_id);
  } catch (err) {
    delivered = false;
    console.error(`Family invite to ${phone} failed:`, err.message);
  }
  return { member, delivered };
}

/**
 * Called from the inbound webhook for senders who are not enrolled patients.
 * Returns true if the message was handled as a family message (so the caller
 * must not fall through to self-enrollment), false otherwise.
 */
async function handleFamilyMessage({ clinicId, senderPhone, messageType, message }) {
  const { rows: links } = await pool.query(
    `SELECT fm.id, fm.status, fm.patient_id, fm.opted_in_at, p.name AS patient_name, p.language_pref,
            p.kill_switch_active, p.consent_given
     FROM family_members fm
     JOIN patients p ON p.id = fm.patient_id
     WHERE fm.phone = $1 AND p.clinic_id = $2 AND fm.status IN ('invited', 'active')
     ORDER BY fm.opted_in_at DESC NULLS LAST, fm.invited_at DESC`,
    [senderPhone, clinicId]
  );
  if (links.length === 0) return false;

  const text = messageType === 'text' ? (message.text?.body || '').trim() : '';
  const lang = links[0].language_pref || 'hi';
  const reply = (body) => sendWhatsAppMessage(senderPhone, body, clinicId);

  const invited = links.filter((l) => l.status === 'invited');
  const hasActive = links.some((l) => l.status === 'active');

  // Opting out works for every patient this number is linked to. Once active,
  // only an exact STOP counts — "No, can she take it with food?" is a question.
  const wantsOut = hasActive ? STOP_ONLY.test(text) : NEGATIVE_OR_STOP.test(text);
  if (text && wantsOut) {
    await pool.query(
      `UPDATE family_members SET status = 'opted_out'
       WHERE phone = $1 AND status IN ('invited', 'active')
         AND patient_id IN (SELECT id FROM patients WHERE clinic_id = $2)`,
      [senderPhone, clinicId]
    );
    await reply(pick(T.optedOut, lang));
    return true;
  }

  if (invited.length > 0 && AFFIRMATIVE.test(text)) {
    await pool.query(
      `UPDATE family_members SET status = 'active', opted_in_at = NOW() WHERE id = ANY($1::uuid[])`,
      [invited.map((l) => l.id)]
    );
    await reply(pick(T.optedIn, lang)(invited[0].patient_name));
    return true;
  }

  const active = links.find((l) => l.status === 'active');
  if (!active) {
    await reply(pick(T.reask, lang)(invited[0].patient_name));
    return true;
  }

  if (messageType !== 'text' || !text) {
    await reply(pick(T.textOnly, active.language_pref || 'hi'));
    return true;
  }

  // Active family member: same prescription-scoped engine, tagged 'family'.
  // Returns null (no reply) if the patient's kill switch is on or consent is missing.
  const result = await processInboundMessage(active.patient_id, text, { senderType: 'family' });
  if (result?.replyText) await reply(result.replyText);
  return true;
}

/**
 * Weekly digest for every active family member. Only reports what the data
 * actually holds — check-ins sent, patient replies, missed-dose alerts and
 * flagged concerns — and never claims "doses taken" (not tracked yet).
 * last_digest_at makes it safe to call from both a daily cron and an
 * every-few-hours interval without double-sending.
 */
async function sendWeeklyDigests() {
  const { rows: members } = await pool.query(
    `SELECT fm.id, fm.name, fm.phone, p.id AS patient_id, p.name AS patient_name,
            p.language_pref, p.clinic_id
     FROM family_members fm
     JOIN patients p ON p.id = fm.patient_id
     WHERE fm.status = 'active'
       AND p.kill_switch_active = false AND p.consent_given = true
       AND COALESCE(fm.last_digest_at, fm.opted_in_at) <= NOW() - INTERVAL '6 days'`
  );

  let sent = 0;
  for (const m of members) {
    try {
      const [conv, flags] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE direction = 'outbound' AND (message_text = ANY($2::text[]) OR message_text LIKE $3 OR message_text LIKE $4)) AS checkins_sent,
             COUNT(*) FILTER (WHERE direction = 'inbound' AND (sender_type IS NULL OR sender_type = 'patient')) AS replies
           FROM conversations WHERE patient_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
          [m.patient_id, CHECKIN_PROMPT_TEXTS, CHECKIN_TEMPLATE_LOG_PATTERN, `${VOICE_CHECKIN_LOG_PREFIX}%`]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE flag_type = 'missed_dose') AS missed,
             COUNT(*) FILTER (WHERE flag_type <> 'missed_dose') AS concerns
           FROM flags WHERE patient_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
          [m.patient_id]
        ),
      ]);
      const stats = {
        patient: m.patient_name,
        checkinsSent: Number(conv.rows[0].checkins_sent),
        replies: Number(conv.rows[0].replies),
        missed: Number(flags.rows[0].missed),
        concerns: Number(flags.rows[0].concerns),
      };
      const lang = m.language_pref || 'hi';
      const summary = pick(T.digest, lang)(stats);
      const fam = m.name || 'there';
      await sendTemplateWithTextFallback(
        m.phone, 'family_weekly_digest', lang, [fam, m.patient_name, summary],
        `${m.patient_name} — ${summary}`, m.clinic_id
      );
      await pool.query('UPDATE family_members SET last_digest_at = NOW() WHERE id = $1', [m.id]);
      sent += 1;
    } catch (err) {
      console.error(`Family digest failed for member ${m.id}:`, err.message);
    }
  }
  return { scanned: members.length, sent };
}

module.exports = { inviteFamilyMember, handleFamilyMessage, sendWeeklyDigests };
