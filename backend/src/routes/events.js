const express = require('express');
const router = express.Router();
const realtimeService = require('../services/realtimeService');
const { authenticate } = require('../middleware/keycloakAuth');

/**
 * SSE endpoint for call updates
 * GET /events/calls?token=<jwt>
 * 
 * Authenticated via query param (EventSource API can't send headers).
 * keycloakAuth.authenticate already supports ?token= fallback.
 * 
 * Clients connect and receive real-time updates:
 * - call.created: New call detected
 * - call.updated: Call status changed
 * - connected: Initial connection confirmation
 * - keepalive: Heartbeat (every 30s)
 */
router.get('/calls', authenticate, (req, res) => {
    console.log(`[Events] SSE connection from user ${req.user?.sub || 'unknown'}`);

    // Add client to realtime service
    const connectionId = realtimeService.addClient(req, res);
});

/**
 * GET /events/stats
 * Monitoring endpoint for SSE service statistics
 */
router.get('/stats', (req, res) => {
    const stats = realtimeService.getStats();
    res.json(stats);
});

module.exports = router;

