#!/usr/bin/env node

/**
 * Twilio Sync CLI
 * Usage:
 *   node backend/src/cli/sync.js --company-id <uuid> --historical --days 7
 *   node backend/src/cli/sync.js --company-id <uuid> --recent
 */

require('dotenv').config();
const twilioSync = require('../services/twilioSync');

// Parse command line arguments
const args = process.argv.slice(2);
const isHistorical = args.includes('--historical');
const isRecent = args.includes('--recent');
const daysIndex = args.indexOf('--days');
const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1]) : 7;
const companyIndex = args.indexOf('--company-id');
const companyId = companyIndex !== -1 ? args[companyIndex + 1] : null;

async function main() {
    console.log('🚀 Twilio Sync CLI\n');
    if (!companyId) throw Object.assign(new Error('--company-id is required'), { code: 'TWILIO_TENANT_UNRESOLVED' });

    if (isHistorical) {
        console.log(`📅 Syncing historical calls (last ${days} days)...\n`);
        const result = await twilioSync.syncHistoricalCalls(days, companyId);
        console.log('\n📊 Results:', result);
    } else if (isRecent) {
        console.log('🔄 Syncing recent calls (last hour)...\n');
        const synced = await twilioSync.syncRecentCalls(companyId);
        console.log(`\n✅ Synced ${synced} recent calls`);
    } else {
        console.log('Usage:');
        console.log('  Sync historical: node backend/src/cli/sync.js --company-id <uuid> --historical --days 7');
        console.log('  Sync recent:     node backend/src/cli/sync.js --company-id <uuid> --recent');
        process.exit(1);
    }

    process.exit(0);
}

main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
});
