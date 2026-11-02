-- Follow-up (Regulars) consent line + STOP opt-out.
-- Idempotent; mirrored at the end of schema.sql.
-- Usage: psql $DATABASE_URL -f src/db/migrations/008_followup_opt_out.sql

-- A patient who replies STOP opts out of follow-up-visit contact (Regulars
-- win-back calls). Care messages (check-ins, reminders) are not affected;
-- stopping those stays a staff decision (kill switch).
ALTER TABLE patients ADD COLUMN IF NOT EXISTS followup_opt_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS followup_opt_out_at TIMESTAMP WITH TIME ZONE;
