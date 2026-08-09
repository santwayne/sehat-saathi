const express = require('express');
const router = express.Router();
const { pool } = require('../db');

/**
 * GET /api/clinics/:id
 * Read-only clinic info for the Settings page.
 */
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clinics WHERE id = $1', [req.params.id]);
    if (!rows[0]) {
      return res.status(404).json({ error: 'Clinic not found.' });
    }
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Failed to fetch clinic:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
