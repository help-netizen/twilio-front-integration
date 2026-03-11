/**
 * User Groups API
 *
 * GET    /api/user-groups        — List all user groups (with members, numbers, hours, flow)
 * GET    /api/user-groups/:id    — Get single group detail
 * POST   /api/user-groups        — Create new group
 * PUT    /api/user-groups/:id    — Update group
 * DELETE /api/user-groups/:id    — Delete group
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const crypto = require('crypto');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genId(prefix = 'ug') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Build full group object from base row + related rows */
async function buildGroupPayload(group, companyId) {
    const [membersRes, numbersRes, hoursRes, flowRes] = await Promise.all([
        db.query(`
            SELECT ugm.user_id AS id, cu.name, 'available' AS status
            FROM user_group_members ugm
            LEFT JOIN crm_users cu ON cu.id = ugm.user_id
            WHERE ugm.group_id = $1
            ORDER BY ugm.priority, ugm.created_at
        `, [group.id]),
        db.query(`
            SELECT id::text, phone_number AS number, friendly_name
            FROM user_group_numbers
            WHERE group_id = $1
            ORDER BY created_at
        `, [group.id]),
        db.query(`
            SELECT day_of_week AS day,
                   CASE WHEN is_open THEN open_time ELSE 'Closed' END AS open,
                   CASE WHEN is_open THEN close_time ELSE '' END AS close
            FROM user_group_hours
            WHERE group_id = $1
            ORDER BY CASE day_of_week
                WHEN 'Mon' THEN 1 WHEN 'Tue' THEN 2 WHEN 'Wed' THEN 3
                WHEN 'Thu' THEN 4 WHEN 'Fri' THEN 5 WHEN 'Sat' THEN 6
                WHEN 'Sun' THEN 7 END
        `, [group.id]),
        db.query(`
            SELECT id, status, updated_at, graph_json
            FROM call_flows
            WHERE group_id = $1
            ORDER BY updated_at DESC LIMIT 1
        `, [group.id]),
    ]);

    const flow = flowRes.rows[0];
    return {
        id: group.id,
        name: group.name,
        desc: group.description || '',
        strategy: group.strategy,
        members: membersRes.rows,
        numbers: numbersRes.rows,
        schedule: {
            timezone: 'America/New_York',
            hours: hoursRes.rows.length > 0 ? hoursRes.rows : [],
        },
        flow: flow ? {
            id: flow.id,
            status: flow.status,
            updated_at: flow.updated_at,
            graph: safeParseJSON(flow.graph_json),
        } : null,
    };
}

function safeParseJSON(str) {
    try { return JSON.parse(str || '{}'); } catch { return {}; }
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const result = await db.query(
            `SELECT * FROM user_groups WHERE company_id = $1 ORDER BY created_at`,
            [companyId]
        );

        const groups = await Promise.all(
            result.rows.map(g => buildGroupPayload(g, companyId))
        );

        res.json({ ok: true, data: groups });
    } catch (err) {
        console.error('[UserGroups] GET list error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch user groups' });
    }
});

// ─── DETAIL ───────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        const { id } = req.params;

        const result = await db.query(
            `SELECT * FROM user_groups WHERE id = $1 AND company_id = $2`,
            [id, companyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Group not found' });
        }

        const group = await buildGroupPayload(result.rows[0], companyId);
        res.json({ ok: true, data: group });
    } catch (err) {
        console.error('[UserGroups] GET detail error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch group' });
    }
});

// ─── CREATE ───────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const { name, strategy = 'Round Robin', members = [], numbers = [], hours = [] } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ ok: false, error: 'Group name is required' });
        }

        await client.query('BEGIN');

        const groupId = genId('ug');
        await client.query(
            `INSERT INTO user_groups (id, company_id, name, strategy) VALUES ($1, $2, $3, $4)`,
            [groupId, companyId, name.trim(), strategy]
        );

        // Members
        for (const userId of members) {
            await client.query(
                `INSERT INTO user_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [groupId, userId]
            );
        }

        // Numbers
        for (const numObj of numbers) {
            const phone = typeof numObj === 'string' ? numObj : numObj.number;
            const fname = typeof numObj === 'string' ? '' : (numObj.friendly_name || '');
            await client.query(
                `INSERT INTO user_group_numbers (group_id, phone_number, friendly_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [groupId, phone, fname]
            );
        }

        // Hours
        for (const h of hours) {
            const isOpen = h.open !== 'Closed';
            await client.query(
                `INSERT INTO user_group_hours (group_id, day_of_week, is_open, open_time, close_time) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (group_id, day_of_week) DO UPDATE SET is_open = $3, open_time = $4, close_time = $5`,
                [groupId, h.day, isOpen, isOpen ? h.open : null, isOpen ? h.close : null]
            );
        }

        // Create default call flow for group
        const flowId = genId('cf');
        await client.query(
            `INSERT INTO call_flows (id, company_id, group_id, name, status, graph_json) VALUES ($1, $2, $3, $4, 'draft', '{}')`,
            [flowId, companyId, groupId, `${name.trim()} Flow`]
        );

        await client.query('COMMIT');

        // Return full payload
        const groupRow = (await db.query(`SELECT * FROM user_groups WHERE id = $1`, [groupId])).rows[0];
        const payload = await buildGroupPayload(groupRow, companyId);
        res.status(201).json({ ok: true, data: payload });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[UserGroups] POST error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to create group' });
    } finally {
        client.release();
    }
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const companyId = req.user?.company_id;
        const { id } = req.params;
        const { name, strategy, members, numbers, hours } = req.body;

        // Verify ownership
        const existing = await client.query(`SELECT id FROM user_groups WHERE id = $1 AND company_id = $2`, [id, companyId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Group not found' });
        }

        await client.query('BEGIN');

        // Update base
        if (name !== undefined || strategy !== undefined) {
            const sets = [];
            const vals = [];
            let idx = 1;
            if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name.trim()); }
            if (strategy !== undefined) { sets.push(`name = $${idx}`); vals.push(strategy); idx++; }
            // fix: use correct column
            const setClauses = [];
            const setVals = [];
            let si = 1;
            if (name !== undefined) { setClauses.push(`name = $${si++}`); setVals.push(name.trim()); }
            if (strategy !== undefined) { setClauses.push(`strategy = $${si++}`); setVals.push(strategy); }
            if (setClauses.length > 0) {
                setVals.push(id);
                await client.query(`UPDATE user_groups SET ${setClauses.join(', ')} WHERE id = $${si}`, setVals);
            }
        }

        // Replace members
        if (members !== undefined) {
            await client.query(`DELETE FROM user_group_members WHERE group_id = $1`, [id]);
            for (const userId of members) {
                await client.query(
                    `INSERT INTO user_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [id, userId]
                );
            }
        }

        // Replace numbers
        if (numbers !== undefined) {
            await client.query(`DELETE FROM user_group_numbers WHERE group_id = $1`, [id]);
            for (const numObj of numbers) {
                const phone = typeof numObj === 'string' ? numObj : numObj.number;
                const fname = typeof numObj === 'string' ? '' : (numObj.friendly_name || '');
                await client.query(
                    `INSERT INTO user_group_numbers (group_id, phone_number, friendly_name) VALUES ($1, $2, $3)`,
                    [id, phone, fname]
                );
            }
        }

        // Replace hours
        if (hours !== undefined) {
            await client.query(`DELETE FROM user_group_hours WHERE group_id = $1`, [id]);
            for (const h of hours) {
                const isOpen = h.open !== 'Closed';
                await client.query(
                    `INSERT INTO user_group_hours (group_id, day_of_week, is_open, open_time, close_time) VALUES ($1, $2, $3, $4, $5)`,
                    [id, h.day, isOpen, isOpen ? h.open : null, isOpen ? h.close : null]
                );
            }
        }

        await client.query('COMMIT');

        const groupRow = (await db.query(`SELECT * FROM user_groups WHERE id = $1`, [id])).rows[0];
        const payload = await buildGroupPayload(groupRow, companyId);
        res.json({ ok: true, data: payload });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[UserGroups] PUT error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to update group' });
    } finally {
        client.release();
    }
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        const { id } = req.params;

        const result = await db.query(
            `DELETE FROM user_groups WHERE id = $1 AND company_id = $2 RETURNING id`,
            [id, companyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Group not found' });
        }

        // Also delete associated flow
        await db.query(`DELETE FROM call_flows WHERE group_id = $1`, [id]);

        res.json({ ok: true });
    } catch (err) {
        console.error('[UserGroups] DELETE error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to delete group' });
    }
});

module.exports = router;
