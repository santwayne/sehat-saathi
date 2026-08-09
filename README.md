# Sehat Saathi — Core Backend & Engine (v1.0.0-MVP)

Sehat Saathi is a WhatsApp companion system for clinics. It translates doctor prescriptions into patient-friendly daily guidance in native languages (Hindi, Punjabi, English), schedules check-ins, answers prescription-bounded questions, and auto-escalates clinical concerns to clinic staff.

Full architecture and safety rules: [Sehat_Saathi_Technical_Spec.md](../Sehat_Saathi_Technical_Spec.md)

---

## 1. Directory Structure

```text
sehat-saathi/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   ├── db/
│   │   │   ├── index.js
│   │   │   └── schema.sql
│   │   ├── routes/
│   │   │   ├── flags.routes.js
│   │   │   ├── prescriptions.routes.js
│   │   │   └── whatsapp.routes.js
│   │   ├── services/
│   │   │   ├── conversation.service.js
│   │   │   ├── escalation.service.js
│   │   │   ├── ocr.service.js
│   │   │   ├── safety.service.js
│   │   │   ├── scheduler.service.js
│   │   │   └── whatsapp.service.js
│   │   └── server.js
│   ├── .env.example
│   └── package.json
└── README.md
```

## 2. Setup

```bash
cd backend
npm install
cp .env.example .env   # fill in real credentials
psql $DATABASE_URL -f src/db/schema.sql
npm run dev
```

Requires a reachable PostgreSQL instance (`DATABASE_URL`) and Redis instance (`REDIS_URL`) for the BullMQ check-in queue.

## 3. What's enforced at the code level (not just prompted)

- **Prescription confidence gate** — OCR results are stored with `verified_by_staff = false` and never reach a patient until a staff member calls `POST /api/prescriptions/:id/verify`.
- **Banned-phrase scan** — every AI reply is checked against `safety.service.js` before sending; a hit routes to escalation instead of the patient.
- **Kill switch** — `POST /api/flags/patients/:id/kill-switch` immediately blocks all outbound automation for a patient; both the check-in worker and the inbound webhook check it first.
- **Audit log** — every inbound and outbound patient message is written to `conversations`.
- **Doctor-scoped routing** — `doctors.staff_user_id` links a doctor to their staff login so flags route to the correct doctor's queue, with stale-flag fallback to the coordinator queue after 2h (urgent) / 24h (normal).
