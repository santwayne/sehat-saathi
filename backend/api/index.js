// Vercel serverless entrypoint. No app.listen() here — Vercel wraps this
// exported Express app as a request handler per invocation.
module.exports = require('../src/app');
