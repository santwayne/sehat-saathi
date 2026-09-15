const { pool } = require('../db');

// Shared fuzzy-matching engine for QR self-enrollment (spec Section 6.4).
// Both OCR-extracted doctor names and voice-transcript mentions funnel
// through here so there's one confidence rule, not two.

const HIGH_CONFIDENCE_THRESHOLD = 0.6;
// If the top two candidates score within this gap of each other, treat the
// match as ambiguous rather than confidently picking the higher one.
const AMBIGUOUS_GAP = 0.08;
const NO_MATCH_THRESHOLD = 0.3;

const HONORIFIC_PATTERN = /\b(dr\.?|doctor|sahab|sahib|saab|ji)\b/gi;

function normalizeForMatch(input) {
  return String(input || '')
    .toLowerCase()
    .replace(HONORIFIC_PATTERN, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Dice coefficient over character bigrams — no external dependency needed,
// works reasonably well for short name-like strings across transliteration
// noise (e.g. OCR/transcript variants of the same name).
function bigramSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const bigrams = (s) => {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };

  const bigA = bigrams(a);
  const bigB = bigrams(b);
  if (bigA.length === 0 || bigB.length === 0) return 0;

  const pool2 = [...bigB];
  let matches = 0;
  for (const bg of bigA) {
    const idx = pool2.indexOf(bg);
    if (idx !== -1) {
      matches += 1;
      pool2.splice(idx, 1);
    }
  }
  return (2 * matches) / (bigA.length + bigB.length);
}

/**
 * Matches a free-text name/phrase against a clinic's doctors.
 * Checks the learned doctor_aliases table first (Section 8.2), then falls
 * back to fuzzy string matching against doctors.name.
 *
 * @returns {{ status: 'high_confidence'|'low_confidence'|'no_match', candidate: {id, name}|null, score: number, viaAlias?: boolean }}
 */
async function matchDoctor({ clinicId, rawInput }) {
  const normalizedInput = normalizeForMatch(rawInput);
  if (!clinicId || !normalizedInput) {
    return { status: 'no_match', candidate: null, score: 0 };
  }

  const aliasRes = await pool.query(
    `SELECT da.doctor_id, da.alias, d.name
     FROM doctor_aliases da
     JOIN doctors d ON da.doctor_id = d.id
     WHERE d.clinic_id = $1`,
    [clinicId]
  );
  const aliasHit = aliasRes.rows.find((row) => normalizeForMatch(row.alias) === normalizedInput);
  if (aliasHit) {
    return {
      status: 'high_confidence',
      candidate: { id: aliasHit.doctor_id, name: aliasHit.name },
      score: 1,
      viaAlias: true,
    };
  }

  const docRes = await pool.query('SELECT id, name FROM doctors WHERE clinic_id = $1', [clinicId]);
  if (docRes.rows.length === 0) {
    return { status: 'no_match', candidate: null, score: 0 };
  }

  const scored = docRes.rows
    .map((d) => ({ id: d.id, name: d.name, score: bigramSimilarity(normalizedInput, normalizeForMatch(d.name)) }))
    .sort((a, b) => b.score - a.score);

  const [best, second] = scored;

  if (best.score >= HIGH_CONFIDENCE_THRESHOLD && (!second || best.score - second.score >= AMBIGUOUS_GAP)) {
    return { status: 'high_confidence', candidate: { id: best.id, name: best.name }, score: best.score };
  }

  if (best.score >= NO_MATCH_THRESHOLD) {
    return { status: 'low_confidence', candidate: { id: best.id, name: best.name }, score: best.score };
  }

  return { status: 'no_match', candidate: null, score: best.score };
}

/**
 * Logs every match attempt (Section 8.1) so corrections can later be traced
 * back to what the system originally guessed.
 */
async function logMatchAttempt({ clinicId, patientId, contextPhone, source, rawInput, matchedDoctorId, matchConfidence }) {
  const { rows } = await pool.query(
    `INSERT INTO doctor_match_log (clinic_id, patient_id, context_phone, source, raw_input, matched_doctor_id, match_confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [clinicId, patientId || null, contextPhone || null, source, rawInput, matchedDoctorId || null, matchConfidence || null]
  );
  return rows[0].id;
}

/**
 * Records the outcome of a low-confidence match once resolved — either a
 * patient's "Yes" confirmation or a staff correction on an escalation flag —
 * and writes the alias into doctor_aliases so the same phrase is a known
 * alias next time (Section 8.2).
 */
async function recordResolution({ matchLogId, resolvedDoctorId, rawInput, learnedFrom }) {
  if (matchLogId) {
    await pool.query('UPDATE doctor_match_log SET staff_corrected_to = $1 WHERE id = $2', [resolvedDoctorId, matchLogId]);
  }
  if (resolvedDoctorId && rawInput && rawInput.trim()) {
    await pool.query(
      `INSERT INTO doctor_aliases (doctor_id, alias, learned_from)
       VALUES ($1, $2, $3)
       ON CONFLICT (doctor_id, alias) DO NOTHING`,
      [resolvedDoctorId, rawInput.trim(), learnedFrom]
    );
  }
}

module.exports = { matchDoctor, logMatchAttempt, recordResolution, normalizeForMatch };
