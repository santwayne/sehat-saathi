-- Roadmap build-out: family accounts, per-bed QR codes, ABHA link, pharmacy refills.
-- Idempotent (IF NOT EXISTS everywhere) so it is safe to re-run, and the same
-- statements are appended to schema.sql for fresh databases.
-- Usage: psql $DATABASE_URL -f src/db/migrations/003_family_beds_abha_refills.sql

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
