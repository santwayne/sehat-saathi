const axios = require('axios');
const { pool } = require('../db');
const { encrypt, decrypt } = require('./crypto.service');
const { recordPlatformEvent } = require('./platform-events.service');

/**
 * Regulars connector (third-party integration, configured by Super Admin only).
 *
 * Regulars is Wayne E Solutions' WhatsApp retention platform. On its own it
 * only counts a visit when a customer happens to type "booking"/"appointment"
 * on WhatsApp. Sehat Saathi knows when a real clinic visit happened, so it
 * reports these to the hospital's Regulars business:
 *
 *   - CUSTOMER  when a consenting patient enrolls      (external id patient:<id>)
 *   - VISIT     when staff verify a patient's document  (external id doc:<id>)
 *   - OPT_OUT   when the kill switch is turned on or the patient is deleted
 *
 * Only phone, first name and dates are sent: never diagnoses, medicines or
 * documents. Patients without consent, or with the kill switch on, are never
 * sent as CUSTOMER/VISIT.
 *
 * Events go through regulars_outbox and are pushed asynchronously with
 * retries, so a Regulars outage never slows or breaks patient care.
 */

const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 10;
const TIMEOUT_MS = 15_000;

const baseUrl = () => (process.env.REGULARS_BASE_URL || '').replace(/\/$/, '');

/** Regulars matches customers by WhatsApp wa_id, which always has a country code. */
function toInternationalPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // Same rule as staff login: a bare 10-digit number is an Indian mobile.
  if (digits.length === 10) return `91${digits}`;
  return /^\d{11,15}$/.test(digits) ? digits : null;
}

/** First name only — enough for a call script greeting. */
function firstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0];
  return n ? n.slice(0, 100) : null;
}

async function clinicConfig(clinicId) {
  const { rows } = await pool.query('SELECT * FROM clinic_regulars WHERE clinic_id = $1', [clinicId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Enqueue (called from patient flows). Never throws.
// ---------------------------------------------------------------------------

async function enqueue({ clinicId, patientId, eventType, externalId, phone, name, occurredAt }) {
  const intl = toInternationalPhone(phone);
  if (!intl) return false;
  const { rowCount } = await pool.query(
    `INSERT INTO regulars_outbox (clinic_id, patient_id, event_type, external_id, phone, name, occurred_at)
     SELECT $1, $2, $3, $4, $5, $6, COALESCE($7, NOW())
     WHERE EXISTS (SELECT 1 FROM clinic_regulars WHERE clinic_id = $1 AND enabled = true)
     ON CONFLICT (clinic_id, external_id) DO NOTHING`,
    [clinicId, patientId || null, eventType, externalId, intl, eventType === 'OPT_OUT' ? null : firstName(name), occurredAt || null]
  );
  return rowCount > 0;
}

function kick(clinicId) {
  // Fire-and-forget, slightly delayed so the caller's own follow-up writes
  // (e.g. the patient DELETE right after an opt-out, which briefly locks the
  // outbox row via ON DELETE SET NULL) can't make the claim query skip it.
  // The periodic flush retries anything this misses.
  setTimeout(() => flushOutbox({ clinicId }).catch((err) => console.error('Regulars flush failed:', err.message)), 1000).unref?.();
}

/** A consenting patient just enrolled (staff-added or QR self-enrollment). */
async function onPatientEnrolled(patient) {
  try {
    if (!patient?.consent_given || patient.kill_switch_active || patient.followup_opt_out) return;
    const queued = await enqueue({
      clinicId: patient.clinic_id,
      patientId: patient.id,
      eventType: 'CUSTOMER',
      externalId: `patient:${patient.id}`,
      phone: patient.phone,
      name: patient.name,
      occurredAt: patient.created_at,
    });
    if (queued) kick(patient.clinic_id);
  } catch (err) {
    console.error('Regulars enqueue (enrolled) failed:', err.message);
  }
}

/** Staff verified a patient's document: the patient really visited the hospital. */
async function onDocumentVerified(prescriptionId) {
  try {
    const { rows } = await pool.query(
      `SELECT pr.id, pr.created_at, p.id AS patient_id, p.clinic_id, p.phone, p.name, p.consent_given, p.kill_switch_active, p.followup_opt_out
       FROM prescriptions pr JOIN patients p ON p.id = pr.patient_id WHERE pr.id = $1`,
      [prescriptionId]
    );
    const r = rows[0];
    if (!r || !r.consent_given || r.kill_switch_active || r.followup_opt_out) return;
    const queued = await enqueue({
      clinicId: r.clinic_id,
      patientId: r.patient_id,
      eventType: 'VISIT',
      externalId: `doc:${r.id}`,
      phone: r.phone,
      name: r.name,
      occurredAt: r.created_at,
    });
    if (queued) kick(r.clinic_id);
  } catch (err) {
    console.error('Regulars enqueue (visit) failed:', err.message);
  }
}

/** Kill switch on, patient replied STOP, or patient deleted: Regulars must never target them again. */
async function onPatientOptOut(patient) {
  try {
    if (!patient?.clinic_id) return;
    const queued = await enqueue({
      clinicId: patient.clinic_id,
      patientId: patient.id,
      eventType: 'OPT_OUT',
      externalId: `optout:${patient.id}`,
      phone: patient.phone,
    });
    // Anything not yet delivered for this patient must not go out after the opt-out.
    await pool.query(
      `UPDATE regulars_outbox SET status = 'failed', last_error = 'Cancelled: patient opted out', phone = NULL, name = NULL
       WHERE patient_id = $1 AND event_type <> 'OPT_OUT' AND status = 'pending'`,
      [patient.id]
    );
    if (queued) kick(patient.clinic_id);
  } catch (err) {
    console.error('Regulars enqueue (opt-out) failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

function backoffMs(attempts) {
  return Math.min(60_000 * 2 ** attempts, 6 * 60 * 60_000); // 2 min … 6 h
}

function httpError(err) {
  const status = err.response?.status;
  const msg = err.response?.data?.error || err.message;
  return { status, message: status ? `HTTP ${status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : msg };
}

async function flushClinic(cfg) {
  const base = baseUrl();
  if (!base) return { clinicId: cfg.clinic_id, skipped: 'REGULARS_BASE_URL not set' };
  if (!cfg.api_key_encrypted) return { clinicId: cfg.clinic_id, skipped: 'No API key' };

  // Release rows a crashed flush left claimed.
  await pool.query(
    `UPDATE regulars_outbox SET status = 'pending', claimed_at = NULL
     WHERE clinic_id = $1 AND status = 'sending' AND claimed_at < NOW() - INTERVAL '5 minutes'`,
    [cfg.clinic_id]
  );
  const { rows: batch } = await pool.query(
    `UPDATE regulars_outbox SET status = 'sending', claimed_at = NOW()
     WHERE id IN (
       SELECT id FROM regulars_outbox
       WHERE clinic_id = $1 AND status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY created_at LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [cfg.clinic_id]
  );
  if (batch.length === 0) return { clinicId: cfg.clinic_id, sent: 0, failed: 0, retrying: 0 };
  batch.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const events = batch.map((e) => ({
    type: e.event_type,
    phone: e.phone,
    ...(e.name ? { name: e.name } : {}),
    occurredAt: new Date(e.occurred_at).toISOString(),
    externalId: e.external_id,
    ...(cfg.location_id ? { locationId: cfg.location_id } : {}),
  }));

  let response;
  try {
    response = await axios.post(`${base}/api/v1/events`, { events }, {
      headers: { Authorization: `Bearer ${decrypt(cfg.api_key_encrypted)}`, 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
    });
  } catch (err) {
    const { status, message } = httpError(err);
    const ids = batch.map((e) => e.id);
    // Bad key / suspended business: nothing in this batch can succeed until fixed.
    await pool.query(
      `UPDATE regulars_outbox SET
         status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
         attempts = attempts + 1,
         next_attempt_at = NOW() + ($3 || ' milliseconds')::INTERVAL,
         claimed_at = NULL, last_error = $4
       WHERE id = ANY($1)`,
      [ids, MAX_ATTEMPTS, String(backoffMs(batch[0].attempts)), message]
    );
    await pool.query('UPDATE clinic_regulars SET last_error = $2, updated_at = NOW() WHERE clinic_id = $1', [cfg.clinic_id, message]);
    await recordPlatformEvent({
      source: 'integration',
      severity: status === 401 || status === 403 ? 'error' : 'warning',
      clinicId: cfg.clinic_id,
      message: `Regulars sync failed: ${message}`,
      details: { events: batch.length },
    });
    return { clinicId: cfg.clinic_id, sent: 0, failed: 0, retrying: batch.length, error: message };
  }

  const results = response.data?.results || [];
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < batch.length; i++) {
    const r = results.find((x) => x.index === i);
    if (r && ['created', 'updated', 'duplicate'].includes(r.status)) {
      await pool.query(
        `UPDATE regulars_outbox SET status = 'sent', sent_at = NOW(), regulars_status = $2, claimed_at = NULL,
           last_error = NULL, phone = NULL, name = NULL
         WHERE id = $1`,
        [batch[i].id, r.status]
      );
      sent++;
    } else {
      // A rejected event is a data problem (e.g. bad phone) — retrying won't fix it.
      await pool.query(
        `UPDATE regulars_outbox SET status = 'failed', attempts = attempts + 1, claimed_at = NULL, last_error = $2 WHERE id = $1`,
        [batch[i].id, r?.error || 'No result returned for this event']
      );
      failed++;
    }
  }
  await pool.query(
    'UPDATE clinic_regulars SET last_synced_at = NOW(), last_error = $2, updated_at = NOW() WHERE clinic_id = $1',
    [cfg.clinic_id, failed ? `${failed} event(s) rejected by Regulars in the last sync` : null]
  );
  if (failed) {
    await recordPlatformEvent({
      source: 'integration',
      severity: 'warning',
      clinicId: cfg.clinic_id,
      message: `Regulars rejected ${failed} of ${batch.length} event(s)`,
      details: { sample_error: results.find((x) => x.status === 'rejected')?.error },
    });
  }
  return { clinicId: cfg.clinic_id, sent, failed, retrying: 0 };
}

/** Pushes due events for one clinic, or every enabled clinic. */
async function flushOutbox({ clinicId } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM clinic_regulars WHERE enabled = true ${clinicId ? 'AND clinic_id = $1' : ''}`,
    clinicId ? [clinicId] : []
  );
  const out = [];
  for (const cfg of rows) {
    // Keep going until this clinic's due backlog is drained (bounded per run).
    for (let round = 0; round < 10; round++) {
      const r = await flushClinic(cfg);
      out.push(r);
      if (r.skipped || r.error || !r.sent && !r.failed) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Super Admin operations
// ---------------------------------------------------------------------------

async function saveConfig(clinicId, { enabled, apiKey, locationId }) {
  await pool.query(
    `INSERT INTO clinic_regulars (clinic_id) VALUES ($1) ON CONFLICT (clinic_id) DO NOTHING`,
    [clinicId]
  );
  const sets = ['updated_at = NOW()'];
  const params = [clinicId];
  if (enabled !== undefined) { params.push(!!enabled); sets.push(`enabled = $${params.length}`); }
  if (apiKey !== undefined) {
    const key = String(apiKey || '').trim();
    params.push(key ? encrypt(key) : null); sets.push(`api_key_encrypted = $${params.length}`);
    params.push(key ? `${key.slice(0, 14)}…` : null); sets.push(`api_key_hint = $${params.length}`);
    // A new key invalidates the last test result.
    sets.push('last_test_ok = NULL', 'business_name = NULL');
  }
  if (locationId !== undefined) { params.push(locationId || null); sets.push(`location_id = $${params.length}`); }
  await pool.query(`UPDATE clinic_regulars SET ${sets.join(', ')} WHERE clinic_id = $1`, params);
  return clinicConfig(clinicId);
}

async function testConnection(clinicId) {
  const cfg = await clinicConfig(clinicId);
  const base = baseUrl();
  if (!base) return { ok: false, message: 'Set the Regulars base URL first (Integrations → Regulars → Edit keys).' };
  if (!cfg?.api_key_encrypted) return { ok: false, message: 'No Regulars API key saved for this hospital.' };
  try {
    const { data } = await axios.get(`${base}/api/v1/ping`, {
      headers: { Authorization: `Bearer ${decrypt(cfg.api_key_encrypted)}` },
      timeout: TIMEOUT_MS,
    });
    if (cfg.location_id && !(data.locations || []).some((l) => l.id === cfg.location_id)) {
      await pool.query(
        'UPDATE clinic_regulars SET last_tested_at = NOW(), last_test_ok = false, business_name = $2, last_error = $3 WHERE clinic_id = $1',
        [clinicId, data.business?.name || null, 'Saved location id is not one of this business’s locations']
      );
      return { ok: false, message: 'Key works, but the saved location id does not belong to this business.', business: data.business, locations: data.locations };
    }
    await pool.query(
      'UPDATE clinic_regulars SET last_tested_at = NOW(), last_test_ok = true, business_name = $2, last_error = NULL WHERE clinic_id = $1',
      [clinicId, data.business?.name || null]
    );
    return { ok: true, message: `Connected to Regulars business “${data.business?.name}”${data.business?.status === 'SUSPENDED' ? ' (suspended in Regulars!)' : ''}.`, business: data.business, locations: data.locations };
  } catch (err) {
    const { message } = httpError(err);
    await pool.query(
      'UPDATE clinic_regulars SET last_tested_at = NOW(), last_test_ok = false, last_error = $2 WHERE clinic_id = $1',
      [clinicId, message]
    );
    await recordPlatformEvent({ source: 'integration', clinicId, message: `Regulars connection test failed: ${message}` });
    return { ok: false, message };
  }
}

/**
 * Queues every existing consenting patient (CUSTOMER) and every verified
 * document (VISIT) for this hospital. Safe to repeat: already-queued events
 * are skipped by the outbox's unique key and by Regulars' externalId check.
 */
async function backfill(clinicId) {
  const cfg = await clinicConfig(clinicId);
  if (!cfg?.enabled) throw Object.assign(new Error('Turn the Regulars connection on for this hospital first.'), { status: 400 });

  const customers = await pool.query(
    `SELECT id, phone, name, created_at FROM patients
     WHERE clinic_id = $1 AND consent_given = true AND kill_switch_active = false AND followup_opt_out = false`,
    [clinicId]
  );
  const visits = await pool.query(
    `SELECT pr.id, pr.created_at, p.id AS patient_id, p.phone, p.name FROM prescriptions pr
     JOIN patients p ON p.id = pr.patient_id
     WHERE p.clinic_id = $1 AND pr.verified_by_staff = true AND p.consent_given = true AND p.kill_switch_active = false
       AND p.followup_opt_out = false`,
    [clinicId]
  );
  let queued = 0;
  for (const p of customers.rows) {
    if (await enqueue({ clinicId, patientId: p.id, eventType: 'CUSTOMER', externalId: `patient:${p.id}`, phone: p.phone, name: p.name, occurredAt: p.created_at })) queued++;
  }
  for (const v of visits.rows) {
    if (await enqueue({ clinicId, patientId: v.patient_id, eventType: 'VISIT', externalId: `doc:${v.id}`, phone: v.phone, name: v.name, occurredAt: v.created_at })) queued++;
  }
  return { patients: customers.rows.length, visits: visits.rows.length, queued };
}

async function retryFailed(clinicId) {
  const { rowCount } = await pool.query(
    `UPDATE regulars_outbox SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL
     WHERE clinic_id = $1 AND status = 'failed' AND phone IS NOT NULL`,
    [clinicId]
  );
  return { requeued: rowCount };
}

async function listStatus() {
  const { rows } = await pool.query(
    `SELECT c.id AS clinic_id, c.name AS clinic_name, c.status AS clinic_status,
            r.enabled, (r.api_key_encrypted IS NOT NULL) AS has_key, r.api_key_hint, r.location_id,
            r.business_name, r.last_tested_at, r.last_test_ok, r.last_synced_at, r.last_error,
            COALESCE(o.pending, 0)::int AS pending, COALESCE(o.failed, 0)::int AS failed, COALESCE(o.sent_30d, 0)::int AS sent_30d
     FROM clinics c
     LEFT JOIN clinic_regulars r ON r.clinic_id = c.id
     LEFT JOIN (
       SELECT clinic_id,
              COUNT(*) FILTER (WHERE status IN ('pending', 'sending')) AS pending,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed,
              COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '30 days') AS sent_30d
       FROM regulars_outbox GROUP BY clinic_id
     ) o ON o.clinic_id = c.id
     ORDER BY c.name`
  );
  return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
}

async function recentFailures(clinicId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, event_type, external_id, attempts, last_error, created_at
     FROM regulars_outbox WHERE clinic_id = $1 AND status = 'failed'
     ORDER BY created_at DESC LIMIT $2`,
    [clinicId, limit]
  );
  return rows;
}

module.exports = {
  onPatientEnrolled,
  onDocumentVerified,
  onPatientOptOut,
  flushOutbox,
  saveConfig,
  testConnection,
  backfill,
  retryFailed,
  listStatus,
  recentFailures,
  toInternationalPhone,
};
