-- 010: Remove staff properly (deactivate, don't delete) + trimmed names.
-- Idempotent. Apply: psql $DATABASE_URL -f src/db/migrations/010_staff_removal.sql
--
-- Before this, "Add staff member" with role Doctor made two rows (a staff_users
-- login and a doctors record), but the only delete removed the doctors row: the
-- login stayed and could still sign in. Now "Remove" deactivates the login and
-- retires the doctor record together. Rows are kept so the audit log and old
-- prescriptions / flags still point at a real person.

ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP WITH TIME ZONE;
CREATE INDEX IF NOT EXISTS doctors_staff_user_active_idx ON doctors (staff_user_id) WHERE removed_at IS NULL;

-- Names were saved untrimmed ("dr priya "). Tidy them: trim + single spaces.
UPDATE staff_users SET name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
 WHERE name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));
UPDATE doctors SET name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
 WHERE name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));
-- Phones: trim spaces (skip a row whose trimmed phone already belongs to someone else).
UPDATE staff_users s SET phone = btrim(s.phone)
 WHERE s.phone <> btrim(s.phone)
   AND NOT EXISTS (SELECT 1 FROM staff_users o WHERE o.phone = btrim(s.phone) AND o.id <> s.id);
