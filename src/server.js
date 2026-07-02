require('dotenv').config();
const express = require('express');
const path = require('path');
const webhooksRouter = require('../backend/src/routes/webhooks'); // Updated to use new webhook router
const healthRouter = require('./routes/health');
const callsRouter = require('../backend/src/routes/calls');
const syncRouter = require('../backend/src/routes/sync');
const devicesRouter = require('../backend/src/routes/devices');
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
const marketplaceRouter = require('../backend/src/routes/marketplace');
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
const crmRouter = require('../backend/src/routes/crm');
const crmMcpRouter = require('../backend/src/routes/crmMcp');
const crmMcpPublicRouter = require('../backend/src/routes/crmMcpPublic');
const authRouter = require('../backend/src/routes/auth');
const requestId = require('../backend/src/middleware/requestId');
const { authenticate, requireRole, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const { requirePermission, requirePlatformRole } = require('../backend/src/middleware/authorization');
const db = require('../backend/src/db/connection');

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const allowLocalhostCors = process.env.NODE_ENV !== 'production' || process.env.ALLOW_LOCALHOST_CORS === 'true';

// CORS middleware - allow frontend origin
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isLocalhostOrigin = typeof origin === 'string' &&
        /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

    if (!origin || allowedOrigins.includes(origin) || (allowLocalhostCors && isLocalhostOrigin)) {
        res.header('Access-Control-Allow-Origin', origin || allowedOrigins[0] || 'http://localhost:3001');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-BLANC-API-KEY, X-BLANC-API-SECRET');
    res.header('Access-Control-Allow-Credentials', 'true');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Billing webhook (Stripe) MUST receive the raw, unparsed body for HMAC
// signature verification, so it is mounted before express.json. Path-scoped:
// every other route is unaffected and still gets parsed JSON below.
app.use('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }),
    require('../backend/src/routes/billingWebhook'));

// F018 Stripe Payments (tenant customer payments) webhook — also needs the raw
// body, mounted before express.json and SEPARATE from the platform billing webhook.
app.use('/api/stripe-payments/webhook', express.raw({ type: '*/*', limit: '1mb' }),
    require('../backend/src/routes/stripePaymentsWebhook'));

// EMAIL-TIMELINE-001 (TASK-ET-5): Gmail Pub/Sub inbound push. UNAUTHENTICATED by
// user (Pub/Sub can't carry our JWT) — token/OIDC verification happens inside the
// route. Mounted with the RAW body BEFORE express.json (mirrors the Stripe webhooks
// above) so verification + JSON parse run on the unmodified payload.
app.use('/api/email/push', express.raw({ type: '*/*', limit: '1mb' }),
    require('../backend/src/routes/emailPush'));

// Middleware
// 2mb limit covers document-template descriptors that may embed a base64 logo
// (logo_url.maxLength = 500_000 chars ≈ 370KB + descriptor JSON overhead).
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
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
app.use('/api/devices', authenticate, requireCompanyAccess, devicesRouter);

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
const telephonyProviderRouter = require('../backend/src/routes/telephonyProvider');
app.use('/api/user-groups', authenticate, requireCompanyAccess, userGroupsRouter);
app.use('/api/call-flows', authenticate, requireCompanyAccess, callFlowsRouter);
app.use('/api/phone-numbers', authenticate, requireCompanyAccess, phoneNumbersRouter);
app.use('/api/telephony/overview', authenticate, requireCompanyAccess, telephonyOverviewRouter);
app.use('/api/telephony/provider', authenticate, requireCompanyAccess, telephonyProviderRouter);
// ALB-107: tenant phone-number management (Twilio subaccount per company)
const telephonyNumbersRouter = require('../backend/src/routes/telephonyNumbers');
app.use('/api/telephony/numbers', authenticate, requirePermission('tenant.telephony.manage'), requireCompanyAccess, telephonyNumbersRouter);
// ADR-001: automation rules (rules-engine editor) + platform billing
const automationRulesRouter = require('../backend/src/routes/automationRules');
app.use('/api/automation', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, automationRulesRouter);
const billingRouter = require('../backend/src/routes/billing');
app.use('/api/billing', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, billingRouter);

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

// TASKS-001 — cross-entity tasks (per-route requirePermission inside the router).
app.use('/api/tasks', authenticate, requireCompanyAccess, require('../backend/src/routes/tasks'));

// ─── PF100 Foundation Contract routes (Sprint 1 — skeleton 501 stubs) ─────
const scheduleRouter = require('../backend/src/routes/schedule');
const estimatesRouter = require('../backend/src/routes/estimates');
const invoicesRouter = require('../backend/src/routes/invoices');
const paymentsCanonicalRouter = require('../backend/src/routes/payments');
const portalRouter = require('../backend/src/routes/portal');

app.use('/api/schedule', authenticate, requireCompanyAccess, scheduleRouter);
app.use('/api/estimates', authenticate, requireCompanyAccess, estimatesRouter);
const estimateItemPresetsRouter = require('../backend/src/routes/estimate-item-presets');
app.use('/api/estimate-item-presets', authenticate, requireCompanyAccess, estimateItemPresetsRouter);
// PRICEBOOK-001: Price Book management API (categories/groups/items).
const priceBookRouter = require('../backend/src/routes/price-book');
app.use('/api/price-book', authenticate, requireCompanyAccess, priceBookRouter);
// VAPI Tool Call Handler — public endpoint, secured by x-vapi-secret header
const vapiToolsRouter = require('../backend/src/routes/vapi-tools');
app.use('/api/vapi-tools', vapiToolsRouter);

// Public, un-authenticated invoice routes (tokenized PDF for "send" links).
// Must be mounted BEFORE the authenticated /api/invoices route so the auth
// middleware doesn't intercept /api/public/* requests.
const publicInvoicesRouter = require('../backend/src/routes/public-invoices');
app.use('/api/public', publicInvoicesRouter);
// Public, un-authenticated estimate routes (tokenized view JSON + PDF for "send" links).
const publicEstimatesRouter = require('../backend/src/routes/public-estimates');
app.use('/api/public', publicEstimatesRouter);
// ALB-101: self-registration surface (rate-limited, no auth, no tenant data)
const publicAuthRouter = require('../backend/src/routes/publicAuth');
app.use('/api/public', publicAuthRouter);
// Top-level short-link redirect (e.g. /i/abc123 → /api/public/invoices/abc123/pdf).
app.use('/', publicInvoicesRouter.shortRouter);
app.use('/', publicEstimatesRouter.shortRouter);
app.use('/api/invoices', authenticate, requireCompanyAccess, invoicesRouter);
app.use('/api/payments', authenticate, requireCompanyAccess, paymentsCanonicalRouter);
app.use('/api/portal', portalRouter); // public auth + portal-session auth inside router
app.use('/api/fsm', authenticate, requireCompanyAccess, fsmRouter);
app.use('/api/note-attachments', authenticate, requireCompanyAccess, noteAttachmentsRouter);
app.use('/api/crm', authenticate, requireCompanyAccess, crmRouter);
app.use('/api/crm/mcp', authenticate, requireCompanyAccess, crmMcpRouter);
app.use('/mcp/crm', crmMcpPublicRouter);

// BLANC Integrations API (secured header-based auth)
app.use('/api/v1/integrations', integrationsLeadsRouter);
app.use('/api/v1/integrations', integrationsAnalyticsRouter);
// Zenbooker integrations (webhook = unauthenticated w/ secret; create-customer/sync = Keycloak auth inside route)
const integrationsZenbookerRouter = require('../backend/src/routes/integrations-zenbooker');
app.use('/api/integrations/zenbooker', integrationsZenbookerRouter);
// Integration settings API (§15)
app.use('/api/admin/integrations', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, integrationsAdminRouter);
app.use('/api/marketplace', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, marketplaceRouter);
// F018 Stripe Payments settings/onboarding (the /webhook subpath is mounted earlier,
// before express.json, so it is unaffected by this authed mount).
app.use('/api/stripe-payments', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess,
    require('../backend/src/routes/stripePayments'));
// F018 Phase 4: Terminal / Tap to Pay backend (per-route permission gating inside).
app.use('/api/stripe-terminal', authenticate, requireCompanyAccess,
    require('../backend/src/routes/stripeTerminal'));
// Technician display profiles (photo/name) for the public payment page.
app.use('/api/settings/technicians', authenticate, requireCompanyAccess,
    require('../backend/src/routes/technicians'));
// COMPANY-PROFILE-001: tenant-facing company identity + branding (brand source for invoice/estimate PDFs).
app.use('/api/settings/company-profile', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess,
    require('../backend/src/routes/companyProfile'));
// RBAC-ROLES-EDITOR-001: in-app Roles & Access editor (role matrix + per-member overrides).
app.use('/api/settings/roles', authenticate, requireCompanyAccess, requirePermission('tenant.roles.manage'),
    require('../backend/src/routes/rolesPermissions'));
// Technician base (home) locations for the slot engine (SLOT-ENGINE-001 Phase 2).
app.use('/api/settings/technician-base-locations', authenticate, requireCompanyAccess,
    require('../backend/src/routes/technicianBaseLocations'));
// Per-company recommendation settings for the slot engine (REC-SETTINGS-001).
app.use('/api/settings/slot-engine-settings', authenticate, requireCompanyAccess,
    require('../backend/src/routes/slotEngineSettings'));
// F015: Document templates customization (estimates first; designed to extend to invoice/work_order)
require('../backend/src/services/documentTemplates'); // bootstrap renderer registry
const documentTemplatesRouter = require('../backend/src/routes/document-templates');
// P0 reuses tenant.integrations.manage (admin-only) until a dedicated tenant.documents.manage permission is seeded.
app.use('/api/document-templates', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, documentTemplatesRouter);
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
// Outbound email from the contact timeline (EMAIL-TIMELINE-001, TASK-ET-8) — mounted
// before the broader /api/email so the more-specific prefix matches first.
const emailTimelineRouter = require('../backend/src/routes/emailTimeline');
app.use('/api/email/timeline', authenticate, requireCompanyAccess, emailTimelineRouter);
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
// ALB-101: login 2FA (OTP + trusted devices)
const authDeviceRouter = require('../backend/src/routes/authDevice');
app.use('/api/auth', authenticate, authDeviceRouter);
// ALB-101: company onboarding (authenticated, pre-tenant)
const onboardingRouter = require('../backend/src/routes/onboarding');
app.use('/api/onboarding', authenticate, onboardingRouter);
// ALB-102: platform companies (platform super admin only)
const platformCompaniesRouter = require('../backend/src/routes/platformCompanies');
app.use('/api/platform/companies', authenticate, requirePlatformRole('super_admin'), platformCompaniesRouter);

// User management API (§5, §6)
app.use('/api/users', authenticate, requirePermission('tenant.users.manage'), requireCompanyAccess, usersRouter);

// Platform Admin routes (super_admin only)
const sessionsRouter = require('../backend/src/routes/sessions');
const adminCompaniesRouter = require('../backend/src/routes/admin-companies');
const adminCompanyUsersRouter = require('../backend/src/routes/admin-company-users');
app.use('/api/admin/sessions', authenticate, requirePlatformRole('super_admin'), sessionsRouter);
app.use('/api/admin/companies', authenticate, requirePlatformRole('super_admin'), adminCompaniesRouter);
app.use('/api/admin/companies/:companyId/users', authenticate, requirePlatformRole('super_admin'), adminCompanyUsersRouter);
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

    // ADR-001: wire event-bus subscribers (rules engine, billing meter)
    require('../backend/src/services/eventSubscribers').registerSubscribers();

    // AUTO-001: agent task worker (executes kind=agent tasks)
    require('../backend/src/services/agentWorker').startWorker();

    // ADR-001: rules-engine scheduler tick (timer-triggered + delayed rules)
    const rulesEngine = require('../backend/src/services/rulesEngine');
    setInterval(() => {
        rulesEngine.tickScheduler().catch(e => console.error('[rulesEngine] tick error:', e.message));
    }, 60 * 1000);
    console.log('⚙️  Rules engine scheduler started (60s tick)');

    // BILLING: monthly usage-overage billing (in arrears, dormant w/o Stripe key)
    require('../backend/src/services/overageScheduler').start();

    // SCHED-ROUTE-001 (C-13): daily retention — purge stale segments + prune route cache
    require('../backend/src/services/routeRetentionScheduler').start();

    // NOTE-ATTACH-UPLOAD-001: sweep abandoned staged note attachments (6h tick)
    require('../backend/src/services/stagedAttachmentCleanupScheduler').start();

    // Start daily Zenbooker jobs sync cron
    const zbSyncCron = require('../backend/src/services/zbJobsSyncCron');
    zbSyncCron.start();

    // Start email sync scheduler (EMAIL-001)
    const emailSyncService = require('../backend/src/services/emailSyncService');
    emailSyncService.startScheduler();

    // ── EMAIL-TIMELINE-001 (TASK-ET-6): Gmail watch-renewal scheduler ──────────
    // Sibling of the EMAIL-001 poll scheduler above. Every ~12h, re-arm Gmail
    // `users.watch` for connected mailboxes whose watch is null or expiring within
    // 48h (Gmail watches expire ≤7 days). Entirely guarded: if GMAIL_PUBSUB_TOPIC
    // is unset (Pub/Sub not provisioned) we skip — the 5-min poll covers inbound.
    // renewWatch is itself safe-fail; per-mailbox + overall try/catch keep one bad
    // mailbox (or a missing topic) from ever crashing the tick or boot.
    if (process.env.GMAIL_PUBSUB_TOPIC) {
        const emailQueries = require('../backend/src/db/emailQueries');
        const providerRegistry = require('../backend/src/services/mail/providerRegistry');
        const WATCH_RENEW_INTERVAL_MS = parseInt(process.env.GMAIL_WATCH_RENEW_INTERVAL_MS, 10) || 43200000; // 12h
        const renewWatches = async () => {
            try {
                const mailboxes = await emailQueries.listMailboxesForWatchRenewal();
                for (const mb of mailboxes) {
                    try {
                        await providerRegistry.get(mb.company_id).renewWatch(mb.company_id);
                    } catch (mbErr) {
                        console.error(`[emailWatchScheduler] renewWatch failed for company ${mb.company_id}:`, mbErr.message);
                    }
                }
            } catch (err) {
                console.error('[emailWatchScheduler] tick error:', err.message);
            }
        };
        setInterval(renewWatches, WATCH_RENEW_INTERVAL_MS);
        console.log(`📧 Gmail watch-renewal scheduler started (${Math.round(WATCH_RENEW_INTERVAL_MS / 3600000)}h tick)`);
    } else {
        console.log('📧 Gmail watch-renewal scheduler skipped (GMAIL_PUBSUB_TOPIC unset)');
    }

    // ── EMAIL-TIMELINE-001 (TASK-ET-4): inbound-link reconciliation poll ───────
    // Sibling of the EMAIL-001 sync scheduler above (additive — does NOT touch
    // emailSyncService). Same cadence (EMAIL_SYNC_INTERVAL_MS, default 5 min): the
    // EMAIL-001 sync imports INBOX rows; this tick scans each connected company's
    // recently-imported, not-yet-linked INBOUND rows and links them onto the
    // contact timeline (recovers any dropped/failed push, idempotently). NOT gated
    // on Pub/Sub — this is the reconciliation path that works without push.
    // Wholly guarded so a bad mailbox or DB error never crashes the tick or boot.
    // Reuse the EMAIL-001 cadence constant (emailSyncService.SYNC_INTERVAL_MS) so the
    // two schedulers stay in lockstep instead of duplicating the 5-min default here.
    const EMAIL_TIMELINE_POLL_MS = emailSyncService.SYNC_INTERVAL_MS;
    const emailTimelineService = require('../backend/src/services/email/emailTimelineService');
    const emailTimelineQueries = require('../backend/src/db/emailQueries');
    const runTimelineLinkPoll = async () => {
        try {
            const mailboxes = await emailTimelineQueries.listConnectedMailboxes();
            for (const mb of mailboxes) {
                try {
                    await emailTimelineService.ingestPolledForCompany(mb.company_id);
                } catch (mbErr) {
                    console.error(`[EmailTimeline] poll failed for company ${mb.company_id}:`, mbErr.message);
                }
            }
        } catch (err) {
            console.error('[EmailTimeline] poll tick error:', err.message);
        }
    };
    setInterval(runTimelineLinkPoll, EMAIL_TIMELINE_POLL_MS);
    console.log(`📨 Email-timeline link poll started, interval: ${EMAIL_TIMELINE_POLL_MS}ms`);

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
