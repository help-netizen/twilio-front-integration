const twilio = require('twilio');
const db = require('../db/connection');
const { normalizeVoiceEvent, upsertMessage, appendCallEvent } = require('./inboxWorker');

/**
 * Reconciliation Service
 * 
 * Polls Twilio API to reconcile call states and catch missed webhooks.
 * Three strategies:
 * - Hot: Active calls (non-final) - poll every 1-5min
 * - Warm: Recent final calls (last 6h) - poll every 15min-1h
 * - Cold: Historical calls - one-time backfill on demand
 */

// Initialize Twilio client
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

/**
 * Configuration
 */
const RECONCILE_CONFIG = {
    HOT: {
        INTERVAL_MS: 60000,        // 1 minute
        BATCH_SIZE: 50,            // Calls to process per run
        MAX_AGE_HOURS: 24          // Only reconcile calls < 24h old
    },
    WARM: {
        INTERVAL_MS: 900000,       // 15 minutes
        BATCH_SIZE: 100,
        COOLDOWN_HOURS: 6          // Final calls within 6h
    },
    COLD: {
        BATCH_SIZE: 200,
        LOOKBACK_DAYS: 90          // Default lookback period
    }
};

/**
 * Fetch call details from Twilio API
 */
async function fetchCallFromTwilio(callSid) {
    try {
        const call = await twilioClient.calls(callSid).fetch();

        return {
            CallSid: call.sid,
            CallStatus: call.status,
            Timestamp: Math.floor(new Date(call.dateCreated).getTime() / 1000).toString(),
            From: call.from,
            To: call.to,
            Direction: call.direction,
            Duration: call.duration?.toString() || '0',
            ParentCallSid: call.parentCallSid,
            AnsweredBy: call.answeredBy,
            Price: call.price,
            PriceUnit: call.priceUnit
        };
    } catch (error) {
        console.error(`Failed to fetch call ${callSid}:`, error.message);
        throw error;
    }
}

/**
 * Hot Reconcile - Active calls only
 * Fetches non-final calls from DB and polls Twilio for updates
 */
async function hotReconcile() {
    console.log('🔥 Starting hot reconcile...');

    const startTime = Date.now();
    let processed = 0;
    let updated = 0;
    let errors = 0;

    try {
        // Get active (non-final) calls from DB
        const result = await db.query(`
            SELECT twilio_sid, status, updated_at
            FROM messages
            WHERE is_final = false
              AND start_time > NOW() - INTERVAL '${RECONCILE_CONFIG.HOT.MAX_AGE_HOURS} hours'
              AND (sync_state IS NULL OR sync_state = 'active')
            ORDER BY updated_at DESC
            LIMIT $1
        `, [RECONCILE_CONFIG.HOT.BATCH_SIZE]);

        const calls = result.rows;
        console.log(`   Found ${calls.length} active calls to reconcile`);

        for (const call of calls) {
            try {
                // Fetch from Twilio
                const twilioData = await fetchCallFromTwilio(call.twilio_sid);

                // Normalize and upsert
                const normalized = normalizeVoiceEvent(twilioData);
                const updatedMessage = await upsertMessage(normalized, 'reconcile_hot');

                // Append to event log
                await appendCallEvent(normalized, 'reconcile_hot');

                // Check if status changed
                if (updatedMessage.status !== call.status) {
                    console.log(`   ✓ ${call.twilio_sid}: ${call.status} → ${updatedMessage.status}`);
                    updated++;
                }

                processed++;

                // Rate limiting: 10 requests/second max
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                console.error(`   ✗ Error reconciling ${call.twilio_sid}:`, error.message);
                errors++;
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`✅ Hot reconcile complete: ${processed} processed, ${updated} updated, ${errors} errors (${elapsed}ms)`);

        // Update sync state cursor
        await updateSyncCursor('hot_reconcile', new Date());

        return { processed, updated, errors };

    } catch (error) {
        console.error('❌ Hot reconcile failed:', error);
        throw error;
    }
}

/**
 * Warm Reconcile - Recent final calls
 * Double-checks final calls within cooldown period
 */
async function warmReconcile() {
    console.log('🌡️  Starting warm reconcile...');

    const startTime = Date.now();
    let processed = 0;
    let updated = 0;
    let errors = 0;

    try {
        // Get final calls within cooldown period
        const result = await db.query(`
            SELECT twilio_sid, status, finalized_at
            FROM messages
            WHERE is_final = true
              AND finalized_at IS NOT NULL
              AND finalized_at > NOW() - INTERVAL '${RECONCILE_CONFIG.WARM.COOLDOWN_HOURS} hours'
              AND (sync_state IS NULL OR sync_state = 'active')
            ORDER BY finalized_at DESC
            LIMIT $1
        `, [RECONCILE_CONFIG.WARM.BATCH_SIZE]);

        const calls = result.rows;
        console.log(`   Found ${calls.length} warm calls to reconcile`);

        for (const call of calls) {
            try {
                const twilioData = await fetchCallFromTwilio(call.twilio_sid);
                const normalized = normalizeVoiceEvent(twilioData);
                const updatedMessage = await upsertMessage(normalized, 'reconcile_warm');

                await appendCallEvent(normalized, 'reconcile_warm');

                if (updatedMessage.status !== call.status) {
                    console.log(`   ⚠️  Final call status changed: ${call.twilio_sid}: ${call.status} → ${updatedMessage.status}`);
                    updated++;
                }

                processed++;
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                console.error(`   ✗ Error reconciling ${call.twilio_sid}:`, error.message);
                errors++;
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`✅ Warm reconcile complete: ${processed} processed, ${updated} updated, ${errors} errors (${elapsed}ms)`);

        await updateSyncCursor('warm_reconcile', new Date());

        return { processed, updated, errors };

    } catch (error) {
        console.error('❌ Warm reconcile failed:', error);
        throw error;
    }
}

/**
 * Cold Reconcile - Historical backfill
 * Polls Twilio API for calls in date range (used for initial sync or recovering from outages)
 */
async function coldReconcile(startDate, endDate, pageSize = RECONCILE_CONFIG.COLD.BATCH_SIZE) {
    console.log('❄️  Starting cold reconcile...');
    console.log(`   Date range: ${startDate.toISOString()} → ${endDate.toISOString()}`);

    let processed = 0;
    let created = 0;
    let updated = 0;
    let errors = 0;

    try {
        // Fetch calls from Twilio with pagination
        let page = 0;
        let hasMore = true;

        while (hasMore) {
            console.log(`   Fetching page ${page + 1}...`);

            const calls = await twilioClient.calls.list({
                startTimeAfter: startDate,
                startTimeBefore: endDate,
                pageSize: pageSize,
                page: page
            });

            if (calls.length === 0) {
                hasMore = false;
                break;
            }

            for (const call of calls) {
                try {
                    const twilioData = {
                        CallSid: call.sid,
                        CallStatus: call.status,
                        Timestamp: Math.floor(new Date(call.dateCreated).getTime() / 1000).toString(),
                        From: call.from,
                        To: call.to,
                        Direction: call.direction,
                        Duration: call.duration?.toString() || '0',
                        ParentCallSid: call.parentCallSid,
                        AnsweredBy: call.answeredBy,
                        Price: call.price,
                        PriceUnit: call.priceUnit
                    };

                    const normalized = normalizeVoiceEvent(twilioData);

                    // Check if call exists
                    const existing = await db.query(
                        'SELECT id, status FROM messages WHERE twilio_sid = $1',
                        [call.sid]
                    );

                    const isNew = existing.rows.length === 0;

                    await upsertMessage(normalized, 'reconcile_cold');
                    await appendCallEvent(normalized, 'reconcile_cold');

                    if (isNew) {
                        created++;
                    } else {
                        updated++;
                    }

                    processed++;

                    if (processed % 50 === 0) {
                        console.log(`   Progress: ${processed} calls processed`);
                    }

                    // Rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));

                } catch (error) {
                    console.error(`   ✗ Error processing call ${call.sid}:`, error.message);
                    errors++;
                }
            }

            page++;

            // Safety: max 10 pages to avoid infinite loop
            if (page >= 10) {
                console.warn('   ⚠️  Reached max page limit (10), stopping');
                hasMore = false;
            }
        }

        console.log(`✅ Cold reconcile complete: ${processed} processed (${created} created, ${updated} updated, ${errors} errors)`);

        await updateSyncCursor('cold_reconcile', endDate);

        return { processed, created, updated, errors };

    } catch (error) {
        console.error('❌ Cold reconcile failed:', error);
        throw error;
    }
}

/**
 * Update sync state cursor
 */
async function updateSyncCursor(jobType, lastSync) {
    await db.query(`
        INSERT INTO sync_state (job_type, last_sync, status)
        VALUES ($1, $2, 'completed')
        ON CONFLICT (job_type) DO UPDATE SET
            last_sync = EXCLUDED.last_sync,
            status = EXCLUDED.status,
            updated_at = NOW()
    `, [jobType, lastSync]);
}

/**
 * Get last sync time for job type
 */
async function getLastSync(jobType) {
    const result = await db.query(
        'SELECT last_sync FROM sync_state WHERE job_type = $1',
        [jobType]
    );
    return result.rows[0]?.last_sync || null;
}

module.exports = {
    hotReconcile,
    warmReconcile,
    coldReconcile,
    fetchCallFromTwilio,
    updateSyncCursor,
    getLastSync,
    RECONCILE_CONFIG
};
