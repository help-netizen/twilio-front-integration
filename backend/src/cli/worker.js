#!/usr/bin/env node

/**
 * Inbox Worker CLI
 * Processes pending webhook events from twilio_webhook_inbox
 * 
 * Usage:
 *   node backend/src/cli/worker.js
 * 
 * Environment variables:
 *   WORKER_BATCH_SIZE - Number of events to process per cycle (default: 10)
 *   WORKER_POLL_INTERVAL_MS - Poll interval in milliseconds (default: 1000)
 *   WORKER_MAX_RETRIES - Max retry attempts (default: 3)
 */

require('dotenv').config();
const { startWorker, CONFIG } = require('../services/inboxWorker');

// Override config from environment
if (process.env.WORKER_BATCH_SIZE) {
    CONFIG.BATCH_SIZE = parseInt(process.env.WORKER_BATCH_SIZE);
}
if (process.env.WORKER_POLL_INTERVAL_MS) {
    CONFIG.POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS);
}
if (process.env.WORKER_MAX_RETRIES) {
    CONFIG.MAX_RETRIES = parseInt(process.env.WORKER_MAX_RETRIES);
}

console.log('Starting Twilio Inbox Worker...');
console.log('Configuration:', CONFIG);

startWorker().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
