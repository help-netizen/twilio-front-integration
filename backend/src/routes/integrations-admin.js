/**
 * Integrations Admin Router
 * 
 * Internal endpoints for managing API integrations (JWT-protected).
 * 
 *   GET    /api/admin/integrations          — List all integrations
 *   POST   /api/admin/integrations          — Create new integration
 *   DELETE /api/admin/integrations/:keyId   — Revoke integration
 */

const express = require('express');
const router = express.Router();
const integrationsService = require('../services/integrationsService');
const { adminAuth } = require('../middleware/adminAuth');

// All admin routes require JWT (or dev fallback)
router.use(adminAuth);

// =============================================================================
// GET / — List all integrations
// =============================================================================
router.get('/', async (req, res) => {
    try {
        const integrations = await integrationsService.listIntegrations();
        res.json({ success: true, integrations });
    } catch (err) {
        console.error('[IntegrationsAdmin] List error:', err.message);
        res.status(500).json({
            success: false,
            message: 'Failed to list integrations.',
            request_id: req.requestId,
        });
    }
});

// =============================================================================
// POST / — Create new integration
// =============================================================================
router.post('/', async (req, res) => {
    try {
        const { client_name, scopes, expires_at } = req.body || {};

        if (!client_name || !client_name.trim()) {
            return res.status(400).json({
                success: false,
                message: 'client_name is required.',
                request_id: req.requestId,
            });
        }

        const result = await integrationsService.createIntegration(
            client_name.trim(),
            scopes || ['leads:create'],
            expires_at || null
        );

        // ⚠️ This response contains the plaintext secret — shown ONCE
        res.status(201).json({
            success: true,
            integration: result,
        });
    } catch (err) {
        console.error('[IntegrationsAdmin] Create error:', err.message);
        res.status(500).json({
            success: false,
            message: 'Failed to create integration.',
            request_id: req.requestId,
        });
    }
});

// =============================================================================
// DELETE /:keyId — Revoke integration
// =============================================================================
router.delete('/:keyId', async (req, res) => {
    try {
        const result = await integrationsService.revokeIntegration(req.params.keyId);
        res.json({ success: true, revoked: result });
    } catch (err) {
        if (err.status === 404) {
            return res.status(404).json({
                success: false,
                message: err.message,
                request_id: req.requestId,
            });
        }
        console.error('[IntegrationsAdmin] Revoke error:', err.message);
        res.status(500).json({
            success: false,
            message: 'Failed to revoke integration.',
            request_id: req.requestId,
        });
    }
});

module.exports = router;
