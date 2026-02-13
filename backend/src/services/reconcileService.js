const twilio = require('twilio');
const queries = require('../db/queries');
const { normalizeVoiceEvent } = require('./inboxWorker');
const CallProcessor = require('./callProcessor');
const { extractPhoneFromSIP } = require('./callProcessor');

/**
 * Reconciliation Service (v3)
 * 
 * Polls Twilio API to reconcile call states and catch missed webhooks.
 * - Hot:  Active (non-final) calls — poll every 1min
 * - Warm: Recent final calls (last 6h) — poll every 15min
 * - Cold: Historical backfill — on demand
 */

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

const RECONCILE_CONFIG = {
    HOT: {
        INTERVAL_MS: 60000,
        BATCH_SIZE: 50,
        MAX_AGE_HOURS: 24,
    },
    WARM: {
        INTERVAL_MS: 900000,
        BATCH_SIZE: 100,
        COOLDOWN_HOURS: 6,
    },
    COLD: {
        BATCH_SIZE: 200,
        LOOKBACK_DAYS: 90,
    },
};

/**
 * Fetch call details from Twilio API and return normalized payload
 */
function twilioCallToPayload(call) {
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
        PriceUnit: call.priceUnit,
    };
}

async function fetchCallFromTwilio(callSid) {
    const call = await twilioClient.calls(callSid).fetch();
    return twilioCallToPayload(call);
}

/**
 * Reconcile a single call from Twilio API data
 */
async function reconcileCall(twilioPayload, source) {
    const normalized = normalizeVoiceEvent(twilioPayload);

    // Resolve contact
    const callData = {
        from: normalized.fromNumber,
        to: normalized.toNumber,
        direction: normalized.direction,
        status: normalized.eventStatus,
        duration: normalized.durationSec,
        parentCallSid: normalized.parentCallSid,
    };
    const processed = CallProcessor.processCall(callData);
    const externalParty = processed.externalParty;

    let contactId = null;
    if (externalParty?.formatted && processed.direction !== 'internal') {
        const contact = await queries.findOrCreateContact(externalParty.formatted);
        contactId = contact.id;
    }

    const { isFinalStatus } = require('./stateMachine');
    const isFinal = isFinalStatus(normalized.eventStatus);

    const call = await queries.upsertCall({
        callSid: normalized.callSid,
        parentCallSid: normalized.parentCallSid,
        contactId,
        direction: processed.direction,
        fromNumber: extractPhoneFromSIP(normalized.fromNumber),
        toNumber: extractPhoneFromSIP(normalized.toNumber),
        status: normalized.eventStatus,
        isFinal,
        startedAt: normalized.eventTime,
        answeredAt: normalized.eventStatus === 'in-progress' ? normalized.eventTime : null,
        endedAt: isFinal ? normalized.eventTime : null,
        durationSec: normalized.durationSec || null,
        price: normalized.price,
        priceUnit: normalized.priceUnit,
        lastEventTime: normalized.eventTime,
        rawLastPayload: twilioPayload,
    });

    // Append immutable event
    await queries.appendCallEvent(
        normalized.callSid,
        'call.status_changed',
        normalized.eventTime,
        { ...normalized, source }
    );

    // Publish SSE event for real-time UI updates
    if (call) {
        try {
            const realtimeService = require('./realtimeService');
            realtimeService.publishCallUpdate({
                eventType: 'call.updated',
                call_sid: call.call_sid,
                status: call.status,
                is_final: call.is_final,
            });
        } catch (e) {
            // SSE publish is best-effort
        }
    }

    // Reconcile parent call from child legs (same logic as inboxWorker)
    const { reconcileParentCall } = require('./inboxWorker');
    if (normalized.parentCallSid && isFinal) {
        await reconcileParentCall(normalized.parentCallSid, source);
    }
    // Also reconcile if THIS is the parent reaching final
    if (!normalized.parentCallSid && isFinal) {
        await reconcileParentCall(normalized.callSid, source);
    }

    return call;
}

// =============================================================================
// Hot Reconcile — active (non-final) calls
// =============================================================================

async function hotReconcile() {
    console.log('🔥 Hot reconcile...');
    const startTime = Date.now();
    let processed = 0, updated = 0, errors = 0;

    try {
        const calls = await queries.getNonFinalCalls(RECONCILE_CONFIG.HOT.MAX_AGE_HOURS);
        console.log(`   ${calls.length} active calls`);

        for (const dbCall of calls) {
            try {
                const twilioPayload = await fetchCallFromTwilio(dbCall.call_sid);
                const result = await reconcileCall(twilioPayload, 'reconcile_hot');

                if (result && result.status !== dbCall.status) {
                    console.log(`   ✓ ${dbCall.call_sid}: ${dbCall.status} → ${result.status}`);
                    updated++;
                }
                processed++;
                await new Promise(r => setTimeout(r, 100));
            } catch (error) {
                console.error(`   ✗ ${dbCall.call_sid}:`, error.message);
                errors++;
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`✅ Hot: ${processed}/${updated}/${errors} (${elapsed}ms)`);

        await queries.upsertSyncState('reconcile_hot', { last_run: new Date() });
        return { processed, updated, errors };
    } catch (error) {
        console.error('❌ Hot reconcile failed:', error);
        await queries.upsertSyncState('reconcile_hot', {}, error.message);
        throw error;
    }
}

// =============================================================================
// Cold Reconcile — historical backfill
// =============================================================================

async function coldReconcile(startDate, endDate, pageSize = RECONCILE_CONFIG.COLD.BATCH_SIZE) {
    console.log(`❄️  Cold reconcile: ${startDate.toISOString()} → ${endDate.toISOString()}`);
    let processed = 0, created = 0, updated = 0, errors = 0;

    try {
        let page = 0;
        let hasMore = true;

        while (hasMore) {
            console.log(`   Page ${page + 1}...`);
            const calls = await twilioClient.calls.list({
                startTimeAfter: startDate,
                startTimeBefore: endDate,
                pageSize,
                page,
            });

            if (calls.length === 0) { hasMore = false; break; }

            for (const call of calls) {
                try {
                    const twilioPayload = twilioCallToPayload(call);
                    const existing = await queries.getCallByCallSid(call.sid);
                    await reconcileCall(twilioPayload, 'reconcile_cold');

                    if (existing) { updated++; } else { created++; }
                    processed++;

                    if (processed % 50 === 0) {
                        console.log(`   Progress: ${processed}`);
                    }
                    await new Promise(r => setTimeout(r, 100));
                } catch (error) {
                    console.error(`   ✗ ${call.sid}:`, error.message);
                    errors++;
                }
            }

            page++;
            if (page >= 10) {
                console.warn('   ⚠️  Max pages reached');
                hasMore = false;
            }
        }

        console.log(`✅ Cold: ${processed} (${created} new, ${updated} updated, ${errors} errors)`);
        await queries.upsertSyncState('reconcile_cold', { last_date: endDate });
        return { processed, created, updated, errors };
    } catch (error) {
        console.error('❌ Cold reconcile failed:', error);
        await queries.upsertSyncState('reconcile_cold', {}, error.message);
        throw error;
    }
}

module.exports = {
    hotReconcile,
    coldReconcile,
    fetchCallFromTwilio,
    reconcileCall,
    RECONCILE_CONFIG,
};
