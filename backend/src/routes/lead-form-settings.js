const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// ─── GET /api/settings/lead-form ────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const companyWhere = companyId ? `WHERE company_id = $1` : '';
        const params = companyId ? [companyId] : [];
        const [jobTypesResult, fieldsResult] = await Promise.all([
            db.query(`SELECT id, name, sort_order FROM lead_job_types ${companyWhere} ORDER BY sort_order, id`, params),
            db.query(`SELECT id, display_name, api_name, field_type, is_system, is_searchable, sort_order FROM lead_custom_fields ${companyWhere} ORDER BY sort_order, id`, params),
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
    const companyId = req.companyFilter?.company_id;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // ── Job Types: full replace ──
        if (Array.isArray(jobTypes)) {
            if (companyId) {
                await client.query('DELETE FROM lead_job_types WHERE company_id = $1', [companyId]);
            } else {
                await client.query('DELETE FROM lead_job_types');
            }
            for (let i = 0; i < jobTypes.length; i++) {
                const name = String(jobTypes[i]).trim();
                if (!name) continue;
                if (companyId) {
                    await client.query(
                        'INSERT INTO lead_job_types (name, sort_order, company_id) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET sort_order = $2',
                        [name, i, companyId],
                    );
                } else {
                    await client.query(
                        'INSERT INTO lead_job_types (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET sort_order = $2',
                        [name, i],
                    );
                }
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
                            'UPDATE lead_custom_fields SET display_name = $1, api_name = $2, field_type = $3, sort_order = $4, is_searchable = $5 WHERE id = $6',
                            [displayName, apiName, fieldType, i, f.is_searchable !== false, f.id],
                        );
                    }
                    keepIds.push(f.id);
                } else {
                    // Insert new
                    const result = await client.query(
                        'INSERT INTO lead_custom_fields (display_name, api_name, field_type, is_system, sort_order, is_searchable) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                        [displayName, apiName, fieldType, false, i, f.is_searchable !== false],
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
        const companyWhere = companyId ? `WHERE company_id = $1` : '';
        const returnParams = companyId ? [companyId] : [];
        const [jobTypesResult, fieldsResult] = await Promise.all([
            db.query(`SELECT id, name, sort_order FROM lead_job_types ${companyWhere} ORDER BY sort_order, id`, returnParams),
            db.query(`SELECT id, display_name, api_name, field_type, is_system, is_searchable, sort_order FROM lead_custom_fields ${companyWhere} ORDER BY sort_order, id`, returnParams),
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
