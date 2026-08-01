# APP-SVC-001 — App Studio Phase 4 remote runner service and UI

Status: **IMPLEMENTED — verification recorded in the task handoff.**

Parent contracts: `APP-STUDIO-001.md` §2/§3/§7, `APP-GW-001.md`,
`APP-RUN-001.md`, and `APP-BUILD-001.md`. This phase closes gap-audit P0-04 by
moving both dry-run and live execution behind an authenticated HTTP boundary on
the application server. It also adds the first tenant-admin App Studio page.

## 1. Proposal

The existing `apps-runtime` package remains the sole owner of `isolated-vm` and
the fresh-isolate execution policy. Its production entrypoint is now a small
Node HTTP service. CRM sends generated source and its independently computed
SHA-256 to that service; the runtime still performs the authoritative hash
comparison before compilation. Builder dry-run uses request-supplied mock
fixtures, while live run uses the existing real CRM gateway bridge and a
host-only run-token.

The CRM has no local child-process or isolate fallback. If the runner is not
configured, cannot be authenticated, times out, or is unreachable, generation
persists a failed assistant message and creates no version.

## 2. Decisions taken

1. Service authentication is `Authorization: Bearer
   <APP_RUNNER_SERVICE_TOKEN>`. The service hashes both supplied and configured
   values to fixed-length buffers and compares them with
   `crypto.timingSafeEqual`.
2. `GET /health` is the only unauthenticated endpoint and returns exactly
   `{ "ok": true }`. All other known service endpoints authenticate before
   reading or executing the body.
3. `APP_RUNNER_REQUEST_TIMEOUT_MS` defaults to 10,000 ms. The handler races all
   request work against that deadline and aborts the active isolate/gateway
   bridge. Deadline failure is HTTP 504.
4. Request bodies are capped at 256 KiB by both declared and observed byte
   length. Oversize input is HTTP 413. Runner responses consumed by CRM are also
   capped at 256 KiB.
5. The service binds to `APP_RUNNER_HOST`, default `127.0.0.1`, and
   `APP_RUNNER_PORT`, default `4010`. Production must set the private interface
   or place the service behind a private reverse proxy/firewall; it must never
   be internet-exposed.
6. The live gateway origin remains `APP_RUNTIME_GATEWAY_BASE_URL`. It is used
   only by `/v1/run`; `/v1/dry-run` has an in-memory fixture gateway.
7. CRM uses `APP_RUNNER_BASE_URL` as a credential-free HTTP(S) origin and the
   same `APP_RUNNER_SERVICE_TOKEN`. `APP_BUILDER_DRY_RUN_TIMEOUT_MS` defaults to
   12 seconds so the service owns the 10-second execution deadline first.
8. `APP_STUDIO_ENABLED` remains an explicit product flag. Disabled is 404.
   Enabled with incomplete runner configuration is a clear 503. There is no
   special production 404 after the remote boundary exists.
9. No migration is required: the Phase 3 ownership, chat, message, quota, app,
   version, and tool tables already provide the page projection.

## 3. HTTP contract

### `POST /v1/dry-run`

Authenticated request:

```json
{
  "source": "export async function run(ctx) { return ctx.input; }",
  "expectedSourceSha256": "<64 lowercase hex>",
  "input": { "today": "2026-07-31" },
  "fixtures": { "svc.list_tasks": { "tasks": [], "total": 0 } }
}
```

The service performs the Phase 3 static validation, then invokes the shared
Phase 2 runner with the supplied expected hash, input, and mocked tool data.

### `POST /v1/run`

Authenticated request:

```json
{
  "source": "export async function run(ctx) { return ctx.input; }",
  "expectedSourceSha256": "<64 lowercase hex>",
  "runToken": "<host-only CRM run token>",
  "input": {}
}
```

The run-token stays in the runtime host and is forwarded only as the Bearer
credential on the fixed CRM gateway paths already defined by `APP-GW-001`.

Success for either endpoint is:

```json
{
  "ok": true,
  "result": {},
  "usage": {
    "wall_ms": 1,
    "gateway_calls": 0,
    "result_bytes": 2,
    "error_code": null
  }
}
```

Execution refusal is `{ ok:false, error:{ code,message }, usage }`. Stable host
statuses are 400 invalid envelope, 401 service authentication, 413 body limit,
422 validation/isolate refusal, 502 gateway unavailability, 503 missing runtime
configuration, and 504 request timeout. Error messages are bounded and contain
no source, fixture payload, service token, run-token, or gateway response.

## 4. CRM builder boundary

`appBuilderDryRunService` computes no authority and accepts no company selector.
`appBuilderService` computes `sha256(generated.source)` before calling it and
sends both bytes and hash. A successful response returns only the static/dry-run
report required by the existing persistence attestation. Every transport,
authentication, protocol, validation, or timeout error follows the existing
`persistFailure` path before returning to the chat; `persistSuccess` is never
called.

## 5. App Studio page

`/settings/app-studio` is a separate page inside the existing Settings layout.
It contains:

- a left company-owned app/chat list and **New app** action;
- a center builder conversation with user/assistant messages, generation errors,
  and `Version N · draft` plaques;
- a read-only profile with app name, generated description, latest version
  status, and exact tool list;
- a desktop profile panel and canonical `DialogContent variant="panel"` mobile
  bottom-sheet;
- explicit empty, loading, error, and quota-exhausted states.

The UI uses the five Phase 3 tenant-scoped endpoints and never sends
`company_id`. It uses the authenticated fetch client. The Settings navigation
entry requires both `tenant.integrations.manage` and exact membership
`tenant_admin`; direct navigation by another role renders a 403 surface and the
backend independently returns 403.

## 6. Tenancy and roles

No new SQL or runtime tenant selector is introduced. CRM still derives company
only from `req.companyFilter.company_id`, actor only from
`req.user.crmUser.id`, and every Phase 3 repository query is company-scoped.
Runner service authentication is machine-to-machine authentication, not tenant
identity. `/v1/run` derives live tenant authority only when its run-token reaches
the existing CRM gateway chain.

Role matrix: tenant_admin with `tenant.integrations.manage` may see and use App
Studio; manager, dispatcher, provider, custom, and tenant_admin without the
permission are denied. Foreign chat/app IDs remain company-scoped 404 and no
frontend request can widen that boundary.

## 7. Deployment contract

The runner container remains unprivileged and must retain the `APP-RUN-001`
controls: separate application server, read-only rootfs, dropped capabilities,
memory+swap/CPU/PID caps, no Docker socket, and network policy limited to the
CRM gateway/private ingress. The image now starts `src/server.js`; the manual
CLI remains available as `npm run run:cli -- ...` for controlled diagnostics.

## 8. Risks

1. A native isolate escape can still kill or compromise one runner container.
   The separate app server and container controls remain mandatory.
2. A service-token leak grants access to runner compute but not tenant identity;
   `/v1/run` still needs a valid short-lived run-token. Rotate both independently
   and keep the service on a private network.
3. HTTP timeout returns promptly even if a non-cooperative host promise ignores
   abort. Built-in isolate and gateway operations honor the abort path and retain
   their independent CPU/network deadlines.
4. Dry-run fixtures prove termination and response shape, not behavior on
   production-like data. Synthetic sandbox remains Phase 5.

## 9. Out of scope / next

Synthetic sandbox data, moderation, arbitrary egress, write tools, public
Marketplace publication, triggers, and production orchestration are unchanged
and remain Phases 5–8.
