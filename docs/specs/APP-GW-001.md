# APP-GW-001 — App Studio Phase 1 read-only gateway

Status: **IMPLEMENTED — pending fresh attack-only review.**

Parent contract: `docs/specs/APP-STUDIO-001.md`, especially §3 (gateway), §5
(minimum controls), and §6 (data). This specification narrows that architecture
to the Phase 1 CRM-side gateway. It does not change the owner-approved scope.

## 1. DECISIONS NEEDED

No open implementation decisions.

## 2. DECISIONS TAKEN

**D1 — protected runtime mounts:** the architect authorized exactly two router
requires and two router mounts in `src/server.js`, with no other runtime-shell
change.

**D2 — authoritative installation-consent storage:** Phase 1 stores the
narrowing snapshot in `marketplace_installations.metadata.app_runtime`:

```json
{
  "version_id": "<uuid>",
  "consented_tools": ["svc.list_jobs", "svc.get_job", "svc.list_tasks"]
}
```

Malformed/missing metadata is no consent and can never widen
`app_version_tools`. Any writer must initialize the `app_runtime` parent before
using nested `jsonb_set`; otherwise PostgreSQL silently no-ops. A normalized
consent table will be reconsidered at Ф6, when runtime writes and money enter
scope.

The remaining items are direct consequences of the approved contract and
repository seams, not new product choices.

1. The Phase 1 catalog is exactly `svc.list_jobs`, `svc.get_job`, and
   `svc.list_tasks`. No Contacts, Calls, Finance, Messages, transitions, generic
   MCP skills, write handlers, delivery tools, or URL/fetch tool exists.
2. The HTTP body is the tool arguments object itself. It must be a JSON object;
   query parameters and unknown outer wrappers are rejected.
3. Tenant-selector rejection happens before any sanitizer or dispatch. Keys
   normalized to `companyid`, `tenantid`, `organizationid`,
   `organisationid`, or `workspaceid` are rejected at any body depth with
   `TENANT_SELECTOR_FORBIDDEN`. They are never ignored or stripped.
4. The gateway uses the three existing strict descriptors from
   `agentSkillsMcpRegistry` and the existing `crmMcpSchemaValidator`; it does
   not duplicate their argument schemas.
5. The gateway does not call `agentSkillsMcpExecutor.execute`. That executor is
   bound to ChatGPT-MCP identity, permits many more dispatcher tools, strips
   top-level tenant selectors, and writes `mcp_tool_invocations`. A small
   app-runtime executor will reuse the descriptor, validator, live authorization
   concepts, and `chatgptMcpReadService.execute` data seam.
6. Run tokens are dedicated HS256 JWTs signed with
   `APP_RUNTIME_RUN_TOKEN_SECRET` (minimum 32 bytes), algorithm-pinned, with no
   implicit `iat`. Their payload contains exactly `installation_id`,
   `version_id`, `run_id`, `exp`, and `nonce`. Default/max TTL is 300 seconds.
7. Nonces are random 256-bit base64url values; only their SHA-256 digest is
   stored. A token is reusable during one run, subject to the five-call run
   ceiling. The nonce is a revocation/binding value, not a one-request nonce.
8. Phase 1 performs the kill-state DB lookup on every call (zero-second cache,
   therefore within the ≤30-second contract). No cross-request authorization or
   revocation cache is introduced.
9. Every token-resolved attempt is synchronously audited before a success/error
   body is released. Audit storage failure returns a sanitized 503 and never
   releases tool data. Missing/bad-signature traffic has no trustworthy
   app/installation identity and is bounded by the unauthenticated IP limiter;
   unverified JWT claims are never copied into tenant audit rows.
10. Every successful result passes through `pulseMaskingService.getMaskViewer`
    and `redactPulsePayload` using the live delegator permissions and the
    installation-derived company context.
11. Initial resource controls are five gateway attempts per run and 60 requests
    per installation per minute, both configurable only downward/upward by
    server environment. The per-run limit is persisted and consumed atomically;
    the per-installation limiter follows the existing ChatGPT-MCP limiter pattern.
12. No Marketplace catalog row is seeded or changed by this phase, so the
    `metadata.assistant` migration rule is not triggered.

## 3. Phase 1 boundary

### In scope

- One POST gateway route with a path-selected, exact tool name.
- Short-lived run-token verification and DB-bound runtime identity.
- One `crm_users.kind='agent'` principal per Marketplace installation.
- Live delegator RBAC, provider scope, Tasks content scope, installation consent,
  version tool allowlist, and active-state intersection on every call.
- Recursive tenant-selector rejection and strict JSON-schema validation.
- Shared response masking.
- Awaited `audit_log` entry for every token-resolved attempt.
- Per-installation rate limiting and per-run call ceiling.
- Internal token-minting service used by tests plus an explicitly enabled,
  super-admin-only development route.
- A hand-authored reference client that invokes only the three gateway tools.

### Explicitly out of scope

- A runner, isolate, trigger, scheduler, app storage, builder, source execution,
  network/egress proxy, public token issuance, public Marketplace publishing UI,
  writes, sends, Contacts, Calls, Finance, Messages, or payment tools.
- Tool discovery over this HTTP surface. The reference client knows the three
  approved names.
- Changes to ChatGPT-MCP behavior or migration of Avatars onto this gateway.
  Phase 1 creates the reusable seam; migration is later work.
- A distributed rate-limit store. The current CRM runtime is single-instance;
  horizontal scaling requires a shared store before rollout.

## 4. Repository seam map

| Concern | Existing seam | Phase 1 use / reason |
|---|---|---|
| ChatGPT token auth | `backend/src/middleware/chatgptMcpAuth.js` | Pattern only. It verifies Keycloak RS256 connector tokens and resolves `chatgpt_mcp_bindings`; app runs need a dedicated secret, strict five-claim payload, and `app_runs` binding. |
| Agent identity | `backend/src/services/chatgptMcpIdentityService.js` | Mirror `activateAvatarUser`, active installation/company/user/member joins, `resolveLiveBinding`, and live `authorizationService` call. Do not reuse ChatGPT tables or static grants. |
| Live RBAC | `backend/src/services/authorizationService.js` | Reuse `resolveCompanyUserAuthz(companyId, delegatorId)` on every call. It has no cross-request cache and returns role, effective permissions, and effective scopes for the selected company. |
| Tool catalog | `backend/src/services/agentSkillsMcpRegistry.js` | Resolve only the three exact dispatcher descriptors. Each is `kind='read'`, has a named read handler, and has `additionalProperties:false`. Fail startup/tests if any property drifts. |
| Schema validation | `backend/src/services/crmMcpSchemaValidator.js` | Reuse after tenant-key rejection. It enforces required fields, types, date formats, bounds, and unknown-key rejection. |
| MCP authorization | `backend/src/services/mcpToolAuthorization.js` | Reuse permission-map concepts, not `sanitizeArguments`: that function deletes `company_id`/`companyId`, which violates this gateway's reject contract. The app version allowlist replaces ChatGPT's `mcp.tool.*` static grant. |
| Read execution | `backend/src/services/chatgptMcpReadService.js` | Reuse handlers `listJobs`, `getJob`, `listTasks`. It derives provider scope from the live human ID/scopes, applies `tasks.manage` content widening, requires company context, returns 404 for invisible Job detail, and strips provider blobs/capability tokens. |
| Jobs record scope | `jobsService.listJobs/getJobById` + `providerScope.resolveProviderScope` | Pass the delegator ID, never the agent ID. Only exact `job_visibility='all'` widens; missing/unknown values remain assigned-only. |
| Tasks content scope | `chatgptMcpReadService` + `tasksQueries.listTasksPage` | `tasks.manage` sees all company Tasks; otherwise scope to Tasks owned/authored by the delegator. An absent actor must fail closed. |
| Masking | `backend/src/services/pulseMaskingService.js` | Use `getMaskViewer(req)` once per request, then `redactPulsePayload` at the final response boundary for all three tools. Resolver/settings failure redacts. |
| Audit | `audit_log`, `auditService.js`, `crmWriteAuditService.js`, ChatGPT `recordInvocation` | `auditService.log` deliberately swallows insert errors and ChatGPT logs to `mcp_tool_invocations` after dispatch, so neither satisfies this contract. Add an awaited, throwing app-runtime audit writer targeting `audit_log`. |
| Rate limit | `backend/src/middleware/chatgptMcpRateLimit.js` | Mirror its authenticated-key isolation, `Retry-After`, and unauthenticated IP guard. The trusted key is installation ID, so multiple run tokens for one installation share a budget. |
| Marketplace | migration 083 + `marketplaceQueries`/`marketplaceService` | Reuse app/installation rows and connected/disconnect lifecycle. Extend disconnect to revoke/disable an app-runtime principal when one exists. |
| Runtime mount | `src/server.js` | No existing `/internal/app-runtime` or `/api/platform/app-runtime` mount. D1 is required because this file is protected. |

Current local `origin/master` and the worktree both end at migration 218
(`218_sms_conversations_tenant_isolation.sql`). This does **not** reserve 219.
At implementation time, determine `N = max(origin/master, worktree) + 1` again and
create both `N_*.sql` and `rollback_N_*.sql`.

## 5. HTTP contract

### 5.1 Tool call

```http
POST /internal/app-runtime/v1/tools/svc.get_job
Authorization: Bearer <run-token>
Content-Type: application/json

{"job_id": 123}
```

Success:

```json
{
  "ok": true,
  "data": { "id": 123 },
  "request_id": "app-gw-..."
}
```

The route accepts no query parameters. Maximum JSON body size is 32 KiB. The
path value must be an exact catalog key; it is never treated as a URL, module,
handler name, or arbitrary registry lookup outside the three-name projection.

### 5.2 Stable failures

| HTTP | code | condition |
|---:|---|---|
| 400 | `INVALID_REQUEST` | body is not an object, query parameters exist, invalid JSON envelope |
| 400 | `TENANT_SELECTOR_FORBIDDEN` | any tenant-identifier key appears in the body |
| 401 | `APP_RUNTIME_AUTH_REQUIRED` | missing/malformed bearer token |
| 401 | `APP_RUNTIME_TOKEN_INVALID` | bad signature/algorithm/claim shape/nonce binding |
| 401 | `APP_RUNTIME_TOKEN_EXPIRED` | expired token or expired run |
| 403 | `APP_RUNTIME_INACTIVE` | app/company/installation/version/run/principal/delegator chain is inactive or revoked |
| 403 | `TOOL_NOT_CONSENTED` | tool absent from version allowlist or installation consent |
| 403 | `ACCESS_DENIED` | live delegator lacks the business permission |
| 404 | `TOOL_NOT_FOUND` | path is not one of the three Phase 1 catalog names |
| 404 | `NOT_FOUND` | Job is foreign, missing, or outside live provider scope |
| 422 | `INVALID_ARGUMENTS` | existing tool schema rejects arguments |
| 429 | `RATE_LIMITED` / `RUN_CALL_LIMIT` | per-installation window or five-call run ceiling reached |
| 503 | `AUDIT_UNAVAILABLE` | required audit row cannot be persisted |

Errors are sanitized and never reveal whether a foreign company, installation,
version, run, principal, Job, or Task exists.

## 6. Identity, token, and live authority

### 6.1 Principal provisioning

`appRuntimeIdentityService.provisionInstallationPrincipal({ installationId },
client)` is internal and transaction-required. It accepts no company ID and:

1. Locks the installation, joins its Marketplace app, and derives `company_id`,
   `app_id`, and `installed_by` from the row.
2. Requires published app, connected installation, active company, active human
   installer, and active membership in that exact company.
3. Idempotently creates/reactivates one agent with synthetic subject
   `agent:app-runtime:<installation_id>` and an Albusto-invalid email.
4. Creates/updates the one principal binding for that installation. The agent
   receives no `company_memberships` row and no `mcp_agent_permission_grants`.
5. If an old conflicting agent cannot be safely reused, fails with 409 rather
   than taking over a human or foreign-company identity.

Disconnect/revoke marks the principal revoked and disables the agent in the
same Marketplace transaction. Even if that cleanup fails to run, the live
gateway join rejects the non-connected installation.

### 6.2 Minting

`appRuntimeTokenService.mintRunToken({ installationId, versionId, ttlSeconds })`
is an internal service used directly by tests and by the dev route. It:

- derives all tenant/app/delegator fields through the installation;
- provisions/resolves the principal transactionally;
- requires version/app match, version `published`, installation consent for the
  exact version, and at least one allowed+consented Phase 1 tool;
- creates a UUID `app_runs.id`, nonce digest, five-call ceiling, and expiry;
- signs the exact five-claim token only after the transaction commits;
- returns the raw token once; no raw token/nonce is logged or persisted.

### 6.3 Per-call resolution

After signature/claim validation, one company-scoped query resolves and checks:

```text
token run_id + installation_id + version_id + nonce digest
  -> active, unexpired app_runs row
  -> matching active app_installation_principals row and active agent
  -> connected marketplace_installations row
  -> published marketplace_apps row
  -> published app_versions row belonging to that app
  -> active companies row
  -> installed_by == delegated_by_user_id
  -> active human crm_users row
  -> active same-company company_memberships row
```

`company_id` is selected only from that installation chain and then assigned to
`req.companyFilter.company_id`. It is not present in the token and is never read
from body, path, query, header, dev-route input, or process defaults.

The bootstrap resolver is still relationally company-scoped: its root predicate
uses the globally unique run/install/version/nonce tuple, and every joined
company-owned table has an explicit `joined.company_id = installation.company_id`
predicate (plus app/install/version/principal equalities). After that one
identity-resolution query, every SQL call receives and filters the resolved
company explicitly. No query uses a run, installation, principal, agent, Job,
or Task ID alone.

The service then calls
`authorizationService.resolveCompanyUserAuthz(companyId, delegatedByUserId)`
for current role, effective permissions, and scopes. There is no permission
snapshot in the token or principal.

## 7. Authorization intersection and dispatch

A call proceeds only if every factor is true:

1. The path name is in the hard Phase 1 set.
2. The current shared-registry descriptor exists, is `kind='read'`, has the
   expected handler, uses a strict object schema, and exposes no URL field.
3. `app_version_tools` contains the name for the token's published version.
4. The installation's consent snapshot contains the same version and name.
5. The full company/app/installation/version/run/principal/delegator chain is
   active now.
6. The live delegator has `jobs.view` for Jobs list/detail or `tasks.view` for
   Tasks list.
7. The canonical record/content scope allows the returned row.

No factor can grant what another factor denies. In particular, a forged token,
principal status, Marketplace requested-scope cache, old role snapshot, agent
permission, or installation metadata alone cannot authorize a tool.

The request pipeline is fixed:

1. assign request ID and enforce transport/body-size shape;
2. cryptographically verify the exact run-token claims;
3. resolve the live DB chain and installation-derived company;
4. resolve the delegator's live effective permissions and scopes;
5. consume the per-installation/per-run attempt budget;
6. reject tenant keys anywhere in the body;
7. resolve the exact catalog/version/consent intersection, validate the strict
   argument schema, enforce its live business permission, and dispatch;
8. apply masking, persist the awaited outcome audit, then release the response.

Thus a still-valid token never reaches a tool using mint-time RBAC, including
when the eventual outcome is rate-limit, schema, consent, or scope denial.

Dispatch calls only:

| gateway tool | registry handler | live business permission | record/content scope |
|---|---|---|---|
| `svc.list_jobs` | `listJobs` | `jobs.view` | `job_visibility`; exact `all` is tenant-wide, otherwise assigned-only using delegator ID |
| `svc.get_job` | `getJob` | `jobs.view` | same Job scope; foreign/unassigned/missing is 404 |
| `svc.list_tasks` | `listTasks` | `tasks.view` | `tasks.manage` widens; otherwise owner/author scope using delegator ID |

The app-runtime executor passes a context containing installation-derived
company ID and live human owner identity to `chatgptMcpReadService.execute`.
It never passes the app agent ID as a provider/content-scope user.

## 8. Masking and audit

### 8.1 Masking

Before any success response is sent:

1. Put live delegator permissions in `req.authz.permissions`, the derived
   company in `req.companyFilter.company_id`, and the agent in
   `req.user.crmUser`.
2. Await `pulseMaskingService.getMaskViewer(req)` once.
3. Apply `redactPulsePayload(result, maskViewer)` to the entire payload.

An active `call_masking.use` grant plus active company masking settings removes
phone-bearing keys recursively. Unknown auth/settings state fails closed to
redaction. The gateway may not implement a local phone-field list.

### 8.2 Audit

Migration `N` adds nullable, indexed app-runtime linkage columns to `audit_log`:
`app_id`, `installation_id`, and `app_run_id`, with composite constraints tying
the run/installation/company/app together. Existing non-app audit rows remain
valid with null linkage.

One awaited `app_runtime.tool_call` row is written for every token-resolved
attempt, including success, schema/tenant-key denial, unknown/unconsented tool,
RBAC/scope denial, not-found, run-limit, and installation-rate-limit outcomes.

- `actor_id` is the installation agent `crm_users.id`.
- `company_id`, `app_id`, `installation_id`, and `app_run_id` come from the live
  DB context.
- `target_type='app_runtime_tool'`, `target_id=<toolName>`.
- `details` contains only `version_id`, outcome, safe error code, response class,
  and run call ordinal. It contains no arguments, search text, record IDs,
  response data, token, nonce, PII, or secrets.
- `trace_id` is the gateway request ID.

The audit insert occurs after the result/error is known but before the response
is released. `auditService.log()` is not used because it catches and suppresses
database failure.

## 9. Data migration contract

At implementation time choose fresh migration number `N` and ship a matching,
idempotent `rollback_N_*.sql`.

### `app_versions` (minimal Phase 1 artifact identity)

- UUID primary key; `app_id` FK; unique `(app_id, version_number)`.
- `source_code`, lowercase 64-hex `source_sha256`, scanner report JSONB.
- full parent-contract status check:
  `draft|submitted|in_review|approved|published|revoked`.
- creator/reviewer timestamps and nullable CRM-user FKs.
- unique `(app_id, id)` for composite downstream FKs.
- service validation requires `source_sha256` to match `source_code`; a DB
  trigger prevents changing source/hash/version identity after the version
  leaves `draft`. Status changes remain explicit transitions, never an artifact
  rewrite in place.

The gateway reads artifact identity/status only; it never loads or executes
`source_code` in Phase 1.

### `app_version_tools`

- `(version_id, tool_name)` primary key plus created timestamp.
- only source that can grant a version tool; `marketplace_apps.requested_scopes`
  remains display-only.
- a DB trigger prevents UPDATE/DELETE/INSERT mutations once the parent version
  is no longer `draft`; version publication is therefore hash/tool-list pinned.
- Phase 1 service validation also rejects names outside the exact three-tool set.

This table is required even though the brief's parenthetical lists the other
three tables: without it, the §3 approved-version allowlist and §6
single-source-of-rights invariant cannot be implemented.

### `app_installation_principals`

- UUID primary key plus `company_id`, `app_id`, `installation_id`,
  `agent_user_id`, `delegated_by_user_id`, status/revocation timestamps.
- one binding per installation; same-company composite FKs to installation and
  agent; indexed delegator; active/revoked status check.
- no permissions or scopes are stored here.

### `app_runs` skeleton

- UUID primary key (the token `run_id`) plus `company_id`, `app_id`,
  `installation_id`, `version_id`, and `principal_id` composite linkage.
- pinned `artifact_sha256`, nonce digest, issued/expiry/revocation timestamps, status
  `issued|exhausted|revoked`, `gateway_calls_used`, and
  `gateway_call_limit DEFAULT 5 CHECK > 0`.
- an atomic conditional update consumes one call only while active, unexpired,
  nonce-matched, and below the ceiling.
- no input/output/error bodies or runner resource measurements in Phase 1.

### Rollback

Rollback drops new audit FKs/columns and app-runtime tables in dependency order,
then drops only indexes/functions/triggers owned by this migration. It does not
delete Marketplace apps/installations, unrelated `crm_users`, or existing
`audit_log` rows. A forward → rollback → forward real-PostgreSQL test is required.

## 10. Tenancy & Roles

| surface | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `POST /internal/app-runtime/v1/tools/svc.list_jobs` | company selected from token-bound installation DB row | installation/run/version/nonce; Job filters are non-authoritative | `jobs.view` | tenant_admin ✓ all; manager ✓ all; dispatcher ✓ all; provider ✓ assigned only; custom without `jobs.view` ✗ | Unscoped Job list/search could return B rows sharing job number, phone, email, or search text. |
| `POST /internal/app-runtime/v1/tools/svc.get_job` | same | numeric Job ID plus company/provider predicate | `jobs.view` | tenant_admin/manager/dispatcher ✓ own-company; provider ✓ assigned and ✗ unassigned (404); custom without permission ✗ | ID-only lookup could disclose B or an unassigned Job. |
| `POST /internal/app-runtime/v1/tools/svc.list_tasks` | same | installation/run plus company query; owner/author content predicate | `tasks.view`; `tasks.manage` widens | tenant_admin/manager/dispatcher ✓ all; provider ✓ own/authored and ✗ others; custom without `tasks.view` ✗ | Unscoped list/search or missing content predicate could disclose B/teammate Task text. |
| run-token mint service | installation row only; no request company accepted | installation ID + published version ID | internal caller only | no human HTTP role | A caller-supplied company or cross-app version could mint a B token. |
| `POST /api/platform/app-runtime/dev-tokens` | installation row only | global installation/version IDs | platform `super_admin`; explicit dev env enable | super_admin ✓ only while enabled; every tenant role ✗ | Missing platform/env gate would become public token issuance. |
| principal provision/revoke | installation row and same-company composite FKs | installation ID | internal transaction | no direct human route | Principal reuse/mismatch could let one installation act as another company. |
| audit row | live runtime context | app/install/run composite linkage | internal | n/a | An unscoped/misattributed row defeats incident response and future bulk rollback. |
| per-installation limiter | verified installation ID | installation ID | valid runtime context | n/a | IP/run-token keys let token rotation evade the installation budget or let A exhaust B. |

Fixed roles all hold `jobs.view` and `tasks.view` in migration 050. Their deny
cells are therefore record/content-scope cells, not invented role-name denials.
Permission-deny coverage uses a custom role or user-level deny override. Checks
derive from effective permissions, never a role-name allowlist.

## 11. IMPLEMENTATION TASKS

### T1 — migration and rollback

**Work:** re-read local `origin/master` and worktree migration maxima; create
fresh migration `N`/rollback; add the four runtime tables, audit linkage,
constraints, indexes, and published-version tool immutability.

**Acceptance:** migration applies twice idempotently; forward → rollback →
forward succeeds; composite FKs reject cross-company/cross-app wiring; published
tool rows cannot be mutated; existing Marketplace/audit/MCP rows survive; no
Marketplace seed is changed.

### T2 — exact runtime catalog and request validation

**Work:** add a three-name `appRuntimeToolCatalog` projection over
`agentSkillsMcpRegistry`; add recursive tenant-key rejection and reuse
`crmMcpSchemaValidator` without using the MCP sanitizer.

**Acceptance:** catalog is exactly three read/handler descriptors with strict
schemas; every other registry name and URL-like path is 404; invalid/unknown
arguments are 422; any tenant selector at any depth is 400 and dispatch is not
called; no arbitrary URL is accepted or fetched.

### T3 — per-installation principal lifecycle

**Work:** implement transaction-required provision/resolve/revoke service based
on the ChatGPT identity pattern; integrate safe revocation into Marketplace
disconnect; never create a membership or static MCP grant.

**Acceptance:** one installation produces one active same-company agent;
repeat provisioning is idempotent; A/B installation/agent/delegator mismatches
fail; human identity conflicts fail 409; disconnect disables the agent and
revokes the binding; agent `created_by` FK shape is valid.

### T4 — token minting and live run authentication

**Work:** implement dedicated secret configuration, exact-claim JWT mint/verify,
nonce hashing, `app_runs` creation, atomic call consumption, and the zero-cache
active-chain resolver.

**Acceptance:** missing secret fails startup/use closed; wrong algorithm,
signature, extra/missing/wrong-type claim, nonce, installation/version/run
mismatch, expiry, and >300-second request are denied; raw token/nonce is stored
nowhere; an already-minted token dies on the next call after any run, principal,
agent, version, installation, app, company, delegator, or membership revocation.

### T5 — live permission/consent executor

**Work:** compute the seven-factor intersection; resolve human authorization on
every call; build the trusted request/read context; dispatch only the three
`chatgptMcpReadService` handlers.

**Acceptance:** version allowlist and installation consent each independently
narrow access; static agent grants cannot widen it; live permission deny is 403;
manager→provider demotion immediately narrows Jobs to assigned and Tasks to
owned/authored without reminting; a live deny override immediately blocks the
relevant tool; missing/unknown provider scope fails restrictive.

### T6 — masking and fail-closed audit

**Work:** apply the shared masking viewer/projector at the final response seam;
add a throwing app-runtime audit writer and one audit outcome per
token-resolved attempt.

**Acceptance:** masked Jobs payloads contain no customer/proxy phone fields at
any depth; unmasked payload is byte-for-byte unchanged; masking-settings failure
redacts; success/deny/not-found/schema/tenant/rate/run-limit attempts have one
correctly linked audit row with no body/PII/token material; forced audit insert
failure returns 503 and no tool data.

### T7 — per-installation rate and per-run resource controls

**Work:** mirror ChatGPT-MCP rate-limit response semantics with an installation
key and unauthenticated IP guard; enforce the persisted five-attempt run limit.

**Acceptance:** multiple tokens/runs for installation A share one window;
installation B on the same IP has an independent budget; token rotation cannot
bypass A's budget; `Retry-After` is present; the sixth valid-token attempt is
denied and audited; expiry/window reset behaves deterministically with fake
timers or a tiny test window.

### T8 — routes and hand-authored client

**Work:** after D1, mount the internal gateway and a self-guarded platform dev
token router; require both platform super-admin and
`APP_RUNTIME_DEV_TOKEN_ROUTE_ENABLED=true`; add a no-dependency Node reference
client that receives base URL/token via environment and calls list Jobs, one Job
detail selected from that result, and list Tasks.

**Acceptance:** normal tenant users and platform non-admins receive 403; route is
404/disabled when the explicit env is off (including production default); body
accepts installation/version/optional TTL but no company; response returns token,
run ID, expiry only; no token is logged; client sends no tenant identifier and
contains no runner/eval/network target other than the configured gateway base.

### T9 — real-PostgreSQL tenancy/RBAC/masking tests

**Work:** add release-blocking DB suites with A+B fixtures and no silently-green
DB fallback. Exercise the real catalog → live authz → read service → masking →
audit path for all three tools.

**Acceptance:** every tool has the T-own/T-foreign/T-blast and R-matrix coverage
in §12; B's complete snapshot is byte-unchanged after A calls; foreign Job is
404; list tools never contain B rows; provider and Tasks content scope use the
human delegator ID, never the agent ID; the DB-unavailable sentinel visibly
fails instead of reporting success.

### T10 — sabotage proof and regression gate

**Work:** run every §13 BREAK→red control on top of the uncommitted diff, restore
by reversing the exact sabotage edit, rerun green, then request a fresh
attack-only review by a different session/person.

**Acceptance:** each named invariant has observed red evidence and restored
green evidence; `git diff` after restoration contains the implementation only;
ChatGPT-MCP authorization/read/rate/masking and Marketplace disconnect suites
remain green; no process, watcher, temporary DB artifact, or temp file remains.

## 12. Test plan

### 12.1 Per-tool tenancy and scope matrix

| tool | T-own | T-foreign | T-blast | R-matrix / live scope |
|---|---|---|---|---|
| `svc.list_jobs` | A token returns A Jobs matching filters | B Job matching every filter is absent | A+B share job number, customer phone/email, and search text; result contains only A and full B snapshot is unchanged | tenant_admin/manager/dispatcher see A company; provider sees only assigned; custom/deny override without `jobs.view` gets 403; missing/unknown `job_visibility` stays assigned-only |
| `svc.get_job` | A-owned visible ID returns 200 | B ID and A-unassigned provider ID both return indistinguishable 404 | A+B share natural fields while their IDs differ; A lookup cannot expose/mutate B and B snapshot is unchanged | same permission cells; manager→provider without remint changes next call from visible to 404 unless assigned |
| `svc.list_tasks` | office role sees A Tasks; provider sees own/authored A Tasks | matching B Tasks and same-company teammate Tasks are absent for restricted caller | A+B share title/search text and same parent-kind shape; only authorized A rows return and B snapshot is unchanged | tenant_admin/manager/dispatcher have `tasks.manage` and see company A; provider/custom with only `tasks.view` sees own/authored; missing `tasks.view` gets 403; missing delegator ID fails closed |

Every A/B snapshot includes Jobs, Tasks, installations, principals, runs, agents,
and app-linked audit rows. Read tools must leave all B domain/runtime rows
byte-unchanged; only A's expected audit/run-call fields may change.

### 12.2 Authentication, revocation, and issuance

- Missing bearer, malformed bearer, bad signature, `alg=none`, wrong algorithm,
  expired token, claim extras/omissions/type errors, nonce mismatch, and run tuple
  mismatch.
- Token contains no company/app/user/permission/scope/source data.
- Active token is denied on the very next request after each of: run revoked,
  principal revoked, agent disabled, version revoked, installation disconnected
  or revoked, app disabled, company suspended, delegator disabled, membership
  disabled/deleted, or installation `installed_by` cleared/changed.
- Principal and token minting reject version from another app and installation
  from another tenant without accepting a company selector.
- Dev route: env off, tenant user, platform non-admin, super-admin happy path,
  TTL clamp/reject, and response/log secret hygiene.

### 12.3 Consent, schema, masking, audit, and limits

- Remove each intersection factor one at a time; direct call stays denied even
  when all other factors allow.
- Top-level and nested tenant aliases are rejected rather than stripped.
- Unknown field, wrong type, invalid dates, `limit=0`, and `limit=101` reject
  before the read service.
- URL-looking path/body keys and registered-but-out-of-scope read/write tools do
  not dispatch.
- Masked active settings remove phone keys recursively for Jobs list/detail;
  masking resolution failure also removes them; no-mask result preserves object.
- Audit row count is exactly one for each token-resolved outcome; linkage matches
  A; details contain no fixture phone/email/search/token/nonce.
- Audit insert sabotage returns 503/no data.
- Two run tokens on A share rate budget; B is isolated; run attempt six is 429;
  rate and run-limit denials are audited.

## 13. Sabotage minimum

Each control is run against the real path it guards, not a mocked assertion that
a helper was called.

| invariant | BREAK sabotage | test that must go red |
|---|---|---|
| company only from installation binding | replace resolved company with a body selector or remove the company/install composite predicate | `appRuntimeTenancy.db.test.js` per-tool T-foreign/T-blast |
| tenant selectors reject, never strip | change rejector to delete-and-continue | gateway nested/top-level `TENANT_SELECTOR_FORBIDDEN` route test |
| exact three read tools only | add `svc.list_calls` or a write descriptor to runtime allowlist | exact catalog equality + out-of-scope direct-call test |
| strict schema before dispatch | bypass `validateArguments` | unknown key/type/bounds route test |
| published artifact/version identity is immutable | update a published version's source/hash or remove the immutability trigger | migration hash-pinning/immutability test |
| version allowlist is required | remove `app_version_tools` membership check | version-tool factor-removal test |
| installation consent independently narrows | skip consent version/name check | unconsented-tool direct-call test |
| live delegator permission on every call | reuse permissions captured at mint/provision time | manager/custom live deny-override test |
| provider Job scope uses delegator | pass agent ID or force `assignedOnly:false` | real-PG manager→provider/unassigned Job test |
| Tasks content scope uses delegator | omit `scopeOwnerId` for non-`tasks.manage` | real-PG provider teammate-Task exclusion test |
| kill state checked per request | remove one status/revocation join or cache beyond 30 seconds | table-driven already-minted-token revocation test |
| run tuple/nonce is bound | omit nonce/version/installation predicate | wrong-tuple/wrong-nonce token test |
| five-call ceiling is atomic | remove conditional counter predicate | sixth-call and concurrent-consume tests |
| rate key is installation | key by IP, token, or run | shared-A/isolated-B rate test |
| all output crosses masking seam | return raw read result | fixture-phone absence test on real gateway response |
| audit is awaited and correctly attributed | call swallowing `auditService.log`, omit app/install IDs, or send before insert | audit-failure 503/no-data + DB linkage tests |
| principal is per installation/company | remove composite FK/query equality or reuse A agent for B | principal cross-tenant migration/identity test |
| dev mint route is not public | remove super-admin or env gate | tenant/non-admin/env-off route tests |

Restore each sabotage with an exact reverse patch or saved copy. Never use
`git checkout` because the implementation is uncommitted.

## 14. RISKS

1. **Protected mount precision:** D1 permits only the two router requires and
   two router mounts; any other `src/server.js` hunk is out of scope.
2. **Consent JSON discipline:** D2 is fail-closed, but future writers must build
   the `app_runtime` parent before nested `jsonb_set`; normalized storage is
   reconsidered at Ф6 when writes/money arrive.
3. **Audit amplification:** only token-resolved calls receive tenant-attributed
   rows; invalid-signature traffic is IP-limited and must not be attributed from
   unverified claims. If product requires durable audit for every malformed
   packet, that needs a separate non-tenant security-event sink and retention
   budget.
4. **In-memory rate store:** matches the existing ChatGPT seam but is per process.
   A shared store is a prerequisite for multiple CRM instances.
5. **Shared read service naming:** `chatgptMcpReadService` is technically reusable
   and already carries the required scopes, but its name is product-specific.
   Renaming/refactoring is explicitly out of Phase 1; use it directly.
6. **Masking projector breadth:** the Pulse projector is recursive and suitable
   for the seam, but new DTO phone-key spellings require its central tests to be
   extended. The gateway must not fork it.
7. **Installer deletion semantics:** `marketplace_installations.installed_by` is
   `ON DELETE SET NULL`. This is desirable fail-closed behavior, but a deleted
   installer immediately kills the installation's runtime authority until a
   future explicit re-delegation flow (out of scope).

## 15. QUESTIONS

No open scope or product questions. Initial TTL/rate/call values are server
configuration, not a product fork; the safe defaults above are sufficient for
the Phase 1 reference client.

## 16. VERIFY

Exact planned commands from the worktree root (test filenames are deliverables
of T8/T9; migration `N` is substituted after rechecking the max):

| task | verification commands below |
|---|---|
| T1 | V0, V2, V5 |
| T2 | V1, V5 |
| T3 | V2, V3, V5 |
| T4 | V1, V2, V5 |
| T5 | V1, V2, V3, V5 |
| T6 | V1, V2, V3, V5 |
| T7 | V1, V3, V5 |
| T8 | V1, V5 |
| T9 | V2, V5 |
| T10 | V1–V5 plus the documented BREAK→red→restore reruns |

**V0 — migration number recheck**

```bash
git ls-tree -r --name-only origin/master backend/db/migrations | grep -E 'backend/db/migrations/[0-9]{3}_[^/]+\.sql$' | grep -v '/rollback_' | sort | tail -1
find backend/db/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' | sort | tail -1
```

**V1 — app-runtime unit/route/client suites**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/appRuntimeGateway.test.js tests/appRuntimeDevTokenRoute.test.js tests/appRuntimeRateLimit.test.js tests/appRuntimeReferenceClient.test.js --testPathIgnorePatterns /node_modules/ --runInBand
```

**V2 — app-runtime real-PostgreSQL suites**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/appRuntimeIdentity.db.test.js tests/appRuntimeTenancy.db.test.js --testPathIgnorePatterns /node_modules/ --runInBand
```

**V3 — affected regression suites**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/chatgptMcpAuthorization.test.js tests/chatgptMcpReads.test.js tests/chatgptMcpRateLimit.test.js tests/pulseMaskingService.test.js tests/services/marketplaceService.test.js --testPathIgnorePatterns /node_modules/ --runInBand
```

**V4 — full backend suite**

```bash
env -u NODE_USE_SYSTEM_CA npm test -- --runInBand
```

**V5 — diff/worktree check**

```bash
git diff --check
git status --short
```

Real-PostgreSQL suites must visibly fail with a release-blocker sentinel when
PostgreSQL is unavailable; they may not convert missing DB into a green pass.
No frontend command is required because Phase 1 has no frontend change.

## 17. NEXT

1. Run the required fresh attack-only review in a different session/person.
2. Reconsider normalized consent storage at Phase 6 before runtime writes or
   money-moving tools are introduced.
