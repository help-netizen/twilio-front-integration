'use strict';

/**
 * OB-66 Vapi-only recommendSlots audit and callback seam.
 *
 * The provider call id is globally unique in the platform Vapi account, while
 * every read/write also carries the secret-bound company id. The exact parsed
 * tool arguments and exact skill result are stored before the unchanged Vapi
 * response envelope is built. Repeated delivery of one tool_call_id is
 * idempotent. A served-area availability failure creates one real dispatcher
 * callback through inboundVoiceRecoveryService's provider-call lock.
 */

const tasksService = require('./tasksService');
const tasksQueries = require('../db/tasksQueries');
const { withTransaction } = require('./transactionService');
const inboundVoiceRecoveryService = require('./inboundVoiceRecoveryService');

function callbackRequired(result) {
    if (!result || result.available !== false) return false;
    if (result.reason === 'out_of_area' || result.reason === 'no_provider_for_area') {
        return false;
    }
    return result.fallback === true;
}

function transcriptFromMessage(message) {
    const value = message?.transcript ?? message?.artifact?.transcript;
    return typeof value === 'string' && value.trim() ? value : null;
}

async function resolveCallSidWithClient(client, companyId, providerCallId, call = {}) {
    const session = await client.query(
        `SELECT session.twilio_parent_call_sid AS call_sid
         FROM vapi_call_sessions session
         WHERE session.company_id = $1
           AND session.vapi_call_id = $2
         LIMIT 2`,
        [companyId, providerCallId],
    );
    if (session.rows.length === 1 && session.rows[0].call_sid) {
        return session.rows[0].call_sid;
    }
    if (session.rows.length > 1) {
        const error = new Error('VAPI_RECOMMEND_AUDIT_SESSION_AMBIGUOUS');
        error.code = 'VAPI_RECOMMEND_AUDIT_SESSION_AMBIGUOUS';
        throw error;
    }

    const candidate = call.phoneCallProviderId;
    if (!candidate) return null;
    const local = await client.query(
        `SELECT call_sid
         FROM calls
         WHERE company_id = $1 AND call_sid = $2
         LIMIT 2`,
        [companyId, candidate],
    );
    return local.rows.length === 1 ? local.rows[0].call_sid : null;
}

async function recordInvocationWithClient(input, client) {
    const companyId = String(input.companyId || '').trim();
    const providerCallId = String(input.providerCallId || input.call?.id || '').trim();
    const toolCallId = String(input.toolCallId || '').trim();
    if (!companyId || !providerCallId || !toolCallId) {
        const error = new Error('VAPI_RECOMMEND_AUDIT_IDENTITY_REQUIRED');
        error.code = 'VAPI_RECOMMEND_AUDIT_IDENTITY_REQUIRED';
        throw error;
    }

    const callSid = await resolveCallSidWithClient(
        client,
        companyId,
        providerCallId,
        input.call,
    );
    const invocation = {
        tool_call_id: toolCallId,
        arguments: input.arguments && typeof input.arguments === 'object'
            ? input.arguments
            : {},
        result: input.result && typeof input.result === 'object'
            ? input.result
            : {},
        observed_at: (input.observedAt || new Date()).toISOString(),
    };
    const appended = await client.query(
        `INSERT INTO vapi_recommend_slots_call_audits (
             provider_call_id, company_id, call_sid, invocations
         ) VALUES ($1, $2, $5, jsonb_build_array($4::jsonb))
         ON CONFLICT (provider_call_id) DO UPDATE
         SET call_sid = COALESCE(
                 vapi_recommend_slots_call_audits.call_sid,
                 EXCLUDED.call_sid
             ),
             invocations = CASE
                 WHEN vapi_recommend_slots_call_audits.invocations
                      @> jsonb_build_array(jsonb_build_object('tool_call_id', $3::text))
                 THEN vapi_recommend_slots_call_audits.invocations
                 ELSE vapi_recommend_slots_call_audits.invocations || $4::jsonb
             END,
             updated_at = now()
         WHERE vapi_recommend_slots_call_audits.company_id = EXCLUDED.company_id
         RETURNING callback_task_id`,
        [
            providerCallId,
            companyId,
            toolCallId,
            JSON.stringify(invocation),
            callSid,
        ],
    );
    if (appended.rows.length !== 1) {
        const error = new Error('VAPI_RECOMMEND_AUDIT_PROVIDER_CALL_COLLISION');
        error.code = 'VAPI_RECOMMEND_AUDIT_PROVIDER_CALL_COLLISION';
        throw error;
    }

    if (!input.inbound || !callbackRequired(input.result)) {
        return {
            recorded: true,
            callbackCreated: false,
            taskId: appended.rows[0].callback_task_id || null,
        };
    }

    const callback = await inboundVoiceRecoveryService.createSlotUnavailableCallbackWithClient({
        companyId,
        providerCallId,
        message: { call: input.call || {} },
        inboundTrusted: true,
    }, client);
    if (callback.taskId != null) {
        await client.query(
            `UPDATE vapi_recommend_slots_call_audits audit
             SET callback_task_id = $3,
                 call_sid = COALESCE(audit.call_sid, recovery.call_sid),
                 updated_at = now()
             FROM vapi_inbound_recovery_cases recovery
             WHERE audit.provider_call_id = $1
               AND audit.company_id = $2
               AND recovery.provider_call_id = audit.provider_call_id
               AND recovery.company_id = audit.company_id`,
            [providerCallId, companyId, callback.taskId],
        );
    }
    return {
        recorded: true,
        callbackCreated: callback.created === true,
        taskId: callback.taskId || null,
        callbackStatus: callback.status,
    };
}

async function recordInvocation(input) {
    return withTransaction(async (client) => {
        const result = await recordInvocationWithClient(input, client);
        if (result.callbackCreated && typeof client.afterCommit === 'function') {
            client.afterCommit(() => tasksService.emitTaskChange(input.companyId));
        }
        return result;
    });
}

async function recordEndOfCallWithClient(input, client) {
    const companyId = String(input.companyId || '').trim();
    const message = input.message || {};
    const providerCallId = String(input.providerCallId || message.call?.id || '').trim();
    if (!companyId || !providerCallId) return { updated: false };

    const callSid = await resolveCallSidWithClient(
        client,
        companyId,
        providerCallId,
        message.call,
    );
    const transcript = transcriptFromMessage(message);
    const updated = await client.query(
        `UPDATE vapi_recommend_slots_call_audits
         SET call_sid = COALESCE(call_sid, $3),
             transcript = COALESCE($4, transcript),
             updated_at = now()
         WHERE provider_call_id = $1 AND company_id = $2
         RETURNING provider_call_id`,
        [providerCallId, companyId, callSid, transcript],
    );
    return { updated: updated.rows.length === 1 };
}

/**
 * Parent the call's slot-unavailable callback task to the lead the same call
 * produced.
 *
 * The task is written mid-call, the moment the engine reports no window — it has
 * to be, because its whole job is to not lose the caller, and at that point there
 * is no lead yet (observed 2026-08-19: task at 23:23:13, lead at 23:23:38). So it
 * lands with only `thread_id`, and `tasksQueries` derives a task's parent from
 * whichever FK is set — with just a thread it reads as a task on the conversation
 * rather than on the lead a dispatcher actually needs to open.
 *
 * `callback_task_id` on this call's audit row is the pointer back to it. Attaching
 * is idempotent (only fills a NULL `lead_id`), company-scoped, and leaves
 * `thread_id` in place so the recording and transcript stay one click away.
 *
 * @returns {Promise<{attached: boolean, taskId: number|null}>}
 */
async function attachLeadToCallbackTaskWithClient(input, client) {
    const companyId = String(input.companyId || '').trim();
    const providerCallId = String(input.providerCallId || input.call?.id || '').trim();
    const leadRef = input.leadRef == null ? '' : String(input.leadRef).trim();
    if (!companyId || !providerCallId || !leadRef) return { attached: false, taskId: null };

    const leadId = await tasksQueries.resolveParentId(companyId, 'lead', leadRef, client);
    if (leadId == null) return { attached: false, taskId: null };

    const { rows } = await client.query(
        `UPDATE tasks t
         SET lead_id = $3, updated_at = now()
         FROM vapi_recommend_slots_call_audits a
         WHERE a.provider_call_id = $1
           AND a.company_id = $2
           AND t.id = a.callback_task_id
           AND t.company_id = $2
           AND t.lead_id IS NULL
         RETURNING t.id`,
        [providerCallId, companyId, leadId],
    );
    return { attached: rows.length === 1, taskId: rows[0]?.id ?? null };
}

async function attachLeadToCallbackTask(input) {
    return withTransaction((client) => attachLeadToCallbackTaskWithClient(input, client));
}

async function recordEndOfCall(input) {
    return withTransaction((client) => recordEndOfCallWithClient(input, client));
}

module.exports = {
    callbackRequired,
    transcriptFromMessage,
    recordInvocationWithClient,
    recordInvocation,
    recordEndOfCallWithClient,
    recordEndOfCall,
    attachLeadToCallbackTaskWithClient,
    attachLeadToCallbackTask,
};
