const express = require('express');
const router = express.Router();

/**
 * Health check endpoint
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
 * Readiness check (for Kubernetes/load balancers)
 */
router.get('/ready', (req, res) => {
    // Add checks for database, external services, etc.
    const checks = {
        server: true,
        // database: checkDatabaseConnection(),
        // twilio: checkTwilioAPI(),
        // front: checkFrontAPI()
    };

    const isReady = Object.values(checks).every(check => check === true);
    const statusCode = isReady ? 200 : 503;

    res.status(statusCode).json({
        ready: isReady,
        checks,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
