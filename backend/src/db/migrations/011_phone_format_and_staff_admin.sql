-- 011: One phone format + staff management + invite delivery (bug list 27 Nov 2026).
-- Idempotent. Apply: psql $DATABASE_URL -f src/db/migrations/011_phone_format_and_staff_admin.sql
--
-- 1. Phones: every number becomes E.164 digits without "+" ("91XXXXXXXXXX"),
--    the same form services/phone.js normalizePhone() saves from now on and
--    the form WhatsApp uses for sender ids. A row whose new value would clash
--    with another row is left as it is (and reported by the SELECTs at the end).
-- 2. staff_users.last_login_at for the staff list.
-- 3. family_members.invite_status: an invite that WhatsApp did not accept is
--    "failed", not "Waiting for YES".

CREATE OR REPLACE FUNCTION ss_normalize_phone(p TEXT) RETURNS TEXT AS $$
DECLARE d TEXT;
BEGIN
  IF p IS NULL OR p LIKE 'hub-%' THEN RETURN p; END IF;   -- Loopdesk placeholder logins stay as they are
  d := ltrim(regexp_replace(p, '\D', '', 'g'), '0');
  IF length(d) = 10 AND btrim(p) NOT LIKE '+%' AND btrim(p) NOT LIKE '00%' THEN d := '91' || d; END IF;
  IF d = '' THEN RETURN p; END IF;
  RETURN d;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- Staff logins (phone is globally unique).
UPDATE staff_users s SET phone = ss_normalize_phone(s.phone)
 WHERE s.phone <> ss_normalize_phone(s.phone)
   AND NOT EXISTS (SELECT 1 FROM staff_users o WHERE o.id <> s.id AND ss_normalize_phone(o.phone) = ss_normalize_phone(s.phone));

-- Patients (phone is globally unique).
UPDATE patients p SET phone = ss_normalize_phone(p.phone)
 WHERE p.phone <> ss_normalize_phone(p.phone)
   AND NOT EXISTS (SELECT 1 FROM patients o WHERE o.id <> p.id AND ss_normalize_phone(o.phone) = ss_normalize_phone(p.phone));

-- Family members (unique per patient).
UPDATE family_members f SET phone = ss_normalize_phone(f.phone)
 WHERE f.phone <> ss_normalize_phone(f.phone)
   AND NOT EXISTS (SELECT 1 FROM family_members o WHERE o.id <> f.id AND o.patient_id = f.patient_id
                                                  AND ss_normalize_phone(o.phone) = ss_normalize_phone(f.phone));

-- Hospital WhatsApp numbers (shown in the bed QR link).
UPDATE clinics c SET whatsapp_number = ss_normalize_phone(c.whatsapp_number)
 WHERE c.whatsapp_number IS NOT NULL AND c.whatsapp_number <> ss_normalize_phone(c.whatsapp_number)
   AND NOT EXISTS (SELECT 1 FROM clinics o WHERE o.id <> c.id AND ss_normalize_phone(o.whatsapp_number) = ss_normalize_phone(c.whatsapp_number));

-- Loopdesk hospitals: Meta's id of the hospital's own number in Loopdesk
-- (whatsapp_phone_number_id stays for hospitals whose webhook comes here).
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS hub_whatsapp_phone_number_id VARCHAR(50);

-- 2. Last login.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;

-- 3. Invite delivery. Existing invited rows: unknown, shown as before.
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS invite_status VARCHAR(10)
  CHECK (invite_status IN ('sent', 'failed'));
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS invite_error TEXT;

-- Left unchanged because of a clash — fix these by hand (Settings → Edit staff).
SELECT 'staff_users' AS tbl, id, phone FROM staff_users WHERE phone <> ss_normalize_phone(phone)
UNION ALL
SELECT 'patients', id, phone FROM patients WHERE phone <> ss_normalize_phone(phone)
UNION ALL
SELECT 'family_members', id, phone FROM family_members WHERE phone <> ss_normalize_phone(phone);
