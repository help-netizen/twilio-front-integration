require('dotenv').config();
const express = require('express');
const path = require('path');
const webhooksRouter = require('../backend/src/routes/webhooks'); // Updated to use new webhook router
const healthRouter = require('./routes/health');
const callsRouter = require('../backend/src/routes/calls');
const syncRouter = require('../backend/src/routes/sync');
const eventsRouter = require('../backend/src/routes/events');
const twimlRouter = require('../backend/src/routes/twiml');
const { tokenRouter: voiceTokenRouter, twimlRouter: voiceTwimlRouter } = require('../backend/src/routes/voice');
const phoneSettingsRouter = require('../backend/src/routes/phoneSettings');
const vapiRouter = require('../backend/src/routes/vapi');
const leadsRouter = require('../backend/src/routes/leads');
const contactsRouter = require('../backend/src/routes/contacts');
const zenbookerRouter = require('../backend/src/routes/zenbooker');
const integrationsLeadsRouter = require('../backend/src/routes/integrations-leads');
const integrationsAnalyticsRouter = require('../backend/src/routes/integrations-analytics');
const integrationsAdminRouter = require('../backend/src/routes/integrations-admin');
const leadFormSettingsRouter = require('../backend/src/routes/lead-form-settings');
const jobTagsSettingsRouter = require('../backend/src/routes/job-tags-settings');
const jobsListFieldsRouter = require('../backend/src/routes/jobs-list-fields-settings');
const usersRouter = require('../backend/src/routes/users');
const messagingRouter = require('../backend/src/routes/messaging');
const pulseRouter = require('../backend/src/routes/pulse');
const quickMessagesRouter = require('../backend/src/routes/quick-messages');
const textPolishRouter = require('../backend/src/routes/text-polish');
const fsmRouter = require('../backend/src/routes/fsm');
const noteAttachmentsRouter = require('../backend/src/routes/noteAttachments');
const authRouter = require('../backend/src/routes/auth');
const requestId = require('../backend/src/middleware/requestId');
const { authenticate, requireRole, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const { requirePermission } = require('../backend/src/middleware/authorization');
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

// Disable ETag + prevent caching on API routes
app.set('etag', false);
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// API Routes (before static files)
app.use('/health', healthRouter);
app.use('/api/time', require('../backend/src/routes/time'));
app.use('/webhooks', webhooksRouter);
app.use('/twiml', twimlRouter);
app.use('/api/voice', voiceTwimlRouter); // TwiML endpoints (Twilio-called, no auth)
app.use('/events', eventsRouter);

// Auth + tenant-scoped CRM API routes
app.use('/api/voice', authenticate, requireCompanyAccess, voiceTokenRouter); // Voice token (Keycloak-authed)
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

// Contacts API
app.use('/api/contacts', authenticate, requireCompanyAccess, contactsRouter);
app.use('/api/phone-settings', authenticate, requireCompanyAccess, phoneSettingsRouter);
app.use('/api/vapi', authenticate, requireCompanyAccess, vapiRouter);

// Telephony Admin routes
const userGroupsRouter = require('../backend/src/routes/userGroups');
const callFlowsRouter = require('../backend/src/routes/callFlows');
const phoneNumbersRouter = require('../backend/src/routes/phoneNumbers');
const telephonyOverviewRouter = require('../backend/src/routes/telephonyOverview');
app.use('/api/user-groups', authenticate, requireCompanyAccess, userGroupsRouter);
app.use('/api/call-flows', authenticate, requireCompanyAccess, callFlowsRouter);
app.use('/api/phone-numbers', authenticate, requireCompanyAccess, phoneNumbersRouter);
app.use('/api/telephony/overview', authenticate, requireCompanyAccess, telephonyOverviewRouter);

// Fast zip-code check (rely-lead-processor)
const zipCheckRouter = require('../backend/src/routes/zip-check');
app.use('/api/zip-check', authenticate, requireCompanyAccess, zipCheckRouter);

// Zenbooker scheduling proxy
const zenbookerPaymentsRouter = require('../backend/src/routes/zenbooker/payments');
const zenbookerJobsRouter = require('../backend/src/routes/zenbooker/jobs');
const localJobsRouter = require('../backend/src/routes/jobs');
app.use('/api/zenbooker/payments', authenticate, requireCompanyAccess, zenbookerPaymentsRouter);
app.use('/api/zenbooker/jobs', authenticate, requireCompanyAccess, zenbookerJobsRouter);
app.use('/api/jobs', authenticate, requireCompanyAccess, localJobsRouter);
app.use('/api/zenbooker', authenticate, requireCompanyAccess, zenbookerRouter);

// ─── PF100 Foundation Contract routes (Sprint 1 — skeleton 501 stubs) ─────
const scheduleRouter = require('../backend/src/routes/schedule');
const estimatesRouter = require('../backend/src/routes/estimates');
const invoicesRouter = require('../backend/src/routes/invoices');
const paymentsCanonicalRouter = require('../backend/src/routes/payments');
const portalRouter = require('../backend/src/routes/portal');

app.use('/api/schedule', authenticate, requireCompanyAccess, scheduleRouter);
app.use('/api/estimates', authenticate, requireCompanyAccess, estimatesRouter);
app.use('/api/invoices', authenticate, requireCompanyAccess, invoicesRouter);
app.use('/api/payments', authenticate, requireCompanyAccess, paymentsCanonicalRouter);
app.use('/api/portal', portalRouter); // public auth + portal-session auth inside router
app.use('/api/fsm', authenticate, requireCompanyAccess, fsmRouter);
app.use('/api/note-attachments', authenticate, requireCompanyAccess, noteAttachmentsRouter);

// BLANC Integrations API (secured header-based auth)
app.use('/api/v1/integrations', integrationsLeadsRouter);
app.use('/api/v1/integrations', integrationsAnalyticsRouter);
// Zenbooker integrations (webhook = unauthenticated w/ secret; create-customer/sync = Keycloak auth inside route)
const integrationsZenbookerRouter = require('../backend/src/routes/integrations-zenbooker');
app.use('/api/integrations/zenbooker', integrationsZenbookerRouter);
// Integration settings API (§15)
app.use('/api/admin/integrations', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, integrationsAdminRouter);
app.use('/api/settings/lead-form', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, leadFormSettingsRouter);
app.use('/api/settings/job-tags', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, jobTagsSettingsRouter);
app.use('/api/settings/jobs-list-fields', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, jobsListFieldsRouter);
const actionRequiredSettingsRouter = require('../backend/src/routes/action-required-settings');
app.use('/api/settings/action-required', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, actionRequiredSettingsRouter);

// Email settings + workspace (EMAIL-001)
const emailSettingsRouter = require('../backend/src/routes/email-settings');
const emailRouter = require('../backend/src/routes/email');
const emailOAuthRouter = require('../backend/src/routes/email-oauth');
app.use('/api/email/oauth', emailOAuthRouter); // public — Google redirects here
app.use('/api/settings/email', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, emailSettingsRouter);
app.use('/api/email', authenticate, requireCompanyAccess, emailRouter);
const serviceTerritoryRouter = require('../backend/src/routes/service-territories');
app.use('/api/settings/service-territories', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, serviceTerritoryRouter);

// Notification settings (GET = any user; PUT = admin-only, checked inside route)
const notificationSettingsRouter = require('../backend/src/routes/notification-settings');
app.use('/api/settings/notifications', authenticate, requireCompanyAccess, notificationSettingsRouter);

// Push subscriptions (any authenticated user manages their own)
const pushSubscriptionsRouter = require('../backend/src/routes/push-subscriptions');
app.use('/api/push-subscriptions', authenticate, requireCompanyAccess, pushSubscriptionsRouter);

// Auth contextual endpoint
app.use('/api/auth', authenticate, authRouter);

// User management API (§5, §6)
app.use('/api/users', authenticate, requirePermission('tenant.users.manage'), requireCompanyAccess, usersRouter);

// Platform Admin routes (super_admin only)
const sessionsRouter = require('../backend/src/routes/sessions');
const adminCompaniesRouter = require('../backend/src/routes/admin-companies');
const adminCompanyUsersRouter = require('../backend/src/routes/admin-company-users');
app.use('/api/admin/sessions', authenticate, requireRole('super_admin'), sessionsRouter);
app.use('/api/admin/companies', authenticate, requireRole('super_admin'), adminCompaniesRouter);
app.use('/api/admin/companies/:companyId/users', authenticate, requireRole('super_admin'), adminCompanyUsersRouter);
console.log('🔐 BLANC Integrations API enabled at /api/v1/integrations/{leads, analytics/*}');


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

    // Start daily Zenbooker jobs sync cron
    const zbSyncCron = require('../backend/src/services/zbJobsSyncCron');
    zbSyncCron.start();

    // Start email sync scheduler (EMAIL-001)
    const emailSyncService = require('../backend/src/services/emailSyncService');
    emailSyncService.startScheduler();



    // Realtime transcription (Twilio Media Streams → AssemblyAI)
    if (process.env.FEATURE_REALTIME_TRANSCRIPTION === 'true') {
        const { initMediaStreamServer } = require('../backend/src/services/mediaStreamServer');
        initMediaStreamServer(server);
        console.log('🎙️ Realtime transcription enabled at /ws/twilio-media');
    } else {
        console.log('🎙️ Realtime transcription disabled (set FEATURE_REALTIME_TRANSCRIPTION=true to enable)');
    }

    // Prevent accumulation of hung requests (e.g. when DB is unresponsive)
    server.setTimeout(15000);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Fly.dev sends SIGTERM before stopping the machine. Without this handler,
// in-flight Twilio webhook requests are killed mid-response → HTTP 502.
let shuttingDown = false;

function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — graceful shutdown started`);

    // Stop accepting new connections, finish in-flight requests
    server.close(() => {
        console.log('HTTP server closed');

        // Close database pool
        db.pool.end().then(() => {
            console.log('Database pool closed');
            process.exit(0);
        }).catch((err) => {
            console.error('Database pool close error:', err.message);
            process.exit(1);
        });
    });

    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => {
        console.error('Graceful shutdown timed out — forcing exit');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
