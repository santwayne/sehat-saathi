const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole } = require('../services/auth.service');
const { logAudit } = require('../services/audit.service');

/**
 * Hospital side of break-glass: the hospital's own admin sees Super Admin's
 * requests for their hospital and approves, denies or ends them.
 * (Super Admin's side lives in admin.routes.js.)
 */
router.use(requireRole('admin'));

const SELECT = `
  SELECT b.id, b.reason, b.duration_minutes, b.status, b.decided_at, b.decision_note,
         b.expires_at, b.created_at, r.name AS requested_by_name, d.name AS decided_by_name,
         (b.status = 'approved' AND b.expires_at > NOW()) AS is_active
  FROM break_glass_requests b
  LEFT JOIN staff_users r ON r.id = b.requested_by
  LEFT JOIN staff_users d ON d.id = b.decided_by`;

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT} WHERE b.clinic_id = $1 ORDER BY b.created_at DESC LIMIT 50`, [req.user.clinic_id]);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to list break-glass requests:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

async function decide(req, res, { fromStatus, toStatus, action, setExpiry }) {
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE break_glass_requests SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = COALESCE($3, decision_note),
         expires_at = ${setExpiry}
       WHERE id = $4 AND clinic_id = $5 AND status = ANY($6) RETURNING id`,
      [toStatus, req.user.id, note, req.params.id, req.user.clinic_id, fromStatus]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Request not found or already decided.' });
    await logAudit(req, action, { targetType: 'break_glass', targetId: req.params.id, clinicId: req.user.clinic_id, details: note ? { note } : null });
    const full = await pool.query(`${SELECT} WHERE b.id = $1`, [req.params.id]);
    return res.json({ success: true, data: full.rows[0] });
  } catch (error) {
    console.error(`Break-glass ${action} failed:`, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

router.post('/:id/approve', (req, res) =>
  decide(req, res, { fromStatus: ['pending'], toStatus: 'approved', action: 'break_glass.approve', setExpiry: `NOW() + (duration_minutes || ' minutes')::INTERVAL` })
);
router.post('/:id/deny', (req, res) =>
  decide(req, res, { fromStatus: ['pending'], toStatus: 'denied', action: 'break_glass.deny', setExpiry: 'NULL' })
);
router.post('/:id/revoke', (req, res) =>
  decide(req, res, { fromStatus: ['approved'], toStatus: 'revoked', action: 'break_glass.revoke', setExpiry: 'LEAST(expires_at, NOW())' })
);

module.exports = router;
