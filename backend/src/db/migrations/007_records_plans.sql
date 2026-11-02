-- Patient-records plans + Super Admin never sees patient data.
-- Idempotent; mirrored at the end of schema.sql.
-- Usage: psql $DATABASE_URL -f src/db/migrations/007_records_plans.sql

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
