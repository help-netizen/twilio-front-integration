const { reconcileCall } = require('./reconcileService');

/**
 * Twilio Sync Service (v3)
 *
 * Delegates to reconcileService for actual call processing.
 * This file provides the sync trigger endpoints used by /api/sync routes.
 */

async function getSyncClient(companyId) {
    if (!companyId) {
        const err = new Error('companyId is required for Twilio sync');
        err.code = 'TWILIO_TENANT_UNRESOLVED';
        throw err;
    }
    const tenant = await require('./telephonyTenantService').getClientForCompany(companyId);
    return { ...tenant, companyId };
}

/**
 * Sync historical calls from Twilio
 */
async function syncHistoricalCalls(days = 7, companyId) {
    const tenant = await getSyncClient(companyId);
    if (tenant.mode !== 'master') {
        const err = new Error('Historical cold reconcile currently supports only the explicit master tenant');
        err.code = 'TWILIO_SYNC_MODE_UNSUPPORTED';
        throw err;
    }
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
async function syncRecentCalls(companyId) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - 1);

    console.log('📞 Syncing recent calls (last 1h)...');

    let synced = 0;
    try {
        const tenant = await getSyncClient(companyId);
        const calls = await tenant.client.calls.list({
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
                    AccountSid: tenant.accountSid,
                };
                await reconcileCall(twilioPayload, 'sync_recent', tenant.companyId);
                synced++;
                await new Promise(r => setTimeout(r, 100));
            } catch (error) {
                console.error(`  ✗ ${call.sid}:`, error.message);
            }
        }

        console.log(`✅ Synced ${synced} recent calls`);
    } catch (error) {
        if (error.code === 'TWILIO_TENANT_UNRESOLVED') throw error;
        console.error('❌ syncRecentCalls failed:', error);
    }

    return synced;
}

/**
 * Sync today's calls (last 3 days, as per original behavior)
 */
async function syncTodayCalls(companyId) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 3);

    console.log('📞 Syncing last 3 days of calls...');

    let synced = 0;
    let skipped = 0;
    let total = 0;

    try {
        const tenant = await getSyncClient(companyId);
        const calls = await tenant.client.calls.list({
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
                    AccountSid: tenant.accountSid,
                };
                await reconcileCall(twilioPayload, 'sync_today', tenant.companyId);
                synced++;
                await new Promise(r => setTimeout(r, 100));
            } catch (error) {
                console.error(`  ✗ ${call.sid}:`, error.message);
                skipped++;
            }
        }

        console.log(`✅ Today sync: ${synced}/${total} (${skipped} skipped)`);
    } catch (error) {
        if (error.code === 'TWILIO_TENANT_UNRESOLVED') throw error;
        console.error('❌ syncTodayCalls failed:', error);
    }

    return { synced, skipped, total };
}

module.exports = {
    syncHistoricalCalls,
    syncRecentCalls,
    syncTodayCalls,
};
