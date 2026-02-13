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

        // Create lead
        const result = await leadsService.createLead(payload, req.integrationCompanyId);

        res.status(201).json({
            success: true,
            lead_id: result.UUID,
            serial_id: result.SerialId,
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
