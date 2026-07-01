# PRICEBOOK-001 — Price Book (Category → Group → Item)

**Status:** Implemented (pending deploy) · **Area:** Estimates/Invoices catalog · Settings
**Evolves:** the flat `estimate_item_presets` catalog (085).

## Model
- **Item** = `estimate_item_presets` (extended with `category_id`, `code`/SKU, `unit`). Can be added
  standalone or as part of a group. Existing preset data preserved.
- **Category** (`price_book_categories`) — top-level grouping ONLY; never added to a document.
  Both Items and Groups may reference a category (`ON DELETE SET NULL`).
- **Group** (`price_book_groups`) — a named set of Items with a per-item quantity
  (`price_book_group_items`, M2M, `quantity` + `sort_order` on the link, unique `(group_id,item_id)`).
  Selecting a group in an estimate/invoice inserts ALL its (active) items as line items; the group
  itself is NOT stored on the document.

## API (`/api/price-book`, gated: reads `price_book.view`, writes `price_book.manage`, company-scoped)
- Categories: `GET/POST /categories`, `PATCH/DELETE /categories/:id`
- Groups: `GET /groups` (with `item_count` + computed `total`), `GET /groups/:id` (with items),
  `GET /groups/:id/expand` (line-item-shaped, for adding to a doc), `POST /groups`,
  `PATCH /groups/:id` (items[] present ⇒ replace membership; absent ⇒ leave), `DELETE /groups/:id`
- Items: `GET /items` (paginated, category filter, archived toggle, category name joined),
  `POST/PATCH/DELETE /items/:id` (delegate to `estimateItemPresetsService`)
- Bulk add: `POST /api/estimates|invoices/:id/items/bulk` (`estimates.create`/`invoices.create`) —
  one status-reset + ONE recalc + ONE `items_added` event.
- Import/Export: `GET /template` + `GET /export` (`price_book.view`, CSV download),
  `POST /import` (`price_book.manage`, body `{csv}`) → summary `{items_created/updated, categories_created, groups_created, memberships, errors[]}`.

## Import / Export (CSV)
Columns: `Name, Description, Code, Unit, Unit Price, Taxable, Category, Group, Group Quantity`
(header order is flexible — matched by name). **Import** upserts each item by name (import is source
of truth → updates existing), **find-or-creates** the named Category and Group (cached per file), and
adds the item to the group with `Group Quantity` (default 1). To put an item in multiple groups or
build a group, list it on multiple rows (dedup by name). Partial success: bad rows are skipped and
reported in `errors[]`. **Export** emits one row per (item, active membership); standalone items get
one row with a blank Group — round-trips cleanly. Downloads via `authedFetch`→Blob; import reads the
file client-side and POSTs `{csv}`. Minimal hand-rolled CSV parse/build (no library). UI = the
Import/Export right-side layer (Import buttons at the top → panel with drop-zone + template link + Export).

## Semantics / edge cases (resolved gaps)
- **G1** migration = **141** (140 taken by ONBOARD-FIX). No renumber collision.
- **G2** group expansion uses the **bulk** endpoint (atomic-ish, one recalc), not N client round-trips.
- **G4/G5** group expansion returns only **active** items (`archived_at IS NULL`), in `sort_order`,
  snapshotting name/desc/unit/price/taxable + the group quantity. Archiving a category/group/item just
  hides it from pickers (SET NULL / soft-delete).
- **G6** group `total` = Σ(item.default_unit_price × link.quantity) over active items (display-only).
- **G7** perms registered in `permissionCatalog.js` + seeded (050 for new companies, 141 backfill for
  existing): view→all doc-editing roles, manage→tenant_admin+manager.
- **G8** item gains `code` (SKU) + `unit` + `category_id` (no cost/brand/images — out of scope).

## UI
- **Settings → Price Book** (`/settings/price-book`, gated `price_book.manage`) — tabs
  Items & products / Item groups / Item categories, each with list + search + create/edit dialog +
  archive. Group editor picks items + per-item qty.
- **Picker integration:** `ItemPresetSearchCombobox` gains an optional Groups section (`onPickGroup`);
  Estimate/Invoice panels expand the picked group into its items via the bulk endpoint.

## Verification
- Backend end-to-end on the local stack (category→items→group; group total=355; expansion shape;
  management list category join). `tests/priceBook.test.js` (7). Migration 141 applied+validated on
  the local DB. Frontend `tsc -b` green; Price Book page rendered live with data.

## Non-goals
No read/unread, no cost/margin/brand/images, no package-bundle group pricing (group only expands),
snapshot semantics (editing the catalog doesn't change past documents).

## Files
- `backend/db/migrations/141_create_price_book.sql`, `050_seed_role_configs.sql`, `services/permissionCatalog.js`
- `backend/src/db/priceBookQueries.js`, `estimateItemPresetsQueries.js`
- `backend/src/services/priceBookService.js`, `estimateItemPresetsService.js`, `estimatesService.js`, `invoicesService.js`
- `backend/src/routes/price-book.js`, `estimates.js`, `invoices.js`; `src/server.js`
- `frontend/src/services/priceBookApi.ts`, `estimatesApi.ts`, `invoicesApi.ts`
- `frontend/src/pages/PriceBookPage.tsx`; `components/layout/appLayoutNavigation.tsx`; `App.tsx`; `auth/AuthProvider.tsx`
- `frontend/src/components/estimates/ItemPresetSearchCombobox.tsx`, `EstimateDetailPanel.tsx`, `invoices/InvoiceDetailPanel.tsx`
- `tests/priceBook.test.js`
