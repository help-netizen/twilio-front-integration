'use strict';

// VAPI-AGENCY-001 T5: tenant-facing provider management was retired. Keep an
// empty router only until the protected src/server.js import/mount is removed by
// the separately reviewed shell patch; every former /api/vapi management route
// therefore resolves as 404 and performs no database or provider work.
const express = require('express');

module.exports = express.Router();
