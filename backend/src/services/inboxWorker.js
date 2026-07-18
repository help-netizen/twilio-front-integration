const queries = require('../db/queries');
const db = require('../db/connection');
const { isFinalStatus } = require('./stateMachine');
const CallProcessor = require('./callProcessor');
const { extractPhoneFromSIP } = require('./callProcessor');
const { reconcileStaleCalls } = require('./reconcileStale');
const { getTwilioClient } = require('./twilioClient');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const AI_ANSWERED_BY = 'ai';

function isVapiSipTarget(value) {
    return /^sip:[^@]+@(?:[^@]+\.)*vapi\.ai(?:[?;].*)?$/i.test(String(value || '').trim());
}

async function resolveEventCompanyId(accountSid) {
    try {
        const telephonyTenantService = require('./telephonyTenantService');
        return await telephonyTenantService.resolveCompanyByAccountSid(accountSid)
            || DEFAULT_COMPANY_ID;
    } catch (_) {
        return DEFAULT_COMPANY_ID;
    }
}

/**
 * Configuration
 */
const CONFIG = {
    BATCH_SIZE: 10,
    POLL_INTERVAL_MS: 1000,
    MAX_RETRIES: 10,
    STALE_CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
};

// =============================================================================
// Event normalizers — transform Twilio payload → canonical form
// =============================================================================

function normalizeVoiceEvent(payload) {
    const {
        CallSid, CallStatus, Timestamp, From, To, Direction,
        Duration, CallDuration, ParentCallSid,
        AnsweredBy, CallerName, Price, PriceUnit,
        FromCity, FromState, FromCountry,
        ToCity, ToState, ToCountry,
        RecordingUrl, RecordingSid, RecordingDuration,
        QueueTime,
    } = payload;

    const eventTime = Timestamp && !isNaN(parseInt(Timestamp))
        ? new Date(parseInt(Timestamp) * 1000)
        : new Date();

    // Direction detection via CallProcessor (pass Twilio's own Direction for fallback)
    const direction = CallProcessor.detectDirection({ from: From, to: To, direction: Direction });

    return {
        callSid: CallSid,
        eventType: 'call.status_changed',
        eventStatus: (CallStatus || '').toLowerCase(),
        eventTime,
        fromNumber: From,
        toNumber: To,
        direction,
        durationSec: parseInt(Duration || CallDuration || 0),
        parentCallSid: ParentCallSid || null,
        price: Price ? parseFloat(Price) : null,
        priceUnit: PriceUnit || null,
        metadata: {
            answered_by: AnsweredBy,
            caller_name: CallerName,
            queue_time: QueueTime,
            from_location: { city: FromCity, state: FromState, country: FromCountry },
            to_location: { city: ToCity, state: ToState, country: ToCountry },
            recording_url: RecordingUrl,
            recording_sid: RecordingSid,
            recording_duration: RecordingDuration,
        },
    };
}

function normalizeRecordingEvent(payload) {
    const {
        RecordingSid, CallSid, RecordingStatus,
        RecordingDuration, RecordingUrl, RecordingChannels,
        RecordingTrack, RecordingSource,
        Timestamp,
    } = payload;

    return {
        recordingSid: RecordingSid,
        callSid: CallSid,
        status: (RecordingStatus || '').toLowerCase(),
        recordingUrl: RecordingUrl,
        durationSec: RecordingDuration ? parseInt(RecordingDuration) : null,
        channels: RecordingChannels ? parseInt(RecordingChannels) : null,
        track: RecordingTrack || null,
        source: RecordingSource || null,
        eventTime: Timestamp && !isNaN(parseInt(Timestamp))
            ? new Date(parseInt(Timestamp) * 1000)
            : new Date(),
    };
}

function normalizeTranscriptionEvent(payload) {
    const {
        TranscriptionSid, TranscriptionStatus, TranscriptionText,
        RecordingSid, CallSid,
        LanguageCode, Confidence,
    } = payload;

    return {
        transcriptionSid: TranscriptionSid,
        callSid: CallSid,
        recordingSid: RecordingSid,
        status: (TranscriptionStatus || '').toLowerCase(),
        text: TranscriptionText || null,
        languageCode: LanguageCode || null,
        confidence: Confidence ? parseFloat(Confidence) : null,
        eventTime: new Date(),
    };
}

// =============================================================================
// Process a single inbox event
// =============================================================================

async function processEvent(inboxEvent) {
    const { id, source, event_type, payload } = inboxEvent;
    const traceId = `worker_${id}`;

    console.log(`[${traceId}] Processing`, { source, event_type, callSid: payload.CallSid });

    try {
        if (source === 'dial' && event_type === 'dial.action') {
            await processDialEvent(payload, traceId);
        } else if (source === 'voice' || source === 'dial') {
            await processVoiceEvent(payload, event_type, traceId, source);
        } else if (source === 'recording') {
            await processRecordingEvent(payload, traceId, source);
        } else if (source === 'transcription') {
            await processTranscriptionEvent(payload, traceId, source);
        } else if (source === 'zenbooker') {
            // Zenbooker events are processed inline by the webhook route.
            // Nothing to do here — just mark as processed.
            console.log(`[${traceId}] Zenbooker event — already processed inline, skipping`);
        } else {
            throw new Error(`Unknown source: ${source}`);
        }

        return { success: true };
    } catch (error) {
        console.error(`[${traceId}] Error:`, error.message);
        throw error;
    }
}

// =============================================================================
// Voice event → upsert call + resolve contact
// =============================================================================

async function processVoiceEvent(payload, eventType, traceId, source = 'webhook') {
    const normalized = normalizeVoiceEvent(payload);

    // ALB-107: attribute the event to a tenant by the Twilio AccountSid
    // (subaccount per company). Unknown/legacy accounts stay inside the legacy
    // default tenant instead of falling through to unscoped worker SQL.
    const eventCompanyId = await resolveEventCompanyId(payload.AccountSid);

    // CALL-BLACKLIST-001: the initial TwiML webhook persists blocked calls
    // directly so it can bypass this worker's unread/AR/task behavior. Ignore
    // any later Twilio status callback for that terminal snapshot as well;
    // otherwise a trailing completed/ringing event could create work or
    // overwrite the distinct blocked state.
    let existingCall = null;
    try {
        existingCall = await queries.getCallByCallSid(normalized.callSid, eventCompanyId);
    } catch (e) { /* preserve the existing fail-open worker behavior */ }
    if (existingCall?.status === 'blocked') {
        console.log(`[${traceId}] Ignoring status event for blocked call ${normalized.callSid}`);
        return existingCall;
    }

    // Resolve external party via CallProcessor
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
    const isAnonymous = !!externalParty?.isAnonymous;

    // Resolve timeline (NOT contact — contacts are only created from leads/import/manual)
    let timelineId = null;
    let contactId = null;
    if (processed.direction !== 'internal' && (externalParty?.formatted || isAnonymous)) {
        const timeline = isAnonymous
            ? await queries.findOrCreateAnonymousTimeline(eventCompanyId)
            : await queries.findOrCreateTimeline(externalParty.formatted, eventCompanyId);
        timelineId = timeline.id;
        contactId = timeline.contact_id || null;

        // Mark timeline + contact unread for MISSED inbound calls only.
        // For ANSWERED inbound calls, actively CLEAR unread — an operator (any
        // operator, not necessarily the current user) already talked with the
        // customer, so the timeline shouldn't be flagged unread anymore. This
        // also covers the case where the unread flag was set by an earlier
        // ringing/initiated event before the call got answered.
        const answeredStatuses = ['completed', 'in-progress'];
        if (timelineId && processed.direction === 'inbound' && !normalized.parentCallSid) {
            const isAnswered = answeredStatuses.includes(normalized.eventStatus);
            if (isAnswered) {
                try {
                    await queries.markTimelineRead(timelineId);
                } catch (e) {
                    console.warn(`[${traceId}] Failed to mark timeline read:`, e.message);
                }
                if (contactId) {
                    try {
                        await queries.markContactRead(contactId);
                    } catch (e) {
                        console.warn(`[${traceId}] Failed to mark contact read:`, e.message);
                    }
                }
            } else {
                try {
                    await queries.markTimelineUnread(timelineId);
                } catch (e) {
                    console.warn(`[${traceId}] Failed to mark timeline unread:`, e.message);
                }
                if (contactId) {
                    try {
                        await queries.markContactUnread(contactId, new Date());
                    } catch (e) {
                        console.warn(`[${traceId}] Failed to mark contact unread:`, e.message);
                    }
                }
            }
        }

        // Action Required auto-trigger for inbound calls — check per-company settings
        if (timelineId && processed.direction === 'inbound' && !normalized.parentCallSid) {
            try {
                const { getTriggerConfig } = require('./arConfigHelper');
                // Resolve company_id from timeline
                const tlRow = await db.query('SELECT company_id FROM timelines WHERE id = $1', [timelineId]);
                const companyId = tlRow.rows[0]?.company_id || null;

                // AUTO-001: publish call.missed for the rules engine.
                if (companyId) {
                    require('./eventBus').emit(companyId, 'call.missed', {
                        call_sid: normalized.callSid, from: normalized.fromNumber, to: normalized.toNumber,
                        contact_id: contactId || null, timeline_id: timelineId,
                    }, { actorType: 'webhook', aggregateType: 'call', aggregateId: normalized.callSid }).catch(() => {});
                }
                if (process.env.FEATURE_RULES_ENGINE_AR === 'true') throw { __skipLegacyAR: true };

                const triggerCfg = await getTriggerConfig(companyId, 'missed_call');

                if (triggerCfg.enabled) {
                    await queries.setActionRequired(timelineId, 'new_call', 'system');

                    if (triggerCfg.create_task) {
                        const contactName = await (async () => {
                            if (contactId) {
                                try {
                                    const { rows } = await db.query('SELECT full_name FROM contacts WHERE id = $1', [contactId]);
                                    return rows[0]?.full_name || externalParty?.formatted || 'Unknown';
                                } catch { return externalParty?.formatted || 'Unknown'; }
                            }
                            return externalParty?.formatted || 'Unknown';
                        })();
                        const slaMs = (triggerCfg.task_sla_minutes || 30) * 60 * 1000;
                        const dueAt = new Date(Date.now() + slaMs).toISOString();
                        await queries.createTask({
                            companyId,
                            threadId: timelineId,
                            subjectType: 'contact',
                            subjectId: contactId,
                            title: `New call from ${contactName}`,
                            priority: triggerCfg.task_priority || 'p2',
                            dueAt,
                            createdBy: 'system',
                        });
                    }

                    const realtimeService = require('./realtimeService');
                    realtimeService.broadcast('thread.action_required', {
                        timelineId, reason: 'new_call',
                    });
                    console.log(`[${traceId}] Action Required set for inbound call on timeline ${timelineId}`);
                }
            } catch (e) {
                if (e && e.__skipLegacyAR) { /* rules engine handles AR */ }
                else console.warn(`[${traceId}] Failed to set AR for inbound call:`, e.message);
            }
        }
    }

    const isFinal = isFinalStatus(normalized.eventStatus);

    // Guard: don't let Twilio's "completed" overwrite meaningful statuses.
    // Applies to BOTH parent and child calls — Twilio sends "completed" for
    // child legs too when TwiML finishes, even if nobody answered.
    let skipUpsert = false;
    {
        try {
            if (existingCall) {
                const existingIsFinal = isFinalStatus(existingCall.status);
                const isInVoicemailFlow =
                    ['voicemail_recording', 'voicemail_left'].includes(existingCall.status);

                // Don't let non-final events overwrite a final status
                // (e.g. dial.action sends "in-progress" after call is already "completed")
                if (existingIsFinal && !isFinal) {
                    console.log(`[${traceId}] Skipping upsert — call is final (${existingCall.status}), ignoring non-final ${normalized.eventStatus}`);
                    skipUpsert = true;
                }
                // Don't let voicemail/missed states be overwritten by non-final events
                if (isInVoicemailFlow && !isFinal) {
                    console.log(`[${traceId}] Skipping upsert — call is in ${existingCall.status} status, ignoring non-final ${normalized.eventStatus}`);
                    skipUpsert = true;
                }
                // Don't let Twilio's "completed" overwrite missed/voicemail statuses.
                // Twilio sends "completed" when TwiML execution finishes, even for
                // unanswered calls — this would erase the meaningful no-answer/voicemail status.
                // This applies to BOTH parent AND child legs.
                const isMissedOrVoicemail = ['no-answer', 'voicemail_recording', 'voicemail_left'].includes(existingCall.status);
                if (isMissedOrVoicemail && normalized.eventStatus === 'completed') {
                    console.log(`[${traceId}] Skipping upsert — preserving ${existingCall.status}, ignoring Twilio completed`);
                    skipUpsert = true;
                }
            }
        } catch (e) { /* proceed with upsert if check fails */ }
    }

    // Guard: call.fallback means the primary TwiML URL (voice-inbound) failed.
    // Twilio returned <Hangup/> via fallback, so no further status webhooks will arrive.
    // Treat as terminal 'failed' immediately to prevent the call from being stuck forever.
    if (eventType === 'call.fallback') {
        console.log(`[${traceId}] call.fallback event → forcing status to 'failed' (primary TwiML URL failed)`);
        normalized.eventStatus = 'failed';
    }

    // Guard: for INBOUND parent calls, Twilio sends "in-progress" when TwiML starts
    // (Dial begins ringing agents), not when someone answers. Keep as "ringing"
    // until a child leg actually reaches "in-progress".
    // NOTE: Skip this guard for outbound calls — their in-progress is genuine (callee answered).
    let effectiveStatus = normalized.eventStatus;
    if (!normalized.parentCallSid && normalized.eventStatus === 'in-progress' && !skipUpsert
        && processed.direction === 'inbound') {
        try {
            const childCheck = await db.query(
                `SELECT 1 FROM calls
                  WHERE parent_call_sid = $1 AND company_id = $2
                    AND status = 'in-progress'
                  LIMIT 1`,
                [normalized.callSid, eventCompanyId]
            );
            if (childCheck.rows.length === 0) {
                effectiveStatus = 'ringing';
                console.log(`[${traceId}] Parent in-progress but no child answered → keeping as ringing`);
            }
        } catch (e) { /* use original status if check fails */ }
    }

    const effectiveIsFinal = isFinalStatus(effectiveStatus);

    // Upsert call snapshot
    let call;
    if (!skipUpsert) {
        call = await queries.upsertCall({
            callSid: normalized.callSid,
            parentCallSid: normalized.parentCallSid,
            contactId,
            timelineId,
            companyId: eventCompanyId,
            direction: processed.direction,   // Use CallProcessor's direction
            fromNumber: (() => {
                const extracted = extractPhoneFromSIP(normalized.fromNumber);
                // Replace SIP username URIs (sip:dana@...) with owned caller ID for clean display
                if (extracted && extracted.startsWith('sip:')) {
                    return process.env.OUTBOUND_CALLER_ID || '+16175006181';
                }
                // Keep client:user_xxx identity so the busy-check query can find
                // outbound calls; reconcileParentCall will overwrite with the
                // actual caller ID when the child leg completes
                if (extracted && extracted.startsWith('client:')) {
                    return extracted;
                }
                return extracted;
            })(),
            toNumber: extractPhoneFromSIP(normalized.toNumber),
            status: effectiveStatus,
            isFinal: effectiveIsFinal,
            startedAt: normalized.eventTime,
            answeredAt: effectiveStatus === 'in-progress' ? normalized.eventTime : null,
            endedAt: effectiveIsFinal ? normalized.eventTime : null,
            durationSec: normalized.durationSec || null,
            price: normalized.price,
            priceUnit: normalized.priceUnit,
            lastEventTime: normalized.eventTime,
            rawLastPayload: payload,
        });
    }

    if (call) {
        console.log(`[${traceId}] Call upserted`, { callSid: call.call_sid, status: call.status });
    } else {
        console.log(`[${traceId}] Call not updated (out-of-order event)`, { callSid: normalized.callSid });
    }

    // OUTBOUND-CALL-CANCEL-001 — shared human-contact trigger.
    // A real completed conversation with the customer (either direction,
    // human-answered) cancels every outbound agent's work for that customer. The
    // predicate runs on the upsertCall RESULT row — the monotonic and
    // voicemail-preserve guards above already filtered stale events, so:
    //   • upsert actually applied (!skipUpsert && call — out-of-order rows out),
    //   • final `completed` only (no-answer/busy/failed/voicemail_left out),
    //   • parent (customer-facing) rows only (child legs out),
    //   • real talk time (duration_sec > 0 — IVR hangups / zero-length out),
    //   • somebody actually picked up (answered_at set),
    //   • direction inbound|outbound (internal out).
    // Robot/Sara exclusions (vapi:% sid, answered_by='ai', call_flow_executions
    // vapi_agent discriminator) live inside the shared cancellation service.
    // Fire-and-forget + double-guarded: NEVER blocks or fails the voice-event
    // pipeline (spec: Failure semantics).
    if (!skipUpsert && call
        && call.is_final
        && call.status === 'completed'
        && call.parent_call_sid == null
        && Number(call.duration_sec || 0) > 0
        && call.answered_at != null
        && (call.direction === 'inbound' || call.direction === 'outbound')) {
        try {
            const cancellationService = require('./outboundCallCancellationService');
            Promise.resolve(cancellationService.cancelForCompletedCustomerCall(call)).catch((err) => {
                console.warn(`[${traceId}] human-contact cancel hook failed (non-fatal):`, err.message);
            });
        } catch (err) {
            console.warn(`[${traceId}] human-contact cancel hook failed (non-fatal):`, err.message);
        }
    }

    // Append immutable event
    await queries.appendCallEvent(
        normalized.callSid,
        eventType || 'call.status_changed',
        normalized.eventTime,
        { ...normalized, raw: payload },
        source,
        eventCompanyId
    );

    // Enrich from Twilio API on final status (skip if voicemail — we manage those statuses ourselves)
    let enrichedCall = call;
    if (isFinal && !skipUpsert) {
        await enrichFromTwilioApi(normalized.callSid, call, traceId, eventCompanyId);
        // Re-read from DB to get enriched data for SSE broadcast
        try {
            const freshCall = await queries.getCallByCallSid(normalized.callSid, eventCompanyId);
            if (freshCall) enrichedCall = freshCall;
        } catch (e) { /* use original call if re-read fails */ }
    }

    // Publish realtime event (after enrichment so frontend gets correct duration)
    if (!skipUpsert) {
        if (call && eventType === 'call.inbound' && !normalized.parentCallSid) {
            publishRealtimeEvent('call.created', call, traceId);
        }
        publishRealtimeEvent('call.updated', enrichedCall || { call_sid: normalized.callSid, status: normalized.eventStatus }, traceId);
    }

    // Propagate child leg status changes to parent call
    if (normalized.parentCallSid && ['ringing', 'in-progress'].includes(normalized.eventStatus)) {
        try {
            const parentCall = await queries.getCallByCallSid(normalized.parentCallSid, eventCompanyId);
            if (parentCall) {
                const parentStatus = parentCall.status;

                // Child ringing → parent ringing (if parent is still initiated)
                if (normalized.eventStatus === 'ringing' && ['initiated', 'queued'].includes(parentStatus)) {
                    await db.query(
                        `UPDATE calls SET status = 'ringing'
                          WHERE call_sid = $1 AND company_id = $2`,
                        [normalized.parentCallSid, eventCompanyId]
                    );
                    const freshParent = await queries.getCallByCallSid(normalized.parentCallSid, eventCompanyId);
                    if (freshParent) publishRealtimeEvent('call.updated', freshParent, traceId);
                    console.log(`[${traceId}] Child ringing → parent ${normalized.parentCallSid} → ringing`);
                }

                // Child in-progress (answered) → parent in-progress
                if (normalized.eventStatus === 'in-progress' && ['initiated', 'queued', 'ringing'].includes(parentStatus)) {
                    const toNum = normalized.toNumber || '';
                    const sipMatch = toNum.match(/^sip:([^@]+)@/i);
                    const answeredBy = isVapiSipTarget(toNum)
                        ? AI_ANSWERED_BY
                        : (sipMatch ? sipMatch[1] : null);

                    await db.query(
                        `UPDATE calls
                            SET status = 'in-progress', answered_at = $2, answered_by = $3
                          WHERE call_sid = $1 AND company_id = $4`,
                        [normalized.parentCallSid, normalized.eventTime, answeredBy, eventCompanyId]
                    );
                    const freshParent = await queries.getCallByCallSid(normalized.parentCallSid, eventCompanyId);
                    if (freshParent) publishRealtimeEvent('call.updated', freshParent, traceId);
                    console.log(`[${traceId}] Child answered → parent ${normalized.parentCallSid} → in-progress (by ${answeredBy})`);
                }
            }
        } catch (e) {
            console.warn(`[${traceId}] Failed to propagate child status to parent:`, e.message);
        }
    }

    // Reconcile parent call if this is a child leg that reached final status
    if (normalized.parentCallSid && isFinal) {
        await reconcileParentCall(normalized.parentCallSid, traceId, eventCompanyId);
    }

    // Also reconcile if THIS is the parent call reaching final status
    // For inbound: Twilio marks parent as 'completed' even when no agent answered
    // For outbound: parent call needs child leg data for accurate status/duration
    // Skip if upsert was skipped (status already preserved as no-answer/voicemail)
    if (!normalized.parentCallSid && isFinal && !skipUpsert) {
        await reconcileParentCall(normalized.callSid, traceId, eventCompanyId);
    }
}

// =============================================================================
// Process dial.action event (single-writer architecture)
// Replaces the direct DB writes that were previously in handleDialAction.
// Runs AFTER child voice-status events have been processed (dial event arrives
// last in webhook_inbox), so it has complete information about children.
// =============================================================================

async function processDialEvent(payload, traceId) {
    const CallSid = payload.CallSid;
    const dialStatus = (payload.DialCallStatus || '').toLowerCase();
    const dialDuration = parseInt(payload.DialCallDuration || 0) || null;
    const isAnswered = dialStatus === 'completed' || dialStatus === 'answered';
    const companyId = await resolveEventCompanyId(payload.AccountSid);

    console.log(`[${traceId}] processDialEvent`, { CallSid, dialStatus, dialDuration });

    // 1. Cross-check: child evidence overrides DialCallStatus
    //    Defense against edge cases where DialCallStatus doesn't match reality
    const childResult = await db.query(
        `SELECT call_sid, status, duration_sec FROM calls
         WHERE parent_call_sid = $1 AND company_id = $2
         ORDER BY duration_sec DESC NULLS LAST`,
        [CallSid, companyId]
    );
    const children = childResult.rows;
    const answeredChild = children.find(c =>
        c.status === 'completed' && c.duration_sec && c.duration_sec > 0
    );

    // Trust child evidence: if a child was genuinely answered (completed + duration),
    // treat the call as answered even if DialCallStatus says otherwise
    const effectivelyAnswered = isAnswered || !!answeredChild;

    if (!isAnswered && answeredChild) {
        console.log(`[${traceId}] dial.action: DialCallStatus=${dialStatus} but child ${answeredChild.call_sid} is completed (duration=${answeredChild.duration_sec}s) — overriding to answered`);
    }

    // 2. Finalize non-final child legs
    const finalizeStatus = effectivelyAnswered ? 'completed' : 'no-answer';
    const finResult = await db.query(
        `UPDATE calls SET
            status = CASE WHEN status = 'in-progress' THEN 'completed' ELSE $2 END,
            is_final = true,
            duration_sec = CASE WHEN status = 'in-progress'
                THEN COALESCE($3, duration_sec) ELSE duration_sec END,
            ended_at = COALESCE(ended_at, NOW())
         WHERE parent_call_sid = $1 AND company_id = $4 AND is_final = false`,
        [CallSid, finalizeStatus, dialDuration, companyId]
    );
    if (finResult.rowCount > 0) {
        console.log(`[${traceId}] dial.action: finalized ${finResult.rowCount} child leg(s) as ${finalizeStatus}`);
    }

    // 3. Update parent status (authoritative — overrides any premature reconciliation result)
    if (effectivelyAnswered) {
        await db.query(
            `UPDATE calls SET status = 'completed', is_final = true,
             ended_at = COALESCE(ended_at, NOW())
             WHERE call_sid = $1 AND company_id = $2`,
            [CallSid, companyId]
        );
        console.log(`[${traceId}] dial.action: parent ${CallSid} → completed`);
    } else {
        await db.query(
            `UPDATE calls SET status = 'voicemail_recording', is_final = false
             WHERE call_sid = $1 AND company_id = $2`,
            [CallSid, companyId]
        );
        console.log(`[${traceId}] dial.action: parent ${CallSid} → voicemail_recording`);
    }

    // 4. SSE broadcast so frontend updates
    const freshCall = await queries.getCallByCallSid(CallSid, companyId);
    if (freshCall) {
        publishRealtimeEvent('call.updated', freshCall, traceId);
    }

    // 5. Final reconciliation to enrich parent with winner metadata (duration, answered_at, etc.)
    if (effectivelyAnswered) {
        await reconcileParentCall(CallSid, traceId, companyId);
    }
}

// =============================================================================
// Reconcile parent call from child legs
// When child legs complete, update the parent with the winner's metadata
// =============================================================================

async function reconcileParentCall(parentCallSid, traceId, companyId = DEFAULT_COMPANY_ID) {
    try {
        // Guard: don't overwrite voicemail / missed-call statuses
        // These are set by handleDialAction and must be preserved — Twilio child legs
        // may report "completed" which would create a false "winner" in reconciliation.
        const parentCheck = await db.query(
            `SELECT status FROM calls WHERE call_sid = $1 AND company_id = $2`,
            [parentCallSid, companyId]
        );
        if (parentCheck.rows.length === 0) return;
        const parentCurrentStatus = parentCheck.rows[0]?.status;
        if (['no-answer', 'voicemail_recording', 'voicemail_left', 'blocked'].includes(parentCurrentStatus)) {
            // Check if any child was genuinely answered (completed with real duration).
            // If so, allow reconciliation — the parent status was likely set prematurely
            // by partial reconciliation or should be corrected to completed.
            const answeredCheck = await db.query(
                `SELECT 1 FROM calls
                 WHERE parent_call_sid = $1 AND company_id = $2
                   AND status = 'completed' AND duration_sec > 0
                 LIMIT 1`,
                [parentCallSid, companyId]
            );
            if (answeredCheck.rows.length === 0) {
                console.log(`[${traceId}] Skipping reconciliation — parent is ${parentCurrentStatus}, no answered children`);
                return;
            }
            console.log(`[${traceId}] Parent is ${parentCurrentStatus} but has answered child — proceeding with reconciliation`);
        }

        // Get all child legs for this parent
        const childResult = await db.query(
            `SELECT call_sid, status, duration_sec, started_at, ended_at, is_final,
                    contact_id, to_number
             FROM calls WHERE parent_call_sid = $1 AND company_id = $2
             ORDER BY duration_sec DESC NULLS LAST`,
            [parentCallSid, companyId]
        );
        const children = childResult.rows;

        if (children.length === 0) return;

        // Check if all children are final
        const allFinal = children.every(c => c.is_final);

        // Determine winner: completed child with longest duration.
        // Fallback: completed child without duration (handleDialAction may finalize
        // child legs before Twilio's status callback sets duration_sec).
        const winner = children.find(c =>
            c.status === 'completed' && c.duration_sec && c.duration_sec > 0
        ) || children.find(c => c.status === 'completed');
        const aiAnswered = children.some(c =>
            c.status === 'completed' && isVapiSipTarget(c.to_number)
        );

        // Get contact_id from winner or first child that has one
        // (for outbound SIP calls where parent may not have contact_id)
        const childContactId = winner?.contact_id || children.find(c => c.contact_id)?.contact_id || null;

        // Determine parent status from children
        let parentStatus;
        let parentIsFinal = false;
        let parentDuration = null;
        let parentAnsweredAt = null;
        let parentEndedAt = null;

        if (winner) {
            parentStatus = 'completed';
            parentIsFinal = true;
            parentDuration = winner.duration_sec;
            parentAnsweredAt = winner.started_at;
            parentEndedAt = winner.ended_at;
        } else if (allFinal) {
            // No winner — determine status from children
            // Priority: busy > no-answer > failed
            // (failed only if ALL children failed; any no-answer means the call rang but wasn't picked up)
            const statuses = children.map(c => c.status);
            if (statuses.includes('busy')) {
                parentStatus = 'busy';
            } else if (statuses.includes('no-answer')) {
                parentStatus = 'no-answer';
            } else {
                parentStatus = 'failed';
            }
            parentIsFinal = true;
            parentEndedAt = children.reduce((latest, c) =>
                c.ended_at && (!latest || new Date(c.ended_at) > new Date(latest)) ? c.ended_at : latest
                , null);
        } else {
            // Some children still active — parent stays in-progress
            parentStatus = 'in-progress';
        }

        // Update parent call with reconciled data + propagate contact_id and from_number from child
        // (for SoftPhone outbound, parent has from_number=null or client:xxx, child has the actual caller ID)
        const childFromNumber = winner
            ? (await db.query(
                `SELECT from_number FROM calls WHERE call_sid = $1 AND company_id = $2`,
                [winner.call_sid, companyId]
            )).rows[0]?.from_number
            : (await db.query(
                `SELECT from_number FROM calls
                  WHERE parent_call_sid = $1 AND company_id = $2
                    AND from_number NOT LIKE 'client:%'
                  LIMIT 1`,
                [parentCallSid, companyId]
            )).rows[0]?.from_number;

        await db.query(
            `UPDATE calls SET
                status = $2,
                is_final = $3,
                duration_sec = COALESCE($4, duration_sec),
                answered_at = COALESCE($5, answered_at),
                ended_at = COALESCE($6, ended_at),
                contact_id = COALESCE(calls.contact_id, $7),
                from_number = CASE
                    WHEN calls.from_number IS NULL OR calls.from_number LIKE 'client:%'
                    THEN COALESCE($8, calls.from_number)
                    ELSE calls.from_number
                END,
                answered_by = CASE WHEN $9 THEN 'ai' ELSE answered_by END
             WHERE call_sid = $1 AND company_id = $10`,
            [parentCallSid, parentStatus, parentIsFinal, parentDuration, parentAnsweredAt,
                parentEndedAt, childContactId, childFromNumber, aiAnswered, companyId]
        );

        console.log(`[${traceId}] Reconciled parent ${parentCallSid}: status=${parentStatus}, winner=${winner?.call_sid || 'none'}`);

        // Publish update for parent so frontend refreshes
        const parentCall = await queries.getCallByCallSid(parentCallSid, companyId);
        if (parentCall) {
            publishRealtimeEvent('call.updated', parentCall, traceId);
        }
    } catch (error) {
        console.error(`[${traceId}] Failed to reconcile parent ${parentCallSid}:`, error.message);
    }
}

// =============================================================================
// Recording event → upsert recording
// =============================================================================

async function processRecordingEvent(payload, traceId, source = 'webhook') {
    const normalized = normalizeRecordingEvent(payload);

    const recording = await queries.upsertRecording({
        recordingSid: normalized.recordingSid,
        callSid: normalized.callSid,
        status: normalized.status,
        recordingUrl: normalized.recordingUrl,
        durationSec: normalized.durationSec,
        channels: normalized.channels,
        track: normalized.track,
        source: normalized.source,
        startedAt: normalized.status === 'in-progress' ? normalized.eventTime : null,
        completedAt: normalized.status === 'completed' ? normalized.eventTime : null,
        rawPayload: payload,
    });

    console.log(`[${traceId}] Recording upserted`, {
        recordingSid: recording.recording_sid,
        status: recording.status
    });

    // Append immutable event
    await queries.appendCallEvent(
        normalized.callSid,
        'recording.updated',
        normalized.eventTime,
        { ...normalized, raw: payload },
        source
    );

    // Publish realtime event
    if (normalized.status === 'completed') {
        publishRealtimeEvent('recording.ready', recording, traceId);

        // Transition voicemail_recording → voicemail_left
        try {
            const call = await queries.getCallByCallSid(normalized.callSid);
            if (call && call.status === 'voicemail_recording') {
                await db.query(
                    `UPDATE calls SET status = 'voicemail_left', is_final = true,
                     duration_sec = COALESCE($2, duration_sec),
                     ended_at = COALESCE($3, ended_at)
                     WHERE call_sid = $1`,
                    [normalized.callSid, normalized.durationSec, normalized.eventTime]
                );
                const updatedCall = await queries.getCallByCallSid(normalized.callSid);
                if (updatedCall) {
                    publishRealtimeEvent('call.updated', updatedCall, traceId);
                }
                console.log(`[${traceId}] Status → voicemail_left for ${normalized.callSid}`);
            }
        } catch (err) {
            console.warn(`[${traceId}] Failed to set voicemail_left:`, err.message);
        }

        // Auto-transcribe via AssemblyAI (fire-and-forget, same flow as manual button)
        const MAX_AUTO_TRANSCRIBE_DURATION = 600; // 10 minutes
        if (normalized.durationSec && normalized.durationSec > MAX_AUTO_TRANSCRIBE_DURATION) {
            console.log(`[${traceId}] Skipping auto-transcription: recording duration ${normalized.durationSec}s > ${MAX_AUTO_TRANSCRIBE_DURATION}s`);
        } else {
            console.log(`[${traceId}] Auto-transcription starting for ${normalized.callSid} (duration: ${normalized.durationSec || 'unknown'}s)`);
            const { transcribeCall } = require('./transcriptionService');
            transcribeCall(normalized.callSid, normalized.recordingSid, traceId)
                .then(() => console.log(`[${traceId}] Auto-transcription completed for ${normalized.callSid}`))
                .catch(err => console.error(`[${traceId}] Auto-transcription failed for ${normalized.callSid}:`, err.message));
        }
    }
}

// =============================================================================
// Transcription event → upsert transcript
// =============================================================================

async function processTranscriptionEvent(payload, traceId, source = 'webhook') {
    const normalized = normalizeTranscriptionEvent(payload);

    const transcript = await queries.upsertTranscript({
        transcriptionSid: normalized.transcriptionSid,
        callSid: normalized.callSid,
        recordingSid: normalized.recordingSid,
        mode: 'post-call',
        status: normalized.status,
        languageCode: normalized.languageCode,
        confidence: normalized.confidence,
        text: normalized.text,
        isFinal: true,
        rawPayload: payload,
    });

    console.log(`[${traceId}] Transcript upserted`, {
        transcriptionSid: transcript.transcription_sid,
        status: transcript.status
    });

    // Append immutable event
    await queries.appendCallEvent(
        normalized.callSid,
        'transcript.updated',
        normalized.eventTime,
        { ...normalized, raw: payload },
        source
    );

    // Publish realtime event
    if (normalized.status === 'completed') {
        publishRealtimeEvent('transcript.ready', transcript, traceId);
    }
}

// =============================================================================
// Twilio API enrichment on final call status
// =============================================================================

async function enrichFromTwilioApi(callSid, existingCall, traceId, companyId = DEFAULT_COMPANY_ID) {
    try {
        const client = getTwilioClient();
        const details = await client.calls(callSid).fetch();
        const db = require('../db/connection');

        // Preserve missed/voicemail statuses — Twilio always reports "completed"
        // for parent calls when TwiML finishes, even if the call was unanswered.
        const currentStatus = existingCall?.status;
        const preserveStatus = ['no-answer', 'voicemail_recording', 'voicemail_left', 'blocked'].includes(currentStatus)
            && details.status === 'completed';
        const effectiveStatus = preserveStatus ? currentStatus : (details.status || null);
        const effectiveIsFinal = preserveStatus ? existingCall.is_final : (isFinalStatus(details.status) || false);

        if (preserveStatus) {
            console.log(`[${traceId}] Enrichment: preserving ${currentStatus} status (Twilio reports completed)`);
        }

        // Direct UPDATE bypassing the timestamp guard in upsertCall
        // Enriches with authoritative Twilio API data (price, duration, timestamps)
        await db.query(
            `UPDATE calls SET
                parent_call_sid = COALESCE($2, parent_call_sid),
                direction       = COALESCE(direction, $3),
                status          = COALESCE($4, status),
                is_final        = COALESCE($5, is_final),
                started_at      = COALESCE($6, started_at),
                answered_at     = COALESCE($7, answered_at),
                ended_at        = COALESCE($8, ended_at),
                duration_sec    = COALESCE($9, duration_sec),
                price           = COALESCE($10, price),
                price_unit      = COALESCE($11, price_unit)
             WHERE call_sid = $1 AND company_id = $12`,
            [
                callSid,
                details.parentCallSid || null,
                existingCall?.direction || details.direction,
                effectiveStatus,
                effectiveIsFinal,
                details.startTime ? new Date(details.startTime) : null,
                details.startTime ? new Date(details.startTime) : null,
                details.endTime ? new Date(details.endTime) : null,
                parseInt(details.duration) || null,
                details.price ? parseFloat(details.price) : null,
                details.priceUnit || 'USD',
                companyId,
            ]
        );

        console.log(`[${traceId}] Enriched from Twilio API`, {
            price: details.price,
            duration: details.duration,
            endTime: details.endTime
        });
    } catch (error) {
        console.warn(`[${traceId}] Failed to enrich from Twilio API:`, error.message);
    }
}

// =============================================================================
// Realtime SSE publishing
// =============================================================================

function publishRealtimeEvent(eventType, data, traceId) {
    try {
        const realtimeService = require('./realtimeService');
        realtimeService.publishCallUpdate({ eventType, ...data });
        console.log(`[${traceId}] SSE event: ${eventType}`);
    } catch (error) {
        console.warn(`[${traceId}] SSE publish failed:`, error.message);
    }
}

// =============================================================================
// Worker: claim → process → mark
// =============================================================================

async function claimAndProcessEvents() {
    const events = await queries.claimInboxEvents(CONFIG.BATCH_SIZE);

    if (events.length === 0) return { processed: 0, failed: 0 };

    console.log(`Claimed ${events.length} events`);

    let processed = 0;
    let failed = 0;

    for (const event of events) {
        try {
            await processEvent(event);
            await queries.markInboxProcessed(event.id);
            processed++;
        } catch (error) {
            await queries.markInboxFailed(event.id, error.message);
            failed++;
        }
    }

    return { processed, failed };
}

// =============================================================================
// Worker main loop
// =============================================================================

async function startWorker() {
    console.log('🔄 Inbox worker started (v4 + stale reconciliation)');
    console.log(`   Batch: ${CONFIG.BATCH_SIZE} | Poll: ${CONFIG.POLL_INTERVAL_MS}ms | Retries: ${CONFIG.MAX_RETRIES}`);
    console.log(`   Stale check: every ${CONFIG.STALE_CHECK_INTERVAL_MS / 1000}s`);

    let isRunning = true;
    let lastStaleCheck = 0;
    process.on('SIGTERM', () => { isRunning = false; });
    process.on('SIGINT', () => { isRunning = false; });

    while (isRunning) {
        try {
            const { processed, failed } = await claimAndProcessEvents();
            if (processed > 0 || failed > 0) {
                console.log(`Processed: ${processed}, Failed: ${failed}`);
            }

            // Periodic stale call reconciliation
            const now = Date.now();
            if (now - lastStaleCheck >= CONFIG.STALE_CHECK_INTERVAL_MS) {
                lastStaleCheck = now;
                try {
                    await reconcileStaleCalls();
                } catch (err) {
                    console.error('Stale reconciliation error:', err.message);
                }
            }

            await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
        } catch (error) {
            console.error('Worker loop error:', error);
            await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 5));
        }
    }

    console.log('✅ Worker stopped');
    process.exit(0);
}

module.exports = {
    startWorker,
    processEvent,
    processDialEvent,
    normalizeVoiceEvent,
    normalizeRecordingEvent,
    normalizeTranscriptionEvent,
    reconcileParentCall,
    isFinalStatus,
    CONFIG,
};
