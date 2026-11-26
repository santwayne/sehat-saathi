-- 009: Loopdesk hub (Nov 2026). Sehat Saathi becomes one of Loopdesk's packages
-- for hospitals. The hub (app.loopdeskai.wayneesolutions.com) sells and bills
-- the plan, creates the hospital here (POST /api/hub/provision), signs staff in
-- (/sso) and owns the hospital's WhatsApp number. Hospitals made by hand keep
-- working exactly as before. Idempotent.

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS hub_business_id VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS clinics_hub_business_id_key ON clinics (hub_business_id) WHERE hub_business_id IS NOT NULL;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS hub_tools TEXT[];          -- the package's tools, e.g. {SEHAT_SAATHI,WAYNERING}
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS hub_plan VARCHAR(100);     -- plan name as the hub calls it (Loopdesk bills it)
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS hub_paid_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS hub_synced_at TIMESTAMP WITH TIME ZONE;

-- A Loopdesk hospital's WhatsApp number lives in Loopdesk, not here.
ALTER TABLE clinics ALTER COLUMN whatsapp_number DROP NOT NULL;

-- One-time use of hub tokens (2-minute HS256 JWTs), so a token can't be replayed.
CREATE TABLE IF NOT EXISTS hub_token_uses (
  jti VARCHAR(100) PRIMARY KEY,
  purpose VARCHAR(30) NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
