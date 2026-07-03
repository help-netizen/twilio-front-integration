/**
 * MAIL-AGENT-001 — Mail Secretary settings + activity API.
 * Mounted at /api/mail-agent with authenticate + requirePermission('tenant.integrations.manage')
 * + requireCompanyAccess (same gate as the marketplace routes).
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const mailAgentQueries = require('../db/mailAgentQueries');
const mailAgentService = require('../services/mailAgentService');
const { parseRules, matchEmail } = require('../services/mailAgentRules');
const emailQueries = require('../db/emailQueries');

const APP_KEY = 'mail-secretary';

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

// ── GET /settings — settings + 30d stats + install/gmail state ──────────────
router.get('/settings', async (req, res) => {
    try {
        const cid = companyId(req);
        const [settings, stats, installStatus, mailboxRow] = await Promise.all([
            mailAgentQueries.getSettings(cid),
            mailAgentQueries.getStats(cid),
            getInstallState(cid),
            emailQueries.getMailboxByCompany(cid).catch(() => null),
        ]);
        res.json({
            ok: true,
            data: {
                settings,
                stats,
                installed: installStatus === 'connected',
                install_status: installStatus,
                gmail_connected: !!(mailboxRow && mailboxRow.provider === 'gmail' && mailboxRow.status === 'connected'),
            },
        });
    } catch (err) {
        console.error('[MailAgent] GET /settings failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load settings' } });
    }
});

// ── PUT /settings — validate exclusion rules, persist, drop the gate cache ──
router.put('/settings', async (req, res) => {
    try {
        const cid = companyId(req);
        const patch = req.body || {};
        if (patch.exclusion_rules !== undefined) {
            try {
                parseRules(String(patch.exclusion_rules));
            } catch (e) {
                return res.status(400).json({
                    ok: false,
                    error: { code: 'BAD_RULES', message: e.message, line: e.line || null },
                });
            }
        }
        if (patch.confidence_threshold !== undefined) {
            const t = Number(patch.confidence_threshold);
            if (!Number.isFinite(t) || t < 0 || t > 1) {
                return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'confidence_threshold must be within 0..1' } });
            }
        }
        const settings = await mailAgentQueries.saveSettings(cid, patch, req.user?.crmUser?.id || null);
        mailAgentService.invalidateCache(cid);
        res.json({ ok: true, data: { settings } });
    } catch (err) {
        console.error('[MailAgent] PUT /settings failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to save settings' } });
    }
});

// ── POST /test-rules — run a sample email through the CURRENT (unsaved) rules ─
router.post('/test-rules', async (req, res) => {
    try {
        const { rules, from, subject, body } = req.body || {};
        let parsed;
        try {
            parsed = parseRules(String(rules ?? ''));
        } catch (e) {
            return res.status(400).json({
                ok: false,
                error: { code: 'BAD_RULES', message: e.message, line: e.line || null },
            });
        }
        const result = matchEmail(parsed, {
            from: String(from || ''), subject: String(subject || ''), body: String(body || ''),
        });
        res.json({ ok: true, data: { excluded: result.excluded, rule_line: result.ruleLine } });
    } catch (err) {
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to test rules' } });
    }
});

// ── POST /dry-run — classify recent inbound mail without side effects ────────
router.post('/dry-run', async (req, res) => {
    try {
        const cid = companyId(req);
        const limit = Math.max(1, Math.min(20, parseInt(req.body?.limit, 10) || 10));
        const results = await mailAgentService.dryRun(cid, limit);
        res.json({ ok: true, data: { results } });
    } catch (err) {
        console.error('[MailAgent] POST /dry-run failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Dry run failed' } });
    }
});

// ── GET /reviews — recent decisions feed ─────────────────────────────────────
router.get('/reviews', async (req, res) => {
    try {
        const cid = companyId(req);
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
        const reviews = await mailAgentQueries.listReviews(cid, limit);
        res.json({ ok: true, data: { reviews } });
    } catch (err) {
        console.error('[MailAgent] GET /reviews failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load reviews' } });
    }
});

module.exports = router;
