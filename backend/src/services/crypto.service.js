const crypto = require('crypto');

// AES-256-GCM for third-party keys stored in integration_settings.
// Key: INTEGRATIONS_ENCRYPTION_KEY if set (recommended, any long random
// string), else derived from JWT_SECRET. Changing the key makes previously
// saved values unreadable — they then have to be re-entered in Integrations.
function key() {
  const secret = process.env.INTEGRATIONS_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('INTEGRATIONS_ENCRYPTION_KEY (or JWT_SECRET) must be set to store integration keys.');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload) {
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1') throw new Error('Unknown encryption format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** "••••1234" — enough to recognise a key without revealing it. */
function mask(value) {
  if (!value) return null;
  const s = String(value);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask };
