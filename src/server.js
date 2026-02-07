require('dotenv').config();
const express = require('express');
const path = require('path');
const webhooksRouter = require('../backend/src/routes/webhooks'); // Updated to use new webhook router
const healthRouter = require('./routes/health');
const conversationsRouter = require('../backend/src/routes/conversations');
const syncRouter = require('../backend/src/routes/sync');
const eventsRouter = require('../backend/src/routes/events');
const twimlRouter = require('../backend/src/routes/twiml');
const db = require('../backend/src/db/connection');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS middleware - allow frontend origin
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:3001');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// API Routes (before static files)
app.use('/health', healthRouter);
app.use('/webhooks', webhooksRouter);
app.use('/twiml', twimlRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/sync', syncRouter);
app.use('/events', eventsRouter);

// Serve static files from React app (production only)
if (process.env.NODE_ENV === 'production') {
    const publicPath = path.join(__dirname, '../public');
    app.use(express.static(publicPath));

    // SPA fallback - serve index.html for all non-API routes
    app.use((req, res, next) => {
        // Skip API routes
        if (req.path.startsWith('/api') ||
            req.path.startsWith('/webhooks') ||
            req.path.startsWith('/health') ||
            req.path.startsWith('/zenbooker-backend')) {
            return next();
        }
        res.sendFile(path.join(publicPath, 'index.html'));
    });
} else {
    // Development: Root endpoint
    app.get('/', (req, res) => {
        res.json({
            name: 'Twilio-Front Integration Server',
            version: '1.0.0',
            status: 'running',
            endpoints: {
                health: '/health',
                webhooks_front: '/webhooks/front/channel',
                webhooks_twilio: '/webhooks/twilio/status',
                api_conversations: '/api/conversations',
                api_messages: '/api/conversations/:id/messages',
                sync_today: 'POST /api/sync/today',
                sync_recent: 'POST /api/sync/recent',
                zenbooker_health: '/zenbooker-backend/health',
                zenbooker_lookup: 'POST /zenbooker-backend/customer-lookup'
            }
        });
    });
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 Twilio-Front Integration Server running on port ${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Webhook URL: ${process.env.CALLBACK_HOSTNAME || 'http://localhost:' + PORT}`);

    // Test database connection
    const dbConnected = await db.testConnection();
    if (!dbConnected) {
        console.error('⚠️  Database connection failed!');
    }

    // Start inbox worker as background task (same process)
    // This ensures worker shares the same realtimeService singleton as the server
    const { startWorker } = require('../backend/src/services/inboxWorker');
    console.log('🔄 Starting inbox worker...');
    startWorker().catch(error => {
        console.error('❌ Worker error:', error);
    });
});

module.exports = app;
