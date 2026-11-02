-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Clinics Table
CREATE TABLE clinics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  address TEXT,
  whatsapp_number VARCHAR(20) UNIQUE NOT NULL,
  voice_number VARCHAR(20),
  -- Multi-hospital support (Super Admin Part A/B): status lets a super admin
  -- suspend a hospital without deleting its data; whatsapp_phone_number_id is
  -- Meta's numeric ID (distinct from the human-readable whatsapp_number) and
  -- is how the inbound webhook resolves which clinic a message belongs to;
  -- whatsapp_access_token is that clinic's own WABA access token, since a
  -- single global token stops working once there's more than one WABA number.
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'onboarding')),
  whatsapp_phone_number_id VARCHAR(50) UNIQUE,
  whatsapp_access_token TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Staff Users
CREATE TABLE staff_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL, -- 'admin', 'coordinator', 'nurse', 'doctor'
  phone VARCHAR(20) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  notify_on_flag BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Doctors Table
-- staff_user_id links a doctor to their login/notification identity in staff_users,
-- so flags can be routed to the exact doctor assigned to a patient (Section 5).
CREATE TABLE doctors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  staff_user_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  specialty VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Patients Table
CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  assigned_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  language_pref VARCHAR(5) DEFAULT 'hi', -- 'pa', 'hi', 'en'
  preferred_channel VARCHAR(10) DEFAULT 'whatsapp', -- 'whatsapp', 'voice'
  consent_given BOOLEAN DEFAULT false,
  kill_switch_active BOOLEAN DEFAULT false, -- Section 6.3 Kill Switch
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Prescriptions Table
-- Doubles as the general "clinical documents" table (QR self-enrollment spec,
-- Section 5.2) — document_type distinguishes a prescription from a lab report
-- or other document so both can share the same OCR/verification/audit trail
-- without a second table.
CREATE TABLE prescriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  document_type VARCHAR(20) NOT NULL DEFAULT 'prescription' CHECK (document_type IN ('prescription', 'lab_report', 'other')),
  image_url TEXT NOT NULL,
  ocr_raw_text TEXT,
  structured_json JSONB,
  ocr_confidence VARCHAR(10) CHECK (ocr_confidence IN ('high', 'medium', 'low')),
  verified_by_staff BOOLEAN DEFAULT false,
  verified_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Checkin Schedules Table
-- UNIQUE(patient_id, prescription_id) lets prescription verification upsert the
-- schedule instead of creating a duplicate active schedule on every re-verify.
CREATE TABLE checkin_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  prescription_id UUID REFERENCES prescriptions(id) ON DELETE CASCADE,
  frequency_days INTEGER NOT NULL DEFAULT 1,
  channel_pref VARCHAR(10) DEFAULT 'whatsapp',
  next_checkin_at TIMESTAMP WITH TIME ZONE NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (patient_id, prescription_id)
);

-- Conversations Table
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  -- Set alongside patient_id IS NULL for messages exchanged during QR
  -- self-enrollment (Section 4), before the patients row exists — completing
  -- enrollment retroactively attaches these rows to the new patient_id
  -- (see enrollment.service.js's completeEnrollment), so the full
  -- name/consent/doctor-signal exchange still shows up in that patient's
  -- Conversation History rather than being lost.
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  context_phone VARCHAR(20),
  channel VARCHAR(10) CHECK (channel IN ('whatsapp', 'voice')),
  direction VARCHAR(10) CHECK (direction IN ('inbound', 'outbound')),
  message_text TEXT NOT NULL,
  intent_type VARCHAR(50), -- 'checkin_response', 'question', 'symptom_report', 'enrollment', 'other'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Flags / Escalation Table
CREATE TABLE flags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  flag_type VARCHAR(50) CHECK (flag_type IN ('missed_dose', 'symptom_reported', 'unanswerable_question', 'no_show_risk', 'ocr_low_confidence', 'doctor_match_failed', 'doctor_match_conflict')),
  priority VARCHAR(10) CHECK (priority IN ('normal', 'urgent')),
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved')),
  assigned_to UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  -- A 'doctor_match_failed' flag raised during QR self-enrollment (Section
  -- 6.4) has no patient yet — clinic_id + context_phone are how staff find
  -- their way back to the pending_enrollments row to resolve it (see
  -- POST /api/flags/:id/resolve-enrollment). NULL for every other flag type,
  -- which always has patient_id set instead.
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  context_phone VARCHAR(20),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP WITH TIME ZONE
);

-- Doctor Match Log Table (QR self-enrollment spec, Section 8.1)
-- Every automatic doctor-match attempt (from OCR or voice) and every staff
-- correction of one gets logged here — the audit trail the alias table below
-- is built from. Defined before pending_enrollments since that table
-- references it.
CREATE TABLE doctor_match_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  -- Set alongside patient_id IS NULL, i.e. a match attempt made during
  -- enrollment before the patients row exists — lets a later
  -- resolve-enrollment call find the right pending_enrollments row.
  context_phone VARCHAR(20),
  source VARCHAR(10) CHECK (source IN ('ocr', 'voice')),
  raw_input TEXT NOT NULL,
  matched_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  match_confidence VARCHAR(10),
  staff_corrected_to UUID REFERENCES doctors(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Pending Enrollments Table (QR self-enrollment spec, Section 4.1)
-- A row here is a patient who scanned the hospital QR and has started but not
-- finished self-enrolling over WhatsApp. Deliberately separate from `patients`
-- — nothing is inserted into `patients` until a name is captured AND consent
-- is explicit, so every existing assumption elsewhere in the codebase ("a
-- patients row means a consenting, enrolled patient") keeps holding.
CREATE TABLE pending_enrollments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  phone VARCHAR(20) NOT NULL,
  stage VARCHAR(30) NOT NULL DEFAULT 'awaiting_name',
    -- 'awaiting_name' -> 'awaiting_consent' -> 'awaiting_doctor_signal' -> 'complete'
  name VARCHAR(255),
  language_pref VARCHAR(5),
  consent_given BOOLEAN DEFAULT false,
  -- Set while stage = 'awaiting_doctor_signal' and the matching engine found a
  -- low-confidence best guess that needs a Yes/No confirmation from the
  -- patient before it's trusted (Section 6.4). Not part of the spec's literal
  -- stage list, but needed to track which doctor a pending "is that right?"
  -- reply refers to, and which doctor_match_log row to attach the outcome to.
  candidate_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  candidate_match_log_id UUID REFERENCES doctor_match_log(id) ON DELETE SET NULL,
  -- A prescription/report photo sent before the doctor match is confirmed is
  -- saved immediately with patient_id NULL (allowed — see prescriptions
  -- table above) so it isn't lost; this points at that row so it can be
  -- attached to the patient once enrollment completes, even if completion
  -- happens later via a text Yes/No reply rather than the image itself.
  candidate_document_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (clinic_id, phone)
);

-- Doctor Aliases Table (QR self-enrollment spec, Section 8.2)
-- Per-clinic dictionary of nicknames/mispronunciations/informal titles that
-- have already been confirmed to mean a given doctor. The matching engine
-- checks this table BEFORE falling back to generic fuzzy matching — this is
-- the mechanism by which doctor-matching accuracy at a given hospital
-- improves the longer the product runs there.
CREATE TABLE doctor_aliases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  learned_from VARCHAR(20) CHECK (learned_from IN ('staff_correction', 'confirmed_match')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (doctor_id, alias)
);

-- Pilot Requests Table (public marketing site "Request a Pilot" form submissions)
CREATE TABLE pilot_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_name VARCHAR(255) NOT NULL,
  clinic_name VARCHAR(255) NOT NULL,
  contact_info VARCHAR(255) NOT NULL, -- phone or email, free text
  patient_volume_estimate VARCHAR(100),
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Roadmap build-out (same as migrations/003): family, beds, ABHA, refills
-- ============================================================
-- 1. Family accounts -------------------------------------------------------
CREATE TABLE IF NOT EXISTS family_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  name VARCHAR(255),
  phone VARCHAR(20) NOT NULL,
  relationship VARCHAR(50),
  status VARCHAR(20) DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'opted_out')),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  opted_in_at TIMESTAMP WITH TIME ZONE,
  last_digest_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (patient_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_family_members_phone ON family_members (phone);

-- NULL (all pre-existing rows) is treated as 'patient'.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sender_type VARCHAR(10)
  CHECK (sender_type IN ('patient', 'family'));

-- 2. Per-bed QR codes ------------------------------------------------------
CREATE TABLE IF NOT EXISTS beds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  label VARCHAR(50) NOT NULL,
  ward VARCHAR(100),
  code VARCHAR(16) UNIQUE NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (clinic_id, label)
);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS bed_id UUID REFERENCES beds(id) ON DELETE SET NULL;
ALTER TABLE pending_enrollments ADD COLUMN IF NOT EXISTS bed_id UUID REFERENCES beds(id) ON DELETE SET NULL;

-- 3. ABHA / ABDM (staff-recorded link; no live ABDM API calls yet) ---------
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_address VARCHAR(255);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_number VARCHAR(20);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_linked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abdm_consent_artefact_id VARCHAR(255);
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS hfr_id VARCHAR(50);
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS hpr_id VARCHAR(50);

-- 4. Pharmacy refill reminders ---------------------------------------------
CREATE TABLE IF NOT EXISTS pharmacy_partners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  whatsapp_catalog_id VARCHAR(100),
  whatsapp_business_phone VARCHAR(20),
  address TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refill_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prescription_id UUID REFERENCES prescriptions(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  pharmacy_partner_id UUID REFERENCES pharmacy_partners(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'flagged' CHECK (status IN ('flagged', 'offered', 'ordered', 'fulfilled', 'cancelled')),
  due_date DATE,
  medicine_names TEXT,
  reminded_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  -- One reminder per prescription: the scanner is re-run daily and must not
  -- re-nag the patient about the same course.
  UNIQUE (prescription_id)
);

-- Same as migrations/004: ABDM enrolment + voice
-- 1. In-flight ABHA enrolment: serverless-safe store for ABDM's transaction id
--    between "send OTP" and "verify OTP". Deliberately holds no Aadhaar number.
CREATE TABLE IF NOT EXISTS abha_enrolment_sessions (
  patient_id UUID PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  txn_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
-- true only when the number came back from ABDM itself (vs. typed in by staff).
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_verified_by_abdm BOOLEAN DEFAULT false;

-- 2. Voice check-ins: 'voice' conversations already exist in the channel CHECK;
--    nothing to alter. Twilio call ids are kept for status callbacks.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS external_id VARCHAR(64);

-- Same as migrations/005: Super Admin platform console
-- Profile field for Settings (super admin and hospital staff alike).
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- WhatsApp Business Account id: needed to read message-template status from Meta.
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS whatsapp_waba_id VARCHAR(50);

-- 1. Plans & billing --------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) UNIQUE NOT NULL,
  price_monthly_inr NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price_monthly_inr >= 0),
  patient_limit INTEGER CHECK (patient_limit IS NULL OR patient_limit > 0),
  features TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- One subscription row per hospital (current state; history lives in audit_log).
CREATE TABLE IF NOT EXISTS clinic_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID UNIQUE NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'past_due', 'cancelled')),
  -- Negotiated price for this hospital; NULL = the plan's list price.
  price_override_inr NUMERIC(12, 2) CHECK (price_override_inr IS NULL OR price_override_inr >= 0),
  trial_ends_at TIMESTAMP WITH TIME ZONE,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  invoice_number VARCHAR(40) UNIQUE NOT NULL,
  amount_inr NUMERIC(12, 2) NOT NULL CHECK (amount_inr >= 0),
  period_start DATE,
  period_end DATE,
  due_date DATE,
  -- 'overdue' is not stored: it is derived (status = 'sent' AND due_date < today).
  status VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  notes TEXT,
  paid_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoices_clinic ON invoices (clinic_id);

-- Payments are recorded manually for now (bank transfer / UPI / cheque); no gateway yet.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_inr NUMERIC(12, 2) NOT NULL CHECK (amount_inr > 0),
  method VARCHAR(30),
  reference VARCHAR(255),
  paid_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_clinic_paid_at ON payments (clinic_id, paid_at);

-- 2. Platform settings (unit costs for Usage & Profit, etc.) -----------------
CREATE TABLE IF NOT EXISTS platform_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Integrations -----------------------------------------------------------
-- Platform-wide third-party keys set from the Super Admin console. Values are
-- AES-256-GCM encrypted (see services/crypto.service.js); a row here overrides
-- the env var of the same name. Per-hospital WhatsApp credentials stay on clinics.
CREATE TABLE IF NOT EXISTS integration_settings (
  key VARCHAR(100) PRIMARY KEY,
  value_encrypted TEXT NOT NULL,
  updated_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Last-synced copy of Meta's message-template list. scope = 'global' for the
-- env/platform WABA, or a clinic id for a hospital's own WABA.
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scope VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  language VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  status VARCHAR(30) NOT NULL,
  rejected_reason TEXT,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scope, name, language)
);

-- 4. Platform health --------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source VARCHAR(30) NOT NULL CHECK (source IN ('webhook', 'queue', 'ocr', 'whatsapp_send', 'voice', 'media', 'integration', 'other')),
  severity VARCHAR(10) NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
  clinic_id UUID REFERENCES clinics(id) ON DELETE SET NULL,
  -- Operational text only: never a patient name, phone or message body.
  message TEXT NOT NULL,
  details JSONB,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_platform_events_created ON platform_events (created_at DESC);

-- 5. Audit log --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  actor_name VARCHAR(255),
  actor_role VARCHAR(50),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(64),
  clinic_id UUID REFERENCES clinics(id) ON DELETE SET NULL,
  details JSONB,
  ip VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

-- 6. Break-glass access -----------------------------------------------------
-- Super Admin has no access to patient data. In an emergency they raise a
-- request for one hospital with a reason; that hospital's admin approves or
-- denies it. An approved grant is read-only and time-boxed, and every request
-- made under it is written to audit_log.
CREATE TABLE IF NOT EXISTS break_glass_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 1440),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
  decided_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at TIMESTAMP WITH TIME ZONE,
  decision_note TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_break_glass_clinic ON break_glass_requests (clinic_id, status);

-- Same as migrations/006: Regulars integration
-- One row per hospital that has been set up. Each hospital maps to one
-- Regulars business, identified by that business's API key.
CREATE TABLE IF NOT EXISTS clinic_regulars (
  clinic_id UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  api_key_encrypted TEXT,            -- AES-256-GCM, see services/crypto.service.js
  api_key_hint VARCHAR(20),          -- e.g. "rk_live_ab12cd…" to recognise the key
  location_id VARCHAR(64),           -- Regulars location; NULL = business default
  business_name VARCHAR(255),        -- from the last successful connection test
  last_tested_at TIMESTAMP WITH TIME ZONE,
  last_test_ok BOOLEAN,
  last_synced_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Outbox: events waiting to be pushed to Regulars. Written in the same
-- request that changes the patient (enrolment, verified document, opt-out)
-- and flushed asynchronously with retries, so a Regulars outage never breaks
-- or slows patient care. phone/name are cleared once an event is delivered.
CREATE TABLE IF NOT EXISTS regulars_outbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('VISIT', 'CUSTOMER', 'OPT_OUT')),
  external_id VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(255),
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  regulars_status VARCHAR(20),       -- created / updated / duplicate, as Regulars reported
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (clinic_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_regulars_outbox_due ON regulars_outbox (status, next_attempt_at);

-- Same as migrations/007: patient-records plans
-- Every hospital is on one of two record modes:
--   with_records    - patient records are stored; the hospital's staff can
--                     access them once Super Admin has approved the hospital
--                     (clinics.status = 'active').
--   without_records - no patient records are stored and nobody (hospital
--                     staff or Super Admin) can open patient pages/APIs.
-- Existing hospitals keep today's behaviour (with_records).
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS records_mode VARCHAR(20) NOT NULL DEFAULT 'with_records';
ALTER TABLE clinics DROP CONSTRAINT IF EXISTS clinics_records_mode_check;
ALTER TABLE clinics ADD CONSTRAINT clinics_records_mode_check CHECK (records_mode IN ('with_records', 'without_records'));

-- A plan decides the record mode; assigning a plan sets clinics.records_mode.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS patient_records BOOLEAN NOT NULL DEFAULT true;

-- Break-glass (Super Admin emergency access) is removed: Super Admin must never
-- access patient records. End anything pending/active; history stays for audit.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'break_glass_requests') THEN
    UPDATE break_glass_requests
       SET status = 'revoked',
           expires_at = CASE WHEN status = 'approved' THEN LEAST(expires_at, NOW()) ELSE expires_at END,
           decision_note = COALESCE(decision_note, 'Break-glass removed: Super Admin has no patient-record access')
     WHERE status IN ('pending', 'approved');
  END IF;
END $$;

-- Same as migrations/008: follow-up opt-out
-- A patient who replies STOP opts out of follow-up-visit contact (Regulars
-- win-back calls). Care messages (check-ins, reminders) are not affected;
-- stopping those stays a staff decision (kill switch).
ALTER TABLE patients ADD COLUMN IF NOT EXISTS followup_opt_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS followup_opt_out_at TIMESTAMP WITH TIME ZONE;
