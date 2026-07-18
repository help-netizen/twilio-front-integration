/**
 * ALB-105 / TENANCY-RBAC-GUARD-001 — tenant-safety sanitizer.
 *
 * Static guardrails for both sides of tenant enforcement:
 *   1. tenant context comes from req.companyFilter, never legacy/user fields;
 *   2. tenant identifiers are parameterized in SQL;
 *   3. tenant-owned writes and natural-key lookups use company_id;
 *   4. non-request workers do not perform unscoped tenant writes; and
 *   5. backend route handlers have an inline, router-level, or mount-level RBAC gate.
 *
 * A statement exception must use a preceding/same-line comment in this form:
 *   // tenant-safety-allow R-write-scope: <one-line reason>
 * Existing route debt is recorded by exact route signature in
 * ROUTE_PERMISSION_BASELINE so newly added ungated routes still fail.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
    'backend/src/routes',
    'backend/src/db',
    'backend/src/services',
    'backend/src/cli',
    'backend/src/scripts',
    'backend/src/webhooks',
];

// Auth plumbing is the only legitimate source-level req.user company reference.
const FILE_ALLOWLIST = new Set([
    'backend/src/middleware/keycloakAuth.js',
]);

const LINE_RULES = [
    {
        id: 'req-user-company-id',
        re: /req\.user\??\.company_id/,
        what: 'route reads tenant context from req.user.company_id',
        why: 'the authenticated identity is not the selected tenant and can cross tenant boundaries',
        fix: 'use req.companyFilter?.company_id',
        appliesTo: (file) => file.includes('backend/src/routes/'),
    },
    {
        id: 'req-companyId-legacy',
        re: /req\.companyId\b/,
        what: 'route reads the removed req.companyId field',
        why: 'the field is undefined since PF007 and can silently remove tenant scoping',
        fix: 'use req.companyFilter?.company_id',
        appliesTo: (file) => file.includes('backend/src/routes/'),
    },
    {
        id: 'sql-interpolation',
        re: /\$\{[^}]*(company_?id|companyId)[^}]*\}/i,
        what: 'SQL text interpolates a company identifier',
        why: 'interpolation can bypass parameterization and tenant-scope review',
        fix: 'bind the company identifier as a query parameter',
        appliesTo: () => true,
        lineFilter: (line) => /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE|FROM|VALUES|JOIN)\b/.test(line)
            && !line.includes('http') && !line.includes('console.'),
    },
];

// High-risk domain tables. The list is deliberately narrow: false positives make
// this guard unusable, while R-natural-key covers the owner's broader incident class.
const TENANT_WRITE_TABLES = new Set([
    'calls',
    'contacts',
    'email_messages',
    'email_threads',
    'jobs',
    'leads',
    'sms_conversations',
    'sms_messages',
    'tasks',
    'timelines',
]);

const NATURAL_KEY_RE = /(?:\b(?:phone(?:_e164|_number)?|email|external_id|sid|uuid|token)\b|\b[a-z][a-z0-9_]*(?:_sid|_uuid|_token)\b)\s*(?:=|IN\b|=\s*ANY\b)/i;
const HIGH_COLLISION_KEY_RE = /\b(?:phone(?:_e164|_number)?|email|external_id)\b\s*(?:=|IN\b|=\s*ANY\b)/i;
const NON_REQUEST_FILE_RE = /backend\/src\/(?:cli|scripts|webhooks)\/|backend\/src\/services\/[^/]*(?:worker|scheduler|processor|reconcile)[^/]*\.js$/i;

// Exact, reviewed statement exceptions. Key format: rule:file:line.
const SQL_ALLOWLIST = new Map([
    ['R-write-scope:backend/src/routes/calls.js:337', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/contacts.js:426', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/contacts.js:702', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/integrations-leads.js:101', 'Pre-existing integration write scoped only by entity id; remediation deferred.'],
    ['R-write-scope:backend/src/routes/integrations-leads.js:126', 'Pre-existing integration write scoped only by entity id; remediation deferred.'],
    ['R-write-scope:backend/src/routes/jobs.js:693', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/jobs.js:710', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/leads.js:273', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/leads.js:311', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/leads.js:377', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/leads.js:440', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/leads.js:466', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/leads.js:586', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-write-scope:backend/src/routes/leads.js:639', 'Pre-existing lead UUID write lacks company_id; remediation deferred.'],
    ['R-write-scope:backend/src/routes/pulse.js:889', 'Pre-existing unscoped route write; remediation deferred to the post-audit triage.'],
    ['R-natural-key:backend/src/routes/calls.js:660', 'Pre-existing transcript delete uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/routes/leads.js:639', 'Pre-existing lead write uses only UUID; remediation deferred.'],
    ['R-natural-key:backend/src/db/conversationsQueries.js:247', 'Pre-existing message update uses only Twilio message SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/callAvailability.js:56', 'Pre-existing call update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/inboxWorker.js:459', 'Pre-existing worker update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/inboxWorker.js:474', 'Pre-existing worker update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/inboxWorker.js:540', 'Pre-existing worker update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/inboxWorker.js:556', 'Pre-existing worker update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/inboxWorker.js:564', 'Pre-existing worker update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/inboxWorker.js:680', 'Pre-existing worker update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/inboxWorker.js:752', 'Pre-existing worker update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/inboxWorker.js:847', 'Pre-existing worker update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/jobSyncService.js:142', 'Pre-existing job-sync write uses only lead UUID; remediation deferred.'],
    ['R-natural-key:backend/src/services/otpService.js:106', 'Signup/login OTP records are intentionally pre-tenant and have no company_id.'],
    ['R-natural-key:backend/src/services/outboundLeadCallService.js:815', 'Known phone-keyed cross-tenant action risk; explicitly retained for Step 2 triage.'],
    ['R-natural-key:backend/src/services/reconcileStale.js:129', 'Pre-existing reconciler update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/reconcileStale.js:194', 'Pre-existing reconciler update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/reconcileStale.js:213', 'Pre-existing reconciler update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/reconcileStale.js:250', 'Pre-existing reconciler update uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/services/transcriptionService.js:208', 'Pre-existing transcript cleanup uses only Twilio call SID; remediation deferred.'],
    ['R-natural-key:backend/src/cli/backfillContacts.js:82', 'One-time global backfill intentionally spans tenants; production remediation is deferred.'],
    ['R-no-request-context:backend/src/services/inboxWorker.js:459', 'Pre-existing worker write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/inboxWorker.js:474', 'Pre-existing worker write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/inboxWorker.js:540', 'Pre-existing worker write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/inboxWorker.js:556', 'Pre-existing worker write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/inboxWorker.js:564', 'Pre-existing worker write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/inboxWorker.js:680', 'Pre-existing worker write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/inboxWorker.js:752', 'Pre-existing worker write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/inboxWorker.js:847', 'Pre-existing worker write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/reconcileStale.js:129', 'Pre-existing reconciler write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/reconcileStale.js:194', 'Pre-existing reconciler write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/reconcileStale.js:213', 'Pre-existing reconciler write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/services/reconcileStale.js:250', 'Pre-existing reconciler write lacks explicit companyId; remediation deferred.'],
    ['R-no-request-context:backend/src/cli/backfillContacts.js:82', 'One-time global backfill intentionally spans tenants; production remediation is deferred.'],
]);

// Public/machine-to-machine routers are not user-RBAC surfaces. Each entry states
// the compensating control; routes lacking one stay in the audited gap baseline.
const PUBLIC_ROUTE_FILES = new Map([
    ['backend/src/routes/agentSkillsMcpPublic.js', 'Disabled by default; timing-safe bearer token and env-bound company context.'],
    ['backend/src/routes/auth.js', 'Authenticated role-neutral self-context endpoint; returns only the caller context.'],
    ['backend/src/routes/authDevice.js', 'Authenticated role-neutral 2FA/trusted-device flow for the current caller.'],
    ['backend/src/routes/billingWebhook.js', 'Stripe HMAC signature is verified before webhook processing.'],
    ['backend/src/routes/crmMcpPublic.js', 'Disabled by default; timing-safe bearer token, env-bound tenant/user, and writes off by default.'],
    ['backend/src/routes/devices.js', 'Authenticated role-neutral device self-service scoped to caller, company, and token.'],
    ['backend/src/routes/email-oauth.js', 'Public OAuth callback validates signed, expiring state before binding a mailbox.'],
    ['backend/src/routes/emailPush.js', 'Google push verifies a shared token or OIDC JWT before processing.'],
    ['backend/src/routes/feedback.js', 'Authenticated role-neutral feedback submission scoped to the caller company.'],
    ['backend/src/routes/integrations-analytics.js', 'Machine API uses integration credentials, header validation, and rate limiting.'],
    ['backend/src/routes/integrations-leads.js', 'Machine API uses integration credentials, header validation, and rate limiting.'],
    ['backend/src/routes/public-estimates.js', 'Customer send-link surface uses validated opaque public tokens.'],
    ['backend/src/routes/public-invoices.js', 'Customer send/pay-link surface uses validated opaque public tokens.'],
    ['backend/src/routes/public-rate.js', 'Public rating surface uses opaque tokens, host binding, and IP rate limits.'],
    ['backend/src/routes/publicAuth.js', 'Pre-auth signup/OTP/places surface uses kill switches and per-IP rate limits.'],
    ['backend/src/routes/push-subscriptions.js', 'Authenticated role-neutral subscription self-service is scoped to the current user.'],
    ['backend/src/routes/stripePaymentsWebhook.js', 'Stripe HMAC signature is verified before webhook processing.'],
    ['backend/src/routes/time.js', 'Public clock endpoint returns no tenant or user data.'],
    ['backend/src/routes/vapi-tools.js', 'Fail-closed x-vapi-secret middleware protects the machine endpoint.'],
    ['backend/src/routes/vapiCallStatus.js', 'Fail-closed x-vapi-secret middleware protects the machine webhook.'],
    ['backend/src/routes/webhooks.js', 'Twilio callback/health surface is public by design; missing/fail-open signature cases are flagged in the audit.'],
    ['backend/src/routes/zip-check.js', 'Authenticated role-neutral service-area lookup is scoped by the selected company.'],
]);

// Route-specific legitimate exceptions for mixed public/authenticated routers.
const ROUTE_PERMISSION_EXCEPTIONS = new Map([
    ['backend/src/routes/events.js:router:GET:/stats', 'Public operational counters endpoint; no tenant records returned (audit flags absent rate/host gate).'],
    ['backend/src/routes/integrations-zenbooker.js:router:POST:/webhooks', 'Zenbooker legacy callback is public by design (audit flags optional-secret fail-open behavior).'],
    ['backend/src/routes/integrations-zenbooker.js:router:POST:/wh/:key', 'Zenbooker callback derives tenant from a minimum-32-character opaque URL key.'],
    ['backend/src/routes/notification-settings.js:router:GET:/', 'Authenticated role-neutral settings read; mutation has tenant.company.manage inline.'],
    ['backend/src/routes/onboarding.js:router:POST:/', 'Authenticated pre-tenant bootstrap requires signup enabled, no membership, and a verified OTP.'],
    ['backend/src/routes/onboarding.js:router:GET:/status', 'Authenticated pre-tenant self-status lookup uses the caller CRM user id.'],
    ['backend/src/routes/onboarding.js:router:GET:/checklist', 'Route-local requireTenantAdmin middleware gates this tenant checklist.'],
    ['backend/src/routes/portal.js:router:POST:/auth/request-access', 'Public portal entrypoint is token workflow by design (audit flags missing proof/rate control).'],
    ['backend/src/routes/portal.js:router:POST:/auth/verify', 'Public portal verification exchanges an opaque expiring token for a scoped session.'],
    ['backend/src/routes/portal.js:router:GET:/session', 'Portal-session middleware validates the bearer session.'],
    ['backend/src/routes/portal.js:router:GET:/documents', 'Portal-session middleware scopes client documents.'],
    ['backend/src/routes/portal.js:router:GET:/documents/:type/:id', 'Portal-session middleware scopes the requested document.'],
    ['backend/src/routes/portal.js:router:POST:/documents/:type/:id/accept', 'Portal-session middleware scopes the document action.'],
    ['backend/src/routes/portal.js:router:POST:/documents/:type/:id/decline', 'Portal-session middleware scopes the document action.'],
    ['backend/src/routes/portal.js:router:POST:/payments', 'Portal-session middleware scopes client payment submission.'],
    ['backend/src/routes/portal.js:router:GET:/payments/history', 'Portal-session middleware scopes client payment history.'],
    ['backend/src/routes/portal.js:router:GET:/bookings', 'Portal-session middleware scopes client bookings.'],
    ['backend/src/routes/portal.js:router:GET:/profile', 'Portal-session middleware scopes the client profile.'],
    ['backend/src/routes/portal.js:router:PATCH:/profile', 'Portal-session middleware scopes the client profile update.'],
    ['backend/src/routes/schedule.js:router:GET:/availability', 'Authenticated placeholder returns only 501 NOT_IMPLEMENTED and no data.'],
    ['backend/src/routes/text-polish.js:router:GET:/health', 'Authenticated health endpoint returns static service/version data only.'],
    ['backend/src/routes/twiml.js:router:POST:/voice', 'Twilio-called TwiML endpoint is public by design (audit flags absent signature validation).'],
    ['backend/src/routes/userGroups.js:router:GET:/my', 'Authenticated role-neutral self lookup returns only the current user groups.'],
    ['backend/src/routes/voice.js:twimlRouter:POST:/twiml/outbound', 'Twilio-called TwiML endpoint is public by design (audit flags absent signature validation).'],
    ['backend/src/routes/voice.js:twimlRouter:POST:/twiml/inbound', 'Twilio-called TwiML endpoint is public by design (audit flags absent signature validation).'],
    ['src/server.js:app:GET:/api/messaging/media/:mediaId/temporary-url', 'Public media proxy uses an opaque UUID (audit flags this as a weak sole control).'],
]);

// Exact known gaps from TENANCY-RBAC-AUDIT-001. This is a regression baseline,
// not approval of the gap: new signatures are rejected until explicitly triaged.
const ROUTE_PERMISSION_BASELINE = new Map([
    ['backend/src/routes/agentSkillsMcp.js:router:GET:/tools', 'Known gap; suggest contacts.view pending a dedicated service-CRM read permission.'],
    ['backend/src/routes/agentSkillsMcp.js:router:POST:/call', 'Known gap; suggest contacts.view transport floor plus existing per-tool write checks.'],
    ['backend/src/routes/agentSkillsMcp.js:router:POST:/jsonrpc', 'Known gap; suggest contacts.view transport floor plus existing per-tool write checks.'],
    ['backend/src/routes/assistant.js:router:POST:/chat', 'Known gap; suggest dashboard.view.'],
    ['backend/src/routes/crm.js:router:GET:/accounts/stale', 'Known gap; suggest contacts.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/accounts/:id/key-contacts', 'Known gap; suggest contacts.view.'],
    ['backend/src/routes/crm.js:router:GET:/accounts/:id', 'Known gap; suggest contacts.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/accounts', 'Known gap; suggest contacts.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/contacts/:id', 'Known gap; suggest contacts.view.'],
    ['backend/src/routes/crm.js:router:GET:/contacts', 'Known gap; suggest contacts.view.'],
    ['backend/src/routes/crm.js:router:GET:/deals/attention', 'Known gap; suggest leads.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/deals/:id', 'Known gap; suggest leads.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/deals', 'Known gap; suggest leads.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/pipeline', 'Known gap; suggest leads.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/activities', 'Known gap; suggest contacts.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/tasks', 'Known gap; suggest tasks.view.'],
    ['backend/src/routes/crm.js:router:GET:/notes', 'Known gap; suggest contacts.view.'],
    ['backend/src/routes/crm.js:router:GET:/metadata', 'Known gap; suggest contacts.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crm.js:router:GET:/lists/:listKey', 'Known gap; suggest contacts.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crmMcp.js:router:GET:/tools', 'Known gap; suggest contacts.view pending a catalog CRM-read permission.'],
    ['backend/src/routes/crmMcp.js:router:POST:/call', 'Known gap; suggest contacts.view transport floor plus existing per-tool write checks.'],
    ['backend/src/routes/crmMcp.js:router:POST:/jsonrpc', 'Known gap; suggest contacts.view transport floor plus existing per-tool write checks.'],
    ['backend/src/routes/estimate-item-presets.js:router:GET:/', 'Known gap; suggest price_book.view.'],
    ['backend/src/routes/estimate-item-presets.js:router:POST:/', 'Known gap; suggest price_book.manage.'],
    ['backend/src/routes/estimate-item-presets.js:router:PATCH:/:id', 'Known gap; suggest price_book.manage.'],
    ['backend/src/routes/estimate-item-presets.js:router:DELETE:/:id', 'Known gap; suggest price_book.manage.'],
    ['backend/src/routes/estimate-item-presets.js:router:POST:/:id/used', 'Known gap; suggest price_book.view.'],
    ['backend/src/routes/events.js:router:GET:/calls', 'Known gap; suggest reports.calls.view or pulse.view.'],
    ['backend/src/routes/integrations-zenbooker.js:router:GET:/webhook-url', 'Known gap; suggest tenant.integrations.manage.'],
    ['backend/src/routes/integrations-zenbooker.js:router:POST:/webhook-url/regenerate', 'Known gap; suggest tenant.integrations.manage.'],
    ['backend/src/routes/integrations-zenbooker.js:router:POST:/contacts/:contactId/create-customer', 'Known gap; suggest contacts.edit.'],
    ['backend/src/routes/integrations-zenbooker.js:router:POST:/contacts/:contactId/sync', 'Known gap; suggest contacts.edit.'],
    ['backend/src/routes/integrations-zenbooker.js:router:GET:/jobs', 'Known gap; suggest jobs.view.'],
    ['backend/src/routes/integrations-zenbooker.js:router:GET:/api-key', 'Known gap; suggest tenant.integrations.manage.'],
    ['backend/src/routes/integrations-zenbooker.js:router:PUT:/api-key', 'Known gap; suggest tenant.integrations.manage.'],
    ['backend/src/routes/noteAttachments.js:router:POST:/upload', 'Known gap; suggest jobs.edit, leads.edit, or contacts.edit by entity type.'],
    ['backend/src/routes/noteAttachments.js:router:GET:/:id/url', 'Known gap; suggest jobs.view, leads.view, or contacts.view by entity type.'],
    ['backend/src/routes/noteAttachments.js:router:DELETE:/:id', 'Known gap; suggest jobs.edit, leads.edit, or contacts.edit by entity type.'],
    ['backend/src/routes/portal.js:router:GET:/links', 'Known gap; suggest contacts.view plus estimates.send/invoices.send by scope.'],
    ['backend/src/routes/sync.js:router:POST:/today', 'Known gap; suggest tenant.integrations.manage.'],
    ['backend/src/routes/sync.js:router:POST:/recent', 'Known gap; suggest tenant.integrations.manage.'],
    ['backend/src/routes/telephonyProvider.js:router:GET:/autonomous-mode', 'Known gap; suggest tenant.telephony.manage.'],
    ['backend/src/routes/voice.js:tokenRouter:GET:/token', 'Known gap; suggest phone_calls.use.'],
    ['backend/src/routes/voice.js:tokenRouter:GET:/phone-access', 'Known gap; suggest phone_calls.use.'],
    ['backend/src/routes/voice.js:tokenRouter:POST:/presence', 'Known gap; suggest phone_calls.use.'],
    ['backend/src/routes/voice.js:tokenRouter:GET:/check-busy', 'Known gap; suggest phone_calls.use.'],
    ['backend/src/routes/voice.js:tokenRouter:GET:/blanc-numbers', 'Known gap; suggest phone_calls.use.'],
    ['backend/src/routes/zenbooker/jobs.js:router:GET:/', 'Known gap; suggest jobs.view.'],
    ['backend/src/routes/zenbooker/jobs.js:router:GET:/:id', 'Known gap; suggest jobs.view.'],
    ['backend/src/routes/zenbooker/jobs.js:router:POST:/:id/cancel', 'Known gap; suggest jobs.close.'],
    ['backend/src/routes/zenbooker/jobs.js:router:POST:/:id/reschedule', 'Known gap; suggest jobs.edit.'],
    ['backend/src/routes/zenbooker/jobs.js:router:POST:/:id/assign', 'Known gap; suggest jobs.assign.'],
    ['backend/src/routes/zenbooker/jobs.js:router:POST:/:id/notes', 'Known gap; suggest jobs.edit.'],
    ['backend/src/routes/zenbooker/jobs.js:router:POST:/:id/enroute', 'Known gap; suggest jobs.edit.'],
    ['backend/src/routes/zenbooker/jobs.js:router:POST:/:id/start', 'Known gap; suggest jobs.edit.'],
    ['backend/src/routes/zenbooker/jobs.js:router:POST:/:id/complete', 'Known gap; suggest jobs.close.'],
    ['backend/src/routes/zenbooker/payments.js:router:POST:/sync', 'Known gap; suggest tenant.integrations.manage.'],
    ['backend/src/routes/zenbooker/payments.js:router:GET:/export', 'Known gap; suggest payments.view.'],
    ['backend/src/routes/zenbooker/payments.js:router:GET:/', 'Known gap; suggest payments.view.'],
    ['backend/src/routes/zenbooker/payments.js:router:GET:/:id', 'Known gap; suggest payments.view.'],
    ['backend/src/routes/zenbooker/payments.js:router:PATCH:/:id', 'Known gap; suggest payments.collect_offline.'],
    ['backend/src/routes/zenbooker.js:router:GET:/service-area-check', 'Known gap; suggest schedule.view.'],
    ['backend/src/routes/zenbooker.js:router:GET:/timeslots', 'Known gap; suggest schedule.view.'],
    ['backend/src/routes/zenbooker.js:router:GET:/services', 'Known gap; suggest schedule.view.'],
]);

function normalize(file) {
    return file.replace(/\\/g, '/');
}

function listJsFiles(dir) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listJsFiles(rel));
        else if (entry.name.endsWith('.js')) out.push(normalize(rel));
    }
    return out;
}

function lineNumberAt(source, index) {
    return source.slice(0, index).split('\n').length;
}

function allowedByComment(source, line, ruleId) {
    const lines = source.split('\n');
    const candidates = [lines[line - 2], lines[line - 1]].filter(Boolean);
    return candidates.some(candidate => {
        const marker = candidate.match(/tenant-safety-allow(?:\s+([\w-]+))?\s*:\s*(\S.*)$/);
        return marker && (!marker[1] || marker[1] === ruleId) && marker[2].trim().length > 0;
    });
}

function extractSqlStatements(source) {
    const statements = [];
    const literalRe = /`(?:\\[\s\S]|[^`])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;
    let match;
    while ((match = literalRe.exec(source)) !== null) {
        const sql = match[0].slice(1, -1);
        if (!/\b(?:SELECT|UPDATE|DELETE\s+FROM)\b/i.test(sql)) continue;
        let offset = 0;
        for (const part of sql.split(';')) {
            const leading = part.search(/\S/);
            if (leading !== -1 && /\b(?:SELECT|UPDATE|DELETE\s+FROM)\b/i.test(part)) {
                statements.push({
                    sql: part,
                    index: match.index + 1 + offset + leading,
                    line: lineNumberAt(source, match.index + 1 + offset + leading),
                });
            }
            offset += part.length + 1;
        }
    }
    return statements;
}

function writeTarget(sql) {
    const match = sql.match(/\b(?:UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?(?:[a-z_][\w]*\.)?"?([a-z_][\w]*)"?/i);
    return match ? match[1].toLowerCase() : null;
}

function whereClause(sql) {
    const match = sql.match(/\bWHERE\b([\s\S]*?)(?:\bRETURNING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i);
    return match ? match[1] : '';
}

function sqlViolations(file, source) {
    const violations = [];
    for (const statement of extractSqlStatements(source)) {
        const target = writeTarget(statement.sql);
        const where = whereClause(statement.sql);
        const hasCompanyScope = /\bcompany_id\b/i.test(where);
        const base = { file, line: statement.line };

        if (file.startsWith('backend/src/routes/') && target
            && TENANT_WRITE_TABLES.has(target) && !hasCompanyScope) {
            const operation = statement.sql.match(/\b(UPDATE|DELETE\s+FROM)\b/i)?.[1].toUpperCase();
            violations.push({
                ...base,
                ruleId: 'R-write-scope',
                what: `${operation} on tenant table ${target} has no company_id in its WHERE clause`,
                why: 'an id or predicate valid in another company could mutate that company\'s data',
                fix: 'accept companyId explicitly and add AND company_id = $N to this statement',
            });
        }

        const isNaturalKeyWrite = Boolean(target) && NATURAL_KEY_RE.test(where);
        const isHighCollisionLookup = !target && HIGH_COLLISION_KEY_RE.test(where)
            && /backend\/src\/(?:routes|db)\//.test(file);
        if ((isNaturalKeyWrite || isHighCollisionLookup) && !hasCompanyScope) {
            violations.push({
                ...base,
                ruleId: 'R-natural-key',
                what: 'query filters by a natural key without company_id in the same WHERE clause',
                why: 'phone/email/external IDs/SIDs/UUIDs/tokens can collide or be reused across tenants',
                fix: 'accept companyId explicitly and add company_id = $N to the same statement',
            });
        }

        if (NON_REQUEST_FILE_RE.test(file) && target && NATURAL_KEY_RE.test(where) && !hasCompanyScope) {
            violations.push({
                ...base,
                ruleId: 'R-no-request-context',
                what: `non-request code writes tenant table ${target} without company_id`,
                why: 'workers, cron jobs, consumers, and webhook handlers have no req.companyFilter safety net',
                fix: 'make companyId a required function argument and bind it in the write WHERE clause',
            });
        }
    }
    return violations.filter(violation => {
        const key = `${violation.ruleId}:${file}:${violation.line}`;
        return !SQL_ALLOWLIST.has(key) && !allowedByComment(source, violation.line, violation.ruleId);
    });
}

function routeHeader(source, start, declarationEnd) {
    const tail = source.slice(declarationEnd, declarationEnd + 1200);
    const callback = tail.search(/(?:async\s*)?\(\s*(?:req|request)\b|function\s*\(\s*(?:req|request)\b|(?:async\s+)?(?:req|request)\s*=>/);
    if (callback !== -1) return source.slice(start, declarationEnd + callback);
    const newline = tail.indexOf('\n');
    return source.slice(start, declarationEnd + (newline === -1 ? tail.length : newline));
}

function routeDeclarations(file, source) {
    const routes = [];
    const re = /^[ \t]*([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`\n]+)\3/gm;
    let match;
    while ((match = re.exec(source)) !== null) {
        const receiver = match[1];
        if (receiver !== 'app' && !/router$/i.test(receiver)) continue;
        routes.push({
            file,
            receiver,
            method: match[2].toUpperCase(),
            routePath: match[4],
            line: lineNumberAt(source, match.index),
            index: match.index,
            header: routeHeader(source, match.index, re.lastIndex),
        });
    }
    return routes;
}

function permissionAliases(source) {
    const aliases = [];
    const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*requirePermission\s*\(/g;
    let match;
    while ((match = re.exec(source)) !== null) aliases.push(match[1]);
    return aliases;
}

function hasRouterLevelGate(source, routeIndex, aliases) {
    const prefix = source.slice(0, routeIndex);
    if (/\brouter\.use\s*\(\s*(?:requirePermission|requirePlatformRole)\s*\(/.test(prefix)) return true;
    return aliases.some(alias => new RegExp(`\\brouter\\.use\\s*\\([\\s\\S]{0,600}\\b${alias}\\b`).test(prefix));
}

function serverMountGuards() {
    const serverFile = 'src/server.js';
    const source = fs.readFileSync(path.join(ROOT, serverFile), 'utf8');
    const imports = new Map();
    let match;
    const defaultImportRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['"]\.\.\/backend\/src\/routes\/([^'"]+)['"]\)/g;
    while ((match = defaultImportRe.exec(source)) !== null) {
        imports.set(match[1], `backend/src/routes/${match[2]}.js`);
    }
    const destructuredRe = /\bconst\s*\{([^}]+)\}\s*=\s*require\(['"]\.\.\/backend\/src\/routes\/([^'"]+)['"]\)/g;
    while ((match = destructuredRe.exec(source)) !== null) {
        for (const item of match[1].split(',')) {
            const parts = item.trim().split(/\s*:\s*/);
            imports.set(parts[1] || parts[0], `backend/src/routes/${match[2]}.js`);
        }
    }

    const guardedFiles = new Map();
    const mountRe = /\bapp\.use\s*\(/g;
    while ((match = mountRe.exec(source)) !== null) {
        const slice = source.slice(match.index, match.index + 1000);
        const end = slice.search(/\);/);
        const mount = end === -1 ? slice.split('\n')[0] : slice.slice(0, end + 2);
        const guard = mount.match(/\b(requirePermission|requirePlatformRole)\s*\(([^)]*)\)/);
        if (!guard) continue;
        const reason = `${guard[1]}(${guard[2].trim()}) at ${serverFile}:${lineNumberAt(source, match.index)}`;
        for (const [identifier, file] of imports) {
            if (new RegExp(`\\b${identifier}\\b`).test(mount)) guardedFiles.set(file, reason);
        }
        const inlineRe = /require\(['"]\.\.\/backend\/src\/routes\/([^'"]+)['"]\)/g;
        let inline;
        while ((inline = inlineRe.exec(mount)) !== null) {
            guardedFiles.set(`backend/src/routes/${inline[1]}.js`, reason);
        }
    }
    return guardedFiles;
}

function routeKey(route) {
    return `${route.file}:${route.receiver}:${route.method}:${route.routePath}`;
}

function routeViolations() {
    const mountGuards = serverMountGuards();
    const files = listJsFiles('backend/src/routes');
    const allRoutes = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const aliases = permissionAliases(source);
        for (const route of routeDeclarations(file, source)) {
            const inlineGate = /\b(?:requirePermission|requirePlatformRole)\s*\(/.test(route.header)
                || aliases.some(alias => new RegExp(`\\b${alias}\\b`).test(route.header));
            if (inlineGate || hasRouterLevelGate(source, route.index, aliases) || mountGuards.has(file)) continue;
            if (allowedByComment(source, route.line, 'R-route-permission')) continue;
            if (PUBLIC_ROUTE_FILES.has(file) || ROUTE_PERMISSION_EXCEPTIONS.has(routeKey(route))
                || ROUTE_PERMISSION_BASELINE.has(routeKey(route))) continue;
            allRoutes.push({
                ...route,
                ruleId: 'R-route-permission',
                what: `${route.method} ${route.routePath} has no inline, router-level, or server mount-level permission gate`,
                why: 'authentication and company scoping do not decide whether the user role may perform this action',
                fix: 'add requirePermission(...) inline/mount-level, or baseline the exact reviewed public/debt route with a reason',
            });
        }
    }

    const serverFile = 'src/server.js';
    const serverSource = fs.readFileSync(path.join(ROOT, serverFile), 'utf8');
    for (const route of routeDeclarations(serverFile, serverSource)) {
        if (!route.routePath.startsWith('/api/')) continue;
        if (/\b(?:requirePermission|requirePlatformRole)\s*\(/.test(route.header)) continue;
        if (allowedByComment(serverSource, route.line, 'R-route-permission')) continue;
        if (ROUTE_PERMISSION_EXCEPTIONS.has(routeKey(route)) || ROUTE_PERMISSION_BASELINE.has(routeKey(route))) continue;
        allRoutes.push({
            ...route,
            ruleId: 'R-route-permission',
            what: `${route.method} ${route.routePath} has no permission gate`,
            why: 'direct app routes bypass router and mount-level RBAC middleware',
            fix: 'add requirePermission(...) or baseline this exact reviewed public route with a reason',
        });
    }
    return allRoutes;
}

function formatViolations(ruleId, violations) {
    const details = violations.map(v => [
        `${v.file}:${v.line} [${v.ruleId || ruleId}]`,
        `  WHAT: ${v.what}`,
        `  WHY: ${v.why}`,
        `  FIX: ${v.fix}. To allow a reviewed exception, add `
            + `// tenant-safety-allow ${v.ruleId || ruleId}: <one-line reason>`,
    ].join('\n')).join('\n\n');
    return `Tenant safety lint failed (${ruleId})\n\n${details}`;
}

const defineSuite = typeof describe === 'function' ? describe : () => {};

defineSuite('ALB-105 / TENANCY-RBAC-GUARD-001: tenant-safety sanitizer', () => {
    const files = SCAN_DIRS.flatMap(listJsFiles)
        .filter(file => !FILE_ALLOWLIST.has(file));

    it('scans routes, db, services, CLI/scripts, and webhook code', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files.some(file => file.startsWith('backend/src/db/'))).toBe(true);
        expect(files.some(file => file.startsWith('backend/src/webhooks/'))).toBe(true);
    });

    it('requires a one-line reason for every central exception', () => {
        for (const allowlist of [SQL_ALLOWLIST, PUBLIC_ROUTE_FILES,
            ROUTE_PERMISSION_EXCEPTIONS, ROUTE_PERMISSION_BASELINE]) {
            for (const [key, reason] of allowlist) {
                expect(key).toBeTruthy();
                expect(typeof reason).toBe('string');
                expect(reason.trim().length).toBeGreaterThan(10);
                expect(reason).not.toContain('\n');
            }
        }
    });

    it.each(LINE_RULES.map(rule => [rule.id, rule]))('%s has no violations', (ruleId, rule) => {
        const violations = [];
        for (const file of files) {
            if (!rule.appliesTo(file)) continue;
            const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
            source.split('\n').forEach((line, index) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
                if (allowedByComment(source, index + 1, ruleId)) return;
                if (rule.lineFilter && !rule.lineFilter(line)) return;
                if (rule.re.test(line)) {
                    violations.push({
                        file,
                        line: index + 1,
                        ruleId,
                        what: rule.what,
                        why: rule.why,
                        fix: rule.fix,
                    });
                }
            });
        }
        if (violations.length) throw new Error(formatViolations(ruleId, violations));
    });

    it.each(['R-write-scope', 'R-natural-key', 'R-no-request-context'])('%s has no violations', (ruleId) => {
        const violations = [];
        for (const file of files) {
            const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
            violations.push(...sqlViolations(file, source).filter(v => v.ruleId === ruleId));
        }
        if (violations.length) throw new Error(formatViolations(ruleId, violations));
    });

    it('R-route-permission has no unreviewed handlers', () => {
        const violations = routeViolations();
        if (violations.length) throw new Error(formatViolations('R-route-permission', violations));
    });
});

module.exports = {
    extractSqlStatements,
    hasRouterLevelGate,
    listJsFiles,
    permissionAliases,
    routeDeclarations,
    routeKey,
    routeViolations,
    serverMountGuards,
    sqlViolations,
};
