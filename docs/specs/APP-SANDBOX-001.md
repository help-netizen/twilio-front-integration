# APP-SANDBOX-001 — App Studio Phase 5 synthetic-data sandbox

Status: **IMPLEMENTED — verification recorded in the task handoff.**

Parent contracts: `APP-STUDIO-001.md` §7 (Phase 5 owner decision),
`APP-SVC-001.md`, `APP-BUILD-001.md`, `APP-GW-001.md`, and
`APP-RUN-001.md`.

## 1. Proposal

The application runner owns one deterministic synthetic dataset generator. A
seed materializes a connected company, contacts, converted leads, jobs, tasks,
invoices, and payments entirely on the application-server side. The generator
contains only explicitly synthetic names, reserved/example contact data, and
stable synthetic identifiers. It never reads CRM storage and never accepts a
CRM company selector.

`POST /v1/dry-run` continues to accept caller-supplied fixture projections for
backward compatibility. When `fixtures` is absent, it generates the connected
dataset from the optional `seed`, runs the same isolate and catalog bridge, and
returns the application result, runtime usage, validation attestation, and
entity counts. App Studio's CRM seam uses a fixed seed and no longer sends the
old disconnected response literals.

## 2. Decisions taken

1. `apps-runtime/src/sandboxFixtures.js` is the only Phase 5 fixture source of
   truth. The dataset is generated in the runner process for a dry run; it is
   not a synthetic tenant row in the CRM PostgreSQL database and needs no CRM
   migration or credential.
2. Seeds are non-empty strings or safe integers of at most 128 characters. The
   default is `albusto-sandbox-v1`; the CRM builder uses
   `app-studio-builder-v1`. Equal seeds produce byte-identical JSON and
   different seeds change identifiers and display data.
3. The graph contains one company, six contacts, six converted leads, six jobs,
   eight tasks, five invoices, and four completed payments. Every job points to
   an existing contact and lead, every task to an existing job, every invoice
   to an existing job, and every payment to a matching invoice and job.
4. Synthetic dates have a fixed company-local test day (`2026-07-31`) and an
   ordered lifecycle. They never depend on runner wall-clock or server
   timezone, so repeatability is preserved.
5. Generated tool responses are projected from the graph at call time.
   `svc.list_jobs` applies its bounded list filters and pagination shape,
   `svc.get_job` resolves an existing synthetic job or returns `NOT_FOUND`, and
   `svc.list_tasks` applies its task filters and pagination shape.
6. The in-memory gateway retains the real gateway envelope
   `{ok,data,request_id}`. Application code receives only `data`, exactly as it
   does through the live `GatewayClient`.
7. Response-shape compatibility is a root-Jest contract against the actual CRM
   `jobsService` and `tasksQueries` projectors. It recursively compares key
   paths for list jobs, job detail, and list tasks, rather than maintaining an
   unrelated handwritten expectation.
8. Builder artifact attestation remains separate from the application result.
   CRM consumes the new `validation` member for `source_bytes`, `tools`,
   `entry_point`, and `returned_type`, and stores bounded `usage` plus
   `fixtures_summary` under `scanner_report.dry_run`. **APP-MOD-001 follow-up:**
   Phase 6 also stores the runner's already bounded synthetic `result` there so
   the super-admin moderation card can show the latest sandbox outcome. This
   supersedes Phase 5's original decision to discard that value.
9. Error identity is never rewritten as success. Unknown catalog tools retain
   `UNKNOWN_TOOL`; isolate CPU exhaustion retains `APP_RUNTIME_CPU_LIMIT`; the
   HTTP host deadline retains `APP_RUNTIME_REQUEST_TIMEOUT` with status 504.

## 3. Runner HTTP contract

Authenticated generated-fixture request:

```json
{
  "source": "export async function run(ctx) { return ctx.input; }",
  "expectedSourceSha256": "<64 lowercase hex>",
  "input": { "today": "2026-07-31" },
  "seed": "app-studio-builder-v1"
}
```

`seed` is optional. `fixtures` is also optional; when it is supplied it keeps
the Phase 4 tool-name-to-response fixture contract and takes precedence over
`seed`.

Success:

```json
{
  "ok": true,
  "result": "<actual JSON application result>",
  "validation": {
    "source_bytes": 123,
    "tools": ["svc.list_jobs", "svc.list_tasks"],
    "entry_point": "run",
    "returned_type": "string"
  },
  "usage": {
    "wall_ms": 4,
    "gateway_calls": 2,
    "result_bytes": 186,
    "error_code": null
  },
  "fixtures_summary": {
    "companies": 1,
    "contacts": 6,
    "leads": 6,
    "jobs": 6,
    "tasks": 8,
    "invoices": 5,
    "payments": 4
  }
}
```

Failure retains the Phase 4 shape and status mapping:

```json
{
  "ok": false,
  "error": {
    "code": "APP_RUNTIME_REQUEST_TIMEOUT",
    "message": "Application request exceeded the host timeout."
  },
  "usage": {
    "wall_ms": 10000,
    "gateway_calls": 0,
    "result_bytes": null,
    "error_code": "APP_RUNTIME_REQUEST_TIMEOUT"
  }
}
```

The bounded English message is the user-safe explanation. It contains no
source, raw fixture graph, seed-derived contact data, service token, run-token,
or gateway payload.

## 4. Fixture response contracts

- `svc.list_jobs` returns the CRM keys `results`, `total`, `offset`, `limit`,
  `has_more`, `facets`, and `pagination`. List records include the live
  projector's finance rollup keys `amount_paid` and `balance_due`.
- `svc.get_job` returns one CRM job-detail record and deliberately does not add
  list-only finance rollup keys.
- `svc.list_tasks` returns `tasks` and `pagination`. Task records use the CRM
  projection names such as `description`, `assignee_name`, `parent_type`,
  `parent_id`, and `parent_label`.

The runner supports only the Phase 1 three-tool catalog. Generated invoices and
payments exist to make the synthetic graph honest and connected; Phase 5 does
not add finance tools or write capabilities.

## 5. Security and data boundary

No request or fixture path queries CRM storage. The generator has no database
client, network client, company credential, run-token, or production
identifier. Its company ID and every child identifier are seed-derived
synthetic values. Names contain `Synthetic`/`Sandbox`, email addresses use
`example.invalid`, and phone numbers use the reserved 555 test range.

The live `/v1/run` path is unchanged. Live tenant authority still comes only
from the CRM-issued run-token and installation binding. Phase 5 does not create
a tenant, principal, installation, audit row, or usage row in the CRM database.

## 6. Verification contract

Runner tests cover:

1. same-seed determinism and different-seed divergence;
2. parent linkage and lifecycle/amount date consistency;
3. generated list/detail/task projection behavior;
4. meaningful `morning-digest` output and usage from generated fixtures;
5. honest unknown-tool and timeout errors;
6. the named connectivity sabotage control.

CRM Jest covers recursive fixture-versus-real-projector key paths for all three
tools and the changed CRM-to-runner response protocol. The sabotage control is
proven with BREAK → red → exact reverse patch → green, without resetting the
worktree.

## 7. Risks

1. A response-key contract catches structural drift, not semantic changes to a
   field. If CRM changes field meaning without changing keys, a focused semantic
   fixture test must be added with that change.
2. The synthetic set is intentionally small. It proves ordinary filters,
   linkage, application behavior, and isolation limits, not production-scale
   query performance or every rare CRM state.
3. Caller-supplied Phase 4 fixture maps remain accepted for compatibility and
   can be disconnected. Product App Studio no longer sends them; only generated
   fixture runs carry the full connected summary.

## 8. Out of scope / next

Write tools and preview buffers (Phase 6+), moderation, egress, triggers,
public Marketplace publication, production orchestration, large synthetic
datasets, and UI polish are not added. A standalone tenant-scoped “Test in
sandbox” UI action needs a separately specified CRM endpoint that can load an
owned immutable version without exposing `source_code` to the browser.
