require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { attachUser } = require('./services/auth.service');
const authRoutes = require('./routes/auth.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');
const prescriptionRoutes = require('./routes/prescriptions.routes');
const flagRoutes = require('./routes/flags.routes');
const patientRoutes = require('./routes/patients.routes');
const staffRoutes = require('./routes/staff.routes');
const doctorRoutes = require('./routes/doctors.routes');
const clinicRoutes = require('./routes/clinics.routes');
const pilotRequestRoutes = require('./routes/pilot-requests.routes');
const cronRoutes = require('./routes/cron.routes');
const bedRoutes = require('./routes/beds.routes');
const pharmacyRoutes = require('./routes/pharmacy.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const voiceRoutes = require('./routes/voice.routes');
const adminRoutes = require('./routes/admin.routes');
const breakGlassRoutes = require('./routes/break-glass.routes');
const { patientDataGuard } = require('./services/break-glass.service');
const { ensureIntegrationsLoaded } = require('./services/integrations.service');

const app = express();
app.use(cors());
app.use(express.json());
app.use(attachUser);
// Applies keys saved in Super Admin → Integrations on top of env vars.
app.use(ensureIntegrationsLoaded);

// Basic health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/whatsapp', whatsappRoutes);
// Patient data: authenticated staff only; Super Admin only via an approved,
// read-only break-glass grant (see services/break-glass.service.js).
app.use('/api/prescriptions', patientDataGuard, prescriptionRoutes);
app.use('/api/flags', patientDataGuard, flagRoutes);
app.use('/api/patients', patientDataGuard, patientRoutes);
app.use('/api/refill-orders', patientDataGuard);
app.use('/api/staff', staffRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/clinics', clinicRoutes);
app.use('/api/pilot-requests', pilotRequestRoutes);
app.use('/api/beds', bedRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/break-glass', breakGlassRoutes);
// /api/pharmacy-partners and /api/refill-orders
app.use('/api', pharmacyRoutes);
// Cron-triggered endpoints (Vercel Cron hits these — see vercel.json). On AWS,
// server.js's setInterval calls do the same work directly instead.
app.use('/api/cron', cronRoutes);

module.exports = app;
