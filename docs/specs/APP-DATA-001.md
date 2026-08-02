# APP-DATA-001 — apps with memory and hands

Status: approved direction (owner, 2026-08-02); phases C/D/E below.
Depends on: APP-VIEW-001 (phases A/B shipped in-branch), APP-TOOLS-001, APP-GW-001,
APP-RUN-001, APP-SANDBOX-001, APP-STUDIO-001 §4.

## 1. Why — the owner's decision

The worked example: *after an estimate is approved, pull the part numbers out of
it and add them to a purchasing table.* The obvious shortcut — build purchasing
as a core CRM section — was explicitly rejected:

> "Я хочу, чтобы App Studio позволял создавать сервисы такого уровня. Я могу
> сделать внутри — но он может не подойти кому-то. Или какой-то дистрибьютор
> решит свой сделать — почему бы и нет."

So App Studio graduates from *reports* to *services*: an app may keep its own
data across runs and let people act on that data — while still never writing to
a CRM entity. The blast radius of any app, first-party or a distributor's,
stays inside the app.

What already exists and is reused, not rebuilt: estimates carry an
`order_list` of `{part_number, part_name, quantity}` filled by the AI estimate
builder (live rows in production), the execution core with admission and
single-flight, the view-document contract with its validator-rendered
documentation, schedules with company-timezone cadence, and the moderation
pipeline that pins consent to a version.

## 2. The three gaps, in delivery order

### Phase C — the app can see estimates (read tools)

Two descriptors, same conveyor as the existing three (documentation lives in
the descriptor, APP-TOOLS-001 renders it, the drift test enforces it):

- `svc.list_estimates` — filters: `status` (enum of real estimate statuses),
  `accepted_from` / `accepted_to` (YYYY-MM-DD, **company timezone**, reusing
  the APP-TZ bounds helper), `search`, `limit`/`offset`. Rows expose id,
  `estimate_number`, `status`, totals, `contact_id`/`job_id`/`lead_id` refs,
  `accepted_at`, `items_count`, `order_list_count`.
- `svc.get_estimate` — one estimate with `items[]` (name, quantity, unit_price,
  amount) and `order_list[]` (`part_number`, `part_name`, `quantity`).

Business permission: existing `estimates.view`. No new permission, no
migration. Sandbox: the showcase dataset gains estimates tied to its jobs,
several `approved` with realistic `order_list` rows, so the purchasing app is
buildable against fixtures. MCP clients (Avatars, ChatGPT connector) inherit
both tools and their documentation for free.

### Phase D — the app can remember (per-installation data)

**Storage.** One table, strictly tenant-paired:

```
app_data_rows (
  company_id uuid, installation_id bigint,
  collection text, row_key text,
  data jsonb, created_at, updated_at,
  PRIMARY KEY (company_id, installation_id, collection, row_key),
  FK (company_id, installation_id) → marketplace_installations ON DELETE CASCADE
)
```

**Schema is declared, not implied.** A version manifest may declare up to 4
collections: `{name, key_fields[], columns[{key, type}]}` with the same value
types as the view document. The CRM validates every written row against the
accepted version's declaration — in the CRM, never in the runner, same side of
the wall as everything else.

**Idempotency is the point.** `row_key` is derived from the declared
`key_fields` (e.g. `estimate_id + part_number`), writes are upserts: the same
approval processed twice yields one row, not two. `key_fields` are immutable
across versions; columns are additive.

**The app touches its memory only through the gateway.** Inside the isolate:
`ctx.data.list(collection, {limit, offset})`, `ctx.data.upsert(collection,
rows[])`, `ctx.data.delete(collection, keys[])` — bridged to
`/internal/app-runtime/v1/data/*`, authenticated by the run token, bound to the
installation, budgeted separately from tool calls (data_calls ≤ 10 per run).
Limits enforced in the CRM: ≤ 5,000 rows per collection, ≤ 8 KB per row,
≤ 20 MB per installation; breach = failed run with a plain reason.

**Dry runs get a real but throwaway memory:** an in-memory store per dry run,
starting empty, its operations echoed in the report so the author sees what the
draft wrote.

**No CRM writes, still.** `app_data_rows` is the only table any app can touch,
and only its own partition of it.

### Phase E — people can act on what the app shows (actions)

**An action is just another run.** No second execution path: the version
manifest declares `actions: [{id, label}]`; a table block may name a `key`
column and attach `row_actions: [{id, label, tone?}]`; clicking sends the
regular run request with `input.action = {id, row_key}`. Admission,
single-flight, viewer-permission gate, limits — all already exist and apply
unchanged. The app's own code handles the action (update its data, return a
fresh view document), the screen re-renders.

Validator addenda: `row_actions[].id ⊆` declared action ids; a `key` column
must exist and its values be unique per document. UI: buttons on rows, spinner
while the action-run is in flight, then the new document.

Not in phase E: action parameters/forms, bulk actions, confirmation dialogs
beyond the destructive-tone default. Add when a real app needs them.

## 3. The purchasing app, end to end, after C+D+E

Schedule every 5 minutes (event triggers deliberately deferred — the same
value, minutes later, none of the thundering-herd machinery). Each run:
`list_estimates(status=approved, accepted_from=cursor)` → for each,
`get_estimate` → upsert `{estimate_id, part_number}`-keyed rows into
`purchases` → return a view: stat row (parts to order / ordered), table with
`Mark ordered` row action, which flips the row's status field in app data.

## 4. Security invariants (delta over APP-VIEW-001 §7)

1. App data is partitioned by (company, installation) at the primary key; no
   query path accepts a selector for either — both always derive from the run
   token or the authenticated route, T-blast tested.
2. Row writes are validated against the accepted version's declared schema in
   the CRM; undeclared collections and oversized rows are refused.
3. Actions execute as the clicking user's delegated authority (live viewer
   gate), through the one execution core.
4. Uninstall cascades the data away; retention needs no second mechanism.
5. The runner still holds no state: its data API is a pass-through to the
   gateway, and a compromised runner can reach exactly what the run token
   allows — one installation's partition, for the token's lifetime.

## 5. Verification contract

Phase C: descriptor documentation gate stays green (every param described,
doc regenerated); timezone bounds on `accepted_from/to` (evening approval near
midnight lands on the company's day — the APP-TZ test pattern); T-own/foreign/
blast on both tools; sandbox projection parity; sabotage: drop the permission
mapping → route test red.

Phase D: idempotent double-upsert = one row; undeclared collection refused;
per-row and per-collection limits refused with English reasons; uninstall
cascades; T-blast on the data API; sabotage: allow a tenant selector in the
data route → red.

Phase E: undeclared action id refused by the validator; action run passes the
live viewer gate; single-flight holds when a schedule tick and an action click
collide; sabotage: skip the action-id ⊆ declared check → red.
