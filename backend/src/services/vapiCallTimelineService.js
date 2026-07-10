/**
 * vapiCallTimelineService — OUTBOUND-CALL-TIMELINE-001 (CT-01)
 *
 * The pure, NON-FATAL orchestration seam that puts a VAPI outbound robot call
 * into the `calls` timeline exactly like a softphone call (voice.js gold model).
 * Two hooks call in:
 *   - the placement worker (CT-04) → recordPlacement (live "Ringing" row)
 *   - the /api/vapi/call-status webhook (CT-05) → applyStatusUpdate (mid-call)
 *                                               → finalizeFromEndOfCallReport
 *
 * Design invariants (spec §Ключевые инварианты, S4, обработка ошибок):
 *   - NON-FATAL: the three entry points never throw. Any internal error →
 *     `console.warn('[vapiCallTimeline] … (non-fatal)')` + return null. Callers
 *     never branch on the result.
 *   - Company-scoped: companyId ALWAYS derives from the caller's attempt row
 *     (never a webhook body). Every SQL statement carries company_id, normalized
 *     to DEFAULT_COMPANY_ID exactly like callsQueries.upsertCall so the WHEREs
 *     match the row that upsert created.
 *   - Synthetic sid `vapi:<vapiCallId>` at placement, re-keyed to the real Twilio
 *     CallSid (message.call.phoneCallProviderId) the moment it is learned.
 *   - NO transcripts/recordings rows before sid resolution — their FKs
 *     REFERENCE calls(call_sid) with no ON UPDATE CASCADE (v3_schema.sql:86,111),
 *     so a child written under the synthetic sid would break the re-key UPDATE.
 *     finalize resolves the sid FIRST, then writes children.
 *
 * This service NEVER writes `outbound_call_attempts` (that is OPC1's retry FSM).
 */
'use strict';

const queries = require('../db/queries');
const db = require('../db/connection');
const realtimeService = require('./realtimeService');

// Mirror callsQueries.js so our raw-SQL WHEREs target the same company_id the
// upsert stored when the caller passed a null/absent companyId.
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

const AI_ANSWERED_BY = 'ai';

// =============================================================================
// Pure helpers
// =============================================================================

/** Deterministic synthetic sid derivable from message.call.id — no new column. */
function syntheticSidFor(vapiCallId) {
    return `vapi:${vapiCallId}`;
}

/**
 * endedReason → calls.status (spec S3 table). Ordered, case-insensitive
 * substring checks. Independent of classifyEndedReason (the attempt-retry
 * classifier) — different vocabularies, deliberately NOT merged.
 *
 *   1. contains "voicemail"                    → voicemail_left
 *   2. contains "did-not-answer"|"no-answer"   → no-answer
 *   3. contains "busy"                          → busy
 *   4. else if durationSec > 0                  → completed
 *   5. else                                     → failed
 */
function mapVapiEndedReasonToCallStatus(endedReason, durationSec) {
    const reason = String(endedReason == null ? '' : endedReason).toLowerCase();
    if (reason.includes('voicemail')) return 'voicemail_left';
    if (reason.includes('did-not-answer') || reason.includes('no-answer')) return 'no-answer';
    if (reason.includes('busy')) return 'busy';
    const dur = Number(durationSec);
    if (Number.isFinite(dur) && dur > 0) return 'completed';
    return 'failed';
}

/**
 * VAPI mid-call status → calls.status (spec S2). Terminal/unknown states return
 * null — finalize owns the terminal row, so status-update never writes one.
 */
function mapVapiStatusToCallStatus(vapiStatus) {
    switch (String(vapiStatus == null ? '' : vapiStatus).toLowerCase()) {
        case 'queued': return 'queued';
        case 'ringing': return 'ringing';
        case 'in-progress': return 'in-progress';
        default: return null;
    }
}

function firstDefined(...vals) {
    for (const v of vals) {
        if (v !== undefined && v !== null) return v;
    }
    return null;
}

function coerceDuration(value) {
    if (value == null) return null;
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : null;
}

// =============================================================================
// Internal DB helpers (raw, company-scoped)
// =============================================================================

/**
 * Guarded AI marker. upsertCall has no answered_by param (callsQueries.js:15-63),
 * so we backfill it here. `answered_by IS NULL` keeps it idempotent and never
 * clobbers a value another path already set.
 */
async function markAnsweredByAi(callSid, cid) {
    await db.query(
        `UPDATE calls SET answered_by = $3
           WHERE call_sid = $1 AND company_id = $2 AND answered_by IS NULL`,
        [callSid, cid, AI_ANSWERED_BY]
    );
}

async function loadExistingCall(callSid, cid) {
    try {
        return await queries.getCallByCallSid(callSid, cid);
    } catch (_) {
        return null;
    }
}

/** Re-read the full row and fan it out over SSE (full row → the SSE gate). */
async function publishBySid(callSid, cid) {
    const row = await queries.getCallByCallSid(callSid, cid);
    if (row) {
        realtimeService.publishCallUpdate({ eventType: 'call.updated', ...row });
    }
    return row || null;
}

/**
 * Merge the synthetic row's fields onto an already-existing real-sid row and
 * drop the synthetic (spec S4 "exists" branch). Safe to DELETE: by invariant no
 * FK children exist under the synthetic sid before resolution.
 */
async function mergeSyntheticIntoReal({ cid, syntheticSid, realSid }) {
    const synthRes = await db.query(
        `SELECT timeline_id, contact_id, answered_by
           FROM calls WHERE call_sid = $1 AND company_id = $2 LIMIT 1`,
        [syntheticSid, cid]
    );
    const synth = synthRes.rows[0] || null;
    await db.query(
        `UPDATE calls SET
            timeline_id = COALESCE(timeline_id, $2),
            contact_id  = COALESCE(contact_id, $3),
            answered_by = COALESCE(answered_by, $4, $6)
          WHERE call_sid = $1 AND company_id = $5`,
        [realSid, synth ? synth.timeline_id : null, synth ? synth.contact_id : null,
            synth ? synth.answered_by : null, cid, AI_ANSWERED_BY]
    );
    if (synth) {
        await db.query(
            `DELETE FROM calls WHERE call_sid = $1 AND company_id = $2`,
            [syntheticSid, cid]
        );
    }
    return realSid;
}

// =============================================================================
// SID resolution (re-key / merge) — spec S4
// =============================================================================

/**
 * resolveFinalSid — re-key the synthetic placement row to the real Twilio
 * CallSid once it is known. Returns the effective sid to use for the calls row
 * and (only afterwards) any child rows.
 *
 * @param {object} opts
 * @param {string} opts.companyId          tenant (from the attempt row)
 * @param {string} opts.syntheticSid       `vapi:<vapiCallId>`
 * @param {string} [opts.realSid]          message.call.phoneCallProviderId (CA…)
 * @param {string} [opts.phoneCallProviderId] alias for realSid
 * @returns {Promise<string>} the effective sid (real if re-keyed, else synthetic)
 *
 * May throw on an unexpected DB error (other than the handled 23505 race) — the
 * three orchestration entry points catch it, so nothing partial is written and
 * no child row is ever created under an unresolved sid.
 */
async function resolveFinalSid({ companyId, syntheticSid, realSid, phoneCallProviderId } = {}) {
    const cid = companyId || DEFAULT_COMPANY_ID;
    const real = firstDefined(realSid, phoneCallProviderId);

    // 1. No real sid learned → keep the synthetic row (S6 lifecycle).
    if (!real) return syntheticSid;
    // Already the same sid (idempotent re-entry) → nothing to do.
    if (real === syntheticSid) return syntheticSid;

    // 2. Does a real-sid row already exist (coldReconcile beat us)?
    const existing = await db.query(
        `SELECT call_sid FROM calls WHERE call_sid = $1 AND company_id = $2 LIMIT 1`,
        [real, cid]
    );
    if (existing.rows.length > 0) {
        return mergeSyntheticIntoReal({ cid, syntheticSid, realSid: real });
    }

    // 3. Plain re-key. On a 23505 race (a concurrent insert of the real sid),
    //    retry the merge branch once.
    try {
        await db.query(
            `UPDATE calls SET call_sid = $1 WHERE call_sid = $2 AND company_id = $3`,
            [real, syntheticSid, cid]
        );
    } catch (err) {
        if (err && err.code === '23505') {
            return mergeSyntheticIntoReal({ cid, syntheticSid, realSid: real });
        }
        throw err;
    }
    // If the synthetic row was missing (placement hook had failed) the UPDATE
    // simply matched nothing → finalize's upsertCall self-heals from scratch.
    return real;
}

// =============================================================================
// Orchestration entry points (NON-FATAL — never throw, return null on error)
// =============================================================================

/**
 * recordPlacement (spec S1) — create the live "Ringing" row the instant the
 * robot call is placed. Accepts the spec/CT-04 shape ({attempt, vapiCallId,
 * dialedNumber, callerId}); also tolerates the decomposed
 * ({companyId, vapiCallId, phone, callerId, jobId}) shape.
 */
async function recordPlacement(opts = {}) {
    try {
        const attempt = opts.attempt || {};
        const cid = opts.companyId || attempt.company_id || DEFAULT_COMPANY_ID;
        const vapiCallId = opts.vapiCallId;
        const dialedNumber = firstDefined(opts.dialedNumber, opts.phone, attempt.phone);
        const callerId = firstDefined(opts.callerId, opts.from);
        const jobId = firstDefined(opts.jobId, attempt.job_id);
        const attemptId = firstDefined(opts.attemptId, attempt.id);

        if (!vapiCallId) {
            console.warn('[vapiCallTimeline] recordPlacement missing vapiCallId (non-fatal)');
            return null;
        }

        const callSid = syntheticSidFor(vapiCallId);
        const now = new Date();

        // Resolve timeline. Inner guard: a resolution failure downgrades to
        // timelineId/contactId null and the row is STILL created (spec S1.3 /
        // граничный-5). Call history keeps it; the Pulse thread self-heals at
        // finalize.
        let timelineId = null;
        let contactId = firstDefined(opts.contactId);
        try {
            if (dialedNumber) {
                const timeline = await queries.findOrCreateTimeline(dialedNumber, cid);
                timelineId = (timeline && timeline.id) || null;
                contactId = (timeline && timeline.contact_id) || contactId || null;
            }
        } catch (tlErr) {
            console.warn(`[vapiCallTimeline] timeline resolve failed — creating row without timeline (non-fatal): ${tlErr.message}`);
        }

        const row = await queries.upsertCall({
            callSid,
            parentCallSid: null,
            contactId,
            timelineId,
            companyId: cid,
            direction: 'outbound',
            fromNumber: callerId,
            toNumber: dialedNumber,
            status: 'initiated',
            isFinal: false,
            startedAt: now,
            answeredAt: null,
            endedAt: null,
            durationSec: null,
            lastEventTime: now,
            rawLastPayload: {
                source: 'vapi-placement',
                vapi_call_id: vapiCallId,
                attempt_id: attemptId,
                job_id: jobId,
            },
        });

        // AI marker (separate guarded UPDATE) + SSE — sub-guarded so a failure
        // here never undoes the insert above.
        try {
            await markAnsweredByAi(callSid, cid);
        } catch (abErr) {
            console.warn(`[vapiCallTimeline] answered_by backfill failed (non-fatal): ${abErr.message}`);
        }
        let published = null;
        try {
            published = await publishBySid(callSid, cid);
        } catch (pubErr) {
            console.warn(`[vapiCallTimeline] publish failed (non-fatal): ${pubErr.message}`);
        }

        return published || row || callSid;
    } catch (err) {
        console.warn(`[vapiCallTimeline] recordPlacement failed (non-fatal): ${err.message}`);
        return null;
    }
}

/**
 * applyStatusUpdate (spec S2) — mid-call live transition + early re-key.
 * Accepts {attempt, message} (CT-05 shape) and the decomposed
 * {companyId, vapiCallId, phoneCallProviderId, status} shape.
 */
async function applyStatusUpdate(opts = {}) {
    try {
        const attempt = opts.attempt || {};
        const message = opts.message || {};
        const call = message.call || {};
        const cid = opts.companyId || attempt.company_id || DEFAULT_COMPANY_ID;
        const vapiCallId = firstDefined(opts.vapiCallId, call.id, attempt.vapi_call_id);
        const realSid = firstDefined(opts.phoneCallProviderId, opts.realSid, call.phoneCallProviderId);
        const rawStatus = firstDefined(opts.status, message.status, call.status);

        if (!vapiCallId) {
            console.warn('[vapiCallTimeline] applyStatusUpdate missing vapiCallId (non-fatal)');
            return null;
        }

        const syntheticSid = syntheticSidFor(vapiCallId);
        // Re-key early if the real sid is already present.
        const effectiveSid = await resolveFinalSid({ companyId: cid, syntheticSid, realSid });

        const status = mapVapiStatusToCallStatus(rawStatus);
        // ended / unknown → finalize owns the terminal row; no status write.
        if (!status) return effectiveSid;

        const now = new Date();
        // Preserve from/to/direction/timeline the placement set — upsertCall
        // writes from_number/to_number/direction from EXCLUDED (NOT COALESCE),
        // so passing nulls would wipe them.
        const existing = await loadExistingCall(effectiveSid, cid);

        await queries.upsertCall({
            callSid: effectiveSid,
            parentCallSid: null,
            contactId: existing ? existing.contact_id : null,
            timelineId: existing ? existing.timeline_id : null,
            companyId: cid,
            direction: (existing && existing.direction) || 'outbound',
            fromNumber: existing ? existing.from_number : null,
            toNumber: existing ? existing.to_number : firstDefined(attempt.phone),
            status,
            isFinal: false,
            startedAt: (existing && existing.started_at) || now,
            answeredAt: status === 'in-progress' ? now : null,
            endedAt: null,
            durationSec: null,
            lastEventTime: now,
            rawLastPayload: { source: 'vapi-status-update', vapi_call_id: vapiCallId, status: rawStatus },
        });

        try {
            await markAnsweredByAi(effectiveSid, cid);
        } catch (abErr) {
            console.warn(`[vapiCallTimeline] answered_by backfill failed (non-fatal): ${abErr.message}`);
        }
        try {
            await publishBySid(effectiveSid, cid);
        } catch (pubErr) {
            console.warn(`[vapiCallTimeline] publish failed (non-fatal): ${pubErr.message}`);
        }
        return effectiveSid;
    } catch (err) {
        console.warn(`[vapiCallTimeline] applyStatusUpdate failed (non-fatal): ${err.message}`);
        return null;
    }
}

/**
 * finalizeFromEndOfCallReport (spec S3) — re-key, write the terminal calls row,
 * then (AFTER resolution) the transcript (VAPI summary → raw_payload.gemini_summary)
 * and recording rows, then SSE. Accepts {attempt, message} (CT-05) and the
 * decomposed {companyId, vapiCallId, phoneCallProviderId, endedReason, startedAt,
 * endedAt, durationSeconds, summary, transcript, recordingUrl} shape.
 */
async function finalizeFromEndOfCallReport(opts = {}) {
    try {
        const attempt = opts.attempt || {};
        const message = opts.message || {};
        const call = message.call || {};
        const artifact = message.artifact || {};
        const analysis = message.analysis || {};

        const cid = opts.companyId || attempt.company_id || DEFAULT_COMPANY_ID;
        const vapiCallId = firstDefined(opts.vapiCallId, call.id, attempt.vapi_call_id);
        const realSid = firstDefined(opts.phoneCallProviderId, opts.realSid, call.phoneCallProviderId);
        const endedReason = firstDefined(opts.endedReason, message.endedReason, call.endedReason);

        if (!vapiCallId) {
            console.warn('[vapiCallTimeline] finalizeFromEndOfCallReport missing vapiCallId (non-fatal)');
            return null;
        }

        const syntheticSid = syntheticSidFor(vapiCallId);

        // 1. Resolve the final sid FIRST — invariant: no child rows before this.
        const finalSid = await resolveFinalSid({ companyId: cid, syntheticSid, realSid });

        // 2. Timing + duration (spec S3 §2).
        const existing = await loadExistingCall(finalSid, cid);
        const startedAt = firstDefined(opts.startedAt, message.startedAt, call.startedAt,
            existing ? existing.started_at : null);
        const endedAt = firstDefined(opts.endedAt, message.endedAt, call.endedAt) || new Date();

        let durationSec = coerceDuration(firstDefined(
            opts.durationSeconds, opts.durationSec, message.durationSeconds, call.durationSeconds));
        if (durationSec == null && startedAt) {
            const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
            durationSec = Number.isFinite(ms) ? coerceDuration(ms / 1000) : null;
        }

        const status = mapVapiEndedReasonToCallStatus(endedReason, durationSec);

        // Preserve/self-heal identity. If the placement row is missing, re-resolve
        // the timeline from the attempt's phone (spec S3 §2 self-healing).
        let timelineId = existing ? existing.timeline_id : null;
        let contactId = existing ? existing.contact_id : null;
        const fromNumber = existing ? existing.from_number : firstDefined(opts.callerId);
        const toNumber = existing ? existing.to_number
            : firstDefined(opts.dialedNumber, opts.phone, attempt.phone);
        if (!existing && toNumber) {
            try {
                const timeline = await queries.findOrCreateTimeline(toNumber, cid);
                timelineId = (timeline && timeline.id) || null;
                contactId = (timeline && timeline.contact_id) || null;
            } catch (tlErr) {
                console.warn(`[vapiCallTimeline] finalize timeline self-heal failed (non-fatal): ${tlErr.message}`);
            }
        }

        const now = new Date();
        await queries.upsertCall({
            callSid: finalSid,
            parentCallSid: null,
            contactId,
            timelineId,
            companyId: cid,
            direction: (existing && existing.direction) || 'outbound',
            fromNumber,
            toNumber,
            status,
            isFinal: true,
            startedAt,
            answeredAt: status === 'completed' ? startedAt : null,
            endedAt,
            durationSec,
            lastEventTime: now,
            rawLastPayload: { source: 'vapi-end-of-call', endedReason, vapi_call_id: vapiCallId },
        });

        try {
            await markAnsweredByAi(finalSid, cid);
        } catch (abErr) {
            console.warn(`[vapiCallTimeline] answered_by backfill failed (non-fatal): ${abErr.message}`);
        }

        // 3. Transcript — ONLY now (after sid resolution). VAPI summary rides in
        //    raw_payload.gemini_summary so formatCall renders it for free.
        const text = firstDefined(opts.transcript, message.transcript, artifact.transcript);
        const summary = firstDefined(opts.summary, message.summary, analysis.summary);
        if (text || summary) {
            try {
                await queries.upsertTranscript({
                    transcriptionSid: `vapi_${vapiCallId}`,
                    callSid: finalSid,
                    recordingSid: null,
                    mode: 'post-call',
                    status: 'completed',
                    languageCode: null,
                    confidence: null,
                    text: text || null,
                    isFinal: true,
                    rawPayload: { source: 'vapi', vapi_call_id: vapiCallId, gemini_summary: summary || null },
                    companyId: cid,
                });
            } catch (tErr) {
                console.warn(`[vapiCallTimeline] transcript upsert failed (non-fatal): ${tErr.message}`);
            }
        }

        // 4. Recording — ONLY now (after sid resolution).
        const recUrl = firstDefined(opts.recordingUrl, message.recordingUrl, artifact.recordingUrl,
            message.stereoRecordingUrl, artifact.stereoRecordingUrl);
        if (recUrl) {
            try {
                await queries.upsertRecording({
                    recordingSid: `vapi_${vapiCallId}`,
                    callSid: finalSid,
                    status: 'completed',
                    recordingUrl: recUrl,
                    durationSec,
                    source: 'vapi',
                    startedAt,
                    completedAt: endedAt,
                    companyId: cid,
                });
            } catch (rErr) {
                console.warn(`[vapiCallTimeline] recording upsert failed (non-fatal): ${rErr.message}`);
            }
        }

        // 5. Re-read + SSE.
        try {
            await publishBySid(finalSid, cid);
        } catch (pubErr) {
            console.warn(`[vapiCallTimeline] publish failed (non-fatal): ${pubErr.message}`);
        }

        return finalSid;
    } catch (err) {
        console.warn(`[vapiCallTimeline] finalizeFromEndOfCallReport failed (non-fatal): ${err.message}`);
        return null;
    }
}

module.exports = {
    // spec exports
    recordPlacement,
    applyStatusUpdate,
    finalizeFromEndOfCallReport,
    mapVapiEndedReasonToCallStatus,
    resolveFinalSid,
    // alias for the orchestrator's shorthand name
    finalize: finalizeFromEndOfCallReport,
    // helpers (pure) exported for targeted tests
    mapVapiStatusToCallStatus,
    syntheticSidFor,
};
