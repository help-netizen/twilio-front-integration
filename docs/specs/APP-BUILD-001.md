# APP-BUILD-001 — App Studio Phase 3 builder backend

Status: **IMPLEMENTED — verification recorded below.**

Parent contracts: `APP-STUDIO-001.md` §1/§4, `APP-GW-001.md`, and
`APP-RUN-001.md`. This phase adds the tenant-admin builder API, chat storage,
code generation, static validation, and mocked isolated dry-run. It adds no UI,
publication, moderation, production run, synthetic-data sandbox, write tool,
egress, trigger, dependency, or installation flow.

## 1. Proposal

For every user message the backend persists only scrubbed text, reserves one
company/day generation, asks the configured builder model for one ESM source
plus a short description, and sends that source to the Phase 2 package. The
Phase 2 package first performs dependency-free static validation and only then
calls its existing `runApplication` library against fixed read-only fixtures.
A transaction creates a `draft` version, SHA-256, exact `app_version_tools`
rows, assistant message, and audit entry only after both gates succeed.

The CRM does not load `isolated-vm`. It invokes a fixed child-process protocol:

```text
APP_BUILDER_RUNNER_NODE (Node 24 executable)
  --no-node-snapshot apps-runtime/src/builderDryRunCli.js
  stdin:  {"source":"..."}
  stdout: {"ok":true,"report":{...}}
```

There is no shell, user-selected executable/path/argument, inherited secret
environment, network gateway, raw run token, or duplicated isolate. The CLI
calls `apps-runtime/src/runner.js` as a library with a mocked gateway.

## 2. Decisions taken

1. Application source is the exact Phase 2 ESM contract:
   `export async function run(ctx)`. CommonJS `module.exports` cannot pass the
   Phase 2 `compileModule`/one-namespace-export contract and is not introduced
   as a second format.
2. The CRM and `isolated-vm` have incompatible Node/ABI lifecycles. The builder
   therefore uses the narrow child seam above. When CRM itself runs Node 24,
   `process.execPath` is accepted; otherwise `APP_BUILDER_RUNNER_NODE` is
   required and failure is closed before version storage.
3. A new chat may have `app_id=NULL`. On its first successful artifact, the
   same transaction creates one private/draft Marketplace profile, records
   company ownership, attaches the chat, and creates version `builder-1`.
   Later successful messages create `builder-N` versions for that owned app.
4. `marketplace_apps` is global and has no owner column. Migration 221 adds
   `app_studio_apps(company_id, app_id)` as the explicit ownership boundary.
   Chats and version-linked messages have composite foreign keys through it.
   Public Marketplace apps are not writable through App Studio.
5. Runtime-created Marketplace profiles include the complete
   `metadata.assistant` product projection. No company identifier, chat text,
   prompt, source, token, or secret is placed in Marketplace metadata.
6. The daily generation quota is UTC-based, matching the existing assistant
   operational counter. `APP_BUILDER_DAILY_GENERATION_QUOTA` defaults to 50.
   Reservation occurs before the provider call and counts an attempted paid
   generation even if validation later rejects its artifact.
7. Quota exhaustion is HTTP 429. Provider/static/dry-run failures are returned
   as persisted assistant messages with `generation_status="failed"` and no
   version. This keeps validation failure inside the chat interaction.
8. The builder provider defaults independently:
   `APP_BUILDER_PROVIDER || ASSISTANT_PROVIDER || gemini` and
   `APP_BUILDER_MODEL || ASSISTANT_MODEL || gemini-2.5-flash`.
9. Version-list responses deliberately exclude `source_code`; Phase 3 stores
   the immutable artifact but does not add a user code-view surface.
10. The protected runtime shell is not modified by this implementation. The
    architect must authorize/add the exact `/api/app-studio` require and mount;
    the router itself enforces `tenant.integrations.manage` and `tenant_admin`.

## 3. Static validation and dry run

Static validation precedes execution and checks:

- UTF-8 source size at most 65,536 bytes;
- one exact `export async function run(ctx)` and no other `run`/export;
- parse success through `isolated-vm.compileModule` without evaluation;
- no static/dynamic import;
- no identifier `require`, `process`, `fetch`, `eval`, `Function`, or
  `WebAssembly`;
- only direct literal `ctx.callTool('<name>', args)` calls;
- every tool name is in the exact Phase 1 catalog:
  `svc.list_jobs`, `svc.get_job`, `svc.list_tasks`.

The dry run then creates the same fresh 32 MB isolate and uses the same 100 ms
CPU, five-call, 64 KiB output, frozen context, capability hardening, disposal,
and output checks as Phase 2. Its host gateway is a deterministic in-memory
fixture projection. The app must return a JSON value for
`ctx.input={"today":"2026-07-31"}`. A loop, memory abuse, sixth call,
invalid output, capability attempt, or fixture/tool failure rejects the draft.

Static scanning is defense-in-depth; the isolate and CRM gateway remain the
security boundaries for any later execution.

## 4. Secret handling, log, provider, and audit

Before storage or model use, user chat/title text replaces:

- bearer values;
- `api-key` / `api_key` / `x-api-key` assignments;
- password/passwd/pwd assignments;
- long base64/base64url-looking blobs.

The raw input is not inserted first and is not put in audit. Generated source
that matches the same secret detector is rejected rather than rewritten.
Messages keep role, scrubbed text, model, token usage, optional version link,
and timestamps with no retention deletion in Phase 3.

Each accepted generation attempt writes awaited
`audit_log.action='app_builder.generation'`. Details contain outcome, model,
token totals, app/version IDs, and safe error code only. They contain no user
message, description, source, provider payload, credential, or fixture data.

## 5. Data migration 221

- `app_studio_apps`: company-to-private-app ownership.
- `app_build_chats`: company-scoped chat, nullable owned `app_id`, CRM creator.
- `app_build_messages`: company/chat composite FK, scrubbed text, role, model,
  token JSON, and composite owned app/version link.
- `app_builder_usage_counters`: `(company_id, usage_date)` generation count.
- Matching `rollback_221_app_studio_builder.sql` drops only Phase 3 tables.

The migration number was selected after both the worktree and local
`origin/master` were verified at migration 220 / commit `c16185df`.

## 6. API

Parent mount (pending protected-file authorization):

```text
/api/app-studio
  authenticate
  requirePermission('tenant.integrations.manage')
  requireCompanyAccess
  appStudioRouter
```

The router additionally checks actual membership
`role_key === 'tenant_admin'` and reads company only from
`req.companyFilter.company_id` and actor only from `req.user.crmUser.id`.

| method/path | behavior |
|---|---|
| `POST /chats` | Creates a chat with optional owned `app_id` and optional title. |
| `GET /chats` | Lists only company chats. |
| `GET /chats/:id/messages` | Returns scrubbed messages or company-scoped 404. |
| `POST /chats/:id/messages` | Persists scrubbed user text and runs the fixed pipeline. |
| `GET /apps/:appId/versions` | Returns owned draft version metadata/tools, never source. |

Unknown body keys are rejected. Foreign chat/app IDs return 404 and never
reveal whether the other company owns them.

## 7. Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `POST /api/app-studio/chats` | `req.companyFilter.company_id` | nullable owned app ID | `tenant.integrations.manage` + exact tenant_admin | tenant_admin ✓; manager/dispatcher/provider/custom ✗ | An app-id-only ownership check could attach a foreign private app. |
| `GET /api/app-studio/chats` | `req.companyFilter.company_id` | company + chat rows | same | tenant_admin ✓; all others ✗ | An unscoped aggregate could count/list another tenant's chat. |
| `GET /api/app-studio/chats/:id/messages` | `req.companyFilter.company_id` | company + UUID chat ID | same | tenant_admin ✓; all others ✗ | UUID-only history lookup could disclose prompts and model metadata. |
| `POST /api/app-studio/chats/:id/messages` | `req.companyFilter.company_id` | company + UUID chat ID + owned app | same | tenant_admin ✓; all others ✗ | Foreign chat mutation could spend another tenant's quota or create a version on its app. |
| `GET /api/app-studio/apps/:appId/versions` | `req.companyFilter.company_id` through `app_studio_apps` | company + numeric app ID | same | tenant_admin ✓; all others ✗ | App-id-only lookup could expose artifact hashes/reports or later source. |
| generation quota/audit | explicit company argument originating from request context | company + UTC date / company + chat | internal after route gate | n/a | An unscoped counter lets one tenant exhaust another; misattributed audit hides blast radius. |

Tests seed A/B with identical names, chat text, descriptions, and source. A's
reads/write leave B's chats/messages/ownership/versions byte-unchanged.

## 8. Verification

Implementation verification is recorded in the task handoff. Required gates:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/appBuilderSourcePolicy.test.js tests/appBuilderSecretScrubber.test.js tests/appBuilderService.test.js tests/appStudioRoutes.test.js --testPathIgnorePatterns /node_modules/ --runInBand --forceExit
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/appBuilderTenancy.db.test.js --testPathIgnorePatterns /node_modules/ --runInBand --forceExit
cd apps-runtime && env -u NODE_USE_SYSTEM_CA npm exec --yes --package=node@24.13.0 -- node /usr/local/lib/node_modules/npm/bin/npm-cli.js test -- --runInBand --forceExit
```

Sabotage invariant: **an exhausted company quota stops the pipeline before the
LLM call**. BREAK changed `if (!quota)` to `if (false && !quota)`. The named
test `SAB APP-BUILD-001 quota gate: exhausted quota returns 429 without invoking
the LLM` went red because the promise resolved with a created version. The exact
reverse patch restored `if (!quota)` and the named test returned green.

Observed final gates:

- CRM builder suites: exit 0; 7 suites / 43 tests passed, including real
  PostgreSQL migration, T-own/T-foreign/T-blast, quota, version, and audit paths.
- Node 24 Phase 2 package: exit 0; 6 suites / 33 tests passed.
- CRM Node 25 → configured Node 24 child seam: exit 0 with a valid static/dry-run
  report.
- Phase 1 gateway/reference regression: exit 0; 2 suites / 30 tests passed.
- Assistant isolation regression: exit 0; 1 suite / 19 tests passed.
- The repository-wide tenant-safety lint remains red on pre-existing untouched
  `calls.js`, `pulse.js`, and `estimates.js` baseline drift; the focused new
  route/line rules do not report an App Studio violation.

## 9. Risks

1. The child seam requires the CRM deployment to provide a Node 24 executable
   and the installed `apps-runtime` native package. Misconfiguration fails
   closed but blocks generation.
2. The source lexer intentionally accepts a conservative ASCII-identifier
   subset. Strings/templates may contain Unicode. This may reject some safe
   generated styles; it cannot widen runtime authority.
3. Dry-run fixture success proves termination/format against representative
   shapes, not correctness on production data. Phase 5 synthetic sandbox is
   still required before broader confidence claims.
4. Daily quota is one PostgreSQL row per company/day and serializes briefly at
   reservation. The initial 50/day ceiling makes that contention negligible.
5. The protected server mount remains an explicit integration step; see D10.

## 10. Next

1. Obtain architect authorization for the exact protected runtime require/mount.
2. Run a fresh attack-only review by a different session/person.
3. Phase 4 may consume these APIs but must not expose source unless a separate
   product/security decision changes the parent contract.

## Production gap — dry run seam (архитектор, 2026-08-01)

Сухой прогон сейчас **порождает локальный процесс Node 24** (`APP_BUILDER_RUNNER_NODE` + путь к
`apps-runtime`). Это верный путь для разработки и тестов, но в проде **не работает**: контейнер CRM
не содержит ни Node 24, ни `apps-runtime` (раннер живёт на отдельном сервере `albusto-apps`,
207.246.123.17 — так решено в APP-STUDIO-001 §2).

Продуктовая форма: раннер поднимается на сервере приложений как СЕРВИС, CRM вызывает сухой прогон
по HTTP через тот же периметр, что и шлюз (обратное направление: CRM → apps). До этого момента
`/api/app-studio` не должен выходить на живых пользователей — генерация без сухого прогона
создавала бы версии, которые никто не проверил в изоляте.

Делается в Ф4/Ф5 вместе с интерфейсом и песочницей.
