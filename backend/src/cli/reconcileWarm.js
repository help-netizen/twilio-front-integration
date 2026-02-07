#!/usr/bin/env node

/**
 * Warm Reconcile CLI
 * 
 * Reconciles recent final calls within cooldown period (6h).
 * Run periodically (every 15-60 minutes) to verify final states.
 * 
 * Usage:
 *   node backend/src/cli/reconcileWarm.js
 * 
 * Cron:
 *   */15 * * * * node / path / to / backend / src / cli / reconcileWarm.js
    */

require('dotenv').config();
const { warmReconcile } = require('../services/reconcileService');

console.log('🌡️  Warm Reconcile - Starting...\n');

warmReconcile()
    .then(result => {
        console.log('\n📊 Summary:', result);
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    });
