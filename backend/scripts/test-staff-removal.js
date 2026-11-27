// End-to-end test: removing staff (deactivate login + retire doctor record,
// patients reassigned or left unassigned) and trimmed names / phones.
// Needs a database created from src/db/schema.sql (+ migration 010).
//   DATABASE_URL=postgres://… node scripts/test-staff-removal.js
const assert = require('assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

(async () => {
  const app = require('../src/app');
  const { pool } = require('../src/db');
  const { hashPassword } = require('../src/services/auth.service');
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
  const ph = (i) => `98${n}${i}`;

  console.log('Sehat Saathi — staff removal');
  const [clinic] = await q(`INSERT INTO clinics (name, whatsapp_number, status) VALUES ('Test Hospital', $1, 'active') RETURNING id`, [`91${ph(0)}`]);
  await q(`INSERT INTO staff_users (clinic_id, name, role, phone, password_hash) VALUES ($1, 'Admin One', 'admin', $2, $3)`, [clinic.id, ph(1), await hashPassword('Admin@12345')]);
  const login = async (phone, password) => call('POST', '/api/auth/login', { body: { phone, password } });
  const A = (await must(login(ph(1), 'Admin@12345'))).token;

  // ---------- trimmed name / phone; doctor record made with the login ----------
  const add = await must(call('POST', '/api/staff', { token: A, body: { clinic_id: clinic.id, name: '  dr   priya ', role: 'doctor', phone: ` ${ph(2)} `, password: 'Priya@12345', specialty: ' Cardiology ' } }), 201);
  assert.equal(add.data.name, 'dr priya'); assert.equal(add.data.phone, `91${ph(2)}`); // saved in the one canonical format (migration 011)
  assert.ok(add.doctor); assert.equal(add.doctor.name, 'dr priya'); assert.equal(add.doctor.specialty, 'Cardiology'); assert.equal(add.doctor.staff_user_id, add.data.id);
  const priya = add.data; const priyaDoc = add.doctor;
  const dr2 = await must(call('POST', '/api/staff', { token: A, body: { clinic_id: clinic.id, name: 'Dr Arjun', role: 'doctor', phone: ph(3), password: 'Arjun@12345' } }), 201);
  ok('name + phone are trimmed; role Doctor creates login + doctor record in one call');

  // patients for Priya
  const pts = [];
  for (let i = 4; i <= 6; i++) {
    const p = await must(call('POST', '/api/patients', { token: A, body: { clinic_id: clinic.id, name: ` Patient  ${i} `, phone: `91${ph(i)}`, assigned_doctor_id: priyaDoc.id, consent_given: true } }), 201);
    pts.push(p.data || p.patient || p);
  }
  const [p0] = await q('SELECT name FROM patients WHERE phone = $1', [`91${ph(4)}`]);
  assert.equal(p0.name, 'Patient 4');
  await q(`INSERT INTO flags (patient_id, flag_type, priority, status, assigned_to) SELECT id, 'symptom_reported', 'urgent', 'open', $1 FROM patients WHERE phone = $2`, [priya.id, `91${ph(4)}`]);
  const P = (await must(login(ph(2), 'Priya@12345'))).token;
  await must(call('GET', '/api/auth/me', { token: P }));
  ok('patient names are trimmed too');

  // ---------- preview ----------
  const pre = (await must(call('GET', `/api/staff/${priya.id}/removal`, { token: A }))).data;
  assert.equal(pre.patient_count, 3); assert.equal(pre.doctors.length, 1);
  assert.deepEqual(pre.reassign_options.map((d) => d.name), ['Dr Arjun']);
  ok('Remove preview: linked doctor record, 3 patients, who can take over');

  // ---------- guards ----------
  const [adminRow] = await q('SELECT id FROM staff_users WHERE phone = $1', [ph(1)]);
  assert.equal((await call('DELETE', `/api/staff/${adminRow.id}`, { token: A })).status, 400); // self
  assert.equal((await call('DELETE', `/api/staff/${priya.id}?reassign_to=${priyaDoc.id}`, { token: A })).status, 400); // to herself
  assert.equal((await call('DELETE', `/api/staff/${priya.id}`, { token: P })).status, 403); // not an admin
  ok('cannot remove yourself, reassign to the doctor being removed, or remove as non-admin');

  // ---------- remove with reassignment ----------
  const rm = (await must(call('DELETE', `/api/staff/${priya.id}?reassign_to=${dr2.doctor.id}`, { token: A }))).data;
  assert.equal(rm.patients_moved, 3); assert.equal(rm.patients_assigned_to, 'Dr Arjun'); assert.deepEqual(rm.doctors_removed, ['dr priya']); assert.equal(rm.open_flags_moved, 1);
  const [srow] = await q('SELECT deactivated_at, notify_on_flag FROM staff_users WHERE id = $1', [priya.id]);
  assert.ok(srow.deactivated_at); assert.equal(srow.notify_on_flag, false);
  const [drow] = await q('SELECT removed_at FROM doctors WHERE id = $1', [priyaDoc.id]);
  assert.ok(drow.removed_at);
  assert.equal((await q('SELECT count(*)::int AS n FROM patients WHERE assigned_doctor_id = $1', [dr2.doctor.id]))[0].n, 3);
  assert.equal((await q('SELECT assigned_to FROM flags WHERE assigned_to = $1', [dr2.data.id])).length, 1);
  ok('Remove: login deactivated, doctor record retired, patients + open flag moved to Dr Arjun');

  // ---------- removed person cannot use the app ----------
  const l2 = await login(ph(2), 'Priya@12345');
  assert.equal(l2.status, 403); assert.match(l2.json.error, /deactivated/);
  const oldTok = await call('GET', '/api/staff', { token: P });
  assert.equal(oldTok.status, 401); assert.match(oldTok.json.error, /deactivated/);
  const staffList = (await must(call('GET', `/api/staff?clinic_id=${clinic.id}`, { token: A }))).data;
  assert.ok(!staffList.some((s) => s.id === priya.id));
  const docList = (await must(call('GET', `/api/doctors?clinic_id=${clinic.id}`, { token: A }))).data;
  assert.deepEqual(docList.map((d) => d.name), ['Dr Arjun']);
  const audit = await q("SELECT action FROM audit_log WHERE action = 'staff.deactivate' AND target_id = $1", [priya.id]);
  assert.equal(audit.length, 1);
  ok('removed login cannot sign in, old token refused, gone from Staff + Doctors lists, audit log row kept');

  // ---------- Doctors-list delete also deactivates the login; unassigned option ----------
  const rm2 = (await must(call('DELETE', `/api/doctors/${dr2.doctor.id}`, { token: A }))).data;
  assert.equal(rm2.patients_moved, 3); assert.equal(rm2.patients_assigned_to, null);
  assert.equal((await login(ph(3), 'Arjun@12345')).status, 403);
  assert.equal((await q('SELECT count(*)::int AS n FROM patients WHERE clinic_id = $1 AND assigned_doctor_id IS NULL', [clinic.id]))[0].n, 3);
  ok('deleting from the Doctors list deactivates the linked login too; "leave unassigned" works');

  // ---------- re-adding a removed person brings the account back ----------
  const back = await must(call('POST', '/api/staff', { token: A, body: { clinic_id: clinic.id, name: 'Dr Priya Mehta', role: 'doctor', phone: ph(2), password: 'NewPass@123' } }), 200);
  assert.equal(back.reactivated, true); assert.equal(back.data.id, priya.id); assert.equal(back.doctor.id, priyaDoc.id);
  assert.equal((await login(ph(2), 'NewPass@123')).status, 200);
  ok('adding the same phone again reactivates the same login + doctor record (history stays linked)');

  // ---------- other roles ----------
  const last = await call('POST', '/api/staff', { token: A, body: { clinic_id: clinic.id, name: 'Nurse', role: 'nurse', phone: ph(7), password: 'Nurse@12345' } });
  assert.equal(last.status, 201);
  ok('other roles still added normally');

  console.log(`\nAll ${passed} staff-removal checks passed.`);
  server.close(); await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
