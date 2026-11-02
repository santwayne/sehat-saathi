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
| `GET/POST /api/patients/:id/family-members`, `DELETE .../:memberId` | Family accounts: staff adds a member, they opt in by replying YES (see Section 7) |
| `POST/DELETE /api/patients/:id/abha` | Staff-recorded ABHA number/address, consent required (not verified with ABDM yet) |
| `GET/POST /api/beds`, `DELETE /api/beds/:id` | Per-bed QR codes (admin/super_admin write) |
| `GET/POST/DELETE /api/pharmacy-partners`, `GET/PATCH /api/refill-orders` | Pharmacy partner + refill-reminder queue |
| `GET /api/cron/family-digest`, `GET /api/cron/refill-reminders` | Vercel Cron only, `CRON_SECRET`-protected |
| `PATCH /api/flags/:id/resolve-doctor-match` | Staff corrects a `doctor_match_conflict` flag; feeds the correction back into the alias-learning loop |

## 6. Multi-hospital (Super Admin) + QR self-enrollment

Built per `SUPER_ADMIN_BUILD_SPEC.md` and `QR_SELF_ENROLLMENT_BUILD_SPEC.md` (see repo root docs handed over alongside this codebase). Summary:

- **One deployment, many hospitals.** Each `clinics` row can carry its own WhatsApp Business number (`whatsapp_phone_number_id` + `whatsapp_access_token`); the inbound webhook resolves which hospital a message belongs to from Meta's `phone_number_id` *before* looking up the patient. A clinic with no credentials of its own falls back to the deployment's global `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` env vars (single-clinic/local-dev mode).
- **`super_admin` role** (`staff_users.clinic_id = NULL`) sees and manages every clinic via `/api/clinics`. Bootstrap the first one with `npm run seed:super-admin` (reads `SUPER_ADMIN_PHONE`/`SUPER_ADMIN_PASSWORD`), then log in and use the "Hospitals" console to onboard the rest — each one gets its own first admin account created in the same step.
- **QR self-enrollment.** An inbound WhatsApp message from a phone number that isn't already an enrolled patient starts (or continues) a `pending_enrollments` conversation instead of being ignored: name → explicit consent → a photo (OCR-read, including the doctor's name off the letterhead) or a voice note (Azure Speech-to-Text) to identify the assigned doctor. A shared fuzzy-matching engine (`doctor-match.service.js`) checks a per-clinic `doctor_aliases` table before falling back to string similarity, and every match/correction is logged (`doctor_match_log`) so the alias table — and therefore matching accuracy — improves the longer a given hospital uses it.
- **Known gaps** (see the handover conversation this was built from for full detail): the printable QR-code image itself isn't generated by the app yet (the deep link is just `wa.me/<clinic_whatsapp_number>` — any QR generator can encode it); Azure transcription accuracy for real Hindi/Punjabi patient audio hasn't been validated against real samples (spec Section 6.5); `GET /api/staff` and `GET /api/doctors` don't fully enforce clinic isolation for unauthenticated callers (pre-existing gap, widened risk once there's more than one clinic — see code comments in those two route files).

## 7. Roadmap build-out (family, bed QR, refills, ABHA)

Apply `src/db/migrations/003_family_beds_abha_refills.sql` to an existing database (idempotent; `schema.sql` already includes it for fresh ones).

| Roadmap item | Status |
|---|---|
| Family member updates | **Built.** Invite -> YES opt-in -> weekly digest + prescription-bounded Q&A. Family replies are never check-in responses; kill switch stays staff-only. |
| QR code at every hospital bed | **Built.** Each bed has a code; its QR opens WhatsApp with `BED-XXXXXX` prefilled, linking the patient to the bed on enrollment. Printable sheet in Settings / Hospitals. |
| Pharmacy refill reminders | **Built (catalog untested).** Parses `duration` ("10 days", "2 weeks", "5 din"), reminds ~3 days before the course ends, one reminder per prescription. If the partner pharmacy has a catalog id, also sends a WhatsApp `catalog_message` (best effort: needs the catalog connected to the clinic's WABA and the patient's 24h window; not tested against real Meta). Ordering status stays staff-managed. |
| ABHA / ABDM health record link | **ABHA creation built, untested against ABDM.** Aadhaar-OTP enrolment (`/api/patients/:id/abha/link-init` + `/verify-otp`: RSA-OAEP-encrypted Aadhaar, OTP, ABHA number stored as ABDM-verified). Off until `ABDM_CLIENT_ID/SECRET` are set; ABDM must enable v3 access on the client id. Aadhaar is never stored or logged. Manual staff recording stays as a fallback. **Care-context push (M2/HIP) is not built** — needs HFR/HPR registration and ABDM's current schema. |
| Hospital analytics on adherence | **Built.** `GET /api/analytics/adherence` + Analytics page: check-in response rate (reply within 24h), daily trend, flags by type, median time to resolve, per-doctor table. Measures engagement and flagged missed doses, not confirmed doses taken. |
| More Indian languages | **Built (needs native review).** Marathi, Gujarati, Bengali, Tamil, Telugu added (`services/i18n.js`) for check-ins, urgent escalation, forwarded-to-doctor, voice transcription locales, UI. Family/refill/enrollment messages fall back to English for these. |
| Voice check-in calls | **Built with Twilio, untested against a real account.** Patients with channel = voice get a call (`<Gather>` keypress 1/2 or speech); answers become check-in responses, missed doses raise flags, spoken symptoms go through the safety engine. No answer / busy / no input falls back to WhatsApp. Webhooks verify Twilio signatures. Off until `TWILIO_*` and `PUBLIC_BASE_URL` are set. |

WhatsApp message templates to create and get approved in Meta (business-initiated messages need them; the code falls back to plain text inside the 24h window): `family_invite` (3 params), `family_weekly_digest` (3), `refill_reminder` (3).

Migration `004_abdm_enrolment_and_voice.sql` adds the ABHA enrolment session table, `abha_verified_by_abdm` and `conversations.external_id`. See `backend/.env.example` for the ABDM and Twilio settings.

## 8. Super Admin platform console

Apply `src/db/migrations/005_super_admin_platform_console.sql` to an existing database (idempotent; `schema.sql` already includes it). Set `INTEGRATIONS_ENCRYPTION_KEY` (see `backend/.env.example`) before saving production keys from the console.

Super Admin is now a **platform operator**: it runs hospitals, money, keys and errors, and has **no access to patient data**.

| Page | What it does | API |
|---|---|---|
| Overview | Hospitals by status, MRR (active + past-due subscriptions; trials count as 0), active patients (inbound message in 30 days), collected revenue, alerts (trials ending, overdue invoices, platform errors, missing WhatsApp setup, hospitals with no plan, pending break-glass) | `GET /api/admin/overview` |
| Hospitals | Unchanged: onboard, edit, suspend, hospital QR, bed QR | `/api/clinics` |
| Plans & Billing | Plans; one subscription/trial per hospital (with optional custom price); invoices (`SS-YYYYMM-0001`, overdue is derived); payments recorded manually, auto-marking an invoice paid once covered | `/api/admin/plans`, `/subscriptions`, `/invoices`, `/payments` |
| Usage & Profit | Per hospital per month: check-in + other WhatsApp messages, AI-handled inbound messages (estimate), OCR documents, voice calls → cost via editable unit costs; revenue = payments that month; margin | `/api/admin/usage`, `/unit-costs` |
| Integrations | WhatsApp (platform default), Twilio and ABDM keys — saved AES-256-GCM encrypted, override the env var of the same name, applied without a restart; live "Test" per provider; per-hospital WhatsApp status + WABA ID; WhatsApp template status synced from Meta | `/api/admin/integrations*` |
| Platform Health | Webhook, check-in queue, OCR, WhatsApp-send, media and voice errors (`platform_events`; ids and error text only, never patient details) | `/api/admin/health*` |
| Audit Log | Every Super Admin / admin action (logins, hospital changes, billing, keys, password changes) | `/api/admin/audit` |
| Settings | Super Admin's own name/phone/email and password | `PATCH /api/auth/me`, `POST /api/auth/change-password` (any role) |

**Removed for Super Admin:** Dashboard, Patients, Prescriptions, Flags, Refills pages and the hospital switcher. Super Admin **never** has access to patient records — see section 10. (An earlier "break-glass" emergency-access feature was removed.)

## 9. Regulars integration (retention, Super Admin only)

Apply `src/db/migrations/006_regulars_integration.sql` (idempotent; `schema.sql` includes it). Needs the Regulars app to have its inbound events API (`/api/v1/events`, `/api/v1/ping` — the `regularsplatform` "Inbound events API" change).

**Setup (Super Admin → Integrations):** set the Regulars URL on the "Regulars (retention)" card → for each hospital, create a Regulars business, issue a key in Regulars → Admin → API keys, then **Connect** it here (key stored AES-256-GCM encrypted; optional Regulars location id) → **Test connection** → turn sync on → optionally **Backfill** existing patients.

**What is sent** (consenting patients only, never with the kill switch on; phone with country code, first name, dates — no diagnoses, medicines or documents):

| Sehat Saathi event | Regulars event | External id |
|---|---|---|
| Patient enrolled (staff-added or QR self-enrolment) | `CUSTOMER` | `patient:<id>` |
| Staff verify a patient's document (= a real visit) | `VISIT` (idempotent on re-verify) | `doc:<id>` |
| Kill switch turned on, or patient deleted | `OPT_OUT` (pending events for them are cancelled) | `optout:<id>` |

Events go through `regulars_outbox` and are pushed asynchronously (right away, then every 5 min on the persistent server / daily via `/api/cron/regulars-sync` on Vercel) with exponential backoff up to 10 attempts. Events Regulars rejects are marked failed with the reason (shown per hospital, retryable). Delivered rows have phone/name cleared. Failures show in Platform Health and as an Overview alert; every settings change is audited (keys are never logged or returned).

Turning the kill switch back off does **not** undo the Regulars opt-out — only the business owner can do that in Regulars.

## 10. Patient-records plans (Super Admin never sees patient records)

Apply `src/db/migrations/007_records_plans.sql` (idempotent; `schema.sql` includes it). Existing hospitals stay **with patient records**.

| | With patient records | Without patient records |
|---|---|---|
| Patient data stored | Yes | **No.** Inbound WhatsApp for the hospital gets one fixed reply ("contact the hospital directly"); no enrolment, conversation log or document is saved |
| Hospital staff access to records | Once Super Admin **approves** the hospital (Hospitals → Approve, i.e. status Active). Before that they see "waiting for approval" | None: record pages are hidden and the API refuses |
| Super Admin access to records | **Never** | **Never** |

- A plan carries `patient_records`; assigning a plan to a hospital sets `clinics.records_mode`. It can also be set on Add/Edit hospital.
- Moving a hospital that still has stored patient records to "without" is refused (409): Super Admin cannot see or delete those records, so the hospital deals with its own data first.
- Enforcement is server-side in `services/records-access.service.js` (`patientRecordsGuard` on `/api/patients`, `/api/prescriptions`, `/api/flags`, `/api/refill-orders`, `/api/analytics`); the UI only mirrors it (`records_access` on login and `/api/auth/me`). Bed occupant names, clinic flag/prescription counts and clinic summaries are not shown to Super Admin either.
- WhatsApp check-ins, document reading and reminders need stored data, so they only run for hospitals **with** patient records.

## 11. Follow-up consent + STOP

Apply `src/db/migrations/008_followup_opt_out.sql`.

- For hospitals connected to Regulars, the WhatsApp consent step now tells the patient (English + Hindi) that the hospital may contact them about follow-up visits using only phone, first name and visit dates, and that they can reply STOP anytime. Hospitals not connected to Regulars see the old text. The staff enrolment form's consent checkbox carries the same note.
- An enrolled patient replying exactly STOP / unsubscribe / band karo / mat bhejo / बंद / ਬੰਦ sets `patients.followup_opt_out`, sends `OPT_OUT` to Regulars, cancels anything still queued for them, and gets a confirmation. Treatment check-ins and reminders continue — stopping those stays a staff decision (kill switch). A sentence that merely contains "stop" is not treated as an opt-out.
- Opted-out patients are never sent to Regulars again (enrolment, verified visits, backfill).
