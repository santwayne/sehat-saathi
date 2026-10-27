const { pool } = require('../db');
const { sendTemplateWithTextFallback, sendCatalogMessage } = require('./whatsapp.service');

// Pharmacy refill reminders (V2_FEATURE_HANDOVER.md, Section 4 — reminder
// half). Works out when a prescription's medicines run out from the
// free-text `duration` the OCR read off the paper, and nudges the patient
// shortly before. Durations that don't parse cleanly are skipped rather than
// guessed at. WhatsApp catalog ordering needs a real partner pharmacy with a
// Meta Commerce catalog connected to the clinic's WABA. When a partner has a
// catalog id on file we additionally try an interactive catalog message
// (best effort — see sendCatalogMessage); ordering itself stays staff-managed.

const REMIND_DAYS_BEFORE = 3;
const GRACE_DAYS_AFTER = 2; // still remind if the course ended a day or two ago

const UNIT_DAYS = [
  [/^(day|days|din|dino|दिन|ਦਿਨ)$/i, 1],
  [/^(week|weeks|wk|wks|hafta|hafte|haftey|हफ्ता|हफ्ते|ਹਫ਼ਤੇ|ਹਫਤੇ)$/i, 7],
  [/^(month|months|mo|mahina|mahine|mahinay|महीना|महीने|ਮਹੀਨੇ|ਮਹੀਨਾ)$/i, 30],
];

/** "10 days" / "2 weeks" / "1 month" / "5 din" -> number of days, else null. */
function parseDurationDays(duration) {
  if (typeof duration !== 'string') return null;
  const m = duration.trim().match(/(\d+(?:\.\d+)?)\s*([A-Za-zऀ-ॿ਀-੿]+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0) || n > 365) return null;
  for (const [re, mult] of UNIT_DAYS) {
    if (re.test(m[2])) return Math.round(n * mult);
  }
  return null;
}

/**
 * Medicines on a prescription whose course ends inside the reminder window.
 * `startedAt` is the prescription's created_at (the best "start" we have).
 */
function medicinesRunningOut(structuredJson, startedAt, now = new Date()) {
  const meds = Array.isArray(structuredJson?.medicines) ? structuredJson.medicines : [];
  const dayMs = 24 * 60 * 60 * 1000;
  const due = [];
  for (const med of meds) {
    const days = parseDurationDays(med?.duration);
    if (!days || !med?.name) continue;
    const endsAt = new Date(new Date(startedAt).getTime() + days * dayMs);
    const daysLeft = (endsAt.getTime() - now.getTime()) / dayMs;
    if (daysLeft <= REMIND_DAYS_BEFORE && daysLeft >= -GRACE_DAYS_AFTER) {
      due.push({ name: String(med.name), endsAt });
    }
  }
  return due;
}

const T = {
  en: (name, meds, pharmacy) => `Hello ${name}, your medicines (${meds}) may be running out soon.${pharmacy} Please speak to your clinic before changing anything about your medicines.`,
  hi: (name, meds, pharmacy) => `नमस्ते ${name}, आपकी दवाइयाँ (${meds}) जल्द ख़त्म हो सकती हैं।${pharmacy} दवाइयों में कोई भी बदलाव करने से पहले कृपया अपने क्लिनिक से बात करें।`,
  pa: (name, meds, pharmacy) => `ਸਤਿ ਸ਼੍ਰੀ ਅਕਾਲ ${name}, ਤੁਹਾਡੀਆਂ ਦਵਾਈਆਂ (${meds}) ਜਲਦੀ ਖ਼ਤਮ ਹੋ ਸਕਦੀਆਂ ਹਨ।${pharmacy} ਦਵਾਈਆਂ ਵਿੱਚ ਕੋਈ ਵੀ ਬਦਲਾਅ ਕਰਨ ਤੋਂ ਪਹਿਲਾਂ ਕਿਰਪਾ ਕਰਕੇ ਆਪਣੇ ਕਲਿਨਿਕ ਨਾਲ ਗੱਲ ਕਰੋ।`,
};
const PHARMACY_LINE = {
  en: (p) => ` You can reorder from ${p.name}${p.link ? `: ${p.link}` : ''}.`,
  hi: (p) => ` आप ${p.name} से दोबारा मँगवा सकते हैं${p.link ? `: ${p.link}` : ''}।`,
  pa: (p) => ` ਤੁਸੀਂ ${p.name} ਤੋਂ ਦੁਬਾਰਾ ਮੰਗਵਾ ਸਕਦੇ ਹੋ${p.link ? `: ${p.link}` : ''}।`,
};

async function sendDueRefillReminders() {
  const { rows } = await pool.query(`
    SELECT pr.id AS prescription_id, pr.structured_json, pr.created_at AS prescribed_at,
           p.id AS patient_id, p.name AS patient_name, p.phone, p.language_pref, p.clinic_id
    FROM prescriptions pr
    JOIN patients p ON p.id = pr.patient_id
    WHERE pr.verified_by_staff = true
      AND pr.document_type = 'prescription'
      AND p.kill_switch_active = false AND p.consent_given = true
      AND NOT EXISTS (SELECT 1 FROM refill_orders ro WHERE ro.prescription_id = pr.id)
  `);

  let flagged = 0;
  let sent = 0;
  for (const row of rows) {
    const due = medicinesRunningOut(row.structured_json, row.prescribed_at);
    if (due.length === 0) continue;

    const earliest = due.reduce((a, b) => (a.endsAt < b.endsAt ? a : b)).endsAt;
    const medNames = due.map((d) => d.name).join(', ');

    const pharmRes = await pool.query(
      'SELECT id, name, whatsapp_business_phone, whatsapp_catalog_id FROM pharmacy_partners WHERE clinic_id = $1 ORDER BY created_at LIMIT 1',
      [row.clinic_id]
    );
    const pharmacy = pharmRes.rows[0] || null;

    // ON CONFLICT: two overlapping scanner runs can't double-insert (and so
    // can't double-message) the same prescription.
    const ins = await pool.query(
      `INSERT INTO refill_orders (prescription_id, patient_id, pharmacy_partner_id, due_date, medicine_names)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (prescription_id) DO NOTHING RETURNING id`,
      [row.prescription_id, row.patient_id, pharmacy?.id || null, earliest.toISOString().slice(0, 10), medNames]
    );
    if (ins.rows.length === 0) continue;
    flagged += 1;

    const lang = T[row.language_pref] ? row.language_pref : 'hi';
    const pharmacyLine = pharmacy
      ? PHARMACY_LINE[lang]({
          name: pharmacy.name,
          link: pharmacy.whatsapp_business_phone ? `https://wa.me/${pharmacy.whatsapp_business_phone.replace(/\D/g, '')}` : '',
        })
      : '';
    const text = T[lang](row.patient_name, medNames, pharmacyLine);

    try {
      await sendTemplateWithTextFallback(
        row.phone, 'refill_reminder', lang, [row.patient_name, medNames, pharmacyLine.trim() || '-'], text, row.clinic_id
      );
      // Pharmacy with a catalog on file: also offer the catalog button. Best
      // effort — it only delivers inside the patient's 24h window, and the
      // text reminder above has already gone out either way.
      if (pharmacy?.whatsapp_catalog_id) {
        const catalogBody = `${pharmacy.name}: ${medNames}`.slice(0, 1000);
        await sendCatalogMessage(row.phone, catalogBody, row.clinic_id).catch(() => undefined);
      }
      await pool.query(
        `UPDATE refill_orders SET reminded_at = NOW(), status = CASE WHEN pharmacy_partner_id IS NULL THEN status ELSE 'offered' END WHERE id = $1`,
        [ins.rows[0].id]
      );
      await pool.query(
        `INSERT INTO conversations (patient_id, channel, direction, message_text, intent_type)
         VALUES ($1, 'whatsapp', 'outbound', $2, 'other')`,
        [row.patient_id, text]
      );
      sent += 1;
    } catch (err) {
      // Row stays 'flagged' with no reminded_at, so staff can see it and follow up manually.
      console.error(`Refill reminder failed for prescription ${row.prescription_id}:`, err.message);
    }
  }
  return { scanned: rows.length, flagged, sent };
}

module.exports = { parseDurationDays, medicinesRunningOut, sendDueRefillReminders };
