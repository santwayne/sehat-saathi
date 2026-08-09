# Sehat Saathi — V2 Feature Build Spec (Developer Handover)

**Purpose of this document:** the investor deck (`Sehat_Saathi_Investor_Deck.pdf`) lists 5 things as either missing or "core to V1, building now": a platform-level **Super Admin**, the **Family account & digest layer**, the **ABHA/ABDM connector**, **Pharmacy catalog integration**, and the **Passive voice signal layer**. None of these exist in the codebase yet (`santwayne/sehat-saathi`). This doc is the build spec for all five — hand it to Claude Code, Gemini, or a developer the same way `Sehat_Saathi_Technical_Spec.md` was used to build V1.

**Current state assumed:** the V1 backend (Express + Postgres) and frontend (Vite/React dashboard) described in `Sehat_Saathi_Technical_Spec.md` are already built and live (`santwayne/sehat-saathi`). Everything below is additive to that schema and codebase, not a rewrite.

**Suggested build order:** Super Admin first (it's small and everything else benefits from being testable across multiple clinics). Then Family Account & Digest (self-contained, no external dependencies). ABHA/ABDM and Pharmacy Catalog both depend on real-world partner/registration steps outside of code — start those registration processes in parallel with building the other features, since they're the long pole. Passive Voice Signal Layer depends on the voice channel (Phase 2, not yet built) existing first — don't start it before that.

---

## 1. Super Admin (platform-level role)

### The gap
Every current role (`admin`, `coordinator`, `nurse`, `doctor`) is scoped to exactly one clinic via `staff_users.clinic_id`. There's no account that sees across every clinic on the platform — needed once Sehat Saathi has more than one paying clinic (Phase 3+), for Wayne E Solutions' own ops team to monitor pilot health, debug issues, and onboard new clinics without a database console.

### Schema changes
```sql
-- staff_users.clinic_id is already nullable (no NOT NULL constraint in the existing schema) —
-- a super_admin row simply has clinic_id = NULL. No migration needed for this column.
-- Add a role check comment update only; role remains a free-text VARCHAR(50), so
-- 'super_admin' is usable immediately without a schema change.
```
No schema migration is required — the existing `staff_users` table already supports this. The only change is in application logic.

### Auth changes (`backend/src/services/auth.service.js`)
- `issueToken()` already puts `clinic_id` in the JWT payload — for a super_admin this will be `null`. No change needed there.
- Add a helper: `isSuperAdmin(req)` → `req.user?.role === 'super_admin'`.
- Extend `requireRole()` usage at call sites (see below) rather than changing the function itself.

### Route changes — every clinic-scoped GET needs a super_admin bypass
Current pattern (e.g. `patients.routes.js`, `flags.routes.js`, `staff.routes.js`, `doctors.routes.js`) scopes by resolving `clinic_id` from the querying staff member's own `clinic_id`. Add this branch to each:

```js
// Before: always scope to the caller's own clinic
// After:
if (req.user?.role === 'super_admin') {
  // no clinic filter — optionally accept ?clinic_id=<uuid> to view one clinic specifically
  if (req.query.clinic_id) { /* apply clinic_id filter */ }
} else {
  // existing staff_id-based clinic scoping, unchanged
}
```
Apply this to: `GET /api/patients`, `GET /api/flags`, `GET /api/staff`, `GET /api/doctors`, `GET /api/prescriptions/pending`.

### New routes
- `GET /api/clinics` — list all clinics. **Super admin only** (`requireRole('super_admin')`). Doesn't exist yet; only `GET /api/clinics/:id` does.
- `POST /api/clinics` — create a new clinic (onboarding). **Super admin only.**
- `GET /api/clinics/:id/summary` — aggregate counts (patients, open flags, pending prescriptions) for one clinic, for the super admin's clinic-switcher view.

### Bootstrapping the first super admin
There's no public signup — staff accounts are created via `POST /api/staff`, which itself requires an existing admin token (chicken-and-egg for the very first account). Add a one-time seed script (`backend/scripts/seed-super-admin.js`, not a route) that:
1. Reads `SUPER_ADMIN_PHONE` and `SUPER_ADMIN_PASSWORD` from env vars.
2. Inserts directly into `staff_users` with `clinic_id = NULL`, `role = 'super_admin'`, bcrypt-hashed password.
3. Is safe to re-run (upsert on phone, or exit early if a super_admin already exists).

Run this once per environment (local, and again against the Vercel/Neon production DB) — same pattern already used to seed the demo clinic admin.

### Frontend changes (`frontend/src/`)
- New page `SuperAdminClinics.tsx`: lists all clinics with summary stats, links into each clinic's Dashboard/Flags/Patients views.
- `AuthContext`: `Staff.role` type needs `'super_admin'` added to the union.
- `Layout.tsx`: super_admin sees a "Clinics" nav item instead of (or in addition to) the single-clinic Settings page; needs a clinic-context switcher stored in state (which clinic's data the other pages currently show).

---

## 2. Family Account & Digest Layer

### What it does (from the deck)
One WhatsApp opt-in adds a family member to a patient's loop. They get the same plain-language prescription explanation, a weekly digest (doses taken/missed, next visit due), see the same flagged concerns, and can ask a small question on the patient's behalf — no separate app.

### Schema
```sql
CREATE TABLE family_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  name VARCHAR(255),
  phone VARCHAR(20) NOT NULL,
  relationship VARCHAR(50), -- 'spouse', 'child', 'parent', 'other' — free text is fine for v1
  status VARCHAR(20) DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'opted_out')),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  opted_in_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (patient_id, phone)
);
```
`conversations.direction` and `conversations.channel` are reused as-is; add a nullable `sender_type VARCHAR(10) CHECK (sender_type IN ('patient','family'))` column to `conversations` so the webhook and dashboard can tell who actually sent an inbound message.

### Enrollment flow
1. Staff (via a new dashboard action on the Patients detail drawer) enters a family member's name + phone → `POST /api/patients/:id/family-members` inserts a row with `status = 'invited'`.
2. Backend immediately sends a WhatsApp opt-in message to that phone via `sendWhatsAppMessage()`, in the patient's `language_pref`, explaining what they're being added to and asking for explicit consent ("Reply YES to receive updates about [patient name]'s care").
3. `whatsapp.routes.js` webhook: before the existing patient-phone lookup, first check `family_members` for the inbound phone. If found with `status = 'invited'` and the message is an affirmative reply, update to `status = 'active'`, `opted_in_at = NOW()`. If already `active`, route the message as a family question (see below).

### Family messages ≠ patient messages — keep them separate
The webhook currently does one lookup (`patients` by phone) and assumes every inbound sender is the patient. Add a branch: if the phone matches a `family_members` row instead of a `patients` row, route to a **separate handler** that:
- Calls `processInboundMessage(patient.id, text)` (same conversation engine, same prescription-scoped safety rules) but tags the resulting `conversations` row with `sender_type = 'family'`.
- **Never** treats a family member's reply as a check-in confirmation (`intent: 'checkin_response'`) — the scheduler's missed-dose tracking must only count the patient's own replies. Add a `sender_type = 'patient'` filter to the missed-dose query in `conversation.service.js`.
- **Never** lets a family member trigger or see the ability to trigger the kill switch — that stays a staff-only dashboard action.

### Weekly digest job
New function in `checkin-direct.service.js` (or a new `family-digest.service.js`): `sendWeeklyDigests()` — for each `family_members` row with `status = 'active'`, query the linked patient's check-ins and flags from the past 7 days, compose a summary message, send via `sendWhatsAppMessage()`.
- **AWS path:** add a third `setInterval` in `server.js` (weekly).
- **Vercel path:** add `GET /api/cron/family-digest` to `cron.routes.js` + a weekly entry in `vercel.json`'s `crons` array (Hobby plan allows once/day cron — a weekly job easily fits that cap, unlike the /15min one that had to be adjusted before).

### Explicitly out of scope for this doc
"Can manage or pay the subscription remotely" (deck, family journey step 4) depends on a billing/subscription system that doesn't exist yet anywhere in the codebase. Don't build billing as part of this feature — just note the family member's contact as the natural place to eventually attach billing once that system exists.

---

## 3. ABHA / ABDM Connector

### What it is
ABHA (Ayushman Bharat Health Account) is India's national patient health ID; ABDM (Ayushman Bharat Digital Mission) is the interoperability framework connecting clinics/hospitals and patient records to it. This is a real government integration, not just an API call — read this section fully before estimating it as "just another connector."

### Real-world prerequisites (do these in parallel with everything else — they're the long pole, not code)
1. **HFR (Health Facility Registry) registration** for each clinic — the clinic itself needs an HFR ID before it can participate in ABDM at all.
2. **HPR (Health Professional Registry) registration** for each doctor whose prescriptions will be linked.
3. **ABDM sandbox access** (developer credentials from the NDHM sandbox environment) to build and test against before going live.
None of this is something engineering can shortcut — flag it to whoever owns partner/clinic relationships as a parallel workstream starting now.

### Schema
```sql
ALTER TABLE patients ADD COLUMN abha_address VARCHAR(255); -- e.g. patient@abdm
ALTER TABLE patients ADD COLUMN abha_number VARCHAR(20);
ALTER TABLE patients ADD COLUMN abha_linked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE patients ADD COLUMN abdm_consent_artefact_id VARCHAR(255); -- ABDM's own consent-manager reference, separate from consent_given

ALTER TABLE clinics ADD COLUMN hfr_id VARCHAR(50);
ALTER TABLE doctors ADD COLUMN hpr_id VARCHAR(50);
```
**Important distinction:** `patients.consent_given` (existing column) is consent for *Sehat Saathi's own* automated messaging under DPDP. ABDM requires its own separate consent flow via its Consent Manager before any health record can be linked or shared — don't conflate the two, or repurpose the existing column for this.

### New service (`backend/src/services/abdm.service.js`)
Wraps ABDM's sandbox REST APIs:
- `initiateAbhaLink(patientId, aadhaarOrMobile)` — starts the ABHA verification (OTP) flow.
- `verifyAbhaOtp(patientId, otp)` — completes linking, stores `abha_address`/`abha_number` on the patient.
- `pushCareContext(prescriptionId)` — once a prescription is staff-verified, register it as a care context under the patient's ABHA record (this is what makes it visible in India's national health record system).

### New routes
- `POST /api/patients/:id/abha/link-init`
- `POST /api/patients/:id/abha/verify-otp`
- Webhook route for any async callback ABDM's consent manager sends (exact shape depends on final sandbox docs at build time — don't guess the payload shape now).

### Sequencing note
Don't start the OTP-linking flow until HFR/HPR registration (above) is actually complete for the pilot clinic — the sandbox APIs generally require a registered facility/professional context to function at all.

---

## 4. Pharmacy Catalog Integration

### What it does
When a patient is close to running out of a medicine (based on the prescription's stated `duration`), offer a WhatsApp catalog reorder from a partnered local pharmacy instead of just a text reminder.

### Real-world prerequisite
A signed partnership with at least one local pharmacy, and that pharmacy having (or Wayne E Solutions setting up on their behalf) a WhatsApp Business **Catalog** in Meta Commerce Manager. This is a business development task, not purely engineering — same caveat as ABDM.

### Schema
```sql
CREATE TABLE pharmacy_partners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  whatsapp_catalog_id VARCHAR(100),
  whatsapp_business_phone VARCHAR(20),
  address TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE refill_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prescription_id UUID REFERENCES prescriptions(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  pharmacy_partner_id UUID REFERENCES pharmacy_partners(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'flagged' CHECK (status IN ('flagged', 'offered', 'ordered', 'fulfilled', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### Trigger logic
New scheduled check (alongside the existing check-in scanner in `scheduler.service.js` / `checkin-direct.service.js`): for each active prescription, compute an estimated "medicine runs out" date from `structured_json.medicines[].duration` (parse durations like "10 days", "1 month" — these are free-text from OCR, so parsing needs to fail gracefully and just skip patients whose duration doesn't parse cleanly, not guess). When within ~3 days of that estimate, insert a `refill_orders` row with `status = 'flagged'` and send the patient a WhatsApp message with the pharmacy's catalog link.

### WhatsApp service changes (`whatsapp.service.js`)
`sendWhatsAppMessage()` currently only sends `type: 'text'`. Add a new function `sendCatalogMessage(toPhone, catalogId, productRetailerId)` using WhatsApp's `interactive` message type with `action.catalog_id` — this is a different Graph API payload shape than plain text, documented under Meta's WhatsApp Commerce/Catalog messages.

### New routes
- `GET/POST /api/pharmacy-partners` — clinic admin manages their partnered pharmacy (admin-only write, matching the `staff`/`doctors` route pattern).
- `GET /api/refill-orders?status=flagged` — staff-facing queue, same shape/pattern as the existing Flags page, could literally reuse the Flags UI component with a different data source rather than building a new page from scratch.

---

## 5. Passive Voice Signal Layer

### Hard dependency — read this first
This feature only makes sense on a **voice call**, not WhatsApp. The voice channel itself (Cartesia Sonic TTS + Deepgram STT, per the original spec's Phase 2) **is not built yet** — there is no call-handling code anywhere in the current backend. Do not start this feature before the voice channel exists; there's nothing to attach it to.

### What it does (once voice exists)
During a routine check-in call, passively flag vocal cues — breathlessness, unusually slow speech, signs of confusion — as a soft signal for staff, alongside (not instead of) the actual conversation content.

### Design approach (once Phase 2 voice is built)
- Deepgram's transcription response includes word-level timing — derive words-per-minute and pause-length distribution from that without needing a separate audio model. Start here; it's nearly free once STT exists.
- Breathlessness/confusion detection likely needs more than word timing (actual audio features — pitch variance, jitter) — this is genuine R&D, not a known-solved problem to wire up. Recommend a throwaway prototype/spike against a handful of real recorded check-in calls before committing to a specific vendor or model here, rather than designing the schema/architecture in detail now against an unvalidated approach.

### Schema (minimal, to not block on the unresolved R&D above)
```sql
ALTER TABLE flags DROP CONSTRAINT flags_flag_type_check;
ALTER TABLE flags ADD CONSTRAINT flags_flag_type_check
  CHECK (flag_type IN ('missed_dose', 'symptom_reported', 'unanswerable_question', 'no_show_risk', 'ocr_low_confidence', 'voice_signal_concern'));
```
Reuse the existing `flags` table rather than a new one — a voice signal concern is triaged by staff exactly like every other flag type already is.

### Non-negotiable safety framing
Same rule as the existing urgent-keyword system (`safety.service.js`, Section 6 of the original spec): a detected vocal cue is **a triage signal for staff, never a diagnosis**, and must never be presented to the patient as a clinical assessment. Whatever gets built here should create a `flags` row and nothing else automated — no message to the patient referencing the detected signal, ever.

---

## Summary: what to schema-migrate, in order

1. `staff_users` — no change needed (already nullable `clinic_id`).
2. `family_members` (new table) + `conversations.sender_type` (new column).
3. `patients.abha_address`, `abha_number`, `abha_linked_at`, `abdm_consent_artefact_id`; `clinics.hfr_id`; `doctors.hpr_id`.
4. `pharmacy_partners` (new table), `refill_orders` (new table).
5. `flags.flag_type` CHECK constraint — add `'voice_signal_concern'` (only once voice channel + R&D spike above are further along).
