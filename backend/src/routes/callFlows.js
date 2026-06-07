/**
 * Call Flows API
 *
 * GET  /api/call-flows          — List all call flows
 * GET  /api/call-flows/:id      — Get flow with graph
 * PUT  /api/call-flows/:id      — Save the group's active graph immediately
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');

function safeParseJSON(str) {
    try { return JSON.parse(str || '{}'); } catch { return {}; }
}

function getCompanyId(req) {
    return req.companyFilter?.company_id;
}

function createSkeletonJSON(groupName) {
    return JSON.stringify({
        states: [
            { id: 'sk-start', name: 'Start', kind: 'start', isInitial: true, protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false, hidden: true },
            { id: 'sk-hours-check', name: 'Hours Check', kind: 'branch', protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false },
            { id: 'sk-current-group', name: groupName, kind: 'queue', protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false, labelExpr: 'currentGroupName', groupRef: 'group.current', config: { queue_name: 'group_agents', timeout_sec: 120 } },
            { id: 'sk-vm-business-hours', name: 'Voicemail', kind: 'voicemail', protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false, uiTerminal: true, config: { greeting: 'missed_call', branchKey: 'business_hours' } },
            { id: 'sk-vm-after-hours', name: 'Voicemail', kind: 'voicemail', protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false, uiTerminal: true, config: { greeting: 'after_hours', branchKey: 'after_hours' } },
            { id: 'sk-done-routed', name: 'Done', kind: 'final', protected: true, system: true, hidden: true },
            { id: 'sk-done-voicemail-business-hours', name: 'Done', kind: 'final', protected: true, system: true, hidden: true },
            { id: 'sk-done-voicemail-after-hours', name: 'Done', kind: 'final', protected: true, system: true, hidden: true },
        ],
        transitions: [
            { id: 'skt-entry', from_state_id: 'sk-start', to_state_id: 'sk-hours-check', system: true, immutable: true, deletable: false, hidden: true, edgeRole: 'entry', transitionMode: 'eventless' },
            { id: 'skt-bh', from_state_id: 'sk-hours-check', to_state_id: 'sk-current-group', label: 'Business Hours', system: true, immutable: true, deletable: false, edgeLabel: 'Business Hours', branchKey: 'business_hours', insertable: true, insertMode: 'between', transitionMode: 'conditional', condExpr: 'isBusinessHours === true' },
            { id: 'skt-ah', from_state_id: 'sk-hours-check', to_state_id: 'sk-vm-after-hours', label: 'After Hours', system: true, immutable: true, deletable: false, edgeLabel: 'After Hours', branchKey: 'after_hours', insertable: true, insertMode: 'between', transitionMode: 'conditional', condExpr: 'isBusinessHours === false' },
            { id: 'skt-fallback', from_state_id: 'sk-current-group', to_state_id: 'sk-vm-business-hours', label: 'Not answered / timeout', system: true, immutable: true, deletable: false, edgeLabel: 'Not answered / timeout', edgeRole: 'fallback', insertable: true, insertMode: 'between', transitionMode: 'event', event_key: 'queue.timeout queue.not_answered queue.failed' },
            { id: 'skt-success', from_state_id: 'sk-current-group', to_state_id: 'sk-done-routed', system: true, immutable: true, hidden: true, edgeRole: 'success', transitionMode: 'event', event_key: 'queue.connected call.handoff' },
            { id: 'skt-vm-bh-done', from_state_id: 'sk-vm-business-hours', to_state_id: 'sk-done-voicemail-business-hours', system: true, immutable: true, hidden: true, edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
            { id: 'skt-vm-ah-done', from_state_id: 'sk-vm-after-hours', to_state_id: 'sk-done-voicemail-after-hours', system: true, immutable: true, hidden: true, edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
        ],
    });
}

function hasRenderableGraph(graph) {
    return Array.isArray(graph?.states) && graph.states.length > 0;
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const result = await db.query(`
            SELECT cf.id, cf.name, cf.description, 'active' AS status, cf.group_id,
                   cf.created_at, cf.updated_at,
                   ug.name AS group_name
            FROM call_flows cf
            LEFT JOIN user_groups ug ON ug.id = cf.group_id
            WHERE cf.company_id = $1
            ORDER BY cf.updated_at DESC
        `, [companyId]);

        const flows = result.rows.map(r => ({
            id: r.id,
            name: r.name,
            description: r.description || '',
            status: 'active',
            group_id: r.group_id,
            group_name: r.group_name || null,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }));

        res.json({ ok: true, data: flows });
    } catch (err) {
        console.error('[CallFlows] GET list error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch call flows' });
    }
});

// ─── DETAIL ───────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await db.query(
            `SELECT cf.*, ug.name AS group_name
             FROM call_flows cf
             LEFT JOIN user_groups ug ON ug.id = cf.group_id AND ug.company_id = cf.company_id
             WHERE cf.id = $1 AND cf.company_id = $2`,
            [id, companyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Flow not found' });
        }

        let r = result.rows[0];
        let graph = safeParseJSON(r.graph_json);
        if (!hasRenderableGraph(graph)) {
            const groupName = r.group_name || r.name.replace(/\s+Flow$/, '') || 'Current Group';
            const updated = await db.query(
                `UPDATE call_flows
                 SET graph_json = $1, status = 'active'
                 WHERE id = $2 AND company_id = $3
                 RETURNING *`,
                [createSkeletonJSON(groupName), id, companyId]
            );
            r = { ...r, ...updated.rows[0] };
            graph = safeParseJSON(r.graph_json);
        }
        res.json({
            ok: true,
            data: {
                id: r.id,
                name: r.name,
                description: r.description || '',
                status: 'active',
                group_id: r.group_id,
                created_at: r.created_at,
                updated_at: r.updated_at,
                graph,
                validation: validateGraph(graph),
            },
        });
    } catch (err) {
        console.error('[CallFlows] GET detail error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch call flow' });
    }
});

// ─── GRAPH VALIDATION ─────────────────────────────────────────────────────────

const ENABLED_KINDS = new Set(['start', 'greeting', 'queue', 'branch', 'transfer', 'voicemail', 'hangup', 'play_audio', 'vapi_agent', 'final']);
const TERMINAL_KINDS = new Set(['voicemail', 'hangup']);

function validateGraph(graph) {
    const errors = [];
    const warnings = [];
    const states = graph?.states || [];
    const transitions = graph?.transitions || [];

    if (states.length === 0) {
        errors.push({ message: 'Flow has no states' });
        return { valid: false, errors, warnings };
    }

    const stateIds = new Set(states.map(s => s.id));

    // Check for unknown node kinds
    for (const s of states) {
        if (!ENABLED_KINDS.has(s.kind)) {
            errors.push({ message: `Unknown node kind "${s.kind}" on node "${s.name}"` });
        }
    }

    // Check for dangling transitions
    for (const t of transitions) {
        if (!stateIds.has(t.from_state_id)) errors.push({ message: `Transition "${t.id}" references missing source "${t.from_state_id}"` });
        if (!stateIds.has(t.to_state_id)) errors.push({ message: `Transition "${t.id}" references missing target "${t.to_state_id}"` });
    }

    // Per-node validation
    for (const s of states) {
        if (s.hidden || s.kind === 'start' || s.kind === 'final') continue;
        const cfg = s.config || {};
        const outgoing = transitions.filter(t => t.from_state_id === s.id && !t.hidden);

        switch (s.kind) {
            case 'greeting':
                if (!cfg.text && !s.system) warnings.push({ message: `Greeting "${s.name}": text is empty` });
                if (outgoing.length === 0 && !s.system) errors.push({ message: `Greeting "${s.name}": must have one outgoing edge` });
                break;

            case 'queue':
                if (cfg.target_mode === 'user_group' && !cfg.user_group_id) {
                    errors.push({ message: `Queue "${s.name}": user_group_id required when target_mode=user_group` });
                }
                if (cfg.on_timeout === 'edge' && outgoing.filter(t => t.edgeRole === 'fallback').length === 0 && !s.system) {
                    warnings.push({ message: `Queue "${s.name}": timeout path edge recommended when on_timeout=edge` });
                }
                break;

            case 'branch': {
                const conditions = cfg.conditions || [];
                if (conditions.length < 2 && !s.system) warnings.push({ message: `Branch "${s.name}": should have at least 2 conditions` });
                if (conditions.length > 10) errors.push({ message: `Branch "${s.name}": max 10 conditions` });
                const elseCount = conditions.filter(c => c.kind === 'else').length;
                if (elseCount !== 1 && conditions.length > 0) warnings.push({ message: `Branch "${s.name}": should have exactly one "else" condition` });
                if (elseCount === 1) {
                    const last = conditions[conditions.length - 1];
                    if (last.kind !== 'else') warnings.push({ message: `Branch "${s.name}": "else" condition should be last` });
                }
                break;
            }

            case 'transfer':
                if (cfg.target_type === 'external_number' && cfg.target_external_number) {
                    if (!/^\+\d{7,15}$/.test(cfg.target_external_number)) {
                        errors.push({ message: `Transfer "${s.name}": external number must be valid E.164` });
                    }
                }
                if (cfg.caller_id_policy === 'explicit_number' && !cfg.explicit_caller_id_number) {
                    errors.push({ message: `Transfer "${s.name}": explicit caller ID number required` });
                }
                if (cfg.on_fail === 'edge' && outgoing.filter(t => t.edgeRole === 'fallback').length === 0 && !s.system) {
                    warnings.push({ message: `Transfer "${s.name}": fail path edge recommended when on_fail=edge` });
                }
                break;

            case 'voicemail':
                if (cfg.greeting_mode === 'tts' && !cfg.greeting_text) {
                    errors.push({ message: `Voicemail "${s.name}": greeting text required when mode=tts` });
                }
                if (cfg.greeting_mode === 'audio_asset' && !cfg.greeting_audio_asset_id) {
                    errors.push({ message: `Voicemail "${s.name}": audio asset required when mode=audio_asset` });
                }
                if (outgoing.length > 0 && !s.system) {
                    warnings.push({ message: `Voicemail "${s.name}": terminal node should not have visible outgoing edges` });
                }
                break;

            case 'hangup':
                if (cfg.optional_message_mode === 'tts' && !cfg.optional_message_text) {
                    errors.push({ message: `Hang Up "${s.name}": message text required when mode=tts` });
                }
                if (cfg.optional_message_mode === 'audio_asset' && !cfg.optional_message_audio_asset_id) {
                    errors.push({ message: `Hang Up "${s.name}": audio asset required when mode=audio_asset` });
                }
                if (outgoing.length > 0) {
                    warnings.push({ message: `Hang Up "${s.name}": terminal node should not have visible outgoing edges` });
                }
                break;

            case 'play_audio':
                if (!cfg.audio_asset_id && !s.system) {
                    warnings.push({ message: `Play Audio "${s.name}": audio asset not selected` });
                }
                if (outgoing.length === 0 && !s.system) {
                    errors.push({ message: `Play Audio "${s.name}": must have one outgoing edge` });
                }
                break;
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

function branchKeyFromEdge(edge) {
    const explicit = edge.branchKey || edge.edgeRole;
    if (explicit) return String(explicit);
    const text = `${edge.label || ''} ${edge.edgeLabel || ''}`.toLowerCase();
    if (text.includes('after') || text.includes('closed')) return 'after_hours';
    if (text.includes('business') || text.includes('open')) return 'business_hours';
    return null;
}

function normalizeGraphForRuntime(graph) {
    if (!graph || !Array.isArray(graph.states) || !Array.isArray(graph.transitions)) return graph;
    const nodeById = new Map(graph.states.map(node => [node.id, node]));
    return {
        ...graph,
        transitions: graph.transitions.map(edge => {
            const from = nodeById.get(edge.from_state_id);
            if (from?.kind !== 'branch') return edge;
            const branchKey = branchKeyFromEdge(edge);
            if (branchKey === 'business_hours') {
                return {
                    ...edge,
                    branchKey,
                    transitionMode: edge.transitionMode || 'conditional',
                    condExpr: edge.condExpr || 'isBusinessHours === true',
                };
            }
            if (branchKey === 'after_hours') {
                return {
                    ...edge,
                    branchKey,
                    transitionMode: edge.transitionMode || 'conditional',
                    condExpr: edge.condExpr || 'isBusinessHours === false',
                };
            }
            return edge;
        }),
    };
}

// ─── SAVE GRAPH ───────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { graph, name, description } = req.body;

        const sets = [];
        const vals = [];
        let idx = 1;

        const normalizedGraph = graph !== undefined ? normalizeGraphForRuntime(graph) : undefined;
        if (normalizedGraph !== undefined) { sets.push(`graph_json = $${idx++}`); vals.push(JSON.stringify(normalizedGraph)); }
        if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
        if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }
        sets.push(`status = 'active'`);

        if (sets.length === 0) {
            return res.status(400).json({ ok: false, error: 'Nothing to update' });
        }

        vals.push(id, companyId);
        const result = await db.query(
            `UPDATE call_flows SET ${sets.join(', ')} WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
            vals
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Flow not found' });
        }

        // Validate graph and return result
        const validation = normalizedGraph ? validateGraph(normalizedGraph) : { valid: true, errors: [], warnings: [] };
        console.log('[CallFlows] Saved:', { id, fieldsUpdated: sets.length, valid: validation.valid, errors: validation.errors.length, warnings: validation.warnings.length });
        res.json({ ok: true, validation });
    } catch (err) {
        console.error('[CallFlows] PUT error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to save call flow' });
    }
});

module.exports = router;
