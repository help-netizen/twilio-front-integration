# TENANT-ISO-002 — part 2

Status: implemented and verified locally on 2026-08-14; not deployed. Part 1
(`3605ecb9`, migrations 262/263) is an accepted production baseline and is not
reopened here.

## Scope and decisions taken

- T6 reuses `api_integrations`. Machine rows are identified by nullable
  `machine_surface` (`vapi_tools` or `sales_mcp_public`). Ordinary integration
  rows remain unchanged.
- A Sales MCP credential has a mandatory `actor_user_id`. The composite FK
  `(actor_user_id, company_id) → company_memberships(user_id, company_id)` binds
  that actor to the same company at the database layer; runtime authorization is
  still resolved live on every request.
- No migration contains a plaintext secret or a hash literal. Existing
  `VAPI_TOOLS_SECRET` and `SALES_MCP_PUBLIC_TOKEN` values are one-time operator
  inputs to `provision-machine-credential.js` for ABC Homes.
- The Vapi master key authorizes Albusto as a platform. It creates one Vapi
  organization per company, but never determines the local tenant. The local
  `api_integrations.secret_hash → company_id` binding is authoritative.
- The undocumented `POST /org` response is accepted only when it is an object
  with a non-trivial string `id` and string `privateKey`. Any status, JSON, or
  shape deviation fails closed before a connection or credential is written.
- A stable `Idempotency-Key: albusto-vapi-org:<company>:<environment>` is sent,
  but no security decision relies on Vapi honoring it. A local transaction,
  advisory lock, and existing scoped connection make successful replays
  idempotent.
- `VAPI_WEBHOOK_SECRET` is mandatory and independent. Call status no longer
  falls back to a tool credential.
- SMS media uses a five-minute, file-specific browser capability bound to
  `(media_id, company_id)`. A full Keycloak token is never placed in an image or
  download URL. The capability shares the existing Twilio-media HMAC codec and
  server secret convention with media-stream tokens, while strict purpose and
  claim validation prevents cross-use.
- The protected `src/server.js` is not changed. The exact handoff patch is below.

## T6 — company-bound machine credentials

Migration 264 adds:

- `api_integrations.machine_surface`;
- `api_integrations.actor_user_id`;
- allowed-surface and Sales-actor checks;
- the same-company membership FK;
- a unique `(machine_surface, secret_hash)` partial index and a company/surface
  lookup index;
- `provider_connections.provider_org_id` and a provider/org unique index.

`machineCredentialService.resolveCredential` hashes the incoming secret with the
existing `BLANC_SERVER_PEPPER` convention and queries only the requested surface.
It requires exactly one row and then checks revocation, expiration, active
company, stored scope shape, and the required access scope. `last_used_at` is
updated synchronously with the same hash/surface/company/scopes and active-state
predicates, closing a revoke-between-lookup-and-use race. A lookup or update
database error is a 503 denial. It
returns only credential id, company id, actor id, scopes, and surface.

Denial contract:

| Condition | HTTP surface result | Tenant work |
|---|---:|---|
| missing/unknown/duplicate/revoked/expired secret | 401 | none |
| required scope absent or company inactive | 403 | none |
| hash configuration, corrupt stored scopes, or database failure | 503 | none |

Provisioning is an explicit CLI operation and requires `--company-id`. Plaintext
is read from a named environment variable, never put in SQL or logs:

```bash
VAPI_TOOLS_SECRET='<existing ABC tool secret>' \
node backend/scripts/provision-machine-credential.js \
  --company-id 00000000-0000-0000-0000-000000000001 \
  --surface vapi_tools \
  --scope vapi_tools:invoke \
  --secret-env VAPI_TOOLS_SECRET

SALES_MCP_PUBLIC_TOKEN='<existing ABC Sales MCP token>' \
node backend/scripts/provision-machine-credential.js \
  --company-id 00000000-0000-0000-0000-000000000001 \
  --surface sales_mcp_public \
  --actor-user-id '<active ABC crm_users.id>' \
  --scope sales_mcp_public:access \
  --scope contacts.view \
  --scope leads.view \
  --scope tasks.view \
  --scope sales.crm.write \
  --secret-env SALES_MCP_PUBLIC_TOKEN
```

Omit `sales.crm.write` for a read-only credential. After verification, remove
both legacy values from the API process environment; clients/Vapi still retain
their plaintext copy.

## T7 — public Vapi tools

`vapi-tools.js` no longer contains `VAPI_COMPANY_ID` and does not read
`VAPI_TOOLS_SECRET`. Its auth middleware resolves `x-vapi-secret` through T6 and
sets `req.vapiCompanyId` only from the returned credential.

Payload `companyId`, `tenant_id`, model arguments, and
`assistantOverrides.variableValues` are untrusted. Correlated server values and
the credential company are spread last. For an outbound-looking call, an absent
or ambiguous correlation, or a correlation to another company, produces a
speech-safe refusal before `agentSkills.runSkill`; no skill write occurs.

`vapiCallStatus.js` accepts only `VAPI_WEBHOOK_SECRET`. This secret is a webhook
authenticator; company still comes only from the uniquely correlated outbound
attempt row.

## T8 — public Sales MCP

The public transport retains the explicit `SALES_MCP_PUBLIC_ENABLED=true` rollout
gate, but removes runtime token/company/user/write env mapping. Every request:

1. authenticates a `sales_mcp_public` credential with
   `sales_mcp_public:access`;
2. calls `resolveCompanyUserAuthz(credential.companyId,
   credential.actorUserId)` with no cross-request cache;
3. exposes `live RBAC permissions ∩ credential scopes` to MCP discovery and
   execution.

A write therefore needs all of: the credential's `sales.crm.write`, the live
actor's `sales.crm.write`, and the existing per-call confirmation. Revoking the
membership or changing RBAC affects the next request immediately.

An SSE session stores only its credential id and company id. `/messages`
reauthenticates and resolves live RBAC again; a different credential or company
gets `MCP_SSE_CREDENTIAL_MISMATCH` before protocol/tool execution. The fresh
request context, not the SSE-open snapshot, executes the tool.

### MCP parity

T8 changes the public Sales MCP connector's visible `tools/list`: it is now the
intersection of live actor RBAC and credential scopes. Tool names, schemas,
registry implementations, and confirmation rules are unchanged.
`chatgptMcpPermissions.js` and `agentSkillsMcpRegistry.js` are unchanged; the
OAuth ChatGPT CRM connector surface is unaffected.

## T9 — Vapi organization provisioning

The single operation is:

1. require an explicit company and environment;
2. acquire a transaction advisory lock for that pair;
3. read the active company and its scoped Vapi connection;
4. if a complete active org connection exists, reuse it and its one active tool
   credential without calling Vapi;
5. preflight local `APP_SECRETS_KEY`, `BLANC_SERVER_PEPPER`, and any supplied
   tool secret;
6. `POST https://api.vapi.ai/org` with the platform master key and stable
   idempotency header;
7. validate exact required response fields;
8. AES-256-GCM encrypt `{api_key: privateKey}` with `APP_SECRETS_KEY` and store
   it in this company's `provider_connections` row with `provider_org_id`;
9. issue a `vapi_tools` credential for the same company;
10. commit. On any failure, roll back all local changes and do not alter a
    pre-existing connection.

Generate a new tool secret into a new mode-0600 file:

```bash
node backend/scripts/provision-vapi-tenant.js \
  --company-id '<company uuid>' \
  --environment prod \
  --secret-output-file '/secure/operator-only/vapi-tools-<company>.secret'
```

Or supply an operator-generated value without printing it:

```bash
TENANT_VAPI_TOOLS_SECRET='<at least 32 characters>' \
node backend/scripts/provision-vapi-tenant.js \
  --company-id '<company uuid>' \
  --environment prod \
  --tools-secret-env TENANT_VAPI_TOOLS_SECRET
```

The command logs only non-secret identifiers and created/reused flags.

### ABC Homes operational move

ABC must also run T9 and receive its own organization. After it succeeds, the
owner manually:

1. inventories the master-account ABC assistants, phone numbers, tool-server
   settings, and webhook destination;
2. creates or moves equivalent resources into the new ABC organization;
3. configures every ABC assistant tool with the new ABC `vapi_tools` secret and
   configures call-status separately with `VAPI_WEBHOOK_SECRET`;
4. updates the owner-managed assistant/phone ids only after GET-before-PATCH
   comparison of the live configuration;
5. performs the cross-organization key test below and ABC inbound/outbound
   smokes before retiring master-account ABC resources.

Resource transfer is deliberately not automated in this change. The existing
ABC-only outbound rollout gate remains the reason that newly connected companies
cannot accidentally use the legacy master assistant while their own resources
are not configured.

### Residual distributed-system risk

If Vapi creates the organization but the local transaction later fails for a
non-preflight reason, a provider-side orphan may exist. The stable idempotency
header reduces duplicate risk if Vapi honors it; because this endpoint is
undocumented, the operator must inspect Vapi before retrying an ambiguous 5xx.
This affects provisioning idempotency, not tenant authorization: no response
payload ever selects a local company.

## E — SMS media

`conversationsQueries.getMediaById(id, companyId)` now requires company context
before I/O and scopes both the message and conversation joins. The service takes
`getMediaTemporaryUrl(mediaId, companyId, forceRefresh)`; both the initial/cached
read and the refresh cache update use the request company. Foreign media is
not-found and Twilio is never called.

The browser delivery contract has two stages:

1. `POST /api/messaging/media/:mediaId/access-url` runs under the existing
   `authenticate + requireCompanyAccess` mount and messaging read gate
   (`messages.view_client ∨ messages.view_internal ∨ pulse.view`). It first
   proves the media belongs to `req.companyFilter.company_id`, then returns a
   five-minute relative URL containing a narrow `cap` token. Body/query company
   fields are ignored.
2. The no-header `GET .../temporary-url` verifies the HMAC, exact claim shape,
   purpose, expiry, and route media id, then calls the company-scoped service
   with the company from the token. Missing, malformed, forged, expired, or
   wrong-file tokens return the same 404. A valid token for B used against A's
   media also returns 404 before any Twilio request.

`rateMeService` and `/e/:token` establish the product pattern that a public link
is a narrow capability, but their tokens are random DB-backed opaque values, not
signed payloads. The implementation therefore reuses the project's actual
signed-token format: the HMAC `payload.signature` codec already used by
`mediaStreamTokenService`, with `TWILIO_MEDIA_STREAM_TOKEN_SECRET`. SMS claims
add mandatory `purpose=sms_media_access`, `media_id`, and `company_id`, so a
voice-stream token and an SMS-media token cannot validate as each other.

Both frontend consumers call the authenticated mint endpoint before assigning
the returned capability URL to image `src`, open/download `href`, or the Pulse
programmatic download anchor. They refresh it 30 seconds before expiry. Layout,
styles, filenames, and interaction affordances are unchanged. Capability
responses and proxied bytes are private/no-store; the proxy also emits
`Referrer-Policy: no-referrer`.

### Protected `src/server.js` handoff — not applied

Apply this exact minimal patch in the same release as the E service, mint route,
and frontend change. The handler is implemented and tested outside the protected
file; this patch only imports and mounts it:

```diff
 const usersRouter = require('../backend/src/routes/users');
 const messagingRouter = require('../backend/src/routes/messaging');
+const { mediaTemporaryUrlHandler } = require('../backend/src/routes/mediaTemporaryUrl');
 const pulseRouter = require('../backend/src/routes/pulse');
@@
-// Media proxy — no auth (browser <img src> can't send JWT; UUID provides security)
-// Proxies media content through the backend to avoid CORS and expired-URL issues
-app.get('/api/messaging/media/:mediaId/temporary-url', async (req, res, next) => {
-    const conversationsService = require('../backend/src/services/conversationsService');
-    try {
-        const result = await conversationsService.getMediaTemporaryUrl(req.params.mediaId);
-        if (!result.url) return res.status(404).json({ error: 'Media URL not available' });
-
-        // Proxy: fetch from Twilio and pipe to response
-        const upstream = await fetch(result.url);
-        if (!upstream.ok) {
-            // URL might be expired — clear cache and retry once
-            console.warn(`[Media] Upstream ${upstream.status} for ${req.params.mediaId}, retrying with fresh URL`);
-            const fresh = await conversationsService.getMediaTemporaryUrl(req.params.mediaId, true);
-            if (!fresh.url) return res.status(404).json({ error: 'Media URL not available' });
-            const retry = await fetch(fresh.url);
-            if (!retry.ok) return res.status(502).json({ error: 'Upstream media fetch failed' });
-            res.set('Content-Type', fresh.contentType || retry.headers.get('content-type') || 'application/octet-stream');
-            res.set('Cache-Control', 'private, max-age=3600');
-            const { Readable } = require('stream');
-            Readable.fromWeb(retry.body).pipe(res);
-            return;
-        }
-        res.set('Content-Type', result.contentType || upstream.headers.get('content-type') || 'application/octet-stream');
-        res.set('Cache-Control', 'private, max-age=3600');
-        const { Readable } = require('stream');
-        Readable.fromWeb(upstream.body).pipe(res);
-    } catch (err) {
-        console.error('[Media] proxy error:', err.message);
-        res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
-    }
-});
+// Browser subresources cannot attach Authorization. This public route accepts
+// only a short-lived, file- and company-bound signed capability.
+app.get('/api/messaging/media/:mediaId/temporary-url', mediaTemporaryUrlHandler);
 app.use('/api/messaging', authenticate, requireCompanyAccess, messagingRouter);
```

Until that protected patch is applied, the service intentionally rejects the old
inline route call with `TENANT_CONTEXT_REQUIRED`. E backend/frontend artifacts
and the protected mount are one rollout unit; deploying a partial unit causes a
media outage, not a tenant fallback.

## Tenancy & Roles

Canon: `docs/specs/TENANCY-RBAC-CANON.md`.

| Surface/action | Tenant source | Allow | Deny / no work |
|---|---|---|---|
| Vapi tool invocation | `vapi_tools` credential row | active credential with `vapi_tools:invoke` | missing, duplicate, revoked, expired, wrong scope, inactive company, DB error |
| Vapi outbound-correlated tool | credential + uniquely correlated attempt | same company in both sources | absent/ambiguous correlation or company mismatch; `runSkill` not called |
| Vapi call-status webhook | separate webhook secret + attempt row | valid secret and unique attempt | tool secret fallback, unknown/ambiguous attempt, spoofed body company |
| Sales MCP read/discovery | Sales credential company/actor | active same-company membership and live permission also present in credential scopes | either side of intersection missing |
| Sales MCP write | same as read | live `sales.crm.write` + credential `sales.crm.write` + confirmation | any missing gate; no write |
| Sales SSE message | freshly resolved credential/company/RBAC | exact SSE credential id and company match | foreign credential/company before protocol |
| Vapi tenant provisioning CLI | mandatory `--company-id` | active company and local config preflight | no company, invalid response, provider/DB/config failure |
| Media capability mint | `req.companyFilter.company_id` | authenticated member with one existing messaging/Pulse read permission; owned media chain | no read permission, no company, or foreign media; 404 for foreign |
| Public media proxy (after protected patch) | signed capability `company_id` + route-bound `media_id` | valid exact-purpose HMAC within five minutes and same-company media chain | missing/forged/expired/wrong-file token or foreign media → 404 before Twilio |

Required isolation coverage is T-own, T-foreign, and T-blast. Public machine
surfaces have no human R-matrix; their complete deny matrix is the credential
state/scope table above. Sales MCP additionally exercises live RBAC deny cells.
The public proxy has no human role because the narrow capability is its sole
credential. Its authenticated mint endpoint exercises all three existing allow
permissions and the no-permission deny cell.

## Deployment order and independence

1. Apply migration 264 with the production runner (`psql -v ON_ERROR_STOP=1 -f`).
2. From the release artifact, provision ABC Vapi and Sales credential rows from
   the current env values; verify counts/scopes/actor without selecting hashes.
3. Set and verify a distinct `VAPI_WEBHOOK_SECRET` before T7 runtime code.
4. Deploy T6+T7 and/or T6+T8. T7 and T8 can roll independently after their own
   credential exists; without it they intentionally deny all traffic.
5. T9 can roll independently after migration 264 and local encryption/hash keys.
6. E service, authenticated mint route, frontend consumers, public handler, and
   protected route mount are one rollout unit. Confirm
   `TWILIO_MEDIA_STREAM_TOKEN_SECRET` is at least 32 bytes before deployment.
7. Remove the legacy runtime token/company/user/write mappings after smokes.

No production command was run during implementation.

## Verification

Common Jest form used for every suite:

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules \
  ../../../node_modules/jest/bin/jest.js --runTestsByPath <files> --runInBand --forceExit \
  --testPathIgnorePatterns "/node_modules/"
```

Executed commands and results:

| Files substituted for `<files>` | Result |
|---|---|
| `tests/machineCredentialService.test.js tests/machineProvisioningCli.test.js` | PASS — 2 suites, 12 tests |
| `tests/vapiOrgProvisioningService.test.js tests/mediaTemporaryUrlTenantIsolation.test.js tests/vapiToolsVariableValues.test.js` | PASS — 3 suites, 13 tests |
| `tests/routes/vapi-tools.test.js tests/vapiFinanceContextRoute.test.js tests/routes/crmMcpPublic.test.js tests/conversationsTenantIsolation.test.js tests/vapiCallStatusWebhook.test.js` | PASS — 5 suites, 121 tests (plus final individual Vapi/CRM reruns) |
| `tests/machineCredentialMigration.db.test.js` | PASS — 1 suite, 1 DB test |
| `tests/tenantSafetyLint.test.js` | PASS — 1 canonical full suite, 11 tests (173.305 s) |
| `tests/smsMediaAccessService.test.js tests/messagingMediaAccess.routes.test.js tests/mediaTemporaryUrlCapability.test.js tests/mediaTemporaryUrlTenantIsolation.test.js tests/twilioMediaStreamAuth.test.js` | PASS — 5 suites, 26 tests |
| `tests/messagingMaskedTargets.test.js tests/providerContactAccessQueries.test.js tests/twilioWebhooks.test.js tests/conversationsTenantIsolation.test.js tests/tenantSafetyLint.test.js` | PASS — 5 suites, 42 tests; canonical lint 173.008 s |

Frontend commands and results:

| Command | Result |
|---|---|
| `env -u NODE_USE_SYSTEM_CA npm test -- src/hooks/useSmsMediaAccessUrl.test.ts` (from `frontend/`) | PASS — 1 file, 4 tests; includes real hook state remaining empty until the authenticated mint resolves |
| `env -u NODE_USE_SYSTEM_CA npm run build` (from `frontend/`) | PASS — TypeScript and production Vite build; only pre-existing CSS/chunk warnings |
| `env -u NODE_USE_SYSTEM_CA npm test` (from `frontend/`) | Baseline FAIL — 83 files/478 tests pass; 5 files/7 tests fail outside this change: `typeScale` (2), `IntegrationsPage` (2), `settingsNav`, `settingsRouteCompleteness`, `ScheduleHeaderContract`. The new SMS-media suite passes. These unrelated failures were not changed. |

Sabotage verification:

```text
BREAK: accept ?companyId as tenant context when cap verification returns null
RUN:   env -u NODE_USE_SYSTEM_CA DATABASE_URL=postgresql://localhost/albusto_test \
       node --use-bundled-ca --experimental-vm-modules \
       ../../../node_modules/jest/bin/jest.js \
       --runTestsByPath tests/mediaTemporaryUrlCapability.test.js \
       --runInBand --forceExit --testNamePattern SAB-E-CAPABILITY \
       --testPathIgnorePatterns /node_modules/
RED:   expected 404, received 500; tenant service was reached
RESTORE: remove the fallback and require verified claims
GREEN: mediaTemporaryUrlCapability.test.js — 5/5
```

Runner-parity migration commands (local `albusto_test`, never production):

```bash
/usr/local/Cellar/postgresql@16/16.11_1/bin/psql -v ON_ERROR_STOP=1 \
  postgresql://localhost/albusto_test \
  -f backend/db/migrations/264_machine_credentials_and_vapi_org.sql
```

Result: PASS twice in autocommit mode; the second run emitted only expected
already-exists notices and exited 0.

### Manual network verification — Vapi organization key isolation

Not executed in the sandbox because it requires two live organization keys and
a known assistant in organization B. Run the complete command after provisioning;
it never prints either key:

```bash
set -euo pipefail
: "${VAPI_ORG_A_KEY:?set organization A private key}"
: "${VAPI_ORG_B_ASSISTANT_ID:?set an assistant id owned by organization B}"
vapi_probe_body="$(mktemp)"
trap 'rm -f "$vapi_probe_body"' EXIT
vapi_probe_code="$(curl --silent --show-error \
  --output "$vapi_probe_body" \
  --write-out '%{http_code}' \
  --header "Authorization: Bearer ${VAPI_ORG_A_KEY}" \
  "https://api.vapi.ai/assistant/${VAPI_ORG_B_ASSISTANT_ID}")"
case "$vapi_probe_code" in
  403|404) ;;
  *) echo "FAIL: org A key read org B assistant (HTTP ${vapi_probe_code})" >&2; exit 1 ;;
esac
curl --silent --show-error --fail \
  --header "Authorization: Bearer ${VAPI_ORG_A_KEY}" \
  'https://api.vapi.ai/assistant?limit=100' \
| jq -e --arg foreign_id "$VAPI_ORG_B_ASSISTANT_ID" \
  '([.. | objects | .id? // empty] | index($foreign_id)) == null' >/dev/null
echo 'PASS: organization A key cannot read/list organization B assistant'
```

## Sabotage minimum

| Sabotage | Test that must turn red |
|---|---|
| hardcode ABC or use request body instead of resolved credential company | `machineCredentialService.test.js` A/B resolution and `vapiFinanceContextRoute.test.js` secret A/B isolation |
| spread model/body `companyId` after trusted values | `vapiFinanceContextRoute.test.js` inbound spoof and `vapiToolsVariableValues.test.js` precedence |
| remove/ignore required credential scope | `machineCredentialService.test.js` wrong-scope cell and Vapi rejected-credential table |
| return tenant context after the conditional-use update lost a revoke race | `machineCredentialService.test.js` revoke-between-lookup-and-use test |
| union Sales scopes with RBAC, or reuse stale SSE auth | `crmMcpPublic.test.js` two intersection deny cells, membership revocation, and fresh-SSE-auth test |
| omit credential/company comparison on `/messages` | `crmMcpPublic.test.js` foreign SSE credential test |
| make phone/media UUID authoritative without company predicates | `conversationsTenantIsolation.test.js` foreign media lookup and `mediaTemporaryUrlTenantIsolation.test.js` no-Twilio T-blast |
| accept a media id without verifying the signed capability | `mediaTemporaryUrlCapability.test.js` `SAB-E-CAPABILITY` missing-token test; tenant/Twilio seams must remain untouched |
| omit media/company/purpose/expiry binding from the capability | `smsMediaAccessService.test.js` wrong-media, tampered-signature, and expired-token tests plus the public-handler foreign-company test |
| restore a bare media-id URL in either UI consumer | `useSmsMediaAccessUrl.test.ts` rejects unsigned responses and checks both components use the signed URL for `src`/`href`/download |
| accept an alternate/unexpected Vapi org key field | `vapiOrgProvisioningService.test.js` changed-shape rollback test |
| weaken Sales actor FK to a user-only FK | `machineCredentialMigration.db.test.js` foreign actor insert |
| restore `VAPI_TOOLS_SECRET` fallback for call status | `vapiCallStatusWebhook.test.js` tools-only secret refusal |

The first, second, and media sabotages are the mandatory minimum requested by
the brief; the rest pin the same trust boundaries at adjacent seams.
