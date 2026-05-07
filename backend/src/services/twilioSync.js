const { getTwilioClient } = require('./twilioClient');
const { reconcileCall, RECONCILE_CONFIG } = require('./reconcileService');

/**
 * Twilio Sync Service (v3)
 *
 * Delegates to reconcileService for actual call processing.
 * This file provides the sync trigger endpoints used by /api/sync routes.
 */

// Lazy proxy resolves the shared singleton on each property access.
const client = new Proxy({}, {
    get(_t, prop) {
        return getTwilioClient()[prop];
    },
});

/**
 * Sync historical calls from Twilio
 */
async function syncHistoricalCalls(days = 7) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    console.log(`📞 Syncing calls for last ${days} days...`);

    const { coldReconcile } = require('./reconcileService');
    return await coldReconcile(startDate, endDate);
}

/**
 * Sync recent calls (last hour)
 */
async function syncRecentCalls() {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - 1);

    console.log('📞 Syncing recent calls (last 1h)...');

    let synced = 0;
    try {
        const calls = await client.calls.list({
            startTimeAfter: startDate,
            startTimeBefore: endDate,
            pageSize: 100,
        });

        for (const call of calls) {
            try {
                const twilioPayload = {
                    CallSid: call.sid,
                    CallStatus: call.status,
                    Timestamp: Math.floor(new Date(call.dateCreated).getTime() / 1000).toString(),
                    From: call.from,
                    To: call.to,
                    Direction: call.direction,
                    Duration: call.duration?.toString() || '0',
                    ParentCallSid: call.parentCallSid,
                    Price: call.price,
                    PriceUnit: call.priceUnit,
                };
                await reconcileCall(twilioPayload, 'sync_recent');
                synced++;
                await new Promise(r => setTimeout(r, 100));
            } catch (error) {
                console.error(`  ✗ ${call.sid}:`, error.message);
            }
        }

        console.log(`✅ Synced ${synced} recent calls`);
    } catch (error) {
        console.error('❌ syncRecentCalls failed:', error);
    }

    return synced;
}

/**
 * Sync today's calls (last 3 days, as per original behavior)
 */
async function syncTodayCalls() {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 3);

    console.log('📞 Syncing last 3 days of calls...');

    let synced = 0;
    let skipped = 0;
    let total = 0;

    try {
        const calls = await client.calls.list({
            startTimeAfter: startDate,
            startTimeBefore: endDate,
            pageSize: 200,
        });

        total = calls.length;
        console.log(`   Found ${total} calls`);

        for (const call of calls) {
            try {
                const twilioPayload = {
                    CallSid: call.sid,
                    CallStatus: call.status,
                    Timestamp: Math.floor(new Date(call.dateCreated).getTime() / 1000).toString(),
                    From: call.from,
                    To: call.to,
                    Direction: call.direction,
                    Duration: call.duration?.toString() || '0',
                    ParentCallSid: call.parentCallSid,
                    Price: call.price,
                    PriceUnit: call.priceUnit,
                };
                await reconcileCall(twilioPayload, 'sync_today');
                synced++;
                await new Promise(r => setTimeout(r, 100));
            } catch (error) {
                console.error(`  ✗ ${call.sid}:`, error.message);
                skipped++;
            }
        }

        console.log(`✅ Today sync: ${synced}/${total} (${skipped} skipped)`);
    } catch (error) {
        console.error('❌ syncTodayCalls failed:', error);
    }

    return { synced, skipped, total };
}

module.exports = {
    syncHistoricalCalls,
    syncRecentCalls,
    syncTodayCalls,
};
