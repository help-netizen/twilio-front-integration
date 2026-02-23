/**
 * Job Tags Settings Routes
 *
 * /api/settings/job-tags — CRUD for tag catalog
 */

const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// ─── GET all tags (active + inactive) ────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT id, name, color, sort_order, is_active, archived_at, created_at FROM job_tags ORDER BY sort_order, id'
        );
        res.json({ ok: true, data: rows });
    } catch (err) {
        console.error('[JobTags] GET error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST create tag ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        const { name, color } = req.body;
        if (!name?.trim()) return res.status(400).json({ ok: false, error: 'name required' });

        // Get next sort_order
        const { rows: maxRows } = await db.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM job_tags');
        const sortOrder = maxRows[0].next;

        const { rows } = await db.query(
            'INSERT INTO job_tags (name, color, sort_order) VALUES ($1, $2, $3) RETURNING *',
            [name.trim(), color || '#6B7280', sortOrder]
        );
        res.json({ ok: true, data: rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ ok: false, error: 'A tag with this name already exists' });
        }
        console.error('[JobTags] POST error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PATCH update tag ────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
    try {
        const { name, color, is_active } = req.body;
        const updates = [];
        const params = [];
        let idx = 0;

        if (name !== undefined) {
            idx++; updates.push(`name = $${idx}`); params.push(name.trim());
        }
        if (color !== undefined) {
            idx++; updates.push(`color = $${idx}`); params.push(color);
        }
        if (is_active !== undefined) {
            idx++; updates.push(`is_active = $${idx}`); params.push(is_active);
            if (!is_active) {
                updates.push('archived_at = NOW()');
            } else {
                updates.push('archived_at = NULL');
            }
        }

        if (updates.length === 0) return res.status(400).json({ ok: false, error: 'No fields to update' });

        updates.push('updated_at = NOW()');
        idx++; params.push(req.params.id);

        const { rows } = await db.query(
            `UPDATE job_tags SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            params
        );

        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Tag not found' });
        res.json({ ok: true, data: rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ ok: false, error: 'A tag with this name already exists' });
        }
        console.error('[JobTags] PATCH error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST reorder ────────────────────────────────────────────────────────────
router.post('/reorder', async (req, res) => {
    try {
        const { ordered_ids } = req.body;
        if (!Array.isArray(ordered_ids)) return res.status(400).json({ ok: false, error: 'ordered_ids required' });

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            for (let i = 0; i < ordered_ids.length; i++) {
                await client.query('UPDATE job_tags SET sort_order = $1, updated_at = NOW() WHERE id = $2', [i, ordered_ids[i]]);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        const { rows } = await db.query('SELECT * FROM job_tags ORDER BY sort_order, id');
        res.json({ ok: true, data: rows });
    } catch (err) {
        console.error('[JobTags] Reorder error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE (archive) ────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const { rows } = await db.query(
            'UPDATE job_tags SET is_active = false, archived_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Tag not found' });
        res.json({ ok: true, data: rows[0] });
    } catch (err) {
        console.error('[JobTags] DELETE error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
