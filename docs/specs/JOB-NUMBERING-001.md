# JOB-NUMBERING-001 — Albusto-native job identifiers (post-Zenbooker)

## Problem
Zenbooker assigned `jobs.job_number`. After the ZB decouple, natively-created jobs
get none → exports/cards show `—` (and Excel mojibakes it to `‚Äî`). Move to
Albusto's own numbering. Owner decisions (this thread) are locked below.

## Model — three identifiers (do NOT conflate)
1. **`jobs.id`** (`BIGSERIAL PK`) — canonical internal key. **Unchanged.** All FKs,
   joins, and existing internal references keep using it.
2. **`public_code`** (`TEXT`, 5×base62, `UNIQUE`) — **global**, unguessable,
   under-the-hood identifier + durable/external deep links. Derived = `Feistel(id)`
   (see below). Deterministic from `id` → backfill by pure compute, no counter.
3. **`job_seq`** (`INTEGER`, per-company, `UNIQUE(company_id, job_seq)`) — the human
   "Job #", shown in card / list / export and used in the **in-app URL**. Assigned
   from a per-company counter on create. **Two companies share a number** (each
   sees their own).

## Capacity
- `public_code`: 62⁵ = **916,132,832** global codes at 5 chars. Extend to 6 chars
  (62⁶ ≈ 56.8 B) if `id` ever approaches the cap. `id` today ≪ that.
- `job_seq`: unbounded `INT` per company.

## URL routing (owner-approved: `/jobs/1579` company-relative; external → code)
- **In-app:** `/jobs/:seq` → `WHERE company_id = <session company> AND job_seq = :seq`.
  A link shared into another company resolves to *their* `:seq` — that's why
  external links must NOT use this form.
- **Durable / external / cross-company** (email, SMS, receipts, notifications):
  `/j/:code` → `WHERE public_code = :code` (globally unambiguous) → then redirect
  to the in-app `/jobs/:seq` once the company context is known.
- **Legacy `/jobs/:id`** (global id): deprecated in favour of `/j/:code`. In-app
  link builders (`parentPath`, deep-link builders, notification/receipt URLs)
  switch to `:seq` / `:code` respectively. `:seq` and `:id` are both integers →
  the route resolves the param strictly as `job_seq` in company context; old raw
  `id` links are not auto-redirected (acceptable one-time cost — owner approved
  external → code).

## Feistel (format-preserving) — how `public_code` is generated
- Domain `[0, 62⁵)`. Feistel over `2³⁰` (two 15-bit halves), **keyed** with a secret
  (env `JOB_CODE_FEISTEL_KEY`, not committed), 4 rounds. **Cycle-walk**: if the
  encrypted value ≥ 62⁵, re-encrypt until it lands in range (keeps the bijection).
  Then base62-encode to exactly 5 chars.
- Properties: bijection over `id` → **guaranteed unique, zero collisions, zero
  retries**; keyed → the counter/order can't be recovered from codes.
- Stored (not computed-on-read) with a `UNIQUE` index for fast `/j/:code` lookup and
  stability if the key ever rotates.

### Key delivery invariant

- Before migration 273 the deploy sets the stable value with `ALTER DATABASE`;
  this protects raw `psql` and the old process during the migration→restart
  window. Migration 273 can read that database setting even from an already-open
  session.
- After restart `backend/src/db/connection.js` passes the same value as PostgreSQL
  startup option `app.job_code_feistel_key` on every physical pool connection.
  Session value has priority; the migration-owned fingerprint rejects drift.
- Missing/invalid application env is a degraded startup diagnostic, not a
  process exception: telephony remains live and only `INSERT INTO jobs` fails
  with an explicit key error.
- Migration 273 stores a one-way key fingerprint. Same-key replay is a no-op;
  different-key replay aborts before renaming jobs. Rotation preserves
  `jobs.updated_at`.
- The production value is never committed. Tests use an explicit non-production
  fixture key and verify that the raw value is absent from the fingerprint table.

## Per-company counter
- `company_job_counters (company_id UUID PRIMARY KEY, next_seq INT NOT NULL)`.
- On create: `UPDATE company_job_counters SET next_seq = next_seq + 1
  WHERE company_id = $1 RETURNING next_seq - 1` (row-lock = race-safe); insert the
  counter row seeded at `N+1` during backfill, or at `1` for a brand-new company.

## Backfill (migration) — **OPTION 1: clean renumber** (owner default, veto window until this step)
- `public_code`: compute `Feistel(id)` for every existing row; fill `UNIQUE` column.
- `job_seq`: per company, assign `1..N` ordered by `created_at, id`; set each
  company's counter to `N+1`.
- (Option 2 — preserve legacy `job_number` where present, continue for the rest —
  NOT chosen; leaves gaps/inconsistency.)
- Legacy `jobs.job_number` (TEXT, ZB) is left in place for historical reference; the
  UI drives off `job_seq`.

## Also fix
- **CSV export encoding**: emit a UTF-8 BOM (or ASCII-safe placeholder) so `—`/codes
  don't mojibake to `‚Äî` in Excel.

## Verification
- Every job has a unique `public_code` (global) and `job_seq` (per company).
- `/jobs/:seq` resolves in company context; `/j/:code` resolves globally + redirects.
- Card / list / export show `job_seq`; email/SMS/receipt links use `/j/:code`.
- Concurrency: two simultaneous creates in one company get distinct `job_seq`.
- `public_code` is unguessable (no visible ordering across consecutive `id`s).
- Production module load without `JOB_CODE_FEISTEL_KEY` succeeds and telephony
  modules load; health is degraded and a job insert fails clearly. A connection
  with the key reports the same GUC and can insert through the trigger.
- Replaying migration 273 with the same key preserves code/timestamp; a different
  key aborts and does not mutate any job.

## Split (tandem)
- **Claude:** this spec, schema/migration shape, URL-resolution design, all frontend
  (card/list/export display, `/jobs/:seq` + `/j/:code` routing, link builders).
- **Codex:** Feistel generator + key handling, per-company counter, create-path wiring,
  backfill migration, backend resolution queries, tests (unit + concurrency).
