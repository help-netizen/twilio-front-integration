#!/usr/bin/env node

/**
 * Hot Reconcile CLI
 * 
 * Reconciles active (non-final) calls by polling Twilio API.
 * Run frequently (every 1-5 minutes) to catch status changes.
 * 
 * Usage:
 *   node backend/src/cli/reconcileHot.js
 * 
 * Cron:
 *   */1 * * * * node / path / to / backend / src / cli / reconcileHot.js
    */

require('dotenv').config();
const { hotReconcile } = require('../services/reconcileService');

console.log('🔥 Hot Reconcile - Starting...\n');

hotReconcile()
    .then(result => {
        console.log('\n📊 Summary:', result);
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    });
