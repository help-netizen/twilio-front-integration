'use strict';

/**
 * Retired legacy mount at /api/settings/notifications.
 *
 * The router intentionally falls through to the reduced notification-policies
 * router mounted at /api/settings, which owns the current GET/PATCH contract.
 * The former company-level GET/PUT boolean adapter no longer responds.
 */

const express = require('express');

module.exports = express.Router();
