const express = require('express');
const router = express.Router();
const { pool } = require('../db');

/**
 * POST /api/pilot-requests
 * Public endpoint backing the marketing site's "Request a Pilot" form. No auth
 * (it's a public lead-capture form), but only writes — never returns other
 * submitters' data.
 */
router.post('/', async (req, res) => {
  const { contact_name, clinic_name, contact_info, patient_volume_estimate, message } = req.body;

  if (!contact_name || !clinic_name || !contact_info) {
    return res.status(400).json({ error: 'contact_name, clinic_name, and contact_info are required.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO pilot_requests (contact_name, clinic_name, contact_info, patient_volume_estimate, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [contact_name, clinic_name, contact_info, patient_volume_estimate || null, message || null]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to save pilot request:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
