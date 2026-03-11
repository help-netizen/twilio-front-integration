/**
 * Call Flows API
 *
 * GET  /api/call-flows          — List all call flows
 * GET  /api/call-flows/:id      — Get flow with graph
 * PUT  /api/call-flows/:id      — Save graph (draft)
 * PUT  /api/call-flows/:id/publish — Publish flow
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');

function safeParseJSON(str) {
    try { return JSON.parse(str || '{}'); } catch { return {}; }
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const result = await db.query(`
            SELECT cf.id, cf.name, cf.description, cf.status, cf.group_id,
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
            status: r.status,
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
        const companyId = req.user?.company_id;
        const { id } = req.params;

        const result = await db.query(
            `SELECT * FROM call_flows WHERE id = $1 AND company_id = $2`,
            [id, companyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Flow not found' });
        }

        const r = result.rows[0];
        res.json({
            ok: true,
            data: {
                id: r.id,
                name: r.name,
                description: r.description || '',
                status: r.status,
                group_id: r.group_id,
                created_at: r.created_at,
                updated_at: r.updated_at,
                graph: safeParseJSON(r.graph_json),
                validation: validateGraph(safeParseJSON(r.graph_json)),
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

// ─── SAVE GRAPH ───────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        const { id } = req.params;
        const { graph, name, description } = req.body;

        const sets = [];
        const vals = [];
        let idx = 1;

        if (graph !== undefined) { sets.push(`graph_json = $${idx++}`); vals.push(JSON.stringify(graph)); }
        if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
        if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }

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
        const validation = graph ? validateGraph(graph) : { valid: true, errors: [], warnings: [] };
        console.log('[CallFlows] Saved:', { id, fieldsUpdated: sets.length, valid: validation.valid, errors: validation.errors.length, warnings: validation.warnings.length });
        res.json({ ok: true, validation });
    } catch (err) {
        console.error('[CallFlows] PUT error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to save call flow' });
    }
});

// ─── PUBLISH ──────────────────────────────────────────────────────────────────

router.put('/:id/publish', async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        const { id } = req.params;

        const result = await db.query(
            `SELECT * FROM call_flows WHERE id = $1 AND company_id = $2`,
            [id, companyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Flow not found' });
        }

        // Validate before publish — block on errors
        const graph = safeParseJSON(result.rows[0].graph_json);
        const validation = validateGraph(graph);
        if (!validation.valid) {
            return res.status(400).json({ ok: false, error: 'Flow has validation errors', validation });
        }

        await db.query(
            `UPDATE call_flows SET status = 'published' WHERE id = $1 AND company_id = $2`,
            [id, companyId]
        );

        console.log('[CallFlows] Published:', id);
        res.json({ ok: true, data: { id, status: 'published' }, validation });
    } catch (err) {
        console.error('[CallFlows] Publish error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to publish flow' });
    }
});

module.exports = router;
