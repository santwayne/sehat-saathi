// Entrypoint for a persistent process (AWS EC2, Railway, etc.) — runs the
// BullMQ scheduler worker and periodic scans in-process. For serverless
// (Vercel) deployment, see api/index.js and vercel.json's cron config instead,
// which hit /api/cron/* on a schedule rather than running setInterval.
const app = require('./app');
const { scanAndScheduleDueCheckins } = require('./services/scheduler.service');
const { reassignStaleFlags } = require('./services/escalation.service');
const { sendWeeklyDigests } = require('./services/family.service');
const { sendDueRefillReminders } = require('./services/refill.service');

// Run the check-in scanner every 15 minutes
setInterval(() => {
  scanAndScheduleDueCheckins();
}, 15 * 60 * 1000);

// Fall back stale open flags to the coordinator queue every 30 minutes (Section 5)
setInterval(() => {
  reassignStaleFlags();
}, 30 * 60 * 1000);

// Family digests (last_digest_at keeps it to once per ~week per member) and
// refill reminders (one per prescription) are both safe to scan often.
setInterval(() => {
  sendWeeklyDigests().catch((err) => console.error('Family digest scan failed:', err));
  sendDueRefillReminders().catch((err) => console.error('Refill reminder scan failed:', err));
}, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Sehat Saathi API active on port ${PORT}`));
