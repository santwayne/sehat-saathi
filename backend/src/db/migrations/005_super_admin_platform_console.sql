-- Super Admin platform console: plans & billing, usage costs, integrations,
-- platform health, audit log and break-glass access.
-- Idempotent (IF NOT EXISTS everywhere); mirrored at the end of schema.sql.
-- Usage: psql $DATABASE_URL -f src/db/migrations/005_super_admin_platform_console.sql

-- Profile field for Settings (super admin and hospital staff alike).
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- WhatsApp Business Account id: needed to read message-template status from Meta.
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS whatsapp_waba_id VARCHAR(50);

-- 1. Plans & billing --------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) UNIQUE NOT NULL,
  price_monthly_inr NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price_monthly_inr >= 0),
  patient_limit INTEGER CHECK (patient_limit IS NULL OR patient_limit > 0),
  features TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- One subscription row per hospital (current state; history lives in audit_log).
CREATE TABLE IF NOT EXISTS clinic_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID UNIQUE NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'past_due', 'cancelled')),
  -- Negotiated price for this hospital; NULL = the plan's list price.
  price_override_inr NUMERIC(12, 2) CHECK (price_override_inr IS NULL OR price_override_inr >= 0),
  trial_ends_at TIMESTAMP WITH TIME ZONE,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  invoice_number VARCHAR(40) UNIQUE NOT NULL,
  amount_inr NUMERIC(12, 2) NOT NULL CHECK (amount_inr >= 0),
  period_start DATE,
  period_end DATE,
  due_date DATE,
  -- 'overdue' is not stored: it is derived (status = 'sent' AND due_date < today).
  status VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  notes TEXT,
  paid_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoices_clinic ON invoices (clinic_id);

-- Payments are recorded manually for now (bank transfer / UPI / cheque); no gateway yet.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_inr NUMERIC(12, 2) NOT NULL CHECK (amount_inr > 0),
  method VARCHAR(30),
  reference VARCHAR(255),
  paid_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_clinic_paid_at ON payments (clinic_id, paid_at);

-- 2. Platform settings (unit costs for Usage & Profit, etc.) -----------------
CREATE TABLE IF NOT EXISTS platform_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Integrations -----------------------------------------------------------
-- Platform-wide third-party keys set from the Super Admin console. Values are
-- AES-256-GCM encrypted (see services/crypto.service.js); a row here overrides
-- the env var of the same name. Per-hospital WhatsApp credentials stay on clinics.
CREATE TABLE IF NOT EXISTS integration_settings (
  key VARCHAR(100) PRIMARY KEY,
  value_encrypted TEXT NOT NULL,
  updated_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Last-synced copy of Meta's message-template list. scope = 'global' for the
-- env/platform WABA, or a clinic id for a hospital's own WABA.
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scope VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  language VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  status VARCHAR(30) NOT NULL,
  rejected_reason TEXT,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scope, name, language)
);

-- 4. Platform health --------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source VARCHAR(30) NOT NULL CHECK (source IN ('webhook', 'queue', 'ocr', 'whatsapp_send', 'voice', 'media', 'integration', 'other')),
  severity VARCHAR(10) NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
  clinic_id UUID REFERENCES clinics(id) ON DELETE SET NULL,
  -- Operational text only: never a patient name, phone or message body.
  message TEXT NOT NULL,
  details JSONB,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_platform_events_created ON platform_events (created_at DESC);

-- 5. Audit log --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  actor_name VARCHAR(255),
  actor_role VARCHAR(50),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(64),
  clinic_id UUID REFERENCES clinics(id) ON DELETE SET NULL,
  details JSONB,
  ip VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

-- 6. Break-glass access -----------------------------------------------------
-- Super Admin has no access to patient data. In an emergency they raise a
-- request for one hospital with a reason; that hospital's admin approves or
-- denies it. An approved grant is read-only and time-boxed, and every request
-- made under it is written to audit_log.
CREATE TABLE IF NOT EXISTS break_glass_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 1440),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
  decided_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at TIMESTAMP WITH TIME ZONE,
  decision_note TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_break_glass_clinic ON break_glass_requests (clinic_id, status);
