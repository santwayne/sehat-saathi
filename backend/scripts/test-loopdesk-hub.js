// End-to-end test: Loopdesk hub connection + multilingual safety.
// Needs a database created from src/db/schema.sql. Starts the API and a fake
// Loopdesk in-process, so nothing external is called.
//   DATABASE_URL=postgres://… node scripts/test-loopdesk-hub.js
const assert = require('assert/strict');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

process.env.HUB_SECRET = process.env.HUB_SECRET || crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.SUPER_ADMIN_PHONE = process.env.SUPER_ADMIN_PHONE || '9000000001';
process.env.SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Test@12345';

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

// ---- fake Loopdesk: records what Sehat Saathi sends through it ----
const sent = [];
const calls = [];
const fakeHub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/v1/outbound-calls') { // fake WayneRing
      if (req.headers.authorization !== 'Bearer wr-test-key') { res.writeHead(401).end('{}'); return; }
      calls.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: `call_${calls.length}` }));
      return;
    }
    const auth = (req.headers.authorization || '').slice(7);
    let claims;
    try { claims = jwt.verify(auth, process.env.HUB_SECRET, { issuer: 'sehat-saathi', audience: 'regulars-hub' }); } catch {
      res.writeHead(401).end('{"error":"bad token"}'); return;
    }
    if (req.url === '/api/hub/tools/sehat-saathi/whatsapp/send' && claims.purpose === 'whatsapp-send') {
      sent.push({ sub: claims.sub, ...JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messageId: `wamid.${sent.length}` }));
      return;
    }
    if (req.url.startsWith('/api/hub/tools/sehat-saathi/whatsapp/media/') && claims.purpose === 'whatsapp-media') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.from('fake-jpeg'));
      return;
    }
    res.writeHead(404).end('{}');
  });
});

const hubToken = (sub, purpose, extra = {}) => jwt.sign({ purpose, jti: crypto.randomUUID(), ...extra }, process.env.HUB_SECRET,
  { algorithm: 'HS256', issuer: 'regulars-hub', audience: 'sehat-saathi', subject: sub, expiresIn: '2m' });

(async () => {
  await new Promise((r) => fakeHub.listen(0, r));
  process.env.HUB_API_URL = `http://127.0.0.1:${fakeHub.address().port}`;
  process.env.WAYNERING_BASE_URL = process.env.HUB_API_URL;
  process.env.WAYNERING_API_KEY = 'wr-test-key';
  process.env.CALL_WEBHOOK_SECRET = 'wr-webhook-secret-0123456789';
  process.env.PUBLIC_BASE_URL = 'https://api.sehat.example';
  const app = require('../src/app');
  const { pool } = require('../src/db');
  const server = app.listen(0);
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let json; try { json = JSON.parse(t); } catch { json = t; }
    return { status: r.status, json };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = Date.now().toString(36);
  const BIZ = `biz_${run}`;
  const ownerPhone = `98${String(Date.now()).slice(-8)}`;
  const provisionBody = (over = {}) => ({
    hubBusinessId: BIZ, active: true, plan: 'Sehat Saathi Professional — Complete', tools: ['SEHAT_SAATHI'],
    business: { name: `Test Hospital ${run}`, address: 'Ludhiana' },
    owner: { name: 'Dr Owner', email: `owner.${run}@example.com`, phone: ownerPhone }, ...over,
  });

  console.log('Sehat Saathi — Loopdesk hub + safety');

  // ---------- provision ----------
  assert.equal((await call('POST', '/api/hub/provision', { body: provisionBody() })).status, 401);
  const t1 = hubToken(BIZ, 'provision');
  const p1 = await call('POST', '/api/hub/provision', { token: t1, body: provisionBody() });
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  assert.equal(p1.json.status, 'ACTIVE'); assert.equal(p1.json.data.created, true); assert.equal(p1.json.data.voiceCalls, false);
  const clinicId = p1.json.accountId;
  const { rows: [admin] } = await pool.query('SELECT * FROM staff_users WHERE clinic_id=$1', [clinicId]);
  assert.equal(admin.role, 'admin'); assert.equal(admin.phone, `91${ownerPhone}`);
  ok('Loopdesk creates the hospital + owner as admin (no token → 401)');

  assert.equal((await call('POST', '/api/hub/provision', { token: t1, body: provisionBody() })).status, 401);
  assert.equal((await call('POST', '/api/hub/provision', { token: hubToken('someone_else', 'provision'), body: provisionBody() })).status, 401);
  assert.equal((await call('POST', '/api/hub/provision', { token: hubToken(BIZ, 'sso'), body: provisionBody() })).status, 401);
  ok('replayed token, other business\'s token and wrong-purpose token are refused');

  const p2 = await call('POST', '/api/hub/provision', { token: hubToken(BIZ, 'provision'), body: provisionBody({ active: false }) });
  assert.equal(p2.json.status, 'PAUSED'); assert.equal(p2.json.data.created, false);
  assert.equal((await pool.query('SELECT count(*)::int n FROM clinics WHERE hub_business_id=$1', [BIZ])).rows[0].n, 1);
  assert.equal((await call('POST', '/api/hub/sso/exchange', { body: { token: hubToken(BIZ, 'sso') } })).status, 403);
  ok('unpaid plan pauses the same hospital (no duplicate); paused hospital cannot sign in');

  const p3 = await call('POST', '/api/hub/provision', { token: hubToken(BIZ, 'provision'), body: provisionBody({ tools: ['SEHAT_SAATHI', 'WAYNERING'] }) });
  assert.equal(p3.json.status, 'ACTIVE'); assert.equal(p3.json.data.voiceCalls, true);
  const voice = require('../src/services/voice.service');
  require('../src/services/hub.service').clearHubCache();
  assert.equal(await voice.allowedForClinic(clinicId), true);
  ok('renewed + WayneRing added → active again, voice calls allowed');

  // ---------- SSO ----------
  const sso = await call('POST', '/api/hub/sso/exchange', { body: { token: hubToken(BIZ, 'sso', { email: `owner.${run}@example.com` }) } });
  assert.equal(sso.status, 200, JSON.stringify(sso.json));
  assert.equal(sso.json.staff.id, admin.id); assert.equal(sso.json.staff.records_access, 'enabled'); assert.equal(sso.json.next, '/app');
  const me = await call('GET', '/api/auth/me', { token: sso.json.token });
  assert.equal(me.status, 200); assert.equal(me.json.data.clinic_id, clinicId);
  ok('"Open Sehat Saathi" in Loopdesk signs the owner in without a password; records open');

  // ---------- WhatsApp through Loopdesk ----------
  const patientPhone = `91${String(Date.now()).slice(-10)}`;
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (clinic_id, name, phone, language_pref, consent_given) VALUES ($1,'Mandeep',$2,'hi',true) RETURNING *`, [clinicId, patientPhone]);
  assert.equal((await call('POST', '/api/hub/whatsapp/inbound', { body: { messages: [] } })).status, 401);
  const inb = await call('POST', '/api/hub/whatsapp/inbound', {
    token: hubToken(BIZ, 'whatsapp-inbound'),
    body: { messages: [{ from: patientPhone, id: `wamid.in.${run}`, type: 'text', text: { body: 'mujhe chhati mein dard ho raha hai' } }] },
  });
  assert.equal(inb.status, 200); assert.equal(inb.json.accepted, 1);
  await wait(800);
  const { rows: flags } = await pool.query('SELECT * FROM flags WHERE patient_id=$1', [patient.id]);
  assert.equal(flags.length, 1); assert.equal(flags[0].priority, 'urgent');
  const reply = sent.find((m) => m.to === patientPhone);
  assert.ok(reply, 'urgent reply went out through Loopdesk'); assert.equal(reply.sub, BIZ); assert.equal(reply.message.type, 'text');
  ok('Hinglish "chhati mein dard" via Loopdesk → URGENT flag + reply sent from the Loopdesk number');

  const media = await require('../src/services/whatsapp.service').downloadWhatsAppMedia('media123', clinicId);
  assert.equal(Buffer.from(media.base64, 'base64').toString(), 'fake-jpeg'); assert.equal(media.mimeType, 'image/jpeg');
  ok('prescription photos are downloaded through Loopdesk (media lives in its WABA)');

  // ---------- templates through Loopdesk ----------
  const wa = require('../src/services/whatsapp.service');
  await wa.sendWhatsAppTemplate(patientPhone, 'patient_checkin', 'ta', ['Mandeep'], clinicId);
  const tpl = sent.filter((m) => m.message.type === 'template').pop();
  assert.equal(tpl.message.template.name, 'sehat_patient_checkin'); assert.equal(tpl.message.template.language.code, 'en');
  ok('templates go out as sehat_<name> (Loopdesk\'s approved set), unknown language → English');

  // ---------- calls only through WayneRing, only with WayneRing in the package ----------
  const sign = (body) => crypto.createHmac('sha256', process.env.CALL_WEBHOOK_SECRET).update(body).digest('hex');
  const hook = async (payload, sig) => {
    const raw = JSON.stringify(payload);
    const r = await fetch(`${BASE}/api/voice/waynering/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig !== false ? { 'x-waynering-signature': sig || sign(raw) } : {}) }, body: raw });
    return r.status;
  };
  assert.equal(await voice.callRoute(clinicId), 'waynering');
  await voice.placeCheckinCall({ id: patient.id, phone: patientPhone, language_pref: 'pa' }, clinicId);
  assert.equal(calls.length, 1); assert.equal(calls[0].language, 'pa'); assert.equal(calls[0].metadata.sehat_saathi_patient_id, patient.id);
  assert.match(calls[0].instructions, /Never give medical advice/); assert.equal(calls[0].webhook_url, 'https://api.sehat.example/api/voice/waynering/webhook');
  assert.equal(await hook({ id: 'call_1', status: 'completed', outcome: 'SYMPTOM', metadata: { sehat_saathi_patient_id: patient.id } }, false), 401);
  assert.equal(await hook({ id: 'call_1', status: 'completed', outcome: 'SYMPTOM', metadata: { sehat_saathi_patient_id: patient.id } }, 'deadbeef'), 401);
  assert.equal(await hook({ id: 'call_1', status: 'completed', outcome: 'SYMPTOM', summary: 'Patient said saans nahi aa rahi since morning', metadata: { sehat_saathi_patient_id: patient.id } }), 200);
  await wait(500);
  const { rows: vflags } = await pool.query(`SELECT priority, flag_type FROM flags WHERE patient_id=$1 AND flag_type='symptom_reported' ORDER BY created_at DESC`, [patient.id]);
  assert.equal(vflags[0].priority, 'urgent');
  const before = sent.length;
  assert.equal(await hook({ id: 'call_2', status: 'no-answer', metadata: { sehat_saathi_patient_id: patient.id } }), 200);
  await wait(500);
  assert.ok(sent.length > before && sent[sent.length - 1].to === patientPhone, 'unanswered call → WhatsApp check-in via Loopdesk');
  await call('POST', '/api/hub/provision', { token: hubToken(BIZ, 'provision'), body: provisionBody({ tools: ['SEHAT_SAATHI'] }) });
  require('../src/services/hub.service').clearHubCache();
  assert.equal(await voice.canCall(clinicId), false);
  ok('WayneRing: Punjabi check-in call; signed result only; "saans nahi aa rahi" → URGENT; no answer → WhatsApp; WayneRing removed → no calls');

  // ---------- billing stays in Loopdesk ----------
  const { rows: [plan] } = await pool.query(
    `INSERT INTO plans (name, price_monthly_inr) VALUES ($1, 1000) RETURNING id`, [`Test plan ${run}`]);
  const seed = require('child_process').spawnSync('node', ['scripts/seed-super-admin.js'], { env: process.env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const sa = await call('POST', '/api/auth/login', { body: { phone: process.env.SUPER_ADMIN_PHONE, password: process.env.SUPER_ADMIN_PASSWORD } });
  assert.equal(sa.status, 200, JSON.stringify(sa.json));
  const sub = await call('PUT', `/api/admin/subscriptions/${clinicId}`, { token: sa.json.token, body: { plan_id: plan?.id, status: 'active' } });
  assert.equal(sub.status, 409); assert.equal(sub.json.code, 'BILLED_IN_LOOPDESK');
  const inv = await call('POST', '/api/admin/invoices', { token: sa.json.token, body: { clinic_id: clinicId, amount_inr: 100 } });
  assert.equal(inv.status, 409);
  ok('Super Admin cannot set a plan or invoice a Loopdesk hospital (no double billing)');

  // ---------- hospitals made by hand are untouched ----------
  const { rows: [own] } = await pool.query(`INSERT INTO clinics (name, whatsapp_number, whatsapp_phone_number_id) VALUES ('Own Number Clinic', $1, $2) RETURNING id`, [`91${run.slice(-8)}00`, `pn_${run}`]);
  assert.equal(await require('../src/services/hub.service').hubWhatsAppRoute(own.id), null);
  assert.equal(await voice.allowedForClinic(own.id), true);
  ok('hospitals not from Loopdesk keep their own WhatsApp number and voice');

  // The Meta webhook (own-number hospitals) still works after the refactor, and catches Punjabi.
  const ownPatientPhone = `91${String(Date.now() + 7).slice(-10)}`;
  const { rows: [op] } = await pool.query(
    `INSERT INTO patients (clinic_id, name, phone, language_pref, consent_given) VALUES ($1,'Gurpreet',$2,'pa',true) RETURNING id`, [own.id, ownPatientPhone]);
  const wh = await call('POST', '/api/whatsapp/webhook', { body: { entry: [{ changes: [{ value: {
    metadata: { phone_number_id: `pn_${run}` },
    messages: [{ from: ownPatientPhone, id: `wamid.own.${run}`, type: 'text', text: { body: 'ਮੇਰੀ ਛਾਤੀ ਵਿੱਚ ਦਰਦ ਹੈ' } }],
  } }] }] } });
  assert.equal(wh.status, 200);
  await wait(800);
  const { rows: ownFlags } = await pool.query('SELECT priority FROM flags WHERE patient_id=$1', [op.id]);
  assert.equal(ownFlags.length, 1); assert.equal(ownFlags[0].priority, 'urgent');
  assert.ok(!sent.some((m) => m.to === ownPatientPhone), 'own-number hospital never goes through Loopdesk');
  ok('Meta webhook still works for own-number hospitals; Gurmukhi "ਛਾਤੀ ਵਿੱਚ ਦਰਦ" → URGENT');

  console.log(`\nAll ${passed} checks passed.`);
  server.close(); fakeHub.close(); await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
