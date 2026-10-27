const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole } = require('../services/auth.service');
const { CHECKIN_PROMPT_TEXTS, CHECKIN_TEMPLATE_LOG_PATTERN } = require('../services/i18n');

// Hospital analytics on adherence (roadmap "Later" item). Everything here is
// derived from data the product already records. A check-in counts as
// "answered" when the same patient sends any message within 24h after it —
// the reply isn't parsed into taken/missed, so this measures engagement and
// flagged missed doses, not confirmed doses taken.

/**
 * GET /api/analytics/adherence?days=30[&clinic_id=]
 * Clinic-wide for admin/coordinator/nurse; super_admin may pick a clinic or
 * see everything.
 */
router.get('/adherence', requireRole('admin', 'coordinator', 'nurse', 'super_admin'), async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const clinicId = req.user.role === 'super_admin' ? req.query.clinic_id || null : req.user.clinic_id;
  if (req.user.role !== 'super_admin' && !clinicId) return res.status(403).json({ error: 'Insufficient permissions.' });

  // $1 = days, $2 = clinic (NULL = all clinics, super_admin only)
  const params = [days, clinicId];
  // Separate params for the two check-in queries (the others don't take them).
  const checkinParams = [days, clinicId, CHECKIN_PROMPT_TEXTS, CHECKIN_TEMPLATE_LOG_PATTERN];
  const isCheckinPrompt = `c.direction = 'outbound' AND (c.message_text = ANY($3::text[]) OR c.message_text LIKE $4)`;
  const patientScope = '($2::uuid IS NULL OR p.clinic_id = $2)';

  try {
    const [totals, checkins, daily, flags, byType, byDoctor] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS patients,
                COUNT(*) FILTER (WHERE p.created_at >= NOW() - make_interval(days => $1)) AS enrolled_in_period,
                COUNT(*) FILTER (WHERE p.kill_switch_active) AS kill_switch_patients,
                COUNT(*) FILTER (WHERE p.abha_linked_at IS NOT NULL) AS abha_linked,
                COUNT(*) FILTER (WHERE p.bed_id IS NOT NULL) AS bed_linked
         FROM patients p WHERE ${patientScope}`, params),
      pool.query(
        `WITH sent AS (
           SELECT c.id, c.patient_id, c.created_at,
                  EXISTS (SELECT 1 FROM conversations r
                          WHERE r.patient_id = c.patient_id AND r.direction = 'inbound'
                            AND (r.sender_type IS NULL OR r.sender_type = 'patient')
                            AND r.created_at > c.created_at AND r.created_at <= c.created_at + INTERVAL '24 hours') AS answered
           FROM conversations c JOIN patients p ON p.id = c.patient_id
           WHERE ${isCheckinPrompt}
             AND c.created_at >= NOW() - make_interval(days => $1) AND ${patientScope})
         SELECT COUNT(*) AS sent, COUNT(*) FILTER (WHERE answered) AS answered,
                COUNT(DISTINCT patient_id) AS patients_checked_in FROM sent`, checkinParams),
      pool.query(
        `SELECT to_char(date_trunc('day', c.created_at), 'YYYY-MM-DD') AS day,
                COUNT(*) AS sent,
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversations r
                          WHERE r.patient_id = c.patient_id AND r.direction = 'inbound'
                            AND (r.sender_type IS NULL OR r.sender_type = 'patient')
                            AND r.created_at > c.created_at AND r.created_at <= c.created_at + INTERVAL '24 hours')) AS answered
         FROM conversations c JOIN patients p ON p.id = c.patient_id
         WHERE ${isCheckinPrompt}
           AND c.created_at >= NOW() - make_interval(days => $1) AND ${patientScope}
         GROUP BY 1 ORDER BY 1`, checkinParams),
      pool.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE f.priority = 'urgent') AS urgent,
                COUNT(*) FILTER (WHERE f.status = 'open') AS open,
                COUNT(DISTINCT f.patient_id) FILTER (WHERE f.flag_type = 'missed_dose') AS patients_with_missed_dose,
                ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (f.resolved_at - f.created_at)) / 3600)
                       FILTER (WHERE f.resolved_at IS NOT NULL))::numeric, 1) AS median_hours_to_resolve
         FROM flags f JOIN patients p ON p.id = f.patient_id
         WHERE f.created_at >= NOW() - make_interval(days => $1) AND ${patientScope}`, params),
      pool.query(
        `SELECT f.flag_type, COUNT(*) AS count
         FROM flags f JOIN patients p ON p.id = f.patient_id
         WHERE f.created_at >= NOW() - make_interval(days => $1) AND ${patientScope}
         GROUP BY 1 ORDER BY 2 DESC`, params),
      pool.query(
        `SELECT COALESCE(d.name, 'Unassigned') AS doctor, COUNT(DISTINCT p.id) AS patients,
                COUNT(f.id) FILTER (WHERE f.status = 'open') AS open_flags,
                COUNT(f.id) FILTER (WHERE f.flag_type = 'missed_dose') AS missed_dose_flags
         FROM patients p
         LEFT JOIN doctors d ON d.id = p.assigned_doctor_id
         LEFT JOIN flags f ON f.patient_id = p.id AND f.created_at >= NOW() - make_interval(days => $1)
         WHERE ${patientScope}
         GROUP BY d.id, d.name ORDER BY patients DESC`, params),
    ]);

    const n = (v) => Number(v) || 0;
    const sent = n(checkins.rows[0].sent);
    const answered = n(checkins.rows[0].answered);
    return res.status(200).json({
      success: true,
      data: {
        period_days: days,
        patients: {
          total: n(totals.rows[0].patients),
          enrolled_in_period: n(totals.rows[0].enrolled_in_period),
          kill_switch: n(totals.rows[0].kill_switch_patients),
          abha_linked: n(totals.rows[0].abha_linked),
          bed_linked: n(totals.rows[0].bed_linked),
        },
        checkins: {
          sent,
          answered,
          response_rate: sent ? Math.round((answered / sent) * 1000) / 10 : null,
          patients_checked_in: n(checkins.rows[0].patients_checked_in),
        },
        daily: daily.rows.map((r) => ({ day: r.day, sent: n(r.sent), answered: n(r.answered) })),
        flags: {
          total: n(flags.rows[0].total),
          urgent: n(flags.rows[0].urgent),
          open: n(flags.rows[0].open),
          patients_with_missed_dose: n(flags.rows[0].patients_with_missed_dose),
          median_hours_to_resolve: flags.rows[0].median_hours_to_resolve === null ? null : Number(flags.rows[0].median_hours_to_resolve),
          by_type: byType.rows.map((r) => ({ flag_type: r.flag_type, count: n(r.count) })),
        },
        by_doctor: byDoctor.rows.map((r) => ({
          doctor: r.doctor, patients: n(r.patients), open_flags: n(r.open_flags), missed_dose_flags: n(r.missed_dose_flags),
        })),
      },
    });
  } catch (error) {
    console.error('Failed to compute adherence analytics:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
