/**
 * Leads API Router
 * 
 * Internal API endpoints for leads CRUD.
 * All responses use unified envelope: { ok, data, meta }
 * 
 * Backed by PostgreSQL via leadsService (self-contained, no external API).
 */

const express = require('express');
const router = express.Router();
const leadsService = require('../services/leadsService');

// =============================================================================
// Helpers
// =============================================================================

function requestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function successResponse(data, reqId) {
    return {
        ok: true,
        data,
        meta: {
            request_id: reqId,
            timestamp: new Date().toISOString(),
        },
    };
}

function errorResponse(code, message, reqId, details = null) {
    return {
        ok: false,
        error: {
            code,
            message,
            details,
            correlation_id: reqId,
        },
    };
}

// =============================================================================
// GET /api/leads — List leads
// =============================================================================
router.get('/', async (req, res) => {
    const reqId = requestId();
    try {
        const { start_date, offset, records, only_open, status } = req.query;

        // Validate
        if (offset !== undefined && (isNaN(Number(offset)) || Number(offset) < 0)) {
            return res.status(400).json(errorResponse('INVALID_QUERY', 'offset must be a non-negative integer', reqId));
        }
        if (records !== undefined && (isNaN(Number(records)) || Number(records) < 1 || Number(records) > 100)) {
            return res.status(400).json(errorResponse('INVALID_QUERY', 'records must be 1-100', reqId));
        }

        const params = {
            start_date,
            offset: offset ? Number(offset) : 0,
            records: records ? Number(records) : 100,
            only_open: only_open !== 'false',
            status: status ? (Array.isArray(status) ? status : [status]) : undefined,
        };

        const result = await leadsService.listLeads(params);

        res.json(successResponse({
            results: result.results,
            pagination: result.pagination,
            filters: {
                start_date: params.start_date || null,
                only_open: params.only_open,
                status: params.status || [],
            },
        }, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// GET /api/leads/:uuid — Get lead details
// =============================================================================
router.get('/:uuid', async (req, res) => {
    const reqId = requestId();
    try {
        const { uuid } = req.params;
        if (!uuid || uuid.length < 2) {
            return res.status(400).json(errorResponse('INVALID_UUID', 'UUID is required', reqId));
        }

        const lead = await leadsService.getLeadByUUID(uuid);
        res.json(successResponse({ lead }, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// POST /api/leads — Create lead
// =============================================================================
router.post('/', async (req, res) => {
    const reqId = requestId();
    try {
        const body = req.body;

        // Validate required fields for create
        const errors = [];
        if (!body.FirstName) errors.push('FirstName is required');
        if (!body.LastName) errors.push('LastName is required');
        if (!body.Phone || body.Phone.length < 5) errors.push('Phone is required (min 5 chars)');

        if (errors.length > 0) {
            return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.join('; '), reqId));
        }

        const result = await leadsService.createLead(body);
        res.status(201).json(successResponse(result, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// PATCH /api/leads/:uuid — Update lead
// =============================================================================
router.patch('/:uuid', async (req, res) => {
    const reqId = requestId();
    try {
        const { uuid } = req.params;
        const body = req.body;

        if (!uuid) {
            return res.status(400).json(errorResponse('INVALID_UUID', 'UUID is required', reqId));
        }

        // Must have at least one field to update
        const { UUID: _, ...fields } = body;
        if (Object.keys(fields).length === 0) {
            return res.status(400).json(errorResponse('VALIDATION_ERROR', 'At least one field must be provided', reqId));
        }

        const result = await leadsService.updateLead(uuid, fields);
        res.json(successResponse(result, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// POST /api/leads/:uuid/mark-lost
// =============================================================================
router.post('/:uuid/mark-lost', async (req, res) => {
    const reqId = requestId();
    try {
        const result = await leadsService.markLost(req.params.uuid);
        res.json(successResponse(result, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// POST /api/leads/:uuid/activate
// =============================================================================
router.post('/:uuid/activate', async (req, res) => {
    const reqId = requestId();
    try {
        const result = await leadsService.activateLead(req.params.uuid);
        res.json(successResponse(result, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// POST /api/leads/:uuid/assign
// =============================================================================
router.post('/:uuid/assign', async (req, res) => {
    const reqId = requestId();
    try {
        const { User } = req.body;
        if (!User) {
            return res.status(400).json(errorResponse('VALIDATION_ERROR', 'User is required', reqId));
        }
        const result = await leadsService.assignUser(req.params.uuid, User);
        res.json(successResponse(result, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// POST /api/leads/:uuid/unassign
// =============================================================================
router.post('/:uuid/unassign', async (req, res) => {
    const reqId = requestId();
    try {
        const { User } = req.body;
        if (!User) {
            return res.status(400).json(errorResponse('VALIDATION_ERROR', 'User is required', reqId));
        }
        const result = await leadsService.unassignUser(req.params.uuid, User);
        res.json(successResponse(result, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// POST /api/leads/:uuid/convert
// =============================================================================
router.post('/:uuid/convert', async (req, res) => {
    const reqId = requestId();
    try {
        const result = await leadsService.convertLead(req.params.uuid, req.body || {});
        res.json(successResponse(result, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// Error handler
// =============================================================================
function handleError(err, reqId, res) {
    if (err instanceof leadsService.LeadsServiceError) {
        const status = err.httpStatus || 500;
        return res.status(status).json(errorResponse(err.code, err.message, reqId));
    }
    console.error(`[LeadsAPI][${reqId}] Unhandled error:`, err);
    res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
}

module.exports = router;
