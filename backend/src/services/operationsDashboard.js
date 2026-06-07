const db = require('../db/connection');
const agentPresence = require('./agentPresence');

function secondsSince(value) {
    const ts = value ? new Date(value).getTime() : Date.now();
    if (!Number.isFinite(ts)) return 0;
    return Math.max(0, Math.floor((Date.now() - ts) / 1000));
}

function safeParseJSON(value) {
    try {
        if (!value) return {};
        return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return {};
    }
}

function nodeLabel(node) {
    if (!node) return null;
    return node.name || node.label || node.kind || node.id || null;
}

function flowPathFromContext(context, currentNodeId, fallbackStatus) {
    const graph = context?.graph || {};
    const states = Array.isArray(graph.states) ? graph.states : [];
    const transitions = Array.isArray(graph.transitions) ? graph.transitions : [];
    if (states.length === 0) return fallbackStatus ? [fallbackStatus] : [];

    const start = states.find(s => s.isInitial) || states.find(s => s.kind === 'start') || states[0];
    const targetId = currentNodeId || start?.id;
    if (!start?.id || !targetId) return states.map(nodeLabel).filter(Boolean);

    const queue = [start.id];
    const seen = new Set([start.id]);
    const parent = new Map();
    while (queue.length > 0) {
        const id = queue.shift();
        if (id === targetId) break;
        for (const edge of transitions.filter(t => t.from_state_id === id)) {
            const next = edge.to_state_id;
            if (!next || seen.has(next)) continue;
            seen.add(next);
            parent.set(next, id);
            queue.push(next);
        }
    }

    if (!seen.has(targetId)) {
        const current = states.find(s => s.id === targetId);
        return [nodeLabel(start), nodeLabel(current)].filter(Boolean);
    }

    const ids = [];
    for (let id = targetId; id; id = parent.get(id)) {
        ids.unshift(id);
        if (id === start.id) break;
    }
    const byId = new Map(states.map(s => [s.id, s]));
    return ids.map(id => nodeLabel(byId.get(id))).filter(Boolean);
}

function currentNodeKind(context, currentNodeId) {
    const states = Array.isArray(context?.graph?.states) ? context.graph.states : [];
    return states.find(s => s.id === currentNodeId)?.kind || null;
}

function makeCall(row) {
    const context = safeParseJSON(row.context_json);
    const waitSeconds = secondsSince(row.started_at || row.execution_created_at);
    const isConnected = Boolean(row.answered_at) || ['in-progress', 'answered'].includes(String(row.status || '').toLowerCase());
    const kind = currentNodeKind(context, row.current_node_id);
    return {
        call_sid: row.call_sid,
        caller: row.from_number || context.callerNumber || '',
        caller_name: row.contact_name || null,
        called_number: row.to_number || context.calledNumber || '',
        status: row.status || row.execution_status || 'active',
        agent_user_id: row.answered_by || null,
        wait_seconds: waitSeconds,
        duration_sec: isConnected ? waitSeconds : 0,
        current_node_id: row.current_node_id,
        current_node_kind: kind,
        flow_path: flowPathFromContext(context, row.current_node_id, row.status || row.execution_status),
    };
}

async function listGroupMembers(companyId) {
    const result = await db.query(
        `SELECT
             ug.id AS group_id,
             ug.name AS group_name,
             ugm.user_id,
             COALESCE(cu.full_name, cu.email, ugm.user_id) AS user_name,
             COALESCE(cupp.phone_calls_allowed, false) AS phone_calls_allowed
         FROM user_groups ug
         LEFT JOIN user_group_members ugm
           ON ugm.group_id = ug.id
          AND COALESCE(ugm.is_active, true) = true
         LEFT JOIN crm_users cu ON cu.id::text = ugm.user_id
         LEFT JOIN company_memberships cm
           ON cm.user_id::text = ugm.user_id
          AND cm.company_id::text = ug.company_id
         LEFT JOIN company_user_profiles cupp ON cupp.membership_id = cm.id
         WHERE ug.company_id = $1
         ORDER BY ug.name, ugm.priority NULLS LAST, ugm.created_at NULLS LAST`,
        [companyId]
    );
    return result.rows;
}

async function listActiveFlowCalls(companyId) {
    const result = await db.query(
        `SELECT
             cfe.call_sid,
             cfe.group_id,
             cfe.current_node_id,
             cfe.context_json,
             cfe.status AS execution_status,
             cfe.created_at AS execution_created_at,
             ug.name AS group_name,
             c.from_number,
             c.to_number,
             c.status,
             c.is_final,
             c.started_at,
             c.answered_at,
             c.duration_sec,
             c.answered_by,
             COALESCE(co.full_name, '') AS contact_name
         FROM call_flow_executions cfe
         JOIN user_groups ug
           ON ug.id = cfe.group_id
          AND ug.company_id = cfe.company_id::text
         LEFT JOIN calls c
           ON c.call_sid = cfe.call_sid
          AND c.company_id::text = cfe.company_id::text
         LEFT JOIN contacts co ON co.id = c.contact_id
         WHERE cfe.company_id = $1
           AND cfe.created_at >= now() - INTERVAL '24 hours'
           AND (cfe.status = 'active' OR COALESCE(c.is_final, false) = false)
         ORDER BY cfe.created_at DESC`,
        [companyId]
    );
    return result.rows;
}

async function getOperationsDashboard(companyId) {
    const [memberRows, callRows] = await Promise.all([
        listGroupMembers(companyId),
        listActiveFlowCalls(companyId),
    ]);
    const memberUserIds = [...new Set(memberRows.map(row => row.user_id).filter(Boolean).map(String))];
    const presence = await agentPresence.getPresenceSnapshot(memberUserIds, companyId);

    const groups = new Map();
    for (const row of memberRows) {
        if (!groups.has(row.group_id)) {
            groups.set(row.group_id, {
                id: row.group_id,
                name: row.group_name,
                reachable: false,
                agents: [],
                active_calls: [],
                queued_calls: [],
                waiting_count: 0,
                longest_wait_seconds: 0,
            });
        }
        if (!row.user_id) continue;
        const status = presence.get(String(row.user_id)) || 'offline';
        const agent = {
            id: String(row.user_id),
            name: row.user_name,
            status,
            phone_calls_allowed: row.phone_calls_allowed === true,
            device_ready: status !== 'offline',
        };
        groups.get(row.group_id).agents.push(agent);
    }

    for (const group of groups.values()) {
        group.reachable = group.agents.some(agent => agent.phone_calls_allowed && agent.status === 'available');
    }

    for (const row of callRows) {
        if (!groups.has(row.group_id)) {
            groups.set(row.group_id, {
                id: row.group_id,
                name: row.group_name || row.group_id,
                reachable: false,
                agents: [],
                active_calls: [],
                queued_calls: [],
                waiting_count: 0,
                longest_wait_seconds: 0,
            });
        }
        const call = makeCall(row);
        const group = groups.get(row.group_id);
        const connected = Boolean(row.answered_at) || ['in-progress', 'answered'].includes(String(row.status || '').toLowerCase());
        if (connected) {
            group.active_calls.push(call);
        } else {
            group.queued_calls.push(call);
            group.waiting_count += 1;
            group.longest_wait_seconds = Math.max(group.longest_wait_seconds, call.wait_seconds);
        }
    }

    const groupList = [...groups.values()];
    const allAgents = groupList.flatMap(group => group.agents.map(agent => ({ ...agent, group_id: group.id, group_name: group.name })));
    const allQueued = groupList.flatMap(group => group.queued_calls.map(call => ({
        id: call.call_sid,
        call_sid: call.call_sid,
        caller: call.caller,
        caller_name: call.caller_name,
        queue_name: group.name,
        group_id: group.id,
        group_name: group.name,
        called_number: call.called_number,
        wait_seconds: call.wait_seconds,
        priority: 'normal',
    })));
    const activeCount = groupList.reduce((sum, group) => sum + group.active_calls.length, 0);
    const queuedCount = allQueued.length;
    const reachableCount = groupList.filter(group => group.reachable).length;

    return {
        groups: groupList,
        agents: allAgents,
        queue: allQueued,
        kpis: [
            { label: 'Active Now', value: activeCount, trend: activeCount > 0 ? 'up' : 'flat' },
            { label: 'In Queue', value: queuedCount, trend: queuedCount > 0 ? 'up' : 'flat' },
            { label: 'Reachable Groups', value: `${reachableCount}/${groupList.length}`, trend: reachableCount === groupList.length ? 'flat' : 'down' },
            { label: 'Longest Wait', value: `${Math.max(0, ...groupList.map(g => g.longest_wait_seconds))}s`, trend: queuedCount > 0 ? 'up' : 'flat' },
        ],
    };
}

module.exports = {
    getOperationsDashboard,
    flowPathFromContext,
};
