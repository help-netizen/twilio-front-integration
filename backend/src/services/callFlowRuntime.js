/**
 * F017 Call Flow Runtime
 *
 * Executes the current group call-flow graph for inbound Twilio calls.
 */

const crypto = require('crypto');
const db = require('../db/connection');
const realtimeService = require('./realtimeService');
const groupRouting = require('./groupRouting');
const telephonyTenantService = require('./telephonyTenantService');
const vapiCallIdentityService = require('./vapiCallIdentityService');
const vapiInboundSafetyPolicy = require('./vapiInboundSafetyPolicy');
const callAgentExclusionService = require('./callAgentExclusionService');
const { buildSoftphoneIdentity } = require('./softphoneIdentity');
const { toE164 } = require('../utils/phoneUtils');

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function xmlResponse(inner) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}\n</Response>`;
}

function buildHangupTwiml(message) {
    const say = message ? `\n    <Say language="${process.env.VM_LANGUAGE || 'en-US'}">${escapeXml(message)}</Say>` : '';
    return xmlResponse(`${say}\n    <Hangup />`);
}

function buildVoicemailTwiml(context, node = {}) {
    const baseUrl = context.baseUrl;
    const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;
    const voicemailCompleteUrl = `${baseUrl}/webhooks/twilio/voicemail-complete?flowEvent=voicemail.recorded`;
    const cfg = node.config || {};
    const greeting = cfg.greeting_text ||
        (cfg.branchKey === 'after_hours'
            ? process.env.VM_AFTER_HOURS_GREETING
            : process.env.VM_GREETING) ||
        'Hello! Our team is currently assisting other customers. Please leave your name and phone number, and we will call you back as soon as possible.';
    const vmLanguage = process.env.VM_LANGUAGE || 'en-US';
    const vmMaxLen = Number(process.env.VM_MAXLEN || 180);
    const vmSilenceTimeout = Number(process.env.VM_SILENCE_TIMEOUT || 5);
    const vmFinishOnKey = process.env.VM_FINISH_ON_KEY || '#';

    return xmlResponse(`
    <Say language="${vmLanguage}">${escapeXml(greeting)}</Say>
    <Record maxLength="${vmMaxLen}"
            action="${voicemailCompleteUrl}"
            method="POST"
            timeout="${vmSilenceTimeout}"
            finishOnKey="${escapeXml(vmFinishOnKey)}"
            playBeep="true"
            transcribe="false"
            recordingStatusCallback="${recordingStatusUrl}"
            recordingStatusCallbackMethod="POST" />
    <Hangup />`);
}

function findNode(graph, nodeId) {
    return (graph.states || []).find(s => s.id === nodeId) || null;
}

function outgoing(graph, nodeId) {
    return (graph.transitions || []).filter(t => t.from_state_id === nodeId);
}

function getStartNode(graph) {
    return (graph.states || []).find(s => s.isInitial) ||
        (graph.states || []).find(s => s.kind === 'start') ||
        (graph.states || [])[0] ||
        null;
}

function eventMatches(edge, event) {
    if (!event) return edge.transitionMode === 'eventless' || edge.edgeRole === 'entry';
    const keys = String(edge.event_key || '').split(/\s+/).filter(Boolean);
    return keys.includes(event) || edge.edgeRole === event;
}

function branchKeyFromEdge(edge) {
    const explicit = edge.branchKey || edge.edgeRole;
    if (explicit) return String(explicit);
    const text = `${edge.label || ''} ${edge.edgeLabel || ''}`.toLowerCase();
    if (text.includes('after') || text.includes('closed')) return 'after_hours';
    if (text.includes('business') || text.includes('open')) return 'business_hours';
    return null;
}

function isConditionalCandidate(edge) {
    return edge.transitionMode === 'conditional' || edge.condExpr || branchKeyFromEdge(edge);
}

function chooseConditionalEdge(edges, context) {
    for (const edge of edges) {
        if (!edge.condExpr) continue;
        try {
            const keys = Object.keys(context);
            const fn = new Function(...keys, `"use strict"; return Boolean(${edge.condExpr});`);
            if (fn(...keys.map(k => context[k]))) return edge;
        } catch (err) {
            console.warn('[CallFlowRuntime] Bad condition ignored:', edge.condExpr, err.message);
        }
    }

    if (context.isBusinessHours === true) {
        const businessEdge = edges.find(e => branchKeyFromEdge(e) === 'business_hours');
        if (businessEdge) return businessEdge;
    }
    if (context.isBusinessHours === false) {
        const afterHoursEdge = edges.find(e => branchKeyFromEdge(e) === 'after_hours');
        if (afterHoursEdge) return afterHoursEdge;
    }

    return edges.find(e => branchKeyFromEdge(e) === 'else') ||
        edges.find(e => !e.condExpr && e.transitionMode !== 'conditional') ||
        null;
}

function nextNodeIdForEvent(graph, nodeId, event, context) {
    const edges = outgoing(graph, nodeId).filter(e => !e.hidden || e.edgeRole || e.transitionMode);
    if (event) {
        const matched = edges.find(e => eventMatches(e, event));
        return matched?.to_state_id || null;
    }
    const eventless = edges.find(e => eventMatches(e, null));
    if (eventless) return eventless.to_state_id;

    const conditional = edges.filter(isConditionalCandidate);
    const selected = chooseConditionalEdge(conditional, context);
    return selected?.to_state_id || null;
}

async function saveExecutionState(callSid, companyId, patch) {
    const result = await db.query(
        `UPDATE call_flow_executions
         SET current_node_id = COALESCE($3, current_node_id),
             context_json = COALESCE($4, context_json),
             status = COALESCE($5, status)
         WHERE call_sid = $1 AND company_id = $2
         RETURNING *`,
        [
            callSid,
            companyId,
            patch.currentNodeId ?? null,
            patch.contextJson ? JSON.stringify(patch.contextJson) : null,
            patch.status ?? null,
        ]
    );
    return result.rows[0] || null;
}

async function createExecution({ callSid, companyId, group, flow, context }) {
    const id = `cfe-${crypto.randomUUID().slice(0, 12)}`;
    const start = getStartNode(flow.graph);
    const contextJson = {
        ...context,
        groupId: group.id,
        groupName: group.name,
        graph: flow.graph,
        flowUpdatedAt: flow.updated_at,
    };

    const result = await db.query(
        `INSERT INTO call_flow_executions (id, company_id, call_sid, group_id, flow_id, current_node_id, context_json, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         ON CONFLICT (company_id, call_sid)
         DO UPDATE SET current_node_id = EXCLUDED.current_node_id,
                       context_json = EXCLUDED.context_json,
                       status = 'active'
         RETURNING *`,
        [id, companyId, callSid, group.id, flow.id, start?.id || null, JSON.stringify(contextJson)]
    );
    return result.rows[0];
}

function parseExecution(row) {
    if (!row) return null;
    let context = {};
    try { context = JSON.parse(row.context_json || '{}'); } catch { context = {}; }
    return { ...row, context };
}

async function getExecution(callSid, companyId) {
    if (!companyId) {
        const err = new Error('companyId is required for call-flow execution');
        err.code = 'TWILIO_TENANT_UNRESOLVED';
        throw err;
    }
    const result = await db.query(
        `SELECT * FROM call_flow_executions
         WHERE call_sid = $1 AND company_id::text = $2::text
         ORDER BY created_at DESC LIMIT 1`,
        [callSid, companyId]
    );
    return parseExecution(result.rows[0]);
}

async function completeVoicemailCall(execution, context) {
    const result = await db.query(
        `UPDATE calls
         SET status = 'voicemail_left',
             is_final = true,
             ended_at = COALESCE(ended_at, NOW()),
             last_event_time = NOW()
         WHERE call_sid = $1
           AND company_id::text = $2::text
         RETURNING *`,
        [execution.call_sid, execution.company_id]
    );

    realtimeService.broadcast('group.call.voicemail', {
        company_id: execution.company_id,
    });
    if (result.rows[0]) {
        realtimeService.publishCallUpdate({ eventType: 'call.updated', ...result.rows[0] });
    }
}

async function followFailureEdge({ execution, node, context, traceId, fallbackTwiml, events }) {
    const failureEvents = events || ['transfer.failed', 'queue.timeout', 'queue.failed', null];
    let nextId = null;
    for (const event of failureEvents) {
        nextId = nextNodeIdForEvent(context.graph, node.id, event, context);
        if (nextId) break;
    }
    if (!nextId) return fallbackTwiml();
    await saveExecutionState(execution.call_sid, execution.company_id, { currentNodeId: nextId, contextJson: context });
    return renderNodeById(execution.call_sid, execution.company_id, nextId, traceId);
}

async function renderQueueNode({ execution, node, context, traceId }) {
    const timeout = Number(node.config?.timeout_sec || process.env.DIAL_TIMEOUT || 25);
    const agents = await groupRouting.availableAgentsForGroup(context.groupId, execution.company_id, traceId);

    if (agents.length === 0) {
        realtimeService.broadcast('group.call.queued', {
            company_id: execution.company_id,
        });
        return followFailureEdge({
            execution,
            node,
            context,
            traceId,
            fallbackTwiml: () => buildVoicemailTwiml(context, node),
        });
    }

    const baseUrl = context.baseUrl;
    const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;
    const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;
    const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;
    const clients = agents.map(agent => `        <Client statusCallback="${statusCallbackUrl}"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">${escapeXml(agent.identity)}</Client>`).join('\n');

    realtimeService.broadcast('group.call.queued', {
        company_id: execution.company_id,
    });

    return xmlResponse(`
    <Dial timeout="${timeout}"
          answerOnBridge="true"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
${clients}
    </Dial>`);
}

async function findPhoneEnabledCompanyUser(companyId, userId) {
    const result = await db.query(
        `SELECT
             u.id,
             COALESCE(u.full_name, u.email, u.id::text) AS name,
             COALESCE(cup.phone_calls_allowed, false) AS phone_calls_allowed
         FROM company_memberships cm
         JOIN crm_users u ON u.id::text = cm.user_id::text
         LEFT JOIN company_user_profiles cup ON cup.membership_id = cm.id
         WHERE cm.company_id::text = $1::text
           AND cm.user_id::text = $2::text
           AND cm.status = 'active'
         LIMIT 1`,
        [companyId, userId]
    );
    const user = result.rows[0];
    if (!user || user.phone_calls_allowed !== true) return null;
    return user;
}

async function findTargetGroup(companyId, groupId) {
    const result = await db.query(
        `SELECT id, name, company_id
         FROM user_groups
         WHERE id = $1
           AND company_id::text = $2::text
         LIMIT 1`,
        [groupId, companyId]
    );
    return result.rows[0] || null;
}

async function renderTransferNode({ execution, node, context, traceId }) {
    const cfg = node.config || {};
    const targetType = cfg.target_type || 'external_number';
    const transferFailure = (message) => followFailureEdge({
        execution,
        node,
        context,
        traceId,
        fallbackTwiml: () => buildHangupTwiml(message),
    });

    if (targetType === 'phone_number_group') {
        const targetGroupId = String(cfg.target_group_id || '').trim();
        if (!targetGroupId) return transferFailure('Transfer target group is not configured.');
        const group = await findTargetGroup(execution.company_id, targetGroupId);
        if (!group) return transferFailure('Transfer target group is not available.');
        const nextContext = {
            ...context,
            groupId: group.id,
            groupName: group.name,
            transferFromGroupId: context.groupId,
            transferFromGroupName: context.groupName,
        };
        const queueNode = {
            ...node,
            kind: 'queue',
            config: {
                ...cfg,
                timeout_sec: Number(cfg.timeout_sec || process.env.DIAL_TIMEOUT || 25),
            },
        };
        await saveExecutionState(execution.call_sid, execution.company_id, { currentNodeId: node.id, contextJson: nextContext });
        return renderQueueNode({ execution, node: queueNode, context: nextContext, traceId });
    }

    const rawTarget = cfg.target_external_number || cfg.target_number || cfg.sip_uri || cfg.target_sip || cfg.target;
    let isSip = false;
    let target = null;
    let child = '';

    if (targetType === 'user') {
        const targetUserId = String(cfg.target_user_id || '').trim();
        if (!targetUserId) return transferFailure('Transfer target user is not configured.');
        const user = await findPhoneEnabledCompanyUser(execution.company_id, targetUserId);
        if (!user) return transferFailure('Transfer target user is not enabled for phone calls.');
        target = buildSoftphoneIdentity(execution.company_id, targetUserId);
        child = `<Client>${escapeXml(target)}</Client>`;
    } else {
        if (!rawTarget) return transferFailure('Transfer target is not configured.');
        isSip = String(rawTarget).startsWith('sip:');
        target = isSip ? String(rawTarget) : toE164(rawTarget);
        if (!target) return transferFailure('Transfer target phone number is invalid.');
        child = isSip ? `<Sip>${escapeXml(target)}</Sip>` : `<Number>${escapeXml(target)}</Number>`;
    }

    const baseUrl = context.baseUrl;
    const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;
    const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;

    const callerId = (() => {
        if (cfg.caller_id_policy === 'explicit_number') return toE164(cfg.explicit_caller_id_number);
        if (cfg.caller_id_policy === 'preserve_caller') return toE164(context.callerNumber);
        return toE164(context.calledNumber);
    })();
    const callerIdAttr = callerId ? ` callerId="${escapeXml(callerId)}"` : '';
    await saveExecutionState(execution.call_sid, execution.company_id, { currentNodeId: node.id, contextJson: context });
    return xmlResponse(`
    <Dial timeout="${Number(cfg.timeout_sec || process.env.DIAL_TIMEOUT || 25)}"
          answerOnBridge="true"
          ${callerIdAttr}
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
        ${child}
    </Dial>`);
}

// Hard wall-clock cap for an AI agent call leg (Twilio backstop). The VAPI
// assistant enforces its own maxDurationSeconds; this guards against a stuck
// SIP leg running indefinitely. 15 minutes. Assistant behaviour (greeting,
// prompt, voice, tools, duration) is configured in VAPI, not on the node.
const VAPI_MAX_DURATION_SECONDS = 900;

function appendSipQuery(sipUri, query) {
    // An unattributed call carries no token, and a bare trailing '?' is not a SIP URI
    // Twilio will dial — return the address untouched.
    if (!query) return escapeXml(sipUri);
    const separator = String(sipUri).includes('?') ? '&amp;' : '?';
    return `${escapeXml(sipUri)}${separator}${query}`;
}

// Where to send the caller when the identity reservation cannot be made. Pre-dates
// the reservation and stays as the answer-the-phone path: the resource row carries
// the SIP address on its own, independently of the assistant registry.
async function resolveVapiSipUriFallback(companyId, query = db.query) {
    if (!companyId) return null;
    // Deliberately NOT node.config.sip_uri. Flow nodes are tenant-editable, so honouring
    // an address from there would let a tenant aim the dial at another tenant's assistant
    // in the shared Vapi org — the hole T2 closed. Only the server-owned resource row counts.
    try {
        // provider_connections.status is an operator/provisioning lifecycle switch.
        // No Vapi health-check, webhook failure, or provider 5xx path mutates it, so
        // this cannot turn a transient provider/accounting failure into call denial.
        const result = await query(
            `SELECT NULLIF(BTRIM(r.sip_uri), '') AS sip_uri
             FROM vapi_tenant_resources r
             JOIN provider_connections pc
               ON pc.id = r.provider_connection_id
              AND pc.company_id = r.company_id
             WHERE ${vapiInboundSafetyPolicy.eligibleResourcePredicate('r', 'pc')}
             ORDER BY ${vapiInboundSafetyPolicy.preferredResourceOrder('r')}
             LIMIT 1`,
            [companyId],
        );
        return result.rows[0]?.sip_uri || null;
    } catch (err) {
        console.error('[CallFlowRuntime] SIP fallback lookup failed:', err.message);
        return null;
    }
}

async function renderVapiNode({ execution, node, context, traceId }, dependencies = {}) {
    const cfg = node.config || {};

    // AGENT-EXCLUSION-001: this caller may be flagged "the bot must not answer them"
    // (the company's manual agent-exclusions UNION its blacklist). Skip the assistant
    // and take the configured human/voicemail fallback edge — the call is NOT dropped.
    // FAIL-OPEN: any lookup error still answers with the bot. This gate must never be
    // the reason the phone goes dead.
    try {
        const botExcluded = await callAgentExclusionService.isExcludedForAgent(
            execution.company_id,
            context.callerNumber,
            dependencies.query || db.query,
        );
        if (botExcluded) {
            console.log(`[${traceId}] Caller ${context.callerNumber} is excluded from the agent; taking the fallback edge`);
            return followFailureEdge({
                execution,
                node,
                context,
                traceId,
                events: ['vapi.no_target', 'vapi.failed', 'vapi.timeout', null],
                fallbackTwiml: () => buildVoicemailTwiml(context, node),
            });
        }
    } catch (err) {
        console.warn(`[${traceId}] Agent-exclusion lookup failed; answering with the bot:`, err.message);
    }

    let reservation = null;
    try {
        reservation = await vapiCallIdentityService.reserveInboundSession({
            companyId: execution.company_id,
            twilioParentCallSid: execution.call_sid,
            flowExecutionId: execution.id,
            flowNodeId: node.id,
            // Purpose/environment are platform policy, never flow-node config.
            purpose: 'inbound_call',
            environment: 'prod',
        });
    } catch (error) {
        // Losing the identity means we cannot attribute this call's cost. That is an
        // accounting problem and it is loud — but it is NOT a reason to stop answering
        // the phone. A refused reservation used to drop the caller onto the failure
        // edge, which plays voicemail: a customer calling the office heard "our team
        // is currently assisting other customers" because a registry row was missing.
        console.error(
            '[CallFlowRuntime] Vapi reservation refused, dialling unattributed:',
            error.code || 'unknown',
        );
        const fallbackSipUri = await resolveVapiSipUriFallback(
            execution.company_id,
            dependencies.query || db.query,
        );
        if (!fallbackSipUri) {
            // No SIP address at all is the genuine "AI is not configured" case.
            return followFailureEdge({
                execution,
                node,
                context,
                traceId,
                events: ['vapi.no_target', 'vapi.failed', 'vapi.timeout', null],
                fallbackTwiml: () => buildHangupTwiml('AI agent is not configured.'),
            });
        }
        reservation = { sipUri: fallbackSipUri, correlationToken: null };
    }
    // vapiNode=1 → the dial-action handler maps the real DialCallStatus to a
    // vapi.* event: completed ends the call, failure/timeout follows the edge.
    const actionUrl = `${context.baseUrl}/webhooks/twilio/voice-dial-action?vapiNode=1`;
    const statusCallbackUrl = `${context.baseUrl}/webhooks/twilio/voice-status`;
    const recordingStatusUrl = `${context.baseUrl}/webhooks/twilio/recording-status`;
    // No token when the reservation was refused: the call still goes through, it just
    // arrives without an identity to bind to. assistant-request then selects only the
    // authenticated credential company's server-owned fallback assistant; an unknown
    // token remains a hard failure and can never borrow another company's session.
    const query = reservation.correlationToken
        ? new URLSearchParams({
            [vapiCallIdentityService.TOKEN_HEADER]: reservation.correlationToken,
        }).toString().replace(/&/g, '&amp;')
        : '';
    return xmlResponse(`
    <Dial action="${actionUrl}"
          method="POST"
          answerOnBridge="true"
          timeout="${Number(cfg.timeout_sec || 60)}"
          timeLimit="${VAPI_MAX_DURATION_SECONDS}"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
        <Sip statusCallback="${statusCallbackUrl}"
             statusCallbackEvent="initiated ringing answered completed"
             statusCallbackMethod="POST">${appendSipQuery(reservation.sipUri, query)}</Sip>
    </Dial>`);
}

async function renderNodeById(callSid, companyId, nodeId, traceId = 'call-flow') {
    const execution = await getExecution(callSid, companyId);
    if (!execution) return null;
    const context = execution.context || {};
    const graph = context.graph || { states: [], transitions: [] };
    const node = findNode(graph, nodeId);
    if (!node) {
        await saveExecutionState(callSid, execution.company_id, { status: 'failed' });
        return buildHangupTwiml('Call flow configuration error.');
    }

    await saveExecutionState(callSid, execution.company_id, { currentNodeId: node.id, contextJson: context });

    switch (node.kind) {
        case 'start': {
            const nextId = nextNodeIdForEvent(graph, node.id, null, context);
            if (!nextId) return buildHangupTwiml();
            return renderNodeById(callSid, companyId, nextId, traceId);
        }
        case 'branch': {
            const nextId = nextNodeIdForEvent(graph, node.id, null, context);
            if (!nextId) return buildHangupTwiml();
            return renderNodeById(callSid, companyId, nextId, traceId);
        }
        case 'greeting':
        case 'play_audio': {
            const nextId = nextNodeIdForEvent(graph, node.id, null, context);
            const redirect = nextId
                ? `\n    <Redirect method="POST">${context.baseUrl}/webhooks/twilio/voice-dial-action?flowEvent=node.completed</Redirect>`
                : '';
            const audioUrl = node.config?.audio_url || node.config?.url;
            const sayText = node.config?.text || node.config?.greeting_text || node.name;
            return xmlResponse(`${audioUrl ? `\n    <Play>${escapeXml(audioUrl)}</Play>` : `\n    <Say>${escapeXml(sayText)}</Say>`}${redirect}`);
        }
        case 'queue':
            return renderQueueNode({ execution, node, context, traceId });
        case 'voicemail':
            await saveExecutionState(callSid, execution.company_id, { status: 'voicemail' });
            return buildVoicemailTwiml(context, node);
        case 'transfer':
            return renderTransferNode({ execution, node, context, traceId });
        case 'vapi_agent':
            return renderVapiNode({ execution, node, context, traceId });
        case 'hangup':
            await saveExecutionState(callSid, execution.company_id, { status: 'completed' });
            return buildHangupTwiml(node.config?.message || node.config?.optional_message_text);
        case 'final':
            await saveExecutionState(callSid, execution.company_id, { status: 'completed' });
            return buildHangupTwiml();
        default:
            return buildHangupTwiml('Unsupported call flow node.');
    }
}

async function startExecution({ callSid, companyId, fromNumber, toNumber, group, flow, baseUrl, traceId }) {
    if (!companyId || String(group?.company_id) !== String(companyId)) {
        const err = new Error('Resolved company does not match call-flow group');
        err.code = 'TWILIO_TENANT_UNRESOLVED';
        throw err;
    }
    // TELEPHONY-AUTONOMOUS-MODE-001: a company-wide Autonomous mode forces EVERY
    // inbound call down its After-Hours branch. When OFF (default) behavior is
    // identical to today — the group's configured hours decide. Single indexed
    // PK lookup, cheap per call.
    // Fail-open: this override adds a SECOND per-call DB read before the hours
    // check. If it errors, degrade to normal-hours routing (fall through to
    // groupRouting.isBusinessHours) rather than rejecting the call.
    const autonomous = await telephonyTenantService.getAutonomousMode(companyId).catch(() => false);
    const businessHours = autonomous ? false : await groupRouting.isBusinessHours(group);
    if (autonomous) {
        console.log('[CallFlowRuntime] autonomous mode → forcing after-hours', {
            callSid, companyId,
        });
    }
    const context = {
        callSid,
        companyId,
        groupName: group.name,
        groupId: group.id,
        calledNumber: toNumber,
        callerNumber: fromNumber,
        isBusinessHours: businessHours,
        queueWaitTime: 0,
        baseUrl,
    };
    const execution = await createExecution({ callSid, companyId, group, flow, context });
    return renderNodeById(callSid, companyId, execution.current_node_id, traceId);
}

function eventFromDialStatus(dialStatus) {
    const status = String(dialStatus || '').toLowerCase();
    if (status === 'completed' || status === 'answered') return 'queue.connected';
    if (status === 'no-answer') return 'queue.timeout';
    if (status === 'busy' || status === 'failed' || status === 'canceled') return 'queue.failed';
    return 'queue.not_answered';
}

// Maps a vapi_agent Dial result to a vapi.* flow event.
// completed/answered → call is done (the assistant handled it) → end the call.
// no-answer → vapi.timeout, busy/failed/canceled → vapi.failed → follow the
// node's fallback edge (e.g. to a human queue).
function vapiEventFromDialStatus(dialStatus) {
    const status = String(dialStatus || '').toLowerCase();
    if (status === 'completed' || status === 'answered') return 'vapi.completed';
    if (status === 'no-answer') return 'vapi.timeout';
    return 'vapi.failed';
}

async function advance(callSid, event, traceId = 'call-flow', companyId) {
    const execution = await getExecution(callSid, companyId);
    const resolvedEvent = event || 'node.completed';
    const isVoicemailCompletion = ['voicemail.recorded', 'voicemail.completed'].includes(resolvedEvent);
    if (!execution) return null;
    if (execution.status !== 'active' && !(execution.status === 'voicemail' && isVoicemailCompletion)) return null;
    const context = execution.context || {};
    const graph = context.graph || { states: [], transitions: [] };
    const currentNode = findNode(graph, execution.current_node_id);
    if (!currentNode) return buildHangupTwiml();

    if (resolvedEvent === 'queue.connected' || resolvedEvent === 'call.handoff') {
        await saveExecutionState(callSid, execution.company_id, { status: 'completed' });
        realtimeService.broadcast('group.call.accepted', {
            company_id: execution.company_id,
        });
        return buildHangupTwiml();
    }

    // AI agent finished the call successfully → end the call. Failure/timeout
    // events (vapi.failed / vapi.timeout) fall through to edge routing below so
    // the flow can continue to a fallback node (e.g. a human queue).
    if (resolvedEvent === 'vapi.completed') {
        await saveExecutionState(callSid, execution.company_id, { status: 'completed' });
        return buildHangupTwiml();
    }

    const nextId = nextNodeIdForEvent(graph, currentNode.id, resolvedEvent, context) ||
        nextNodeIdForEvent(graph, currentNode.id, 'queue.timeout', context) ||
        nextNodeIdForEvent(graph, currentNode.id, null, context);
    if (!nextId) {
        await saveExecutionState(callSid, execution.company_id, { status: 'completed' });
        if (isVoicemailCompletion) await completeVoicemailCall(execution, context);
        return buildHangupTwiml();
    }

    await saveExecutionState(callSid, execution.company_id, { currentNodeId: nextId, contextJson: context });
    // SARA-BACKUP-HARDEN-001: a node renderer crash must never surface as a
    // webhook 500 — Twilio would drop the live caller (observed 2026-08-01:
    // pointer moved to n-vapi-bh-backup, no TwiML, parent died as no-answer).
    // Fail into voicemail: the call gets ANSWERED and the customer can speak.
    let twiml;
    try {
        twiml = await renderNodeById(callSid, companyId, nextId, traceId);
    } catch (err) {
        console.error(`[${traceId}] Node render crashed on ${nextId} — failing into voicemail:`, err.stack || err.message);
        await saveExecutionState(callSid, execution.company_id, { status: 'failed' }).catch(() => {});
        twiml = buildVoicemailTwiml(context);
    }
    if (isVoicemailCompletion) await completeVoicemailCall(execution, context);
    return twiml;
}

module.exports = {
    startExecution,
    advance,
    getExecution,
    eventFromDialStatus,
    vapiEventFromDialStatus,
    buildVoicemailTwiml,
    buildHangupTwiml,
    resolveVapiSipUriFallback,
    renderVapiNode,
};
