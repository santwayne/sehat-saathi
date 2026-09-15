-- Migration: Multi-hospital Super Admin (SUPER_ADMIN_BUILD_SPEC.md) +
-- QR self-enrollment / auto doctor identification (QR_SELF_ENROLLMENT_BUILD_SPEC.md)
--
-- Safe to run against an existing production database that was created from
-- an earlier version of schema.sql. schema.sql itself has already been
-- updated to include all of this for brand-new installs — run this file
-- only against a database that predates that change.
--
-- Usage: psql $DATABASE_URL -f src/db/migrations/002_multi_hospital_and_qr_enrollment.sql

-- staff_users.clinic_id is already nullable — a super_admin row simply has
-- clinic_id = NULL, no migration needed for that column. role is free-text
-- VARCHAR(50), so 'super_admin' is usable immediately, no migration needed.

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'onboarding'));
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id VARCHAR(50) UNIQUE;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT;

ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) NOT NULL DEFAULT 'prescription' CHECK (document_type IN ('prescription', 'lab_report', 'other'));

-- Widen the flags CHECK constraint to allow the new doctor-matching flag types.
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_flag_type_check;
ALTER TABLE flags ADD CONSTRAINT flags_flag_type_check CHECK (flag_type IN ('missed_dose', 'symptom_reported', 'unanswerable_question', 'no_show_risk', 'ocr_low_confidence', 'doctor_match_failed', 'doctor_match_conflict'));

CREATE TABLE IF NOT EXISTS doctor_match_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  source VARCHAR(10) CHECK (source IN ('ocr', 'voice')),
  raw_input TEXT NOT NULL,
  matched_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  match_confidence VARCHAR(10),
  staff_corrected_to UUID REFERENCES doctors(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_enrollments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  phone VARCHAR(20) NOT NULL,
  stage VARCHAR(30) NOT NULL DEFAULT 'awaiting_name',
  name VARCHAR(255),
  language_pref VARCHAR(5),
  consent_given BOOLEAN DEFAULT false,
  candidate_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  candidate_match_log_id UUID REFERENCES doctor_match_log(id) ON DELETE SET NULL,
  candidate_document_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (clinic_id, phone)
);

CREATE TABLE IF NOT EXISTS doctor_aliases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  learned_from VARCHAR(20) CHECK (learned_from IN ('staff_correction', 'confirmed_match')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (doctor_id, alias)
);

-- Backfill: every existing clinic already has exactly one WhatsApp number in
-- the deployment's env vars today. Point its whatsapp_phone_number_id /
-- whatsapp_access_token at that same global number so multi-tenant routing
-- (whatsapp.service.js, whatsapp.routes.js) keeps working for the existing
-- clinic without a manual data-entry step. Run this manually after the
-- migration, once per environment, with the deployment's real values:
--
-- UPDATE clinics SET whatsapp_phone_number_id = '<WHATSAPP_PHONE_NUMBER_ID from env>',
--                     whatsapp_access_token = '<WHATSAPP_ACCESS_TOKEN from env>'
-- WHERE whatsapp_phone_number_id IS NULL;
