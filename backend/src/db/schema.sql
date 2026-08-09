-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Clinics Table
CREATE TABLE clinics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  address TEXT,
  whatsapp_number VARCHAR(20) UNIQUE NOT NULL,
  voice_number VARCHAR(20),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Staff Users
CREATE TABLE staff_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL, -- 'admin', 'coordinator', 'nurse', 'doctor'
  phone VARCHAR(20) NOT NULL,
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
CREATE TABLE prescriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
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
  flag_type VARCHAR(50) CHECK (flag_type IN ('missed_dose', 'symptom_reported', 'unanswerable_question', 'no_show_risk', 'ocr_low_confidence')),
  priority VARCHAR(10) CHECK (priority IN ('normal', 'urgent')),
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved')),
  assigned_to UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP WITH TIME ZONE
);
