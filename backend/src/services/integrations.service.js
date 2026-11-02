const axios = require('axios');
const { pool } = require('../db');
const { encrypt, decrypt, mask } = require('./crypto.service');
const { recordPlatformEvent } = require('./platform-events.service');

/**
 * Platform-wide third-party keys, editable from Super Admin → Integrations.
 *
 * A key saved in the console (integration_settings) overrides the env var of
 * the same name; deleting it falls back to the env value again. The services
 * that use these (voice.service, abdm.service, whatsapp.service,
 * whatsapp.routes) read process.env at call time, so overrides are applied by
 * writing them into process.env — refreshed every REFRESH_MS so all
 * instances (EC2 + serverless) pick up a change within a minute.
 */
const PROVIDERS = {
  whatsapp: {
    label: 'WhatsApp Cloud API (platform default)',
    description: 'Fallback number used when a hospital has no WhatsApp credentials of its own.',
    required: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'],
    fields: [
      { key: 'WHATSAPP_ACCESS_TOKEN', label: 'Access token', secret: true },
      { key: 'WHATSAPP_PHONE_NUMBER_ID', label: 'Phone number ID', secret: false },
      { key: 'WHATSAPP_WABA_ID', label: 'WhatsApp Business Account ID', secret: false },
      { key: 'WHATSAPP_VERIFY_TOKEN', label: 'Webhook verify token', secret: true },
    ],
  },
  twilio: {
    label: 'Twilio Voice',
    description: 'Voice check-in calls. Off when not configured; check-ins then go out on WhatsApp.',
    required: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VOICE_NUMBER', 'PUBLIC_BASE_URL'],
    fields: [
      { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', secret: false },
      { key: 'TWILIO_AUTH_TOKEN', label: 'Auth token', secret: true },
      { key: 'TWILIO_VOICE_NUMBER', label: 'Voice number', secret: false },
      { key: 'PUBLIC_BASE_URL', label: 'Public API base URL', secret: false },
    ],
  },
  abdm: {
    label: 'ABDM (ABHA)',
    description: 'ABHA creation and linking through ABDM. Off when not configured.',
    required: ['ABDM_CLIENT_ID', 'ABDM_CLIENT_SECRET'],
    fields: [
      { key: 'ABDM_CLIENT_ID', label: 'Client ID', secret: false },
      { key: 'ABDM_CLIENT_SECRET', label: 'Client secret', secret: true },
      { key: 'ABDM_CM_ID', label: 'CM ID (sbx / abdm)', secret: false },
    ],
  },
  regulars: {
    label: 'Regulars (retention)',
    description: 'Wayne E Solutions’ WhatsApp retention platform. Each hospital gets its own Regulars API key below.',
    required: ['REGULARS_BASE_URL'],
    fields: [{ key: 'REGULARS_BASE_URL', label: 'Regulars URL', secret: false }],
  },
};

const ALL_FIELDS = Object.values(PROVIDERS).flatMap((p) => p.fields);
const ALLOWED_KEYS = new Set(ALL_FIELDS.map((f) => f.key));
const SECRET_KEYS = new Set(ALL_FIELDS.filter((f) => f.secret).map((f) => f.key));

// Env values as deployed, captured before any override is applied.
const ENV_DEFAULTS = Object.fromEntries([...ALLOWED_KEYS].map((k) => [k, process.env[k]]));

const REFRESH_MS = 60_000;
let consoleKeys = new Set();
let loadedAt = 0;
let loading = null;

async function loadIntegrationOverrides() {
  const { rows } = await pool.query('SELECT key, value_encrypted FROM integration_settings');
  const next = new Set();
  for (const row of rows) {
    if (!ALLOWED_KEYS.has(row.key)) continue;
    try {
      process.env[row.key] = decrypt(row.value_encrypted);
      next.add(row.key);
    } catch (err) {
      console.error(`Could not decrypt integration key ${row.key}:`, err.message);
    }
  }
  // Keys removed from the console fall back to their deployed env value.
  for (const k of consoleKeys) {
    if (!next.has(k)) {
      if (ENV_DEFAULTS[k] === undefined) delete process.env[k];
      else process.env[k] = ENV_DEFAULTS[k];
    }
  }
  consoleKeys = next;
  loadedAt = Date.now();
}

/** Express middleware: keeps overrides fresh. Never blocks a request on failure. */
function ensureIntegrationsLoaded(req, res, next) {
  if (Date.now() - loadedAt < REFRESH_MS) return next();
  if (!loading) {
    loading = loadIntegrationOverrides()
      .catch((err) => console.error('Loading integration overrides failed:', err.message))
      .finally(() => { loading = null; });
  }
  loading.then(() => next(), () => next());
}

function fieldStatus(field) {
  const value = process.env[field.key];
  const source = consoleKeys.has(field.key) ? 'console' : value ? 'env' : 'missing';
  return {
    key: field.key,
    label: field.label,
    secret: field.secret,
    source,
    value: value ? (field.secret ? mask(value) : value) : null,
  };
}

function providerStatus() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    description: p.description,
    configured: p.required.every((k) => !!process.env[k]),
    fields: p.fields.map(fieldStatus),
  }));
}

/**
 * Saves (non-empty string) or clears (null / '') keys. Unknown keys are
 * rejected. Returns the list of keys changed.
 */
async function saveIntegrationKeys(values, actorId) {
  const changed = [];
  for (const [k, v] of Object.entries(values || {})) {
    if (!ALLOWED_KEYS.has(k)) throw Object.assign(new Error(`Unknown integration key: ${k}`), { status: 400 });
    if (v === undefined) continue;
    if (v === null || String(v).trim() === '') {
      await pool.query('DELETE FROM integration_settings WHERE key = $1', [k]);
    } else {
      await pool.query(
        `INSERT INTO integration_settings (key, value_encrypted, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [k, encrypt(String(v).trim()), actorId || null]
      );
    }
    changed.push(k);
  }
  await loadIntegrationOverrides();
  return changed;
}

const GRAPH = 'https://graph.facebook.com/v18.0';

/** Live credential check. Returns { ok, message }; failures also go to Platform Health. */
async function testProvider(id) {
  const env = process.env;
  try {
    if (id === 'whatsapp') {
      if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return { ok: false, message: 'Not configured.' };
      const { data } = await axios.get(`${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}`, {
        params: { fields: 'display_phone_number,verified_name,quality_rating' },
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
        timeout: 10_000,
      });
      return { ok: true, message: `Connected: ${data.verified_name || ''} ${data.display_phone_number || ''} (quality ${data.quality_rating || 'n/a'})`.trim() };
    }
    if (id === 'twilio') {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return { ok: false, message: 'Not configured.' };
      const { data } = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}.json`, {
        auth: { username: env.TWILIO_ACCOUNT_SID, password: env.TWILIO_AUTH_TOKEN },
        timeout: 10_000,
      });
      return { ok: true, message: `Connected: ${data.friendly_name} (${data.status})` };
    }
    if (id === 'abdm') {
      if (!env.ABDM_CLIENT_ID || !env.ABDM_CLIENT_SECRET) return { ok: false, message: 'Not configured.' };
      const url = env.ABDM_SESSION_URL || 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions';
      const { data } = await axios.post(
        url,
        { clientId: env.ABDM_CLIENT_ID, clientSecret: env.ABDM_CLIENT_SECRET, grantType: 'client_credentials' },
        {
          headers: {
            'Content-Type': 'application/json',
            'REQUEST-ID': require('crypto').randomUUID(),
            TIMESTAMP: new Date().toISOString(),
            'X-CM-ID': env.ABDM_CM_ID || 'sbx',
          },
          timeout: 10_000,
        }
      );
      return data.accessToken ? { ok: true, message: 'Connected: ABDM session token issued.' } : { ok: false, message: 'ABDM returned no access token.' };
    }
    if (id === 'regulars') {
      const base = (env.REGULARS_BASE_URL || '').replace(/\/$/, '');
      if (!base) return { ok: false, message: 'Not configured.' };
      // Without a key the ping must answer 401 — that proves the URL is a Regulars server.
      const res = await axios.get(`${base}/api/v1/ping`, { timeout: 10_000, validateStatus: () => true });
      if (res.status === 401) return { ok: true, message: `Reachable: ${base}. Now add each hospital's API key below.` };
      return { ok: false, message: `Unexpected response HTTP ${res.status} from ${base}/api/v1/ping — is this the Regulars app URL?` };
    }
    return { ok: false, message: 'Unknown provider.' };
  } catch (err) {
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    await recordPlatformEvent({ source: 'integration', message: `${id} connection test failed: ${message}` });
    return { ok: false, message };
  }
}

/**
 * Pulls message templates from Meta for the platform WABA (scope 'global')
 * and for every hospital that has its own whatsapp_waba_id.
 */
async function syncWhatsAppTemplates() {
  const targets = [];
  if (process.env.WHATSAPP_WABA_ID && process.env.WHATSAPP_ACCESS_TOKEN) {
    targets.push({ scope: 'global', wabaId: process.env.WHATSAPP_WABA_ID, token: process.env.WHATSAPP_ACCESS_TOKEN, clinicId: null });
  }
  const { rows } = await pool.query(
    `SELECT id, whatsapp_waba_id, whatsapp_access_token FROM clinics WHERE whatsapp_waba_id IS NOT NULL AND whatsapp_waba_id <> ''`
  );
  for (const c of rows) {
    const token = c.whatsapp_access_token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (token) targets.push({ scope: c.id, wabaId: c.whatsapp_waba_id, token, clinicId: c.id });
  }

  const results = [];
  for (const t of targets) {
    try {
      const { data } = await axios.get(`${GRAPH}/${t.wabaId}/message_templates`, {
        params: { fields: 'name,language,status,category,rejected_reason', limit: 200 },
        headers: { Authorization: `Bearer ${t.token}` },
        timeout: 15_000,
      });
      const templates = data.data || [];
      await pool.query('DELETE FROM whatsapp_templates WHERE scope = $1', [t.scope]);
      for (const tpl of templates) {
        await pool.query(
          `INSERT INTO whatsapp_templates (scope, name, language, category, status, rejected_reason, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (scope, name, language) DO UPDATE SET category = EXCLUDED.category,
             status = EXCLUDED.status, rejected_reason = EXCLUDED.rejected_reason, synced_at = NOW()`,
          [t.scope, tpl.name, tpl.language, tpl.category || null, tpl.status, tpl.rejected_reason && tpl.rejected_reason !== 'NONE' ? tpl.rejected_reason : null]
        );
      }
      results.push({ scope: t.scope, ok: true, count: templates.length });
    } catch (err) {
      const message = err.response?.data?.error?.message || err.message;
      await recordPlatformEvent({ source: 'integration', clinicId: t.clinicId, message: `Template sync failed: ${message}` });
      results.push({ scope: t.scope, ok: false, error: message });
    }
  }
  return { targets: targets.length, results };
}

module.exports = {
  PROVIDERS,
  ensureIntegrationsLoaded,
  loadIntegrationOverrides,
  providerStatus,
  saveIntegrationKeys,
  testProvider,
  syncWhatsAppTemplates,
  SECRET_KEYS,
};
