require('dotenv').config();
const express = require('express');
const path = require('path');
const webhooksRouter = require('../backend/src/routes/webhooks'); // Updated to use new webhook router
const healthRouter = require('./routes/health');
const callsRouter = require('../backend/src/routes/calls');
const syncRouter = require('../backend/src/routes/sync');
const eventsRouter = require('../backend/src/routes/events');
const twimlRouter = require('../backend/src/routes/twiml');
const leadsRouter = require('../backend/src/routes/leads');
const zenbookerRouter = require('../backend/src/routes/zenbooker');
const integrationsLeadsRouter = require('../backend/src/routes/integrations-leads');
const integrationsAdminRouter = require('../backend/src/routes/integrations-admin');
const leadFormSettingsRouter = require('../backend/src/routes/lead-form-settings');
const usersRouter = require('../backend/src/routes/users');
const messagingRouter = require('../backend/src/routes/messaging');
const pulseRouter = require('../backend/src/routes/pulse');
const quickMessagesRouter = require('../backend/src/routes/quick-messages');
const textPolishRouter = require('../backend/src/routes/text-polish');
const requestId = require('../backend/src/middleware/requestId');
const { authenticate, requireRole, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const db = require('../backend/src/db/connection');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS middleware - allow frontend origin
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:3001');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-BLANC-API-KEY, X-BLANC-API-SECRET');
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
app.use(requestId);

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// API Routes (before static files)
app.use('/health', healthRouter);
app.use('/webhooks', webhooksRouter);
app.use('/twiml', twimlRouter);
app.use('/events', eventsRouter);

// Auth + tenant-scoped CRM API routes
app.use('/api/calls', authenticate, requireCompanyAccess, callsRouter);
// Media proxy — no auth (browser <img src> can't send JWT; UUID provides security)
// Proxies media content through the backend to avoid CORS and expired-URL issues
app.get('/api/messaging/media/:mediaId/temporary-url', async (req, res, next) => {
    const conversationsService = require('../backend/src/services/conversationsService');
    try {
        const result = await conversationsService.getMediaTemporaryUrl(req.params.mediaId);
        if (!result.url) return res.status(404).json({ error: 'Media URL not available' });

        // Proxy: fetch from Twilio and pipe to response
        const upstream = await fetch(result.url);
        if (!upstream.ok) {
            // URL might be expired — clear cache and retry once
            console.warn(`[Media] Upstream ${upstream.status} for ${req.params.mediaId}, retrying with fresh URL`);
            const fresh = await conversationsService.getMediaTemporaryUrl(req.params.mediaId, true);
            if (!fresh.url) return res.status(404).json({ error: 'Media URL not available' });
            const retry = await fetch(fresh.url);
            if (!retry.ok) return res.status(502).json({ error: 'Upstream media fetch failed' });
            res.set('Content-Type', fresh.contentType || retry.headers.get('content-type') || 'application/octet-stream');
            res.set('Cache-Control', 'private, max-age=3600');
            const { Readable } = require('stream');
            Readable.fromWeb(retry.body).pipe(res);
            return;
        }
        res.set('Content-Type', result.contentType || upstream.headers.get('content-type') || 'application/octet-stream');
        res.set('Cache-Control', 'private, max-age=3600');
        const { Readable } = require('stream');
        Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
        console.error('[Media] proxy error:', err.message);
        res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
    }
});
app.use('/api/messaging', authenticate, requireCompanyAccess, messagingRouter);
app.use('/api/pulse', authenticate, requireCompanyAccess, pulseRouter);
app.use('/api/quick-messages', authenticate, requireCompanyAccess, quickMessagesRouter);
app.use('/api/text/polish', authenticate, requireCompanyAccess, textPolishRouter);
app.use('/api/sync', authenticate, requireCompanyAccess, syncRouter);

// Leads API (behind feature flag)
if (process.env.FEATURE_LEADS_TAB !== 'false') {
    app.use('/api/leads', authenticate, requireCompanyAccess, leadsRouter);
}

// Zenbooker scheduling proxy
const zenbookerPaymentsRouter = require('../backend/src/routes/zenbooker/payments');
app.use('/api/zenbooker/payments', authenticate, requireCompanyAccess, zenbookerPaymentsRouter);
app.use('/api/zenbooker', authenticate, requireCompanyAccess, zenbookerRouter);

// BLANC Integrations API (secured header-based auth)
app.use('/api/v1/integrations', integrationsLeadsRouter);
app.use('/api/admin/integrations', authenticate, requireRole('company_admin'), requireCompanyAccess, integrationsAdminRouter);
app.use('/api/settings/lead-form', authenticate, requireRole('company_admin'), requireCompanyAccess, leadFormSettingsRouter);

// User management API (§5, §6)
app.use('/api/users', authenticate, requireRole('company_admin'), requireCompanyAccess, usersRouter);

// Session & auth-policy management (§9, super_admin only)
const sessionsRouter = require('../backend/src/routes/sessions');
app.use('/api/admin/sessions', authenticate, requireRole('super_admin'), sessionsRouter);
console.log('🔐 BLANC Integrations API enabled at /api/v1/integrations/leads');


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
            req.path.startsWith('/twiml') ||
            req.path.startsWith('/events') ||
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
                api_calls: '/api/calls',
                api_calls_detail: '/api/calls/:callSid',
                api_calls_media: '/api/calls/:callSid/media',
                api_calls_events: '/api/calls/:callSid/events',
                api_calls_active: '/api/calls/active',
                api_calls_by_contact: '/api/calls/by-contact',
                api_sync_health: '/api/calls/health/sync',
                webhooks_voice: '/webhooks/twilio/voice-status',
                webhooks_recording: '/webhooks/twilio/recording-status',
                webhooks_transcription: '/webhooks/twilio/transcription-status',
                webhooks_inbound: '/webhooks/twilio/voice-inbound',
                webhooks_dial: '/webhooks/twilio/dial-action',
                sync_today: 'POST /api/sync/today',
                events_sse: '/events/calls'
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
const server = app.listen(PORT, '0.0.0.0', async () => {
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

    // Start transcription worker (Variant B post-call pipeline)
    if (process.env.FEATURE_TRANSCRIPTION_WORKER === 'true') {
        const { startTranscriptionWorker } = require('../backend/src/services/transcriptionWorker');
        startTranscriptionWorker().catch(error => {
            console.error('❌ Transcription worker error:', error);
        });
        console.log('🎙️ Transcription worker started');
    } else {
        console.log('🎙️ Transcription worker disabled (set FEATURE_TRANSCRIPTION_WORKER=true to enable)');
    }

    // Realtime transcription (Twilio Media Streams → AssemblyAI)
    if (process.env.FEATURE_REALTIME_TRANSCRIPTION === 'true') {
        const { initMediaStreamServer } = require('../backend/src/services/mediaStreamServer');
        initMediaStreamServer(server);
        console.log('🎙️ Realtime transcription enabled at /ws/twilio-media');
    } else {
        console.log('🎙️ Realtime transcription disabled (set FEATURE_REALTIME_TRANSCRIPTION=true to enable)');
    }
});

module.exports = app;
