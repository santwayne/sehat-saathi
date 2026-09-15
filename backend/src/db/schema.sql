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
  channel VARCHAR(10) CHECK (channel IN ('whatsapp', 'voice')),
  direction VARCHAR(10) CHECK (direction IN ('inbound', 'outbound')),
  message_text TEXT NOT NULL,
  intent_type VARCHAR(50), -- 'checkin_response', 'question', 'symptom_report', 'other'
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP WITH TIME ZONE
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

-- Doctor Match Log Table (QR self-enrollment spec, Section 8.1)
-- Every automatic doctor-match attempt (from OCR or voice) and every staff
-- correction of one gets logged here — the audit trail the alias table above
-- is built from.
CREATE TABLE doctor_match_log (
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
