const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

/**
 * Loopdesk hub connection (Nov 2026) — same contract as Loyvexa, WayneRing,
 * GMB Manager and Video Studio.
 *
 * Loopdesk (the hub, formerly "Regulars hub") sells and bills Sehat Saathi as a
 * hospital package. Tokens both ways are HS256 JWTs signed with HUB_SECRET and
 * valid for 2 minutes, each usable once (jti):
 *
 *   Loopdesk → Sehat Saathi   iss "regulars-hub"  aud "sehat-saathi"  sub <hub business id>
 *                             purpose "provision" | "sso" | "whatsapp-inbound"
 *   Sehat Saathi → Loopdesk   iss "sehat-saathi"  aud "regulars-hub"  sub <hub business id>
 *                             purpose "whatsapp-send" | "whatsapp-media"
 *
 * A hospital made by the hub has clinics.hub_business_id set. One made by hand
 * (demo, pilots, direct clients) keeps its own WhatsApp number and Twilio voice
 * exactly as before.
 */

const TOKEN_TTL = '2m';
const cfg = () => ({
  secret: process.env.HUB_SECRET || '',
  issuer: process.env.HUB_ISSUER || 'regulars-hub',
  audience: process.env.HUB_AUDIENCE || 'sehat-saathi',
  // Where Loopdesk's tool API lives (sends WhatsApp from the hospital's number).
  apiUrl: (process.env.HUB_API_URL || '').replace(/\/$/, ''),
});

const hubConfigured = () => cfg().secret.length >= 32;

class HubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Verifies a token from Loopdesk for one purpose and burns its jti. */
async function verifyHubToken(token, purpose) {
  if (!hubConfigured()) throw new HubError(503, 'Loopdesk connection is not configured (HUB_SECRET).');
  const { secret, issuer, audience } = cfg();
  let claims;
  try {
    claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer, audience, maxAge: '3m' });
  } catch {
    throw new HubError(401, 'Invalid or expired Loopdesk token.');
  }
  if (claims.purpose !== purpose || !claims.sub || !claims.jti) throw new HubError(401, 'Wrong Loopdesk token.');
  const { rowCount } = await pool.query(
    'INSERT INTO hub_token_uses (jti, purpose) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [String(claims.jti).slice(0, 100), purpose]
  );
  if (!rowCount) throw new HubError(401, 'Loopdesk token already used.');
  pool.query("DELETE FROM hub_token_uses WHERE used_at < NOW() - INTERVAL '1 day'").catch(() => {});
  return claims;
}

/** Token for calls Sehat Saathi makes to Loopdesk. */
function signHubToken(hubBusinessId, purpose) {
  const { secret, issuer } = cfg();
  return jwt.sign({ purpose, jti: crypto.randomUUID() }, secret, {
    algorithm: 'HS256', issuer: 'sehat-saathi', audience: issuer, subject: hubBusinessId, expiresIn: TOKEN_TTL,
  });
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HubError(401, 'Loopdesk token missing.');
  return h.slice(7);
};

// ---------------------------------------------------------------------------
// Which hospitals follow the hub rules
// ---------------------------------------------------------------------------

const isHubClinic = (clinic) => !!clinic?.hub_business_id;

/**
 * Bundle rule: calls only through WayneRing, and only when WayneRing is in the
 * package. A hub hospital without WAYNERING in its tools gets no voice calls;
 * check-ins stay on WhatsApp. Hospitals made by hand are unaffected.
 */
function voiceAllowed(clinic) {
  if (!isHubClinic(clinic)) return true;
  return Array.isArray(clinic.hub_tools) && clinic.hub_tools.map((t) => String(t).toUpperCase()).includes('WAYNERING');
}

// Small cache: the scheduler can send many messages for one hospital in a burst.
const CACHE_MS = 60_000;
const clinicCache = new Map();
async function hubInfoFor(clinicId) {
  if (!clinicId) return null;
  const hit = clinicCache.get(clinicId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const { rows } = await pool.query('SELECT id, hub_business_id, hub_tools, status FROM clinics WHERE id = $1', [clinicId]);
  const value = rows[0] || null;
  clinicCache.set(clinicId, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}
const clearHubCache = (clinicId) => (clinicId ? clinicCache.delete(clinicId) : clinicCache.clear());

/**
 * The hospital's hub business id when its WhatsApp must go out through
 * Loopdesk's number, else null (then the hospital's own WABA number is used).
 */
async function hubWhatsAppRoute(clinicId) {
  if (!hubConfigured() || !cfg().apiUrl) return null;
  const c = await hubInfoFor(clinicId);
  return isHubClinic(c) ? c.hub_business_id : null;
}

/**
 * POST {HUB_API_URL}/api/hub/tools/sehat-saathi/whatsapp/send
 * Body { to, message } — message is a WhatsApp Cloud API payload
 * ({ type: 'text' | 'template' | 'interactive', … }) without messaging_product/to.
 * Loopdesk sends it from the hospital's number, applies its own STOP list and
 * answers { messageId }.
 */
async function hubSend(hubBusinessId, to, message) {
  const token = signHubToken(hubBusinessId, 'whatsapp-send');
  try {
    const res = await axios.post(`${cfg().apiUrl}/api/hub/tools/sehat-saathi/whatsapp/send`, { to, message }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
    return { messages: [{ id: res.data?.messageId || null }], via: 'loopdesk' };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.response?.data?.error || error.message;
    // Shaped like a Graph API error so existing callers log it the same way.
    const e = new Error(`Loopdesk WhatsApp send failed: ${msg}`);
    e.response = { status: error.response?.status, data: { error: { message: `Loopdesk: ${msg}`, code: error.response?.status } } };
    throw e;
  }
}

/**
 * GET {HUB_API_URL}/api/hub/tools/sehat-saathi/whatsapp/media/:mediaId
 * Media (prescription photos, voice notes) belongs to Loopdesk's WABA, so only
 * Loopdesk can download it. Answers the file bytes with its Content-Type.
 */
async function hubMedia(hubBusinessId, mediaId) {
  const token = signHubToken(hubBusinessId, 'whatsapp-media');
  const res = await axios.get(`${cfg().apiUrl}/api/hub/tools/sehat-saathi/whatsapp/media/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: 30_000,
  });
  const base64 = Buffer.from(res.data, 'binary').toString('base64');
  const mimeType = res.headers['content-type'] || 'application/octet-stream';
  return { base64, base64Image: base64, mimeType, mediaUrl: null };
}

module.exports = {
  HubError, hubConfigured, verifyHubToken, signHubToken, bearer,
  isHubClinic, voiceAllowed, hubInfoFor, clearHubCache, hubWhatsAppRoute, hubSend, hubMedia,
};
