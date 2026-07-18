'use strict';

/**
 * OUTBOUND-CALL-CANCEL-001 — one customer-contact cancellation mechanism for
 * every scenario sharing outbound_call_attempts.
 *
 * The core is deliberately scenario-agnostic when selecting work: exact phone
 * digits + authoritative company + active status. Scenario knowledge is isolated
 * in SCENARIO_HANDLERS, where each entry declares its note target and any side
 * effects required to cancel that agent's retry chain.
 */

const { randomUUID } = require('node:crypto');
const db = require('../db/connection');
const eventService = require('./eventService');

const CAUSES = Object.freeze({
    DISPATCHER_CALL: 'customer_answered_dispatcher_call',
    INBOUND_CALL: 'customer_called_in',
    INBOUND_SMS: 'customer_replied_by_sms',
});

const CAUSE_COPY = Object.freeze({
    [CAUSES.DISPATCHER_CALL]: Object.freeze({
        leadNote: 'Scheduled automated calls canceled — customer answered a dispatcher call.',
        partsNote: (at) => `AI: robot call canceled — customer was already reached by phone (outbound call completed at ${at}).`,
        partsStamp: 'Canceled — customer was already reached by phone.',
    }),
    [CAUSES.INBOUND_CALL]: Object.freeze({
        leadNote: 'Scheduled automated calls canceled — customer called in.',
        partsNote: (at) => `AI: robot call canceled — customer was already reached by phone (inbound call completed at ${at}).`,
        partsStamp: 'Canceled — customer was already reached by phone.',
    }),
    [CAUSES.INBOUND_SMS]: Object.freeze({
        leadNote: 'Scheduled automated calls canceled — customer replied by SMS.',
        partsNote: () => 'AI: robot call canceled — customer replied by SMS.',
        partsStamp: 'Canceled — customer replied by SMS.',
    }),
});

const MIDFLIGHT_NOTE_SUFFIX = ' A call already in progress will not be retried.';
const PARTS_VISIT_TASK_KIND = 'part_arrived_call';
const PARTS_VISIT_DEFAULT_ACTIONS = Object.freeze([
    Object.freeze({ type: 'robot_call', label: '🤖 Let the robot call' }),
    Object.freeze({ type: 'manual_call', label: "📞 I'll call myself" }),
]);

function normalizeDialablePhone(raw) {
    const str = String(raw ?? '').trim();
    const digits = str.replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    if (str.startsWith('+') && digits.length >= 10 && digits.length <= 15) return '+' + digits;
    return null;
}

function normalizeContactAt(value) {
    const parsed = value == null ? null : new Date(value);
    return parsed && !Number.isNaN(parsed.getTime())
        ? parsed.toISOString()
        : new Date().toISOString();
}

function rowCount(result) {
    if (!result) return 0;
    if (result.rowCount != null) return result.rowCount;
    return Array.isArray(result.rows) ? result.rows.length : 0;
}

async function appendLeadNotes(client, companyId, leadUuids, noteText) {
    const noted = await client.query(
        `UPDATE leads
         SET structured_notes =
                (CASE
                    WHEN jsonb_typeof(COALESCE(structured_notes, '[]'::jsonb)) = 'array'
                        THEN COALESCE(structured_notes, '[]'::jsonb)
                    ELSE '[]'::jsonb
                 END)
                || jsonb_build_array(jsonb_build_object(
                    'id', gen_random_uuid()::text,
                    'text', $3::text,
                    'created', now(),
                    'created_by', 'system',
                    'author', 'AI Phone'
                )),
             updated_at = now()
         WHERE company_id = $1 AND uuid = ANY($2::varchar[])
         RETURNING uuid`,
        [companyId, leadUuids, noteText]
    );
    const notedUuids = new Set((noted.rows || []).map((row) => row.uuid));
    if (notedUuids.size !== leadUuids.length || leadUuids.some((uuid) => !notedUuids.has(uuid))) {
        throw new Error('cancel_note_target_mismatch:lead_call');
    }
}

async function appendJobNote(client, companyId, jobId, noteText) {
    const noteId = randomUUID();
    const noted = await client.query(
        `UPDATE jobs
         SET notes =
                (CASE
                    WHEN jsonb_typeof(COALESCE(notes, '[]'::jsonb)) = 'array'
                        THEN COALESCE(notes, '[]'::jsonb)
                    ELSE '[]'::jsonb
                 END)
                || jsonb_build_array(jsonb_build_object(
                    'id', $3::text,
                    'text', $4::text,
                    'created', now(),
                    'created_by', 'system',
                    'author', 'AI Phone'
                )),
             updated_at = now()
         WHERE company_id = $1 AND id = $2
         RETURNING id, zenbooker_job_id`,
        [companyId, jobId, noteId, noteText]
    );
    if (!noted.rows || noted.rows.length !== 1) {
        throw new Error('cancel_note_target_mismatch:parts_visit');
    }
    return {
        jobId,
        noteId,
        noteText,
        zenbookerJobId: noted.rows[0].zenbooker_job_id || null,
    };
}

async function stampPartsTask(client, companyId, jobId, rows, reason) {
    let taskId = (rows.find((row) => row.task_id != null) || {}).task_id ?? null;
    if (taskId == null) {
        const task = await client.query(
            `SELECT id FROM tasks
             WHERE company_id = $1 AND job_id = $2 AND kind = $3 AND status = 'open'
             LIMIT 1`,
            [companyId, jobId, PARTS_VISIT_TASK_KIND]
        );
        taskId = task.rows && task.rows[0] ? task.rows[0].id : null;
    }
    if (taskId == null) return;

    const task = await client.query(
        `SELECT actions FROM tasks WHERE company_id = $1 AND id = $2 LIMIT 1`,
        [companyId, taskId]
    );
    if (!task.rows || task.rows.length === 0) return;
    const actions = Array.isArray(task.rows[0].actions)
        ? task.rows[0].actions
        : PARTS_VISIT_DEFAULT_ACTIONS;
    const next = actions.map((action) => {
        if (!action || action.type !== 'robot_call') return action;
        return { ...action, state: 'canceled', reason };
    });
    const stamped = await client.query(
        `UPDATE tasks SET actions = $3::jsonb
         WHERE company_id = $1 AND id = $2
         RETURNING id`,
        [companyId, taskId, JSON.stringify(next)]
    );
    if (rowCount(stamped) !== 1) throw new Error('cancel_task_target_mismatch:parts_visit');
}

async function cancelLeadScenario({ client, companyId, rows, cause, copy }) {
    const ids = rows.map((row) => row.id);
    const canceled = await client.query(
        `UPDATE outbound_call_attempts
         SET status = 'canceled', reason = $3, updated_at = now()
         WHERE company_id = $1
           AND id = ANY($2::bigint[])
           AND scenario = 'lead_call'
           AND status IN ('pending', 'dialing')
         RETURNING id, lead_uuid`,
        [companyId, ids, cause]
    );
    const changed = canceled.rows || [];
    if (changed.length === 0) return { canceled: 0, marker: false, events: [], syncNotes: [] };
    if (changed.some((row) => !row.lead_uuid)) {
        throw new Error('cancel_note_target_missing:lead_call');
    }

    const leadUuids = [...new Set(changed.map((row) => row.lead_uuid))];
    await appendLeadNotes(client, companyId, leadUuids, copy.leadNote);
    return {
        canceled: changed.length,
        marker: false,
        syncNotes: [],
        events: leadUuids.map((leadUuid) => ({
            aggregateType: 'lead',
            aggregateId: leadUuid,
            eventType: 'outbound_lead_call_canceled',
            eventData: { reason: cause },
        })),
    };
}

async function insertPartsMarker(client, companyId, row, cause) {
    const marker = await client.query(
        `INSERT INTO outbound_call_attempts
            (company_id, job_id, task_id, contact_id, phone, attempt_no,
             status, scheduled_at, slot_json, reason, scenario)
         SELECT $1, $2, $3, $4, $5, $6,
                'canceled', now(), $7::jsonb, $8, $9
         WHERE NOT EXISTS (
             SELECT 1 FROM outbound_call_attempts
              WHERE company_id = $1
                AND scenario = $9
                AND job_id = $2
                AND status = 'canceled'
                AND id > $10
         )
         RETURNING id`,
        [
            companyId,
            row.job_id,
            row.task_id,
            row.contact_id,
            row.phone,
            row.attempt_no,
            row.slot_json ? JSON.stringify(row.slot_json) : null,
            cause,
            row.scenario,
            row.id,
        ]
    );
    return rowCount(marker) > 0;
}

async function cancelPartsScenario({ client, companyId, rows, cause, copy, contactAt }) {
    const byJob = new Map();
    for (const row of rows) {
        if (!row.job_id) throw new Error('cancel_note_target_missing:parts_visit');
        if (!byJob.has(row.job_id)) byJob.set(row.job_id, []);
        byJob.get(row.job_id).push(row);
    }

    let canceledCount = 0;
    let anyMarker = false;
    const events = [];
    const syncNotes = [];

    for (const [jobId, jobRows] of byJob) {
        let flipped = 0;
        let marker = false;
        for (const row of jobRows) {
            if (row.status === 'pending') {
                const canceled = await client.query(
                    `UPDATE outbound_call_attempts
                     SET status = 'canceled', reason = $3, updated_at = now()
                     WHERE company_id = $1
                       AND id = $2
                       AND scenario = 'parts_visit'
                       AND status = 'pending'
                     RETURNING id`,
                    [companyId, row.id, cause]
                );
                if (rowCount(canceled) > 0) {
                    flipped += 1;
                    continue;
                }
            }
            if (row.status === 'dialing') {
                marker = (await insertPartsMarker(client, companyId, row, cause)) || marker;
            }
        }

        if (flipped === 0 && !marker) continue;
        canceledCount += flipped;
        anyMarker = anyMarker || marker;

        const noteText = copy.partsNote(contactAt) + (marker ? MIDFLIGHT_NOTE_SUFFIX : '');
        syncNotes.push(await appendJobNote(client, companyId, jobId, noteText));
        await stampPartsTask(client, companyId, jobId, jobRows, copy.partsStamp);
        events.push({
            aggregateType: 'job',
            aggregateId: jobId,
            eventType: 'outbound_call_canceled',
            eventData: { canceled: flipped, marker, kind: 'customer_contact', reason: cause },
        });
    }

    return { canceled: canceledCount, marker: anyMarker, events, syncNotes };
}

const SCENARIO_HANDLERS = Object.freeze({
    lead_call: Object.freeze({
        noteTarget: 'leads.structured_notes',
        cancel: cancelLeadScenario,
    }),
    parts_visit: Object.freeze({
        noteTarget: 'jobs.notes',
        cancel: cancelPartsScenario,
        sideEffects: Object.freeze(['canceled_marker_for_dialing', 'part_arrived_call_task_stamp']),
    }),
});

async function syncJobNoteAfterCommit(companyId, note) {
    if (!note.zenbookerJobId) return;
    try {
        const zenbookerClient = require('./zenbookerClient');
        const response = await zenbookerClient.addJobNote(note.zenbookerJobId, { text: note.noteText });
        const zbNoteId = response?.id
            || response?.note?.id
            || (Array.isArray(response?.job_notes)
                ? response.job_notes[response.job_notes.length - 1]?.id
                : null);
        if (!zbNoteId) return;
        await db.query(
            `UPDATE jobs j
             SET notes = (
                 SELECT jsonb_agg(
                     CASE WHEN elem->>'id' = $3
                          THEN elem || jsonb_build_object('zb_note_id', $4::text)
                          ELSE elem END
                     ORDER BY ord
                 )
                 FROM jsonb_array_elements(j.notes) WITH ORDINALITY AS t(elem, ord)
             ), updated_at = now()
             WHERE j.company_id = $1 AND j.id = $2
               AND jsonb_typeof(j.notes) = 'array'`,
            [companyId, note.jobId, note.noteId, String(zbNoteId)]
        );
    } catch (err) {
        console.warn('[outboundCallCancellation] Zenbooker note sync failed (non-fatal):', err && err.message);
    }
}

/**
 * Cancel every active outbound attempt to this customer in this company.
 * Cancellation + local dispatcher-visible notes + transactional scenario side
 * effects are one DB transaction. Unknown scenarios roll the entire operation
 * back so an attempt can never be canceled without a declared note target.
 */
async function cancel({ companyId, rawPhone, cause, contactAt } = {}) {
    const phone = normalizeDialablePhone(rawPhone);
    const copy = CAUSE_COPY[cause];
    if (!companyId || !phone || !copy) return { canceled: 0, marker: false };

    const phoneDigits = phone.replace(/\D/g, '');
    const normalizedAt = normalizeContactAt(contactAt);
    let client = null;
    let canceledCount = 0;
    let anyMarker = false;
    const events = [];
    const syncNotes = [];
    try {
        client = await db.getClient();
        await client.query('BEGIN');
        const active = await client.query(
            `SELECT id, company_id, scenario, job_id, lead_uuid, task_id,
                    contact_id, phone, attempt_no, status, slot_json
             FROM outbound_call_attempts
             WHERE company_id = $1
               AND (
                    regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
                    OR (
                        length($2) = 11 AND left($2, 1) = '1'
                        AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') ~ '^(1)?[0-9]{10}$'
                        AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10)
                            = right($2, 10)
                    )
               )
               AND status IN ('pending', 'dialing')
             ORDER BY id
             FOR UPDATE`,
            [companyId, phoneDigits]
        );
        const rows = active.rows || [];
        if (rows.length === 0) {
            await client.query('COMMIT');
            return { canceled: 0, marker: false };
        }

        const byScenario = new Map();
        for (const row of rows) {
            if (!byScenario.has(row.scenario)) byScenario.set(row.scenario, []);
            byScenario.get(row.scenario).push(row);
        }
        for (const scenario of byScenario.keys()) {
            if (!SCENARIO_HANDLERS[scenario]) {
                throw new Error(`cancel_scenario_not_declared:${scenario}`);
            }
        }

        for (const [scenario, scenarioRows] of byScenario) {
            const result = await SCENARIO_HANDLERS[scenario].cancel({
                client,
                companyId,
                rows: scenarioRows,
                cause,
                copy,
                contactAt: normalizedAt,
            });
            canceledCount += result.canceled;
            anyMarker = anyMarker || result.marker;
            events.push(...result.events);
            syncNotes.push(...result.syncNotes);
        }
        await client.query('COMMIT');
    } catch (err) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch { /* non-fatal */ }
        }
        console.warn('[outboundCallCancellation] cancel failed (non-fatal):', err && err.message);
        return { canceled: 0, marker: false };
    } finally {
        if (client) {
            try { client.release(); } catch { /* non-fatal */ }
        }
    }

    for (const event of events) {
        try {
            eventService.logEvent(
                companyId,
                event.aggregateType,
                event.aggregateId,
                event.eventType,
                event.eventData,
                'system'
            );
        } catch { /* non-fatal */ }
    }
    for (const note of syncNotes) await syncJobNoteAfterCommit(companyId, note);

    console.log(
        `[outboundCallCancellation] ${cause} ${phone} → canceled=${canceledCount} marker=${anyMarker}`
    );
    return { canceled: canceledCount, marker: anyMarker };
}

async function saraHandledCall(call, query) {
    const result = await query(
        `SELECT current_node_id, context_json
         FROM call_flow_executions
         WHERE company_id = $1 AND call_sid = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [call.company_id, call.call_sid]
    );
    const row = result.rows && result.rows[0];
    if (!row || !row.current_node_id) return false;
    let context = {};
    try { context = JSON.parse(row.context_json || '{}'); } catch { context = {}; }
    const states = context?.graph && Array.isArray(context.graph.states)
        ? context.graph.states
        : [];
    const node = states.find((state) => state && state.id === row.current_node_id);
    return !!(node && node.kind === 'vapi_agent');
}

/**
 * Shared voice-trigger detector. It enforces the completed-human-call predicate
 * itself so webhook and reconciliation ingestion cannot drift, and excludes our
 * own VAPI/Sara calls before invoking the one cancellation core.
 */
async function cancelForCompletedCustomerCall(call, client = null) {
    try {
        if (!call || !call.company_id) return { canceled: 0, marker: false };
        if (!call.is_final || call.status !== 'completed' || call.parent_call_sid != null) {
            return { canceled: 0, marker: false };
        }
        if (Number(call.duration_sec || 0) <= 0 || call.answered_at == null) {
            return { canceled: 0, marker: false };
        }
        if (call.direction !== 'inbound' && call.direction !== 'outbound') {
            return { canceled: 0, marker: false };
        }
        if (String(call.call_sid || '').startsWith('vapi:') || String(call.answered_by || '') === 'ai') {
            return { canceled: 0, marker: false };
        }

        const query = client ? client.query.bind(client) : db.query.bind(db);
        if (await saraHandledCall(call, query)) return { canceled: 0, marker: false };

        return cancel({
            companyId: call.company_id,
            rawPhone: call.direction === 'inbound' ? call.from_number : call.to_number,
            cause: call.direction === 'outbound' ? CAUSES.DISPATCHER_CALL : CAUSES.INBOUND_CALL,
            contactAt: call.ended_at,
        });
    } catch (err) {
        console.warn('[outboundCallCancellation] completed-call trigger failed (non-fatal):', err && err.message);
        return { canceled: 0, marker: false };
    }
}

module.exports = {
    CAUSES,
    SCENARIO_HANDLERS,
    PARTS_VISIT_TASK_KIND,
    PARTS_VISIT_DEFAULT_ACTIONS,
    normalizeDialablePhone,
    cancel,
    cancelForCompletedCustomerCall,
};
