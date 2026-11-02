-- Regulars (WhatsApp retention platform) as a third-party integration,
-- configured per hospital by Super Admin only.
-- Idempotent; mirrored at the end of schema.sql.
-- Usage: psql $DATABASE_URL -f src/db/migrations/006_regulars_integration.sql

-- One row per hospital that has been set up. Each hospital maps to one
-- Regulars business, identified by that business's API key.
CREATE TABLE IF NOT EXISTS clinic_regulars (
  clinic_id UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  api_key_encrypted TEXT,            -- AES-256-GCM, see services/crypto.service.js
  api_key_hint VARCHAR(20),          -- e.g. "rk_live_ab12cd…" to recognise the key
  location_id VARCHAR(64),           -- Regulars location; NULL = business default
  business_name VARCHAR(255),        -- from the last successful connection test
  last_tested_at TIMESTAMP WITH TIME ZONE,
  last_test_ok BOOLEAN,
  last_synced_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Outbox: events waiting to be pushed to Regulars. Written in the same
-- request that changes the patient (enrolment, verified document, opt-out)
-- and flushed asynchronously with retries, so a Regulars outage never breaks
-- or slows patient care. phone/name are cleared once an event is delivered.
CREATE TABLE IF NOT EXISTS regulars_outbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('VISIT', 'CUSTOMER', 'OPT_OUT')),
  external_id VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(255),
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  regulars_status VARCHAR(20),       -- created / updated / duplicate, as Regulars reported
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (clinic_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_regulars_outbox_due ON regulars_outbox (status, next_attempt_at);
