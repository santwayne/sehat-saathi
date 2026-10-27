-- ABHA creation via ABDM (Aadhaar OTP) and Twilio voice check-ins.
-- Idempotent; mirrored in schema.sql.
-- Usage: psql $DATABASE_URL -f src/db/migrations/004_abdm_enrolment_and_voice.sql

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
