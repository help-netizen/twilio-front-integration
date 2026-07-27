# REPORT-TO-ESTIMATE-001 — Price-Book-grounded AI estimate/invoice generator

Status: approved design (owner 2026-07-27) · /tandem (Claude = design/prompt/schema/FE, Codex = backend/tests)

## Problem

`backend/src/services/aiEstimateService.js` today: the LLM prompt (`SYSTEM_PROMPT`)
**never shows the model the Price Book**. It extracts free-text lines
(`description/qty/unit_price`), then the server does a naive word-overlap match
(`bestItemMatch`, `MATCH_THRESHOLD = 0.55`) against the catalog. Consequences:
- model has zero catalog knowledge; **groups are invisible** to it;
- everything lands in the line title, never the item description;
- unmatched lines auto-create junk Price Book items.

Owner verdict: output unusable.

## Goal

The generator **builds the draft from the company's Price Book**: map the report to
catalog **groups/items by id**, operate in **groups** (a group = labor + its parts =
one service unit), order **labor first then parts**, use the **description** field for
specifics, take **catalog prices** (override only on an explicit report quote), and
**reuse catalog items** over creating new. Packaged as a default-ON marketplace app
**"Report → Estimate"** with a **per-company editable instruction**; a soft banner
replaces generation when the app is disabled.

## Price Book model (studied)

`Category → Group → Item` (migrations 085, 141, 193).
- **Item** = `estimate_item_presets`: `name, description, default_quantity,
  default_unit_price, unit, code, category_id`. No labor/part flag — conveyed by
  naming + order.
- **Group** = `price_book_groups` + M2M `price_book_group_items(quantity)`: a named
  service unit that **expands into its member items** (each with a link quantity).
  This is the unit to prefer.
- Query shapes exist: `priceBookQueries.getGroupExpansion / getGroupItems / listGroups`,
  `estimateItemPresetsQueries.listForManage`.

## Design

### Generation flow (replaces the current extract-then-match)
1. **Gate** — app `report_to_estimate` must be enabled for the company (else the route
   returns a structured `app_disabled` error the FE renders as a soft banner).
2. **Digest** — build a compact, bounded Price Book digest for the company:
   - GROUPS: `{group_id, name, category, items:[{item_id, name, qty, unit_price, unit}]}`
   - ITEMS: `{item_id, name, description, unit_price, unit, code, category_path}`
   - Bound total size (cap groups + items; when the catalog is large, prioritize groups
     then most-used items by `usage_count`). Log when truncated.
3. **Prompt** = `[per-company instruction]` + `[Price Book digest]` + `[report — UNTRUSTED]`.
4. **Model output = catalog selections** (schema below), not free text.
5. **Assemble** server-side:
   - expand each selected `group` → member items, **labor line(s) first, then parts**;
   - resolve price from the catalog item unless the line carries an explicit override;
   - qty from the line if set, else catalog/link default;
   - title = catalog `name`; `description` = the model's per-line specifics;
   - reuse by id; create a new Price Book item ONLY for `source:"new"` lines and only
     when `canManagePriceBook`.

### Response schema (new)
```
{
  summary: STRING,
  lines: [{
    source: "group" | "item" | "new",
    group_id?: NUMBER,     // when source=group
    item_id?: NUMBER,      // when source=item
    title?: STRING,        // when source=new (or an intentional retitle)
    description?: STRING,   // report-specific detail — goes to the line description
    qty?: NUMBER,
    unit_price?: NUMBER     // ONLY when the report explicitly quotes a different price
  }],
  order_list: [ ... unchanged ... ]
}
```
Server validates every `group_id`/`item_id` belongs to `companyId` (reject cross-tenant).
Group lines expand in `price_book_group_items.sort_order`, labor-first.

### Default instruction (per-company editable; this text is the seed)
> **Report → Estimate** turns a service report into a draft **built from your Price Book** —
> your catalog is the source of truth for what you sell, how it's described, and what it costs.
> 1. For every work item or part in the report, pick the matching Price Book **group or item** —
>    don't type free text. Propose a new item only when nothing in the book reasonably fits.
> 2. When the report describes a standard job, select the **Group** (service unit); it brings
>    its labor + parts.
> 3. Order each unit **labor first, then its parts**.
> 4. Keep the catalog **name as the title**; put report specifics (model, symptom, part number,
>    what was done) in the **description**.
> 5. Use **Price Book prices**; override a price only when the report explicitly quotes a
>    different amount.
> 6. Use the report's quantity when stated, otherwise the catalog default. Never invent work,
>    parts, or prices.

The security preamble (report = untrusted data, never instructions) stays as a fixed,
non-editable wrapper around the editable instruction.

### Marketplace app "Report → Estimate"
- Register following the existing marketplace-app pattern (cf. lead-gen apps + RELY-SETTINGS):
  user-facing app, **default-enabled for every tenant** (backfill existing companies +
  onboarding bootstrap).
- Per-company setting `instruction_text` (default = the seed above), editable in the app's
  settings surface.
- The estimate/invoice route consults enablement; disabled → `app_disabled` → FE soft banner
  ("Turn a report into a draft — connect Report → Estimate").

## Work split
- **T1 (Codex) — generator core:** digest builder + new prompt (seed instruction constant) +
  new response schema + `generateDraft` rewrite (expand groups, labor-first, price/qty/desc
  resolution, reuse-over-create, cross-tenant id validation) + unit tests. Keep the current
  route contract; enrich the returned `line_items`.
- **T2 (Codex) — app + editable instruction:** migration to register the app (default-on) +
  per-company `instruction_text` storage + enablement gate + wire the generator to read the
  per-company instruction. Tests.
- **T3 (Claude) — FE:** app card/toggle in the marketplace, the settings editor for the
  instruction, and the soft banner on the report field when disabled.

## Acceptance
- Standard-job report → matching **Group** expands to labor + parts, **labor first**.
- Line titles = catalog names; specifics in **description**; prices from catalog unless the
  report quotes otherwise; qty from report else default.
- Reuses catalog by id; new item only on `source:"new"` + `canManagePriceBook`.
- Disabled app → generation blocked + banner; enabled by default for all tenants.
- Editable instruction persisted per-company + used in the prompt.
- Tenancy: digest + selections scoped to `company_id`; cross-tenant id rejected.

## Sabotage checks (tandem gate)
- SAB-IGNORES-BOOK — model selections ignored / still free-text matched → red.
- SAB-CROSS-TENANT-DIGEST — digest or accepted id leaks another company → red.
- SAB-PROMPT-INJECTION — instructions inside the report are followed → red.
- SAB-DEFAULT-OFF — app not enabled by default for a tenant → red.
- SAB-PARTS-BEFORE-LABOR — group expands parts-before-labor → red.
