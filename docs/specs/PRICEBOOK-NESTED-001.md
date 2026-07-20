# PRICEBOOK-NESTED-001 — three-level Price Book category tree and Workiz import

**Status:** implemented and verified locally; production dry-run/apply remain owner-gated  
**Date:** 2026-07-20 · **Area:** Price Book / estimates / invoices  
**Evolves:** `PRICEBOOK-001`, `PRICEBOOK-002` · **Migration:** 193

## Goal

Allow Price Book categories to form a company-scoped tree with at most three
levels, expose both a nested API and the existing flat API, let a user browse the
tree and select an item, and import the two owner-supplied Workiz workbooks without
duplicating data or changing the six existing production presets.

## Owner decisions (verbatim authority)

> "добавить поддержку подкатегорий в pricebook. Это подкатегории, первая самая крупная. вторая входит в него. а третья - во вторую"

Binding interpretation: Price Book categories are a tree of at most three levels:
level 1 contains level 2, and level 2 contains level 3. A cycle and a fourth level
must be rejected by PostgreSQL, not only by the UI.

The owner separately chose the literal level-1 category name `8 Education`. It must
not be renamed or reinterpreted as training content. Its 209 rows are real sellable
flat-rate services.

## Scope

- Add a nullable, self-referencing `parent_id` to `price_book_categories`.
- Enforce same-company parentage, no cycles, and a maximum depth of three in the
  database, including reparenting an existing subtree.
- Replace category active-name uniqueness with parent-aware uniqueness that also
  handles root `NULL` correctly.
- Resolve the pre-existing item active-name index conflict exposed by stripping
  `SKU - ` from imported item names, without changing any existing item row.
- Add one nullable storage-only `item_type` column and populate it from Workiz.
- Preserve `GET /api/price-book/categories` as a flat response and add a nested
  category-tree read contract.
- Extend category create/update with `parent_id` and keep all Price Book reads and
  writes company-scoped and permission-gated.
- Add tree browsing to the shared item picker and hierarchical category labels to
  Settings → Price Book.
- Add a repeatable Node CLI for the two `.xlsx` sources. It defaults to no writes,
  supports explicit `--dry-run`, requires `--company-id=<uuid>`, and requires an
  explicit `--apply` for mutation.
- Add real-PostgreSQL, backend, import, frontend, tenancy/RBAC, compatibility, and
  named sabotage coverage.

## Out of scope

- Changing how estimates or invoices snapshot/consume a selected item or group.
- Adding item cost, inventory, images, model numbers, or Workiz custom fields.
- Mutating, categorizing, archiving, deduplicating, or otherwise “cleaning up” the
  six existing production `estimate_item_presets` rows.
- Adding package dependencies.
- Renaming `8 Education`.

## Decisions taken

### D1 — owner decided “Импорт без этой строки”

The importer skips source row 280, `0003 - Service call fee paid` at `-95`, entirely.
It does not create the item, clamp/negate/substitute the value, or weaken either
`>= 0` constraint. Revalidation found exactly **121** references to this SKU (one in
every group), drops exactly those 121 links, and leaves **0** empty groups. A changed
source count aborts preflight instead of guessing.

This has an intentional operational consequence: **every imported group now totals
$95 more than the owner’s Workiz setup intended**, because the service-call credit is
gone. The dispatcher deducts that $95 manually. The owner accepted this knowingly.
Future maintainers must not “fix” the difference by re-adding a negative line.

### D2 — owner decided “Сохранить”

Migration 193 adds the single nullable storage-only column
`estimate_item_presets.item_type`. The importer persists `Service` / `Product` from
the workbook. No product behavior reads or edits it yet; that is intentional so a
future labor-versus-parts feature will not require another import. Cost remains
absent because every source Cost cell is empty.

### D3 — accepted archive behavior

Archive returns `409 category_not_empty` while any active direct child, item, or
group remains. No recursive archive or silent reassignment occurs.

### D4 — approved UX

The approved sequential drill-down is implemented inside the existing anchored
picker with breadcrumbs and no new overlay. `Uncategorized` keeps legacy presets
reachable. Settings uses the existing right-side panel for category editing.

## Discovery map

| Current seam | Evidence | Consequence for this feature |
|---|---|---|
| Form/overlay canon | `CLAUDE.md:9-18`; `docs/specs/FORM-CANON.md:16-51` | Category create/edit remains a right-side panel with shared floating fields. The anchored picker is a chooser, not an entity editor. |
| Category table and broken-for-tree unique index | `backend/db/migrations/141_create_price_book.sql:15-32` | Add `parent_id`; replace company-wide active-name uniqueness. |
| Item schema extension had no cost/type | `backend/db/migrations/141_create_price_book.sql:56-62`; `backend/db/migrations/085_create_estimate_item_presets.sql:10-23` | Cost is not added; migration 193 adds nullable storage-only `item_type`. |
| Item active-name uniqueness | `backend/db/migrations/085_create_estimate_item_presets.sql:26-29` | Required transformed names cannot import until this index is removed/replaced. |
| Category queries are flat and name lookup ignores parent | `backend/src/db/priceBookQueries.js:16-59,175-181` | Add `parent_id`, a parent-aware lookup, and a tree projection while retaining flat list behavior. |
| Group category join and writes | `backend/src/db/priceBookQueries.js:64-125` | Category labels become full paths in the UI; foreign `category_id` must be rejected before write. |
| Item management filter/join | `backend/src/db/estimateItemPresetsQueries.js:167-191` | Direct-category browse can reuse the existing company-scoped filter; joins must remain tenant-bound. |
| Legacy preset search | `backend/src/db/estimateItemPresetsQueries.js:33-50`; `backend/src/routes/estimate-item-presets.js:34-45` | URI, permission, search-first behavior, and existing rows remain available. |
| Category routes | `backend/src/routes/price-book.js:18-52` | Existing mount already sources company from `req.companyFilter?.company_id`; add the literal tree route without changing middleware. |
| Price Book permissions | `backend/src/routes/price-book.js:33-34`; `backend/db/migrations/050_seed_role_configs.sql:18-125` | Reads use `price_book.view`; mutations use `price_book.manage`; no new permission key. |
| Flat category API client | `frontend/src/services/priceBookApi.ts:21-47` | Extend the type additively and add `listCategoryTree`; do not change the flat function’s return shape. |
| Settings flat selectors/grid | `frontend/src/pages/PriceBookPage.tsx:27-64,209-425,447-623` | Render path labels in item/group selects and an expandable tree in Categories; preserve bulk-grid dirty/save behavior. |
| Shared item picker | `frontend/src/components/estimates/ItemPresetSearchCombobox.tsx:21-214` | Add browse state and breadcrumb/path labels while preserving global search, create-new, recent items, and optional groups. |
| Estimate/invoice consumers | `frontend/src/components/estimates/EstimateDetailPanel.tsx:140-166,395-402`; `frontend/src/components/estimates/EstimateEditorDialog.tsx:203-220,382-385`; `frontend/src/components/invoices/InvoiceDetailPanel.tsx:322-344,618-624` | The shared picker may return an existing item exactly as today. Group expansion and document writes remain untouched. |
| Authenticated route mounts | `src/server.js:230-234` | Both APIs are already behind `authenticate, requireCompanyAccess`; the protected runtime file is not modified. |
| Existing tests | `tests/priceBook.test.js`; `tests/priceBookBulk.test.js`; `tests/priceBookBulkQueries.test.js`; `tests/estimateItemPresetsRbac.test.js` | Extend rather than weaken these contracts; add real-DB invariants and route-level matrix coverage. |

## Source revalidation (2026-07-20, read-only)

The workbooks were read with formulas resolved and no workbook was edited or
exported.

### Items workbook

`~/Downloads/workiz_items_v8_SKU_category_prefix_PLUS_missing_items.xlsx`

- 394 populated item rows; all 394 names parse as `SKU - remainder`.
- 0 duplicate SKUs and 0 duplicate full source names (case-insensitive).
- **After the required prefix removal:** 41 distinct remainder names repeat, with
  212 additional duplicate-name rows; maximum multiplicity is 30. This is valid
  catalog data because SKU and category path distinguish the rows, but it conflicts
  with migration 085’s active-name index.
- Cost is empty on all 394 rows. No cost value will be lost and no cost column will
  be added.
- Source item type: Service 305 / Product 89. After D1’s skipped Service row, the
  persisted plan is Service 304 / Product 89. Taxability is `0` on all 394 sources.
- All 394 prices are present. One is negative: source row 280, SKU `0003`,
  `Service call fee paid`, `-95` (D1).
- Category 1 counts: `0 General fees` 4; `1 Cooktop Repair` 12;
  `2 Dishwasher Repair` 39; `3 Dryer Repair` 29; `4 Microwave Repair` 4;
  `5 Range/Oven Repair` 14; `6 Refrigerator Repair` 44;
  `7 Washer Repair` 39; `8 Education` 209.
- Only `8 Education` uses lower levels. Level 2: Refrigerator 59; Dishwasher 30;
  Dryer 30; Oven 30; `Stove,Range,Cooktop` 30; Washer 30. Level 3:
  Commercial 42; Economy 42; `Etc...` 41; High End 42; Standard 42.
- The resulting tree contains 45 category nodes: 9 roots, 6 level-2 appliance
  nodes, and 30 level-3 segment nodes. The repeated segment names under different
  appliance parents are the intended proof for parent-aware uniqueness.
- Education prices span $220–$2,700 apart from the unrelated negative General-fee
  row.

### Groups workbook

`~/Downloads/workiz_groups_v8_category_prefix_PARTS_filled_STRICT.xlsx`

- 121 populated groups; all are `Individual items`.
- 0 duplicate full group names, 0 duplicate parsed group SKUs, and every group name
  parses as `SKU - remainder`.
- 396 group→item links; 0 orphan references; every quantity is present and `> 0`;
  0 duplicate item references inside a group.
- All populated links have empty part price and part cost cells. Quantity is the
  only link-level source value with a destination, so no link price/cost is lost.
- Groups use the eight non-Education level-1 categories; none uses level 2/3 or
  `8 Education`.

## Approved UX

### A. Item picker — keep search, add browse

The current compact input remains in the estimate/invoice item section. Focusing an
empty input opens a single-pane, sequential browser sized to the existing panel;
typing switches to global search. No center modal is introduced.

```text
┌ Search price book or create a new item… ───────────────┐
│ BROWSE CATEGORIES                                      │
│ › 0 General fees                                      │
│ › 1 Cooktop Repair                                    │
│ › 2 Dishwasher Repair                                 │
│   …                                                    │
│ › 8 Education                                         │
│ › Uncategorized                                       │
│                                                        │
│ FREQUENTLY USED                                        │
│ 1000  Labor to replace infinite switch…        $280.00│
└────────────────────────────────────────────────────────┘
```

Selecting `8 Education`, then `Refrigerator`, then `Economy` drills in without
opening another overlay:

```text
┌ Search price book… ────────────────────────────────────┐
│ ‹ All categories › 8 Education › Refrigerator › Economy│
│ ITEMS                                                  │
│ 8102  Charge freon                              $470.00│
│ 8106  Does Not Cool refrigerator…               $470.00│
│  …                                                     │
└────────────────────────────────────────────────────────┘
```

Interaction contract:

- Each level shows its direct child categories first, then direct groups (only when
  `onPickGroup` exists), then direct items. A category may contain both direct items
  and children; this preserves existing level-1 category behavior.
- Clicking an item calls the existing `onPickPreset` with the unchanged item DTO.
  Clicking a group keeps the existing group-expansion behavior.
- `Uncategorized` exposes the six legacy presets and any other active item with
  `category_id IS NULL`.
- Global search remains available at every level and searches across the company,
  not only the open branch. Results show `code`, name, price, and the full category
  breadcrumb so repeated names are distinguishable.
- The existing “Create new” action remains the last search result. Existing recent /
  frequently-used ordering remains when no branch is open.
- Keyboard: Up/Down moves through actionable rows; Enter opens a category or picks
  a result; Backspace on an empty query goes to the parent; Escape closes and returns
  focus to the input.
- New UI uses only existing design tokens and functional chevrons; no decorative
  cards, hardcoded colors, horizontal separators, or empty placeholder rows.

### B. Settings → Price Book

- Categories tab becomes an expandable tree. Rows are indented by depth and expose
  Edit / Archive plus `Add subcategory` at levels 1 and 2 only.
- `Add category` creates a root. `Add subcategory` opens the canonical right-side
  category panel with its parent preselected. Editing exposes a `Parent category`
  `FloatingSelect`; the current category and its descendants are absent from the
  choices. PostgreSQL remains the authority if stale UI state races a reparent.
- Item-grid and group-panel category controls display full paths, for example
  `8 Education › Refrigerator › Economy`, while storing the same numeric
  `category_id` as today.
- The item spreadsheet, one-save transaction, dirty guard, and group editor remain
  otherwise unchanged.

## Data and database contract

### Category shape

`price_book_categories.parent_id BIGINT NULL` references another category in the
same company. `NULL` means level 1. Depth is derived, not stored.

The migration creates a unique key suitable for the composite self-FK and a
same-company self-reference. A database trigger walks both the proposed parent’s
ancestors and the moved node’s descendants, locks the affected category rows, and
rejects:

1. self-parenting;
2. any ancestor cycle;
3. a new fourth level;
4. reparenting whose existing descendant subtree would extend below level 3;
5. changing a category’s `company_id`.

Real-PostgreSQL tests include ordinary and concurrent opposing reparent attempts;
at most one transaction may succeed and the committed graph must remain acyclic and
at depth `<= 3`.

### Correct uniqueness with root `NULL`

The old index is dropped and replaced by two partial unique indexes:

```sql
UNIQUE (company_id, lower(name))
WHERE parent_id IS NULL AND archived_at IS NULL;

UNIQUE (company_id, parent_id, lower(name))
WHERE parent_id IS NOT NULL AND archived_at IS NULL;
```

The first index explicitly enforces root-name uniqueness; the second enforces
sibling-name uniqueness while allowing `Standard`, `Economy`, and the other segment
names to repeat under different appliance parents. A bare
`(company_id, parent_id, lower(name))` index is forbidden because PostgreSQL treats
root `NULL` values as distinct.

### Item uniqueness required by the import

The transformed import has legitimate duplicate item names, and `PRICEBOOK-002`
already declares duplicate names allowed. Migration 193 therefore drops
`uq_estimate_item_presets_active_name` and adds active, company-scoped,
case-insensitive SKU uniqueness for nonblank `code`. Existing code-`NULL` presets do
not conflict and no item row is updated.

The importer keys imported items by `(company_id, normalized code)`, never by the
transformed name. Manual/legacy items with `code IS NULL` are outside the import
match set even if their names equal an imported remainder.

### Migration and rollback

- Both the worktree and current remote `master` were rechecked immediately before
  writing. Remote `master` was
  `187e7ee5dff795ba5cf5cd5f1251de4fc5b9785e`; migrations 191 and 192 had been taken,
  so 193 was the next free number.
- Final collision check after implementation: remote `master`
  `328d7769816660dea03d928e690af442744442eb` still ends at migration 192; 193 remains
  free. The temporary shallow clone used for the read-only check was removed.
- Forward migration: `backend/db/migrations/193_price_book_nested_categories.sql`.
- Matching rollback:
  `backend/db/migrations/rollback_193_price_book_nested_categories.sql`.
- Forward SQL is replay-safe and changes no existing row values. The six production
  presets must be byte-identical before/after migration.
- Rollback is safe before nested/imported data exists. Once active nested categories
  or duplicate active item names exist, a data-preserving flatten is impossible.
  The rollback must preflight and fail with a clear exception rather than rename,
  archive, or delete data silently; after operators explicitly remove/export the
  incompatible feature data, it restores the former indexes and drops `parent_id`.

## API contract and compatibility

### Existing flat endpoint — preserved

`GET /api/price-book/categories?includeArchived=false`

- Remains `200 { categories: PriceBookCategory[] }`, never changes to a nested
  payload, and retains every former field.
- Adds `parent_id` as an additive nullable field. Existing root rows retain the same
  ids and values. Flat consumers that ignore the field continue to work.

### New tree endpoint

`GET /api/price-book/categories/tree`

```jsonc
{
  "categories": [
    {
      "id": 8,
      "name": "8 Education",
      "parent_id": null,
      "depth": 1,
      "children": [
        {
          "id": 20,
          "name": "Refrigerator",
          "parent_id": 8,
          "depth": 2,
          "children": []
        }
      ]
    }
  ]
}
```

Nodes retain the category DTO fields and add `depth` and `children`. Siblings sort
by `sort_order`, then case-insensitive `name`. Only active nodes appear.

### Category mutation

- `POST /api/price-book/categories` accepts optional `parent_id`.
- `PATCH /api/price-book/categories/:id` accepts `parent_id` (`null` moves to root).
- Foreign/missing/inactive parent: 404 with no write.
- Cycle/fourth-level/subtree-overflow: 422 with no write.
- Duplicate root or sibling name: 409 with no write.
- Archive behavior follows D3 after approval.

### Existing item/group contracts

- `GET /api/price-book/items?category_id=<id>` remains a direct-category filter;
  tree navigation composes it with child traversal in the client.
- Existing item/group create/update validates any supplied category against the
  caller’s company before mutation. Foreign category ids never leak a name and never
  create a cross-tenant reference.
- `/api/estimate-item-presets`, group expansion, estimate/invoice bulk add, CSV
  import/export, and existing flat category consumers retain their routes and former
  response fields. Additive category metadata is allowed; no consumer is changed to
  require the tree endpoint.

## Workiz import contract

### CLI

`scripts/import-workiz-price-book.js`

```text
node scripts/import-workiz-price-book.js --dry-run --company-id=<uuid> \
  --items=<items.xlsx> --groups=<groups.xlsx>

node scripts/import-workiz-price-book.js --apply --company-id=<uuid> \
  --items=<items.xlsx> --groups=<groups.xlsx>
```

- With neither `--dry-run` nor `--apply`, the command behaves as dry-run and prints
  that no writes were made. Both flags together are invalid.
- `--company-id` is required and must resolve to an existing company. `--items` and
  `--groups` may override the two owner-file defaults under `~/Downloads`.
- The script uses existing `pg` and `fast-xml-parser` dependencies plus argument-safe
  `/usr/bin/unzip` execution. It adds no dependency and invokes no shell-expanded
  workbook path.
- The CLI is an operator-only/offline surface, not an HTTP route. It has no `req` and
  takes company scope only from the validated `--company-id` flag.

### Preflight — all errors abort before writes

- Required headers exist; SKUs parse; source SKUs/full names/group names are unique.
- Category columns are contiguous and produce depth `<= 3`.
- Cost is empty on every item; part price/cost is empty on every populated group
  link. Any future nonempty value fails instead of being silently discarded.
- Item type and taxability values are recognized; prices are numeric and compatible
  with the destination constraints; quantities are numeric and `> 0`.
- Every part reference resolves by exact full source item name; duplicate membership
  within one group fails.
- The current sources must report 394 items, 121 groups, 396 raw links, 45 category
  nodes, exactly 121 dropped `0003` links, 393 imported items, 275 imported links,
  and zero empty groups after the drop. Any count drift aborts.
- Existing target duplicates for an imported SKU or active group/path key fail with
  an actionable report; the script never chooses an arbitrary row.

### Mapping

| Workiz source | Destination |
|---|---|
| `Item name = SKU - Name` | `estimate_item_presets.code = SKU`; `name = Name` |
| `Description` | item `description` |
| `Price` | item `default_unit_price` |
| `Taxability` | item `default_taxable` |
| no source quantity/unit | `default_quantity = 1`; `unit = NULL` |
| `Category 1/2/3` | parent-aware category path; item points to deepest populated node |
| full `Group name` | group `name` (the full `SKU - Name` is retained because groups have no code column) |
| group `Description` / `Category 1` | group description / level-1 category |
| `Part N name` | exact full source name → imported item SKU/id |
| `Part N quantity` | `price_book_group_items.quantity`; source column order → `sort_order` |

`Cost`, part price/cost, images, inventory/model/custom fields have no current
destination. Empty cost/part amounts mean no financial data is lost. `Item type`
is persisted to the nullable storage-only `item_type` column and deliberately has
no product reader yet.

### Apply and repeatability

- Parse and validate both workbooks fully before opening the write transaction.
- Open one transaction and take a company-scoped advisory lock so two imports for
  the same company cannot race.
- Find-or-create each active category by `(company_id, parent_id, lower(name))`.
- Insert or update imported items by `(company_id, lower(code))`; update only when a
  mapped value is distinct. Never fall back to name.
- Find-or-create active groups by `(company_id, lower(full group name))`; update only
  mapped fields that differ.
- Upsert each link by `(group_id, item_id)` with the source quantity/order. Do not
  duplicate links. Do not delete unrelated items, groups, categories, or memberships.
- Snapshot every pre-existing item not matched by a source SKU before the first
  write and assert the same rows are byte-identical before commit. The production
  expectation is six such rows.
- A second apply against unchanged sources reports zero entity changes, creates no
  rows/links, and leaves a canonical database snapshot unchanged.
- On any validation, tenant, SQL, or postcondition error: rollback the whole apply
  and exit nonzero.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET /api/price-book/categories` | `req.companyFilter?.company_id` | category rows by `company_id`; no caller-supplied tenant | `price_book.view` | default tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓; any role without effective permission ✗ | Flat aggregate could expose another company’s category names if the base predicate is removed |
| `GET /api/price-book/categories/tree` | `req.companyFilter?.company_id` | all nodes loaded by `company_id`; parent links accepted only within that set | `price_book.view` | default tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓; any role without effective permission ✗ | Tree assembly can magnify one unscoped row into a visible foreign branch |
| `POST /api/price-book/categories` | `req.companyFilter?.company_id` | optional `parent_id` resolved with `id AND company_id` | `price_book.manage` | tenant_admin ✓; manager ✓; dispatcher ✗; provider ✗; missing effective permission ✗ | Foreign parent could create a cross-tenant edge |
| `PATCH/DELETE /api/price-book/categories/:id` | `req.companyFilter?.company_id` | target `id AND company_id`; new parent `id AND company_id` | `price_book.manage` | tenant_admin ✓; manager ✓; dispatcher ✗; provider ✗; missing effective permission ✗ | Id-only update/archive/reparent could mutate a foreign tree |
| Existing item/group create/update with `category_id` | `req.companyFilter?.company_id` | target and category both paired with company | `price_book.manage` | tenant_admin ✓; manager ✓; dispatcher ✗; provider ✗; missing effective permission ✗ | An unscoped category lookup can leak its name or store a foreign FK |
| Existing item/group/preset reads and group expansion | `req.companyFilter?.company_id` | item/group/category ids and aggregates paired with company | `price_book.view` | default tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓; any role without effective permission ✗ | Flat compatibility must not weaken current item/group isolation |
| Workiz CLI dry-run/apply | validated `--company-id`; no `req` and no default company | SKU, category path, group name, and memberships always paired with explicit company; transaction advisory-locked by company | operator CLI authority; no HTTP role | authorized operator ✓; missing/invalid company flag ✗ | A missing company predicate could update every tenant sharing an SKU/name |

Mandatory test matrix for every affected surface:

- `T-own`: own category/tree/item/group/import key works.
- `T-foreign`: foreign target or parent returns 404 (or CLI preflight failure), and
  the foreign row is byte-unchanged.
- `T-blast`: companies A and B share the same root/child names, item SKU, group name,
  and item remainder; an A action leaves every B snapshot byte-unchanged.
- `R-matrix`: every allow cell above succeeds and every deny cell returns 403 before
  a query/write. The CLI is separately gated by an explicit valid company flag.

## Task breakdown and acceptance criteria

### T1 — migration 193 and rollback

Acceptance:

- Candidate number is rechecked immediately before file creation.
- Forward migration is double-apply safe and adds `parent_id` without updating rows.
- Same-company FK, root/sibling uniqueness, active-code uniqueness, cycle guard,
  fourth-level guard, and subtree-reparent guard are enforced by PostgreSQL.
- Same child names under different parents succeed; duplicate root/sibling names
  fail case-insensitively.
- Six seeded legacy presets are byte-identical after forward migration twice.
- Guarded rollback succeeds on pre-feature data, double-apply is safe, and refuses
  lossy rollback once nested/duplicate-name feature data exists.

### T2 — backend flat/tree contracts and category mutation

Files: `backend/src/db/priceBookQueries.js`,
`backend/src/services/priceBookService.js`, `backend/src/routes/price-book.js`.

Acceptance:

- Existing flat response remains flat with additive `parent_id` only.
- New nested response is stable, active-only, correctly sorted, and at most depth 3.
- Category create/reparent maps foreign/missing parent to 404, structural violations
  to 422, and root/sibling conflict to 409.
- Archive implements approved D3 behavior.
- Every affected query and join is company-scoped; all T/R tests pass.

### T3 — browse model and API client

Files: `frontend/src/services/priceBookApi.ts`,
`frontend/src/services/estimateItemPresetsApi.ts`, and a small pure tree/path helper.

Acceptance:

- TypeScript models flat and nested DTOs without breaking old callers.
- Pure helpers build breadcrumbs/path labels, direct children, and `Uncategorized`.
- Duplicate item names remain separate by id/SKU/path.
- No API client or helper writes to document items.

### T4 — owner-approved frontend

Files: `frontend/src/components/estimates/ItemPresetSearchCombobox.tsx` and
`frontend/src/pages/PriceBookPage.tsx`.

Acceptance:

- Picker drills level 1→2→3 and selecting an item invokes the existing callback once.
- Global search/create/recent/group behavior remains available and duplicate names
  show SKU + full category path.
- Settings renders an expandable tree and path-labelled category selects; level-3
  rows cannot add a child.
- Category editor follows the right-panel/floating-field canon; no new hardcoded
  color, separator, decorative card, or center entity modal.
- Item-grid save/dirty/discard and estimate/invoice item/group flows regress green.

### T5 — Workiz XLSX importer

Files: `scripts/import-workiz-price-book.js` plus focused tests.

Acceptance:

- Fixed source workbooks parse without an npm dependency and produce the revalidated
  counts above.
- Default/dry-run makes zero writes and prints a deterministic plan plus all quality
  findings.
- Apply is one company-locked transaction, all-or-nothing, and uses the mapping and
  postconditions above.
- Run two succeeds with no duplicates/no state drift; T-own/T-foreign/T-blast pass.
- A seeded set of six code-`NULL` legacy presets remains byte-identical, including a
  name that collides with a stripped imported name.
- D1 skips exactly one source item and exactly 121 links, persists no negative
  price, and aborts if those established counts or the zero-empty-group invariant
  drift.

### T6 — verification, sabotage, and live import ledger

Acceptance:

- Every command below is run exactly and its exit/count recorded in this document.
- Every named sabotage is broken, observed red for the intended reason, restored
  from a backup (never from Git), and rerun green.
- Owner supplies the production company UUID, approves the dry-run plan, and only
  then authorizes `--apply`. The apply and immediate second apply results are
  recorded; no process/temp artifact remains.

## Named sabotage controls

| Name | Invariant | Deliberate break | Test that must redden |
|---|---|---|---|
| `SAB-PB-ROOT-NULL-UNIQUE` | Active root names are unique despite `parent_id NULL` | Replace the root partial index with only bare `(company_id,parent_id,lower(name))` | `tests/priceBookNestedMigration.db.test.js` named root-NULL test |
| `SAB-PB-SIBLING-REPEAT` | Same child name is allowed under different parents, not under the same parent | Remove `parent_id` from child uniqueness | migration DB test using `Standard` under two appliance nodes |
| `SAB-PB-DEPTH-CYCLE` | No cycle, fourth level, or subtree overflow can commit | Bypass the trigger rejection branch | migration DB tests for direct cycle, fourth level, and reparent overflow |
| `SAB-PB-PARENT-TENANT` | Parent belongs to the same company | Remove company from parent lookup/FK | route + migration `T-foreign` parent tests |
| `SAB-PB-TREE-BLAST` | Tree aggregate contains only the caller company | Remove the category base `company_id` predicate | tree route `T-blast` with identical A/B paths |
| `SAB-PB-RBAC-MATRIX` | Read/write permissions retain the declared role matrix | Remove `VIEW` or `MANAGE` from one new route | route test for each denied permission/role cell |
| `SAB-PB-FLAT-LEGACY-SIX` | Flat API and six legacy presets remain compatible/unchanged | Return nested data from the flat route or let importer match by name | flat contract test and import legacy snapshot test |
| `SAB-PB-SKU-IDEMPOTENT` | Duplicate transformed names coexist and rerun does not duplicate | Restore active-name uniqueness or match item by name instead of scoped SKU | migration duplicate-name test + importer second-run snapshot test |
| `SAB-PB-IMPORT-BLAST` | Import natural keys are company-paired | remove `company_id` from one SKU/group/category lookup | importer A/B same-key byte-snapshot test |
| `SAB-PB-NO-SILENT-LOSS` | Unsupported nonempty cost/part amount and invalid price abort | skip the preflight checks | importer fixture tests with item cost, part cost/price, and `-95` |
| `SAB-PB-PICKER-PATH` | Drill-down/path disambiguates repeated names and retains uncategorized items | flatten by name or omit path/uncategorized branch | frontend pure-model test and picker source/markup contract test |

## MANDATORY Verification

This is the durable acceptance ledger. Exact live commands, suite/test counts, exit
statuses, import summaries, and sabotage break→red→restore evidence are recorded
below. A command absent here was not run. All commands ran from the worktree root
unless a different cwd is stated.

### Automated commands and live results

| Gate | Exact command | Live result |
|---|---|---|
| Final backend + RBAC + owner sources + real PG | `env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --config ./package.json --runInBand --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/priceBook.test.js tests/priceBookBulk.test.js tests/priceBookBulkQueries.test.js tests/estimateItemPresetsRbac.test.js tests/estimateItemPresetsNested.test.js tests/priceBookNested.test.js tests/priceBookNestedQueries.test.js tests/priceBookNestedRoutes.test.js tests/workizPriceBookImport.test.js tests/priceBookNestedMigration.db.test.js tests/workizPriceBookImport.db.test.js` | exit 0; **11 suites, 72 tests passed**. Real PostgreSQL tests ran (not skipped). |
| Owner-workbook assertions after final preflight tightening | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- --runInBand --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/workizPriceBookImport.test.js` | exit 0; **1 suite, 7 tests passed**; includes full no-write plan. |
| Frontend focused (cwd `frontend`) | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- src/components/estimates/priceBookBrowseModel.test.ts src/components/estimates/ItemPresetSearchCombobox.test.tsx` | exit 0; **2 files, 4 tests passed**. |
| Full frontend Vitest (cwd `frontend`) | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test` | exit 0; **46 files, 259 tests passed**. |
| Frontend production build (cwd `frontend`) | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm run build` | exit 0; tsc + Vite, **3,534 modules transformed**; only existing chunk-size/dynamic-import warnings. |
| JS syntax 1 | `node --check backend/src/db/priceBookQueries.js` | exit 0. |
| JS syntax 2 | `node --check backend/src/db/estimateItemPresetsQueries.js` | exit 0. |
| JS syntax 3 | `node --check backend/src/services/priceBookService.js` | exit 0. |
| JS syntax 4 | `node --check backend/src/services/estimateItemPresetsService.js` | exit 0. |
| JS syntax 5 | `node --check backend/src/routes/price-book.js` | exit 0. |
| JS syntax 6 | `node --check scripts/import-workiz-price-book.js` | exit 0. |
| Patch whitespace | `git diff --check` | exit 0. |
| Final remote collision check | `git ls-remote origin refs/heads/master` plus temporary shallow-clone migration listing | remote `328d7769816660dea03d928e690af442744442eb`; max migration 192; **193 remains free**; clone removed. |

### Source plan and production commands

Replace `<OWNER_COMPANY_UUID>` only after the owner identifies the target company.

```bash
env -u NODE_USE_SYSTEM_CA node scripts/import-workiz-price-book.js \
  --dry-run \
  --company-id=<OWNER_COMPANY_UUID> \
  --items=/Users/rgareev91/Downloads/workiz_items_v8_SKU_category_prefix_PLUS_missing_items.xlsx \
  --groups=/Users/rgareev91/Downloads/workiz_groups_v8_category_prefix_PARTS_filled_STRICT.xlsx
```

The no-write owner-file test invoked the real `run(--dry-run)` path with a recording
DB client. It executed only `BEGIN`, company-scoped `SELECT`s, and `ROLLBACK`, and
asserted that no `INSERT`/`UPDATE`/`DELETE`/DDL occurred. The emitted full plan held
45 categories (9/6/30), 393 items, 121 groups, 275 links, one skipped source row,
exactly 121 dropped links, and 0 empty groups. Source validation also reconfirmed
394/121/396, Service 305/Product 89 before the skip, every Cost/part amount empty,
all Taxability 0, and all established category counts.

After owner approval of that dry run only:

```bash
env -u NODE_USE_SYSTEM_CA node scripts/import-workiz-price-book.js \
  --apply \
  --company-id=<OWNER_COMPANY_UUID> \
  --items=/Users/rgareev91/Downloads/workiz_items_v8_SKU_category_prefix_PLUS_missing_items.xlsx \
  --groups=/Users/rgareev91/Downloads/workiz_groups_v8_category_prefix_PARTS_filled_STRICT.xlsx
```

Then run the exact same `--apply` command once more. The second result must show zero
creates/updates, no duplicate entities/links, the same canonical snapshot, and the
same six legacy-row hashes.

Production dry-run result: **PENDING — the owner has not supplied/selected the
production company UUID in this implementation session. No production connection or
write was attempted.**  
Live apply result: **PENDING — owner approval and company UUID required.**  
Live second-apply result: **PENDING — first apply not authorized.**

### Sabotage execution protocol and ledger

Before each sabotage, copy every edited uncommitted file to an explicit
`/tmp/PRICEBOOK-NESTED-001.<filename>.backup` path. Apply the smallest deliberate
break, run only the named test with `--testNamePattern` (backend) or `-t` (frontend),
record the exact red output, restore with `cp` from that backup, prove restoration
with `cmp -s`, and rerun the named test green. Never use `git checkout` or reset to
restore sabotage because that would destroy the implementation diff.

For the five migration controls, the exact red and green command was:

`env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- --runInBand --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/priceBookNestedMigration.db.test.js --testNamePattern "SAB-PB migration invariants"`

Each broken run exited 1; each restored run exited 0 (1 passed, 1 skipped because the
focused pattern intentionally excluded the separate concurrency test).

| Sabotage | Break → observed red | Exact red/green test command | Backup restore proof |
|---|---|---|---|
| `SAB-PB-ROOT-NULL-UNIQUE` | Replaced root partial key with bare parent tuple → duplicate root insert resolved instead of rejecting (`expect(...).rejects` red). | Migration command above. | `cp /tmp/PRICEBOOK-NESTED-001.root-null.backup backend/db/migrations/193_price_book_nested_categories.sql`; `cmp -s /tmp/PRICEBOOK-NESTED-001.root-null.backup backend/db/migrations/193_price_book_nested_categories.sql` exit 0; restored test green. |
| `SAB-PB-SIBLING-REPEAT` | Removed `parent_id` from child unique key → second `Standard` under another appliance hit 23505. | Migration command above. | `cp /tmp/PRICEBOOK-NESTED-001.sibling-repeat.backup backend/db/migrations/193_price_book_nested_categories.sql`; matching `cmp -s` exit 0; green. |
| `SAB-PB-DEPTH-CYCLE` | Changed max-depth threshold 3→300 → fourth-level insert resolved instead of rejecting. | Migration command above. | `cp /tmp/PRICEBOOK-NESTED-001.depth-cycle.backup backend/db/migrations/193_price_book_nested_categories.sql`; matching `cmp -s` exit 0; green. |
| `SAB-PB-PARENT-TENANT` | Replaced composite parent FK with id-only FK → company B accepted company A’s parent. | Migration command above. | `cp /tmp/PRICEBOOK-NESTED-001.parent-tenant.backup backend/db/migrations/193_price_book_nested_categories.sql`; matching `cmp -s` exit 0; green. |
| `SAB-PB-TREE-BLAST` | Replaced category `WHERE company_id=$1` with `WHERE TRUE` → scope assertion showed unscoped SQL. | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- --runInBand --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/priceBookNestedQueries.test.js --testNamePattern "SAB-PB-TREE-BLAST"` → red 1/green 1. | `cp /tmp/PRICEBOOK-NESTED-001.tree-blast.backup backend/src/db/priceBookQueries.js`; matching `cmp -s` exit 0. |
| `SAB-PB-RBAC-MATRIX` | Removed `VIEW` from tree route → no-permission request returned 200 instead of 403. | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- --runInBand --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/priceBookNestedRoutes.test.js --testNamePattern "R-matrix missing view permission denies get /api/price-book/categories/tree"` → red 1/green 1. | `cp /tmp/PRICEBOOK-NESTED-001.rbac.backup backend/src/routes/price-book.js`; matching `cmp -s` exit 0. |
| `SAB-PB-FLAT-LEGACY-SIX` | Flat route called tree service → old response contract became `{}` in the isolated test. | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- --runInBand --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/priceBookNestedRoutes.test.js --testNamePattern "SAB-PB-FLAT-LEGACY"` → red 1/green 1. | `cp /tmp/PRICEBOOK-NESTED-001.flat-legacy.backup backend/src/routes/price-book.js`; matching `cmp -s` exit 0. Real-PG importer test separately kept all six legacy rows byte-identical. |
| `SAB-PB-SKU-IDEMPOTENT` | Restored name-based uniqueness under the code-index name → two legitimate `Repeated name` rows hit 23505. | Migration command above. | `cp /tmp/PRICEBOOK-NESTED-001.sku-idempotent.backup backend/db/migrations/193_price_book_nested_categories.sql`; matching `cmp -s` exit 0; green. |
| `SAB-PB-IMPORT-BLAST` | Removed `company_id` from item-SKU lookup → A matched B’s same SKU and reported update instead of create. | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- --runInBand --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/workizPriceBookImport.db.test.js --testNamePattern "IMPORT-BLAST"` → red 1/green 1. | `cp /tmp/PRICEBOOK-NESTED-001.import-blast.backup scripts/import-workiz-price-book.js`; matching `cmp -s` exit 0. |
| `SAB-PB-NO-SILENT-LOSS` | Bypassed item Cost guard → Cost=5 fixture no longer threw. | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- --runInBand --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/workizPriceBookImport.test.js --testNamePattern "SAB-PB-NO-SILENT-LOSS"` → red 1/green 1. | `cp /tmp/PRICEBOOK-NESTED-001.no-silent-loss.backup scripts/import-workiz-price-book.js`; matching `cmp -s` exit 0. |
| `SAB-PB-PICKER-PATH` | Collapsed full path to leaf only → received `Standard` instead of the two distinct appliance paths. | `(cwd frontend) env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- src/components/estimates/priceBookBrowseModel.test.ts -t "SAB-PB-PICKER-PATH"` → red 1/green 1. | `cp /tmp/PRICEBOOK-NESTED-001.picker-path.backup frontend/src/components/estimates/priceBookBrowseModel.ts`; matching `cmp -s` exit 0. |

All `/tmp/PRICEBOOK-NESTED-001.*.backup` files were removed after this ledger was
written. No watcher, browser, dev server, or background process was started.

## Risks and pushback

1. I still disagree with presenting the imported group totals as source-equivalent:
   the accepted D1 skip intentionally raises each group by $95. The implementation
   follows the owner’s decision, reports the discrepancy, and records the manual
   dispatcher deduction so nobody later re-adds an unsupported negative line.
2. Required prefix stripping creates duplicate names despite the source’s unique full
   names. Keeping migration 085’s name index is incompatible with the brief; scoped
   SKU uniqueness is required.
3. A true rollback after nested import cannot both flatten repeated child names and
   preserve data. A guarded refusal is safer than hidden rename/archive/delete.
4. The importer intentionally bypasses HTTP RBAC as an operator CLI. Its safety rests
   on explicit company scope, an all-or-nothing transaction, same-company natural
   keys, dry-run review, and the live T-blast/postcondition ledger.
5. CSV rows with Code now match by scoped code; code-less legacy CSV rows and manual
   create retain their historic name-dedupe fallback. With repeated imported names,
   operators should use Code and the picker’s full path when identity matters.

## Open questions / next gate

No conceptual decision remains. The only next gate is operational: run the printed
`--dry-run` against the owner-selected production company after migration 193 is
deployed, show its complete plan to the owner, and do not run `--apply` without the
owner’s explicit post-dry-run authorization.

## Production deploy + import record — 2026-07-20

Deployed master `d311522`; migrations **191, 192, 193** applied in order (190 was
already on prod — probe by object, never by number: this deploy found 191/192
pending from a parallel session, not just this feature's 193).

Import ran inside the app container against company
`00000000-0000-0000-0000-000000000001`. The dry run matched the pre-computed plan
exactly, so it was applied without re-litigating the numbers:

| | planned | applied | verified in DB |
|---|---|---|---|
| categories | 45 | 45 | 45 (9 root / 6 level-2 / 30 level-3) |
| items | 393 | 393 | 393 with a code, plus the 6 legacy presets untouched |
| groups | 121 | 121 | 121 |
| group→item links | 275 | 275 | 275 |
| dropped links (skipped credit row) | 121 | 121 | — |
| groups left empty | 0 | 0 | — |
| negative prices in the table | 0 | 0 | 0 |

Sample of the resulting tree: `8 Education / Dishwasher / Commercial`.

A bug found only at deploy time: the importer's `--company-id` validator demanded
RFC-4122 version/variant nibbles, so this deployment's seeded company id was
rejected outright — the script refused before opening a connection. The test
suite had hidden it by using a synthetic v4-shaped id, i.e. a fixture shaped to
satisfy the validator instead of matching production. Fixed in `d03e06a` with a
regression test that pins the real seeded form.
