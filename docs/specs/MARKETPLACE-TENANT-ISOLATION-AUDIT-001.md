# SUMMARY

Static, read-only audit found **17 issues** plus **4 deployment/data-state suspects**.

| Severity | Count | Meaning |
|---|---:|---|
| P0 | 4 | Active cross-tenant read/write paths |
| P1 | 8 | Exploitable under a feature/configuration/credential condition |
| P2 | 5 | Missing defense-in-depth or dangerous internal contract |
| SUSPECT | 4 | Requires deployment configuration or production-data inspection |

Known-history verdict:

- **SMS list pagination leak:** closed on the audited list/message paths, but `/messaging/start` introduces a separate active IDOR.
- **Zenbooker default-company binding:** **not closed**. Tenant-aware support exists, but many live routes/services still call the global client.
- **Email/Yelp wrong-company ingestion:** core mailbox uniqueness and Yelp conversation scoping are fixed. Public push/OAuth entry points and Yelp scheduling tools still have cross-tenant weaknesses.

# LEAKS

## P0 — active cross-tenant paths

### 1. Vapi management API hard-codes every tenant to `default`

- **Evidence:** [`vapi.js:33`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/vapi.js:33) applies RBAC but [`vapi.js:37`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/vapi.js:37) hard-codes `DEFAULT_TENANT`. It is used for connections at lines 144–217, resources at 256–286, assistant profiles at 298–351, node configurations at 369–411, and AI runs at 427–437. Resources include `assistant_request_secret` at lines 60–69.
- **App:** Vapi.
- **Exploit:** Tenant A’s integration admin calls `/api/vapi/resources`, `/assistant-profiles`, or `/ai-runs` and reads tenant B/default configuration and run data; A can then update/delete the same shared records.
- **Minimal fix:** Replace `tenant_id='default'` with `req.companyFilter.company_id`; use a UUID/FK company column; scope every CRUD statement and validate referenced provider connections belong to the same company.

### 2. Authenticated Zenbooker proxy ignores the authenticated company

- **Evidence:** Mounted with company auth at [`server.js:210`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/src/server.js:210), but scheduling routes call company-less methods at [`zenbooker.js:12`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/zenbooker.js:12), lines 67–109. The entire jobs proxy does likewise at [`zenbooker/jobs.js:25`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/zenbooker/jobs.js:25), including reads, cancel, reschedule, assignment, notes, and status changes. Those methods use the global client at [`zenbookerClient.js:383`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/zenbookerClient.js:383), lines 395–467.
- **App:** Zenbooker.
- **Exploit:** Tenant A lists the default/B Zenbooker account’s jobs, retrieves a known B job ID, then cancels, reschedules, reassigns, completes, or annotates it.
- **Minimal fix:** Require `companyId` on every Zenbooker method, obtain only `getClientForCompany(companyId)`, pass `req.companyFilter.company_id` from every route, and fail closed when no tenant connection exists.

### 3. Local jobs/contacts from any company are pushed through the default Zenbooker account

- **Evidence:** Local contact selection is scoped, but the external write is global at [`zenbookerSyncService.js:173`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/zenbookerSyncService.js:173), specifically lines 207, 271–288, 371–375, and 428. Job creation does the same at [`jobsService.js:539`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/jobsService.js:539), lines 584–591; lead conversion at [`leadsService.js:1197`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/leadsService.js:1197); background sync at [`agentHandlers.js:114`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/agentHandlers.js:114), lines 137 and 162; rescheduling at [`scheduleService.js:273`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/scheduleService.js:273).
- **App:** Zenbooker.
- **Exploit:** Tenant A creates or edits an A contact/job; A’s customer PII is sent into tenant B/default’s Zenbooker account. A can also mutate a B external job if a local mapping contains its ID.
- **Minimal fix:** Thread mandatory `companyId` through every external operation, remove company-less fallback, and validate each stored external customer/job/address ID against the same tenant connection.

### 4. SMS “start conversation” has an active cross-tenant IDOR and permits proxy-number spoofing

- **Evidence:** [`messaging.js:217`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/messaging.js:217) accepts caller-supplied `customerE164` and `proxyE164`. Although it passes a company at lines 236–238, [`conversationsService.js:23`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/conversationsService.js:23) discards it during lookup. [`conversationsQueries.js:97`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/conversationsQueries.js:97) has no `company_id`; the active-pair uniqueness constraint is also global at [`017_create_messaging_tables.sql:33`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/db/migrations/017_create_messaging_tables.sql:33). Initial sending reloads the row unscoped at `conversationsService.js:104–120`.
- **App:** Twilio Conversations/SMS.
- **Exploit:** Tenant A supplies tenant B’s public proxy number plus a known customer number, receives B’s conversation row, and sends `initialMessage` into B’s thread/as B’s business number.
- **Minimal fix:** Add mandatory `companyId` to `findActiveConversation` and `sendMessage`; validate the proxy number belongs to A; include `company_id` in the active-pair unique index.

## P1 — conditional paths

### 5. Yelp conversation agent switches to the default company for later scheduling tools

- **Evidence:** [`yelpConvoAgentService.js:44`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/yelpConvoAgentService.js:44) defines the default. Turn zero correctly passes the actual company at lines 653–675, but model-driven turns call `runSkill(...DEFAULT_COMPANY_ID...)` at [`yelpConvoAgentService.js:752`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/yelpConvoAgentService.js:752), line 778. The worker supplies the real company at [`agentHandlers.js:363`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/agentHandlers.js:363).
- **App:** Yelp Leads / agent skills / slot engine.
- **Exploit:** With `YELP_CONVO_ENABLED`, tenant A’s Yelp conversation reaches `recommendSlots` or `checkAvailability` and is offered tenant B/default’s schedule or technicians.
- **Minimal fix:** Pass the existing `companyId` to `runSkill`; remove the default constant and test non-default Yelp conversations.

### 6. Vapi public tool calls trust body-supplied outbound variables when correlation fails

- **Evidence:** A single shared secret protects the endpoint at [`vapi-tools.js:55`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/vapi-tools.js:55). Unmatched calls fall back to the default at [`vapi-tools.js:118`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/vapi-tools.js:118), lines 127 and 155–164. `buildSkillInput` accepts `message.call.assistantOverrides.variableValues` at lines 92–113. `confirmLeadBooking` explicitly ignores the trusted transport tenant and uses `input.companyId` at [`confirmLeadBooking.js:30`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/agentSkills/skills/confirmLeadBooking.js:30), then reads/writes that company at lines 77–82 onward.
- **App:** Vapi / agent skills.
- **Exploit:** If the shared Vapi secret is exposed, tenant A submits an uncorrelated call with `companyId=B` and a B lead UUID and books/modifies B’s lead.
- **Minimal fix:** Reject unmatched calls; derive company only from a server-side correlated call record or per-tenant signed token; make skills scope exclusively from the trusted `companyId` argument.

### 7. Public Sales MCP is one shared bearer mapped to a fixed company

- **Evidence:** [`crmMcpPublicAuth.js:24`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/crmMcpPublicAuth.js:24) accepts one environment token and injects an environment-selected company/user at lines 36–44. Lines 59–80 synthesize permissions without validating a live membership or installation. It is publicly mounted at [`server.js:274`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/src/server.js:274).
- **App:** Sales CRM MCP.
- **Exploit:** Tenant A obtains the shared bearer and reads B’s contacts/leads/tasks; if public writes are enabled, A writes B CRM data.
- **Minimal fix:** Disable this transport in production or replace it with tenant-specific OAuth/API credentials plus live company, user, installation, and permission validation.

### 8. Gmail Pub/Sub ingestion can fail open and uses a shared token

- **Evidence:** [`emailPush.js:89`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/emailPush.js:89) accepts a shared query token without OIDC at lines 93–100. If neither credential is configured, lines 107–109 process unverified pushes without a production guard. The body’s `emailAddress` selects a mailbox at [`GmailProvider.js:129`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/mail/GmailProvider.js:129), lines 134–150, after which [`emailTimelineService.js:483`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/email/emailTimelineService.js:483) synchronizes that company.
- **App:** Gmail/email/Yelp/mail agent.
- **Exploit:** If auth variables are missing or the shared token leaks, tenant A names B’s mailbox in a forged push and triggers B email ingestion, lead processing, and agent side effects.
- **Minimal fix:** Fail closed in production; require verified OIDC audience and exact service-account identity; bind each Pub/Sub subscription/channel to a mailbox and reject address mismatches.

### 9. Gmail OAuth state supports transferable account-link CSRF

- **Evidence:** [`emailMailboxService.js:70`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/emailMailboxService.js:70) creates a reusable HMAC state containing only company, user, and timestamp. The public callback at [`email-oauth.js:19`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/email-oauth.js:19) trusts it and connects the Google account authorizing the request to that stored company at lines 39–61, with no initiating-session or live-membership check.
- **App:** Gmail/email.
- **Exploit:** Tenant A sends its generated authorization URL to tenant B’s admin; B consents to B’s Gmail account, and the callback connects that mailbox to A’s workspace.
- **Minimal fix:** Use single-use server-stored state bound to the initiating authenticated session and PKCE; revalidate the actor’s active membership at callback time.

### 10. Legacy Zenbooker webhook accepts requests without authentication when the secret is unset

- **Evidence:** [`integrations-zenbooker.js:155`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/integrations-zenbooker.js:155) checks the secret only when `WEBHOOK_SECRET` is configured, then always attributes the payload to `ZENBOOKER_DEFAULT_COMPANY_ID` at lines 166–172.
- **App:** Zenbooker webhook.
- **Exploit:** If the environment secret is absent, tenant A posts a forged job/customer webhook and creates or changes records in tenant B/default.
- **Minimal fix:** Remove the legacy endpoint or require authentication unconditionally and resolve tenant from a verified per-company webhook/account binding.

### 11. SMS media is exposed through an unauthenticated UUID bearer

- **Evidence:** [`server.js:130`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/src/server.js:130) explicitly mounts the media proxy without auth. [`conversationsService.js:505`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/conversationsService.js:505) and [`conversationsQueries.js:273`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/conversationsQueries.js:273) resolve media/message/conversation without company scope.
- **App:** Twilio Conversations/SMS.
- **Exploit:** Tenant A obtains a B media UUID from forwarded markup, logs, or a referrer and downloads B’s attachment without an authenticated B session.
- **Minimal fix:** Require authentication and join media→message→conversation with `company_id`, or issue short-lived signed tenant-bound URLs.

### 12. Unknown Twilio Conversations are inserted into the default company

- **Evidence:** [`conversationsService.js:225`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/conversationsService.js:225) auto-fetches an unknown conversation and upserts it without a company at lines 265–271. [`conversationsQueries.js:10`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/conversationsQueries.js:10) defaults that write to the seed company.
- **App:** Twilio Conversations webhook.
- **Exploit:** Tenant A causes an auto-created conversation on the shared Conversations service; the event and customer data are stored in tenant B/default’s inbox.
- **Minimal fix:** Resolve the company from a verified messaging-service/account/proxy-number binding before insert; quarantine unknown bindings and eliminate the default.

## P2 — hardening gaps

### 13. Marketplace credential relationships do not enforce same-company ownership

- **Evidence:** [`marketplaceQueries.js:120`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/marketplaceQueries.js:120) joins installations to `api_integrations` by ID alone. The same pattern appears at lines 176, 251, 269, 343, and 370. [`marketplaceQueries.js:448`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/marketplaceQueries.js:448) accepts an integration ID without verifying it belongs to the installation company.
- **App:** Marketplace core.
- **Exploit:** If a future caller or corrupted task attaches B’s credential ID to A’s installation, A receives B credential metadata and can influence its revocation/reconciliation.
- **Minimal fix:** Add `ai.company_id = i.company_id` to every join and an ownership `EXISTS` check or composite FK when updating credentials.

### 14. Several integration helper mutations accept only globally unique IDs

- **Evidence:** Yelp claim mutations at [`yelpLeadQueries.js:52`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/yelpLeadQueries.js:52), lines 52–79 and 134–155; email mailbox ID helpers at [`emailQueries.js:20`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/emailQueries.js:20), lines 20–25 and 82–125; SMS preview/delivery/media helpers at [`conversationsQueries.js:106`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/conversationsQueries.js:106), lines 106–150 and 249–275.
- **App:** Yelp, email, Twilio/SMS.
- **Exploit:** A future endpoint or compromised worker task supplies B’s row ID and mutates B because the helper cannot enforce the caller’s tenant.
- **Minimal fix:** Require `companyId` in every helper signature and include it in the SQL or a same-company ownership join.

### 15. ChatGPT MCP lead UUID collision probe is global

- **Evidence:** [`chatgptMcpWriteService.js:249`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/chatgptMcpWriteService.js:249) checks `SELECT 1 FROM leads WHERE uuid=$1` without company scope.
- **App:** ChatGPT MCP.
- **Exploit:** A collision or future caller-controlled UUID lets A’s creation behavior reveal that the UUID exists in B.
- **Minimal fix:** Pass company ID and add `AND company_id=$2`, or make UUID generation retry independent of tenant data.

### 16. Vapi timeline functions retain default-company fallbacks

- **Evidence:** [`vapiCallTimelineService.js:180`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/vapiCallTimelineService.js:180), with fallbacks at lines 180–203, 226–230, 310–327, and 382–403.
- **App:** Vapi/outbound calling.
- **Exploit:** If a new caller omits attempt/company context, tenant A’s call timeline is silently created or finalized in tenant B/default.
- **Minimal fix:** Require company context and fail closed; never synthesize the default tenant.

### 17. Twilio inbox worker fails to the default company on lookup miss or DB error

- **Evidence:** [`inboxWorker.js:17`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/inboxWorker.js:17) returns the default on both an unmapped `AccountSid` and exceptions; the result is used for writes at lines 164–184.
- **App:** Twilio voice worker.
- **Exploit:** An A webhook whose binding is temporarily unavailable is processed as tenant B/default instead of retrying.
- **Minimal fix:** Persist the verified company at webhook ingestion; on missing/error, retry or quarantine rather than falling back.

# CLEAN

“Clean” below applies to the named path, not an entire integration where another finding exists.

- **Marketplace API/service selection:** Auth and tenant-admin middleware are applied at [`server.js:289`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/src/server.js:289); routes derive company only from `req.companyFilter` at [`marketplace.js:8`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/marketplace.js:8). Install/list/settings flows propagate it in [`marketplaceService.js:641`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/marketplaceService.js:641). Provisioning signs a server-selected company and credential at [`marketplaceProvisioningService.js:38`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/marketplaceProvisioningService.js:38).
- **Marketplace ratings:** Reviewer creation/deletion is company-scoped at [`marketplaceRatingsQueries.js:9`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/marketplaceRatingsQueries.js:9) and lines 109–117. Cross-company posted reviews at lines 120–155 are intentionally public. Moderation is super-admin gated at lines 209–219.
- **Authenticated CRM/service MCP and ChatGPT OAuth MCP:** Routes require company context at [`crmMcp.js:25`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/crmMcp.js:25) and [`agentSkillsMcp.js:38`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/agentSkillsMcp.js:38). OAuth binding supplies the immutable company at [`chatgptMcpAuth.js:157`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/middleware/chatgptMcpAuth.js:157). Service MCP’s public transport is disabled in production at [`agentSkillsMcpPublicAuth.js:25`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/agentSkillsMcpPublicAuth.js:25).
- **Avatars:** Installation, membership, binding, credential, and invocation joins are consistently paired to the requested company at [`avatarsService.js:84`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/avatarsService.js:84).
- **Email workspace and sync after tenant resolution:** Mailbox/thread/message operations propagate company; mail-agent cache is keyed by company at [`mailAgentService.js:25`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/mailAgentService.js:25). The historical duplicate-address problem is prevented by [`130_email_mailbox_address_unique.sql:27`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/db/migrations/130_email_mailbox_address_unique.sql:27).
- **Yelp core ingestion/conversation state:** Installation gate and claims receive the actual company at [`yelpLeadService.js:282`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/yelpLeadService.js:282); replies use company-scoped conversation lookup/update at lines 681–732. Conversation keys and updates include company at [`yelpConversationQueries.js:40`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/yelpConversationQueries.js:40).
- **Google Ads core:** Company is mandatory in [`googleAdsConnectionService.js:21`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/googleAdsConnectionService.js:21); connection, channel, sync, and imported records carry company. The OAuth client/developer token is platform-shared, while refresh tokens are encrypted per connection.
- **Zenbooker isolated islands:** `getClientForCompany` correctly restricts the environment fallback to the owner company at [`zenbookerClient.js:73`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/zenbookerClient.js:73). Team members pass company at [`zenbooker.js:122`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/zenbooker.js:122); the integration jobs endpoint uses the tenant client at [`integrations-zenbooker.js:339`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/integrations-zenbooker.js:339); per-company webhooks resolve from an opaque key at lines 181–206.
- **Historical SMS pagination path:** List supplies company at [`messaging.js:92`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/messaging.js:92); message pages require and filter company at [`conversationsQueries.js:184`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/db/conversationsQueries.js:184), including timeline pagination at lines 213–246.
- **Telephony administration and call masking:** Tenant subaccount clients are cached by company at [`telephonyTenantService.js:178`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/telephonyTenantService.js:178); webhook signatures select the account token at [`twilioWebhooks.js:98`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/webhooks/twilioWebhooks.js:98). Call-masking settings, sessions, contacts, and role checks are company-scoped.
- **Stripe customer-payment webhook:** Signature verification precedes account lookup; company derives from verified Stripe account binding, not metadata/body company, and unknown accounts are ignored.
- **Rely apps:** [`relyLeadFilterService.js:119`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/relyLeadFilterService.js:119) passes company through installation/settings/territory evaluation. `relyLeadsCatalog.js` is static catalog data.
- **Outbound Lead Caller:** Settings/routes and attempt rows are company-scoped; the separate Vapi public-tool weakness is finding 6.
- **Lead-channel analytics:** Company is mandatory and every cohort/cost/source query filters it at [`leadChannelAnalyticsService.js:73`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/leadChannelAnalyticsService.js:73), lines 159–308 and 373–455.
- **Slot-engine local data assembly:** Jobs, technicians, settings, and coordinates are selected by company before egress. The engine implementation itself is stateless.

# SUSPECT

1. **Twilio master-account number ownership:** [`twilioWebhooks.js:21`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/webhooks/twilioWebhooks.js:21) resolves `AccountSid` before `To`; [`telephonyTenantService.js:211`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/telephonyTenantService.js:211) maps the master account to default. If any non-default tenant number remains on the master account, its inbound calls are attributed to default. **Check:** compare active `phone_number_settings.company_id` against the provider account owning each number.

2. **Duplicate provider-account bindings:** Zenbooker keys can be assigned per company at [`integrations-zenbooker.js:425`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/integrations-zenbooker.js:425) without a uniqueness/provider-owner check. Google Ads similarly prevents customer changes within one company but not the same `customer_id` across companies at [`googleAdsConnectionService.js:49`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/googleAdsConnectionService.js:49). **Check:** compare provider account IDs or irreversible key fingerprints across companies.

3. **Slot-engine deployment boundary:** [`slotEngineService.js:457`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/services/slotEngineService.js:457) sends technician names/IDs/base coordinates and scheduled-job coordinates to a shared URL without an application-level company identifier or auth header. The local engine route is unauthenticated at [`slot-engine/src/server.js:11`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/slot-engine/src/server.js:11). **Check:** private-network controls, ingress authorization, request logging/retention, and whether any shared deployment caches payloads.

4. **Vapi call-status correlation uniqueness:** [`vapiCallStatus.js:87`](/Users/rgareev91/contact_center/twilio-front-integration/.claude/worktrees/hungry-heyrovsky-84a367/backend/src/routes/vapiCallStatus.js:87) uses one shared webhook secret; correlation selects the first `vapi_call_id` row at lines 152–161 without an ambiguity check. **Check:** database uniqueness of `vapi_call_id`, whether multiple Vapi organizations feed the endpoint, and whether secrets are tenant-specific.

# NEXT

1. Gate the four P0 paths first: disable the shared Vapi management API and legacy/global Zenbooker routes, then block SMS `/start` until company and proxy ownership are enforced.
2. Rotate shared Vapi/Sales-MCP/Gmail/Zenbooker webhook secrets after fixes if they have ever been deployed.
3. Add the canonical `T-own`, `T-foreign`, `T-blast`, and RBAC deny-cell suites to each corrected route plus worker/webhook attribution tests.
4. Resolve the four SUSPECT items using production configuration and database inventory before declaring isolation guaranteed.

This was a static source audit only. No files were changed, no patches were applied, and no tests or external systems were run.
