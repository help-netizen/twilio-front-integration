#!/usr/bin/env node

/**
 * Cold Reconcile CLI
 * 
 * Historical backfill by polling Twilio API for calls in date range.
 * Use for initial sync or recovering from webhook outages.
 * 
 * Usage:
 *   # Last 7 days
 *   node backend/src/cli/reconcileCold.js --days 7
 * 
 *   # Specific date range
 *   node backend/src/cli/reconcileCold.js --start 2026-01-01 --end 2026-01-31
 * 
 *   # Custom page size
 *   node backend/src/cli/reconcileCold.js --days 30 --page-size 100
 */

require('dotenv').config();
const { coldReconcile } = require('../services/reconcileService');

// Parse command line args
const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : defaultValue;
};

const days = parseInt(getArg('days', '7'));
const startDateArg = getArg('start', null);
const endDateArg = getArg('end', null);
const pageSize = parseInt(getArg('page-size', '200'));

let startDate, endDate;

if (startDateArg && endDateArg) {
    // Use explicit date range
    startDate = new Date(startDateArg);
    endDate = new Date(endDateArg);
} else {
    // Use lookback days
    endDate = new Date();
    startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - days);
}

console.log('❄️  Cold Reconcile - Starting...\n');
console.log(`   Start: ${startDate.toISOString()}`);
console.log(`   End: ${endDate.toISOString()}`);
console.log(`   Page size: ${pageSize}\n`);

coldReconcile(startDate, endDate, pageSize)
    .then(result => {
        console.log('\n📊 Summary:', result);
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    });
