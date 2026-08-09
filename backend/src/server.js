require('dotenv').config();
const express = require('express');
const cors = require('cors');

const whatsappRoutes = require('./routes/whatsapp.routes');
const prescriptionRoutes = require('./routes/prescriptions.routes');
const flagRoutes = require('./routes/flags.routes');
const { scanAndScheduleDueCheckins } = require('./services/scheduler.service');
const { reassignStaleFlags } = require('./services/escalation.service');

const app = express();
app.use(cors());
app.use(express.json());

// Basic health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount API routes
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/flags', flagRoutes);

// Run the check-in scanner every 15 minutes
setInterval(() => {
  scanAndScheduleDueCheckins();
}, 15 * 60 * 1000);

// Fall back stale open flags to the coordinator queue every 30 minutes (Section 5)
setInterval(() => {
  reassignStaleFlags();
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Sehat Saathi API active on port ${PORT}`));
