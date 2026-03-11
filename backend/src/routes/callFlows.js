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
                validation: { valid: true, errors: [], warnings: [] },
            },
        });
    } catch (err) {
        console.error('[CallFlows] GET detail error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch call flow' });
    }
});

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

        console.log('[CallFlows] Saved:', { id, fieldsUpdated: sets.length });
        res.json({ ok: true });
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
            `UPDATE call_flows SET status = 'published' WHERE id = $1 AND company_id = $2 RETURNING *`,
            [id, companyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Flow not found' });
        }

        console.log('[CallFlows] Published:', id);
        res.json({ ok: true, data: { id, status: 'published' } });
    } catch (err) {
        console.error('[CallFlows] Publish error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to publish flow' });
    }
});

module.exports = router;
