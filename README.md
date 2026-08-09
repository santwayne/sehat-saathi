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

**Vercel (demo/proof-of-concept only)** — deploys `api/index.js`, which exports the same Express app with no `listen()` call, per Vercel's serverless function convention. Serverless functions can't host a long-lived BullMQ worker, so there's no queue on this path: `vercel.json` configures Vercel Cron to hit `GET /api/cron/checkins` every 15 minutes and `GET /api/cron/reassign-flags` every 30 minutes, which run the same logic synchronously (`checkin-direct.service.js`) instead of enqueueing. Needs `DATABASE_URL`, `JWT_SECRET`, and `CRON_SECRET` (Vercel sends `CRON_SECRET` as a Bearer header automatically once set in the project's env vars) — does **not** need `REDIS_URL`.

Both paths hit the same PostgreSQL database and the same route/service code otherwise — nothing behaves differently between them except how check-ins get scheduled.

## 3. Setup (local dev)

```bash
cd backend
npm install
cp .env.example .env   # fill in real credentials
psql $DATABASE_URL -f src/db/schema.sql
npm run dev
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
