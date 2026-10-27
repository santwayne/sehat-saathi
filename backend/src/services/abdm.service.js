const axios = require('axios');
const crypto = require('crypto');
const { pool } = require('../db');

// ABHA creation through ABDM's v3 Aadhaar-OTP enrolment (M1):
//   session token -> ABDM public key -> RSA-encrypted Aadhaar -> OTP request
//   -> OTP + txnId -> ABHA number.
//
// Off unless ABDM_CLIENT_ID / ABDM_CLIENT_SECRET are set. Written from ABDM's
// published v3 flow and developer-forum guidance; it has NOT been run against
// the ABDM sandbox (no credentials yet), and ABDM must enable v3/hid access on
// the client id. Every URL is overridable by env because ABDM has moved paths
// between releases. Care-context push (M2/HIP) is deliberately not here.
//
// Aadhaar numbers pass straight through to ABDM: they are never stored or logged.

const CFG = () => ({
  clientId: process.env.ABDM_CLIENT_ID,
  clientSecret: process.env.ABDM_CLIENT_SECRET,
  cmId: process.env.ABDM_CM_ID || 'sbx',
  sessionUrl: process.env.ABDM_SESSION_URL || 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions',
  abhaBase: (process.env.ABDM_ABHA_BASE_URL || 'https://abhasbx.abdm.gov.in/abha/api/v3').replace(/\/$/, ''),
  certUrl: process.env.ABDM_CERT_URL || null,
});

function isConfigured() {
  const c = CFG();
  return !!(c.clientId && c.clientSecret);
}

class AbdmError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const baseHeaders = (token) => ({
  'Content-Type': 'application/json',
  'REQUEST-ID': crypto.randomUUID(),
  TIMESTAMP: new Date().toISOString(),
  'X-CM-ID': CFG().cmId,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

let tokenCache = null;
async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const c = CFG();
  const { data } = await axios.post(
    c.sessionUrl,
    { clientId: c.clientId, clientSecret: c.clientSecret, grantType: 'client_credentials' },
    { headers: baseHeaders() }
  );
  const token = data.accessToken;
  if (!token) throw new AbdmError('ABDM did not return an access token.', 502);
  const ttlMs = Math.max(((data.expiresIn || 600) - 30) * 1000, 30_000);
  tokenCache = { token, expiresAt: Date.now() + ttlMs };
  return token;
}

/** Accepts a PEM, or bare base64 SPKI (what ABDM returns), or JSON with the key. */
function toPem(raw) {
  let key = typeof raw === 'string' ? raw : raw?.publicKey || raw?.key || raw?.cert || '';
  key = String(key).trim();
  if (!key) throw new AbdmError('ABDM did not return an encryption key.', 502);
  if (key.includes('BEGIN')) return key;
  const body = key.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

let keyCache = null;
async function getPublicKey(token) {
  if (keyCache && keyCache.expiresAt > Date.now()) return keyCache.pem;
  const c = CFG();
  const url = c.certUrl || `${c.abhaBase}/profile/public/certificate`;
  const { data } = await axios.get(url, { headers: baseHeaders(token) });
  const pem = toPem(data);
  keyCache = { pem, expiresAt: Date.now() + 60 * 60 * 1000 };
  return pem;
}

// RSA-OAEP with SHA-1 / MGF1-SHA-1, base64 — what ABDM documents for v3.
function encrypt(pem, plain) {
  return crypto
    .publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(String(plain), 'utf8'))
    .toString('base64');
}

function wrapError(err) {
  if (err instanceof AbdmError) return err;
  const status = err.response?.status;
  const detail = err.response?.data?.message || err.response?.data?.error?.message || err.message;
  // 900908 = "API subscription validation failed": the client id lacks v3 access.
  const hint = /900908/.test(JSON.stringify(err.response?.data || '')) ? ' (ABDM has not enabled v3 ABHA access for this client id)' : '';
  return new AbdmError(`ABDM request failed${status ? ` (${status})` : ''}: ${detail}${hint}`, status && status < 500 ? 400 : 502);
}

/** Step 1: ABDM texts an OTP to the mobile linked to the Aadhaar. */
async function initiateAbhaEnrolment(patientId, aadhaar) {
  if (!isConfigured()) throw new AbdmError('ABDM integration is not configured.', 503);
  if (!/^\d{12}$/.test(String(aadhaar))) throw new AbdmError('Aadhaar must be 12 digits.', 400);
  try {
    const token = await getAccessToken();
    const pem = await getPublicKey(token);
    const { data } = await axios.post(
      `${CFG().abhaBase}/enrollment/request/otp`,
      { txnId: '', scope: ['abha-enrol'], loginHint: 'aadhaar', loginId: encrypt(pem, aadhaar), otpSystem: 'aadhaar' },
      { headers: baseHeaders(token) }
    );
    if (!data.txnId) throw new AbdmError('ABDM did not return a transaction id.', 502);
    await pool.query(
      `INSERT INTO abha_enrolment_sessions (patient_id, txn_id) VALUES ($1, $2)
       ON CONFLICT (patient_id) DO UPDATE SET txn_id = EXCLUDED.txn_id, created_at = NOW()`,
      [patientId, data.txnId]
    );
    return { message: data.message || 'OTP sent to the mobile number linked to Aadhaar.' };
  } catch (err) {
    throw wrapError(err);
  }
}

/** Step 2: verify the OTP; on success the ABHA is stored as ABDM-verified. */
async function verifyAbhaOtp(patientId, otp, mobile) {
  if (!isConfigured()) throw new AbdmError('ABDM integration is not configured.', 503);
  if (!/^\d{6}$/.test(String(otp))) throw new AbdmError('OTP must be 6 digits.', 400);

  const { rows } = await pool.query(
    `SELECT txn_id FROM abha_enrolment_sessions WHERE patient_id = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
    [patientId]
  );
  if (!rows[0]) throw new AbdmError('No OTP request in progress (or it expired). Start again.', 409);

  try {
    const token = await getAccessToken();
    const pem = await getPublicKey(token);
    const { data } = await axios.post(
      `${CFG().abhaBase}/enrollment/enrol/byAadhaar`,
      {
        authData: {
          authMethods: ['otp'],
          otp: { timeStamp: new Date().toISOString().replace('T', ' ').slice(0, 19), txnId: rows[0].txn_id, otpValue: encrypt(pem, otp), ...(mobile ? { mobile } : {}) },
        },
        consent: { code: 'abha-enrollment', version: '1.4' },
      },
      { headers: baseHeaders(token) }
    );
    const profile = data.ABHAProfile || data.abhaProfile || {};
    const abhaNumber = profile.ABHANumber || profile.abhaNumber || null;
    if (!abhaNumber) throw new AbdmError(data.message || 'ABDM did not return an ABHA number.', 502);
    const address = profile.preferredAbhaAddress || (Array.isArray(profile.phrAddress) ? profile.phrAddress[0] : null) || null;

    const upd = await pool.query(
      `UPDATE patients SET abha_number = $1, abha_address = COALESCE($2, abha_address), abha_linked_at = NOW(), abha_verified_by_abdm = true
       WHERE id = $3 RETURNING id, abha_number, abha_address, abha_linked_at, abha_verified_by_abdm`,
      [abhaNumber, address, patientId]
    );
    await pool.query('DELETE FROM abha_enrolment_sessions WHERE patient_id = $1', [patientId]);
    return upd.rows[0];
  } catch (err) {
    throw wrapError(err);
  }
}

module.exports = { isConfigured, initiateAbhaEnrolment, verifyAbhaOtp, AbdmError, _test: { toPem, encrypt } };
