'use strict';

/**
 * Inbound voice recovery — human callback safety net.
 *
 * This path is deliberately independent from supplier-cost ingest and from the
 * outbound FSM. The authenticated call-status credential supplies companyId;
 * provider_call_id is globally unique in the single platform Vapi account. A
 * durable case row serializes the decision and survives task deletion, while a
 * retry state lets the existing scheduler repair a non-fatal task-write failure.
 */

const db = require('../db/connection');
const timelinesQueries = require('../db/timelinesQueries');
const tasksService = require('./tasksService');
const { withTransaction } = require('./transactionService');
const { toE164 } = require('../utils/phoneUtils');

const DEFAULT_MIN_CONVERSATION_SECONDS = 30;
const RETRY_DELAY_MINUTES = 5;
const SWEEP_LIMIT = 50;

function minimumConversationSeconds(environment = process.env) {
    const configured = Number(environment.VAPI_INBOUND_RECOVERY_MIN_SECONDS);
    if (Number.isInteger(configured) && configured >= 5 && configured <= 600) {
        return configured;
    }
    return DEFAULT_MIN_CONVERSATION_SECONDS;
}

function validDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function durationFromProvider(message) {
    const call = message?.call || {};
    for (const value of [message?.durationSeconds, call.durationSeconds]) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
    }
    const startedAt = validDate(call.startedAt);
    const endedAt = validDate(call.endedAt);
    if (!startedAt || !endedAt || endedAt < startedAt) return null;
    return Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);
}

function normalizePhone(value) {
    if (typeof value !== 'string' || value.trim().length < 5) return null;
    return toE164(value) || value.trim();
}

function normalizeInput(input) {
    const call = input.message?.call || {};
    const suppliedDuration = input.providerDurationSeconds == null
        ? durationFromProvider(input.message)
        : Number(input.providerDurationSeconds);
    return {
        companyId: String(input.companyId || '').trim(),
        providerCallId: String(input.providerCallId || call.id || '').trim(),
        providerCallType: input.providerCallType || call.type || null,
        callerPhone: normalizePhone(input.callerPhone || call.customer?.number),
        providerStartedAt: validDate(input.providerStartedAt || call.startedAt),
        providerEndedAt: validDate(input.providerEndedAt || call.endedAt),
        providerDurationSeconds: Number.isFinite(suppliedDuration) && suppliedDuration >= 0
            ? Math.floor(suppliedDuration)
            : null,
    };
}

function errorCode(error) {
    const code = String(error?.code || 'VOICE_RECOVERY_WRITE_FAILED');
    return /^[A-Za-z0-9_:-]{1,120}$/.test(code)
        ? code
        : 'VOICE_RECOVERY_WRITE_FAILED';
}

async function resolveLocalContext(client, input) {
    const sessionResult = await client.query(
        `SELECT session.id AS session_id,
                session.direction AS session_direction,
                session.twilio_parent_call_sid,
                root.call_sid,
                root.contact_id,
                root.timeline_id,
                root.from_number,
                root.duration_sec,
                root.started_at
         FROM vapi_call_sessions session
         LEFT JOIN calls root
           ON root.company_id = session.company_id
          AND root.call_sid = session.twilio_parent_call_sid
         WHERE session.company_id = $1
           AND session.vapi_call_id = $2
         LIMIT 2`,
        [input.companyId, input.providerCallId],
    );
    if (sessionResult.rows.length === 1) return sessionResult.rows[0];
    if (sessionResult.rows.length > 1) {
        const error = new Error('VOICE_RECOVERY_SESSION_AMBIGUOUS');
        error.code = 'VOICE_RECOVERY_SESSION_AMBIGUOUS';
        throw error;
    }

    // Tokenless inbound fallback has no bound session. Link a Twilio root call
    // only when phone + provider time window produce one unambiguous local row;
    // otherwise keep the task on the phone timeline and do not guess a CallSid.
    if (!input.callerPhone || !input.providerStartedAt) return null;
    const candidates = await client.query(
        `SELECT NULL::uuid AS session_id,
                'inbound'::text AS session_direction,
                NULL::text AS twilio_parent_call_sid,
                call.call_sid,
                call.contact_id,
                call.timeline_id,
                call.from_number,
                call.duration_sec,
                call.started_at
         FROM calls call
         WHERE call.company_id = $1
           AND call.parent_call_sid IS NULL
           AND call.direction = 'inbound'
           AND RIGHT(REGEXP_REPLACE(COALESCE(call.from_number, ''), '[^0-9]', '', 'g'), 10)
               = RIGHT(REGEXP_REPLACE($2, '[^0-9]', '', 'g'), 10)
           AND COALESCE(call.started_at, call.created_at)
               BETWEEN $3::timestamptz - interval '5 minutes'
                   AND COALESCE($4::timestamptz, $3::timestamptz) + interval '5 minutes'
         ORDER BY ABS(EXTRACT(EPOCH FROM (
             COALESCE(call.started_at, call.created_at) - $3::timestamptz
         ))), call.id
         LIMIT 2`,
        [
            input.companyId,
            input.callerPhone,
            input.providerStartedAt,
            input.providerEndedAt,
        ],
    );
    return candidates.rows.length === 1 ? candidates.rows[0] : null;
}

async function resolveTimeline(client, input, local) {
    if (local?.timeline_id != null) {
        const owned = await client.query(
            `SELECT id, contact_id
             FROM timelines
             WHERE id = $1 AND company_id = $2
             LIMIT 1`,
            [local.timeline_id, input.companyId],
        );
        if (owned.rows[0]) return owned.rows[0];
    }
    if (local?.contact_id != null) {
        return timelinesQueries.findOrCreateTimelineByContact(
            local.contact_id,
            input.companyId,
            client,
        );
    }
    const callerPhone = normalizePhone(local?.from_number) || input.callerPhone;
    if (callerPhone) {
        return timelinesQueries.findOrCreateTimeline(callerPhone, input.companyId, client);
    }
    return timelinesQueries.findOrCreateAnonymousTimeline(input.companyId, client);
}

async function findOpenWork(client, input, contactId, callerPhone) {
    const { rows } = await client.query(
        `SELECT
             EXISTS (
                 SELECT 1
                 FROM leads lead
                 WHERE lead.company_id = $1
                   AND UPPER(COALESCE(lead.status, '')) NOT IN ('LOST', 'CONVERTED')
                   AND (
                       ($2::bigint IS NOT NULL AND lead.contact_id = $2::bigint)
                       OR ($3::text IS NOT NULL AND
                           RIGHT(REGEXP_REPLACE(COALESCE(lead.phone, ''), '[^0-9]', '', 'g'), 10)
                           = RIGHT(REGEXP_REPLACE($3::text, '[^0-9]', '', 'g'), 10))
                   )
             ) AS has_open_lead,
             EXISTS (
                 SELECT 1
                 FROM jobs job
                 LEFT JOIN contacts contact
                   ON contact.id = job.contact_id
                  AND contact.company_id = job.company_id
                 WHERE job.company_id = $1
                   AND UPPER(COALESCE(job.blanc_status, ''))
                       NOT IN ('JOB IS DONE', 'CANCELED', 'CANCELLED')
                   AND (
                       ($2::bigint IS NOT NULL AND job.contact_id = $2::bigint)
                       OR ($3::text IS NOT NULL AND
                           RIGHT(REGEXP_REPLACE(
                               COALESCE(NULLIF(contact.phone_e164, ''), NULLIF(job.customer_phone, ''), ''),
                               '[^0-9]', '', 'g'
                           ), 10) = RIGHT(REGEXP_REPLACE($3::text, '[^0-9]', '', 'g'), 10))
                   )
             ) AS has_open_job`,
        [input.companyId, contactId || null, callerPhone || null],
    );
    return rows[0] || { has_open_lead: false, has_open_job: false };
}

async function markSkipped(client, input, reason, context = {}) {
    await client.query(
        `UPDATE vapi_inbound_recovery_cases
         SET state = 'skipped',
             decision_reason = $3,
             vapi_call_session_id = COALESCE($4, vapi_call_session_id),
             call_sid = COALESCE($5, call_sid),
             timeline_id = COALESCE($6, timeline_id),
             contact_id = COALESCE($7, contact_id),
             observed_duration_seconds = COALESCE($8, observed_duration_seconds),
             next_retry_at = NULL,
             last_error_code = NULL,
             updated_at = now()
         WHERE provider_call_id = $1 AND company_id = $2`,
        [
            input.providerCallId,
            input.companyId,
            reason,
            context.sessionId || null,
            context.callSid || null,
            context.timelineId || null,
            context.contactId || null,
            context.durationSeconds ?? null,
        ],
    );
    return { status: 'skipped', reason, created: false };
}

async function createDispatcherTask(client, input, context) {
    const seconds = context.durationSeconds;
    const phoneLabel = context.callerPhone || 'number unavailable';
    const description = [
        `Call back ${phoneLabel}.`,
        `The voice assistant spoke with this caller for ${seconds} seconds, but no open lead or job exists.`,
        'Open the linked conversation to review its recording and transcript before calling.',
    ].join(' ');
    const inserted = await client.query(
        `INSERT INTO tasks (
             company_id, thread_id, subject_type, subject_id,
             title, description, status, priority, due_at,
             created_by, kind, agent_type, agent_input, agent_output
         ) VALUES (
             $1, $2, 'contact', $3,
             $4, $5, 'open', 'p1', now(),
             'agent', 'agent', 'voice_inbound_recovery', $6::jsonb, $7::jsonb
         )
         RETURNING id`,
        [
            input.companyId,
            context.timelineId,
            context.contactId || null,
            `Call back ${phoneLabel} — AI conversation needs follow-up`,
            description,
            JSON.stringify({
                source: 'voice_inbound_recovery',
                call_sid: context.callSid || null,
            }),
            JSON.stringify({
                reason: 'The AI conversation ended without an open lead or job.',
            }),
        ],
    );
    return inserted.rows[0].id;
}

async function processEndOfCallWithClient(rawInput, client) {
    const input = normalizeInput(rawInput);
    if (!input.companyId || !input.providerCallId) {
        const error = new Error('VOICE_RECOVERY_IDENTITY_REQUIRED');
        error.code = 'VOICE_RECOVERY_IDENTITY_REQUIRED';
        throw error;
    }

    await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`vapi-inbound-recovery:${input.providerCallId}`],
    );
    await client.query(
        `INSERT INTO vapi_inbound_recovery_cases (
             provider_call_id, company_id, state, caller_phone_e164,
             provider_call_type, provider_started_at, provider_ended_at,
             observed_duration_seconds
         ) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)
         ON CONFLICT (provider_call_id) DO NOTHING`,
        [
            input.providerCallId,
            input.companyId,
            input.callerPhone,
            input.providerCallType,
            input.providerStartedAt,
            input.providerEndedAt,
            input.providerDurationSeconds,
        ],
    );
    const existingResult = await client.query(
        `SELECT *
         FROM vapi_inbound_recovery_cases
         WHERE provider_call_id = $1
         FOR UPDATE`,
        [input.providerCallId],
    );
    const existing = existingResult.rows[0];
    if (!existing || String(existing.company_id) !== input.companyId) {
        const error = new Error('VOICE_RECOVERY_PROVIDER_CALL_COLLISION');
        error.code = 'VOICE_RECOVERY_PROVIDER_CALL_COLLISION';
        throw error;
    }
    if (existing.state === 'task_created' || existing.state === 'skipped') {
        return {
            status: existing.state,
            reason: existing.decision_reason,
            taskId: existing.task_id || null,
            created: false,
            idempotent: true,
        };
    }

    const effective = {
        ...input,
        providerCallType: input.providerCallType || existing.provider_call_type,
        callerPhone: input.callerPhone || existing.caller_phone_e164,
        providerStartedAt: input.providerStartedAt || validDate(existing.provider_started_at),
        providerEndedAt: input.providerEndedAt || validDate(existing.provider_ended_at),
        providerDurationSeconds: input.providerDurationSeconds
            ?? existing.observed_duration_seconds,
    };
    await client.query(
        `UPDATE vapi_inbound_recovery_cases
         SET attempt_count = attempt_count + 1,
             caller_phone_e164 = COALESCE($3, caller_phone_e164),
             provider_call_type = COALESCE($4, provider_call_type),
             provider_started_at = COALESCE($5, provider_started_at),
             provider_ended_at = COALESCE($6, provider_ended_at),
             observed_duration_seconds = COALESCE($7, observed_duration_seconds),
             updated_at = now()
         WHERE provider_call_id = $1 AND company_id = $2`,
        [
            effective.providerCallId,
            effective.companyId,
            effective.callerPhone,
            effective.providerCallType,
            effective.providerStartedAt,
            effective.providerEndedAt,
            effective.providerDurationSeconds,
        ],
    );

    await client.query('SAVEPOINT inbound_voice_recovery_work');
    try {
        const local = await resolveLocalContext(client, effective);
        const inboundConfirmed = local?.session_direction === 'inbound'
            || effective.providerCallType === 'inboundPhoneCall';
        if (!inboundConfirmed) {
            const skipped = await markSkipped(client, effective, 'not_verified_inbound');
            await client.query('RELEASE SAVEPOINT inbound_voice_recovery_work');
            return skipped;
        }

        const localDuration = local?.duration_sec == null ? null : Number(local.duration_sec);
        const durationCandidates = [localDuration, effective.providerDurationSeconds]
            .filter((value) => value != null && Number.isFinite(value) && value >= 0)
            .map((value) => Math.floor(value));
        // Twilio and Vapi callbacks race. A provisional local row may still say
        // zero while the authenticated EoC already carries the full duration;
        // take the best known observation rather than terminally classifying the
        // conversation as short from an early zero.
        const durationSeconds = durationCandidates.length > 0
            ? Math.max(...durationCandidates)
            : null;
        if (!Number.isInteger(durationSeconds) || durationSeconds < 0) {
            const error = new Error('VOICE_RECOVERY_DURATION_UNAVAILABLE');
            error.code = 'VOICE_RECOVERY_DURATION_UNAVAILABLE';
            throw error;
        }
        if (durationSeconds < minimumConversationSeconds()) {
            const skipped = await markSkipped(client, effective, 'short_call', {
                sessionId: local?.session_id,
                callSid: local?.call_sid,
                contactId: local?.contact_id,
                timelineId: local?.timeline_id,
                durationSeconds,
            });
            await client.query('RELEASE SAVEPOINT inbound_voice_recovery_work');
            return skipped;
        }

        const timeline = await resolveTimeline(client, effective, local);
        const callerPhone = normalizePhone(local?.from_number) || effective.callerPhone;
        const contactId = local?.contact_id || timeline?.contact_id || null;
        const openWork = await findOpenWork(client, effective, contactId, callerPhone);
        const common = {
            sessionId: local?.session_id,
            callSid: local?.call_sid,
            timelineId: timeline.id,
            contactId,
            durationSeconds,
        };
        if (openWork.has_open_lead) {
            const skipped = await markSkipped(client, effective, 'existing_open_lead', common);
            await client.query('RELEASE SAVEPOINT inbound_voice_recovery_work');
            return skipped;
        }
        if (openWork.has_open_job) {
            const skipped = await markSkipped(client, effective, 'existing_open_job', common);
            await client.query('RELEASE SAVEPOINT inbound_voice_recovery_work');
            return skipped;
        }

        const taskId = await createDispatcherTask(client, effective, {
            ...common,
            callerPhone,
        });
        await client.query(
            `UPDATE vapi_inbound_recovery_cases
             SET state = 'task_created',
                 decision_reason = 'missing_open_work',
                 vapi_call_session_id = $3,
                 call_sid = $4,
                 timeline_id = $5,
                 contact_id = $6,
                 task_id = $7,
                 observed_duration_seconds = $8,
                 next_retry_at = NULL,
                 last_error_code = NULL,
                 updated_at = now()
             WHERE provider_call_id = $1 AND company_id = $2`,
            [
                effective.providerCallId,
                effective.companyId,
                common.sessionId || null,
                common.callSid || null,
                common.timelineId,
                common.contactId,
                taskId,
                durationSeconds,
            ],
        );
        await client.query('RELEASE SAVEPOINT inbound_voice_recovery_work');
        return { status: 'task_created', taskId, created: true };
    } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT inbound_voice_recovery_work');
        await client.query('RELEASE SAVEPOINT inbound_voice_recovery_work');
        const code = errorCode(error);
        await client.query(
            `UPDATE vapi_inbound_recovery_cases
             SET state = 'retry_pending',
                 decision_reason = NULL,
                 next_retry_at = now() + ($3::integer * interval '1 minute'),
                 last_error_code = $4,
                 updated_at = now()
             WHERE provider_call_id = $1 AND company_id = $2`,
            [effective.providerCallId, effective.companyId, RETRY_DELAY_MINUTES, code],
        );
        console.error('[inboundVoiceRecovery] callback task deferred', {
            companyId: effective.companyId,
            providerCallId: effective.providerCallId,
            code,
        });
        return { status: 'retry_pending', reason: code, created: false };
    }
}

async function handleEndOfCall(input) {
    const result = await withTransaction(async (client) => {
        const processed = await processEndOfCallWithClient(input, client);
        if (processed.created && typeof client.afterCommit === 'function') {
            client.afterCommit(() => tasksService.emitTaskChange(input.companyId));
        }
        return processed;
    });
    return result;
}

async function sweepRetryPending({ now = new Date(), limit = SWEEP_LIMIT } = {}) {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= SWEEP_LIMIT
        ? limit
        : SWEEP_LIMIT;
    const { rows } = await db.query(
        `SELECT company_id, provider_call_id, provider_call_type,
                caller_phone_e164, provider_started_at, provider_ended_at,
                observed_duration_seconds
         FROM vapi_inbound_recovery_cases
         WHERE state = 'retry_pending'
           AND next_retry_at <= $1
         ORDER BY next_retry_at, provider_call_id
         LIMIT $2`,
        [now, safeLimit],
    );
    const results = [];
    for (const row of rows) {
        try {
            results.push(await handleEndOfCall({
                companyId: row.company_id,
                providerCallId: row.provider_call_id,
                providerCallType: row.provider_call_type,
                callerPhone: row.caller_phone_e164,
                providerStartedAt: row.provider_started_at,
                providerEndedAt: row.provider_ended_at,
                providerDurationSeconds: row.observed_duration_seconds,
            }));
        } catch (error) {
            console.error('[inboundVoiceRecovery] retry sweep failed', {
                companyId: row.company_id,
                providerCallId: row.provider_call_id,
                code: errorCode(error),
            });
            results.push({ status: 'failed' });
        }
    }
    return {
        due: rows.length,
        tasksCreated: results.filter((result) => result.created).length,
        stillPending: results.filter((result) =>
            result.status === 'retry_pending' || result.status === 'failed').length,
    };
}

module.exports = {
    DEFAULT_MIN_CONVERSATION_SECONDS,
    durationFromProvider,
    minimumConversationSeconds,
    processEndOfCallWithClient,
    handleEndOfCall,
    sweepRetryPending,
};
