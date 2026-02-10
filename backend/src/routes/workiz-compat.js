/**
 * Workiz-Compatible API Router
 * 
 * External endpoints that mimic Workiz's lead API surface.
 * Lead generators can point here instead of Workiz without changing their integrations.
 * 
 * Auth: validates api_key in URL path + auth_secret in POST body.
 * Response format: Workiz-style (raw arrays, not our envelope format).
 * 
 * Mounted at: /api/v1/:apiKey/lead/...
 */

const express = require('express');
const router = express.Router({ mergeParams: true });
const leadsService = require('../services/leadsService');

const BLANC_API_KEY = process.env.BLANC_API_KEY;
const BLANC_API_SECRET = process.env.BLANC_API_SECRET;

// =============================================================================
// Auth middleware
// =============================================================================
function validateApiKey(req, res, next) {
    if (!BLANC_API_KEY) {
        return res.status(500).json({ error: 'Workiz-compat API not configured' });
    }
    if (req.params.apiKey !== BLANC_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    next();
}

function validateAuthSecret(req, res, next) {
    if (!BLANC_API_SECRET) {
        return res.status(500).json({ error: 'Workiz-compat API secret not configured' });
    }
    const { auth_secret } = req.body || {};
    if (auth_secret !== BLANC_API_SECRET) {
        return res.status(401).json({ error: 'Invalid auth_secret' });
    }
    // Remove auth_secret from body so it's not passed to service
    delete req.body.auth_secret;
    next();
}

router.use(validateApiKey);

// =============================================================================
// GET /api/v1/:apiKey/lead/all/ — List leads (Workiz format)
// =============================================================================
router.get('/lead/all/', async (req, res) => {
    try {
        const { start_date, offset, records, only_open, status } = req.query;

        const result = await leadsService.listLeads({
            start_date,
            offset: offset ? Number(offset) : 0,
            records: records ? Number(records) : 100,
            only_open: only_open !== 'false',
            status: status ? (Array.isArray(status) ? status : [status]) : undefined,
        });

        // Workiz returns raw array of leads
        res.json(result.results);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// GET /api/v1/:apiKey/lead/get/:uuid/ — Get lead details (Workiz format)
// =============================================================================
router.get('/lead/get/:uuid/', async (req, res) => {
    try {
        const lead = await leadsService.getLeadByUUID(req.params.uuid);
        // Workiz returns [lead]
        res.json([lead]);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// POST /api/v1/:apiKey/lead/create/ — Create lead (Workiz format)
// =============================================================================
router.post('/lead/create/', validateAuthSecret, async (req, res) => {
    try {
        const result = await leadsService.createLead(req.body);
        // Workiz returns [{ flag: "1", data: [{ UUID, ClientId, link }] }]
        res.json([{
            flag: '1',
            data: [result],
        }]);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// POST /api/v1/:apiKey/lead/update/ — Update lead (Workiz format)
// =============================================================================
router.post('/lead/update/', validateAuthSecret, async (req, res) => {
    try {
        const { UUID, ...fields } = req.body;
        if (!UUID) {
            return res.status(400).json({ error: 'UUID is required' });
        }
        const result = await leadsService.updateLead(UUID, fields);
        res.json([{
            flag: '1',
            data: [result],
        }]);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// POST /api/v1/:apiKey/lead/markLost/:uuid/ — Mark lost (Workiz format)
// =============================================================================
router.post('/lead/markLost/:uuid/', validateAuthSecret, async (req, res) => {
    try {
        await leadsService.markLost(req.params.uuid);
        res.json([{ flag: '1', message: 'Lead marked as lost' }]);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// POST /api/v1/:apiKey/lead/activate/:uuid/ — Activate (Workiz format)
// =============================================================================
router.post('/lead/activate/:uuid/', validateAuthSecret, async (req, res) => {
    try {
        await leadsService.activateLead(req.params.uuid);
        res.json([{ flag: '1', message: 'Lead activated' }]);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// POST /api/v1/:apiKey/lead/assign/ — Assign user (Workiz format)
// =============================================================================
router.post('/lead/assign/', validateAuthSecret, async (req, res) => {
    try {
        const { UUID, User } = req.body;
        if (!UUID || !User) {
            return res.status(400).json({ error: 'UUID and User are required' });
        }
        const result = await leadsService.assignUser(UUID, User);
        res.json([{
            flag: '1',
            data: [result],
        }]);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// POST /api/v1/:apiKey/lead/unassign/ — Unassign user (Workiz format)
// =============================================================================
router.post('/lead/unassign/', validateAuthSecret, async (req, res) => {
    try {
        const { UUID, User } = req.body;
        if (!UUID || !User) {
            return res.status(400).json({ error: 'UUID and User are required' });
        }
        const result = await leadsService.unassignUser(UUID, User);
        res.json([{
            flag: '1',
            data: [result],
        }]);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// POST /api/v1/:apiKey/lead/convert/ — Convert to job (Workiz format)
// =============================================================================
router.post('/lead/convert/', validateAuthSecret, async (req, res) => {
    try {
        const { UUID } = req.body;
        if (!UUID) {
            return res.status(400).json({ error: 'UUID is required' });
        }
        const result = await leadsService.convertLead(UUID);
        res.json([{
            flag: '1',
            data: [result],
        }]);
    } catch (err) {
        handleError(err, res);
    }
});

// =============================================================================
// Error handler (Workiz-style errors)
// =============================================================================
function handleError(err, res) {
    if (err instanceof leadsService.LeadsServiceError) {
        const status = err.httpStatus || 500;
        return res.status(status).json({ error: err.message });
    }
    console.error('[WorkizCompat] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
}

module.exports = router;
