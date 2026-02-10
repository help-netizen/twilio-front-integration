const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// ─── GET /api/settings/lead-form ────────────────────────────────────────────
router.get('/', async (_req, res) => {
    try {
        const [jobTypesResult, fieldsResult] = await Promise.all([
            db.query('SELECT id, name, sort_order FROM lead_job_types ORDER BY sort_order, id'),
            db.query('SELECT id, display_name, api_name, field_type, is_system, sort_order FROM lead_custom_fields ORDER BY sort_order, id'),
        ]);

        res.json({
            success: true,
            jobTypes: jobTypesResult.rows,
            customFields: fieldsResult.rows,
        });
    } catch (err) {
        console.error('[LeadFormSettings] GET error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load settings' });
    }
});

// ─── PUT /api/settings/lead-form ────────────────────────────────────────────
router.put('/', async (req, res) => {
    const { jobTypes, customFields } = req.body;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // ── Job Types: full replace ──
        if (Array.isArray(jobTypes)) {
            await client.query('DELETE FROM lead_job_types');
            for (let i = 0; i < jobTypes.length; i++) {
                const name = String(jobTypes[i]).trim();
                if (!name) continue;
                await client.query(
                    'INSERT INTO lead_job_types (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET sort_order = $2',
                    [name, i],
                );
            }
        }

        // ── Custom Fields: upsert + delete removed ──
        if (Array.isArray(customFields)) {
            const keepIds = [];

            for (let i = 0; i < customFields.length; i++) {
                const f = customFields[i];
                const displayName = String(f.display_name || '').trim();
                const apiName = String(f.api_name || '').trim();
                const fieldType = f.field_type || 'text';
                const isSystem = !!f.is_system;

                if (!displayName || !apiName) continue;

                if (f.id) {
                    // Update existing
                    if (isSystem) {
                        // System fields: only update sort_order
                        await client.query(
                            'UPDATE lead_custom_fields SET sort_order = $1 WHERE id = $2',
                            [i, f.id],
                        );
                    } else {
                        await client.query(
                            'UPDATE lead_custom_fields SET display_name = $1, api_name = $2, field_type = $3, sort_order = $4 WHERE id = $5',
                            [displayName, apiName, fieldType, i, f.id],
                        );
                    }
                    keepIds.push(f.id);
                } else {
                    // Insert new
                    const result = await client.query(
                        'INSERT INTO lead_custom_fields (display_name, api_name, field_type, is_system, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                        [displayName, apiName, fieldType, false, i],
                    );
                    keepIds.push(result.rows[0].id);
                }
            }

            // Delete removed custom fields (never delete system fields)
            if (keepIds.length > 0) {
                await client.query(
                    'DELETE FROM lead_custom_fields WHERE is_system = false AND id != ALL($1::bigint[])',
                    [keepIds],
                );
            } else {
                await client.query('DELETE FROM lead_custom_fields WHERE is_system = false');
            }
        }

        await client.query('COMMIT');

        // Return updated data
        const [jobTypesResult, fieldsResult] = await Promise.all([
            db.query('SELECT id, name, sort_order FROM lead_job_types ORDER BY sort_order, id'),
            db.query('SELECT id, display_name, api_name, field_type, is_system, sort_order FROM lead_custom_fields ORDER BY sort_order, id'),
        ]);

        res.json({
            success: true,
            jobTypes: jobTypesResult.rows,
            customFields: fieldsResult.rows,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[LeadFormSettings] PUT error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to save settings' });
    } finally {
        client.release();
    }
});

module.exports = router;
