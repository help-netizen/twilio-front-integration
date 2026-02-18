#!/usr/bin/env node
/**
 * Contacts Sync CLI
 * 
 * Syncs Zenbooker customers → local contacts table.
 * Designed to be run as a cron job (hourly).
 * 
 * Usage: node backend/src/cli/syncContacts.js
 */

require('dotenv').config();

const { runSync } = require('../services/contactsSyncService');

async function main() {
    console.log(`[syncContacts] Starting at ${new Date().toISOString()}`);

    try {
        const result = await runSync();
        console.log(`[syncContacts] Completed — upserted: ${result.upserted}, errors: ${result.errors}, elapsed: ${result.elapsed}s`);
        process.exit(0);
    } catch (err) {
        console.error(`[syncContacts] Fatal error:`, err);
        process.exit(1);
    }
}

main();
