'use strict';
/** Standalone HTTP service for SLOT-ENGINE-001. POST /api/v1/slot-recommendations. */
const express = require('express');
const { recommendSlots } = require('./engine');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'slot-engine', version: '0.1.0' }));

app.post('/api/v1/slot-recommendations', (req, res) => {
  const body = req.body || {};
  if (!body.new_request || body.new_request.lat == null || body.new_request.lng == null) {
    return res.status(400).json({
      request_id: body.request_id,
      error: { code: 'location_not_found', message: 'new_request.lat/lng are required (geocode upstream).' },
    });
  }
  try {
    res.json(recommendSlots(body));
  } catch (err) {
    res.status(500).json({ request_id: body.request_id, error: { code: 'engine_error', message: err.message } });
  }
});

if (require.main === module) {
  const port = process.env.PORT || 4500;
  app.listen(port, () => console.log(`slot-engine listening on :${port}`));
}

module.exports = app;
