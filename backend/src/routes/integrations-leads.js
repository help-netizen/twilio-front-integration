/**
 * Integrations Leads Router
 * 
 * External endpoint for lead generators:
 *   POST /api/v1/integrations/leads
 * 
 * Auth: X-BLANC-API-KEY + X-BLANC-API-SECRET headers
 * Rate limited per key_id and IP.
 */

const express = require('express');
const router = express.Router();
const leadsService = require('../services/leadsService');
const {
    rejectLegacyAuth,
    validateHeaders,
    authenticateIntegration,
} = require('../middleware/integrationsAuth');
const rateLimiter = require('../middleware/rateLimiter');

// =============================================================================
// Middleware chain
// =============================================================================
router.use(rejectLegacyAuth);
router.use(validateHeaders);
router.use(authenticateIntegration);
router.use(rateLimiter);

// =============================================================================
// POST /api/v1/integrations/leads — Create a lead
// =============================================================================
router.post('/leads', async (req, res) => {
    try {
        // Check scope
        const scopes = req.integrationScopes || [];
        if (!scopes.includes('leads:create')) {
            return res.status(403).json({
                success: false,
                code: 'SCOPE_INSUFFICIENT',
                message: 'This integration does not have leads:create scope.',
                request_id: req.requestId,
            });
        }

        // Validate required fields
        const payload = req.body || {};
        if (!payload.FirstName && !payload.LastName && !payload.Phone && !payload.Email) {
            return res.status(400).json({
                success: false,
                code: 'PAYLOAD_INVALID',
                message: 'At least one of FirstName, LastName, Phone, or Email is required.',
                request_id: req.requestId,
            });
        }

        // Contact deduplication: resolve or create contact (non-blocking — if it fails, lead still gets created)
        let contactResolution = { contact_id: null, status: 'skipped' };
        try {
            if (payload.FirstName && payload.LastName && payload.Phone) {
                const contactDedupeService = require('../services/contactDedupeService');
                contactResolution = await contactDedupeService.resolveContact({
                    first_name: payload.FirstName,
                    last_name: payload.LastName,
                    phone: payload.Phone,
                    email: payload.Email,
                }, req.integrationCompanyId);

                if (contactResolution.contact_id) {
                    payload.contact_id = contactResolution.contact_id;
                }
            }
        } catch (dedupeErr) {
            console.error('[IntegrationsLeads] Contact dedup error (non-blocking):', dedupeErr.message);
        }

        // Create lead
        const result = await leadsService.createLead(payload, req.integrationCompanyId);

        // Fallback: link contact if createLead didn't persist it
        if (contactResolution.contact_id && result.ClientId) {
            try {
                const db = require('../db/connection');
                await db.query(
                    'UPDATE leads SET contact_id = $1 WHERE id = $2 AND contact_id IS NULL',
                    [contactResolution.contact_id, result.ClientId]
                );
            } catch { /* ignore */ }
        }

        // Address sync: persist lead address to contact_addresses
        if (contactResolution.contact_id && payload.Address) {
            try {
                const contactAddressService = require('../services/contactAddressService');
                const addrResult = await contactAddressService.resolveAddress(
                    contactResolution.contact_id,
                    {
                        street: payload.Address,
                        apt: payload.Unit || null,
                        city: payload.City || '',
                        state: payload.State || '',
                        zip: payload.PostalCode || '',
                        lat: payload.Latitude || null,
                        lng: payload.Longitude || null,
                    }
                );
                if (addrResult.contact_address_id && result.ClientId) {
                    const db = require('../db/connection');
                    await db.query(
                        'UPDATE leads SET contact_address_id = $1 WHERE id = $2',
                        [addrResult.contact_address_id, result.ClientId]
                    );
                }
            } catch (addrErr) {
                console.error('[IntegrationsLeads] Address sync error (non-blocking):', addrErr.message);
            }
        }

        res.status(201).json({
            success: true,
            lead_id: result.UUID,
            serial_id: result.SerialId,
            contact_id: contactResolution.contact_id,
            request_id: req.requestId,
        });
    } catch (err) {
        if (err instanceof leadsService.LeadsServiceError) {
            return res.status(err.httpStatus || 400).json({
                success: false,
                code: 'PAYLOAD_INVALID',
                message: err.message,
                request_id: req.requestId,
            });
        }
        console.error('[IntegrationsLeads] Error:', err.message);
        res.status(500).json({
            success: false,
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
            request_id: req.requestId,
        });
    }
});

module.exports = router;
