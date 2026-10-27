const express = require('express');
const router = express.Router();
const { sendDueCheckinsDirectly } = require('../services/checkin-direct.service');
const { reassignStaleFlags } = require('../services/escalation.service');
const { sendWeeklyDigests } = require('../services/family.service');
const { sendDueRefillReminders } = require('../services/refill.service');

// Vercel Cron (see vercel.json) calls these on a schedule and sends this header
// automatically; reject anything else so the endpoints can't be triggered by
// randoms hitting a public URL.
function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (expected && req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.get('/checkins', requireCronSecret, async (req, res) => {
  try {
    const result = await sendDueCheckinsDirectly();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Cron check-in run failed:', error);
    return res.status(500).json({ error: 'Check-in run failed' });
  }
});

router.get('/reassign-flags', requireCronSecret, async (req, res) => {
  try {
    await reassignStaleFlags();
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Cron flag reassignment failed:', error);
    return res.status(500).json({ error: 'Flag reassignment failed' });
  }
});

router.get('/family-digest', requireCronSecret, async (req, res) => {
  try {
    const result = await sendWeeklyDigests();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Cron family digest failed:', error);
    return res.status(500).json({ error: 'Family digest run failed' });
  }
});

router.get('/refill-reminders', requireCronSecret, async (req, res) => {
  try {
    const result = await sendDueRefillReminders();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Cron refill reminders failed:', error);
    return res.status(500).json({ error: 'Refill reminder run failed' });
  }
});

module.exports = router;
