/**
 * Zenbooker Integration Routes
 *
 * - POST /webhooks         — Receive Zenbooker webhooks (legacy, secret-validated)
 * - POST /wh/:key          — Receive Zenbooker webhooks (per-company, key in URL)
 * - GET  /webhook-url      — Get webhook URL for the current company
 * - POST /webhook-url/regenerate — Regenerate webhook key
 * - POST /contacts/:contactId/create-customer — Create Zenbooker customer from Blanc contact
 * - POST /contacts/:contactId/sync — Sync Blanc contact to Zenbooker
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db/connection');
const zenbookerSyncService = require('../services/zenbookerSyncService');
const { authenticate, requireCompanyAccess } = require('../middleware/keycloakAuth');

const WEBHOOK_SECRET = process.env.ZENBOOKER_WEBHOOK_SECRET;

// =============================================================================
// Helpers
// =============================================================================
function requestId() {
    return `zb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

// =============================================================================
// Shared: process webhook payload (used by both legacy and per-company routes)
// =============================================================================
async function processWebhookPayload(reqId, payload, headers, companyId = null) {
    const event = payload.event || 'unknown';
    const dataId = payload.data?.id ? String(payload.data.id) : 'unknown';
    const webhookId = payload.webhook_id || '';
    const retryCount = payload.retry_count || 0;

    console.log(`[ZbWebhook][${reqId}] Received event=${event} data.id=${dataId} webhook_id=${webhookId} retry=${retryCount}`);

    // Store in webhook_inbox for audit (reqId is unique per HTTP request)
    const eventKey = `zenbooker:${event}:${dataId}:${reqId}`;
    try {
        await db.query(
            `INSERT INTO webhook_inbox (provider, event_key, source, event_type, call_sid, payload, headers, company_id)
             VALUES ('zenbooker', $1, 'zenbooker', $2, NULL, $3::jsonb, $4::jsonb, $5)
             ON CONFLICT (event_key) DO NOTHING
             RETURNING id`,
            [eventKey, event, JSON.stringify(payload), JSON.stringify(headers), companyId]
        );
    } catch (dbErr) {
        if (dbErr.code === '23505') {
            console.log(`[ZbWebhook][${reqId}] Duplicate event_key=${eventKey}, skipping`);
            return;
        }
        console.error(`[ZbWebhook][${reqId}] DB error:`, dbErr.message);
        return;
    }

    // Process event
    if (event.startsWith('customer.') && zenbookerSyncService.FEATURE_ENABLED) {
        try {
            await zenbookerSyncService.handleWebhookPayload(payload, companyId);
            await db.query(
                `UPDATE webhook_inbox SET status = 'processed', processed_at = NOW(), attempts = attempts + 1
                 WHERE event_key = $1 AND provider = 'zenbooker'`,
                [eventKey]
            );
            console.log(`[ZbWebhook][${reqId}] Processed event=${event} successfully`);
        } catch (procErr) {
            console.error(`[ZbWebhook][${reqId}] Processing error:`, procErr.message);
            await db.query(
                `UPDATE webhook_inbox SET status = 'failed', error_text = $1, attempts = attempts + 1
                 WHERE event_key = $2 AND provider = 'zenbooker'`,
                [procErr.message, eventKey]
            );
        }
    } else if (event.startsWith('job.')) {
        try {
            const jobsService = require('../services/jobsService');
            const jobSyncService = require('../services/jobSyncService');

            const zbJobId = payload.data?.id || payload.data?.job_id;
            if (zbJobId) {
                const localResult = await jobsService.syncFromZenbooker(zbJobId, payload.data, companyId);
                console.log(`[ZbWebhook][${reqId}] Local job sync:`, JSON.stringify(localResult));
            }

            const legacyResult = await jobSyncService.handleJobWebhook(payload);
            console.log(`[ZbWebhook][${reqId}] Lead sub_status sync:`, JSON.stringify(legacyResult));

            await db.query(
                `UPDATE webhook_inbox SET status = 'processed', processed_at = NOW(), attempts = attempts + 1
                 WHERE event_key = $1 AND provider = 'zenbooker'`,
                [eventKey]
            );
        } catch (procErr) {
            console.error(`[ZbWebhook][${reqId}] Job event processing error:`, procErr.message);
            await db.query(
                `UPDATE webhook_inbox SET status = 'failed', error_text = $1, attempts = attempts + 1
                 WHERE event_key = $2 AND provider = 'zenbooker'`,
                [procErr.message, eventKey]
            );
        }
    } else {
        console.log(`[ZbWebhook][${reqId}] Event ${event} not handled or feature disabled`);
    }
}

// =============================================================================
// POST /webhooks — Legacy webhook receiver (secret-validated)
// =============================================================================
router.post('/webhooks', async (req, res) => {
    const reqId = requestId();
    try {
        if (WEBHOOK_SECRET) {
            const incomingSecret = req.headers['x-zenbooker-secret'] || req.query.secret;
            if (incomingSecret !== WEBHOOK_SECRET) {
                console.warn(`[ZbWebhook][${reqId}] Invalid secret`);
                return res.status(401).json({ error: 'Unauthorized' });
            }
        }

        res.status(200).json({ ok: true, request_id: reqId });
        await processWebhookPayload(reqId, req.body, req.headers);
    } catch (err) {
        console.error(`[ZbWebhook][${reqId}] Unexpected error:`, err);
    }
});

// =============================================================================
// POST /wh/:key — Per-company webhook receiver (key in URL)
// =============================================================================
router.post('/wh/:key', async (req, res) => {
    const reqId = requestId();
    try {
        const { key } = req.params;
        if (!key || key.length < 32) {
            return res.status(401).json({ error: 'Invalid webhook key' });
        }

        // Look up company by key
        const result = await db.query(
            `SELECT id, name FROM companies WHERE zenbooker_webhook_key = $1 AND status = 'active'`,
            [key]
        );
        if (result.rows.length === 0) {
            console.warn(`[ZbWebhook][${reqId}] Unknown webhook key`);
            return res.status(401).json({ error: 'Invalid webhook key' });
        }

        const company = result.rows[0];
        console.log(`[ZbWebhook][${reqId}] Company: ${company.name} (${company.id})`);

        // Respond 200 immediately
        res.status(200).json({ ok: true, request_id: reqId });

        // Process async
        await processWebhookPayload(reqId, req.body, req.headers, company.id);
    } catch (err) {
        console.error(`[ZbWebhook][${reqId}] Unexpected error:`, err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal error' });
        }
    }
});

// =============================================================================
// GET /webhook-url — Get webhook URL for the current company
// =============================================================================
router.get('/webhook-url', authenticate, requireCompanyAccess, async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyId;
        let result = await db.query(
            `SELECT zenbooker_webhook_key FROM companies WHERE id = $1`,
            [companyId]
        );

        let key = result.rows[0]?.zenbooker_webhook_key;

        // Auto-generate if no key exists
        if (!key) {
            key = crypto.randomBytes(32).toString('hex');
            await db.query(
                `UPDATE companies SET zenbooker_webhook_key = $1 WHERE id = $2`,
                [key, companyId]
            );
            console.log(`[ZbIntegration][${reqId}] Generated webhook key for company ${companyId}`);
        }

        const baseUrl = process.env.CALLBACK_HOSTNAME || `http://localhost:${process.env.PORT || 3000}`;
        const url = `${baseUrl}/api/integrations/zenbooker/wh/${key}`;

        res.json({ ok: true, data: { url, key } });
    } catch (err) {
        console.error(`[ZbIntegration][${reqId}] webhook-url error:`, err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
});

// =============================================================================
// POST /webhook-url/regenerate — Generate new webhook key
// =============================================================================
router.post('/webhook-url/regenerate', authenticate, requireCompanyAccess, async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyId;
        const key = crypto.randomBytes(32).toString('hex');

        await db.query(
            `UPDATE companies SET zenbooker_webhook_key = $1 WHERE id = $2`,
            [key, companyId]
        );

        const baseUrl = process.env.CALLBACK_HOSTNAME || `http://localhost:${process.env.PORT || 3000}`;
        const url = `${baseUrl}/api/integrations/zenbooker/wh/${key}`;

        console.log(`[ZbIntegration][${reqId}] Regenerated webhook key for company ${companyId}`);
        res.json({ ok: true, data: { url, key } });
    } catch (err) {
        console.error(`[ZbIntegration][${reqId}] regenerate error:`, err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
});

// =============================================================================
// POST /contacts/:contactId/create-customer — Create Zenbooker customer
// =============================================================================
router.post('/contacts/:contactId/create-customer', authenticate, requireCompanyAccess, async (req, res) => {
    const reqId = requestId();
    try {
        const contactId = Number(req.params.contactId);
        if (isNaN(contactId)) {
            return res.status(400).json({ ok: false, error: { code: 'INVALID_ID', message: 'Contact ID must be a number' } });
        }

        const result = await zenbookerSyncService.pushContactToZenbooker(contactId);
        res.json({ ok: true, data: result, meta: { request_id: reqId } });
    } catch (err) {
        if (err.code === 'FEATURE_DISABLED') {
            return res.status(503).json({ ok: false, error: { code: 'FEATURE_DISABLED', message: 'Zenbooker sync is not enabled' } });
        }
        if (err.code === 'ALREADY_LINKED') {
            return res.status(409).json({ ok: false, error: { code: 'ALREADY_LINKED', message: err.message } });
        }
        if (err.code === 'NOT_FOUND') {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } });
        }
        console.error(`[ZbIntegration][${reqId}] create-customer error:`, err.response?.data || err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
});

// =============================================================================
// POST /contacts/:contactId/sync — Sync Blanc contact to Zenbooker
// =============================================================================
router.post('/contacts/:contactId/sync', authenticate, requireCompanyAccess, async (req, res) => {
    const reqId = requestId();
    try {
        const contactId = Number(req.params.contactId);
        if (isNaN(contactId)) {
            return res.status(400).json({ ok: false, error: { code: 'INVALID_ID', message: 'Contact ID must be a number' } });
        }

        await zenbookerSyncService.syncContactToZenbooker(contactId);

        const contactsService = require('../services/contactsService');
        const contact = await contactsService.getContactById(contactId);
        res.json({ ok: true, data: { contact }, meta: { request_id: reqId } });
    } catch (err) {
        if (err.code === 'FEATURE_DISABLED') {
            return res.status(503).json({ ok: false, error: { code: 'FEATURE_DISABLED', message: 'Zenbooker sync is not enabled' } });
        }
        if (err.code === 'NOT_FOUND') {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } });
        }
        console.error(`[ZbIntegration][${reqId}] sync error:`, err.response?.data || err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
});
// =============================================================================
// GET /jobs — Fetch Zenbooker jobs for a customer
// =============================================================================
router.get('/jobs', authenticate, requireCompanyAccess, async (req, res) => {
    const reqId = requestId();
    try {
        const customerId = req.query.customer_id;
        if (!customerId) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_CUSTOMER_ID', message: 'customer_id query parameter required' } });
        }

        const zenbookerClient = require('../services/zenbookerClient');

        // Fetch jobs for this customer (paginated)
        const allJobs = [];
        let cursor = 0;
        const limit = 100;

        while (true) {
            const jobRes = await zenbookerClient.getClient().get('/jobs', {
                params: { customer: customerId, limit, cursor },
            });
            const data = jobRes.data;
            const results = data.results || [];
            allJobs.push(...results);
            if (!data.has_more || results.length === 0) break;
            cursor += results.length;
            if (allJobs.length >= 200) break; // Safety limit
        }

        // Map to lightweight response
        const jobs = allJobs.map(job => ({
            id: job.id,
            job_number: job.job_number || null,
            service_name: job.service_name || null,
            status: job.canceled ? 'Canceled' : (job.status || 'Unknown'),
            start_date: job.start_date || null,
            end_date: job.end_date || null,
            created: job.created || null,
            assigned_providers: (job.assigned_providers || []).map(p => p.name).filter(Boolean),
            service_address: job.service_address?.formatted || null,
            invoice_total: job.invoice?.total || null,
            invoice_status: job.invoice?.status || null,
            recurring: job.recurring || false,
        }));

        res.json({ ok: true, data: jobs });
    } catch (err) {
        console.error(`[ZbIntegration][${reqId}] jobs error:`, err.response?.data || err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
});

module.exports = router;
