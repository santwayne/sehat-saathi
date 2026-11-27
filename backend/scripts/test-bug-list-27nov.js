// End-to-end test for the 27 Nov 2026 bug list (Sehat-Saathi-Bugs-Suggestions.pdf).
// Needs a database created from src/db/schema.sql (+ migration 011).
//   DATABASE_URL=postgres://… node scripts/test-bug-list-27nov.js
const assert = require('assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.HUB_SECRET = process.env.HUB_SECRET || crypto.randomBytes(32).toString('hex');
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

const hubToken = (sub, purpose) => jwt.sign({ purpose, jti: crypto.randomUUID() }, process.env.HUB_SECRET,
  { algorithm: 'HS256', issuer: 'regulars-hub', audience: 'sehat-saathi', subject: sub, expiresIn: '2m' });

(async () => {
  const app = require('../src/app');
  const { pool } = require('../src/db');
  const { hashPassword } = require('../src/services/auth.service');
  const { normalizePhone } = require('../src/services/phone');
  const server = app.listen(0);
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let json; try { json = JSON.parse(t); } catch { json = t; }
    return { status: r.status, json };
  };
  const must = async (p, s = 200) => { const r = await p; assert.equal(r.status, s, JSON.stringify(r.json)); return r.json; };
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  const n = String(Date.now()).slice(-7);
  const ph = (i) => `97${n}${i}`; // 10 digits
  const login = (phone, password) => call('POST', '/api/auth/login', { body: { phone, password } });

  console.log('Sehat Saathi — bug list 27 Nov 2026');
  const [clinic] = await q(`INSERT INTO clinics (name, whatsapp_number, status) VALUES ('Bug List Hospital', NULL, 'active') RETURNING id`);
  await q(`INSERT INTO staff_users (clinic_id, name, role, phone, password_hash) VALUES ($1, 'Admin', 'admin', $2, $3)`, [clinic.id, `91${ph(1)}`, await hashPassword('Admin@12345')]);

  // #3 one phone format: any typed form signs in; login answer carries the hospital name (#5/#11)
  for (const form of [ph(1), `91${ph(1)}`, `+91 ${ph(1).slice(0, 5)} ${ph(1).slice(5)}`, `0${ph(1)}`]) {
    const r = await must(login(form, 'Admin@12345'));
    assert.equal(r.staff.clinic_name, 'Bug List Hospital');
  }
  const A = (await must(login(ph(1), 'Admin@12345'))).token;
  const [{ last_login_at }] = await q('SELECT last_login_at FROM staff_users WHERE phone = $1', [`91${ph(1)}`]);
  assert.ok(last_login_at);
  assert.equal(normalizePhone('+6591234567'), '6591234567'); // explicit foreign code kept
  ok('#3 10-digit / 91 / +91 / 0-prefixed all sign in; last login recorded; hospital name in the session');

  // #1 Add doctor with login access → doctor can sign in
  const mandeep = await must(call('POST', '/api/doctors', { token: A, body: { name: 'Mandeep kaur', specialty: 'General Medicine', login: { phone: ph(2), password: 'Mandeep@123' } } }), 201);
  assert.equal(mandeep.data.staff_phone, `91${ph(2)}`); assert.ok(mandeep.data.staff_user_id);
  const M = await must(login(ph(2), 'Mandeep@123'));
  assert.equal(M.staff.role, 'doctor');
  // list-only doctor, then "Create login"
  const visiting = await must(call('POST', '/api/doctors', { token: A, body: { name: 'Dr Visiting' } }), 201);
  assert.equal(visiting.data.staff_user_id, null);
  const linked = await must(call('POST', `/api/doctors/${visiting.data.id}/login`, { token: A, body: { phone: ph(3), password: 'Visit@1234' } }), 201);
  assert.equal(linked.data.id, visiting.data.id);
  await must(login(ph(3), 'Visit@1234'));
  const docs = (await must(call('GET', '/api/doctors', { token: A }))).data.filter((d) => d.name === 'Dr Visiting');
  assert.equal(docs.length, 1);
  ok('#1 Add doctor gives a login; "Create login" links one to an existing doctor (no second record)');

  // #12 duplicate warning, both flows
  const dup = await call('POST', '/api/doctors', { token: A, body: { name: 'mandeep  KAUR' } });
  assert.equal(dup.status, 409); assert.equal(dup.json.code, 'DUPLICATE_DOCTOR');
  const dup2 = await call('POST', '/api/staff', { token: A, body: { name: 'Mandeep Kaur', role: 'doctor', phone: ph(4), password: 'Another@123' } });
  assert.equal(dup2.status, 409); assert.equal(dup2.json.code, 'DUPLICATE_DOCTOR');
  await must(call('POST', '/api/doctors', { token: A, body: { name: 'Mandeep Kaur', allow_duplicate: true } }), 201);
  ok('#12 same doctor name warns (409 DUPLICATE_DOCTOR) from both Add doctor and Add staff; can be confirmed');

  // #2 / #8 wrong number fixed by admin; password reset; role edit honoured by an old token
  const nurse = (await must(call('POST', '/api/staff', { token: A, body: { name: 'Office', role: 'nurse', phone: '8725893692', password: 'Nurse@1234' } }), 201)).data;
  assert.equal(nurse.phone, '918725893692');
  assert.equal((await login('8725837692', 'Nurse@1234')).status, 401);
  const N0 = (await must(login('8725893692', 'Nurse@1234'))).token;
  await must(call('PATCH', `/api/staff/${nurse.id}`, { token: A, body: { phone: `+91 ${ph(5)}` } }));
  assert.equal((await login('8725893692', 'Nurse@1234')).status, 401);
  await must(login(ph(5), 'Nurse@1234'));
  const reset = await must(call('POST', `/api/staff/${nurse.id}/reset-password`, { token: A }));
  assert.match(reset.data.temporary_password, /^[A-Za-z2-9]{10}$/);
  await must(login(ph(5), reset.data.temporary_password));
  assert.equal((await login(ph(5), 'Nurse@1234')).status, 401);
  // phone already used by someone else
  assert.equal((await call('PATCH', `/api/staff/${nurse.id}`, { token: A, body: { phone: ph(2) } })).status, 409);
  // role change: the old token follows the new role
  await must(call('PATCH', `/api/staff/${nurse.id}`, { token: A, body: { role: 'admin' } }));
  await must(call('GET', '/api/staff?include_inactive=1', { token: N0 }));
  await must(call('PATCH', `/api/staff/${nurse.id}`, { token: A, body: { role: 'nurse' } }));
  assert.equal((await call('POST', `/api/staff/${nurse.id}/reset-password`, { token: N0 })).status, 403);
  // can't change own role; nurse can't edit
  assert.equal((await call('PATCH', `/api/staff/${(await must(login(ph(1), 'Admin@12345'))).staff.id}`, { token: A, body: { role: 'nurse' } })).status, 400);
  assert.equal((await call('PATCH', `/api/staff/${nurse.id}`, { token: N0, body: { name: 'x' } })).status, 403);
  ok('#2/#8 admin edits a mistyped login phone, resets a password (temp shown once), role edits apply to old tokens');

  // #8 deactivate → listed as inactive → reactivate
  await must(call('DELETE', `/api/staff/${nurse.id}`, { token: A }));
  assert.equal((await login(ph(5), reset.data.temporary_password)).status, 403);
  const all = (await must(call('GET', '/api/staff?include_inactive=1', { token: A }))).data;
  assert.ok(all.find((s) => s.id === nurse.id).deactivated_at);
  assert.ok(!(await must(call('GET', '/api/staff', { token: A }))).data.find((s) => s.id === nurse.id));
  await must(call('POST', `/api/staff/${nurse.id}/reactivate`, { token: A }));
  await must(login(ph(5), reset.data.temporary_password));
  const mStaff = M.staff.id;
  await must(call('DELETE', `/api/staff/${mStaff}`, { token: A }));
  await must(call('POST', `/api/staff/${mStaff}/reactivate`, { token: A }));
  assert.ok((await must(call('GET', '/api/doctors', { token: A }))).data.find((d) => d.staff_user_id === mStaff));
  ok('#8 Deactivate keeps the row; inactive staff listed on request and can be reactivated (doctor record returns)');

  // #4 / #10 beds: natural order, no-number message
  await must(call('POST', '/api/beds', { token: A, body: { prefix: 'wwe', from: 1, to: 11, ward: '2' } }), 201);
  const beds = await must(call('GET', '/api/beds', { token: A }));
  assert.deepEqual(beds.data.map((b) => b.label).slice(0, 3), ['wwe1', 'wwe2', 'wwe3']);
  assert.equal(beds.data.at(-1).label, 'wwe11');
  assert.ok(beds.whatsapp_missing); assert.equal(beds.data[0].link, null);
  ok('#4/#10 beds sorted 1, 2 … 11; missing WhatsApp number explained once');

  // #6 family invite: 10-digit saved with 91; undelivered invite is marked failed; resend
  const pat = await must(call('POST', '/api/patients', { token: A, body: { clinic_id: clinic.id, name: 'noor', phone: ph(6), consent_given: true } }), 201);
  const patient = pat.data || pat.patient || pat;
  const [{ phone: patPhone }] = await q('SELECT phone FROM patients WHERE id = $1', [patient.id]);
  assert.equal(patPhone, `91${ph(6)}`);
  const fam = await must(call('POST', `/api/patients/${patient.id}/family-members`, { token: A, body: { name: 'mandeep', phone: ph(7) } }), 201);
  assert.equal(fam.data.phone, `91${ph(7)}`);
  // This test clinic has no WhatsApp credentials; whether Meta rejects it or it
  // never leaves, the status must match what happened.
  assert.equal(fam.data.invite_status, fam.invite_delivered ? 'sent' : 'failed');
  const list = (await must(call('GET', `/api/patients/${patient.id}/family-members`, { token: A }))).data;
  assert.ok('invite_status' in list[0]);
  const again = await must(call('POST', `/api/patients/${patient.id}/family-members/${fam.data.id}/resend`, { token: A }));
  assert.ok(['sent', 'failed'].includes(again.data.invite_status));
  ok('#6 family phone saved as 91…; invite delivery recorded (sent / failed) and can be resent');

  // #5 Loopdesk provision: hospital's own WhatsApp number saved, name in session
  const bizId = `biz_${n}`;
  const prov = await must(call('POST', '/api/hub/provision', {
    token: hubToken(bizId, 'provision'),
    body: { hubBusinessId: bizId, active: true, business: { name: 'Wayne E Solutions' }, owner: { name: 'Owner', email: `o${n}@x.in`, phone: ph(8) },
      whatsapp: { phoneNumberId: `pn${n}`, displayNumber: `+91 ${ph(9)}` } },
  }));
  assert.equal(prov.data.whatsappNumber, `91${ph(9)}`);
  const [hc] = await q('SELECT name, whatsapp_number, hub_whatsapp_phone_number_id FROM clinics WHERE id = $1', [prov.accountId]);
  assert.deepEqual(hc, { name: 'Wayne E Solutions', whatsapp_number: `91${ph(9)}`, hub_whatsapp_phone_number_id: `pn${n}` });
  const sso = await must(call('POST', '/api/hub/sso/exchange', { body: { token: hubToken(bizId, 'sso') } }));
  assert.equal(sso.staff.clinic_name, 'Wayne E Solutions');
  const OW = sso.token;
  const hbeds = await must(call('POST', '/api/beds', { token: OW, body: { labels: ['A-1'] } }), 201);
  assert.match(hbeds.data[0].link, new RegExp(`^https://wa.me/91${ph(9)}\\?text=BED-`));
  // no number sent → a warning, nothing invented
  const biz2 = `biz2_${n}`;
  const prov2 = await must(call('POST', '/api/hub/provision', {
    token: hubToken(biz2, 'provision'),
    body: { hubBusinessId: biz2, active: true, business: { name: 'No Number Hospital' }, owner: { name: 'O2', email: `p${n}@x.in` } },
  }));
  assert.equal(prov2.data.whatsappNumber, null);
  assert.ok(prov2.data.warnings.some((w) => /WhatsApp/.test(w)));
  ok('#5 Loopdesk sends name + own WhatsApp number: saved, bed QR links work, SSO session shows the hospital name');

  server.close();
  await pool.end();
  console.log(`\nAll ${passed} bug-list checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
