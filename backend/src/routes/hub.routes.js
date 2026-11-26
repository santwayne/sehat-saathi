const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword, issueToken } = require('../services/auth.service');
const { logAudit } = require('../services/audit.service');
const { clinicAccessInfo, recordsAccessFor, setRecordsMode, clearClinicAccessCache } = require('../services/records-access.service');
const { recordPlatformEvent } = require('../services/platform-events.service');
const hub = require('../services/hub.service');

/**
 * Loopdesk hub endpoints (mounted at /api/hub). Sehat Saathi is sold as a
 * Loopdesk hospital package; see services/hub.service.js for the token rules.
 *
 *   POST /api/hub/provision         create / update / pause the hospital
 *   POST /api/hub/sso/exchange      one-time Loopdesk token → dashboard session
 *   POST /api/hub/whatsapp/inbound  WhatsApp messages that reached the hospital's
 *                                   Loopdesk number and belong to Sehat Saathi
 */

const fail = (res, err) => {
  if (err instanceof hub.HubError || err.status) return res.status(err.status || 400).json({ error: err.message });
  console.error('Hub route failed:', err);
  return res.status(500).json({ error: 'Internal server error' });
};

const str = (v, max = 255) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const digitsOf = (p) => String(p || '').replace(/\D/g, '');
const RECORDS_MODES = ['with_records', 'without_records'];

/** Checks the body the hub sends (same shape as Loyvexa's provision). */
function readProvision(body) {
  const b = body || {};
  const errors = [];
  if (!str(b.hubBusinessId, 100)) errors.push('hubBusinessId is required');
  if (typeof b.active !== 'boolean') errors.push('active must be true or false');
  if (!str(b.business?.name)) errors.push('business.name is required');
  if (!str(b.owner?.name)) errors.push('owner.name is required');
  if (!/^\S+@\S+\.\S+$/.test(String(b.owner?.email || ''))) errors.push('owner.email must be an email');
  if (b.tools !== undefined && !(Array.isArray(b.tools) && b.tools.every((t) => typeof t === 'string'))) errors.push('tools must be a list of names');
  if (b.recordsMode !== undefined && !RECORDS_MODES.includes(b.recordsMode)) errors.push(`recordsMode must be ${RECORDS_MODES.join(' or ')}`);
  if (b.paidUntil && Number.isNaN(Date.parse(b.paidUntil))) errors.push('paidUntil must be a date');
  if (errors.length) throw Object.assign(new Error(`Invalid provision: ${errors.join('; ')}`), { status: 400 });
  return {
    hubBusinessId: str(b.hubBusinessId, 100),
    active: b.active,
    plan: str(b.plan, 100),
    paidUntil: b.paidUntil || null,
    tools: b.tools ? [...new Set(b.tools.map((t) => t.trim().toUpperCase()).filter(Boolean))] : null,
    recordsMode: b.recordsMode || null,
    business: { name: str(b.business.name), address: str(b.business.address, 1000), phone: str(b.business.phone, 20) },
    owner: { name: str(b.owner.name), email: String(b.owner.email).trim().toLowerCase(), phone: str(b.owner.phone, 20) },
  };
}

/**
 * Staff log in by phone, and phones are unique. Use the owner's phone when it's
 * free; otherwise a placeholder that can't collide or be typed by accident —
 * Loopdesk single sign-on works either way, and the owner can set a real
 * phone + password in Settings later.
 */
async function loginPhoneFor(db, ownerPhone) {
  const d = digitsOf(ownerPhone);
  const phone = d.length === 10 ? `91${d}` : d;
  if (/^\d{10,15}$/.test(phone)) {
    const { rows } = await db.query(
      "SELECT 1 FROM staff_users WHERE regexp_replace(phone, '\\D', '', 'g') IN ($1, $2)", [phone, phone.replace(/^91(?=\d{10}$)/, '')]);
    if (!rows.length) return phone;
  }
  return `hub-${crypto.randomBytes(7).toString('hex')}`; // 18 chars, fits VARCHAR(20)
}

router.post('/provision', async (req, res) => {
  try {
    const claims = await hub.verifyHubToken(hub.bearer(req), 'provision');
    const p = readProvision(req.body);
    if (claims.sub !== p.hubBusinessId) throw new hub.HubError(401, 'Token is for a different business.');
    const status = p.active ? 'active' : 'suspended';
    const warnings = [];

    const client = await pool.connect();
    let clinic; let created = false;
    try {
      await client.query('BEGIN');
      const { rows: [found] } = await client.query('SELECT * FROM clinics WHERE hub_business_id = $1 FOR UPDATE', [p.hubBusinessId]);
      if (found) {
        // Same hospital every time. Name/address stay as the hospital set them.
        ({ rows: [clinic] } = await client.query(
          `UPDATE clinics SET status = $2, hub_tools = COALESCE($3, hub_tools), hub_plan = COALESCE($4, hub_plan),
                  hub_paid_until = $5, hub_synced_at = NOW()
            WHERE id = $1 RETURNING *`,
          [found.id, status, p.tools, p.plan, p.paidUntil]));
      } else {
        created = true;
        ({ rows: [clinic] } = await client.query(
          `INSERT INTO clinics (name, address, status, hub_business_id, hub_tools, hub_plan, hub_paid_until, hub_synced_at, records_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8) RETURNING *`,
          [p.business.name, p.business.address, status, p.hubBusinessId, p.tools || [], p.plan, p.paidUntil, p.recordsMode || 'with_records']));
        // First admin = the owner. Loopdesk signs them in, so the password is random.
        const phone = await loginPhoneFor(client, p.owner.phone);
        if (phone.startsWith('hub-')) warnings.push('Owner phone missing or already used: admin login phone is a placeholder; single sign-on from Loopdesk still works.');
        await client.query(
          `INSERT INTO staff_users (clinic_id, name, role, phone, email, password_hash) VALUES ($1, $2, 'admin', $3, $4, $5)`,
          [clinic.id, p.owner.name, phone, p.owner.email, await hashPassword(crypto.randomBytes(24).toString('base64url'))]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Plan change with / without patient records. Refused (not fatal) while
    // the hospital still stores records — it must remove them itself first.
    if (!created && p.recordsMode && p.recordsMode !== clinic.records_mode) {
      try {
        await setRecordsMode(clinic.id, p.recordsMode);
        clinic.records_mode = p.recordsMode;
      } catch (e) {
        warnings.push(e.message);
      }
    }
    clearClinicAccessCache(clinic.id);
    hub.clearHubCache(clinic.id);
    // Audit, not a platform event: platform_events is the health/error console.
    await logAudit(req, created ? 'hub.provision.create' : 'hub.provision.update', {
      actor: { id: null, name: 'Loopdesk', role: 'system' }, targetType: 'clinic', targetId: clinic.id, clinicId: clinic.id,
      details: { hubBusinessId: p.hubBusinessId, status, plan: p.plan, tools: clinic.hub_tools, warnings },
    });

    const base = (process.env.APP_BASE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
    return res.json({
      accountId: clinic.id,
      status: clinic.status === 'active' ? 'ACTIVE' : 'PAUSED',
      data: {
        name: clinic.name, created, recordsMode: clinic.records_mode,
        voiceCalls: hub.voiceAllowed(clinic), consoleUrl: base ? `${base}/app` : null,
        ...(warnings.length ? { warnings } : {}),
      },
    });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/sso/exchange', async (req, res) => {
  try {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.length < 10) return res.status(400).json({ error: 'token is required.' });
    const claims = await hub.verifyHubToken(token, 'sso');
    const { rows: [clinic] } = await pool.query('SELECT * FROM clinics WHERE hub_business_id = $1', [claims.sub]);
    if (!clinic || (claims.acct && claims.acct !== clinic.id)) return res.status(401).json({ error: 'Hospital not found for this Loopdesk business.' });
    if (clinic.status === 'suspended') return res.status(403).json({ error: 'This hospital is paused. Renew the plan in your Loopdesk account.' });

    // The signed-in Loopdesk user's own staff login if their email matches,
    // else the hospital's first admin.
    const { rows: [staff] } = await pool.query(
      `SELECT id, clinic_id, name, role, phone FROM staff_users WHERE clinic_id = $1 AND deactivated_at IS NULL
        ORDER BY (lower(email) = lower($2)) DESC, (role = 'admin') DESC, created_at ASC LIMIT 1`,
      [clinic.id, String(claims.email || '')]);
    if (!staff) return res.status(403).json({ error: 'No staff login for this hospital.' });

    const next = typeof claims.next === 'string' && claims.next.startsWith('/') && !claims.next.startsWith('//') ? claims.next : '/app';
    await logAudit(req, 'auth.login.loopdesk', { actor: staff, targetType: 'staff', targetId: staff.id, clinicId: clinic.id });
    return res.json({
      success: true,
      token: issueToken(staff),
      next,
      staff: { ...staff, records_access: recordsAccessFor(staff.role, await clinicAccessInfo(clinic.id)) },
    });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Body: { messages: [WhatsApp Cloud API message objects], statuses?: [...] }
 * Loopdesk forwards only messages that belong to Sehat Saathi (patients,
 * family members, QR/bed enrolment) of this hospital. Answered at once; the
 * messages are then handled exactly like the Meta webhook does.
 */
router.post('/whatsapp/inbound', async (req, res) => {
  let clinic;
  try {
    const claims = await hub.verifyHubToken(hub.bearer(req), 'whatsapp-inbound');
    ({ rows: [clinic] } = await pool.query('SELECT id, name, status, records_mode, hub_business_id FROM clinics WHERE hub_business_id = $1', [claims.sub]));
    if (!clinic) return res.status(404).json({ error: 'Hospital not found for this Loopdesk business.' });
  } catch (err) {
    return fail(res, err);
  }
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.filter((m) => m && m.from && m.type) : [];
  res.json({ ok: true, accepted: clinic.status === 'suspended' ? 0 : messages.length });
  if (clinic.status === 'suspended') return;

  // Lazy require: whatsapp.routes pulls in the whole conversation engine.
  const { handleClinicMessage } = require('./whatsapp.routes');
  for (const message of messages) {
    try {
      await handleClinicMessage(clinic, message);
    } catch (error) {
      console.error('Loopdesk inbound message failed:', error);
      await recordPlatformEvent({ source: 'webhook', clinicId: clinic.id, message: `Loopdesk inbound processing error: ${error.message}`, details: { via: 'loopdesk' } }).catch(() => {});
    }
  }
});

module.exports = router;
