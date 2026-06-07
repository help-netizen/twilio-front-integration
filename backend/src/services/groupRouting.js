/**
 * F017 Group Routing
 *
 * Resolves inbound DID -> user group -> current flow -> available group agents.
 */

const db = require('../db/connection');
const { getPresenceSnapshot } = require('./agentPresence');
const { getBusyClientIdentities, verifyAndFixStaleCalls } = require('./callAvailability');
const { buildSoftphoneIdentity } = require('./softphoneIdentity');

function safeParseJSON(value) {
    try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function createSkeletonJSON(groupName) {
    return JSON.stringify({
        states: [
            { id: 'sk-start', name: 'Start', kind: 'start', isInitial: true, system: true, hidden: true },
            { id: 'sk-hours-check', name: 'Hours Check', kind: 'branch', system: true },
            { id: 'sk-current-group', name: groupName, kind: 'queue', system: true, groupRef: 'group.current', config: { queue_name: 'group_agents', timeout_sec: 120 } },
            { id: 'sk-vm-business-hours', name: 'Voicemail', kind: 'voicemail', system: true, config: { greeting: 'missed_call', branchKey: 'business_hours' } },
            { id: 'sk-vm-after-hours', name: 'Voicemail', kind: 'voicemail', system: true, config: { greeting: 'after_hours', branchKey: 'after_hours' } },
            { id: 'sk-done-routed', name: 'Done', kind: 'final', system: true, hidden: true },
            { id: 'sk-done-voicemail-business-hours', name: 'Done', kind: 'final', system: true, hidden: true },
            { id: 'sk-done-voicemail-after-hours', name: 'Done', kind: 'final', system: true, hidden: true },
        ],
        transitions: [
            { id: 'skt-entry', from_state_id: 'sk-start', to_state_id: 'sk-hours-check', edgeRole: 'entry', transitionMode: 'eventless' },
            { id: 'skt-bh', from_state_id: 'sk-hours-check', to_state_id: 'sk-current-group', label: 'Business Hours', branchKey: 'business_hours', transitionMode: 'conditional', condExpr: 'isBusinessHours === true' },
            { id: 'skt-ah', from_state_id: 'sk-hours-check', to_state_id: 'sk-vm-after-hours', label: 'After Hours', branchKey: 'after_hours', transitionMode: 'conditional', condExpr: 'isBusinessHours === false' },
            { id: 'skt-fallback', from_state_id: 'sk-current-group', to_state_id: 'sk-vm-business-hours', label: 'Not answered / timeout', edgeRole: 'fallback', transitionMode: 'event', event_key: 'queue.timeout queue.not_answered queue.failed' },
            { id: 'skt-success', from_state_id: 'sk-current-group', to_state_id: 'sk-done-routed', edgeRole: 'success', transitionMode: 'event', event_key: 'queue.connected call.handoff' },
            { id: 'skt-vm-bh-done', from_state_id: 'sk-vm-business-hours', to_state_id: 'sk-done-voicemail-business-hours', edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
            { id: 'skt-vm-ah-done', from_state_id: 'sk-vm-after-hours', to_state_id: 'sk-done-voicemail-after-hours', edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
        ],
    });
}

async function ensureFlowForGroup(group, companyId) {
    const existing = await db.query(
        `SELECT id, company_id, group_id, name, status, graph_json, updated_at
         FROM call_flows
         WHERE group_id = $1 AND company_id = $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [group.id, companyId]
    );

    const flow = existing.rows[0];
    if (flow) {
        const graph = safeParseJSON(flow.graph_json);
        if (Array.isArray(graph.states) && graph.states.length > 0) {
            if (flow.status !== 'active') {
                const updated = await db.query(
                    `UPDATE call_flows
                     SET status = 'active'
                     WHERE id = $1 AND company_id = $2
                     RETURNING id, company_id, group_id, name, status, graph_json, updated_at`,
                    [flow.id, companyId]
                );
                const row = updated.rows[0];
                return { ...row, graph: safeParseJSON(row.graph_json) };
            }
            return { ...flow, status: 'active', graph };
        }

        const updated = await db.query(
            `UPDATE call_flows
             SET graph_json = $1, status = 'active'
             WHERE id = $2 AND company_id = $3
             RETURNING id, company_id, group_id, name, status, graph_json, updated_at`,
            [createSkeletonJSON(group.name), flow.id, companyId]
        );
        const row = updated.rows[0];
        return { ...row, graph: safeParseJSON(row.graph_json) };
    }

    const id = `cf-${cryptoRandom()}`;
    const inserted = await db.query(
        `INSERT INTO call_flows (id, company_id, group_id, name, status, graph_json)
         VALUES ($1, $2, $3, $4, 'active', $5)
         RETURNING id, company_id, group_id, name, status, graph_json, updated_at`,
        [id, companyId, group.id, `${group.name} Flow`, createSkeletonJSON(group.name)]
    );
    const row = inserted.rows[0];
    return { ...row, graph: safeParseJSON(row.graph_json) };
}

function cryptoRandom() {
    return require('crypto').randomUUID().slice(0, 8);
}

async function resolveGroupForNumber(toNumber) {
    const result = await db.query(
        `SELECT
             pns.id AS phone_setting_id,
             pns.phone_number,
             pns.company_id,
             pns.group_id,
             ug.name AS group_name,
             ug.description,
             ug.strategy,
             COALESCE(c.timezone, 'America/New_York') AS company_timezone
         FROM phone_number_settings pns
         LEFT JOIN user_groups ug
           ON ug.id = pns.group_id
          AND ug.company_id = pns.company_id::text
         LEFT JOIN companies c ON c.id = pns.company_id
         WHERE pns.phone_number = $1
         LIMIT 1`,
        [toNumber]
    );

    const row = result.rows[0];
    if (!row || !row.group_id) return null;

    const group = {
        id: row.group_id,
        company_id: row.company_id,
        name: row.group_name,
        description: row.description || '',
        strategy: 'Simultaneous',
        timezone: row.company_timezone || 'America/New_York',
        phone_number: row.phone_number,
    };
    const flow = await ensureFlowForGroup(group, row.company_id);
    return { group, flow, phoneSettingId: row.phone_setting_id };
}

async function getGroupHours(groupId) {
    const result = await db.query(
        `SELECT day_of_week, is_open, open_time, close_time
         FROM user_group_hours
         WHERE group_id = $1`,
        [groupId]
    );
    return result.rows;
}

async function isBusinessHours(group, now = new Date()) {
    const hours = await getGroupHours(group.id);
    if (hours.length === 0) return true;

    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: group.timezone || 'America/New_York',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
    const day = parts.weekday;
    const localTime = `${parts.hour}:${parts.minute}`;
    const row = hours.find(h => h.day_of_week === day);
    if (!row || !row.is_open || !row.open_time || !row.close_time) return false;
    return localTime >= row.open_time && localTime < row.close_time;
}

async function availableAgentsForGroup(groupId, companyId, traceId = 'group-routing') {
    const members = await db.query(
        `SELECT
             ugm.user_id,
             COALESCE(cu.full_name, cu.email, ugm.user_id) AS name,
             COALESCE(cupp.phone_calls_allowed, false) AS phone_calls_allowed
         FROM user_group_members ugm
         JOIN user_groups ug ON ug.id = ugm.group_id
         LEFT JOIN crm_users cu ON cu.id::text = ugm.user_id
         LEFT JOIN company_memberships cm
           ON cm.user_id::text = ugm.user_id
          AND cm.company_id::text = ug.company_id
         LEFT JOIN company_user_profiles cupp ON cupp.membership_id = cm.id
         WHERE ugm.group_id = $1
           AND ug.company_id = $2
           AND COALESCE(ugm.is_active, true) = true
         ORDER BY ugm.priority, ugm.created_at`,
        [groupId, companyId]
    );

    const candidateIds = members.rows
        .filter(row => row.phone_calls_allowed === true)
        .map(row => String(row.user_id));
    if (candidateIds.length === 0) return [];

    const presence = await getPresenceSnapshot(candidateIds, companyId);
    let busyIdentities = new Set();
    let callSids = [];
    try {
        const busy = await getBusyClientIdentities(traceId);
        busyIdentities = busy.busyIdentities;
        callSids = busy.callSids;
    } catch (err) {
        console.warn(`[${traceId}] Failed to load busy client identities:`, err.message);
    }

    let agents = members.rows
        .filter(row => candidateIds.includes(String(row.user_id)))
        .filter(row => {
            const userId = String(row.user_id);
            const status = presence.get(userId);
            const identity = buildSoftphoneIdentity(companyId, userId);
            if (busyIdentities.has(identity)) return false;
            return status === 'available';
        })
        .map(row => ({
            user_id: String(row.user_id),
            identity: buildSoftphoneIdentity(companyId, row.user_id),
            name: row.name,
        }));

    if (agents.length === 0 && callSids.length > 0) {
        await verifyAndFixStaleCalls(callSids, traceId);
        const fresh = await getBusyClientIdentities(traceId);
        agents = members.rows
            .filter(row => candidateIds.includes(String(row.user_id)))
            .filter(row => {
                const userId = String(row.user_id);
                return presence.get(userId) === 'available' && !fresh.busyIdentities.has(buildSoftphoneIdentity(companyId, userId));
            })
            .map(row => ({
                user_id: String(row.user_id),
                identity: buildSoftphoneIdentity(companyId, row.user_id),
                name: row.name,
            }));
    }

    return agents;
}

async function groupsForUser(userId, companyId, { includeAllForDev = false } = {}) {
    if (!companyId) return [];
    const params = [companyId];
    let whereMembership = '';
    if (!includeAllForDev) {
        params.push(String(userId));
        whereMembership = `AND ugm.user_id = $2`;
    }

    const result = await db.query(
        `SELECT DISTINCT ug.id, ug.name, ug.description, ug.strategy, ug.created_at, ug.updated_at
         FROM user_groups ug
         ${includeAllForDev ? '' : 'JOIN user_group_members ugm ON ugm.group_id = ug.id'}
         WHERE ug.company_id = $1
           ${whereMembership}
         ORDER BY ug.name`,
        params
    );
    return result.rows;
}

module.exports = {
    resolveGroupForNumber,
    availableAgentsForGroup,
    ensureFlowForGroup,
    isBusinessHours,
    groupsForUser,
    safeParseJSON,
};
