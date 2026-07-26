# MARKETPLACE-RATINGS-001 — ratings, moderated reviews, and human app copy

Status: backend implemented, not deployed
Date: 2026-07-26

## 1. Scope

This change adds:

- one cross-company rating/review per CRM user and Marketplace app;
- posted-only rating aggregates on the existing app catalog response;
- deterministic security screening, Gemini policy moderation, and manual
  platform-superadmin moderation;
- tenant-admin review submission/read/delete endpoints on the existing
  Marketplace router;
- a self-guarded platform moderation router ready for the authorized
  `/api/admin/app-reviews` bridge;
- authoritative human names/descriptions and `Free` pricing metadata for all
  19 published app identities.

Frontend implementation and the `src/server.js` bridge are intentionally
outside this backend patch.

## 2. Schema

Migration 204 creates `app_ratings`:

| column | contract |
|---|---|
| `id` | `BIGSERIAL` primary key |
| `company_id` | required FK to `companies`; tenant context at submission time |
| `app_key` | required text; deliberately not an FK |
| `user_id` | required FK to `crm_users` |
| `stars` | integer `1..5` |
| `comment` | nullable sanitized text, maximum 1000 characters |
| `status` | `posted`, `pending`, or `rejected` |
| `moderation_reason` | nullable text |
| `moderation_source` | nullable `security`, `llm`, or `manual` |
| `moderated_by` | nullable FK to the platform moderator's `crm_users.id` |
| timestamps | `created_at`, `updated_at` |

`UNIQUE(app_key, user_id)` is intentionally cross-company: a person has one
review per app. `company_id` is retained for audit and future company views.
Indexes `(app_key,status)` and `(status,created_at)` cover catalog aggregation
and the moderation queue.

## 3. Three-layer moderation

### 3.1 Deterministic security gate

The gate runs before Gemini or persistence.

- URLs are not accepted: `http(s)://`, `www.`, Markdown links, domain-looking
  text, and link-like `@handles` return HTTP 422
  `REVIEW_LINKS_NOT_ALLOWED`. No row is written.
- Prompt-injection markers (`ignore previous/above`, `disregard`, role
  prefixes/markers, `you are`, `prompt`, fenced code, and unusual control
  characters) are sanitized and persisted as `pending` with
  `moderation_source='security'`. Gemini is not called.
- Control characters are removed, whitespace is normalized, and stored
  comments are clamped to 1000 characters.

### 3.2 Gemini policy moderation

Clean non-empty comments go through the shared `generateJson` transport:

- provider: Gemini;
- immutable system prompt states that record text is untrusted evidence, never
  instructions;
- strict response: `{allow:boolean,reason?:string}`;
- strict `allow=true` posts the review;
- deny or uncertain output queues `pending/llm`;
- missing key, timeout, quota/429, malformed output, or any provider exception
  fails closed to `pending/llm`.

Environment:

| variable | default |
|---|---|
| `GEMINI_API_KEY` | required for automated allow decisions |
| `MARKETPLACE_REVIEW_MODERATION_MODEL` | `gemini-2.5-flash-lite` |
| `MARKETPLACE_REVIEW_MODERATION_FALLBACK_MODEL` | `gemini-2.5-flash` |
| `MARKETPLACE_REVIEW_MODERATION_TIMEOUT_MS` | `15000` |
| `MARKETPLACE_REVIEW_MODERATION_RETRY_MAX` | `1` |

A stars-only review posts immediately because there is no text to moderate.
Resubmission uses the same full pipeline and upserts the existing row.

### 3.3 Manual platform moderation

The self-guarded `platformAppReviews` router requires
`platform_role='super_admin'`. Approve/reject sets `moderation_source='manual'`,
the new status, optional reason, and `moderated_by`.

The router is ready for this authorized bridge, which Claude owns:

```js
app.use(
  '/api/admin/app-reviews',
  authenticate,
  requirePlatformRole('super_admin'),
  platformAppReviewsRouter
);
```

The router repeats the platform-role guard internally, so an incomplete future
mount fails closed.

## 4. Exact tenant API contract

All routes below inherit the existing production mount:

```text
authenticate
→ requirePermission('tenant.integrations.manage')
→ requireCompanyAccess
→ marketplace router
```

The default role matrix therefore allows `tenant_admin`; manager, dispatcher,
and provider are denied unless a company explicitly grants the catalog
permission.

### 4.1 `GET /api/marketplace/apps`

Response:

```json
{
  "success": true,
  "apps": [
    {
      "id": 1,
      "app_key": "vapi-ai",
      "name": "AI Receptionist",
      "provider_name": "Blanc Labs",
      "category": "telephony",
      "app_type": "internal",
      "short_description": "...",
      "long_description": "...",
      "logo_url": null,
      "docs_url": null,
      "support_email": null,
      "privacy_url": null,
      "requested_scopes": [],
      "access_summary": [],
      "provisioning_mode": "none",
      "status": "published",
      "metadata": {
        "pricing": {
          "paid": false,
          "label": "Free",
          "text": "Free — included with your Albusto plan."
        }
      },
      "avg_rating": 4.5,
      "rating_count": 2,
      "installation": {
        "id": 10,
        "status": "connected",
        "installed_at": "2026-07-26T12:00:00.000Z",
        "disconnected_at": null,
        "provisioning_error": null,
        "last_used_at": null
      }
    }
  ],
  "request_id": "..."
}
```

`installation` is nullable. `avg_rating` is `null` when no posted rating exists;
otherwise it is a number rounded to two decimal places. `rating_count` is an
integer. Both aggregate across companies and count only `status='posted'`.

### 4.2 `POST /api/marketplace/apps/:appKey/rating`

Request:

```json
{
  "stars": 1,
  "comment": "Optional review text, maximum stored length 1000"
}
```

`stars` is required integer `1..5`; `comment` is optional string/null.

Success response:

```json
{
  "success": true,
  "status": "posted",
  "review": {
    "id": 12,
    "app_key": "vapi-ai",
    "stars": 5,
    "comment": "Works well.",
    "status": "posted",
    "moderation_reason": null,
    "moderation_source": null,
    "created_at": "2026-07-26T12:00:00.000Z",
    "updated_at": "2026-07-26T12:00:00.000Z"
  },
  "request_id": "..."
}
```

`status` is `posted` or `pending`. For a pending result,
`moderation_source` is `security` or `llm`, and `moderation_reason` is a
human-readable reason.

Link rejection:

```json
{
  "success": false,
  "code": "REVIEW_LINKS_NOT_ALLOWED",
  "message": "Links and social handles are not allowed in Marketplace reviews.",
  "request_id": "..."
}
```

HTTP status is 422.

### 4.3 `GET /api/marketplace/apps/:appKey/reviews`

Response:

```json
{
  "success": true,
  "app_key": "vapi-ai",
  "reviews": [
    {
      "id": 12,
      "app_key": "vapi-ai",
      "stars": 5,
      "comment": "Works well.",
      "status": "posted",
      "reviewer_first_name": "Alex",
      "is_mine": false,
      "created_at": "2026-07-26T12:00:00.000Z",
      "updated_at": "2026-07-26T12:00:00.000Z"
    }
  ],
  "request_id": "..."
}
```

The array contains all posted reviews across companies plus the viewer's own
review even when it is pending or rejected. Other users' pending/rejected
reviews never appear. No company id, user id, email, moderation reason, or
moderation source is exposed here.

### 4.4 `DELETE /api/marketplace/apps/:appKey/rating`

Response:

```json
{
  "success": true,
  "deleted": true,
  "request_id": "..."
}
```

`deleted=false` is an idempotent success when the actor has no review. Deletion
uses `company_id + user_id + app_key`.

Common errors use:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR | APP_NOT_FOUND | REVIEWER_CONTEXT_INVALID | INTERNAL_ERROR",
  "message": "...",
  "request_id": "..."
}
```

## 5. Exact platform API contract

### 5.1 `GET /api/admin/app-reviews`

Query:

- `status=pending|posted|rejected`, default `pending`;
- `page`, positive integer, default `1`;
- `limit`, positive integer, default `25`, maximum `100`.

Response:

```json
{
  "ok": true,
  "reviews": [
    {
      "id": 12,
      "app_key": "vapi-ai",
      "app_name": "AI Receptionist",
      "stars": 1,
      "comment": "Review text",
      "status": "pending",
      "moderation_reason": "Manual review required.",
      "moderation_source": "llm",
      "reviewer_first_name": "Alex",
      "company_id": "uuid",
      "company_name": "ABC Homes",
      "moderated_by": null,
      "moderator_first_name": null,
      "created_at": "2026-07-26T12:00:00.000Z",
      "updated_at": "2026-07-26T12:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 25,
  "trace_id": "..."
}
```

### 5.2 `POST /api/admin/app-reviews/:id/moderate`

Request:

```json
{
  "action": "approve",
  "reason": "Optional moderator note, maximum 1000 characters"
}
```

`action` is exactly `approve` or `reject`.

Response:

```json
{
  "ok": true,
  "review": {
    "id": 12,
    "app_key": "vapi-ai",
    "app_name": "AI Receptionist",
    "stars": 1,
    "comment": "Review text",
    "status": "posted",
    "moderation_reason": "Approved manually.",
    "moderation_source": "manual",
    "reviewer_first_name": "Alex",
    "company_id": "uuid",
    "company_name": "ABC Homes",
    "moderated_by": "moderator-crm-user-uuid",
    "moderator_first_name": "Sam",
    "created_at": "2026-07-26T12:00:00.000Z",
    "updated_at": "2026-07-26T12:01:00.000Z"
  },
  "trace_id": "..."
}
```

Platform errors use `{ok:false,code,message,trace_id}`.

## 6. Tenancy & Roles

| surface | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET /api/marketplace/apps` | installation overlay from `req.companyFilter.company_id`; rating aggregate deliberately global | `company_id`, global `app_key` | `tenant.integrations.manage` | tenant_admin ✓; manager/dispatcher/provider ✗ by default | an unscoped installation join would leak tenant state; aggregate is intentionally cross-company |
| `POST .../:appKey/rating` | `req.companyFilter.company_id` + authenticated `crm_users.id` + active membership/company | `company_id`, `user_id`, `app_key` | `tenant.integrations.manage` | tenant_admin ✓; others ✗ by default | foreign actor/company pairing must not write; upsert repeats active tenant joins |
| `GET .../:appKey/reviews` | active viewer membership; posted rows global; non-posted constrained to viewer id | global `app_key`, own `user_id` | `tenant.integrations.manage` | tenant_admin ✓; others ✗ by default | another user's pending/rejected review must never appear |
| `DELETE .../:appKey/rating` | explicit company + actor | `company_id`, `user_id`, `app_key` | `tenant.integrations.manage` | tenant_admin ✓; others ✗ by default | foreign review must remain byte-unchanged |
| `GET /api/admin/app-reviews` | intentional platform-wide queue | status + pagination | platform role `super_admin` | super_admin ✓; all tenant roles ✗ | global review/company identity is visible only to platform moderator |
| `POST .../:id/moderate` | intentional platform-wide mutation; active superadmin rechecked by CRM id | review id + moderator id | platform role `super_admin` | super_admin ✓; all tenant roles ✗ | missing guard would expose every tenant's reviews |
| rating aggregate | intentional cross-company product aggregate | `app_key`, `status='posted'` | through Marketplace list | same as list | pending/rejected inclusion would publish unmoderated content |

## 7. Authoritative copy and pricing

Migration 205 updates exactly the 19 approved `app_key` values without changing
provider or key. It overwrites only name, short description, long description,
and `metadata.pricing`, preserving `metadata.assistant` and every other metadata
key. Pricing shape is always:

```json
{"paid": false, "label": "Free", "text": "<approved per-app line>"}
```

The SQL is intentionally the highest-numbered authoritative content migration
and is replayed after all older app seeds and migration 173. Deployment must be
from master containing 205; an older branch can still replay stale seed copy.

Rollback 205 removes the pricing block but deliberately retains the safer human
display copy rather than recreating the known replay regression.

## 8. Verification

Unit/routes/RBAC:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/marketplaceRatingsService.test.js tests/marketplaceReviewModerator.test.js tests/platformAppReviews.test.js tests/marketplaceRatingsRbac.test.js tests/routes/marketplace.test.js tests/services/marketplaceService.test.js
```

Prod-shaped PostgreSQL:

```bash
DATABASE_URL=postgresql://... env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/marketplaceRatings.db.test.js
```

The DB suite is a release blocker: an unavailable database produces a failing
sentinel rather than a false green skip.

Recorded worktree results:

- complete Marketplace unit/route/RBAC regression batch: 12 suites, 111 tests,
  exit 0;
- prod-shaped PostgreSQL suite: 1 suite, 10 tests, exit 0;
- tenant-safety rules: line rules, write scope, natural keys, no-request
  context, and route permission all passed. The three SQL rules were run
  separately because this repository's static parser rescans the full backend
  for each rule (about 70–76 seconds per rule).
