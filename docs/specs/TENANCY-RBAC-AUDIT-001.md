# TENANCY-RBAC-AUDIT-001 — backend route audit

Date: 2026-07-18

## Scope and result

The audit parsed 534 handlers in `backend/src/routes` plus the one direct `/api/*`
handler in `src/server.js`. Of those, 245 contain literal inline
`requirePermission(...)`; the remaining 290 are classified below.

| Category | Handlers | Result |
|---|---:|---|
| (a) effective RBAC outside the literal handler declaration | 182 | Fine: mount-level, router-level/alias, platform-role, reviewed local role gate, or reviewed per-tool MCP gate |
| (b) public/machine/role-neutral by design | 84 | Compensating controls recorded; seven weak or missing-control cases are flagged |
| (c) REAL GAP | 24 | Exact route and suggested catalog permission recorded; all are retiring Zenbooker surfaces |

The scanner recognizes server mount guards by resolving route imports into the
`app.use(... requirePermission/requirePlatformRole ..., router)` call. Existing real
gaps are baselined by exact `file:receiver:method:path`, so a new ungated signature
fails the lint without treating the baseline as approval.

## (a) Effective gate outside literal inline `requirePermission` — 182

Every handler is listed as `line METHOD path`; mount citations point to `src/server.js`.

| Route file | Handlers without literal inline gate | Effective gate |
|---|---|---|
| `action-required-settings.js` | 40 GET `/`; 69 PUT `/` | `tenant.company.manage`, mount line 315 |
| `admin-companies.js` | 16 GET `/`; 53 GET `/:id`; 69 POST `/`; 200 PATCH `/:id/status`; 240 POST `/:id/bootstrap-admin` | `super_admin`, mount line 359 |
| `admin-company-users.js` | 95 GET `/`; 118 POST `/`; 163 PATCH `/:userId`; 200 PATCH `/:userId/status`; 245 PUT `/:userId/reset-password` | `super_admin`, mount line 360 |
| `automationRules.js` | 34 GET `/rules`; 47 POST `/rules`; 70 PATCH `/rules/:id`; 104 DELETE `/rules/:id`; 113 GET `/rules/:id/runs`; 124 GET `/catalog`; 129 POST `/rules/seed-defaults`; 140 POST `/rules/migrate-ar`; 150 GET `/agent-tasks`; 167 POST `/agent-tasks/:id/retry` | `tenant.company.manage`, mount line 199 |
| `billing.js` | 15 GET `/`; 30 GET `/invoices`; 40 POST `/checkout`; 66 GET `/wallet`; 92 POST `/wallet/topup`; 102 PATCH `/wallet/auto-recharge`; 113 POST `/portal` | `tenant.company.manage`, mount line 201 |
| `calls.js` | 26 GET `/`; 75 GET `/active`; 91 GET `/operations-dashboard`; 107 GET `/by-contact`; 386 GET `/contact/:contactId`; 504 GET `/:callSid`; 520 GET `/:callSid/recording.mp3`; 604 GET `/:callSid/media`; 798 GET `/:callSid/events`; 811 GET `/health/sync` | Router middleware invokes `callsRead` (`reports.calls.view` or `pulse.view`) |
| `document-templates.js` | 40 GET `/`; 52 GET `/factory/:document_type`; 61 GET `/:id`; 72 PUT `/:id`; 88 POST `/:id/reset`; 101 POST `/:id/preview` | `tenant.integrations.manage`, mount line 310 |
| `email-settings.js` | 19 GET `/`; 34 POST `/google/start`; 50 POST `/disconnect`; 80 POST `/sync` | `tenant.integrations.manage`, mount line 322 |
| `integrations-admin.js` | 18 GET `/`; 35 POST `/`; 72 DELETE `/:keyId` | `tenant.integrations.manage`, mount line 276 |
| `job-tags-settings.js` | 13 GET `/`; 26 POST `/`; 50 PATCH `/:id`; 94 POST `/reorder`; 122 DELETE `/:id` | `tenant.company.manage`, mount line 312 |
| `jobs-list-fields-settings.js` | 44 GET `/`; 72 PUT `/` | `tenant.company.manage`, mount line 313 |
| `lead-form-settings.js` | 7 GET `/`; 29 PUT `/` | `tenant.company.manage`, mount line 311 |
| `mailAgent.js` | 35 GET `/settings`; 61 PUT `/settings`; 91 POST `/test-rules`; 113 POST `/dry-run`; 126 GET `/reviews` | `tenant.integrations.manage`, mount line 279 |
| `marketplace.js` | 33 GET `/apps`; 42 GET `/installations`; 52 GET `/apps/:appKey/settings`; 64 PUT `/apps/:appKey/settings`; 79 PUT `/apps/rate-me/domain`; 92 POST `/apps/rate-me/domain/verify`; 104 DELETE `/apps/rate-me/domain`; 113 POST `/apps/rate-me/tokens`; 130 POST `/apps/:appKey/install`; 144 POST `/installations/:id/disconnect`; 158 POST `/installations/:id/retry-provisioning` | `tenant.integrations.manage`, mount line 277 |
| `agentSkillsMcp.js` | 46 GET `/tools`; 59 POST `/call`; 78 POST `/jsonrpc` | Authenticated + tenant-resolved transport; registry-declared per-tool permissions enforced before dispatch, discovery filtered, unmapped tools denied |
| `crmMcp.js` | 33 GET `/tools`; 46 POST `/call`; 65 POST `/jsonrpc` | Authenticated + tenant-resolved transport; registry-declared per-tool permissions enforced before dispatch, discovery filtered, unmapped tools denied |
| `messaging.js` | 35 GET `/`; 55 GET `/:id`; 67 GET `/:id/messages`; 126 POST `/:id/mark-read`; 143 POST `/:id/mark-unread` | Inline `msgRead` permission alias |
| `outboundLeadCall.js` | 37 GET `/settings`; 78 PUT `/settings` | `tenant.integrations.manage`, mount line 282 |
| `platformCompanies.js` | 11 GET `/`; 28 GET `/:id`; 41 PATCH `/:id` | `super_admin`, mount line 349 |
| `price-book.js` | 37 GET `/categories`; 41 POST `/categories`; 45 PATCH `/categories/:id`; 49 DELETE `/categories/:id`; 55 GET `/groups`; 61 GET `/groups/:id`; 66 GET `/groups/:id/expand`; 70 POST `/groups`; 74 PATCH `/groups/:id`; 78 DELETE `/groups/:id`; 84 GET `/items`; 96 POST `/items`; 101 PUT `/items/bulk`; 105 PATCH `/items/:id`; 109 DELETE `/items/:id`; 115 GET `/template`; 120 GET `/export`; 128 POST `/import` | Inline `VIEW`/`MANAGE` permission aliases |
| `pulse.js` | 95 GET `/timeline-by-id/:timelineId`; 138 GET `/timeline/:contactId`; 757 GET `/unread-count`; 776 GET `/timeline-by-phone`; 809 GET `/default-proxy`; 831 POST `/ensure-timeline`; 939 POST `/threads/:id/mark-handled`; 963 POST `/threads/:id/snooze`; 990 POST `/threads/:id/assign`; 1017 POST `/threads/:id/tasks`; 1060 POST `/threads/:id/set-action-required` | Router-level `pulse.view`, line 19 |
| `rolesPermissions.js` | 46 GET `/`; 82 PUT `/:roleKey/permissions`; 155 GET `/members`; 192 PUT `/members/:membershipId/overrides` | `tenant.roles.manage`, mount line 298 |
| `service-territories.js` | 82 GET `/config`; 111 PUT `/mode`; 126 POST `/radii`; 170 DELETE `/radii/:id`; 182 GET `/`; 193 GET `/areas`; 204 GET `/export`; 224 POST `/`; 248 POST `/bulk-import`; 273 DELETE `/:zip` | `tenant.company.manage`, mount line 329 |
| `sessions.js` | 76 GET `/`; 112 DELETE `/:sessionId`; 142 DELETE `/user/:userId`; 172 GET `/auth-policy`; 214 PUT `/auth-policy` | `super_admin`, mount line 358 |
| `stripePayments.js` | 50 GET `/status`; 56 POST `/connect`; 64 POST `/onboarding-link`; 70 POST `/refresh-status`; 76 POST `/disconnect` | `tenant.integrations.manage`, mount line 286 |
| `telephonyNumbers.js` | 79 GET `/status`; 94 POST `/port-in-prompt/dismiss`; 109 POST `/connect`; 120 GET `/locale`; 127 GET `/search`; 145 GET `/`; 156 POST `/buy`; 178 DELETE `/:sid`; 190 GET `/usage`; 200 POST `/softphone/setup`; 208 GET `/a2p`; 219 POST `/a2p/register`; 229 POST `/a2p/campaign` | `tenant.telephony.manage`, mount line 195 |
| `telephonyPortIn.js` | 167 POST `/check`; 188 POST `/`; 206 GET `/`; 216 GET `/:id`; 227 DELETE `/:id` | `tenant.telephony.manage`, mount line 196 |
| `users.js` | 42 POST `/`; 122 GET `/`; 151 GET `/:id`; 187 PATCH `/:id`; 276 PATCH `/:id/status` | `tenant.users.manage`, mount line 352 |
| `vapi.js` | 144 GET `/connections`; 161 POST `/connections`; 206 PUT `/connections/:id`; 231 DELETE `/connections/:id`; 256 GET `/resources`; 270 POST `/resources`; 298 GET `/assistant-profiles`; 312 POST `/assistant-profiles`; 336 PUT `/assistant-profiles/:id`; 369 GET `/node-configs/:flowId/:nodeId`; 393 PUT `/node-configs/:flowId/:nodeId`; 427 GET `/ai-runs` | Router-level `tenant.integrations.manage`, line 35 |
| `onboarding.js` | 121 GET `/checklist` | Route-local `requireTenantAdmin` after `requireCompanyAccess` |

## (b) Public, machine, or role-neutral by design — 84

| Route file | Handlers | Compensating control / finding |
|---|---|---|
| `agentSkillsMcpPublic.js` | 49 POST `/`; 55 GET `/sse`; 78 POST `/messages` | Disabled by default; timing-safe bearer token; env-bound tenant; writes off by default |
| `auth.js` | 4 GET `/me` | Authenticated self-context only |
| `authDevice.js` | 12 POST `/otp/send`; 29 POST `/otp/verify`; 46 POST `/trust-device` | Authenticated current-user 2FA/device flow |
| `billingWebhook.js` | 14 POST `/` | Stripe HMAC signature |
| `crmMcpPublic.js` | 34 POST `/`; 40 GET `/sse`; 63 POST `/messages` | Disabled by default; timing-safe bearer token; env-bound tenant/user; writes off by default |
| `devices.js` | 41 POST `/`; 91 DELETE `/:token` | Authenticated current-user/company ownership |
| `email-oauth.js` | 19 GET `/google/callback` | Signed, expiring OAuth state |
| `emailPush.js` | 116 POST `/google` | Shared verification token or Google OIDC signature/audience validation |
| `feedback.js` | 29 POST `/` | Authenticated role-neutral company/user submission |
| `integrations-analytics.js` | 51/63/77/98 GET analytics endpoints | Integration credentials + header validation + rate limiter |
| `integrations-leads.js` | 34 POST `/leads` | Integration credentials + header validation + rate limiter |
| `public-estimates.js` | 14 GET `/estimates/:token`; 29 GET `/estimates/:token/pdf`; 54 GET `/ep/:token` | Validated opaque send-link token |
| `public-invoices.js` | 11 GET `/invoices/:token/pdf`; 34 GET `/invoices/:token/pay-info`; 47 POST `/invoices/:token/pay`; 60 POST `/invoices/:token/pay-intent`; 77 GET `/i/:token` | Validated opaque send/pay-link token |
| `public-rate.js` | 88 GET `/rate/:token`; 109 POST `/rate/:token/rating`; 151 POST `/rate/:token/click`; 172 GET `/rate-domain-ask` | Opaque token + host binding + IP rate limits |
| `publicAuth.js` | 58 POST `/signup`; 127 POST `/otp/send`; 142 POST `/otp/verify`; 156 GET `/places/suggest`; 166 GET `/places/resolve` | Feature kill switch, IP rate limits, OTP/anti-enumeration controls |
| `push-subscriptions.js` | 25 GET `/status`; 52 GET `/vapid-public-key`; 62 POST `/`; 102 DELETE `/`; 123 POST `/test` | Authenticated current-user subscription self-service |
| `stripePaymentsWebhook.js` | 16 POST `/` | Stripe HMAC signature |
| `time.js` | 4 GET `/` | Static clock data only |
| `vapi-tools.js` | 111 POST `/` | Fail-closed `x-vapi-secret` middleware |
| `vapiCallStatus.js` | 165 POST `/` | Fail-closed `x-vapi-secret` middleware |
| `zip-check.js` | 18 GET `/` | Authenticated role-neutral lookup scoped by selected company |
| `events.js` | 30 GET `/stats` | **FLAG:** public operational counters have no auth, host gate, or local rate limit |
| `integrations-zenbooker.js` | 127 POST `/webhooks`; 148 POST `/wh/:key` | **FLAG:** legacy route accepts requests without a secret when the env var is unset; keyed route uses a 32+ character company key |
| `notification-settings.js` | 35 GET `/` | Authenticated role-neutral read; PUT is separately admin-gated |
| `onboarding.js` | 21 POST `/`; 94 GET `/status` | Authenticated pre-tenant flow; bootstrap requires no membership + verified OTP |
| `portal.js` | 61 POST `/auth/request-access`; 91 POST `/auth/verify`; 158 GET `/session`; 181 GET `/documents`; 191 GET `/documents/:type/:id`; 202 POST `/documents/:type/:id/accept`; 213 POST `/documents/:type/:id/decline`; 224 POST `/payments`; 239 GET `/payments/history`; 249 GET `/bookings`; 259 GET `/profile`; 269 PATCH `/profile` | Portal-session bearer gate after token exchange. **FLAG:** `request-access` accepts company/contact ids and returns a raw token with no proof or route-local rate limit |
| `schedule.js` | 190 GET `/availability` | Authenticated placeholder; always 501, no data/action |
| `text-polish.js` | 36 GET `/health` | Authenticated static health/version response |
| `twiml.js` | 12 POST `/voice` | **FLAG:** Twilio-called endpoint has no Twilio signature validation |
| `userGroups.js` | 261 GET `/my` | Authenticated current-user group lookup |
| `voice.js` | 271 POST `/twiml/outbound`; 398 POST `/twiml/inbound` | **FLAG:** Twilio-called TwiML handlers have no signature validation; outbound validates caller-id ownership only |
| `webhooks.js` | 14/17/20/23/26/29/32/35 POST voice callbacks; 42/43 POST Conversations callbacks; 46 GET `/health` | Main voice callbacks validate Twilio signatures. **FLAG:** voice fallback and Conversations pre do not validate; Conversations post fails open when token/signature is absent |
| `src/server.js` | 129 GET `/api/messaging/media/:mediaId/temporary-url` | **FLAG:** opaque UUID is the sole control; no auth or rate limit |

## (c) REAL GAP — 24

All are authenticated/tenant-mounted unless noted, but lack role authorization.
Suggested keys are from `permissionCatalog.js`.

| Route file | Handler | Suggested permission |
|---|---|---|
| `integrations-zenbooker.js` | 185 GET `/webhook-url`; 219 POST `/webhook-url/regenerate`; 361 GET `/api-key`; 386 PUT `/api-key` | `tenant.integrations.manage` |
|  | 244 POST `/contacts/:contactId/create-customer`; 272 POST `/contacts/:contactId/sync` | `contacts.edit` |
|  | 300 GET `/jobs` | `jobs.view` |
| `zenbooker/jobs.js` | 25 GET `/`; 41 GET `/:id` | `jobs.view` |
|  | 57 POST `/:id/cancel`; 190 POST `/:id/complete` | `jobs.close` |
|  | 73 POST `/:id/reschedule`; 126 POST `/:id/notes`; 151 POST `/:id/enroute`; 171 POST `/:id/start` | `jobs.edit` |
|  | 97 POST `/:id/assign` | `jobs.assign` |
| `zenbooker/payments.js` | 17 POST `/sync` | `tenant.integrations.manage` |
|  | 53 GET `/export`; 84 GET `/`; 123 GET `/:id` | `payments.view` |
|  | 156 PATCH `/:id` | `payments.collect_offline` |
| `zenbooker.js` | 12 GET `/service-area-check`; 67 GET `/timeslots`; 92 GET `/services` | `schedule.view` |

## Additional tenancy findings exposed by the USE checks

The lint deliberately baselines existing occurrences instead of changing product code in
this audit step. Step 2 rechecked the historical outbound phone-cancel incident: it is no
longer live; `outboundCallCancellationService.cancel` scopes its lookup and all mutations by
`company_id`, with `outboundCancelTenantIsolation.test.js` as the passing `T-blast` guard.
Highest-risk baselines still open are:

- `calls.js:337`: SMS conversation read-state update uses customer digits without company scope.
- `inboxWorker.js:459,474,540,556,564,680,752,847` and
  `reconcileStale.js:129,194,213,250`: background writes use Twilio SIDs without an explicit
  company argument/predicate.
- Fifteen direct route-layer writes to high-risk tenant tables lack `company_id` in their
  `WHERE`; each is explicitly baselined for later remediation.

## Failure UX sample

Captured with a temporary unsafe route SQL literal, then removed:

```text
Tenant safety lint failed (R-write-scope)

backend/src/routes/__tenantSafetyNegativeControl.js:1 [R-write-scope]
  WHAT: UPDATE on tenant table leads has no company_id in its WHERE clause
  WHY: an id or predicate valid in another company could mutate that company's data
  FIX: accept companyId explicitly and add AND company_id = $N to this statement.
       To allow a reviewed exception, add
       // tenant-safety-allow R-write-scope: <one-line reason>
```

## Recommended triage order

1. Fix the phone/digits/SID write baselines and public callbacks with missing/fail-open signatures.
2. Gate TwiML operations and integration key/configuration routes.
3. Gate MCP and Zenbooker job/payment surfaces.
