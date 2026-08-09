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

const app = express();
app.use(cors());
app.use(express.json());
app.use(attachUser);

// Basic health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/flags', flagRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/clinics', clinicRoutes);
app.use('/api/pilot-requests', pilotRequestRoutes);
// Cron-triggered endpoints (Vercel Cron hits these — see vercel.json). On AWS,
// server.js's setInterval calls do the same work directly instead.
app.use('/api/cron', cronRoutes);

module.exports = app;
