# INVOICE-ESTIMATE-NUMBERING-001 — per-company doc numbers + durable codes

Applies the numbering scheme to the twin financial documents **estimates** and
**invoices** together (shared number-builder + Feistel infrastructure).

## Problem
The document number embeds a **global** identifier shipped to customers (email, PDF,
public pay page) and the MCP agent — `ESTIMATE L-{lead.serial_id GLOBAL}-{seq}`,
`INVOICE J-{job.id GLOBAL}-{seq}` — leaking cross-tenant creation order. Everything
else keys off stable FK ids (payments, Stripe, receipts, PDFs, exports, webhooks all
use `invoice_id`/`estimate_id`/`id`; numbers are stored once at create, never
recomputed). So the NEW-doc format change is low-risk; issued numbers stay frozen.

## Owner decisions (locked this thread)
- **Document number** = per-company, parent-tied, **no "J" prefix**:
  - from a **lead** → `L{lead_seq}-{n}`
  - from a **job** → `{job_seq}-{n}` (bare, no letter)
  - `{n}` = the document's per-parent sequence. **Conversion preserves it**: converting
    estimate `L1234-2` → invoice keeps `L1234-2` (copy the source number, don't mint new).
- **Durable code** (`public_code`) = **5-char base62 Feistel(id)**, same construction/key as
  jobs & leads (reuse GUC `app.job_code_feistel_key`, no new env). This is the stable
  DB/URL identifier + durable link. **No separate per-company `*_seq` counter** — the
  human number is `L{lead_seq}-{n}`; the stable key is the code.
- **Invoice public_token hardening** = IN SCOPE this pass (expiry + status gate + rotate-on-resend).

## Identifier model — per entity (estimates AND invoices)
1. **`id`** (`BIGSERIAL PK`) — internal key. Unchanged (FKs, `/api/…/:id`, payments, Stripe, mobile).
2. **`public_code`** (`TEXT`, 5×base62, `UNIQUE`, global) — NEW. `estimate_public_code(id)` /
   `invoice_public_code(id)` (jobs Feistel, shared key). Canonical in-app URL + durable link.
3. **`estimate_number` / `invoice_number`** (existing `VARCHAR(50)`, per-company `UNIQUE`) —
   the human display/document number. Format fixed to `L{lead_seq}-{n}` / `{job_seq}-{n}`;
   conversion-preserving. Stays on PDF/email/customer surfaces (leak removed).

## Number format & sequence (the careful part)
- **Prerequisite:** `getJobContext`/`getLeadContext` (`estimatesQueries.js:265-292`) currently
  select `serial_id` / global job id — **add `lead_seq` and `job_seq`** so builders can swap.
- **Prefix swap:** `estimateNumberPrefix`/`invoiceNumberPrefix` →
  `L{lead_seq}-` (lead) / `{job_seq}-` (job, bare). Drop the `J` letter. NEW docs only.
  Callers: `estimatesService.js:318/327/338/347/1161/1169/1338-1356`, `invoicesService.js:180-209`.
- **Conversion preserves the number:** the estimate→invoice path (`estimatesService.js:1338-1356`)
  must **copy the estimate's `estimate_number` into the new `invoice_number`** instead of calling
  `buildInvoiceNumber`. (`UNIQUE(company_id, invoice_number)` still holds — an estimate `L1234-2`
  and its converted invoice `L1234-2` live in different tables.)
- **Hazard 1 — sequence restart:** `nextEstimateSequence`/`nextInvoiceSequence` gate on
  `LIKE '{prefix}%'`; the new prefix won't match OLD rows → `MAX()` resets → a parent with
  existing docs restarts at `-1`. **Fix:** seed the new-format sequence from the old-prefix MAX
  for that parent (union old + new prefix in the continuation), so a parent's numbering stays
  continuous across the format cutover. Include the converted invoices in `nextInvoiceSequence`'s
  MAX so a later standalone invoice doesn't collide with a copied number.
- **Hazard 2 — cross-namespace aliasing** (EST-DUP-001 class, now WORSE without the `J`/`L`
  disambiguator for jobs): a bare `{job_seq}-` prefix (per-company dense) is textually a plain
  number and could align with a lead's `{lead_seq}` space or an old global value. **Mitigation:**
  estimate/invoice numbers are already `UNIQUE(company_id, number)` and jobs vs leads never share a
  parent for the same doc; keep the trailing `-{n}` guard; the seed-from-old logic keys on
  (company_id, parent) not raw text. Verify with the sequence tests.
- Render/strip surfaces are format-agnostic (strip leading word only) — unchanged. **Update in
  lockstep:** `estimateNumberSequence.test.js`, `invoiceNumberSequence.test.js`,
  `estimatesLifecycleR2.test.js`, and the build-prefix==LIKE-prefix invariant assertions.

## Feistel / trigger / backfill (mirror jobs 271+273, leads 279 — NO counter needed)
- `estimate_public_code(id)` / `invoice_public_code(id)` — 62⁵ keyed Feistel/cycle-walk, reuse
  GUC `app.job_code_feistel_key`. Deterministic from `id` → no counter, no race.
- `BEFORE INSERT` trigger per table: `NEW.public_code := *_public_code(NEW.id)`. Fires on every path.
- Backfill (idempotent): `UPDATE … SET public_code = *_public_code(id) WHERE public_code IS NULL`.
  Number columns NOT touched (frozen).

## URL routing (code-based; no seq)
- **Canonical in-app:** `/estimates/:code` `/invoices/:code` → `getEstimateByCode` / `getInvoiceByCode`
  (global `WHERE public_code=$1`; route enforces session-company match → 404 cross-tenant, mirror
  jobs by-code). Today there is NO per-record route (a panel opened via `?openId=<id>`) → add these;
  the list page resolves `:code`.
- **Shims → redirect to `/…/:code`:** `/estimates/by-id/:id` `/invoices/by-id/:id` (FK-only builders:
  tasks parentPath, EstimateDetailPanel cross-links) and the existing `?openId=<id>` (kept as a
  redirect during migration; resolve id → code). Data endpoints `/api/…/:id` unchanged (company-scoped).
- Optional durable short alias `/es/:code` `/iv/:code` (authed, like `/j/:code`) if we want a
  short shareable form; otherwise `/estimates/:code` is already the durable link.
- Mobile (`albusto-mobile`) keeps `/api/{kind}s/:id` (company-scoped) — add `public_code` to the doc
  DTO; no deep-link change required.

## Machine contracts (additive; keep existing fields)
- MCP `projectInvoiceSummary`/`projectEstimateSummary` + `agentSkillsMcpRegistry` schema: add
  `public_code`; keep `id` + `*_number` (the number value changes format for new docs — additive/opaque).
- App-runtime `appEventCatalog` estimate/invoice events: add `public_code` alongside id + number.

## Invoice token hardening (bundled — owner: include now)
Bring the invoice `public_token` to estimate parity: add `public_token_expires_at`, a status gate in
`getInvoiceByPublicToken` (`invoicesQueries.js:846-874`), and rotate-on-resend in
`invoicesService.ensurePublicLink`/send. Estimate token already has all three (`estimatesService.js:831`).

## Frozen / out of scope
- Already-issued `estimate_number`/`invoice_number` + `estimate_sequence` column — never backfilled.
- Legacy `INV-YYYYMMDD` parser stays; all render/strip surfaces stay; `?openId` kept via by-id shim.

## Verification
- Every estimate/invoice gets a unique global `public_code`. NEW numbers use `L{lead_seq}-{n}` /
  `{job_seq}-{n}`; a converted invoice copies its estimate's number; sequences stay continuous
  (seeded). Issued numbers unchanged.
- `/estimates/:code` `/invoices/:code` resolve in company context; `by-id` + `?openId` redirect; a
  foreign company's code 404s. Payments/Stripe/receipts unaffected (FK-keyed). Invoice public link
  now expires + status-gated + rotates.

## Split (tandem)
- **Claude:** this spec, schema/migration shape, URL/identifier design, all frontend (code routes,
  redirect pages, `?openId`→by-id, number display/placeholders), review + gate.
- **Codex:** `public_code` columns + Feistel fns + triggers + backfill (mig); number-format swap +
  conversion-preserve + sequence seeding; context-query prerequisite; `getEstimateByCode`/`ByCode`
  routes; MCP/event additive `public_code`; invoice-token hardening; tests.
