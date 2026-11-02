const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole } = require('../services/auth.service');
const { logAudit } = require('../services/audit.service');
const integrations = require('../services/integrations.service');
const { SOURCES } = require('../services/platform-events.service');

/**
 * Super Admin platform console (/api/admin/*). Everything here is about
 * running the platform — hospitals, money, keys, errors, audit — and nothing
 * here returns patient-level data (only counts).
 */
router.use(requireRole('super_admin'));

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function fail(res, error, label) {
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === '23505') return res.status(409).json({ error: 'A record with these details already exists.' });
  if (error.code === '23503') return res.status(400).json({ error: 'Referenced record does not exist.' });
  console.error(`${label}:`, error);
  return res.status(500).json({ error: 'Internal server error' });
}

// Monthly price a subscription contributes to MRR.
const SUB_PRICE_SQL = 'COALESCE(s.price_override_inr, pl.price_monthly_inr, 0)';

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const [hospitals, mrr, patients, trialsEnding, overdue, errors24h, noWhatsapp, noSubscription, pendingBreakGlass, revenue30d] =
      await Promise.all([
        pool.query(`SELECT status, COUNT(*)::int AS count FROM clinics GROUP BY status`),
        pool.query(
          // Trials are counted but contribute nothing to MRR.
          `SELECT COALESCE(SUM(${SUB_PRICE_SQL}) FILTER (WHERE s.status IN ('active', 'past_due')), 0) AS mrr,
                  COUNT(*) FILTER (WHERE s.status = 'active')::int AS active,
                  COUNT(*) FILTER (WHERE s.status = 'trial')::int AS trial,
                  COUNT(*) FILTER (WHERE s.status = 'past_due')::int AS past_due
           FROM clinic_subscriptions s LEFT JOIN plans pl ON pl.id = s.plan_id`
        ),
        pool.query(
          `SELECT
             (SELECT COUNT(*) FROM patients)::int AS enrolled,
             (SELECT COUNT(DISTINCT patient_id) FROM conversations
               WHERE direction = 'inbound' AND patient_id IS NOT NULL
                 AND created_at > NOW() - INTERVAL '30 days')::int AS active_30d`
        ),
        pool.query(
          `SELECT c.id AS clinic_id, c.name, s.trial_ends_at
           FROM clinic_subscriptions s JOIN clinics c ON c.id = s.clinic_id
           WHERE s.status = 'trial' AND s.trial_ends_at IS NOT NULL
             AND s.trial_ends_at < NOW() + INTERVAL '7 days'
           ORDER BY s.trial_ends_at`
        ),
        pool.query(
          `SELECT i.id, i.invoice_number, i.amount_inr, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, c.name AS clinic_name
           FROM invoices i JOIN clinics c ON c.id = i.clinic_id
           WHERE i.status = 'sent' AND i.due_date < CURRENT_DATE
           ORDER BY i.due_date`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS count FROM platform_events
           WHERE resolved_at IS NULL AND severity = 'error' AND created_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
          `SELECT id, name FROM clinics
           WHERE status <> 'suspended' AND (whatsapp_phone_number_id IS NULL OR whatsapp_phone_number_id = '')`
        ),
        pool.query(
          `SELECT c.id, c.name FROM clinics c
           LEFT JOIN clinic_subscriptions s ON s.clinic_id = c.id
           WHERE s.id IS NULL AND c.status <> 'suspended'`
        ),
        pool.query(`SELECT COUNT(*)::int AS count FROM break_glass_requests WHERE status = 'pending'`),
        pool.query(`SELECT COALESCE(SUM(amount_inr), 0) AS total FROM payments WHERE paid_at > NOW() - INTERVAL '30 days'`),
      ]);

    const byStatus = Object.fromEntries(hospitals.rows.map((r) => [r.status, r.count]));
    const m = mrr.rows[0];

    const alerts = [];
    if (errors24h.rows[0].count > 0) {
      alerts.push({ level: 'error', type: 'platform_errors', message: `${errors24h.rows[0].count} unresolved platform error(s) in the last 24 hours`, link: '/app/health' });
    }
    for (const inv of overdue.rows) {
      alerts.push({ level: 'error', type: 'invoice_overdue', message: `Invoice ${inv.invoice_number} (${inv.clinic_name}) overdue since ${inv.due_date}`, link: '/app/billing' });
    }
    for (const t of trialsEnding.rows) {
      const ended = new Date(t.trial_ends_at) < new Date();
      alerts.push({ level: 'warning', type: 'trial_ending', message: `${t.name}: trial ${ended ? 'ended' : 'ends'} ${new Date(t.trial_ends_at).toISOString().slice(0, 10)}`, link: '/app/billing' });
    }
    for (const c of noWhatsapp.rows) {
      alerts.push({ level: 'warning', type: 'whatsapp_missing', message: `${c.name} has no WhatsApp phone_number_id — inbound messages cannot be routed to it`, link: '/app/clinics' });
    }
    for (const c of noSubscription.rows) {
      alerts.push({ level: 'warning', type: 'no_plan', message: `${c.name} has no plan or trial assigned`, link: '/app/billing' });
    }
    if (pendingBreakGlass.rows[0].count > 0) {
      alerts.push({ level: 'info', type: 'break_glass_pending', message: `${pendingBreakGlass.rows[0].count} break-glass request(s) waiting for hospital approval`, link: '/app/audit' });
    }

    return res.json({
      success: true,
      data: {
        hospitals: {
          total: Object.values(byStatus).reduce((a, b) => a + b, 0),
          active: byStatus.active || 0,
          onboarding: byStatus.onboarding || 0,
          suspended: byStatus.suspended || 0,
        },
        mrr_inr: num(m.mrr),
        subscriptions: { active: m.active, trial: m.trial, past_due: m.past_due },
        revenue_30d_inr: num(revenue30d.rows[0].total),
        patients: patients.rows[0],
        alerts,
      },
    });
  } catch (error) {
    return fail(res, error, 'Failed to build overview');
  }
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pl.*, (SELECT COUNT(*)::int FROM clinic_subscriptions s WHERE s.plan_id = pl.id AND s.status <> 'cancelled') AS hospital_count
       FROM plans pl ORDER BY pl.price_monthly_inr, pl.name`
    );
    return res.json({ success: true, data: rows.map((r) => ({ ...r, price_monthly_inr: num(r.price_monthly_inr) })) });
  } catch (error) {
    return fail(res, error, 'Failed to list plans');
  }
});

function planFields(body) {
  const out = {};
  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw Object.assign(new Error('Plan name is required.'), { status: 400 });
    out.name = String(body.name).trim();
  }
  if (body.price_monthly_inr !== undefined) {
    const p = Number(body.price_monthly_inr);
    if (!Number.isFinite(p) || p < 0) throw Object.assign(new Error('price_monthly_inr must be a number ≥ 0.'), { status: 400 });
    out.price_monthly_inr = p;
  }
  if (body.patient_limit !== undefined) {
    const l = body.patient_limit === null || body.patient_limit === '' ? null : Number(body.patient_limit);
    if (l !== null && (!Number.isInteger(l) || l <= 0)) throw Object.assign(new Error('patient_limit must be a positive whole number or empty.'), { status: 400 });
    out.patient_limit = l;
  }
  if (body.features !== undefined) out.features = body.features || null;
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

router.post('/plans', async (req, res) => {
  try {
    const f = planFields(req.body);
    if (!f.name) return res.status(400).json({ error: 'Plan name is required.' });
    const { rows } = await pool.query(
      `INSERT INTO plans (name, price_monthly_inr, patient_limit, features, active)
       VALUES ($1, $2, $3, $4, COALESCE($5, true)) RETURNING *`,
      [f.name, f.price_monthly_inr ?? 0, f.patient_limit ?? null, f.features ?? null, f.active]
    );
    await logAudit(req, 'plan.create', { targetType: 'plan', targetId: rows[0].id, details: f });
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    return fail(res, error, 'Failed to create plan');
  }
});

router.patch('/plans/:id', async (req, res) => {
  try {
    const f = planFields(req.body);
    const keys = Object.keys(f);
    if (keys.length === 0) return res.status(400).json({ error: 'No fields provided to update.' });
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const { rows } = await pool.query(
      `UPDATE plans SET ${sets.join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => f[k]), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    await logAudit(req, 'plan.update', { targetType: 'plan', targetId: req.params.id, details: f });
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return fail(res, error, 'Failed to update plan');
  }
});

// ---------------------------------------------------------------------------
// Subscriptions (one per hospital) and trials
// ---------------------------------------------------------------------------
router.get('/subscriptions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id AS clinic_id, c.name AS clinic_name, c.status AS clinic_status,
              s.id, s.plan_id, pl.name AS plan_name, s.status, s.price_override_inr,
              pl.price_monthly_inr AS plan_price_inr, ${SUB_PRICE_SQL} AS effective_price_inr,
              s.trial_ends_at, s.started_at, s.cancelled_at,
              (SELECT COUNT(*)::int FROM patients p WHERE p.clinic_id = c.id) AS patient_count,
              pl.patient_limit
       FROM clinics c
       LEFT JOIN clinic_subscriptions s ON s.clinic_id = c.id
       LEFT JOIN plans pl ON pl.id = s.plan_id
       ORDER BY c.name`
    );
    return res.json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        price_override_inr: r.price_override_inr === null ? null : num(r.price_override_inr),
        plan_price_inr: r.plan_price_inr === null ? null : num(r.plan_price_inr),
        effective_price_inr: num(r.effective_price_inr),
      })),
    });
  } catch (error) {
    return fail(res, error, 'Failed to list subscriptions');
  }
});

/**
 * PUT /api/admin/subscriptions/:clinicId
 * Body: { plan_id, status, trial_ends_at?, trial_days?, price_override_inr? }
 * Creates or replaces the hospital's subscription.
 */
router.put('/subscriptions/:clinicId', async (req, res) => {
  const { clinicId } = req.params;
  const { plan_id, status, trial_ends_at, trial_days, price_override_inr } = req.body;

  if (!['trial', 'active', 'past_due', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: "status must be 'trial', 'active', 'past_due' or 'cancelled'." });
  }
  if (plan_id && !isUuid(plan_id)) return res.status(400).json({ error: 'Invalid plan_id.' });
  if (status !== 'cancelled' && !plan_id) return res.status(400).json({ error: 'Pick a plan.' });

  let trialEnds = null;
  if (status === 'trial') {
    if (trial_ends_at) {
      trialEnds = new Date(trial_ends_at);
      if (Number.isNaN(trialEnds.getTime())) return res.status(400).json({ error: 'Invalid trial_ends_at.' });
    } else {
      const days = Number(trial_days || 14);
      if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ error: 'trial_days must be 1–365.' });
      trialEnds = new Date(Date.now() + days * 86400_000);
    }
  }
  let override = null;
  if (price_override_inr !== undefined && price_override_inr !== null && price_override_inr !== '') {
    override = Number(price_override_inr);
    if (!Number.isFinite(override) || override < 0) return res.status(400).json({ error: 'price_override_inr must be ≥ 0.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO clinic_subscriptions (clinic_id, plan_id, status, price_override_inr, trial_ends_at, started_at, cancelled_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW())
       ON CONFLICT (clinic_id) DO UPDATE SET
         plan_id = EXCLUDED.plan_id,
         status = EXCLUDED.status,
         price_override_inr = EXCLUDED.price_override_inr,
         trial_ends_at = EXCLUDED.trial_ends_at,
         started_at = CASE WHEN clinic_subscriptions.status <> EXCLUDED.status OR clinic_subscriptions.plan_id IS DISTINCT FROM EXCLUDED.plan_id
                           THEN NOW() ELSE clinic_subscriptions.started_at END,
         cancelled_at = CASE WHEN EXCLUDED.status = 'cancelled' THEN COALESCE(clinic_subscriptions.cancelled_at, NOW()) END,
         updated_at = NOW()
       RETURNING *`,
      [clinicId, plan_id || null, status, override, trialEnds, status === 'cancelled' ? new Date() : null]
    );
    await logAudit(req, 'subscription.update', {
      targetType: 'clinic',
      targetId: clinicId,
      clinicId,
      details: { plan_id, status, trial_ends_at: trialEnds, price_override_inr: override },
    });
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return fail(res, error, 'Failed to save subscription');
  }
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
const INVOICE_SELECT = `
  SELECT i.id, i.clinic_id, i.invoice_number, i.amount_inr, i.status, i.notes, i.paid_at, i.created_at,
         -- DATE columns as plain strings so no timezone shift creeps in.
         to_char(i.period_start, 'YYYY-MM-DD') AS period_start,
         to_char(i.period_end, 'YYYY-MM-DD') AS period_end,
         to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
         c.name AS clinic_name,
         COALESCE((SELECT SUM(amount_inr) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_inr,
         (i.status = 'sent' AND i.due_date < CURRENT_DATE) AS is_overdue
  FROM invoices i JOIN clinics c ON c.id = i.clinic_id`;

const shapeInvoice = (r) => ({ ...r, amount_inr: num(r.amount_inr), paid_inr: num(r.paid_inr) });

router.get('/invoices', async (req, res) => {
  const { clinic_id, status } = req.query;
  const where = [];
  const params = [];
  if (clinic_id) { params.push(clinic_id); where.push(`i.clinic_id = $${params.length}`); }
  if (status === 'overdue') where.push(`i.status = 'sent' AND i.due_date < CURRENT_DATE`);
  else if (status) { params.push(status); where.push(`i.status = $${params.length}`); }
  try {
    const { rows } = await pool.query(
      `${INVOICE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.created_at DESC LIMIT 500`,
      params
    );
    return res.json({ success: true, data: rows.map(shapeInvoice) });
  } catch (error) {
    return fail(res, error, 'Failed to list invoices');
  }
});

router.post('/invoices', async (req, res) => {
  const { clinic_id, amount_inr, period_start, period_end, due_date, notes, status = 'sent' } = req.body;
  if (!isUuid(clinic_id)) return res.status(400).json({ error: 'Pick a hospital.' });
  const amount = Number(amount_inr);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount_inr must be ≥ 0.' });
  for (const [k, v] of Object.entries({ period_start, period_end, due_date })) {
    if (v && !isDate(v)) return res.status(400).json({ error: `${k} must be YYYY-MM-DD.` });
  }
  if (!['draft', 'sent'].includes(status)) return res.status(400).json({ error: "New invoices are 'draft' or 'sent'." });

  try {
    // SS-YYYYMM-0001, sequential within the month.
    const prefix = `SS-${new Date().toISOString().slice(0, 7).replace('-', '')}-`;
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM invoices WHERE invoice_number LIKE $1`,
      [`${prefix}%`]
    );
    let n = countRows[0].n + 1;
    let inserted;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++, n++) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO invoices (clinic_id, invoice_number, amount_inr, period_start, period_end, due_date, status, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [clinic_id, `${prefix}${String(n).padStart(4, '0')}`, amount, period_start || null, period_end || null, due_date || null, status, notes || null]
        );
        inserted = rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    if (!inserted) return res.status(409).json({ error: 'Could not allocate an invoice number, try again.' });
    const { rows } = await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [inserted.id]);
    await logAudit(req, 'invoice.create', { targetType: 'invoice', targetId: inserted.id, clinicId: clinic_id, details: { amount_inr: amount, due_date, status } });
    return res.status(201).json({ success: true, data: shapeInvoice(rows[0]) });
  } catch (error) {
    return fail(res, error, 'Failed to create invoice');
  }
});

router.patch('/invoices/:id', async (req, res) => {
  const { status, due_date, notes } = req.body;
  const sets = [];
  const params = [];
  if (status !== undefined) {
    if (!['draft', 'sent', 'paid', 'void'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    params.push(status); sets.push(`status = $${params.length}`);
    sets.push(status === 'paid' ? 'paid_at = COALESCE(paid_at, NOW())' : 'paid_at = NULL');
  }
  if (due_date !== undefined) {
    if (due_date && !isDate(due_date)) return res.status(400).json({ error: 'due_date must be YYYY-MM-DD.' });
    params.push(due_date || null); sets.push(`due_date = $${params.length}`);
  }
  if (notes !== undefined) { params.push(notes || null); sets.push(`notes = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'No fields provided to update.' });
  params.push(req.params.id);
  try {
    const { rows } = await pool.query(`UPDATE invoices SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, clinic_id`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
    const full = await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [req.params.id]);
    await logAudit(req, 'invoice.update', { targetType: 'invoice', targetId: req.params.id, clinicId: rows[0].clinic_id, details: req.body });
    return res.json({ success: true, data: shapeInvoice(full.rows[0]) });
  } catch (error) {
    return fail(res, error, 'Failed to update invoice');
  }
});

// ---------------------------------------------------------------------------
// Payments (recorded manually)
// ---------------------------------------------------------------------------
router.get('/payments', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.clinic_id) { params.push(req.query.clinic_id); where = 'WHERE p.clinic_id = $1'; }
  try {
    const { rows } = await pool.query(
      `SELECT p.*, c.name AS clinic_name, i.invoice_number, s.name AS recorded_by_name
       FROM payments p
       JOIN clinics c ON c.id = p.clinic_id
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN staff_users s ON s.id = p.recorded_by
       ${where} ORDER BY p.paid_at DESC LIMIT 500`,
      params
    );
    return res.json({ success: true, data: rows.map((r) => ({ ...r, amount_inr: num(r.amount_inr) })) });
  } catch (error) {
    return fail(res, error, 'Failed to list payments');
  }
});

router.post('/payments', async (req, res) => {
  const { clinic_id, invoice_id, amount_inr, method, reference, paid_at } = req.body;
  if (!isUuid(clinic_id)) return res.status(400).json({ error: 'Pick a hospital.' });
  if (invoice_id && !isUuid(invoice_id)) return res.status(400).json({ error: 'Invalid invoice_id.' });
  const amount = Number(amount_inr);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount_inr must be > 0.' });
  const paidAt = paid_at ? new Date(paid_at) : new Date();
  if (Number.isNaN(paidAt.getTime())) return res.status(400).json({ error: 'Invalid paid_at.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (invoice_id) {
      const inv = await client.query('SELECT clinic_id FROM invoices WHERE id = $1 FOR UPDATE', [invoice_id]);
      if (!inv.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found.' }); }
      if (inv.rows[0].clinic_id !== clinic_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invoice belongs to a different hospital.' }); }
    }
    const { rows } = await client.query(
      `INSERT INTO payments (clinic_id, invoice_id, amount_inr, method, reference, paid_at, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [clinic_id, invoice_id || null, amount, method || null, reference || null, paidAt, req.user.id]
    );
    // Fully covered invoice → mark paid.
    if (invoice_id) {
      await client.query(
        `UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, $2)
         WHERE id = $1 AND status <> 'void'
           AND (SELECT COALESCE(SUM(amount_inr), 0) FROM payments WHERE invoice_id = $1) >= amount_inr`,
        [invoice_id, paidAt]
      );
    }
    await client.query('COMMIT');
    await logAudit(req, 'payment.record', { targetType: 'payment', targetId: rows[0].id, clinicId: clinic_id, details: { amount_inr: amount, invoice_id, method, reference } });
    return res.status(201).json({ success: true, data: { ...rows[0], amount_inr: num(rows[0].amount_inr) } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return fail(res, error, 'Failed to record payment');
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Usage & Profit
// ---------------------------------------------------------------------------
const UNIT_COST_KEYS = {
  whatsapp_checkin_inr: 'Per WhatsApp check-in (template) message',
  whatsapp_other_outbound_inr: 'Per other outbound WhatsApp message',
  ai_reply_inr: 'Per AI-handled inbound message',
  ocr_document_inr: 'Per document read by OCR',
  voice_call_inr: 'Per voice check-in call',
  fixed_per_hospital_inr: 'Fixed monthly cost per hospital (hosting share etc.)',
};

async function getUnitCosts() {
  const { rows } = await pool.query(`SELECT value FROM platform_settings WHERE key = 'unit_costs'`);
  const saved = rows[0]?.value || {};
  return Object.fromEntries(Object.keys(UNIT_COST_KEYS).map((k) => [k, num(saved[k])]));
}

router.get('/unit-costs', async (req, res) => {
  try {
    return res.json({ success: true, data: { values: await getUnitCosts(), labels: UNIT_COST_KEYS } });
  } catch (error) {
    return fail(res, error, 'Failed to load unit costs');
  }
});

router.put('/unit-costs', async (req, res) => {
  const values = {};
  for (const k of Object.keys(UNIT_COST_KEYS)) {
    const v = Number(req.body?.[k] ?? 0);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `${k} must be a number ≥ 0.` });
    values[k] = v;
  }
  try {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('unit_costs', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [JSON.stringify(values), req.user.id]
    );
    await logAudit(req, 'unit_costs.update', { targetType: 'platform_settings', targetId: 'unit_costs', details: values });
    return res.json({ success: true, data: values });
  } catch (error) {
    return fail(res, error, 'Failed to save unit costs');
  }
});

/**
 * GET /api/admin/usage?month=YYYY-MM
 * Per-hospital usage counts for the month, cost (counts × unit costs),
 * revenue (payments received that month) and margin.
 */
router.get('/usage', async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const start = `${month}-01`;
  try {
    const costs = await getUnitCosts();
    const { rows } = await pool.query(
      `WITH win AS (SELECT $1::date AS s, ($1::date + INTERVAL '1 month') AS e),
       conv AS (
         SELECT COALESCE(cv.clinic_id, p.clinic_id) AS clinic_id, cv.channel, cv.direction, cv.intent_type, cv.external_id
         FROM conversations cv
         LEFT JOIN patients p ON p.id = cv.patient_id, win
         WHERE cv.created_at >= win.s AND cv.created_at < win.e
       ),
       conv_agg AS (
         SELECT clinic_id,
           COUNT(*) FILTER (WHERE channel = 'whatsapp' AND direction = 'outbound' AND intent_type = 'checkin_response') AS wa_checkins,
           COUNT(*) FILTER (WHERE channel = 'whatsapp' AND direction = 'outbound' AND intent_type IS DISTINCT FROM 'checkin_response') AS wa_other_outbound,
           COUNT(*) FILTER (WHERE channel = 'whatsapp' AND direction = 'inbound') AS wa_inbound,
           COUNT(*) FILTER (WHERE channel = 'whatsapp' AND direction = 'inbound'
                              AND intent_type IS DISTINCT FROM 'prescription_image'
                              AND intent_type IS DISTINCT FROM 'enrollment') AS ai_replies,
           COUNT(DISTINCT external_id) FILTER (WHERE channel = 'voice' AND direction = 'outbound') AS voice_calls
         FROM conv GROUP BY clinic_id
       ),
       docs AS (
         SELECT COALESCE(p.clinic_id, pe.clinic_id) AS clinic_id, COUNT(*) AS ocr_documents
         FROM prescriptions pr
         LEFT JOIN patients p ON p.id = pr.patient_id
         LEFT JOIN pending_enrollments pe ON pe.candidate_document_id = pr.id, win
         WHERE pr.created_at >= win.s AND pr.created_at < win.e
         GROUP BY 1
       ),
       pay AS (
         SELECT clinic_id, SUM(amount_inr) AS revenue
         FROM payments, win WHERE paid_at >= win.s AND paid_at < win.e GROUP BY clinic_id
       )
       SELECT c.id AS clinic_id, c.name AS clinic_name, c.status AS clinic_status,
              COALESCE(ca.wa_checkins, 0)::int AS wa_checkins,
              COALESCE(ca.wa_other_outbound, 0)::int AS wa_other_outbound,
              COALESCE(ca.wa_inbound, 0)::int AS wa_inbound,
              COALESCE(ca.ai_replies, 0)::int AS ai_replies,
              COALESCE(ca.voice_calls, 0)::int AS voice_calls,
              COALESCE(d.ocr_documents, 0)::int AS ocr_documents,
              COALESCE(pay.revenue, 0) AS revenue_inr,
              ${SUB_PRICE_SQL} AS plan_price_inr, s.status AS subscription_status
       FROM clinics c
       LEFT JOIN conv_agg ca ON ca.clinic_id = c.id
       LEFT JOIN docs d ON d.clinic_id = c.id
       LEFT JOIN pay ON pay.clinic_id = c.id
       LEFT JOIN clinic_subscriptions s ON s.clinic_id = c.id
       LEFT JOIN plans pl ON pl.id = s.plan_id
       ORDER BY c.name`,
      [start]
    );

    const round = (v) => Math.round(v * 100) / 100;
    const hospitals = rows.map((r) => {
      const cost =
        r.wa_checkins * costs.whatsapp_checkin_inr +
        r.wa_other_outbound * costs.whatsapp_other_outbound_inr +
        r.ai_replies * costs.ai_reply_inr +
        r.ocr_documents * costs.ocr_document_inr +
        r.voice_calls * costs.voice_call_inr +
        (r.clinic_status === 'suspended' ? 0 : costs.fixed_per_hospital_inr);
      const revenue = num(r.revenue_inr);
      return {
        ...r,
        revenue_inr: revenue,
        plan_price_inr: num(r.plan_price_inr),
        cost_inr: round(cost),
        margin_inr: round(revenue - cost),
        margin_pct: revenue > 0 ? round(((revenue - cost) / revenue) * 100) : null,
      };
    });
    const totals = hospitals.reduce(
      (t, h) => ({ cost_inr: round(t.cost_inr + h.cost_inr), revenue_inr: round(t.revenue_inr + h.revenue_inr), margin_inr: round(t.margin_inr + h.margin_inr) }),
      { cost_inr: 0, revenue_inr: 0, margin_inr: 0 }
    );
    const costsConfigured = Object.values(costs).some((v) => v > 0);
    return res.json({ success: true, data: { month, unit_costs: costs, costs_configured: costsConfigured, totals, hospitals } });
  } catch (error) {
    return fail(res, error, 'Failed to compute usage');
  }
});

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
router.get('/integrations', async (req, res) => {
  try {
    await integrations.loadIntegrationOverrides();
    const [clinics, templates] = await Promise.all([
      pool.query(
        `SELECT id, name, status, whatsapp_number, whatsapp_phone_number_id, whatsapp_waba_id,
                (whatsapp_access_token IS NOT NULL AND whatsapp_access_token <> '') AS has_access_token
         FROM clinics ORDER BY name`
      ),
      pool.query(`SELECT scope, name, language, category, status, rejected_reason, synced_at FROM whatsapp_templates ORDER BY scope, name, language`),
    ]);
    return res.json({
      success: true,
      data: {
        providers: integrations.providerStatus(),
        clinics: clinics.rows,
        templates: templates.rows,
        encryption_key_set: !!process.env.INTEGRATIONS_ENCRYPTION_KEY,
      },
    });
  } catch (error) {
    return fail(res, error, 'Failed to load integrations');
  }
});

/** PUT /api/admin/integrations  Body: { values: { KEY: 'new value' | '' (clear) } } */
router.put('/integrations', async (req, res) => {
  try {
    const changed = await integrations.saveIntegrationKeys(req.body?.values, req.user.id);
    // Key names only — never the values.
    await logAudit(req, 'integration.update', { targetType: 'integration', targetId: changed.join(',').slice(0, 64), details: { keys: changed } });
    return res.json({ success: true, data: { changed, providers: integrations.providerStatus() } });
  } catch (error) {
    return fail(res, error, 'Failed to save integration keys');
  }
});

router.post('/integrations/:provider/test', async (req, res) => {
  if (!integrations.PROVIDERS[req.params.provider]) return res.status(404).json({ error: 'Unknown provider.' });
  try {
    await integrations.loadIntegrationOverrides();
    const result = await integrations.testProvider(req.params.provider);
    await logAudit(req, 'integration.test', { targetType: 'integration', targetId: req.params.provider, details: { ok: result.ok } });
    return res.json({ success: true, data: result });
  } catch (error) {
    return fail(res, error, 'Integration test failed');
  }
});

router.post('/integrations/templates/sync', async (req, res) => {
  try {
    await integrations.loadIntegrationOverrides();
    const result = await integrations.syncWhatsAppTemplates();
    await logAudit(req, 'whatsapp_templates.sync', { targetType: 'integration', targetId: 'whatsapp', details: result });
    return res.json({ success: true, data: result });
  } catch (error) {
    return fail(res, error, 'Template sync failed');
  }
});

/** PATCH /api/admin/integrations/clinics/:id  Body: { whatsapp_waba_id } */
router.patch('/integrations/clinics/:id', async (req, res) => {
  const { whatsapp_waba_id } = req.body;
  if (whatsapp_waba_id !== null && whatsapp_waba_id !== undefined && !/^\d{0,30}$/.test(String(whatsapp_waba_id))) {
    return res.status(400).json({ error: 'WABA ID should be digits only.' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE clinics SET whatsapp_waba_id = $1 WHERE id = $2 RETURNING id, whatsapp_waba_id',
      [whatsapp_waba_id || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Clinic not found.' });
    await logAudit(req, 'clinic.update_waba', { targetType: 'clinic', targetId: req.params.id, clinicId: req.params.id, details: { whatsapp_waba_id } });
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return fail(res, error, 'Failed to update WABA id');
  }
});

// ---------------------------------------------------------------------------
// Platform Health
// ---------------------------------------------------------------------------
router.get('/health', async (req, res) => {
  const { source, state = 'open' } = req.query;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const where = [`e.created_at > NOW() - ($1 || ' days')::INTERVAL`];
  const params = [String(days)];
  if (source && SOURCES.includes(source)) { params.push(source); where.push(`e.source = $${params.length}`); }
  if (state === 'open') where.push('e.resolved_at IS NULL');
  if (state === 'resolved') where.push('e.resolved_at IS NOT NULL');
  try {
    const [events, summary] = await Promise.all([
      pool.query(
        `SELECT e.*, c.name AS clinic_name FROM platform_events e
         LEFT JOIN clinics c ON c.id = e.clinic_id
         WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT 300`,
        params
      ),
      pool.query(
        `SELECT source,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
                COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
                MAX(created_at) AS last_at
         FROM platform_events WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY source`
      ),
    ]);
    return res.json({ success: true, data: { events: events.rows, summary: summary.rows, sources: SOURCES } });
  } catch (error) {
    return fail(res, error, 'Failed to load platform health');
  }
});

router.patch('/health/:id/resolve', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE platform_events SET resolved_at = COALESCE(resolved_at, NOW()) WHERE id = $1 RETURNING id, resolved_at`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Event not found.' });
    await logAudit(req, 'platform_event.resolve', { targetType: 'platform_event', targetId: req.params.id });
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return fail(res, error, 'Failed to resolve event');
  }
});

router.post('/health/resolve-all', async (req, res) => {
  const { source } = req.body || {};
  try {
    const params = [];
    let extra = '';
    if (source && SOURCES.includes(source)) { params.push(source); extra = 'AND source = $1'; }
    const { rowCount } = await pool.query(`UPDATE platform_events SET resolved_at = NOW() WHERE resolved_at IS NULL ${extra}`, params);
    await logAudit(req, 'platform_event.resolve_all', { targetType: 'platform_event', details: { source: source || 'all', count: rowCount } });
    return res.json({ success: true, data: { resolved: rowCount } });
  } catch (error) {
    return fail(res, error, 'Failed to resolve events');
  }
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
router.get('/audit', async (req, res) => {
  const { action, clinic_id, actor_role, before } = req.query;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const where = [];
  const params = [];
  if (action) { params.push(`${action}%`); where.push(`a.action LIKE $${params.length}`); }
  if (clinic_id) { params.push(clinic_id); where.push(`a.clinic_id = $${params.length}`); }
  if (actor_role) { params.push(actor_role); where.push(`a.actor_role = $${params.length}`); }
  if (before) { params.push(before); where.push(`a.created_at < $${params.length}`); }
  params.push(limit);
  try {
    const { rows } = await pool.query(
      `SELECT a.*, c.name AS clinic_name FROM audit_log a
       LEFT JOIN clinics c ON c.id = a.clinic_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC LIMIT $${params.length}`,
      params
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return fail(res, error, 'Failed to load audit log');
  }
});

// ---------------------------------------------------------------------------
// Break-glass (Super Admin side: request, list, revoke)
// ---------------------------------------------------------------------------
const BREAK_GLASS_SELECT = `
  SELECT b.*, c.name AS clinic_name, r.name AS requested_by_name, d.name AS decided_by_name,
         (b.status = 'approved' AND b.expires_at > NOW()) AS is_active
  FROM break_glass_requests b
  JOIN clinics c ON c.id = b.clinic_id
  LEFT JOIN staff_users r ON r.id = b.requested_by
  LEFT JOIN staff_users d ON d.id = b.decided_by`;

router.get('/break-glass', async (req, res) => {
  try {
    const { rows } = await pool.query(`${BREAK_GLASS_SELECT} ORDER BY b.created_at DESC LIMIT 200`);
    return res.json({ success: true, data: rows });
  } catch (error) {
    return fail(res, error, 'Failed to list break-glass requests');
  }
});

router.post('/break-glass', async (req, res) => {
  const { clinic_id, reason } = req.body;
  const duration = Number(req.body.duration_minutes || 60);
  if (!isUuid(clinic_id)) return res.status(400).json({ error: 'Pick a hospital.' });
  if (!reason || String(reason).trim().length < 15) {
    return res.status(400).json({ error: 'Give a clear reason (at least 15 characters) — the hospital admin sees it before approving.' });
  }
  if (!Number.isInteger(duration) || duration < 15 || duration > 1440) {
    return res.status(400).json({ error: 'duration_minutes must be between 15 and 1440.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO break_glass_requests (clinic_id, requested_by, reason, duration_minutes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [clinic_id, req.user.id, String(reason).trim(), duration]
    );
    await logAudit(req, 'break_glass.request', { targetType: 'break_glass', targetId: rows[0].id, clinicId: clinic_id, details: { reason, duration_minutes: duration } });
    const full = await pool.query(`${BREAK_GLASS_SELECT} WHERE b.id = $1`, [rows[0].id]);
    return res.status(201).json({ success: true, data: full.rows[0] });
  } catch (error) {
    return fail(res, error, 'Failed to create break-glass request');
  }
});

/** Super Admin can withdraw its own pending request or end an active grant early. */
router.post('/break-glass/:id/revoke', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE break_glass_requests SET status = 'revoked',
         expires_at = CASE WHEN status = 'approved' THEN LEAST(expires_at, NOW()) ELSE expires_at END
       WHERE id = $1 AND status IN ('pending', 'approved') RETURNING id, clinic_id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No pending or active request with this id.' });
    await logAudit(req, 'break_glass.revoke', { targetType: 'break_glass', targetId: req.params.id, clinicId: rows[0].clinic_id });
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 'Failed to revoke break-glass request');
  }
});

module.exports = router;
