# CHATGPT-CRM-MCP-001 — OAuth CRM connector

Status: approved specification; S1 implemented; S1.1 call-history read pending architect gate
Date: 2026-07-23
Scope: backend-only ChatGPT MCP connector with company-scoped reads, internal CRM writes, and customer sends; payments deferred

## 1. Outcome and non-goals

Albusto will expose a remote MCP resource that a ChatGPT connector can authorize through the Keycloak `crm-prod` realm. A successful grant resolves to one active Marketplace installation, one company, and one synthetic CRM agent. Every tool call then passes four independent gates:

1. valid OAuth token for the exact Albusto MCP resource and client;
2. active company, human authorizer, Marketplace installation, binding, and AI agent;
3. OAuth scope for the tool class;
4. the tool's business permissions plus its exact `mcp.tool.<tool_name>` permission.

The model can never choose the company. Company identifiers in tool arguments are stripped, and entity queries repeat `company_id` at every join and mutation.

This project is backend-only. It does not add a CRM screen, a browser flow, a server-side draft queue, or an Albusto approval UI. V1 does not expose payment collection, keyed-card, terminal, offline-payment, refunds, arbitrary-recipient messaging, arbitrary job payment links, or raw card data.

The existing voice/customer `svc.*` skills remain intact. Dispatcher tools extend `agentSkillsMcpRegistry` and its service transport, but use dispatcher-specific handlers rather than weakening customer identity levels in the existing skills.

## 2. Settled decisions

- Connection: ChatGPT native MCP connector over OAuth 2.1 and Streamable HTTP.
- Authorization server: Keycloak realm `crm-prod`; Albusto is the protected resource, not an OAuth proxy.
- Client identification: one pre-registered Keycloak public client, `chatgpt-crm-mcp`, for v1. Dynamic Client Registration is not exposed.
- Actor: one company-bound `crm_users.kind = 'agent'` identity per active ChatGPT CRM installation. It is not assigned the literal Dispatcher role.
- Authorization: deny by default. A tool needs its ordinary business permissions and a system-only permission unique to that tool.
- Human role: only a tenant administrator may install, bind, reconnect, or disconnect the connector in v1. Managers, dispatchers, providers, custom roles, and platform-only admins cannot configure it.
- Execution: ChatGPT's per-action confirmation is the only human gate. Albusto executes an authorized call immediately; there is no server draft/approve state.
- Status changes: accept a published FSM event, resolve it under the bound company, and fail closed when there is no published FSM or no matching transition.
- Authorship: the synthetic AI user's `crmUser.id` is used in every UUID/FK actor field. Keycloak `sub` is never written to such a field.
- Estimates and invoices: reads are S1. Create/update—including replacement of line items through the canonical services—and estimate-to-invoice conversion are S2. They require `estimates.*`/`invoices.*` permissions plus exact synthetic tool grants.
- Payments: deferred in full. No payment permission, OAuth scope, grant, tool, Stripe call, or payment-link delivery ships in v1.
- Delivery: S1 reads, S2 internal writes, and S3 customer sends belong to v1. S4 is a documented deferred payment stage, not an implementation commitment.

## 3. Owner decisions recorded

### D1 — protected server mount: approved

The owner explicitly authorized S1 to add the two public mounts below and the two matching `require(...)` declarations to protected `src/server.js`:

```js
app.use('/.well-known/oauth-protected-resource', chatgptMcpResourceMetadataRouter);
app.use('/mcp/chatgpt', chatgptMcpOAuthRouter);
```

No other `src/server.js` edit is authorized.

### D2 — payments: deferred

The owner deferred all payment work from v1. The repo's platform wallet remains unrelated to CRM customer invoices and must never be reused. S4 retains the risk analysis and safety requirements as future design input only; it registers no tools and receives no AI grants or OAuth scope in v1.

## 4. OAuth 2.1 connector design

### 4.1 Concrete endpoints

Production protected-resource identifier:

```text
https://api.albusto.com/mcp/chatgpt
```

| Owner | Endpoint | Authentication | Purpose |
|---|---|---|---|
| Albusto | `GET https://api.albusto.com/.well-known/oauth-protected-resource` | public | Compatibility metadata alias for clients that probe the origin root. Returns the same resource document as the path-specific endpoint. |
| Albusto | `GET https://api.albusto.com/.well-known/oauth-protected-resource/mcp/chatgpt` | public | RFC 9728 metadata for the exact MCP resource. |
| Albusto | `POST https://api.albusto.com/mcp/chatgpt` | OAuth Bearer | MCP Streamable HTTP JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`, and required notifications. |
| Albusto | `GET https://api.albusto.com/mcp/chatgpt` | OAuth Bearer | Streamable HTTP continuation only if the negotiated MCP client uses it; otherwise a standards-shaped 405, never a legacy unauthenticated SSE stream. |
| Albusto | `POST /api/marketplace/apps/chatgpt-crm-mcp/install` | Keycloak + tenant company + tenant admin | Provisions installation, binding, AI user, and exact grant bundle. Uses the existing Marketplace route/service seam. |
| Albusto | `POST /api/marketplace/installations/:id/disconnect` | Keycloak + tenant company + tenant admin | Revokes the binding and disables the AI actor atomically for future calls. |
| Keycloak | `GET https://auth.albusto.com/realms/crm-prod/.well-known/openid-configuration` | public | Authorization-server metadata. |
| Keycloak | `GET https://auth.albusto.com/realms/crm-prod/protocol/openid-connect/auth` | browser redirect | Authorization Code request with PKCE S256 and `resource=https://api.albusto.com/mcp/chatgpt`. |
| Keycloak | `POST https://auth.albusto.com/realms/crm-prod/protocol/openid-connect/token` | public client + PKCE verifier | Code exchange/refresh. |
| Keycloak | `GET https://auth.albusto.com/realms/crm-prod/protocol/openid-connect/certs` | public | JWKS for access-token verification. |

Albusto does not implement `/authorize`, `/token`, or open `/register` endpoints. An unauthenticated MCP request returns 401 with:

```http
WWW-Authenticate: Bearer resource_metadata="https://api.albusto.com/.well-known/oauth-protected-resource/mcp/chatgpt", scope="albusto.mcp.read"
```

The protected-resource document declares:

- `resource`: the exact canonical resource URI above;
- `authorization_servers`: only `https://auth.albusto.com/realms/crm-prod`;
- `scopes_supported`: `albusto.mcp.read`, `albusto.mcp.write`, `albusto.mcp.send`;
- a product documentation URI, without company data.

### 4.2 Keycloak client registration

Configure, rather than build, a public realm client named `chatgpt-crm-mcp`:

- Standard Authorization Code flow enabled.
- PKCE method fixed to S256.
- Client authentication disabled (`token_endpoint_auth_method=none`); no client secret is placed in ChatGPT.
- Implicit flow, Direct Access Grants, service accounts, device grant, and wildcard redirect URIs disabled.
- The exact callback URI displayed in ChatGPT connector/app management is allowlisted. The current documented form is `https://chatgpt.com/connector/oauth/{callback_id}`; the deployed value must be copied from the actual ChatGPT configuration, not guessed.
- `fullScopeAllowed=false`; only the three named v1 MCP client scopes are attached.
- consent text identifies read, write, and external-send scopes separately.
- an audience mapper emits the exact protected resource as `aud`; a hardcoded access-token claim mapper emits the same URI as the `resource` claim; the token must also identify `chatgpt-crm-mcp` as `azp`/client ID.
- access and refresh lifetimes follow the realm security policy; logout/disconnect does not rely on expiry because Albusto checks its binding on every request.

This is preferred to DCR because it prevents arbitrary OAuth clients from registering against `crm-prod`. CIMD is deferred until the deployed Keycloak version and ChatGPT connector are proven to support it end-to-end. If the real connector cannot accept the pre-registered public client, S1 pauses and evaluates CIMD; it does not silently enable unrestricted DCR.

S1 documents this operator configuration but does not edit `keycloak/realm-export.json` or create the deployed client. Runtime configuration is fail-closed and requires:

```text
KEYCLOAK_REALM_URL=https://auth.albusto.com/realms/crm-prod
CHATGPT_MCP_CLIENT_ID=chatgpt-crm-mcp
CHATGPT_MCP_RESOURCE=https://api.albusto.com/mcp/chatgpt
CHATGPT_MCP_RESOURCE_METADATA=https://api.albusto.com/.well-known/oauth-protected-resource/mcp/chatgpt
```

### 4.3 Token validation and company mapping

The normal middleware currently verifies issuer/signature but not the connector audience/client/resource (`backend/src/middleware/keycloakAuth.js:89-116`). The connector gets a separate fail-closed middleware; it does not call the normal `findOrCreateUser` actor path.

For every MCP request:

1. Parse only an `Authorization: Bearer` token; never accept a query-string token.
2. Verify RS256 signature from the `crm-prod` JWKS plus issuer, expiry, not-before, exact `aud`, exact `azp`/client ID, and required OAuth scope.
3. Resolve the human subject to an existing active CRM user. Do not create a user on an MCP request.
4. Query the binding by `(issuer, subject, oauth_client_id)` and require exactly one active row. The binding identifies the installation, company, and AI user. Zero or multiple rows deny the request; this prevents an ambiguous human account from selecting a tenant.
5. In one company-scoped query/transaction, recheck the human's active tenant-admin membership in that same company, active company, connected Marketplace installation, active binding, and active AI user. Every join repeats `company_id`.
6. Resolve the AI system permission grants for that company and user. Never fall back to a human role. The current role resolver's missing-role fallback to `dispatcher` at `backend/src/services/authorizationService.js:108-114` is expressly forbidden here.
7. Build the trusted request context:

```js
req.companyFilter = { company_id: binding.company_id };
req.user = { crmUser: aiUser, kind: 'agent', oauthAuthorizerId: humanUser.id };
req.authz = { company, permissions: exactAiPermissions, oauthScopes };
```

8. Strip `company_id` and `companyId` from all client arguments through the existing gate (`backend/src/services/mcpToolAuthorization.js:36-41`). No header, resource ID, email, phone, external ID, or model text can change the bound tenant.
9. Repeat the active binding/company/agent/install checks immediately before a write or external side effect so disconnect or suspension wins a race with an already-started request.

The binding table has a partial uniqueness rule that permits at most one active binding per `(issuer, subject, oauth_client_id)`. A human who administers multiple companies needs a separate Keycloak subject in v1; ambiguous grants fail closed rather than selecting a default company.

### 4.4 Residual interoperability checks

S1 is not accepted until a real ChatGPT/Codex MCP client proves:

- the exact callback URI and static public-client configuration;
- PKCE S256 and `resource` propagation at authorization and token exchange;
- the Keycloak mapper emits an audience that ChatGPT accepts and Albusto verifies;
- the client follows both protected-resource metadata locations correctly;
- the supported MCP protocol version, `Accept` headers, initialization sequence, and Streamable HTTP GET/POST behavior;
- ChatGPT displays the intended confirmation for every important tool.

OAuth and MCP requirements follow OpenAI's current authenticated-app guidance and deployment guidance: [Authenticate users](https://developers.openai.com/apps-sdk/build/auth) and [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt).

## 5. Dedicated AI identity, grants, and audit

### 5.1 Data model

Migration numbers are assigned only at implementation time after rechecking the current maximum, with a matching forward and rollback migration.

S1 introduces:

1. Marketplace app `chatgpt-crm-mcp`, including the mandatory `metadata.assistant` object (`what_it_does`, `prerequisites`, `setup_steps`, `outcome`, `recommend_when`, `gotchas`).
2. `chatgpt_mcp_bindings`: `company_id`, installation ID, human authorizer CRM user ID, immutable issuer/subject/client ID, AI CRM user ID, state, grant version, created/revoked timestamps and actors. All foreign references are paired with/revalidated under `company_id`.
3. `mcp_agent_permission_grants`: `company_id`, `agent_user_id`, `permission_key`, `bundle_version`, timestamps, with uniqueness by company/agent/key.
4. `mcp_tool_invocations`: append-only, tenant-scoped audit with `created_by UUID REFERENCES crm_users(id)` set to the AI user, human authorizer ID, tool, stage, request/trace ID, idempotency key, canonical argument hash, confirmation class, start/end/status, and safe result/error metadata. Sensitive message bodies are not copied into audit details.
5. `mcp_tool_idempotency`: company, AI user, tool, idempotency key, canonical argument hash, state, and serialized safe result reference. Same key/same arguments returns the prior result; same key/different arguments is 409.

Install provisions a synthetic row such as:

```text
crm_users.kind        = agent
crm_users.company_id  = <bound company>
crm_users.keycloak_sub = agent:chatgpt-crm-mcp:<company UUID>
```

The synthetic subject exists only to satisfy the existing non-null unique column; it is never accepted as a Keycloak principal. The AI user receives no `company_memberships` row and no `company_role_configs.role_key`. The fixed human role constraint currently permits only tenant admin, manager, dispatcher, and provider (`backend/db/migrations/046_create_role_config_tables.sql:7-20`), so pretending the agent is a fifth human role is rejected.

### 5.2 Deny-by-default permission model

Every tool descriptor declares all of:

- one or more OAuth scopes;
- one or more existing business permissions;
- one exact system-only key: `mcp.tool.<full_tool_name>`.

`mcpToolAuthorization` already uses AND semantics and denies an unmapped tool (`backend/src/services/mcpToolAuthorization.js:5-33`). The ChatGPT dispatcher extension preserves that gate. Discovery filters out unavailable tools; direct invocation returns `access_denied` without revealing entity existence.

The system-only keys are not added to the human role editor. The connector bundle is versioned and seeded explicitly. Adding code for a new tool does not grant it: until its exact key is in the installed bundle, it is absent from discovery and cannot run. OAuth scopes are a second gate, not a substitute for permissions.

For the few tools whose business permission depends on a closed input enum (host/entity type or resolved FSM target), the descriptor declares an allowlisted permission resolver. After argument sanitization and schema validation—but before entity lookup—the executor resolves that fixed permission list and passes it through the same `mcpToolAuthorization.requireToolAccess` AND gate. A client string can never become a permission key.

### 5.3 Authorship and schema mismatch

All UUID/FK actor columns use the AI user's `crmUser.id`; no Keycloak `sub` fallback is permitted. The central invocation row always has `created_by = aiUser.id`. Domain records use their canonical equivalent:

- notes: `created_by`, `edited_by`, and `deleted_by` become the AI CRM UUID;
- note attachments: `uploaded_by = aiUser.id`;
- payment sessions and domain audit rows: `created_by`/`actor_id = aiUser.id`;
- tasks: the existing `created_by` is a provenance enum, not a UUID, so it remains `created_by='agent'` while `author_user_id=aiUser.id`; `mcp_tool_invocations.created_by` carries the required FK authorship.

Writing a UUID into the task provenance column would violate its schema and is not an acceptable interpretation of the owner decision.

## 6. Transport and execution contract

The connector reuses the registry, `mcpToolAuthorization`, argument validator, response mapper, and service/domain methods. It does not call Express routes over HTTP and does not duplicate business logic. Where a route currently owns business logic, S2 first extracts a company-required service function and makes both route and MCP wrapper call it.

All tool input schemas:

- are objects with `additionalProperties: false`;
- use bounded string and page sizes;
- contain no tenant selector;
- separate status transitions from other edits;
- reject remote file URLs;
- require an idempotency key for external effects, payments, conversions, scheduling changes, and sends.

Error normalization is stable: foreign/missing entities are `not_found`; missing permission/scope is `access_denied`; absent published FSM is `workflow_unavailable`; same idempotency key with different arguments is `idempotency_conflict`; provider failures expose a safe code, not credentials or raw upstream payloads.

### 6.1 Confirmation classes

| Code | MCP annotations and client behavior |
|---|---|
| `R` | `readOnlyHint=true`, `destructiveHint=false`, `openWorldHint=false`; no action confirmation. |
| `W` | internal mutation, `readOnlyHint=false`; ChatGPT asks before changing CRM state. |
| `D` | destructive/terminal or externally synchronized mutation, `destructiveHint=true`; ChatGPT asks every time. |
| `I` | important external action (customer send or money movement/link delivery), `readOnlyHint=false`, `openWorldHint=true`; connector must be configured to always ask. |

The annotations communicate risk to ChatGPT but do not prove approval to Albusto. The existing custom `{confirmed, confirmation_id}` check at `backend/src/services/agentSkillsMcpExecutor.js:101-112` is client-asserted and must not be described as cryptographic human approval. The dedicated connector follows the standard MCP call shape and relies on the locked owner decision that ChatGPT's UI is the only approval gate.

### 6.2 Fixed-bearer development path

`POST /mcp/agent-skills` remains the non-production real-client test seam and executes the same registry and handlers as OAuth. Before use it must be hardened from `backend/src/services/agentSkillsMcpPublicAuth.js:22-24,71-76,87-95`:

- no default company or default user;
- require explicit `SVC_MCP_PUBLIC_COMPANY_ID`, `SVC_MCP_PUBLIC_AGENT_USER_ID`, and bearer token;
- resolve that AI user as active, `kind='agent'`, and owned by the configured company;
- derive the exact DB grants; never synthesize broad read/write permissions from booleans;
- remain disabled when `NODE_ENV=production` even if an enable flag is set.

The fixed token authenticates the transport only; it does not bypass the per-tool permission gate.

## 7. Full tool inventory

Every permission cell below also requires the exact system key `mcp.tool.<tool name>`. Every read uses the binding company from server context; every write rechecks ownership in the mutation predicate. “Wrap” names the existing route/service behavior to reuse after any listed hardening. In the OAuth-scope column, `read`, `write`, and `send` abbreviate `albusto.mcp.read`, `albusto.mcp.write`, and `albusto.mcp.send` respectively.

### 7.1 S1 — reads

| Tool | Kind | Required permission(s) / OAuth scope | Confirm | Wrapped route/service | Tenant-scoping note |
|---|---|---|---|---|---|
| `svc.list_jobs` | read | `jobs.view` / `albusto.mcp.read` | R | `GET /api/jobs`; `jobsService.listJobs` | Force `companyId`; bounded cursor; repeat company scope on contact/lead joins. |
| `svc.get_job` | read | `jobs.view` / read | R | `GET /api/jobs/:id`; `jobsService.getJobById` | Harden signature to require company; tags must query by job and company. |
| `svc.get_job_transitions` | read | `jobs.view` / read | R | `GET /api/fsm/job/actions`; `fsmService.getAvailableActions` | Published company FSM only; no hardcoded fallback. |
| `svc.list_leads` | read | `leads.view` / read | R | `GET /api/leads`; `leadsService.listLeads` | Company required in base query, count, filters, and joins. |
| `svc.get_lead` | read | `leads.view` / read | R | `GET /api/leads/:uuid`; `leadsService.getLeadByUUID` | UUID is not authority; pair with company. |
| `svc.get_lead_transitions` | read | `leads.view` / read | R | published FSM service (new safe facade over `fsmService`) | Company-published lead FSM only; empty/error when absent. |
| `svc.search_contacts` | read | `contacts.view` / read | R | `GET /api/contacts`; `contactsService.listContacts` | Phone/email are natural keys; company scope before matching. |
| `svc.get_contact` | read | `contacts.view` / read | R | `GET /api/contacts/:id`; `contactsService.getById` | Harden required company; child emails/addresses repeat company ownership. |
| `svc.get_contact_history` | read | `contacts.view` / read | R | `GET /api/contacts/:id/history` plus typed notes | Base entity and every event/note/attachment query scoped to company. |
| `svc.list_schedule` | read | `schedule.view` / read | R | `GET /api/schedule`; schedule service/query layer | Company required; bounded company-local date range. |
| `svc.list_calls` | read | `pulse.view` / read | R | Pulse timeline call query; dedicated `chatgptMcpQueries.listCalls` projection | Explicit `calls.company_id` predicate; company-scoped contact join; root calls without a contact remain visible to their owning company. |
| `svc.get_schedule_item` | read | `schedule.view` / read | R | `GET /api/schedule/items/:entityType/:entityId` | Allowlisted entity types; entity and schedule joins repeat company. |
| `svc.list_tasks` | read | `tasks.view` / read | R | `GET /api/tasks`; `tasksQueries.listTasksPage` | Company required in base query/count and every parent join. |
| `svc.list_entity_tasks` | read | `tasks.view` plus host `jobs.view` or `leads.view` / read | R | `GET /api/tasks/entity/:parentType/:parentId` | Reuse host-visibility guard; foreign host is not found. |
| `svc.list_task_assignees` | read | `tasks.view` / read | R | `GET /api/tasks/assignees`; `userService.listUsers` | Active users from bound company only. |
| `svc.list_estimates` | read | `estimates.view` / read | R | `GET /api/estimates`; `estimatesService.listEstimates` | Company required in list/count and linked contact/job/lead joins; revisions are not double-counted. |
| `svc.get_estimate` | read | `estimates.view` / read | R | `GET /api/estimates/:id`; `estimatesService.getEstimate` | Estimate, items, contact, lead, job, and revision-derived data all repeat company ownership. |
| `svc.list_invoices` | read | `invoices.view` / read | R | `GET /api/invoices`; `invoicesService.listInvoices` | Company required in list/count and linked contact/job/estimate joins. |
| `svc.get_invoice` | read | `invoices.view` / read | R | `GET /api/invoices/:id`; `invoicesService.getInvoice` | Invoice, items, contact, job, estimate, and payment rollup remain company-scoped. |

#### 7.1.1 S1.1 — Pulse call journal

`svc.list_calls` is the nineteenth S1 read tool. Its exact permission pair is
`pulse.view` plus `mcp.tool.svc.list_calls`; it uses `albusto.mcp.read` and
confirmation class R. Grant bundle version 2 adds those permissions for every
active connector binding. Marketplace metadata adds `calls:read`, a Calls
access-summary row, and a Calls recommendation.

The strict input object has no required fields and rejects unknown fields:

- `limit`: integer 1–50, default 20;
- `direction`: `inbound` or `outbound`;
- `contact_id`: positive integer;
- `date_from` and `date_to`: company-local `YYYY-MM-DD` dates.

With no dates, the window is the current company-local day plus the preceding
13 days. Results sort by `started_at DESC`, then `id DESC`. The response uses
the neighboring list-tool envelope `{ rows, total }`. Each row is projected to
only `id`, `direction`, `status`, `started_at`, `answered_at`, `ended_at`,
`duration_sec`, `from_number`, `to_number`, `contact_id`, `contact_name`, and
`answered_by`. The `answered_by='ai'` value is preserved for the existing
agent-call badge meaning. The service never returns `call_sid`,
`parent_call_sid`, price fields, raw provider payloads, recordings, or recording
URLs.

The old v3 schema description is no longer authoritative: migration 012 added
`calls.company_id`. S1.1 reuses Pulse's current root-call ownership seam:

```sql
FROM calls
WHERE timeline_id = $1
  AND company_id = $2
  AND parent_call_sid IS NULL
```

The dedicated MCP query generalizes that timeline-specific read to the bound
company while retaining the same decisive predicates:

```sql
FROM calls c
JOIN companies tenant
  ON tenant.id = $1
 AND tenant.status = 'active'
LEFT JOIN contacts co
  ON co.id = c.contact_id
 AND co.company_id = c.company_id
WHERE c.company_id = tenant.id
  AND c.parent_call_sid IS NULL
```

Direct `calls.company_id` ownership—not a contact natural key—is authoritative.

#### 7.1.2 Marketplace connect panel

`ChatgptMcpConnectPanel` (frontend/src/components/settings/ChatgptMcpConnectPanel.tsx)
is the FORM-CANON right-side panel behind the app card. Installing the app
auto-opens it, and a connected card shows a `Setup` button
(`/settings/integrations?tab=marketplace&app=chatgpt-crm-mcp`). It walks the
admin through the ChatGPT side, in the order the live rollout proved necessary:
Developer mode on a computer (required, no mobile), a new connector at
`chatgpt.com/plugins` with the MCP server URL, OAuth with the pre-registered
client (`chatgpt-crm-mcp`, empty secret, token auth `none`, Registration URL
left empty — DCR is rejected by design), signing in with the same admin
account that installed the app (the binding subject must match), and
@-mentioning the connector in a chat to attach it. Access chips render from
`access_summary`, so migration 198's Calls row appears without UI changes.
A no-backend Vite harness (`frontend/chatgpt-connect-harness.html`) renders the
real component for visual review.
That is why a call with `contact_id IS NULL` remains visible to its own company
and cannot enter another company's result. The optional contact join repeats
tenant ownership and supplies only `contact_name`.

### 7.2 S2a — transactional write foundation and first seven tools

S2a exposes only the first consent-gated internal-write batch. It does not
expose files, estimates/invoices, tasks, assignment, conversion, or sends.
All seven tools are `kind=write`, `confirmationClass=W`,
`requiresConfirmation=true`, and require `albusto.mcp.write`. ChatGPT presents
the confirmation; after authorization the server executes immediately.

The executor owns the transaction:

```text
BEGIN
SELECT b.id, current_grants
FROM chatgpt_mcp_bindings b
JOIN marketplace_installations mi
  ON mi.id=b.installation_id AND mi.company_id=b.company_id
JOIN companies c
  ON c.id=b.company_id
JOIN crm_users ai
  ON ai.id=b.ai_user_id AND ai.company_id=b.company_id
JOIN crm_users human
  ON human.id=b.authorized_by_user_id AND human.company_id=b.company_id
JOIN company_memberships cm
  ON cm.user_id=human.id AND cm.company_id=b.company_id
WHERE b.id=:bindingId
  AND b.company_id=:companyId
  AND b.ai_user_id=:aiUserId
  AND b.authorized_by_user_id=:authorizerId
  AND b.status='active'
  AND mi.status='connected'
  AND c.status='active'
  AND ai.kind='agent' AND ai.status='active' AND ai.onboarding_status='active'
  AND human.status='active' AND human.onboarding_status='active'
  AND cm.status='active' AND cm.role_key='tenant_admin'
FOR SHARE OF b, mi, c, ai, human, cm;
-- recheck current entity + exact tool grants under the binding lock
handler(companyId, aiUserId, args, same_client)
COMMIT
```

An empty recheck is `403 MCP_BINDING_INVALID`; any error rolls back. Reads keep
their one request-time identity resolution. The real DB race test resolves auth,
disconnects the installation before this query, and proves the handler leaves
zero rows.

Existing bindings remain read-only. `S1_GRANTS` stays bundle v2. The separate
`S2_WRITE_GRANTS` bundle v3 is added or removed only by:

- `POST /api/marketplace/apps/chatgpt-crm-mcp/writes/enable`
- `POST /api/marketplace/apps/chatgpt-crm-mcp/writes/disable`

Both endpoints derive the company from `req.companyFilter.company_id`, require
the active human authorizer to remain a `tenant_admin`, lock the active binding,
and transactionally insert/delete only S2 write grants while changing
`binding.grant_version` to 3/2. They are idempotent. There is deliberately no
migration or write-grant backfill.

| Tool | Permission pair (business + exact) | Input/behavior | Tenant-safe seam |
|---|---|---|---|
| `svc.create_lead` | `leads.create` + `mcp.tool.svc.create_lead` | Dispatcher-editable identity, source, description/address fields and optional text note; no status. | Transactional contact resolution pairs every natural key with company and uses fill-empty-never-steal propagation. |
| `svc.update_lead` | `leads.edit` + exact | `lead_uuid` plus allowlisted non-status fields. | `SELECT ... WHERE uuid=$1 AND company_id=$2 FOR UPDATE`; update repeats both predicates. |
| `svc.transition_lead` | `leads.edit` + exact | `lead_uuid` + published-FSM `action`, never target state. | Owned row lock, `getAvailableActions(...,['dispatcher'])`, exact event match, then scoped update; no FSM fallback. |
| `svc.create_job` | `jobs.create` + exact | Dispatcher-editable customer/service/schedule/address fields and optional text note; no status. | Contact ownership/resolution and insert use the binding company in one transaction; no Zenbooker side effect in S2a. |
| `svc.update_job` | `jobs.edit` + exact | `job_id` plus allowlisted non-status fields. | `SELECT ... WHERE id=$1 AND company_id=$2 FOR UPDATE`; update repeats both predicates. |
| `svc.transition_job` | `jobs.edit`, `jobs.close` + exact | `job_id` + published-FSM dispatcher action. | Same action-only FSM seam as Leads; the close grant keeps the first batch fail-closed for any closing action. |
| `svc.add_note` | `jobs.edit`, `leads.edit`, `contacts.edit` + exact | `parent_type=job\|lead\|contact`, `parent_id`, text only. | Parent lock/update repeat company; note `created_by` is the AI `crm_users.id`; no attachment or Keycloak-sub path. |

`svc.create_lead` and `svc.create_job` claim
`mcp_tool_idempotency(company_id, agent_user_id, tool_name, idempotency_key)`
inside the same transaction. `argument_hash` is SHA-256 of recursively
key-sorted JSON; the server-derived idempotency key hashes
`bindingId + toolName + argument_hash`. A succeeded replay returns the stored
safe result and creates no second entity. Updates and transitions do not claim
this table.

### 7.2.1 S2b — deferred internal writes and files

| Tool | Kind | Required permission(s) / OAuth scope | Confirm | Wrapped route/service | Tenant-scoping note |
|---|---|---|---|---|---|
| `svc.assign_lead` | write | `leads.edit` / write | W | `POST /api/leads/:uuid/assign`; `leadsService.assignUser` | Assignee and lead both revalidated in company; join/write includes company. |
| `svc.unassign_lead` | write | `leads.edit` / write | W | `POST /api/leads/:uuid/unassign` | Same company checks as assign. |
| `svc.convert_lead` | write | `leads.convert`, `jobs.create` / write | D | `POST /api/leads/:uuid/convert`; `leadsService.convertLead` | One company-scoped transaction/idempotency claim; every contact/timeline/call/job join repeats company. |
| `svc.update_contact` | write | `contacts.edit` / write | W | `PATCH /api/contacts/:id` | Allowlisted fields; base, emails, merge/cascade queries all company-scoped. |
| `svc.update_contact_address` | write | `contacts.edit` / write | W | `PATCH /api/contacts/:id/addresses/:addressId`; `contactAddressService` | Both contact and address owned by company; cascaded leads repeat company. |
| `svc.set_contact_default_address` | write | `contacts.edit` / write | W | `PUT /api/contacts/:id/addresses/:addressId/default` | Clear/set operations include company through contact join. |
| `svc.edit_job_note` | write | `jobs.edit` / write | W | `PATCH /api/jobs/:id/notes/:noteId`; `notesMutationService.editNote` | Company-required job adapter; `edited_by=aiUser.id`. |
| `svc.delete_job_note` | write | `jobs.edit` / write | D | `DELETE /api/jobs/:id/notes/:noteId`; `notesMutationService.softDeleteNote` | Company-required job adapter; `deleted_by=aiUser.id`; foreign note is not found. |
| `svc.edit_lead_note` | write | `leads.edit` / write | W | `PATCH /api/leads/:uuid/notes/:noteId`; `notesMutationService.editNote` | Company-required lead adapter; `edited_by=aiUser.id`. |
| `svc.delete_lead_note` | write | `leads.edit` / write | D | `DELETE /api/leads/:uuid/notes/:noteId`; `notesMutationService.softDeleteNote` | Company-required lead adapter; `deleted_by=aiUser.id`; foreign note is not found. |
| `svc.edit_contact_note` | write | `contacts.edit` / write | W | `PATCH /api/contacts/:id/notes/:noteId`; `notesMutationService.editNote` | Company-required contact adapter; `edited_by=aiUser.id`. |
| `svc.delete_contact_note` | write | `contacts.edit` / write | D | `DELETE /api/contacts/:id/notes/:noteId`; `notesMutationService.softDeleteNote` | Company-required contact adapter; `deleted_by=aiUser.id`; foreign note is not found. |
| `svc.reschedule_schedule_item` | write | `schedule.dispatch` / write | D | `PATCH /api/schedule/items/:entityType/:entityId/reschedule` | Company required through local update and Zenbooker credential/side effect; idempotency required. |
| `svc.assign_job_technicians` | write | `jobs.assign`, `schedule.dispatch` / write | D | `PATCH /api/schedule/items/:entityType/:entityId/reassign` | Job and TEXT Zenbooker technician IDs validated under company; idempotency required. |
| `svc.create_task` | write | `tasks.create` / write | W | `POST /api/tasks`; `tasksQueries.createTask` | Parent visibility/ownership checked; `created_by='agent'`, `author_user_id=AI UUID`. |
| `svc.update_task` | write | `tasks.manage` / write | W | `PATCH /api/tasks/:id`; task query layer | Task and parent remain in bound company; no client author override. |
| `svc.complete_task` | write | `tasks.manage` / write | W | `POST /api/tasks/:id/actions/complete` | Company-scoped status transition; idempotent completion. |
| `svc.delete_task` | write | `tasks.manage` / write | D | `DELETE /api/tasks/:id` | Company-scoped delete; foreign row byte-unchanged. |
| `svc.create_estimate` | write | `estimates.create` / write | W | `POST /api/estimates`; `estimatesService.createEstimate` | One company-scoped transaction creates the estimate and bounded line-item array; linked contact/job/lead IDs are revalidated under company. |
| `svc.update_estimate` | write | `estimates.create` / write | W | `PUT /api/estimates/:id`; `estimatesService.updateEstimate` | Reuse canonical full update and line-item replacement; estimate, every retained/replaced item, and linked entities repeat company scope. |
| `svc.create_invoice` | write | `invoices.create` / write | W | `POST /api/invoices`; `invoicesService.createInvoice` | One company-scoped transaction creates the invoice and line items; contact/job/estimate links are company-owned. |
| `svc.update_invoice` | write | `invoices.create` / write | W | `PUT /api/invoices/:id`; `invoicesService.updateInvoice` | Reuse canonical full update and line-item replacement; no item-ID-only mutation is reachable. |
| `svc.convert_estimate_to_invoice` | write | `estimates.view`, `invoices.create` / write | D | `POST /api/estimates/:id/convert`; `estimatesService.convertToInvoice` | Canonical approved-estimate conversion only; estimate, items, created invoice, reciprocal links, and events are company-scoped and idempotent. |
| `svc.begin_note_attachment_upload` | write | corresponding entity edit permission / write | W | new two-step facade over `noteAttachmentsService.stageAttachments` | Entity ownership first; no source URL; storage key contains company; AI UUID uploader; bounded size/type/checksum. |
| `svc.commit_note_attachments` | write | corresponding entity edit permission / write | W | hardened `noteAttachmentsService.associateStagedAttachments` | Upload IDs, object metadata/checksum, entity, note, and company must all match; commit once. |

### 7.3 S3 — customer sends

| Tool | Kind | Required permission(s) / OAuth scope | Confirm | Wrapped route/service | Tenant-scoping note |
|---|---|---|---|---|---|
| `svc.send_sms` | external write | `messages.send` / `albusto.mcp.send` | I | `POST /api/messaging/:id/messages` and safe company-owned conversation creation | Accept contact/conversation IDs and body, never arbitrary proxy/recipient phone; resolve owned contact phone and company Twilio number; idempotency required. |
| `svc.send_email` | external write | `messages.send` / send | I | `POST /api/email-timeline/contacts/:contactId/send`; `emailTimelineService.sendForContact` | Recipient must be an email already owned by that company contact; sender/mailbox from company config; AI UUID actor; idempotency required. |

### 7.4 S4 — payments (deferred, outside v1)

No payment tool is registered or granted in v1. Future payment work requires a separate owner-approved spec amendment covering customer consent, no-raw-PAN schemas, invoice-balance locking, provider idempotency, and delivery truthfulness. The current Stripe/platform-wallet surfaces are not wrapped by this connector.

## 8. Tenant-write-canon blockers

These blockers are fixed and tested before the corresponding tool is discoverable. “The caller already checked” is not acceptable; public service signatures require `companyId`, and each query/mutation repeats it.

| Blocker | Current evidence | Required repair before exposure |
|---|---|---|
| Service MCP default tenant and synthesized actor/permissions | `backend/src/services/agentSkillsMcpPublicAuth.js:22-24,71-76,87-95,98-127` | Remove defaults; require explicit dev company and AI user; resolve exact DB grants; production hard-off. |
| Optional/unscoped job lookup and tag child read | `backend/src/services/jobsService.js:657-681` | Make company required; pass it into company-scoped tag lookup. |
| Job status pre-read/update and hardcoded no-FSM fallback | `backend/src/services/jobsService.js:1133-1179`; fallback behavior `backend/src/services/fsmService.js:614-618` | Company-required pre-read/update; connector facade requires published FSM and never enters fallback. |
| Job note unscoped fallback | `backend/src/services/jobsService.js:1527-1566` | Remove optional company signature and ID-only SQL branches; AI UUID required. |
| Job cancel/en-route/start/complete ID-only paths | `backend/src/services/jobsService.js:1601-1678`; route applies them at `backend/src/routes/fsm.js:273-279` | Add required company to every read/write and outbound credential lookup; no ID-only update. |
| Lead update optional company, unscoped metadata/status reads, permissive FSM fallback | `backend/src/services/leadsService.js:571-605,619-637` | Require company on reads/update; split non-status update from fail-closed transition facade. |
| Lead assignment optional scope and child write keyed only by lead ID | `backend/src/services/leadsService.js:699-716`; route omits company at `backend/src/routes/leads.js:759-768` | Require company, validate assignee company, and company-scope assignment write/join. |
| Lead conversion optional tenant and ID-only related writes/joins | `backend/src/services/leadsService.js:906-919,923-940,1009-1035` | Require company and transaction/idempotency claim; repeat company on contact, lead, job, timeline, and calls reads/writes. |
| Lead route owns unscoped contact/address/job-sync mutations | `backend/src/routes/leads.js:592-640,666-713` | Extract company-required service used by both HTTP route and MCP wrapper; scope cascades and async work. |
| Contact phone/email natural keys are non-unique, including within one company | contact read/search paths | Scope every lookup by `company_id`; do not add uniqueness or deduplicate contacts in this feature. Contact deduplication is a separate deferred project. |
| Contact lookup/child email helpers accept or use no company | `backend/src/services/contactsService.js:224-243,275-294` | Require company and company-own the contact before every child read. |
| Contact route email reconciliation and address cascades are ID-only | `backend/src/routes/contacts.js:484-520,687-729,747-768`; `backend/src/services/contactAddressService.js:85-95,109-202` | Extract transaction-safe company-required services; every address/contact-email/lead predicate includes company via owned join. |
| Estimate/invoice reads leave contact/address/item child reads unscoped | `backend/src/db/estimatesQueries.js:listEstimates,getEstimateById,getEstimateItems`; `backend/src/db/invoicesQueries.js:listInvoices,getInvoiceById,getInvoiceItems` | Before S1 registration, use company-required read facades whose contact/address/item joins repeat parent `company_id`; never rely on a prior parent check for an ID-only child query. |
| Estimate create/update and line-item replacement are not one transaction and item queries/mutations use parent ID only | `backend/src/services/estimatesService.js:createEstimate,updateEstimate`; `backend/src/db/estimatesQueries.js:replaceEstimateItems,recalculateEstimateTotals` | Before S2 registration, extract a transaction-aware company-required service; validate linked contact/job/lead ownership and scope every item delete/insert/recalc through an owned estimate join. |
| Invoice create/update and line-item replacement are not one transaction and item mutations use invoice/item ID only | `backend/src/services/invoicesService.js:createInvoice,updateInvoice,updateItem,removeItem`; `backend/src/db/invoicesQueries.js:replaceInvoiceItems,updateInvoiceItem,deleteInvoiceItem,recalculateInvoiceTotals` | Before S2 registration, make the canonical full create/update atomic and company-required; validate all linked entities and scope every line-item mutation/recalc through an owned invoice join. |
| Estimate-to-invoice conversion can race and performs a multi-step, non-transactional copy | `backend/src/services/estimatesService.js:convertToInvoice` | Before S2 registration, atomically lock the company-owned approved estimate, claim conversion idempotency, copy only company-owned items, create the company invoice, and record reciprocal events; concurrent/replayed conversion returns the same canonical invoice rather than duplicating it. |
| Note mutation authorship uses Keycloak sub | `backend/src/services/notesMutationService.js:19-22,58-65,124-149`; route fallback example `backend/src/routes/leads.js:919-964` | Require AI CRM UUID for create/edit/delete; remove sub fallback; adapters require company. |
| File staging is server-buffer upload and trusts declared MIME | `backend/src/services/noteAttachmentsService.js:37-68,197-236` | Add presigned begin/commit, signed size/checksum, object HEAD/content inspection and malware policy; no URL fetch. Existing company-scoped commit predicate is retained. |
| SMS start accepts arbitrary destination/proxy values | `backend/src/routes/messaging.js:158-171` | MCP wrapper accepts owned contact/conversation only and resolves both numbers server-side. |
| Email route stamps Keycloak sub | `backend/src/routes/emailTimeline.js:41-48` | Pass AI CRM UUID and retain company/contact-recipient validation. |
| Deferred payment surfaces remain unsafe for MCP exposure | event-only link send at `backend/src/services/stripePaymentsService.js:306-314`; platform wallet at `backend/db/migrations/109_billing_wallet.sql:1-13` is unrelated | Keep every payment tool, scope, and grant unregistered in v1. A future spec must solve real delivery, tenant-customer consent, balance locking, and idempotency before exposure. |

S2a closes only its reachable rows. `leadsService.createLead/updateLead` now
reject a missing company; the update's metadata/status pre-reads and mutation
all repeat `company_id`. `jobsService.updateBlancStatus` now rejects a missing
company, scopes its pre-read, and mutates with
`WHERE id=$3 AND company_id=$4`. The MCP batch does not call the remaining
optional job action helpers: its dedicated transaction-bound data layer scopes
every parent/contact/note read and write and uses the AI UUID.
`jobsService.addNote` now rejects a missing company and every existing caller
passes an explicit company; its job read and both note updates always repeat
`company_id`. UI job/lead/contact note creation also no longer falls back from
`crmUser.id` to Keycloak `sub`. All other table rows above remain S2b blockers
and their tools remain unregistered.

Shared HTTP routes remain green after hardening. No MCP wrapper may call a forbidden optional-company helper.

## 9. Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET /.well-known/oauth-protected-resource[ /mcp/chatgpt]` | no tenant data | fixed resource URI | public metadata only | public ✓; all roles n/a | Metadata must not contain company/install/user data. |
| Marketplace install/reconnect/disconnect | `req.companyFilter.company_id` from active human membership | app key / installation UUID + company | `tenant.integrations.manage` plus explicit v1 tenant-admin check | tenant_admin ✓; manager ✗; dispatcher ✗; provider ✗; custom ✗; platform-only ✗ | Provisions/revokes an identity with external-send and money capabilities. |
| `POST/GET /mcp/chatgpt` authentication | validated token → unique active binding → company | issuer + subject + client ID; never client company | valid audience/client/resource/scope and active binding chain | bound AI agent ✓; human roles cannot call as actors ✗ | Wrong/ambiguous binding could grant a whole tenant; fail closed. |
| S1 read tools | binding company | tenant entity ID or company-paired natural key | exact tool key + read business permission + read scope | exact AI grant ✓; tenant_admin/manager/dispatcher/provider/custom direct MCP actor ✗ | Aggregates, shared phone/email/external IDs, and child joins can leak B. |
| S2 internal writes/files | binding company, rechecked before mutation | entity ID plus company; idempotency key where required | exact tool key + listed business permission + write scope | exact AI grant ✓; all human roles as direct MCP actor ✗ | ID-only mutation, FSM fallback, async cascade, or attachment adoption can alter B. |
| S3 sends | binding company and company-owned recipient/sender resolution | contact/conversation ID + company; idempotency key | exact tool key + `messages.send` + send scope | exact AI grant ✓; all human roles as direct MCP actor ✗ | Arbitrary recipient/proxy or retry can message the wrong customer. |
| S4 payments (deferred) | no v1 surface | n/a | no scope, grant, or registered tool | all actors ✗ | Any discovered/invocable payment tool is a release-blocking v1 failure. |
| `mcp_tool_invocations` / idempotency writes | trusted execution context | request/tool/idempotency key + company + AI user | internal only | connector executor ✓; all direct callers ✗ | Missing company or weak uniqueness could replay across tenants. |
| fixed-bearer `POST /mcp/agent-skills` | non-prod explicit env company + resolved AI user | fixed bearer + company/agent configuration | same exact DB grants; no synthesized broad permission | configured AI agent ✓; production ✗; human roles ✗ | Current default company is unsafe; absence of any required env must disable path. |

## 10. Mandatory four-class test contract

Every inventory row is entered into a parameterized contract; a stage is incomplete while any row lacks one of these classes.

- `T-own`: the bound AI for company A can discover and invoke its granted tool on an A record; the expected result/audit/side effect occurs once.
- `T-foreign`: the same call with a company B entity returns MCP `not_found` (HTTP transport remains protocol-correct), never reveals that B exists, creates one denied audit outcome, and leaves the complete B snapshot byte-unchanged.
- `T-blast`: seed A and B with the same phone, email, external ID, invoice number, timeline SID, and relevant local identifiers; invoke in A; snapshot all B parents and children before/after. For writes include contacts, contact emails/addresses, leads, jobs, assignments, notes, attachments, timelines, calls, messages, tasks, invoices, payment sessions/transactions, grants, bindings, and audit/idempotency rows.
- `R-matrix`: for every tool test allow with all gates, then deny when each is independently absent: OAuth scope, business permission, exact synthetic tool grant, active AI user, active human membership, active company, connected installation, active binding. Also verify all human roles cannot act directly through the connector and every deny cell from the Tenancy & Roles table.

Foreign entity failures are 404/`not_found`; role/scope/grant failures are 403/`access_denied` before entity lookup. DB suites never return early as success when PostgreSQL/schema is missing. The release command requires its DB URL and fails setup if unavailable; all DB suites run `--runInBand`.

## 11. Attack-only red-team plan

After each implementation stage passes its authored tests, a fresh session that did not implement the stage performs an attack-only review. It may add adversarial tests but does not rewrite happy paths. Its report maps every exploit attempt to blocked, reproduced, or parked-with-release-blocker.

Attack corpus:

- forged issuer, signature, `aud`, `azp`, resource, scope, expiry/not-before, query token, and malformed `WWW-Authenticate` discovery;
- company A token with B IDs, B natural keys, `company_id`/`companyId` arguments, tenant headers, duplicate/ambiguous bindings, and disconnect/suspension races;
- unmapped tool, hidden tool invoked directly, extra JSON keys, prototype-shaped objects, oversized strings/pages, and tool-name confusion with pre-existing voice skills;
- prompt/data text that asks the client to call hidden tools, alter arguments, bypass confirmation, or select another company; record text is data and cannot change server authorization;
- status events with no published FSM, forged target status, non-action transition, closing without `jobs.close`, and race between transition resolution and update;
- shared phone/email/SID/external ID blasts through contact dedupe, timeline adoption, async cascades, SMS/email, and Zenbooker credentials;
- file URL/SSRF, path traversal filename, MIME spoof, checksum/size mismatch, foreign upload ID, cross-entity commit, replayed commit, malicious content, and abandoned staging;
- send to arbitrary raw phone/email/proxy, foreign conversation/contact, provider retry, and same/different-payload idempotency replays;
- deferred-surface discovery: try to enumerate or directly invoke plausible payment tool names and payment OAuth scope; all must remain absent/denied without a Stripe call.

The red team must inspect raw company B state, provider fakes, and audit/idempotency rows; asserting only that a helper was called is insufficient.

## 12. Named sabotage minimum

Each control is executed against the real code path after taking a `cp` backup. The implementer makes the stated single break, runs the named test and records non-zero/red, restores from the backup (never `git checkout`), reruns green, then deletes the temporary backup.

| Control | Invariant | Deliberate break | Test that must go red |
|---|---|---|---|
| `SAB-MCP-UNMAPPED` | A tool without a non-empty mapped permission is absent and denied. | Change `mcpToolAuthorization.canInvoke` to allow an empty required set, or remove the test tool's mapping while forcing discovery. | `chatgptMcpAuthorization.test.js` — `SAB-MCP-UNMAPPED`. |
| `SAB-MCP-FOREIGN` | Company A calls cannot read or mutate B and return `not_found`. | Remove the `company_id` predicate from the dedicated test target's base query. | `chatgptMcpTenancy.db.test.js` — `SAB-MCP-FOREIGN` and B snapshot assertion. |
| `SAB-MCP-SEND-PERM` | Send is unreachable without scope, business permission, and exact tool grant. | Remove `messages.send` from `svc.send_sms.requiredPermissions` (then separately the exact grant/scope gate). | `chatgptMcpSends.test.js` — `SAB-MCP-SEND-PERM`; outbound provider fake remains at zero. |
| `SAB-MCP-DEFERRED-PAYMENTS` | No payment capability is registered or granted in v1. | Add a plausible `svc.collect_invoice_saved_method` descriptor or payment grant to the S1 bundle. | `chatgptMcpAuthorization.test.js` — `SAB-MCP-DEFERRED-PAYMENTS`. |
| `SAB-MCP-OAUTH-TENANT` | A token maps only through its unique active binding and cannot act on B. | Resolve binding by human subject only while ignoring installation/company uniqueness, or trust a client company argument. | `chatgptMcpIdentity.db.test.js` — `SAB-MCP-OAUTH-TENANT`; ambiguous binding denied and B snapshot unchanged. |
| `SAB-MCP-WRITE-CONSENT` | Existing/read-only bindings cannot discover or invoke writes without both v3 grants and `albusto.mcp.write`. | Merge S2 grants into `S1_GRANTS`, skip the live grant recheck, or omit the write-scope requirement. | `chatgptMcpAuthorization.test.js` write discovery contract plus `chatgptMcpWrites.test.js` stale-grant and missing-scope cases. |
| `SAB-MCP-DISCONNECT-RACE` | A revoked binding/install between request auth and execution leaves zero domain rows. | Remove `requireLiveBinding` from the transaction or run it before `BEGIN`. | `chatgptMcpWrites.db.test.js` — `SAB-MCP-DISCONNECT-RACE`; marker Lead count stays zero. |
| `SAB-MCP-WRITE-BLAST` | Every S2a parent/contact lookup and mutation pairs its key with the bound company. | Remove the company predicate from any of the seven handlers. | `chatgptMcpWrites.db.test.js` per-tool own/foreign loop; foreign call is not-found and the tenant-B byte snapshot is unchanged. |
| `SAB-MCP-CREATE-REPLAY` | Identical create calls under one binding return the stored result without a second Lead/Job. | Bypass the idempotency claim or omit binding/tool/argument hash from its key. | `chatgptMcpWrites.db.test.js` replay assertions for both create tools; canonical entity count must remain one. |
| `SAB-MCP-FSM-CLOSED` | Missing/unavailable company-published FSM action never mutates status. | Skip `getAvailableActions` or accept `resolveTransition(...).fallback`. | `chatgptMcpWrites.db.test.js` — unavailable/injected action is denied after own/foreign transition checks. |
| `SAB-MCP-ACTOR` | Every S2a note author is the AI CRM UUID, never human `sub`. | Pass the decoded Keycloak subject or human authorizer to the note target. | `chatgptMcpWrites.db.test.js` — Job, Lead, and Contact note `created_by` fields equal the bound AI UUID. |
| `SAB-MCP-ESTIMATE-ITEMS` | An estimate update cannot replace another company's line items. | Remove the company-owned estimate join/predicate from the S2 line-item replacement target. | `chatgptMcpInternalWrites.test.js` — `SAB-MCP-ESTIMATE-ITEMS`; company B snapshot changes only under the break. |
| `SAB-MCP-INVOICE-ITEMS` | An invoice update cannot replace another company's line items. | Remove the company-owned invoice join/predicate from the S2 line-item replacement target. | `chatgptMcpInternalWrites.test.js` — `SAB-MCP-INVOICE-ITEMS`; company B snapshot changes only under the break. |

## 13. Stage verification plan

All commands run from the worktree root. They use the main checkout's Jest binary, bundled CA, and serial DB execution per `docs/agents/gpt-lessons.md`. Exact suite/test counts and exit status are recorded during implementation; this spec does not invent counts before the tests exist.

### S1 command — OAuth, identity, registry, reads, tenancy

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/chatgptMcpOAuth.test.js tests/chatgptMcpIdentity.db.test.js tests/chatgptMcpAuthorization.test.js tests/chatgptMcpReads.test.js tests/chatgptMcpCalls.test.js tests/chatgptMcpTenancy.db.test.js tests/agentSkillsMcp.test.js tests/tenantSafetyLint.test.js
```

### S2a command — write foundation, consent, first seven tools, and regressions

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/chatgptMcpOAuth.test.js tests/keycloakAuthMcpIsolation.test.js tests/chatgptMcpIdentity.db.test.js tests/chatgptMcpAuthorization.test.js tests/chatgptMcpReads.test.js tests/chatgptMcpCalls.test.js tests/chatgptMcpTenancy.db.test.js tests/chatgptMcpWrites.test.js tests/chatgptMcpWrites.db.test.js tests/chatgptMcpConsentRoutes.test.js tests/agentSkillsMcp.test.js tests/tenantSafetyLint.test.js
```

Company-scoped service regressions:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/jobsStatusUpdate.test.js tests/jobsPartArrived.test.js tests/jobsPartArrivedForward.test.js tests/jobsService.test.js tests/notesEditDelete.test.js tests/relyLeadIngest.test.js
```

The DB command uses a real PostgreSQL schema through `DATABASE_URL`. The
`chatgptMcpWrites.db` suite performs consent enable/disable, a real stale-auth
disconnect race, protocol/executor T-own/T-foreign/T-blast for each of the seven
tools, byte snapshots of tenant B, replay checks for both creates, action-only
FSM denial, fill-empty-never-steal contact checks, and AI-UUID note authorship.

### S2b command — remaining internal writes, FSM, authorship, files, route regressions

```bash
node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --config ./package.json --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/chatgptMcpInternalWrites.test.js tests/chatgptMcpAuthorship.db.test.js tests/chatgptMcpFiles.test.js tests/chatgptMcpTenancy.db.test.js tests/estimatesConvert.test.js tests/invoicesQueriesReplaceItems.test.js tests/invoicesUpdateItems.test.js tests/jobsCreate.test.js tests/jobsStatusRbac.test.js tests/jobsStatusUpdate.test.js tests/leadsService.convert.test.js tests/contactsPatchEmails.test.js tests/notesEditDelete.test.js tests/scheduleReassign.test.js tests/scheduleServiceRescheduleZb.test.js tests/tasksActionRoute.test.js tests/tasksLeadUuid.test.js tests/tenantSafetyLint.test.js
```

### S3 command — customer sends

```bash
node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --config ./package.json --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/chatgptMcpSends.test.js tests/chatgptMcpTenancy.db.test.js tests/emailTimelineOutbound.test.js tests/emailMailboxMultitenancy.test.js tests/contactsPulseTenantIsolation.test.js tests/tenantSafetyLint.test.js
```

### S4 — payments deferred

There is no S4 implementation command in v1. S1/S2 authorization tests assert that no payment scope, grant, descriptor, or tool name is exposed.

### Full MCP regression

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/agentSkillsMcp.test.js tests/chatgptMcpOAuth.test.js tests/keycloakAuthMcpIsolation.test.js tests/chatgptMcpIdentity.db.test.js tests/chatgptMcpAuthorization.test.js tests/chatgptMcpReads.test.js tests/chatgptMcpCalls.test.js tests/chatgptMcpTenancy.db.test.js tests/chatgptMcpWrites.test.js tests/chatgptMcpWrites.db.test.js tests/chatgptMcpConsentRoutes.test.js tests/tenantSafetyLint.test.js
```

Backend-only means there is no frontend build/test gate for this project. The protected-file gate for D1 is an exact-diff inspection:

```bash
git diff --unified=0 -- src/server.js
git diff --numstat -- src/server.js
```

D1 authorized exactly two connector `require(...)` declarations and two mounts
in the already-merged S1 baseline. S2a does not edit this protected file:
`git diff --exit-code -- src/server.js` must return 0.

### 13.1 End-to-end real MCP client checks

The architect, not a mocked Jest client, performs both:

1. **Fixed-bearer development path.** Start the backend in a non-production environment with an explicit test company, explicit active AI CRM user, fixed token, and seeded exact grants. Point a real MCP client at `POST /mcp/agent-skills` with that bearer token. Complete initialize, list tools, call owned job and estimate/invoice reads, verify every S2/S3/deferred-payment tool is absent, and inspect DB audit/tenant state. No default tenant/user is permitted.
2. **OAuth connector path.** Configure the real ChatGPT connector with `https://api.albusto.com/mcp/chatgpt`, sign in through `crm-prod`, inspect consent and tool discovery, execute owned job and estimate/invoice reads, disconnect Marketplace, and prove the still-unexpired token can perform zero further work. Repeat the A-token/B-entity attack.

Acceptance evidence includes client transcript, request/trace IDs, DB invocation rows, provider fake/log evidence for zero unintended sends/charges, and company B before/after snapshots. Secrets and bearer tokens are redacted.

## 14. S1–S4 staged build plan

### S1 — OAuth connector, AI identity, and reads

Tasks:

1. Recheck migration maximum; add paired forward/rollback migrations for Marketplace app metadata, AI user kind, bindings, grants, and invocation audit; provision/revoke AI user transactionally.
2. Document the `chatgpt-crm-mcp` public client and three client scopes for the `crm-prod` realm. Keycloak realm/client configuration is an operator action and is not built into S1.
3. Implement resource metadata, connector-specific JWT validation, unique subject-to-binding mapping, active-chain recheck, scope gate, and 401 challenges.
4. Extend the existing registry/protocol/transport with exact per-tool keys and all S1 read tools, including estimate and invoice list/detail. S1.1 adds the tenant-scoped Pulse call-history list as bundle version 2.
5. Harden the fixed-bearer dev path so it requires explicit company and AI user and uses DB grants.
6. Apply D1 by adding only the two required public mounts and two requires to protected `src/server.js`.
7. Add S1 contract, OAuth, DB tenancy, protocol, sabotage, and real-client tests.

Acceptance criteria:

- a real connector completes OAuth Code + PKCE and lists only granted read tools;
- one token resolves to exactly one active company/AI identity; ambiguous/revoked/suspended cases do zero work;
- every read—including estimate/invoice list/detail and S1.1 call history—passes T-own/T-foreign/T-blast/R-matrix and logs the AI/user/binding context without leaking record data;
- the fixed bearer path has no defaults and cannot run in production;
- `SAB-MCP-UNMAPPED`, `SAB-MCP-FOREIGN`, and `SAB-MCP-OAUTH-TENANT` each prove break-red-restore-green;
- S1 verification and real-client fixed-bearer read pass.

### S2a — transactional foundation and first write batch

Implemented scope:

1. Transactional executor rechecks binding/install/company/AI/authorizer and
   current grants under a binding share-lock before the first side effect.
2. Tenant-admin-only enable/disable endpoints manage a separate v3 write bundle;
   existing/read-only bindings receive no migration backfill.
3. Register only create/update/transition for Leads and Jobs plus text-only
   `svc.add_note`, all with strict schemas, write scope, exact grants, and W
   confirmation annotations.
4. Use action-only published FSM transitions, AI CRM UUID notes, contact
   fill-empty-never-steal behavior, and transaction-local create idempotency.
5. Gate with a real disconnect race and per-tool real-DB
   T-own/T-foreign/T-blast through the executor/protocol path.

Acceptance: discovery is 19 before consent, 26 after enable, and 19 after
disable; stale resolved auth plus disconnect leaves zero rows; tenant B remains
byte-identical for every own/foreign call; both creates replay to one entity;
unavailable FSM actions do not mutate; `src/server.js`, frontend, migrations,
S2b, and S3 are untouched.

### S2b — remaining internal writes and file attachment

Carry-forward prerequisites from the S1 red-team:

- S2a satisfies the common write prerequisite: immediately before every S2/S3 side effect, re-resolve the active binding, company, AI agent, Marketplace installation, and human authorizer chain. Every later handler must use that executor and retain a real disconnect-between-authorization-and-side-effect race proving zero mutation/provider work.
- Strengthen the read contract with real-PostgreSQL T-own/T-foreign/T-blast calls through the MCP protocol for every S1 read tool, rather than mocked read seams, and add a real signed-token verification test rather than mocking `jwt.verify`. These are required S2 regression gates.

Tasks:

1. Fix the applicable Section 8 service signatures and query/join predicates before registering any write tool.
2. Extract route-owned contact/lead/note business logic into company-required reusable services; keep HTTP behavior/regression tests intact.
3. Implement the S2 registry handlers, narrow schemas, dynamic host/entity permission checks, transaction boundaries, AI authorship, invocation audit, and idempotency.
4. Implement job and lead event transitions against the company's published FSM; remove fallback only from the new safe facade and harden shared writers.
5. Implement company-required estimate/invoice create and full update with line-item replacement, then the canonical approved-estimate conversion; make each operation atomic and idempotent where required.
6. Add two-step attachment begin/commit with owned entity/note, signed checksum/size, content inspection policy, and cleanup.
7. Run every S2 contract and sabotage plus the existing route regressions.

Acceptance criteria:

- no S2 tool is discoverable until its blocker is fixed and its exact grant exists;
- all writes use explicit company signatures and company predicates at base and joined tables;
- no-published-FSM produces no mutation;
- domain FK actor and central `created_by` are the AI CRM UUID;
- attachment upload/commit cannot cross company/entity/note and cannot fetch a URL;
- estimate/invoice full updates cannot adopt, overwrite, or delete another company's line items; concurrent estimate conversion cannot duplicate an invoice;
- `SAB-MCP-FSM-CLOSED`, `SAB-MCP-ACTOR`, `SAB-MCP-ESTIMATE-ITEMS`, `SAB-MCP-INVOICE-ITEMS`, and foreign-write/file blasts prove break-red-restore-green;
- S1 remains green and S2 verification passes.

### S3 — customer SMS and email sends

Tasks:

1. Build company-required send facades that accept owned contact/conversation identifiers, never an arbitrary proxy or recipient.
2. Resolve company credentials, sender, recipient, and timeline/conversation under the same tenant; stamp AI actor/audit.
3. Require `messages.send`, exact tool grant, `albusto.mcp.send`, idempotency, and `I` confirmation metadata.
4. Add provider fakes and contract/attack tests for duplicate, foreign, arbitrary-recipient, disconnect-race, and provider-error behavior.

Acceptance criteria:

- sends are absent and directly denied if any one gate is missing;
- each approved call sends at most once and records the AI actor;
- raw recipient/proxy inputs and foreign conversations/contacts are rejected before provider call;
- provider errors do not report success and are safely auditable;
- `SAB-MCP-SEND-PERM` proves break-red-restore-green;
- S1/S2 remain green and S3 verification passes.

### S4 — payments deferred

No S4 payment task is in v1. No payment scope is advertised, no payment permission or exact tool grant is provisioned, and no payment descriptor or handler is registered. Future payment work requires a new owner-approved design and gate; it must not be smuggled into S2 invoice editing or S3 messaging.

## 15. Risks and explicit pushback

1. **ChatGPT confirmation is not a server-verifiable authorization artifact.** Tool annotations and connector settings can make ChatGPT ask, but a stolen valid bearer token can call the MCP endpoint directly. Because the owner locked out a server-side approval/draft token, this remains a high residual risk for writes and sends. Short token lifetimes, revocation checks, exact grants, idempotency, limits, and audit reduce impact but do not prove a human clicked Approve.
2. **Static-client interoperability is unproven.** Pre-registration is safer than open DCR, but the live ChatGPT connector may require a different client-identification path. S1 treats the real-client handshake as a critical-path gate and pauses before enabling DCR.
3. **Current shared writers are not safe enough to wrap.** Registering tools before Section 8 hardening would convert latent ID-only paths into remotely callable cross-tenant write risks. The ordering is a release blocker, not optional refactoring.
4. **Payments are deliberately absent.** Estimate/invoice editing must not gain any payment-link or collection side effect. A future payment stage still needs a customer-consent model; platform wallet credentials are not customer invoice credentials.
5. **File upload expands the attack surface.** Two-step upload needs checksum/content verification, tenant-bound object keys, and cleanup; MIME strings alone are inadequate.
6. **External side effects outlive database rollbacks.** Sends, Zenbooker writes, and Stripe calls require durable idempotency claims and reconciliation states rather than assuming a transaction can undo a provider call.

## 16. Definition of done

V1 is done only when S1–S3 acceptance criteria are met and S4 remains absent; every v1 inventory tool has all four contract classes; every named sabotage was observed red after a real break and green after `cp` restore; the attack-only red team has no unmitigated tenant/auth finding; the real fixed-bearer and OAuth client tests pass; migrations and rollbacks use free numbers; existing route/MCP regressions remain green; and protected `src/server.js` contains only the explicitly approved four-line hook.
