const express = require('express');
const router = express.Router();
const realtimeService = require('../services/realtimeService');

/**
 * SSE endpoint for call updates
 * GET /events/calls
 * 
 * Clients connect and receive real-time updates:
 * - call.created: New call detected
 * - call.updated: Call status changed
 * - connected: Initial connection confirmation
 * - keepalive: Heartbeat (every 30s)
 */
router.get('/calls', (req, res) => {
    console.log('[Events] New SSE connection request');

    // Add client to realtime service
    const connectionId = realtimeService.addClient(req, res);

    // Send initial state (optional: could send recent calls here)
    // For now, client will fetch via REST API on connect
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
