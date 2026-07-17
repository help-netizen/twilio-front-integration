const express = require('express');
const router = express.Router();
const twilioSync = require('../services/twilioSync');

/**
 * POST /api/sync/today
 * Sync all calls from today (00:00 EST to now)
 */
router.post('/today', async (req, res) => {
    try {
        console.log('🔄 Manual sync triggered: Today\'s calls');
        const result = await twilioSync.syncTodayCalls();

        res.json({
            success: true,
            message: `Synced ${result.synced} new calls from last 3 days`,
            synced: result.synced,
            skipped: result.skipped,
            total: result.total
        });
    } catch (error) {
        console.error('Error in /api/sync/today:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to sync today\'s calls',
            message: error.message
        });
    }
});

/**
 * POST /api/sync/recent
 * Sync recent calls (last hour)
 */
router.post('/recent', async (req, res) => {
    try {
        console.log('🔄 Manual sync triggered: Recent calls');
        const synced = await twilioSync.syncRecentCalls();

        res.json({
            success: true,
            message: `Synced ${synced} recent calls`,
            synced
        });
    } catch (error) {
        console.error('Error in /api/sync/recent:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to sync recent calls',
            message: error.message
        });
    }
});

module.exports = router;
