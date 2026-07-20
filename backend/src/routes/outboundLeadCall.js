/**
 * outboundLeadCall.js — OUTBOUND-LEAD-CALL-001 settings API (§10).
 * Mounted at /api/outbound-lead-caller behind authenticate +
 * requirePermission('tenant.integrations.manage') + requireCompanyAccess
 * (identical chain to /api/mail-agent — N-4, no new permission entries).
 *
 * company_id ONLY via req.companyFilter?.company_id; every SQL leg filters
 * by it. v1 surface: enabled sources multi-select; ladder columns stay
 * DB-editable only (parts precedent).
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const outboundLeadCallSettingsService = require('../services/outboundLeadCallSettingsService');

const APP_KEY = 'outbound-lead-caller';

function companyId(req) {
    return req.companyFilter?.company_id;
}

async function getInstallState(cid) {
    const { rows } = await db.query(
        `SELECT mi.status
         FROM marketplace_installations mi
         JOIN marketplace_apps ma ON ma.id = mi.app_id
         WHERE mi.company_id = $1 AND ma.app_key = $2
           AND mi.status IN ('connected', 'provisioning_failed')
         ORDER BY mi.created_at DESC LIMIT 1`,
        [cid, APP_KEY]
    );
    return rows[0]?.status || null;
}

// ── GET /settings — settings + install state + observed sources + 30d rollup ─
router.get('/settings', async (req, res) => {
    try {
        const cid = companyId(req);
        const [settings, installStatus, sourcesRes, recentRes] = await Promise.all([
            outboundLeadCallSettingsService.get(cid),
            getInstallState(cid),
            db.query(
                `SELECT DISTINCT job_source FROM leads
                 WHERE company_id = $1 AND job_source IS NOT NULL AND btrim(job_source) <> ''
                 ORDER BY job_source
                 LIMIT 100`,
                [cid]
            ),
            db.query(
                `SELECT status, COUNT(*)::int AS count
                 FROM outbound_call_attempts
                 WHERE company_id = $1 AND scenario = 'lead_call'
                   AND created_at >= now() - interval '30 days'
                 GROUP BY status`,
                [cid]
            ),
        ]);
        res.json({
            ok: true,
            data: {
                settings,
                installed: installStatus === 'connected',
                install_status: installStatus,
                company_sources: sourcesRes.rows.map(r => r.job_source),
                recent: recentRes.rows,
            },
        });
    } catch (err) {
        console.error('[OutboundLeadCall] GET /settings failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load settings' } });
    }
});

// ── PUT /settings — sources + nullable inherit/custom calling window ────────
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
router.put('/settings', async (req, res) => {
    try {
        const cid = companyId(req);
        const body = req.body || {};
        const enabledSources = body.enabled_sources;

        if (!Array.isArray(enabledSources) || enabledSources.length > 50) {
            return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION', message: 'enabled_sources must be an array of at most 50 items' },
            });
        }
        for (const item of enabledSources) {
            if (typeof item !== 'string' || item.trim() === '' || item.trim().length > 80) {
                return res.status(400).json({
                    ok: false,
                    error: { code: 'VALIDATION', message: 'each source must be a non-empty string of at most 80 characters' },
                });
            }
        }

        // AGENT-CALL-WINDOW-001: null means inherit; custom carries a complete
        // day set + same-day HH:MM range. 'always' remains API-compatible for
        // existing saved lead settings but is not exposed by the new UI.
        const mode = body.calling_window_mode == null ? null : body.calling_window_mode;
        if (mode !== null && !outboundLeadCallSettingsService.CALLING_WINDOW_MODES.includes(mode)) {
            return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION', message: "calling_window_mode must be null, 'always', or 'custom'" },
            });
        }
        let customStart = null;
        let customEnd = null;
        let workDays = null;
        if (mode === 'custom') {
            customStart = body.custom_start_time;
            customEnd = body.custom_end_time;
            if (!HHMM_RE.test(String(customStart)) || !HHMM_RE.test(String(customEnd))) {
                return res.status(400).json({
                    ok: false,
                    error: { code: 'VALIDATION', message: 'custom hours must be HH:MM (24-hour), e.g. 09:00 and 20:00' },
                });
            }
            if (!(customStart < customEnd)) {
                return res.status(400).json({
                    ok: false,
                    error: { code: 'VALIDATION', message: 'custom start time must be earlier than end time' },
                });
            }
            if (!Array.isArray(body.calling_window_work_days)
                || body.calling_window_work_days.length === 0
                || body.calling_window_work_days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
                return res.status(400).json({
                    ok: false,
                    error: { code: 'VALIDATION', message: 'calling_window_work_days must contain at least one weekday number from 0 to 6' },
                });
            }
            workDays = [...new Set(body.calling_window_work_days)].sort((a, b) => a - b);
        }

        // Normalized dedup: keep the FIRST display label per canonical key.
        const seen = new Set();
        const deduped = [];
        for (const item of enabledSources) {
            const key = outboundLeadCallSettingsService.normalizeSource(item);
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(item.trim());
        }

        const settings = await outboundLeadCallSettingsService.saveSettings(cid, {
            enabled_sources: deduped,
            calling_window_mode: mode,
            custom_start_time: customStart,
            custom_end_time: customEnd,
            calling_window_work_days: workDays,
        });
        res.json({ ok: true, data: { settings } });
    } catch (err) {
        console.error('[OutboundLeadCall] PUT /settings failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to save settings' } });
    }
});

module.exports = router;
