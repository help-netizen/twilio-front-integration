# LEAD-NUMBERING-001 — Per-company lead numbers + global short code

## Problem
Leads carry a **global** `serial_id` (`SERIAL`) shown to users as the "ID" column and
used (indirectly) for the `/leads/:id` URL. It reveals the global creation order across
tenants, and the URL/link plumbing is fragile: a click navigates with `SerialId`, the URL
loader resolves with `getLeadById` → `WHERE id = …`; they coincide only because
`id ≈ serial_id`. Owner ask: give leads the **same scheme as jobs** — a per-company
display number + per-company in-app URL, plus a short global code for durable links.

## Owner decisions (this thread — locked)
- **Short global code `/l/:code`** (full parity with jobs' `/j/:code`), NOT reuse of the
  existing 20-char `uuid`. Mint a new 5-char base62 code. `uuid` stays as the internal
  API/FK handle.
- **Do NOT touch estimate/invoice number formats** this pass. `ESTIMATE L-{serial}-{n}` /
  `INVOICE L-{serial}-{n}` stay as-is; detaching them from the global serial is a **later,
  separate step** (see Deferred).

## Model — four handles (distinct roles; do NOT conflate)
1. **`leads.id`** (`BIGSERIAL PK`) — canonical internal key. **Unchanged.** All FKs/joins
   (`lead_team_assignments.lead_id`, tasks, events). DTO = `ClientId`.
2. **`leads.uuid`** (`VARCHAR(20)`, `UNIQUE`, global) — the internal **API + FK handle**,
   **unchanged**: `GET/PATCH /api/leads/:uuid`, `getLeadByUUID`, every mutation
   `WHERE uuid = $1 AND company_id = $2`, `outbound_lead_call.lead_uuid`. Kept as-is; too
   deeply wired to remove and not user-facing.
3. **`leads.public_code`** (`TEXT`, 5×base62, `UNIQUE`, global) — **NEW.** Unguessable
   short code for durable/deep links `/l/:code`. = keyed `Feistel(id)` (see below). Stored
   (not computed-on-read) with a `UNIQUE` index. Mirrors `jobs.public_code`.
4. **`leads.lead_seq`** (`INTEGER`, per-company, `UNIQUE(company_id, lead_seq)`) — **NEW.**
   The human "Lead #" `1,2,3…`, per company; shown in list/card/detail and used in the
   **in-app URL** `/leads/:seq`. **Two companies share a number** (each sees their own).
   DTO = `LeadSeq`.

`serial_id` is **frozen**, not dropped (issued estimate/invoice numbers still embed it):
kept in the row, no longer shown, no longer the URL/number source.

## Capacity
- `public_code`: 62⁵ = **916,132,832** global codes at 5 chars (extend to 6 if `id` nears
  the cap — `id` today ≪ that). `lead_seq`: unbounded `INT` per company.

## Feistel — how `public_code` is generated (reuse the jobs machinery + key)
- Same construction as `jobs.public_code`: domain `[0, 62⁵)`, keyed Feistel over `2³⁰`,
  4 rounds, **cycle-walk** into range, base62-encode to 5 chars → bijection over `id`
  (guaranteed unique, zero collisions/retries, unguessable order).
- **Reuse the existing key** (env `JOB_CODE_FEISTEL_KEY` / GUC `app.job_code_feistel_key`)
  — **no new prod env var**. Implement `lead_public_code(id)` sharing that key. Same-`id`
  lead & job yield the same code, namespaced by route prefix (`/l/` vs `/j/`) → no
  collision (each `public_code` column is independently `UNIQUE`). (A future hardening
  could split keys; not needed now — `/l/:code` is not yet externally shared.)

## Per-company counter + assignment
- `company_lead_counters (company_id UUID PRIMARY KEY, next_seq INT NOT NULL)` — mirrors
  `company_job_counters`.
- **`BEFORE INSERT` trigger** on `leads` (`leads_assign_identifiers`) sets, on **every**
  insert path (manual, Yelp/LSA/eLocal ingestion, email-origin, integrations-leads):
  - `public_code := lead_public_code(NEW.id)` (BIGSERIAL default is applied before the
    BEFORE-ROW trigger, so `NEW.id` is available — same as jobs).
  - `lead_seq` atomically from the counter:
    `INSERT INTO company_lead_counters (company_id, next_seq) VALUES (NEW.company_id, 2)
     ON CONFLICT (company_id) DO UPDATE SET next_seq = company_lead_counters.next_seq + 1
     RETURNING next_seq - 1` (row-lock = race-safe).
  - `uuid` keeps being generated in the service (`generateUniqueUUID`) — untouched.

## Backfill (migration) — **OPTION 1: clean renumber** (owner default for jobs; same here)
- `public_code`: compute `lead_public_code(id)` for every existing row; fill `UNIQUE` col.
- `lead_seq`: per company, `1..N` ordered by `created_at, id`; seed each counter at `N+1`.
- Idempotent / re-runnable (migrations 083+ re-run in prod).

## URL routing (mirror jobs) — refined by the audit
Audit finding: **4 of 5 link-builders already emit `leads.id` (PK)** and resolve cleanly
via `getLeadById` (`WHERE l.id=`): Schedule (`scheduleQueries` `l.id AS entity_id`), Tasks
(`parent_id` = `lead_id` FK→`leads.id`), both Contact panels (`lead.id`), Notifications
(`record_id`, id-or-uuid). **Only the primary list row-click is broken** — `LeadsPage.tsx:106`
navigates with `SerialId` while the loader resolves by `id` (works only because `id ≈
serial_id`). So the link rework is small and targeted, NOT a mass entity-key migration.

- **In-app canonical:** `/leads/:seq` → `WHERE company_id = <session company> AND
  lead_seq = :seq` via new `getLeadBySeq(companyId, seq)` (fail-closed if no company).
  `LeadsPage` resolves the route param via `getLeadBySeq`; panel data still loads by `uuid`.
- **`/l/:code`** (durable/external) → `getLeadByCode(code)` (GLOBAL `WHERE public_code =
  :code`) → resolve company → `<Navigate replace>` to `/leads/:seq`. Cross-tenant guard.
- **`/leads/by-id/:id`** (shim) → `getLeadById(id)` → its `lead_seq` → redirect. The 4
  id-emitting builders switch their path template `/leads/${id}` → `/leads/by-id/${id}`
  (one-line each). Backend `GET /api/leads/by-id/:id` already exists.
- **`/leads/by-uuid/:uuid`** (shim) → for notification refs that carry a uuid (non-numeric),
  and any uuid-only builder. Redirects to `/leads/:seq`.
- **Row-click** (`LeadsPage.tsx:106`): emit `lead_seq` → `/leads/:seq` (fixes the mismatch).
- **LEAVE FROZEN (do NOT migrate):** `domain_events.aggregate_id` (leads = `serial_id`;
  `getEntityHistory` reads dual-keyed `id OR serial_id` → safe) and `note_attachments.entity_id`
  (leads = `serial_id`, the stable attachment key; `noteAttachmentsService.resolveEntityIdInCompany`
  + `unitLabelScanService` predicate). These are internal keys, never URL sources — untouched.
- `/api/leads/*` data endpoints stay keyed on `:uuid` — **unchanged**.
- **Search/sort:** the "ID"→"#" column shows/sorts by `lead_seq`; the search box matches
  `lead_seq` **and** keeps matching `serial_id` (additive) so "search the number you see" works.
- **Fix latent bug R5 (independent of numbering):** lead financials pass `lead_id = SerialId`
  but the FK is `leads.id` — switch `LeadDetailPanel`/`useLeadFinancials` to `ClientId`
  (`leads.id`). Never key financials by `lead_seq`.

## Display
- Leads list column "ID" (bound to `SerialId`, sort `SerialId`) → **`LeadSeq`**, header
  `#`, sort by `lead_seq`. Detail panel/header show `Lead #{LeadSeq}`.
- FE `Lead` type gains `LeadSeq?: number | null` (+ `PublicCode?` for the share link);
  `rowToLead` projects `LeadSeq: row.lead_seq`, `PublicCode: row.public_code`.
- Click-navigation uses `lead_seq` (not `SerialId`); URL loader resolves via `getLeadBySeq`.

## Machine contracts (additive — does NOT touch doc numbers)
- MCP (chatgpt) lead get/search, inspector, sync: **add `lead_seq` + `public_code`** to
  output; let number-search also match `lead_seq` (keep `serial_id` match for back-compat).
  Never remove `serial_id` from an existing output a consumer may read.

## Integrations (verify in audit — expected safe)
- Lead-gen apps (Yelp/LSA/eLocal), VAPI/Sara, outbound calls: expected safe (match by
  phone; persist `uuid`/`id`; emit no global lead number or `/leads/:n` link). Audit
  confirms per surface; any at-risk surface handled before build.

## Deferred (explicitly out of scope this pass)
- Detaching estimate/invoice number **formats** from the global `serial_id`
  (`ESTIMATE/INVOICE L-{serial}-` → `L-{lead_seq}-` for new docs). Owner: not now.
- **Job-side lead-number displays** still show `lead_serial_id`: mobile `JobCardHeader`
  (`job.job_number || job.lead_serial_id`), web `JobDetailPanel`/`JobFinancialsTab`. These
  are the *job's* fallback number, not the lead's identity — left on `serial_id` (stable).
  Threading `lead_seq` into the job DTO/sync is a follow-up; job UI keeps showing the serial
  for now (accepted divergence from the leads UI, which shows `lead_seq`).
- Third-party create-lead API (`POST /api/v1/integrations/leads`) keeps `serial_id` in its
  response (documented partner contract); `lead_seq` added alongside, `serial_id` not removed.

## Verification
- Every lead: unique `public_code` (global) + `lead_seq` (per company); `uuid` unchanged.
- `/leads/:seq` resolves in company context; `/l/:code` + `/leads/by-id/:id` redirect to
  it; a foreign company's `:seq` shows *their* lead (no leak); `/l/:code` for another
  company redirects but the target still enforces company access.
- List/detail show `lead_seq`; `public_code` unguessable (no visible order across `id`s).
- Concurrency: two simultaneous creates in one company get distinct `lead_seq`.
- Estimate/invoice numbers UNCHANGED. Lead-gen/agent surfaces unaffected (audit-confirmed).

## Split (tandem)
- **Claude:** this spec, schema/migration shape, URL-resolution & entity-key design, all
  frontend (list/detail display, `/leads/:seq` + `/l/:code` + `by-id` routing, redirect
  pages, link builders), review + gate.
- **Codex:** `lead_seq` + `public_code` columns, `company_lead_counters`,
  `lead_public_code()` (reusing the jobs Feistel key) + `BEFORE INSERT` trigger, backfill
  migration, `getLeadBySeq` + `getLeadByCode`, routes `GET /api/leads/by-seq/:seq` &
  `/by-code/:code` (registered before `/:uuid`), `entity_id`→`id` switch in event/task
  logging, MCP/inspector/sync `lead_seq`+`public_code` exposure, tests (unit + concurrency
  + backfill + cross-tenant).
