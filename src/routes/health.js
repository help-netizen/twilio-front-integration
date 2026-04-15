const express = require('express');
const router = express.Router();
const db = require('../../backend/src/db/connection');

/**
 * Health check endpoint — liveness probe.
 * Fly.dev calls this every 15s to know the process is alive.
 */
router.get('/', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});

/**
 * Readiness check — verifies the app can serve real traffic.
 * Returns 503 if database is unreachable so Fly.dev stops routing requests.
 */
router.get('/ready', async (req, res) => {
    let dbOk = false;
    try {
        await db.query('SELECT 1');
        dbOk = true;
    } catch { }

    const checks = {
        server: true,
        database: dbOk,
    };

    const isReady = Object.values(checks).every(check => check === true);

    res.status(isReady ? 200 : 503).json({
        ready: isReady,
        checks,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
