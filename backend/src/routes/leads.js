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
const contactDedupeService = require('../services/contactDedupeService');
const contactAddressService = require('../services/contactAddressService');

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
            companyId: req.companyFilter?.company_id,
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
// GET /api/leads/by-phone/:phone — Find newest lead by phone number
// =============================================================================
router.get('/by-phone/:phone', async (req, res) => {
    const reqId = requestId();
    try {
        const { phone } = req.params;
        if (!phone || phone.length < 5) {
            return res.status(400).json(errorResponse('INVALID_PHONE', 'Phone number is required (min 5 chars)', reqId));
        }

        const lead = await leadsService.getLeadByPhone(phone, req.companyFilter?.company_id);
        res.json(successResponse({ lead }, reqId));
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

        const lead = await leadsService.getLeadByUUID(uuid, req.companyFilter?.company_id);
        res.json(successResponse({ lead }, reqId));
    } catch (err) {
        handleError(err, reqId, res);
    }
});

// =============================================================================
// POST /api/leads — Create lead (with contact deduplication)
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

        const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
        const companyId = req.companyFilter?.company_id || req.user?.company_id || DEFAULT_COMPANY_ID;

        // Contact deduplication: resolve or create contact
        const contactResolution = await contactDedupeService.resolveContact({
            first_name: body.FirstName,
            last_name: body.LastName,
            phone: body.Phone,
            email: body.Email,
        }, companyId);

        // If ambiguous, return 409 with candidates for UI/API to resolve
        if (contactResolution.status === 'ambiguous') {
            return res.status(409).json({
                ok: false,
                error: {
                    code: 'CONTACT_AMBIGUOUS',
                    message: contactResolution.warnings.join('; '),
                    correlation_id: reqId,
                },
                contact_resolution: contactResolution,
            });
        }

        // Set contact_id on the lead body so createLead links it
        if (contactResolution.contact_id) {
            body.contact_id = contactResolution.contact_id;
        }

        const result = await leadsService.createLead(body, companyId);

        // Link lead to contact if not already done by createLead
        if (contactResolution.contact_id && result.ClientId) {
            try {
                await require('../db/connection').query(
                    'UPDATE leads SET contact_id = $1 WHERE id = $2 AND contact_id IS NULL',
                    [contactResolution.contact_id, result.ClientId]
                );
            } catch { /* ignore if already linked */ }
        }

        // Address sync: persist lead address to contact_addresses
        let addressResolution = { contact_address_id: null, status: 'none' };
        if (contactResolution.contact_id && body.Address) {
            try {
                addressResolution = await contactAddressService.resolveAddress(
                    contactResolution.contact_id,
                    {
                        street: body.Address,
                        apt: body.Unit || null,
                        city: body.City || '',
                        state: body.State || '',
                        zip: body.PostalCode || '',
                        lat: body.Latitude || null,
                        lng: body.Longitude || null,
                        placeId: body.google_place_id || null,
                    }
                );
                // Link lead to address
                if (addressResolution.contact_address_id && result.ClientId) {
                    await require('../db/connection').query(
                        'UPDATE leads SET contact_address_id = $1 WHERE id = $2',
                        [addressResolution.contact_address_id, result.ClientId]
                    );
                }
            } catch (addrErr) {
                console.error(`[LeadsAPI][${reqId}] Address sync error:`, addrErr.message);
            }
        }

        res.status(201).json(successResponse({
            ...result,
            contact_resolution: {
                contact_id: contactResolution.contact_id,
                status: contactResolution.status,
                matched_by: contactResolution.matched_by,
                email_enriched: contactResolution.email_enriched,
                warnings: contactResolution.warnings,
            },
            address_resolution: {
                contact_address_id: addressResolution.contact_address_id,
                status: addressResolution.status,
            },
        }, reqId));
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

        const result = await leadsService.updateLead(uuid, fields, req.companyFilter?.company_id);

        // Sync contact if lead has contact_id and contact-relevant fields changed
        const contactFields = ['FirstName', 'LastName', 'Phone', 'Email'];
        const hasContactChange = contactFields.some(f => f in fields);
        if (hasContactChange) {
            try {
                const db = require('../db/connection');
                // Get the updated lead to read its contact_id and current data
                const lead = await leadsService.getLeadByUUID(uuid, req.companyFilter?.company_id);
                if (lead && lead.ContactId) {
                    const updates = [];
                    const params = [];
                    let idx = 1;

                    if (lead.FirstName || lead.LastName) {
                        const fullName = [lead.FirstName, lead.LastName].filter(Boolean).join(' ');
                        updates.push(`full_name = $${idx++}`);
                        params.push(fullName);
                        updates.push(`first_name = $${idx++}`);
                        params.push(lead.FirstName || null);
                        updates.push(`last_name = $${idx++}`);
                        params.push(lead.LastName || null);
                    }
                    if (lead.Phone) {
                        updates.push(`phone_e164 = $${idx++}`);
                        params.push(lead.Phone);
                    }
                    if (lead.Email) {
                        updates.push(`email = $${idx++}`);
                        params.push(lead.Email);
                    }

                    if (updates.length > 0) {
                        params.push(lead.ContactId);
                        await db.query(
                            `UPDATE contacts SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
                            params
                        );
                    }
                }
            } catch (syncErr) {
                console.error(`[LeadsAPI][${reqId}] Contact sync error (non-blocking):`, syncErr.message);
            }
        }

        // Address sync: if address fields changed, resolve and link to contact_addresses
        const addressFields = ['Address', 'City', 'State', 'PostalCode', 'Unit'];
        const hasAddressChange = addressFields.some(f => f in fields);
        if (hasAddressChange) {
            try {
                const db = require('../db/connection');
                const lead = hasContactChange
                    ? await leadsService.getLeadByUUID(uuid, req.companyFilter?.company_id)
                    : await leadsService.getLeadByUUID(uuid, req.companyFilter?.company_id);
                if (lead && lead.ContactId && lead.Address) {
                    const addrResult = await contactAddressService.resolveAddress(
                        lead.ContactId,
                        {
                            street: lead.Address,
                            apt: lead.Unit || null,
                            city: lead.City || '',
                            state: lead.State || '',
                            zip: lead.PostalCode || '',
                            lat: lead.Latitude || null,
                            lng: lead.Longitude || null,
                            placeId: fields.google_place_id || null,
                        }
                    );
                    if (addrResult.contact_address_id) {
                        await db.query(
                            'UPDATE leads SET contact_address_id = $1 WHERE uuid = $2',
                            [addrResult.contact_address_id, uuid]
                        );
                    }
                }
            } catch (addrErr) {
                console.error(`[LeadsAPI][${reqId}] Address sync error (non-blocking):`, addrErr.message);
            }
        }

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
        const result = await leadsService.markLost(req.params.uuid, req.companyFilter?.company_id);
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
        const result = await leadsService.activateLead(req.params.uuid, req.companyFilter?.company_id);
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
        const result = await leadsService.unassignUser(req.params.uuid, User, req.companyFilter?.company_id);
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
        const result = await leadsService.convertLead(req.params.uuid, req.body || {}, req.companyFilter?.company_id);
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
