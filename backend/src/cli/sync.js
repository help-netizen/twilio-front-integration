#!/usr/bin/env node

/**
 * Twilio Sync CLI
 * Usage:
 *   node backend/src/cli/sync.js --historical --days 7
 *   node backend/src/cli/sync.js --recent
 */

require('dotenv').config();
const twilioSync = require('../services/twilioSync');

// Parse command line arguments
const args = process.argv.slice(2);
const isHistorical = args.includes('--historical');
const isRecent = args.includes('--recent');
const daysIndex = args.indexOf('--days');
const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1]) : 7;

async function main() {
    console.log('🚀 Twilio Sync CLI\n');

    if (isHistorical) {
        console.log(`📅 Syncing historical calls (last ${days} days)...\n`);
        const result = await twilioSync.syncHistoricalCalls(days);
        console.log('\n📊 Results:', result);
    } else if (isRecent) {
        console.log('🔄 Syncing recent calls (last hour)...\n');
        const synced = await twilioSync.syncRecentCalls();
        console.log(`\n✅ Synced ${synced} recent calls`);
    } else {
        console.log('Usage:');
        console.log('  Sync historical: node backend/src/cli/sync.js --historical --days 7');
        console.log('  Sync recent:     node backend/src/cli/sync.js --recent');
        process.exit(1);
    }

    process.exit(0);
}

main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
});
