/**
 * F017 Call Flow Runtime
 *
 * Executes the current group call-flow graph for inbound Twilio calls.
 */

const crypto = require('crypto');
const db = require('../db/connection');
const realtimeService = require('./realtimeService');
const groupRouting = require('./groupRouting');
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
         ON CONFLICT (call_sid)
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

async function getExecution(callSid) {
    const result = await db.query(
        `SELECT * FROM call_flow_executions WHERE call_sid = $1 ORDER BY created_at DESC LIMIT 1`,
        [callSid]
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
        call_sid: execution.call_sid,
        group_id: context.groupId,
        from_number: context.callerNumber,
        to_number: context.calledNumber,
    });
    if (result.rows[0]) {
        realtimeService.publishCallUpdate({ eventType: 'call.updated', ...result.rows[0] });
    }
}

async function followFailureEdge({ execution, node, context, traceId, fallbackTwiml }) {
    const nextId = nextNodeIdForEvent(context.graph, node.id, 'transfer.failed', context) ||
        nextNodeIdForEvent(context.graph, node.id, 'queue.timeout', context) ||
        nextNodeIdForEvent(context.graph, node.id, 'queue.failed', context) ||
        nextNodeIdForEvent(context.graph, node.id, null, context);
    if (!nextId) return fallbackTwiml();
    await saveExecutionState(execution.call_sid, execution.company_id, { currentNodeId: nextId, contextJson: context });
    return renderNodeById(execution.call_sid, nextId, traceId);
}

async function renderQueueNode({ execution, node, context, traceId }) {
    const timeout = Number(node.config?.timeout_sec || process.env.DIAL_TIMEOUT || 25);
    const agents = await groupRouting.availableAgentsForGroup(context.groupId, execution.company_id, traceId);

    if (agents.length === 0) {
        realtimeService.broadcast('group.call.queued', {
            call_sid: execution.call_sid,
            group_id: context.groupId,
            from_number: context.callerNumber,
            to_number: context.calledNumber,
            status: 'no_available_agents',
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
        call_sid: execution.call_sid,
        group_id: context.groupId,
        from_number: context.callerNumber,
        to_number: context.calledNumber,
        agent_count: agents.length,
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

function renderVapiNode(node, context) {
    const cfg = node.config || {};
    const sipUri = cfg.sip_uri || cfg.sipUri || process.env.VAPI_SIP_URI;
    if (!sipUri) return buildHangupTwiml('AI agent is not configured.');
    const actionUrl = `${context.baseUrl}/webhooks/twilio/voice-dial-action?flowEvent=vapi.completed`;
    const query = new URLSearchParams({
        'x-blanc-company-id': context.companyId,
        'x-blanc-group-id': context.groupId,
        'x-blanc-called-number': context.calledNumber || '',
        'x-blanc-call-sid': context.callSid || '',
    }).toString().replace(/&/g, '&amp;');
    return xmlResponse(`
    <Dial action="${actionUrl}" method="POST" answerOnBridge="true" timeout="${Number(cfg.timeout_sec || 60)}">
        <Sip>${escapeXml(sipUri)}?${query}</Sip>
    </Dial>`);
}

async function renderNodeById(callSid, nodeId, traceId = 'call-flow') {
    const execution = await getExecution(callSid);
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
            return renderNodeById(callSid, nextId, traceId);
        }
        case 'branch': {
            const nextId = nextNodeIdForEvent(graph, node.id, null, context);
            if (!nextId) return buildHangupTwiml();
            return renderNodeById(callSid, nextId, traceId);
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
            return renderVapiNode(node, context);
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

async function startExecution({ callSid, fromNumber, toNumber, group, flow, baseUrl, traceId }) {
    const businessHours = await groupRouting.isBusinessHours(group);
    const context = {
        callSid,
        companyId: group.company_id,
        groupName: group.name,
        groupId: group.id,
        calledNumber: toNumber,
        callerNumber: fromNumber,
        isBusinessHours: businessHours,
        queueWaitTime: 0,
        baseUrl,
    };
    const execution = await createExecution({ callSid, companyId: group.company_id, group, flow, context });
    return renderNodeById(callSid, execution.current_node_id, traceId);
}

function eventFromDialStatus(dialStatus) {
    const status = String(dialStatus || '').toLowerCase();
    if (status === 'completed' || status === 'answered') return 'queue.connected';
    if (status === 'no-answer') return 'queue.timeout';
    if (status === 'busy' || status === 'failed' || status === 'canceled') return 'queue.failed';
    return 'queue.not_answered';
}

async function advance(callSid, event, traceId = 'call-flow') {
    const execution = await getExecution(callSid);
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
            call_sid: callSid,
            group_id: context.groupId,
            from_number: context.callerNumber,
            to_number: context.calledNumber,
        });
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
    const twiml = await renderNodeById(callSid, nextId, traceId);
    if (isVoicemailCompletion) await completeVoicemailCall(execution, context);
    return twiml;
}

module.exports = {
    startExecution,
    advance,
    getExecution,
    eventFromDialStatus,
    buildVoicemailTwiml,
    buildHangupTwiml,
};
