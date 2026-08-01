# NOTIF-REWORK-001 — Alerts & notifications platform rework

Status: approved; M1 foundation implementation in progress
Owner: Product owner / team lead  
Backend implementation: GPT implementer  
Frontend design and implementation: Claude architect, except the explicitly listed M1 security wiring  
Source analysis: NOTIF-REWORK-001 Turn 1, accepted 2026-07-31

## 1. Outcome

Replace company-wide notification fan-out with an event-driven, per-recipient notification platform. Every delivery is bound to one company and one CRM user, evaluated against live RBAC and the user's current record scope. The work ships in four independently deployable, owner-gated milestones so production is never left in a half-built insecure state.

The source of notification intent is an allowlisted catalog over typed `domain_events` published through `eventBus`. `audit_log` remains the canonical History read model and is never polled or repurposed as a notification queue.

## 2. Binding product decisions

1. Scope is the full platform, delivered as M1 security core, M2 in-app inbox, M3 staff email/SMS, and M4 durable projector hardening.
2. M1 contains both current leak paths: company-broadcast Web Push and record-bearing SSE.
3. The V1 event vocabulary and isolation scopes are the Turn-1 taxonomy in §6. User preferences are five category booleans, default on by absence.
4. Financial notifications use a new permission, `notifications.financial.receive`. It grants notification eligibility only; it does not grant access to financial pages, APIs, amounts, or records.
5. Default dispatchers receive that permission. Providers may receive financial notifications only for their own jobs.
6. The reworked settings UI and the M2 bell/inbox UI are owned by the Claude architect. The GPT implementer does not design or build those surfaces.
7. The Action triggers section is removed from the frontend in M1. Its backend settings, legacy helper, automation rules, and data remain, except that the unsafe first-company fallback is removed.
8. There is no company, role, per-event, or per-channel notification policy. Channel enablement is the existence of an active user-owned destination; every eligible event goes to every active destination.

## 3. Milestone boundaries

| Milestone | Independently shippable outcome | Must not depend on |
|---|---|---|
| M1 | Scoped event-driven browser/native delivery; current Web Push and SSE leaks contained; typed V1 producers; per-user category settings; Action triggers hidden | Bell UI, staff email/SMS, background replay worker |
| M2 | Persistent per-user notification center and unread state with access re-check | Staff email/SMS or M4 worker |
| M3 | Verified, opted-in staff email/SMS with quiet hours, cost guards, and loop prevention | M4 worker |
| M4 | Persistent event scan, leases, retry, replay, and at-least-once hardening | Any UI change |

Each milestone has its own test suite, named sabotage controls, owner review, and deploy/rollback decision. A later milestone may extend a table or catalog entry but may not weaken M1 recipient isolation.

## 4. Non-goals and ownership boundaries

- Do not build or finish Automations as part of this spec.
- Do not delete `action_required_config`, its route, its helper, its seeded automation rules, or existing company data.
- Do not dispatch from `audit_log`.
- Do not treat every `domain_event` as notifiable; only catalog entries in §6 are eligible.
- Do not introduce a second event bus.
- Do not modify protected frontend files, including `frontend/src/hooks/useRealtimeEvents.ts`.
- GPT-owned frontend work in M1 is limited to:
  - removing the Action triggers section and its obsolete query/mutation wiring;
  - unmounting/stopping `SSEPushBridge` notification behavior;
  - non-visual realtime callback changes needed to refetch scoped REST data after PII-free invalidations.
- All settings-category markup, device controls, bell/inbox markup, responsive behavior, and visual design are Claude-owned. They use `SettingsPageShell` / `SettingsSection`, PALETTE-V2 violet tokens, invisible containers, no horizontal rules, and no entity slide-over.

## 5. Architecture

### 5.1 Authoritative write flow

```text
authoritative business mutation / webhook / scheduled transition
    ├── audit_log action in the mutation transaction  -> History
    └── typed domain_event through eventBus            -> existing consumers
                                                          + notification projector
```

The two writes describe the same committed business action but serve different contracts. Existing Rules, MCP, Inspector, billing, and agent subscribers continue to consume the shared bus unchanged.

New producers must emit after the business mutation is known to have committed. Where the mutation already owns a database transaction, extend the event-bus persistence API compatibly so the event row can be written with that transaction and dispatched only after commit. Never send before commit.

### 5.2 M1 dispatch flow

```text
eventBus subscriber receives allowlisted event
    -> validate event company and aggregate
    -> map source event to one catalog policy key
    -> resolveNotificationRecipients(companyId, event)
    -> insert/claim one notification_deliveries row per user/channel
    -> build PII-safe payload
    -> send Web Push/APNs only to (company_id, user_id) endpoints
    -> mark delivery sent/failed
```

M1 is "durable enough," not yet durable discovery: the domain event and delivery ledger persist, `eventBus.redispatch` can replay manually, and the unique logical delivery key prevents concurrent duplicate claims. A process crash after event persistence but before the in-process subscriber runs can still leave an undispatched event until M4.

### 5.3 M4 hardening flow

M4 adds a persistent projector that scans allowlisted `domain_events` without a completed projection, claims work with leases, recreates missing delivery claims idempotently, and retries transient failures. The in-process M1 subscriber becomes a low-latency hint into the same idempotent projector, not a separate delivery path.

External Web Push/APNs/email/SMS providers do not offer a universal exactly-once transaction with PostgreSQL. The platform guarantees one logical delivery row and at-least-once attempts; a crash after provider acceptance but before the database acknowledgment may still produce a transport-level duplicate. Payload tags/provider IDs are used for best-effort suppression. This spec does not claim impossible exactly-once external delivery.

## 6. Versioned notification event catalog

### 6.1 Public event-catalog contract

The backend owns an ordered, versioned allowlist of 54 typed events. The event catalog remains useful for diagnostics and future UI detail, but the settings UI renders only the five user-configurable categories from §11.

```ts
type NotificationEventCatalogItem = {
  event_type: string;
  category_key: NotificationCategoryKey | 'admin_system';
  category_label: string;
  label: string;
  description: string;
  required_permission: string;
  default_audience_summary: string;
  producer_available: boolean;
};

type NotificationCategoryKey =
  | 'job_schedule'
  | 'leads'
  | 'calls_messages'
  | 'finance'
  | 'tasks';
```

Internal-only fields remain `source_event_type`, `source_predicate`, `record_scope`, safe payload builder, deep-link builder, and self-notification behavior. They never come from a client. `producer_available` is an event dispatch gate, not a category-toggle availability gate: all five user categories remain visible while individual producers come online. Unknown events are ignored fail-closed.

There is no per-event default, company policy, role audience toggle, supported-channel toggle, or channel preference in this model. Record audience is derived only from live permission and live record scope.

### 6.2 Stable category map (all 54 V1 events)

| category_key | category_label | configurable | events |
|---|---|---:|---|
| `job_schedule` | Job & schedule updates | yes | `job.created`, `job.assigned`, `job.unassigned`, `job.rescheduled`, `job.status_changed`, `job.updated`, `job.sync_completed`, `review.received` |
| `leads` | Leads | yes | `lead.created`, `lead.assigned`, `lead.unassigned`, `lead.review_required`, `lead.converted`, `lead.status_changed`, `lead.updated` |
| `calls_messages` | Calls & messages | yes | `sms.inbound`, `email.inbound`, `yelp.message_received`, `call.inbound_started`, `call.missed`, `call.voicemail_received`, `call.completed`, `sms.outbound`, `message.delivery_failed`, `ai_call.booked`, `ai_call.declined`, `ai_call.exhausted`, `ai_call.failed`, `ai_call.retry_scheduled`, `contact.updated` |
| `finance` | Estimates, invoices & payments | yes | `estimate.client_accepted`, `estimate.client_declined`, `estimate.send_failed`, `estimate.sent`, `estimate.viewed`, `invoice.send_failed`, `invoice.sent`, `invoice.viewed`, `invoice.voided`, `payment.succeeded`, `payment.failed`, `payment.disputed`, `payment.refunded`, `payment.voided` |
| `tasks` | Tasks | yes | `task.assigned`, `task.reassigned`, `task.due`, `task.overdue`, `task.completed` |
| `admin_system` | Administration & system | no; internal and always on | `agent_task.failed`, `integration.delivery_failed`, `sync.completed`, `billing.subscription_past_due`, `billing.invoice_payment_failed` |

The per-event labels, descriptions, required permissions, audience summaries, source predicates, record scopes, and producer flags are versioned in `backend/src/services/notificationEventCatalog.js`. Financial events use only `notifications.financial.receive`; system events use `tenant.company.manage`. The event vocabulary and security scopes remain the accepted Turn-1 taxonomy.

## 7. Recipient isolation contract

### 7.1 Required service

Implement:

```js
resolveNotificationRecipients(companyId, event, { client? })
  -> Array<{
       user_id,
       role_key,
       destinations: { browser_push: PushSubscription[], native_push: DeviceToken[] },
       delivery_ids: { browser_push?: uuid, native_push?: uuid }
     }>
```

The function is server-owned. No caller supplies roles, company, audience, permission, record scope, or user IDs except explicit pre-change recipient IDs carried by an authoritative event producer.

Evaluation order is fixed and fail-closed:

1. Reject missing `companyId` or `event.company_id`; they must match exactly.
2. Resolve the catalog entry by allowlisted event type. Unknown/unavailable types produce no recipients.
3. Validate the aggregate and every `record_ref` belongs to `companyId`. A foreign or missing record is indistinguishable and returns no recipients/404 at route boundaries.
4. Build a bounded candidate set from active `company_memberships` in that company only:
   - active office-role members;
   - current/pre-change job assignees for job events;
   - providers assigned to an active job for contact events;
   - task owner/author and `tasks.manage` candidates;
   - explicit assignee/actor where allowed.
5. Resolve live, no-cache authorization for every candidate with `resolveCompanyUserAuthz(companyId, userId)`. Do not copy role permissions into the event or trust a cached request context.
6. Resolve the catalog category. For the five user categories, deny only when an explicit `(company_id,user_id,category)` row has `enabled=false`; absence is enabled. `admin_system` skips this lookup.
7. Require the catalog `required_permission`.
8. Apply record scope:
   - job: reuse the canonical company + id + `assigned_provider_user_ids @>` predicate represented by `tasksQueries.jobParentVisible`;
   - contact/message/call/email/Yelp: require an active assigned job, with only `Canceled` and `Job is Done` inactive;
   - task: reuse `resolveTaskContentScope`; non-managers see owner/author tasks only;
   - lead: office-only; providers are denied;
   - financial: resolve the estimate/invoice/payment parent, require `notifications.financial.receive`, then apply the parent job/contact/lead scope;
   - `admin_system`: active members with live `tenant.company.manage` only;
   - orphan/unresolvable record: provider denied; a permitted office user may receive a generic event only when the catalog says office-only fallback is allowed.
9. Load every active Web Push subscription and native token bound to both `company_id` and `user_id`; no destination means no recipient.
10. Insert/claim one delivery row per available transport before provider send. The dispatcher sends to every active device returned for that transport.

No stage may widen recipients after a previous deny.

### 7.2 Shared active-contact helper

Factor the duplicated Pulse/conversation/contact-list predicate into one shared backend module, proposed path:

`backend/src/db/providerContactAccessQueries.js`

Required exports:

```js
buildActiveAssignedContactPredicate({
  jobsAlias,
  contactIdExpression,
  companyPlaceholder,
  userPlaceholder,
})

providerHasActiveJobForContact(companyId, userId, contactId, { client? })

listProvidersWithActiveJobForContact(companyId, contactId, { client? })
```

The module imports the one canonical inactive-status constant from `providerScope.js`. Pulse list/open, conversation visibility, contact-list provider scope, the notification resolver, and inbox re-checks must use this helper. No consumer retains its own `['Canceled', 'Job is Done']` list or hand-written equivalent predicate.

### 7.3 Pre-change recipient exception

`job.unassigned`, `lead.unassigned`, and `task.reassigned` may carry an authoritative `previous_recipient_user_ids` array captured inside the mutation transaction. The resolver validates that each ID was actually present before the mutation and is an active membership in the same company.

The removed user receives only a generic title. It contains no customer name, contact data, address, message, amount, AI summary, or deep link to a record the user can no longer open.

## 8. Effective policy rule

### 8.1 Exact rule

For candidate user `u` and allowlisted event `e`:

```text
deliver(u,e) =
    catalog[e].producer_available
    AND user_category_enabled(u, catalog[e].category_key)
    AND live_permission(u, catalog[e].required_permission)
    AND live_record_scope(u, event.record_ref)
    AND active_destinations(company_id,u).length >= 1
```

`user_category_enabled` is true when no preference row exists and equals the stored boolean when a row exists. The five configurable categories therefore default on for every user. `admin_system` is internal, always on, and not stored in `user_notification_preferences`; eligibility still requires live `tenant.company.manage`, the event permission, and record scope.

Access gates are authoritative and cannot be widened by a category preference. Channel is device-level, not event-level: an eligible event is delivered to every active browser subscription and native token for `(company_id,user_id)`. Creating/removing a browser subscription or native token is the corresponding device master switch. There is no company, role, event, or per-channel policy layer.

## 9. PII-safe delivery contract

Push/email/SMS payload builders are catalog-owned and accept an already-authorized event. Browser lock-screen and native APNs payloads may contain only:

- generic catalog title;
- generic action text, such as "Open Albusto to review";
- event type;
- opaque notification/delivery identifier;
- an authorized route token or non-sensitive internal deep link where supported;
- stable dedupe tag.

They must never contain:

- message/email/Yelp bodies or subjects;
- phone numbers or email addresses;
- customer/contact names;
- street addresses;
- payment amounts, balances, card/check data, invoice totals, or estimate totals;
- AI summaries, transcripts, recordings, or structured call outcomes;
- arbitrary event payload JSON.

Tests snapshot every payload builder and fail on forbidden keys and representative phone/email/address/amount/body values.

## 10. Data model and concrete migrations

Migration baseline was checked against local `origin/master` commit `1c6b989ac65f26b89b26cc15ec343f4d9d4310f3` on 2026-07-31. `origin/master` contains migration 220, so the current planned numbers are 221–224. Every implementation task must recheck `origin/master`; if another change takes a number, renumber this sequence forward before creating files.

### 10.1 M1 — `221_notification_security_core.sql`

Matching rollback: `rollback_221_notification_security_core.sql`

Changes:

1. Replace the global partial unique index on `domain_events(idempotency_key)` with a tenant-paired partial unique index on `(company_id, idempotency_key)`.
2. Replace Web Push endpoint uniqueness with `UNIQUE(company_id, user_id, endpoint)`. Subscription create/update/delete/stale-deactivation operations use the full key and never move a row between tenants/users.
3. Drop the unreleased `company_notification_policies` and `role_notification_delivery` tables if a development database already ran the earlier local form of migration 221. They are not part of the shipped model.
4. Create `user_notification_preferences`:
   - `id uuid PK`
   - `company_id uuid NOT NULL`
   - `user_id uuid NOT NULL`
   - `category text NOT NULL CHECK job_schedule/leads/calls_messages/finance/tasks`
   - `enabled boolean NOT NULL`
   - timestamps
   - membership-bound FK `(user_id, company_id)`
   - unique `(company_id, user_id, category)`
   - absence means enabled; no preference rows are seeded
5. Create `notification_deliveries`:
   - `id uuid PK`
   - `company_id uuid NOT NULL`
   - `domain_event_id bigint NOT NULL`
   - `user_id uuid NOT NULL`
   - `event_type text NOT NULL`
   - `channel text NOT NULL`; this records the transport claim and is not a preference
   - `record_type text NULL`, `record_id text NULL`
   - `status text NOT NULL CHECK pending/sending/sent/failed/skipped/unknown`
   - `attempt_count integer NOT NULL DEFAULT 0`
   - `last_error_code text NULL`, `last_error_at timestamptz NULL`
   - `provider_message_id text NULL`
   - `sent_at timestamptz NULL`, timestamps
   - FK `(company_id, domain_event_id)` using a unique context index on `domain_events(company_id,id)`
   - membership-bound FK `(user_id, company_id)`
   - unique `(company_id, domain_event_id, user_id, channel)`
6. Add `notifications.financial.receive` to `permissionCatalog.js` under Financial.
7. Add the permission to `050_seed_role_configs.sql` for tenant admin, manager, dispatcher, and provider. It grants notification eligibility only.
8. Backfill `is_allowed=true` for existing tenant-admin, manager, dispatcher, and provider role configs. Provider delivery remains own-job-only through record scope.
9. Retire the legacy `company_settings.browser_push_config` bridge. Migration 221 neither reads nor writes it, and the legacy broadcast gate is fail-closed until its callers are replaced by the scoped dispatcher.

The `notifications` inbox remains M2 migration 222; this task does not pull M2 storage into migration 221. Rollback is fail-safe: before restoring either former global unique index, it checks for cross-company duplicate idempotency keys/endpoints and raises a clear exception rather than deleting or merging data.

### 10.2 M2 — `222_notification_inbox.sql`

Matching rollback: `rollback_222_notification_inbox.sql`

Create `notifications`:

- `id uuid PK`
- `company_id uuid NOT NULL`
- `domain_event_id bigint NOT NULL`
- `user_id uuid NOT NULL`
- `event_type text NOT NULL`
- `category text NOT NULL`
- `safe_title text NOT NULL`
- `record_type text NULL`, `record_id text NULL`
- `deep_link_kind text NULL`; do not persist an arbitrary URL
- `read_at timestamptz NULL`
- `opened_at timestamptz NULL`
- `hidden_at timestamptz NULL` for access-revoked/expired items
- `created_at timestamptz NOT NULL`
- tenant-bound event and membership FKs
- unique `(company_id, domain_event_id, user_id)`
- index `(company_id, user_id, read_at, created_at DESC)` for unread/list queries

Retention target is 90 days unless a stricter platform retention policy exists at implementation time. Cleanup is company-scoped and never part of a request transaction.

### 10.3 M3 — `223_staff_notification_channels.sql`

Matching rollback: `rollback_223_staff_notification_channels.sql`

Create:

1. `notification_staff_endpoints`
   - tenant/member-bound `(company_id,user_id)`
   - `channel email|sms`
   - normalized destination required for send; encrypted or protected using the project's approved secrets mechanism
   - `destination_hash` for equality/guard checks
   - verification token hash/expiry, `verified_at`, `revoked_at`
   - unique `(company_id,user_id,channel,destination_hash)`
2. `notification_quiet_hours`
   - `(company_id,user_id)` unique
   - timezone defaults to `company.timezone`, never server local time
   - local start/end and enabled flag
3. `company_notification_channel_limits`
   - `(company_id,channel)` unique
   - company daily cap and per-user daily cap
   - absent/zero cap disables email/SMS fail-closed

Reuse `crm_users.phone_e164/phone_verified_at` when the opted-in SMS destination matches the verified profile number. A changed/custom number must pass OTP verification. Email requires a verified endpoint record; an unverified `crm_users.email` alone is insufficient for M3 delivery.

### 10.4 M4 — `224_notification_projector_hardening.sql`

Matching rollback: `rollback_224_notification_projector_hardening.sql`

Create `notification_event_projections`:

- `company_id uuid NOT NULL`
- `domain_event_id bigint NOT NULL`
- `event_type text NOT NULL`
- `status pending/processing/completed/retry/dead`
- `attempt_count`, `next_attempt_at`, `lease_owner`, `lease_expires_at`
- `last_error_code`, `last_error_at`, `completed_at`, timestamps
- PK/unique `(company_id, domain_event_id)`
- tenant-bound FK to `domain_events`
- scan index `(status, next_attempt_at, company_id, domain_event_id)`

Extend `notification_deliveries` with per-delivery retry/lease columns if M1 did not already include them. Do not create a second deliveries table.

## 11. API contracts for the Claude-owned UI

All routes use `authenticate, requireCompanyAccess`. `company_id` comes only from `req.companyFilter?.company_id`; it is never accepted in the body/query and there is no first-company fallback.

### 11.1 Current-user settings read

`GET /api/settings/notifications`

Permission: any active company member; current request-derived user only.

```json
{
  "ok": true,
  "data": {
    "categories": [
      {
        "key": "job_schedule",
        "label": "Job & schedule updates",
        "description": "Job assignments, schedule changes, status updates, and reviews.",
        "enabled": true
      },
      {
        "key": "leads",
        "label": "Leads",
        "description": "New leads, assignments, status changes, and review requests.",
        "enabled": true
      },
      {
        "key": "calls_messages",
        "label": "Calls & messages",
        "description": "Customer calls, messages, delivery failures, and AI-call outcomes.",
        "enabled": true
      },
      {
        "key": "finance",
        "label": "Estimates, invoices & payments",
        "description": "Estimate, invoice, and payment activity you are allowed to access.",
        "enabled": true
      },
      {
        "key": "tasks",
        "label": "Tasks",
        "description": "Task assignments, due dates, overdue alerts, and completions.",
        "enabled": true
      }
    ],
    "device": {
      "browser_push": {
        "supported": true,
        "permission": "unknown",
        "subscribed": true
      }
    }
  }
}
```

Categories are returned in the exact order above. A missing preference row yields `enabled:true`. `admin_system` is not returned. `subscribed` reuses the existing `(company_id,user_id,is_active=true)` Web Push subscription status. Browser permission cannot be observed by the server, so the API returns the stable `"unknown"` sentinel and the frontend replaces it with the local `Notification.permission` value.

The old `GET /api/settings/notification-policies`, company/role snapshot, effective-policy snapshot, and legacy two-boolean response are retired.

### 11.2 Current-user category write

`PATCH /api/settings/notifications/:category`

Permission: any active company member; current request-derived user only.

Body:

```json
{ "enabled": false }
```

Response:

```json
{
  "ok": true,
  "data": {
    "key": "leads",
    "label": "Leads",
    "description": "New leads, assignments, status changes, and review requests.",
    "enabled": false
  }
}
```

Only the five category keys from §6.2 are accepted. Unknown keys, including `admin_system`, return `404 NOTIFICATION_CATEGORY_NOT_FOUND`. `enabled` must be a boolean; extra identity/audience/channel fields return `400 INVALID_NOTIFICATION_PREFERENCE`. The route derives `company_id` from `req.companyFilter.company_id` and `user_id` from `req.user.crmUser.id`; neither can be selected by the caller.

The former `PATCH /api/settings/notification-policies/:eventType` and `PATCH /api/settings/notification-preferences/:eventType` routes are removed.

### 11.3 M2 inbox list/item contract

`GET /api/notifications?cursor=<opaque>&limit=<1..50>`

Permission: active company membership; own rows only

The service rechecks live permission and record access in bounded batches before returning items. Revoked/inaccessible rows are omitted and may be stamped `hidden_at`. Cursor ordering is `(created_at,id)` and is scoped to `(company_id,user_id)`.

Item shape, exactly as required by the UI:

```ts
type NotificationInboxItem = {
  id: string;
  event_type: string;
  category: string;
  title: string;
  created_at: string;
  read_at: string | null;
  deep_link: string | null;
  record_ref: { type: string; id: string } | null;
};
```

Response:

```json
{
  "ok": true,
  "data": {
    "items": [],
    "next_cursor": null
  }
}
```

`title` is PII-safe. `deep_link` is built from an allowlisted `deep_link_kind`; arbitrary URLs are never stored or returned. A record ID appears only after current access succeeds.

### 11.4 Unread count

`GET /api/notifications/unread-count`

Response:

```json
{ "ok": true, "data": { "count": 4 } }
```

The count is scoped to `(company_id,user_id)`. It excludes `hidden_at` rows. The inbox list/open path remains authoritative for live record access; revocation events should proactively hide affected rows so the count does not remain stale.

### 11.5 Mark read and open

`PATCH /api/notifications/:id/read`

Body:

```json
{ "read": true }
```

Own company/user row only. Foreign/other-user/unknown IDs return 404 and remain byte-unchanged. `read:false` may clear `read_at` if the UI supports mark-unread.

`POST /api/notifications/:id/open`

This is the required record-access re-check before navigation. It resolves live authz and current record scope again, then:

```json
{ "ok": true, "data": { "deep_link": "/jobs/123" } }
```

It marks `read_at/opened_at` only after authorization. If access was revoked, it returns 404, stamps the caller's own row hidden, and returns no record reference or link. The destination route/API still performs its normal authorization.

### 11.6 Eligibility preview, deferred to M2

`POST /api/settings/notifications/eligibility-preview`

Permission: `tenant.company.manage`

Body:

```json
{
  "event_type": "job.rescheduled",
  "record_ref": { "type": "job", "id": "123" }
}
```

Response contains counts only, never user IDs, names, emails, phones, or destinations:

```json
{
  "ok": true,
  "data": {
    "eligible_count": 3,
    "excluded_count": 5,
    "exclusion_reasons": [
      { "code": "USER_CATEGORY_DISABLED", "count": 2 },
      { "code": "RECORD_SCOPE_DENIED", "count": 2 },
      { "code": "NO_ACTIVE_DESTINATION", "count": 1 }
    ]
  }
}
```

Each candidate is assigned the first terminal reason in the resolver evaluation order, so counts do not double-count. Foreign/unknown record returns 404. Preview creates no event, notification, or delivery row.

Stable reason codes:

- `INACTIVE_MEMBERSHIP`
- `USER_CATEGORY_DISABLED`
- `MISSING_PERMISSION`
- `RECORD_SCOPE_DENIED`
- `NO_ACTIVE_DESTINATION`
- `QUIET_HOURS`
- `COST_GUARD`
- `PROXY_DESTINATION_BLOCKED`

## 12. SSE containment contract — M1

M1 chooses the safer of the two approved approaches: company-wide SSE may carry only PII-free invalidation signals. Authorized detail is refetched from existing scoped REST routes.

Rules:

1. Stop/unmount `SSEPushBridge`; it must not derive OS notifications or Sonner toasts from SSE.
2. Preserve the singleton EventSource and existing event names so the protected `useRealtimeEvents.ts` does not change.
3. Replace record-bearing payloads for `message.added`, `conversation.updated`, `call.created`, `call.updated`, `job.updated`, transcript events, and similar tenant broadcasts with minimal invalidation data:

```json
{
  "company_id": "uuid",
  "invalidate": true,
  "resource": "messages"
}
```

4. Company-wide invalidations contain no record ID, SID, phone, contact, timeline, conversation, job, message, transcript, subject, body, or status details.
5. Frontend callbacks refetch scoped REST lists/details. They do not perform inline cache insertion from the invalidation payload.
6. Existing PII-free count/change events may remain company-wide when their payload is only company/resource state.
7. Any feature that truly needs a full record SSE payload in the future must use a separate recipient-aware path whose user set is resolved through live record access. It may not restore company broadcast.
8. Tests enumerate every realtime publisher. Adding a new publisher without either the PII-free allowlist or a recipient-aware resolver fails the suite.

This changes realtime latency behavior but preserves security and avoids caching authorization for the life of an SSE connection. REST remains the authorization boundary.

## 13. M3 staff email/SMS contract

### 13.1 Opt-in and verification

- Email/SMS is opted in by creating a verified active destination for the same `(company_id,user_id)`; removing/revoking it is the device/channel master off switch.
- SMS may reuse `crm_users.phone_verified_at` only when the normalized opted-in destination equals the current verified `phone_e164`.
- Email uses a verification link/token flow and stores only a token hash; token expiry and one-time consumption are mandatory.
- Verification responses do not reveal whether another tenant/user owns the same normalized destination.

### 13.2 Quiet hours

- Evaluate in the user's configured timezone or company timezone fallback.
- Never use server-local date/time semantics.
- During quiet hours, M3 delivery remains pending until the next allowed time. No event in V1 bypasses quiet hours without a future explicit product decision.

### 13.3 Cost guard

- Both a system hard cap and a company-configured cap must allow delivery.
- Missing/zero company cap disables the paid channel.
- Enforce company/day and user/day counters transactionally before provider send.
- A blocked delivery records `skipped/COST_GUARD`; it does not fall back to another paid channel automatically.

### 13.4 Loop prevention

- Notification-origin outbound email/SMS is stamped with `origin=staff_notification` and `notification_delivery_id`.
- Event producers ignore notification-origin outbound messages.
- Staff SMS is never sent when the normalized destination matches an active customer-facing proxy number in the same company.
- `sms.outbound` and `message.delivery_failed` never support the staff SMS channel.
- A staff notification send failure may update its delivery row but may not publish another staff-notification event.

## 14. Milestone task plan

### M1 — Security core and event-driven dispatch

#### M1.T1 — Migration 221, financial permission, and tenant-paired keys

Deliverables:

- Migration/rollback 221 from §10.1.
- `notifications.financial.receive` in `permissionCatalog.js` and `050_seed_role_configs.sql`.
- Existing-role backfill for tenant admin, manager, dispatcher, and provider.
- Category preference table and retirement of the legacy two-boolean/company-settings bridge.
- Removal of first-company fallbacks from notification settings, Action Required settings, and push subscriptions.
- Full-key Web Push subscription mutations and tenant-paired domain-event idempotency.

Acceptance criteria:

- No company/role/event/channel preference rows are seeded; all five user categories resolve enabled by absence.
- Reapplying migration 221 preserves category preference rows.
- Dispatcher receives the new permission without gaining `financial_data.view` or any financial-route permission.
- Provider receives the notification permission but remains assigned-only.
- Foreign role/user/subscription/event keys cannot be read or changed.
- Rollback files exist and fail safely on incompatible global uniqueness restoration.

Planned tests:

- `tests/notificationMigrations.test.js`
- `tests/notificationMigrations.db.test.js`
- `tests/notificationSettingsRoutes.test.js`
- extend `tests/devicesApns.test.js` / new `tests/pushSubscriptionsIsolation.test.js` as affected

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationMigrations.test.js tests/notificationMigrations.db.test.js tests/notificationSettingsRoutes.test.js tests/pushSubscriptionsIsolation.test.js
```

Sabotage minimum:

- `SAB-M1-T1-CATEGORY-PRESERVE`: make the second migration apply recreate category preferences; double-apply preservation must fail.
- `SAB-M1-T1-NATURAL-KEY`: remove `company_id` from endpoint/idempotency uniqueness or mutation; shared-key T-blast must fail.
- `SAB-M1-T1-EFFECTIVE-PERM`: remove the migration backfill while leaving the catalog key; existing-dispatcher effective-permission test must fail.

#### M1.T2 — Catalog and category settings API

Deliverables:

- Versioned internal catalog and exact public catalog projection from §6.
- Current-user category reads and writes from §11.
- Strict five-category allowlist validation; producer availability remains an event dispatch concern.

Acceptance criteria:

- Public catalog objects have the exact required UI fields.
- Exactly five ordered user categories are returned; missing rows read enabled.
- `admin_system` is not user-configurable.
- User `enabled` cannot widen live permission or record scope.
- Foreign company/user identity cannot be selected; unknown categories return 404 with no write.

Planned tests:

- `tests/notificationEventCatalog.test.js`
- `tests/notificationPolicyService.test.js`
- `tests/notificationPolicyRoutes.test.js`
- `tests/notificationSettingsRoutes.test.js`

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationEventCatalog.test.js tests/notificationPolicyService.test.js tests/notificationPolicyRoutes.test.js tests/notificationSettingsRoutes.test.js
```

Sabotage minimum:

- `SAB-M1-T2-ALLOWLIST`: accept an unknown/internal category; unknown-category tests must fail.
- `SAB-M1-T2-IDENTITY`: accept body/query company or user identity; request-derived identity tests must fail.
- `SAB-M1-T2-DEFAULT`: treat a missing preference row as disabled; default-on settings/resolver tests must fail.

#### M1.T3 — Shared contact scope and recipient resolver

Deliverables:

- Shared active-contact helper from §7.2 adopted by Pulse, conversation access, contact-list scope, and notifications.
- `resolveNotificationRecipients` with live `resolveCompanyUserAuthz`.
- Parent resolution for job/contact/task/lead/financial/review events.
- Pre-change recipient validation.

Acceptance criteria:

- Provider own job and active contact work.
- Foreign job/contact, inactive contact, lead, orphan record, and missing user ID deny providers.
- Only `Canceled` and `Job is Done` are inactive; unknown/custom status remains active.
- Office users are still gated by event permission.
- Financial resolver uses only `notifications.financial.receive` plus parent scope, never `financial_data.view`.
- Category false is a terminal deny, absence is enabled, and `admin_system` ignores user preferences while requiring `tenant.company.manage`.
- Every active browser/native destination bound to the eligible `(company,user)` is returned and claimed.
- All entity validation is company-scoped and foreign IDs become 404/no recipients.

Planned tests:

- `tests/providerContactAccessQueries.test.js`
- `tests/providerContactAccessQueries.db.test.js`
- `tests/notificationRecipientResolver.test.js`
- `tests/notificationRecipientResolver.db.test.js`

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/providerContactAccessQueries.test.js tests/providerContactAccessQueries.db.test.js tests/notificationRecipientResolver.test.js tests/notificationRecipientResolver.db.test.js
```

Sabotage minimum:

- `SAB-M1-T3-PROVIDER-SCOPE`: bypass assigned-only job predicate; provider-foreign test must fail.
- `SAB-M1-T3-ACTIVE-CONTACT`: remove inactive-status exclusion; canceled/done contact test must fail.
- `SAB-M1-T3-LIVE-RBAC`: replace live resolver with seeded role assumptions; revoked/overridden permission test must fail.
- `SAB-M1-T3-FINANCE-PERM`: switch the gate back to `financial_data.view`; dispatcher/provider matrix test must fail.

#### M1.T4 — Typed V1 producers and corrected call semantics

Deliverables:

- Typed producers for every V1 catalog row that is marked available at M1 completion.
- Canonical audit + domain event at the same authoritative mutation seam.
- Correct terminal missed-call classification.
- Task due/overdue scheduler with company timezone and idempotency.
- Lead assignment normalized to a CRM user identifier before targeted notification; do not target by display name.
- Payment/invoice outcome normalization so one business payment produces one notification event.

Acceptance criteria:

- Answered/in-progress/completed answered calls never emit `call.missed`.
- A terminal unanswered parent call emits it exactly once; child legs do not.
- Voicemail emits only after a persisted voicemail record/outcome exists.
- Inbound email/Yelp and reviews emit after tenant-scoped persistence.
- AI outcomes use `eventBus.emit`, not raw `eventService.logEvent` as their only path.
- Task due/overdue idempotency includes company, task, boundary, and timezone-derived window.
- Every producer supplies company, aggregate, record refs, actor, and PII-safe identifiers; notification payload builders do not consume raw bodies/amounts.

Planned tests:

- `tests/notificationEventProducers.test.js`
- `tests/notificationEventProducers.db.test.js`
- extend `tests/bug-answered-call-shown-missed.test.js`
- extend `tests/bug009-missed-call-status.test.js`
- `tests/taskNotificationScheduler.test.js`

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationEventProducers.test.js tests/notificationEventProducers.db.test.js tests/bug-answered-call-shown-missed.test.js tests/bug009-missed-call-status.test.js tests/taskNotificationScheduler.test.js
```

Sabotage minimum:

- `SAB-M1-T4-MISSED-CALL`: restore the current broad inbound condition; answered-call test must fail.
- `SAB-M1-T4-WEBHOOK-TENANT`: remove company from a shared SID/external-ID lookup; T-blast must fail and foreign row must change in the broken control.
- `SAB-M1-T4-DUE-DEDUPE`: remove company/window from the scheduler idempotency key; two-tenant/same-task-key test must fail.

#### M1.T5 — Scoped browser/native dispatcher

Deliverables:

- EventBus notification subscriber.
- Per-recipient delivery claims.
- PII-safe Web Push and APNs builders.
- Web Push selects subscriptions by `(company_id,user_id)`.
- APNs selects tokens by `(company_id,crm_user_id)`.
- Remove inline `sendPushToCompany` calls and route assignment/reschedule APNs through the dispatcher.

Acceptance criteria:

- No production path calls company-broadcast notification fan-out.
- Provider receives own job/active-contact event only.
- Lead notification never reaches a provider.
- Same endpoint/token/natural record key in two companies cannot cross-deliver.
- One event/user/channel creates one logical delivery claim.
- PII-safe payload snapshots contain no forbidden data.
- Provider failures remain fail-soft with recorded delivery status and never roll back business mutations.

Planned tests:

- `tests/notificationDispatcher.test.js`
- `tests/notificationDispatcher.db.test.js`
- `tests/notificationPayloadSafety.test.js`
- extend `tests/devicesApns.test.js`

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationDispatcher.test.js tests/notificationDispatcher.db.test.js tests/notificationPayloadSafety.test.js tests/devicesApns.test.js
```

Sabotage minimum:

- `SAB-M1-T5-COMPANY-FANOUT`: select all company subscriptions; provider/role matrix must fail.
- `SAB-M1-T5-USER-SCOPE`: remove `user_id` from delivery endpoint query; own-vs-other-provider test must fail.
- `SAB-M1-T5-PII`: add event body/phone/amount to payload; payload-safety suite must fail.
- `SAB-M1-T5-CLAIM`: remove the unique claim/atomic insert; concurrent duplicate test must fail.

#### M1.T6 — SSE containment and frontend security wiring

Deliverables:

- PII-free invalidation contract from §12 for every company-broadcast realtime publisher.
- `SSEPushBridge` no longer mounted/active.
- Existing frontend realtime consumers refetch scoped REST data rather than inline-insert full SSE DTOs.
- Protected realtime hook unchanged.

Acceptance criteria:

- Provider connections receive no foreign message, email, Yelp, call, job, contact, conversation, transcript, or financial payload.
- Company B receives nothing from company A.
- Unscoped event fails closed.
- Invalidation payload contains only company/resource/invalidate fields.
- Scoped lists/details still refresh through REST for allowed users.
- Browser/native alerts now come only from the scoped notification dispatcher.

Planned tests:

- extend `tests/eventsRbacIsolation.test.js`
- extend `tests/realtimeSse.test.js`
- `tests/realtimePayloadSafety.test.js`
- focused frontend tests for changed consumer callbacks

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/eventsRbacIsolation.test.js tests/realtimeSse.test.js tests/realtimePayloadSafety.test.js
cd frontend && npm test
cd frontend && npm run build
```

Sabotage minimum:

- `SAB-M1-T6-RECORD-PAYLOAD`: restore one full `message.added`/`job.updated` DTO; payload allowlist test must fail.
- `SAB-M1-T6-UNSCOPED`: remove company fail-closed check; cross-company SSE test must fail.
- `SAB-M1-T6-BRIDGE`: remount `SSEPushBridge`; single-notification-source frontend test must fail.

#### M1.T7 — Remove Action triggers UI and security-only route cleanup

Deliverables:

- Remove Action triggers markup, types, query, mutation, icons, and loading/error dependency.
- Update page description to notifications-only wording.
- Keep backend Action Required behavior/data intact, except first-company fallback removal.
- Keep old route alias unless the UI owner explicitly changes it.

Acceptance criteria:

- Notification settings render without calling `/api/settings/action-required`.
- No Action triggers UI is present.
- Inbound SMS/missed-call Automation behavior is unchanged except the separately specified missed-call correctness fix.
- No unused frontend imports/variables.

Planned tests:

- focused page test owned jointly with the Claude UI lane
- existing settings navigation/completeness tests

Verify:

```bash
cd frontend && npm test
cd frontend && npm run build
npm test -- --runInBand --runTestsByPath tests/arConfigMigration.test.js tests/arTasksRegression.test.js
```

Sabotage minimum:

- `SAB-M1-T7-BACKEND-DELETE`: remove/rename the Action Required backend route or setting key; legacy regression test must fail.
- `SAB-M1-T7-PAGE-DEPENDENCY`: restore the Action Required fetch as the page loading gate; page test must fail.

#### M1.T8 — M1 integration, attack-only audit, and deploy gate

Acceptance criteria:

- All M1 focused suites pass together with `--runInBand` for DB suites.
- `T-own`, `T-foreign`, `T-blast`, and every R-matrix deny cell in §16 is green.
- Each named sabotage was proven by break -> focused red -> exact restore -> focused green.
- A fresh, separate attack-only review session audits tenant keys, role overrides, record scope, webhook natural keys, SSE payloads, and PII builders. It must not be the implementation session.
- Working tree contains no sabotage residue, temp files, servers, watchers, or background processes.

Verify:

```bash
npm test -- --runInBand --testPathPattern 'notification|pushSubscriptions|devicesApns|eventsRbacIsolation|realtimeSse|answered-call|missed-call|taskNotification'
cd frontend && npm test
cd frontend && npm run build
```

M1 owner gate: no deploy if any current company-broadcast notification path or record-bearing company-wide SSE publisher remains.

### M2 — Persistent in-app notification center

#### M2.T1 — Migration 222 and inbox projection

Acceptance criteria:

- One inbox row per `(company,event,user)` for effective `in_app` delivery.
- Existing M1 channels remain unchanged.
- Safe title/category/record reference only; no raw event payload.
- Access-revocation events hide now-inaccessible items.

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationInboxProjection.test.js tests/notificationInboxProjection.db.test.js
```

#### M2.T2 — Inbox APIs, unread count, mark-read/open, preview

Acceptance criteria:

- Exact §11 inbox contracts.
- Own user/company rows only.
- List and open perform live access checks; foreign/other-user IDs return 404.
- Unread count and mark-read are tenant/user scoped.
- Preview returns counts/reason codes only.

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationsInboxRoutes.test.js tests/notificationsInboxTenancy.db.test.js tests/notificationEligibilityPreview.test.js
```

#### M2.T3 — Claude-owned bell/inbox UI integration

Backend handoff is the §11 contract. Claude owns all markup and interactions. Backend implementer supports contract fixes only; no independent UI redesign.

Verify owner lane:

```bash
cd frontend && npm test
cd frontend && npm run build
```

M2 sabotage minimum:

- `SAB-M2-OPEN-RECHECK`: bypass live record re-check; revoked-assignment open test must fail.
- `SAB-M2-USER-COUNT`: remove `user_id` from unread count; two-user same-company test must fail.
- `SAB-M2-MARK-FOREIGN`: remove company/user from mark-read; foreign row unchanged test must fail.
- `SAB-M2-PREVIEW-PII`: include a user ID/name/destination in preview; schema/snapshot test must fail.

M2 owner gate: no deploy until M1 suites also pass unchanged.

### M3 — Staff email and SMS channels

#### M3.T1 — Migration 223 and verified destination APIs

Acceptance criteria:

- Email/SMS are opt-in only through existence of a verified active destination.
- Destination verification is tenant/member scoped and token/OTP replay-safe.
- Unverified/revoked destination cannot become effective.
- No endpoint API returns another user's full destination.

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationStaffEndpoints.test.js tests/notificationStaffEndpoints.db.test.js tests/notificationStaffEndpointRoutes.test.js
```

#### M3.T2 — Quiet hours and cost guard

Acceptance criteria:

- Company/user limits are checked atomically.
- Missing limit fails closed.
- Quiet hours use user/company timezone and handle overnight/DST boundaries.
- Deferred delivery carries a deterministic next-attempt timestamp.

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationQuietHours.test.js tests/notificationCostGuard.db.test.js
```

#### M3.T3 — Staff email/SMS delivery and loop prevention

Acceptance criteria:

- Only verified, opted-in, allowed destinations are sent.
- Notification-origin outbound does not emit a notification event.
- Staff SMS destination matching the company's active proxy number is blocked.
- No forbidden event supports SMS.
- M1 browser/native and M2 inbox behavior remain green.

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/staffNotificationDelivery.test.js tests/staffNotificationLoopPrevention.test.js tests/staffNotificationTenancy.db.test.js
```

M3 sabotage minimum:

- `SAB-M3-VERIFY`: force unverified endpoint active; verification gate test must fail.
- `SAB-M3-QUIET`: bypass quiet-hours calculation; overnight/DST test must fail.
- `SAB-M3-COST`: remove transactional cap claim; concurrent cap test must fail.
- `SAB-M3-LOOP`: remove notification-origin exclusion; recursive event test must fail.
- `SAB-M3-PROXY`: remove proxy-number block; same-company proxy test must fail.
- `SAB-M3-DEST-TBLAST`: remove company from normalized-destination lookup; shared destination T-blast must fail.

M3 owner gate: no deploy until destination verification, cost limits, quiet hours, and loop prevention are all configured and green in the target environment.

### M4 — Durable projector hardening

#### M4.T1 — Migration 224 and persistent scanner/lease

Acceptance criteria:

- Worker scans allowlisted domain events and claims `(company,event)` once.
- Worker takes company ID from the event row explicitly; it never assumes request context.
- Multiple workers use leases/atomic claims without duplicate logical work.
- Unknown event types are ignored/completed diagnostically, never dispatched.

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationProjector.test.js tests/notificationProjector.db.test.js
```

#### M4.T2 — Retry, replay, dead-letter, and observability

Acceptance criteria:

- Missing M1 in-process dispatch is discovered by the scanner.
- Transient failure retries with bounded backoff.
- Permanent policy/scope/no-destination outcomes do not retry indefinitely.
- Manual replay uses the same claim/delivery path.
- Metrics expose lag, pending/retry/dead counts by company without exposing payload PII.

Verify:

```bash
npm test -- --runInBand --runTestsByPath tests/notificationProjectorRecovery.test.js tests/notificationDeliveryRetry.test.js tests/notificationReplay.test.js
```

M4 sabotage minimum:

- `SAB-M4-SCAN-GAP`: disable the in-process subscriber, then disable the scanner; missed-event recovery test must fail.
- `SAB-M4-LEASE`: remove atomic lease condition; two-worker concurrency test must fail.
- `SAB-M4-DELIVERY-KEY`: remove company/event/user/channel uniqueness; replay duplicate test must fail.
- `SAB-M4-TENANT-SCAN`: remove company from projection/event join; same event/natural key T-blast must fail.
- `SAB-M4-CRASH-WINDOW`: terminate after provider acceptance before acknowledgment; recovery test must demonstrate the documented at-least-once behavior and no second logical delivery row.

M4 owner gate: deploy separately with worker concurrency initially one, observe lag/retry/dead metrics, then increase concurrency only after the owner reviews production behavior.

## 15. Cross-milestone test contract

Every company-scoped route, worker, webhook, SSE publisher, aggregate, and mutation receives:

- `T-own`: own company succeeds.
- `T-foreign`: foreign record/role/notification/event returns 404 and remains byte-unchanged.
- `T-blast`: seed companies A and B with the same endpoint, phone, email, SID, external ID, task key, idempotency key, and/or event aggregate as applicable; action in A leaves B byte-unchanged.
- `R-matrix`: one test per deny cell plus allow cells.
- Missing `company_id`: fail closed; no first-company fallback.
- Missing CRM user ID under assigned-only scope: no recipients.
- Live permission override/revoked membership: denied without restarting or cache expiry.
- Replay/concurrency: one logical delivery row per key.
- Payload safety: forbidden PII snapshot scan.

Mock-only tests that assert SQL substrings do not satisfy T-blast. At least one real-Postgres DB suite per milestone must seed both tenants, snapshot B, exercise the real service/route/worker, and prove B unchanged. If the DB is unavailable, the suite must visibly skip/fail by the repository's established convention; it must not report a false green.

## 16. Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET /api/settings/notifications` | `req.companyFilter.company_id` + `req.user.crmUser.id` | company + current user | active membership, own only | all active ✓ own; everyone ✗ other user | cross-user category/device status leak |
| `PATCH /api/settings/notifications/:category` | request company + `req.user.crmUser.id` | company + user + allowlisted category | active membership, own only | all active ✓ own; everyone ✗ other user | cross-user preference write; internal-category override |
| push subscription routes | request company + CRM user | company + user + endpoint | active membership, own only | all active ✓ own | endpoint shared/rebound across tenants |
| `resolveNotificationRecipients` subscriber | `event.company_id` explicit | company + domain event + aggregate/record | live catalog permission | office ✓ per permission; provider ✓ own only; inactive/foreign ✗ | company/role/record-wide fan-out |
| task due/overdue scheduler | explicit company per scanned task | company + task + due window | live `tasks.view` and scope | owner/author/manager ✓; others ✗ | cron has no request context; duplicate window |
| webhook producers | company resolved from authoritative account/SID binding | company + external natural key | system/webhook producer, then recipient permission | recipients per resolver | same SID/phone/external ID across tenants |
| Web Push/APNs delivery | delivery row company + user | company + user + endpoint/token | prior live recipient result | eligible user ✓; all others ✗ | company broadcast or token reassignment |
| company-wide SSE invalidation | producer company | company only; no record key in payload | `pulse.view` handshake | same-company stream ✓; foreign ✗ | any record/PII accidentally added to payload |
| future recipient-aware SSE | producer company + resolved user IDs | company + user + record | live record-view permission | eligible viewers ✓; others ✗ | stale connection authorization |
| `GET /api/notifications` | request company + current user | company + user + cursor | active membership + per-item live permission/scope | own accessible ✓; other/revoked ✗ | inbox leaks record IDs/history |
| `GET /api/notifications/unread-count` | request company + current user | company + user | active membership | own ✓; others ✗ | cross-user aggregate leak |
| `PATCH /api/notifications/:id/read` | request company + current user | company + user + notification | active membership, own only | own ✓; others ✗ | foreign mutation |
| `POST /api/notifications/:id/open` | request company + current user | company + user + notification + record | live catalog permission + record scope | own current access ✓; revoked/foreign ✗ | stale deep-link access |
| eligibility preview | request company | company + event + record | `tenant.company.manage` | admin/custom allow ✓; others ✗ | recipient/PII enumeration |
| endpoint verification APIs | request company + current user | company + user + destination hash/token | active membership, own only | own ✓ | email/phone natural-key collision |
| staff email/SMS worker | delivery row company + user | company + user + verified endpoint | live permission/scope + destination/guard | opted-in eligible ✓; others ✗ | paid fan-out, proxy loop |
| M4 projector worker | `domain_events.company_id` explicit | company + domain event | allowlisted event + live recipient checks | resolved users only | process-wide scan without tenant key |

### Default R-matrix

| Capability | tenant admin | manager | dispatcher | provider | custom role |
|---|---:|---:|---:|---:|---:|
| Edit company/role notification policy | ✓ | ✗ | ✗ | ✗ | only with `tenant.company.manage` |
| Edit own preferences/endpoints | ✓ | ✓ | ✓ | ✓ | active membership ✓ |
| Receive lead events | ✓ | ✓ | ✓ | ✗ | `leads.view` + role policy |
| Receive company-wide job events | ✓ | ✓ | ✓ | ✗ | `jobs.view` + `job_visibility=all` |
| Receive own-job job events | ✓ | ✓ | ✓ | ✓ assigned only | live scope |
| Receive active-contact message/call events | ✓ | ✓ | ✓ | ✓ active assigned job only | live scope |
| Receive financial notification | ✓ | ✓ | ✓ | ✓ own job only | `notifications.financial.receive` + parent scope |
| Receive task event | ✓ all | ✓ all | ✓ all | ✓ owner/author only | `tasks.manage` or owner/author |
| Receive system/Albusto billing event | ✓ | ✗ default | ✗ default | ✗ | `tenant.company.manage` + role policy |
| Eligibility preview | ✓ | ✗ | ✗ | ✗ | `tenant.company.manage` |

Permission note: migration 221 grants `notifications.financial.receive` to all four default roles because the approved audience includes office roles and own-job providers. The provider's `assigned_only` record scope is mandatory and is what prevents company-wide finance alerts. This permission does not make any financial REST route or UI visible.

## 17. Deploy, compatibility, and rollback gates

### M1

- Deploy migration and backend category API in the same release.
- Confirm category absence resolves enabled and explicit false is preserved across reapply.
- Confirm no call site remains for `sendPushToCompany` before deploy.
- Confirm all record-bearing SSE publisher tests pass before deploy.
- Keep manual `eventBus.redispatch` operator-only; never expose event ID replay without company authorization.

### M2

- Inbox table/API may deploy before the Claude-owned bell UI.
- Catalog exposes `in_app` only when projection and API are live.
- Rollback UI first, then backend/table only after preserving any required audit evidence.

### M3

- Email/SMS destinations cannot become active until provider configuration, verification, cost limits, and quiet hours are all ready.
- Default all existing users to no staff email/SMS destination, hence not opted in.
- Revoke/disable staff destinations before rollback.

### M4

- Start scanner concurrency at one.
- Observe lag, retry, dead-letter, and provider failure metrics.
- Disabling the worker reverts to M1 low-latency behavior without schema loss.

## 18. Risks and explicit engineering pushback

1. Exactly-once delivery across PostgreSQL and external push/email/SMS providers cannot be guaranteed. M4 provides one logical delivery and at-least-once attempts with best-effort transport dedupe.
2. M1's complete V1 producer set is large. It must still ship as one owner-gated security milestone because enabling delivery before scoped producers/dispatch would recreate the current unsafe state. Tasks M1.T1–T7 may be reviewed separately but are not independently deployable unless `producer_available=false` keeps incomplete events inert.
3. Converting SSE to invalidation/refetch increases REST traffic and may reduce instant inline updates. This is preferred to storing stale authorization on a long-lived SSE connection or continuing full DTO broadcasts.
4. The financial notification permission intentionally does not authorize financial details. Dispatcher payloads must remain generic and deep-link to an operational parent they may access, not to a forbidden payment ledger.
5. Removing global endpoint uniqueness permits the same browser endpoint to be bound separately to multiple company memberships. Every send/deactivation must therefore operate by row ID or full `(company,user,endpoint)` key.
6. Existing raw `eventService.logEvent` writers can create domain rows without subscriber dispatch. M1 converts V1 producers; M4 is the backstop for allowlisted events only.

## 19. Completion definition

NOTIF-REWORK-001 is complete only when:

- all four owner-gated milestones are deployed;
- no company-broadcast notification delivery remains;
- no record-bearing company-wide SSE payload remains;
- every V1 catalog entry truthfully reports producer availability and a stable category;
- all recipient decisions use live RBAC and canonical record scope;
- existing companies were not silently opted into new events or paid channels;
- persistent inbox access is rechecked;
- staff email/SMS verification, quiet hours, cost guards, and loop prevention are active;
- M4 replay demonstrates one logical delivery key under concurrency;
- every milestone's sabotage controls were proven red then restored green by exact edit;
- a separate attack-only review has accepted tenant, role, record, PII, and replay isolation.
