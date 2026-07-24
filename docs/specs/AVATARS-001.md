# AVATARS-001 — per-user CRM avatars

Status: owner decisions approved; Phase A implemented and awaiting review; not deployable before Phase B
Date: 2026-07-24
Parent contract: `docs/specs/CHATGPT-CRM-MCP-001.md`

## 1. Outcome

The Marketplace app currently identified by `app_key='chatgpt-crm-mcp'` becomes
**Avatars**: one company installation enables the product, then each active CRM
member may connect one ChatGPT-backed avatar that acts as that member's digital
copy.

The load-bearing authorization invariant is:

```text
effective avatar authority
  = live owner permission keys
  ∩ live owner record scopes
  ∩ live owner FSM role
  ∩ enabled avatar tier
  ∩ token OAuth scope
```

An avatar must never see or do anything its human owner cannot see or do at the
same instant. Writes and Sends are independent, owner-controlled narrowing
tiers; neither tier can grant a missing human permission or widen a record
scope.

This specification is separate from `CHATGPT-CRM-MCP-001` because it replaces
that document's company-wide identity and static-agent-grant authorization
model. The parent remains the historical transport, tool-schema, tenant-write,
idempotency, and send-safety contract.

## 2. Scope and non-goals

In scope:

- one company Marketplace installation with multiple per-user bindings;
- one synthetic `crm_users.kind='agent'` identity per company/owner;
- owner-bound OAuth resolution and same-transaction write reauthorization;
- live, uncached human permissions, scopes, and role on every MCP call;
- owner-only Writes/Sends consent;
- tenant-admin global enable/disable and per-avatar revoke;
- company roster with owner name, `base='ChatGPT'`, connection status,
  presence, and no other identity/tool data;
- display name and domain authorship as `Avatar of <DB owner name>`.

Out of scope:

- OAuth company selector or multiple simultaneous company avatars for one
  Keycloak subject in v1;
- payment tools, files, new MCP tools, or tool schema changes;
- any relaxation of existing company predicates, idempotency, recipient
  resolution, or confirmation requirements;
- cross-request authorization caches;
- frontend work by the GPT implementer; Phase D belongs to Claude;
- Phase A edits to record-scope plumbing, FSM actor roles, `/api/avatars`,
  frontend, or protected `src/server.js`.

Phase A is a schema and identity foundation only. It intentionally keeps the
existing static tool gate while making live owner context available. It must
not be deployed before Phase B replaces that gate and threads all record
scopes.

## 3. Settled owner decisions

- V1 permits one active avatar per human OAuth principal, in one company.
- A tenant administrator enables the shared company installation.
- Every active member self-provisions and self-revokes only their own avatar.
- Only the owner may enable that avatar's Writes or Sends tier.
- A tenant administrator may revoke another member's avatar or disable the
  company installation, but may never expand another avatar's tiers.
- Reads are tier-enabled by default but remain limited by the owner's live
  business permissions and record scopes.
- Sends remain independent from Writes.
- Authorization is resolved from PostgreSQL on every `tools/list` and
  `tools/call`; there is no cross-request cache.
- A write repeats owner/binding/company/install/agent authorization with the
  same transaction client immediately before its first side effect.
- The existing ABC Homes binding becomes its authorizer's avatar without OAuth
  reconnect and preserves binding ID, AI user ID, invocation audit, and
  idempotency records.
- `app_key='chatgpt-crm-mcp'` and the Keycloak client stay unchanged; only the
  Marketplace display name becomes `Avatars`.
- Roster visibility is allowed to every active company member.
- Presence is `active` when the binding has an invocation in the preceding
  15 minutes; otherwise it is `idle`.

## 4. Data and identity model

### 4.1 Company installation and avatar binding

`marketplace_installations` remains unique per company/app and is the global
tenant enablement switch. `chatgpt_mcp_bindings` gains:

- `owner_user_id UUID NOT NULL`;
- a composite FK `(owner_user_id, company_id)` to
  `company_memberships(user_id, company_id)`;
- `writes_enabled BOOLEAN NOT NULL DEFAULT false`;
- `sends_enabled BOOLEAN NOT NULL DEFAULT false`;
- partial uniqueness on `(company_id, owner_user_id)` while active.

The existing active-principal unique index on
`(oauth_issuer, oauth_subject, oauth_client_id)` remains. It enforces the v1
one-active-avatar-per-human rule across companies and prevents OAuth lookup
ambiguity.

`owner_user_id` is the canonical local owner. The external binding additionally
requires `owner.keycloak_sub = oauth_subject` under the configured issuer and
client. `authorized_by_user_id` remains the consent/audit actor; v1
self-provision requires it to equal `owner_user_id`.

### 4.2 Synthetic actor

Each avatar has one company-owned `crm_users.kind='agent'` row:

```text
keycloak_sub = agent:chatgpt-crm-mcp:<companyId>:<ownerUserId>
full_name    = Avatar of <current DB owner full_name>
```

The agent receives no human membership or role. UUID/FK authorship continues to
use the AI user's CRM UUID. Display strings are server-derived from the owner's
DB profile, never JWT claims, model arguments, or record text.

### 4.3 Consent persistence

The binding booleans are the canonical tier state:

- reads: always tier-enabled;
- Writes: `writes_enabled`;
- Sends: `sends_enabled`, independent of Writes.

Phase A retains `mcp_agent_permission_grants` so the existing gate and rollback
stay green. New avatars receive only the S1 read bundle; no write/send grants
are created by provisioning. Existing tier state is backfilled from the
current exact anchors:

- `mcp.tool.svc.create_lead` → `writes_enabled=true`;
- `mcp.tool.svc.send_estimate` → `sends_enabled=true`.

Phase B stops treating persisted business/tool grants as authority. It may keep
the table for historical rollback compatibility, but all effective tool access
will be synthesized from live owner rights plus tier booleans.

## 5. Live owner authorization seam

The canonical function is:

```text
resolveCompanyUserAuthz(companyId, ownerUserId, { client })
```

It must:

1. require explicit company and owner IDs;
2. use the supplied transaction client when present;
3. join the requested company, human CRM user, and that exact
   `(user_id, company_id)` membership;
4. require active company, active/onboarded human, human `kind='user'`, and
   active membership;
5. derive `role_key` from that membership, never from the primary-membership
   helper and never from client input;
6. reuse the canonical role matrix plus member permission/scope override merge;
7. return owner ID, DB display name, membership/role, sorted live permission
   keys, and live record scopes;
8. fail closed for a foreign company, disabled user/membership/company, or
   missing role context.

Normal MCP reads resolve it once after OAuth binding resolution. Writes resolve
it again inside their existing transaction, after locking the active binding
chain and before the handler's first side effect.

## 6. Tool parity checklist for Phase B

Every row also needs its exact internal `mcp.tool.<name>` key and the OAuth
scope for its tier. “Record scope” identifies the current human-route seam to
carry into MCP; “none” means the current wrapped human route has no additional
record-level scope beyond company ownership and its business permission.

| Tool | Tier | Required live business permission(s) | Record-scope parity required | FSM role parity |
|---|---|---|---|---|
| `svc.list_jobs` | Read | `jobs.view` | Yes — `job_visibility`; assigned jobs only when not `all` | n/a |
| `svc.get_job` | Read | `jobs.view` | Yes — same owned/assigned Job predicate | n/a |
| `svc.get_job_transitions` | Read | `jobs.view` | Yes — Job visibility before state lookup | owner `role_key` |
| `svc.list_leads` | Read | `leads.view` | None in current Leads route | n/a |
| `svc.get_lead` | Read | `leads.view` | None in current Leads route | n/a |
| `svc.get_lead_transitions` | Read | `leads.view` | None in current Leads route | owner `role_key` |
| `svc.search_contacts` | Read | `contacts.view` | Yes — assigned-contact reachability from `job_visibility` | n/a |
| `svc.get_contact` | Read | `contacts.view` | Yes — same assigned-contact reachability | n/a |
| `svc.get_contact_history` | Read | `contacts.view` | Yes — visible Contact before history | n/a |
| `svc.list_schedule` | Read | `schedule.view` | Yes — `job_visibility` on schedule Jobs/items | n/a |
| `svc.get_schedule_item` | Read | `schedule.view` | Yes — same schedule item visibility | n/a |
| `svc.list_tasks` | Read | `tasks.view`; `tasks.manage` widens from own to company-wide | Yes — without `tasks.manage`, scope to owner/authored or assigned Tasks using the human owner ID | n/a |
| `svc.list_entity_tasks` | Read | `tasks.view` + host-specific `jobs.view` or `leads.view` | Job host: yes; Lead host: none | n/a |
| `svc.list_task_assignees` | Read | `tasks.view` | None; active users remain company-scoped | n/a |
| `svc.list_estimates` | Read | `estimates.view` | None enforced by current Estimates route | n/a |
| `svc.get_estimate` | Read | `estimates.view` | None enforced by current Estimates route | n/a |
| `svc.list_invoices` | Read | `invoices.view` | None enforced by current Invoices route | n/a |
| `svc.get_invoice` | Read | `invoices.view` | None enforced by current Invoices route | n/a |
| `svc.list_calls` | Read | `pulse.view` | Yes — Pulse/call assigned-contact visibility; no cross-owner orphan widening | n/a |
| `svc.create_lead` | Writes | `leads.create` | None; all links remain company-owned | n/a |
| `svc.update_lead` | Writes | `leads.edit` | None in current Leads route | n/a |
| `svc.transition_lead` | Writes | `leads.edit` | None in current Leads route | owner `role_key` |
| `svc.create_job` | Writes | `jobs.create` | None before the new Job exists | n/a |
| `svc.update_job` | Writes | `jobs.edit` | Yes — owned/assigned Job before mutation | n/a |
| `svc.transition_job` | Writes | `jobs.edit` + `jobs.close` | Yes — owned/assigned Job before mutation | owner `role_key` |
| `svc.add_note` | Writes | host-specific `jobs.edit`, `leads.edit`, or `contacts.edit` | Job/Contact: yes; Lead: none | n/a |
| `svc.create_estimate` | Writes | `estimates.create` | None enforced by current Estimates route; all links remain company-owned | n/a |
| `svc.update_estimate` | Writes | `estimates.create` | None enforced by current Estimates route | n/a |
| `svc.create_invoice` | Writes | `invoices.create` | None enforced by current Invoices route; all links remain company-owned | n/a |
| `svc.update_invoice` | Writes | `invoices.create` | None enforced by current Invoices route | n/a |
| `svc.convert_estimate_to_invoice` | Writes | `invoices.create` | None enforced by current conversion route | n/a |
| `svc.send_estimate` | Sends | `estimates.send` | None enforced by current Estimate send route; recipient remains server-resolved | n/a |
| `svc.send_invoice` | Sends | `invoices.send` | None enforced by current Invoice send route; recipient remains server-resolved | n/a |

Phase B must explicitly reconcile two polymorphic descriptors:

- `svc.list_entity_tasks`: discovery may advertise when at least one host class
  is available; invocation checks the selected host permission and visibility.
- `svc.add_note`: discovery may advertise when at least one parent class is
  editable; invocation checks only the selected allowlisted parent class.

No Phase B handler may construct a provider scope from the AI user's ID. The
scope uses the live human owner's ID and server-resolved scope map.

## 7. Roster contract

The Phase C company roster joins active bindings to the same-company owner
membership and synthetic AI identity. `last_activity_at` is
`MAX(mcp_tool_invocations.started_at)` constrained by both `company_id` and
`binding_id`.

Allowed response fields:

```text
owner_user_id
owner_name
base = ChatGPT
connection_status
presence = active | idle
last_activity_at
```

The user-facing roster omits `last_activity_at` if the final owner design
chooses only the requested status fields. It must never return email,
Keycloak/OAuth subject, permissions, scopes, role, tool names, arguments,
result metadata, AI email, or token data.

Every active company member may read the roster. Tenant administrators may
globally disable the company installation or revoke one avatar. An owner may
revoke only their own avatar. Only the owner may enable Writes/Sends.

Invocation audit is best-effort after a domain action, so presence is an
operational hint rather than a security signal. Binding/install/user state,
not presence, controls authorization.

## 8. Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| Marketplace company enable/disable | `req.companyFilter.company_id` | app key + installation ID + company | `tenant.integrations.manage` and active `tenant_admin` | tenant_admin ✓; manager/dispatcher/provider/custom ✗ | Global disconnect revokes every avatar; wrong company predicate is tenant-wide. |
| Phase A self-provision service; Phase C self endpoint | trusted company membership | `(company_id, owner_user_id)` plus OAuth `(issuer, subject, client)` | active company membership; self only | active tenant_admin/manager/dispatcher/provider/custom ✓ for self; inactive/platform-only/foreign ✗ | A caller creating a binding for another user would impersonate them. |
| Self revoke / owner tier mutation | trusted company membership | binding `(company_id, owner_user_id)` | active membership; self only | owner ✓; other members/admin expansion ✗ | ID-only binding selection could revoke or expand another avatar. |
| Admin avatar revoke | `req.companyFilter.company_id` | binding ID + owner + company | `tenant.integrations.manage` and active `tenant_admin` | tenant_admin ✓; all others ✗ | Missing company join can revoke another tenant's avatar. |
| OAuth MCP authentication | verified token → active unique principal binding | issuer + subject + client; owner and company come only from binding | valid token/scope + active binding/install/company/owner/agent | bound owner avatar ✓; unbound/foreign/disabled ✗ | Subject-only/default-company resolution could select another tenant. |
| `tools/list` and Read tools | binding company + live owner authz | exact tool map + company-owned entity/natural key | live business permission + exact tool + read OAuth scope | any active role/custom only where live permission/scope allows | Stale/static permissions or AI-ID provider scopes can expose all tenant records. |
| Writes tools | same transaction binding/company/owner recheck | entity/item ID + company; create idempotency key | live business permission + owner Writes tier + write scope | owner avatar only when every gate allows | Role/revoke race or ID-only mutation can alter B. |
| Sends tools | same transaction binding/company/owner/contact recheck | document/contact ID + company; send idempotency key | live send permission + owner Sends tier + send scope | owner avatar only when every gate allows | Tier confusion or recipient injection can disclose a document externally. |
| Roster aggregate | `req.companyFilter.company_id` from active membership | binding + owner membership + invocation binding, all repeated with company | active company membership | all active tenant roles/custom ✓; inactive/platform-only/foreign ✗ | Email/sub/tool audit leakage or an unscoped MAX leaks user behavior. |
| Invocation audit/idempotency | trusted binding context | company + binding + AI user + tool/hash | internal executor only | avatar executor ✓; direct humans ✗ | A reused binding/agent key can cross-contaminate audit or replay. |

## 9. Mandatory test contract

Every new company-scoped read/write follows `TENANCY-RBAC-CANON`:

- `T-own`: owner avatar/company succeeds.
- `T-foreign`: foreign ID is not-found; writes leave the complete foreign
  snapshot byte-identical.
- `T-blast`: A and B use colliding permitted natural keys; A never reads or
  changes B.
- `R-matrix`: every allow and deny role/permission/tier/scope cell is explicit.
- sabotage: removing the owner/company predicate, live permission resolution,
  record scope, or tier check makes its named test red.

Phase A additionally requires:

- migration/backfill on an existing company-wide binding, preserving IDs,
  audit, and idempotency references;
- idempotent migration and idempotent self-provision;
- same owner cannot hold a second active avatar in another company;
- foreign/inactive company membership cannot resolve live authorization;
- self-revoke affects only the exact owner/company avatar;
- no write/send grant is created for a new avatar.

## 10. Staged implementation plan

### Phase A — identity foundation (this implementation)

| Task | Deliverable | Acceptance |
|---|---|---|
| T1 | This specification | Owner decisions, Tenancy & Roles, 33-tool parity table, stages, and verification skeleton are complete. |
| T2 | Migration 200 + rollback | Owner/tier columns and constraints are backfilled idempotently; current binding/AI/audit/idempotency IDs survive; app display is Avatars; rollback aborts if a company already has multiple active avatars. |
| T3 | Client-aware live owner resolver | Exact company membership returns DB name, role, live permissions, and scopes; foreign/inactive chains fail closed; supplied transaction client is used. |
| T4 | Split installation/avatar provisioning | Admin enablement is separate from active-member self-provision/revoke; provisioning is idempotent, read-only by default, and T-blast safe. |
| T5 | Owner-aware OAuth/live binding context | OAuth/fixed bearer/live write recheck return owner identity/context while the Phase A static gate behavior remains unchanged. |
| T6 | Phase A tests/regression | Migration, resolver, identity, self-provision/revoke, uniqueness, OAuth, and existing MCP suites are green. |

### Phase B — live permission and record-scope core (owner greenlight required)

| Task | Deliverable | Acceptance |
|---|---|---|
| T7 | Dynamic tool authority | `tools/list` and direct call synthesize exact tool access from live owner permissions + tier + OAuth scope; static agent business grants cannot authorize a tool. |
| T8 | Read record scopes | Jobs, Contacts, Schedule, Calls/Pulse, and host Tasks use the owner ID/scope from the parity table; no handler uses the AI user as provider scope. |
| T9 | Write record scopes and live race | Job/contact/host writes recheck scope in the existing transaction immediately before side effect; revoke/role/tier races leave zero changes. |
| T10 | FSM and polymorphic parity | Job/Lead transitions use owner role; add-note/entity-task permissions depend only on the selected allowlisted host type. |
| T11 | 33-tool parity/red team | Each row has tools/list, direct-call, R-matrix, T-own/T-foreign/T-blast where applicable, and break-to-red record-scope controls. |

### Phase C — roster and HTTP endpoints (owner approval for protected mount)

| Task | Deliverable | Acceptance |
|---|---|---|
| T12 | `/api/avatars` self/admin endpoints | Active members self-connect/revoke/toggle own tiers; admin can revoke/disable but cannot enable another owner's tier. |
| T13 | Roster query/route | All active members see only the allowlisted fields; 15-minute presence; T-blast aggregate isolation. |
| T14 | Protected runtime hook | Minimal `src/server.js` require/mount only after explicit owner approval; no Marketplace-wide permission relaxation. |

### Phase D — frontend (Claude)

| Task | Deliverable | Acceptance |
|---|---|---|
| T15 | Avatars hub/roster | Company members see the roster; current owner can connect/revoke and inspect own state. |
| T16 | Owner consent controls | Writes and Sends controls mutate only the signed-in owner's avatar and clearly show their independent narrowing semantics. |
| T17 | Admin controls | Tenant admin can disable the company app/revoke an avatar but has no UI/API path to expand another owner's tiers. |

## 11. Verification skeleton

Commands run from the worktree root with bundled CA and serial DB suites.
Exact suite/test counts are recorded when each phase exists.

### Phase A focused

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/avatarsPhaseA.test.js tests/avatarsPhaseA.db.test.js tests/chatgptMcpIdentity.db.test.js tests/chatgptMcpOAuth.test.js
```

Phase A implementation result: 4 suites / 22 tests passed, exit 0.

### Phase A full MCP regression

Use the current full command from `CHATGPT-CRM-MCP-001` §13, adding both
`avatarsPhaseA` suites. DB-backed suites must point to a production-shaped
database with all numbered migrations applied and must fail visibly when
PostgreSQL is unavailable.

Phase A implementation result: 22 suites / 258 tests passed, exit 0.

### Phase B focused

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/avatarsAuthorization.test.js tests/avatarsScopes.db.test.js tests/chatgptMcpReadsProtocol.db.test.js tests/chatgptMcpWrites.db.test.js tests/chatgptMcpSends.db.test.js
```

Phase B named sabotage minimum:

- remove live owner-permission lookup → `SAB-AVATAR-LIVE-RBAC` red;
- substitute AI user ID in provider scope → `SAB-AVATAR-RECORD-SCOPE` red;
- restore hardcoded dispatcher FSM role → `SAB-AVATAR-FSM-ROLE` red;
- bypass owner tier → `SAB-AVATAR-SELF-CONSENT` red;
- change owner role between list/call or before write → live call/race tests red.

### Phase C focused

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/avatarsRoutes.test.js tests/avatarsRoster.db.test.js
```

Phase C sabotage removes the roster `company_id` predicate and must make the
two-company aggregate test expose B and fail.

### Phase D

Claude records the exact frontend build and Vitest commands after the approved
components exist.
