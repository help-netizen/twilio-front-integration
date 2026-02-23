/**
 * Jobs List Fields Settings Routes
 *
 * /api/settings/jobs-list-fields — company-level column configuration
 */

const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// ─── Whitelist of allowed field keys ─────────────────────────────────────────
const ALLOWED_FIELDS = new Set([
    'job_number', 'customer_name', 'customer_phone', 'customer_email',
    'service_name', 'blanc_status', 'zb_status', 'tags', 'assigned_techs',
    'start_date', 'address', 'territory', 'invoice_total', 'invoice_status',
    'job_source', 'created_at',
]);

const DEFAULT_FIELDS = [
    'job_number', 'customer_name', 'service_name', 'blanc_status',
    'tags', 'assigned_techs', 'start_date',
];

const SETTING_KEY = 'jobs_list_fields';

// ─── GET /api/settings/jobs-list-fields ──────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const companyId = req.companyId;
        if (!companyId) {
            return res.json({ ok: true, ordered_visible_fields: DEFAULT_FIELDS });
        }

        const { rows } = await db.query(
            'SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = $2',
            [companyId, SETTING_KEY]
        );

        if (rows.length === 0) {
            return res.json({ ok: true, ordered_visible_fields: DEFAULT_FIELDS });
        }

        const value = rows[0].setting_value;
        res.json({
            ok: true,
            ordered_visible_fields: value.ordered_visible_fields || DEFAULT_FIELDS,
        });
    } catch (err) {
        console.error('[JobsListFields] GET error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PUT /api/settings/jobs-list-fields ──────────────────────────────────────
router.put('/', async (req, res) => {
    try {
        const { ordered_visible_fields } = req.body;

        if (!Array.isArray(ordered_visible_fields) || ordered_visible_fields.length === 0) {
            return res.status(400).json({ ok: false, error: 'ordered_visible_fields must be a non-empty array' });
        }

        // Validate all fields are allowed
        const invalid = ordered_visible_fields.filter(f => !ALLOWED_FIELDS.has(f));
        if (invalid.length > 0) {
            return res.status(400).json({
                ok: false,
                error: `Unknown fields: ${invalid.join(', ')}`,
                allowed: [...ALLOWED_FIELDS],
            });
        }

        // Deduplicate while preserving order
        const seen = new Set();
        const deduped = ordered_visible_fields.filter(f => {
            if (seen.has(f)) return false;
            seen.add(f);
            return true;
        });

        const companyId = req.companyId;
        if (!companyId) {
            return res.status(400).json({ ok: false, error: 'No company context' });
        }

        await db.query(
            `INSERT INTO company_settings (company_id, setting_key, setting_value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (company_id, setting_key)
             DO UPDATE SET setting_value = $3, updated_at = NOW()`,
            [companyId, SETTING_KEY, JSON.stringify({ ordered_visible_fields: deduped })]
        );

        res.json({ ok: true, ordered_visible_fields: deduped });
    } catch (err) {
        console.error('[JobsListFields] PUT error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
