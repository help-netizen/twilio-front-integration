# APP-RUN-001 — App Studio Phase 2 isolated application runner

Status: **IMPLEMENTED — verification recorded below.**

Parent contracts: `docs/specs/APP-STUDIO-001.md` §2 and
`docs/specs/APP-GW-001.md`. This specification covers only the application-server
side of Phase 2. It does not change the approved App Studio architecture.

## 1. Phase boundary

### In scope

- A standalone `apps-runtime/` Node package and Docker image. It imports no CRM
  backend code and communicates with CRM only through the Phase 1 HTTP gateway.
- One fresh `isolated-vm` isolate per invocation: 32 MB memory, 100 ms application
  CPU, and at most five host gateway calls.
- One application format: a single dependency-free JavaScript module exporting
  only `async function run(ctx)`, where `ctx = { callTool, input }`.
- A host-only run-token and a copied async bridge exposed in the isolate as both
  `albusto.callTool(name, args)` and `ctx.callTool(name, args)`.
- JSON input, JSON-serializable output capped at 64 KiB, a manual CLI, and the
  hand-authored `reference-apps/morning-digest/app.js` fixture/example.

### Out of scope

Code generation, builder chat, application DB storage, source hash lookup,
triggers, scheduling, synthetic sandbox data, writes, arbitrary egress, UI,
application-server provisioning, and deployment are later phases. Phase 2 takes
source from a file or direct runner argument and a previously minted run-token.

## 2. Decisions taken

1. The runtime host is CommonJS because `isolated-vm` is a native CommonJS
   module; application source remains a real ESM module compiled with
   `Isolate.compileModule`. Static imports are rejected before instantiation and
   no resolver is supplied.
2. `isolated-vm@6.0.2` is installed only in `apps-runtime/package.json`. The
   image pins Node 24 because isolated-vm 6 supports Node 24 and does not support
   the worktree host's odd Node 25. All runtime/test entry points include
   `--no-node-snapshot`, required by isolated-vm on Node 20+.
3. The Phase 1 tool projection is repeated as the runner's fixed three-name
   outbound ceiling: `svc.list_jobs`, `svc.get_job`, and `svc.list_tasks`. The
   CRM gateway remains authoritative for version allowlist, consent, live RBAC,
   tenancy, rate limit, masking, and audit.
4. The `today` input used by the reference application is a company-local
   `YYYY-MM-DD` supplied by the manual invoker. The application never derives a
   customer-visible date from server-local time.
5. Gateway failures cross the bridge as copied data and are reconstructed as a
   sandbox-native `GatewayError` with `code`, `status`, and sanitized `message`.
   No host `Reference` is exposed to application code, and no host error,
   response, fetch object, or token is copied into the isolate.
6. Output is serialized and UTF-8-sized inside the isolate before copying it to
   the host. This prevents a result larger than 64 KiB from crossing the memory
   boundary merely so the host can reject it.

## 3. Isolation and lifecycle

`runApplication` validates source/input secret hygiene, creates a gateway client,
then creates exactly one isolate with `memoryLimit: 32`. The isolate is disposed
in `finally` on every success or failure. CPU/memory violations and the sixth
bridge attempt also call `isolate.dispose()` immediately; any in-flight host
gateway requests are aborted.

The application CPU baseline is taken before module instantiation/evaluation.
The 100 ms remaining budget is supplied to module evaluation, invoker creation,
and invocation; `isolate.cpuTime` is checked at bridge boundaries and before the
result is released. Waiting for the CRM gateway is wall time and is not counted
as application CPU.

The bootstrap makes these capabilities fail closed with
`APP_RUNTIME_CAPABILITY_DISABLED`: `require`, `process`, `fetch`, `eval`, global
and indirect Function constructors, `globalThis.constructor`, WebAssembly, and
host timers. Relevant constructor links and built-ins are hardened before
application top-level code runs. A module gets ECMAScript values only; it has no
Node globals, filesystem, module loader, network primitive, process object, or
host timer.

## 4. Host gateway bridge

For one invocation the raw token exists only in the host `GatewayClient` and its
host callback closure. A private `isolated-vm.Reference` is captured by the
hardened `callTool` closure; the Reference itself is never returned, stored on a
global, accepted from application input, or otherwise exposed to application
code. The host callback owns the counter and sends:

```http
POST /internal/app-runtime/v1/tools/{encodedExactToolName}
Authorization: Bearer <host-only-run-token>
Content-Type: application/json

<tool arguments object>
```

The application cannot select an origin/path or send headers. The base URL must
be a credential-free HTTP(S) origin. Source, input, and gateway responses are
blocked if their serialized value contains the run-token, adding a testable
defense against accidental echo in addition to keeping the token out of every
bridge argument.

The local five-call limit is independent of the persisted Phase 1 gateway
limit. Attempts 1–5 may leave the runner. Attempt 6 disposes the isolate before
fetch is called and fails the run with `APP_RUNTIME_GATEWAY_CALL_LIMIT`.

## 5. Application contract

Valid source has no imports and exactly one export:

```js
export async function run(ctx) {
    const rows = await ctx.callTool('svc.list_tasks', { status: 'open' });
    return { count: rows.tasks.length, input: ctx.input };
}
```

`ctx` and JSON input are frozen inside the isolate. A return value must survive
`JSON.stringify`, must not be `undefined`, and its serialized UTF-8 form must be
at most 65,536 bytes. Functions, cyclic structures, BigInt, and oversized values
fail the run. There is no second entry point and no application state survives a
run.

The manual CLI reads source on the trusted host:

```bash
cd apps-runtime
APP_RUNTIME_GATEWAY_BASE_URL=https://api.example.test \
APP_RUNTIME_RUN_TOKEN='<run-token>' \
npm run run:cli -- reference-apps/morning-digest/app.js '{"today":"2026-07-31"}'
```

The source filename and token are never forwarded to application code.

## 6. Container contract

`apps-runtime/Dockerfile` is independent of the CRM image. The build stage has
the native compiler required by isolated-vm; the final Node 24 image contains
production dependencies only and runs as the unprivileged `node` user. At
deployment time it must additionally be run with the parent-contract controls:
read-only root filesystem, `--cap-drop=ALL`, memory+swap and CPU caps,
`--pids-limit`, no docker socket, and network policy allowing only the CRM
gateway. Deployment itself is not Phase 2.

## 7. Test matrix

| invariant | test coverage |
|---|---|
| no Node/network/dynamic-code escape | table-driven `require`, `process`, `fetch`, `globalThis.constructor`, direct `eval`, direct and indirect Function constructor attacks |
| one module/entry point | imports, sync `run`, and an extra export are rejected |
| CPU and memory | infinite loop reaches `APP_RUNTIME_CPU_LIMIT`; 40 MiB touched ArrayBuffer reaches `APP_RUNTIME_MEMORY_LIMIT` |
| local bridge ceiling | five calls pass; sixth is rejected and fetch count stays five |
| token host-only | globals, `albusto`, and `ctx` are enumerated; source/input/response echo attempts are blocked |
| bridge correctness | exact URL, tool, body, bearer header, success data, and sandbox-visible 403/429 errors |
| output contract | >64 KiB output is rejected inside the isolate |
| reference application | populated and empty Jobs/Tasks responses render deterministic meaningful text |

## 8. Sabotage proof

Invariant selected: **the runner, not only the CRM gateway, enforces at most five
outbound calls per invocation.**

BREAK patch: change the host check from
`gatewayCalls > LIMITS.gatewayCallLimit` to `gatewayCalls >
LIMITS.gatewayCallLimit + 1`.

Required red test name:
`APP-RUN-001 resource limits › the sixth gateway call is rejected and no sixth request leaves the host`.
Restore uses the exact reverse patch, never `git checkout`, followed by the full
green suite. Observed commands and exit codes are recorded in §9.

## 9. Verification

Canonical dependency/test command on a supported Node 24 host:

```bash
cd apps-runtime && npm ci && npm test
```

Canonical hermetic command from the repository root (also builds the native
module on the target Node major):

```bash
docker build --target test -t albusto-apps-runtime:test apps-runtime
```

Observed implementation verification:

- `env -u NODE_USE_SYSTEM_CA npm install --ignore-scripts` (from
  `apps-runtime/`) — exit 0; 332 packages installed, audit found 0
  vulnerabilities. Native scripts were deliberately deferred because the host
  is unsupported Node 25.
- `env -u NODE_USE_SYSTEM_CA npm exec --yes --package=node@24.13.0 -- node
  /usr/local/lib/node_modules/npm/bin/npm-cli.js rebuild isolated-vm` — exit 0;
  native dependency rebuilt successfully under supported Node 24.
- `docker build --target test -t albusto-apps-runtime:test apps-runtime` — exit
  1 before build: local Docker daemon unavailable. No GUI/daemon was started on
  this resource-constrained machine.
- BREAK red: `env -u NODE_USE_SYSTEM_CA npm exec --yes
  --package=node@24.13.0 -- node --no-node-snapshot
  node_modules/jest/bin/jest.js --runTestsByPath test/limits.test.js
  --runInBand --testNamePattern 'the sixth gateway call is rejected and no
  sixth request leaves the host'` — exit 1; named test failed because the run
  resolved to `"unreachable"`.
- Restored full run: `env -u NODE_USE_SYSTEM_CA npm exec --yes
  --package=node@24.13.0 -- node
  /usr/local/lib/node_modules/npm/bin/npm-cli.js test` — exit 0; 5 suites, 26
  tests passed.
- `git diff --check` plus the untracked-file whitespace/syntax checks — exit 0;
  `git status --short --untracked-files=all` lists the 17 intended new Phase 2
  files; the 48 MB verification `apps-runtime/node_modules` was removed after
  testing and no task-started process remains.

## 10. Risks

1. `isolated-vm` documents its 32 MB setting as a guideline: a hostile isolate
   may briefly consume roughly 2–3× the configured heap before termination.
   The parent contract's separate runner container memory+swap limit therefore
   remains mandatory, not optional defense-in-depth.
2. `isolated-vm` is in maintenance mode and ties compatibility to Node/V8
   majors. The image deliberately pins Node 24 + isolated-vm 6; upgrades require
   rebuilding and rerunning this attack suite before deployment.
3. Native isolate escape or fatal V8 failure can still kill a runner process.
   The approved separate application server and constrained runner containers
   are the failure boundary; the runner process must never be colocated with CRM
   infrastructure.
4. Phase 2 has no server, scheduler, source store, or production token delivery
   path. The CLI proves execution and isolation only; wiring it into a service is
   a later explicitly reviewed phase.

## 11. Next

Run a fresh attack-only review by a different session/person before treating
the boundary as release-ready. Phase 3 may generate only this exact artifact
format and must not add modules, npm dependencies, egress, writes, or another
entry point.
