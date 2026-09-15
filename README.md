# Sehat Saathi — Core Backend & Engine (v1.0.0-MVP)

Sehat Saathi is a WhatsApp companion system for clinics. It translates doctor prescriptions into patient-friendly daily guidance in native languages (Hindi, Punjabi, English), schedules check-ins, answers prescription-bounded questions, and auto-escalates clinical concerns to clinic staff.

Full architecture and safety rules: [Sehat_Saathi_Technical_Spec.md](../Sehat_Saathi_Technical_Spec.md)

---

## 1. Directory Structure

```text
sehat-saathi/
├── backend/
│   ├── api/
│   │   └── index.js          # Vercel serverless entrypoint (exports the Express app)
│   ├── src/
│   │   ├── config/
│   │   ├── db/
│   │   │   ├── index.js
│   │   │   └── schema.sql
│   │   ├── routes/
│   │   │   ├── auth.routes.js
│   │   │   ├── flags.routes.js
│   │   │   ├── prescriptions.routes.js
│   │   │   ├── patients.routes.js
│   │   │   ├── staff.routes.js
│   │   │   ├── doctors.routes.js
│   │   │   ├── clinics.routes.js
│   │   │   ├── pilot-requests.routes.js
│   │   │   ├── cron.routes.js
│   │   │   └── whatsapp.routes.js
│   │   ├── services/
│   │   │   ├── auth.service.js
│   │   │   ├── checkin-direct.service.js
│   │   │   ├── conversation.service.js
│   │   │   ├── escalation.service.js
│   │   │   ├── ocr.service.js
│   │   │   ├── safety.service.js
│   │   │   ├── scheduler.service.js
│   │   │   └── whatsapp.service.js
│   │   ├── app.js            # Express app + route mounts (no listen())
│   │   └── server.js         # Persistent-process entrypoint (AWS/Railway/EC2)
│   ├── vercel.json
│   ├── .env.example
│   └── package.json
└── README.md
```

## 2. Two deployment targets, one codebase

**AWS / Railway / EC2 (real production target)** — run `npm start` (`src/server.js`). This runs a persistent process: the BullMQ worker (`scheduler.service.js`) processes check-ins off a Redis queue, and `setInterval` drives the periodic scan + stale-flag reassignment. Needs `DATABASE_URL` and `REDIS_URL`.

**Vercel (demo/proof-of-concept only)** — deploys `api/index.js`, which exports the same Express app with no `listen()` call, per Vercel's serverless function convention. Serverless functions can't host a long-lived BullMQ worker, so there's no queue on this path: `vercel.json` configures Vercel Cron to hit `GET /api/cron/checkins` and `GET /api/cron/reassign-flags` once daily each, which run the same logic synchronously (`checkin-direct.service.js`) instead of enqueueing — Vercel's Hobby plan caps cron jobs at once/day; the AWS path still runs every 15/30 minutes via `setInterval`. Needs `DATABASE_URL`, `JWT_SECRET`, and `CRON_SECRET` (Vercel sends `CRON_SECRET` as a Bearer header automatically once set in the project's env vars) — does **not** need `REDIS_URL`.

Both paths hit the same PostgreSQL database and the same route/service code otherwise — nothing behaves differently between them except how check-ins get scheduled.

## 3. Setup (local dev)

```bash
cd backend
npm install
cp .env.example .env   # fill in real credentials
psql $DATABASE_URL -f src/db/schema.sql
npm run dev
```

Against an existing (already-deployed) database created from an older `schema.sql`, run the migration instead of recreating the schema:
```bash
psql $DATABASE_URL -f src/db/migrations/002_multi_hospital_and_qr_enrollment.sql
```
Then bootstrap the first super admin account (see Section 6):
```bash
npm run seed:super-admin
```

## 4. What's enforced at the code level (not just prompted)

- **Prescription confidence gate** — OCR results are stored with `verified_by_staff = false` and never reach a patient until a staff member calls `POST /api/prescriptions/:id/verify`.
- **Banned-phrase scan** — every AI reply is checked against `safety.service.js` before sending; a hit routes to escalation instead of the patient.
- **Kill switch** — `POST /api/flags/patients/:id/kill-switch` immediately blocks all outbound automation for a patient; both the check-in worker and the inbound webhook check it first.
- **Audit log** — every inbound and outbound patient message is written to `conversations`.
- **Doctor-scoped routing** — `doctors.staff_user_id` links a doctor to their staff login so flags route to the correct doctor's queue, with stale-flag fallback to the coordinator queue after 2h (urgent) / 24h (normal).
- **Consent-gated enrollment** — `POST /api/patients` captures `consent_given` explicitly (DPDP Act); the WhatsApp webhook ignores messages from any phone number not already enrolled.
- **Auth** — `POST /api/auth/login` issues a JWT from `staff_users.password_hash` (bcrypt). Bearer tokens are optionally attached to every request (`attachUser` middleware); a handful of admin-only writes (creating staff/doctor accounts) require it via `requireRole('admin')`. Existing list endpoints (flags/prescriptions/patients) keep their original `role`/`staff_id` query-param scoping for backward compatibility with dashboards built against that contract.

## 5. API surface

| Route | Purpose |
|---|---|
| `POST /api/auth/login`, `GET /api/auth/me` | Staff login / current profile |
| `GET/POST /api/patients`, `GET /api/patients/:id` | Roster, enrollment, detail (prescriptions + schedule + conversation history) |
| `GET/POST /api/staff` | Staff accounts (admin-only write) |
| `GET/POST /api/doctors` | Doctor records, linked to a staff login (admin-only write) |
| `GET /api/clinics/:id` | Read-only clinic info |
| `GET /api/flags`, `PATCH /api/flags/:id/resolve`, `POST /api/flags/patients/:id/kill-switch` | Escalation queue |
| `GET /api/prescriptions/pending`, `POST /api/prescriptions/:id/verify` | Manual verification queue |
| `POST /api/pilot-requests` | Public lead-capture form on the marketing site |
| `GET /api/whatsapp/webhook` (verify), `POST /api/whatsapp/webhook` | WhatsApp Business Cloud API webhook |
| `GET /api/cron/checkins`, `GET /api/cron/reassign-flags` | Vercel Cron only, `CRON_SECRET`-protected |
| `GET/POST /api/clinics`, `PATCH /api/clinics/:id`, `GET /api/clinics/:id/summary` | Hospital onboarding/management (super_admin-only, see Section 6) |
| `PATCH /api/flags/:id/resolve-doctor-match` | Staff corrects a `doctor_match_conflict` flag; feeds the correction back into the alias-learning loop |

## 6. Multi-hospital (Super Admin) + QR self-enrollment

Built per `SUPER_ADMIN_BUILD_SPEC.md` and `QR_SELF_ENROLLMENT_BUILD_SPEC.md` (see repo root docs handed over alongside this codebase). Summary:

- **One deployment, many hospitals.** Each `clinics` row can carry its own WhatsApp Business number (`whatsapp_phone_number_id` + `whatsapp_access_token`); the inbound webhook resolves which hospital a message belongs to from Meta's `phone_number_id` *before* looking up the patient. A clinic with no credentials of its own falls back to the deployment's global `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` env vars (single-clinic/local-dev mode).
- **`super_admin` role** (`staff_users.clinic_id = NULL`) sees and manages every clinic via `/api/clinics`. Bootstrap the first one with `npm run seed:super-admin` (reads `SUPER_ADMIN_PHONE`/`SUPER_ADMIN_PASSWORD`), then log in and use the "Hospitals" console to onboard the rest — each one gets its own first admin account created in the same step.
- **QR self-enrollment.** An inbound WhatsApp message from a phone number that isn't already an enrolled patient starts (or continues) a `pending_enrollments` conversation instead of being ignored: name → explicit consent → a photo (OCR-read, including the doctor's name off the letterhead) or a voice note (Azure Speech-to-Text) to identify the assigned doctor. A shared fuzzy-matching engine (`doctor-match.service.js`) checks a per-clinic `doctor_aliases` table before falling back to string similarity, and every match/correction is logged (`doctor_match_log`) so the alias table — and therefore matching accuracy — improves the longer a given hospital uses it.
- **Known gaps** (see the handover conversation this was built from for full detail): the printable QR-code image itself isn't generated by the app yet (the deep link is just `wa.me/<clinic_whatsapp_number>` — any QR generator can encode it); Azure transcription accuracy for real Hindi/Punjabi patient audio hasn't been validated against real samples (spec Section 6.5); `GET /api/staff` and `GET /api/doctors` don't fully enforce clinic isolation for unauthenticated callers (pre-existing gap, widened risk once there's more than one clinic — see code comments in those two route files).
