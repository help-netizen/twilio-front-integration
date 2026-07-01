# PRICEBOOK-002 — Items grid (inline spreadsheet editing)

**Status:** Implemented (verified local; pending deploy) · **Area:** Settings → Price Book / Items tab · **Evolves:** PRICEBOOK-001 (Items tab)

## Goal
Edit the whole Items catalog as a spreadsheet: every field inline, a trailing "+" adds a blank row,
one **Save changes** button commits the entire sheet atomically. No per-item slide-over on this tab.

## API contract

### `PUT /api/price-book/items/bulk`  (gate: `price_book.manage`, company-scoped)
Request:
```jsonc
{
  "creates": [ { "clientKey": "tmp-1", "name": "Labor", "description": "On-site", "code": "1010",
                 "unit": "hr", "default_unit_price": 95, "default_taxable": false, "category_id": 7 } ],
  "updates": [ { "id": 42, "name": "Part", "description": null, "code": "2010",
                 "unit": "ea", "default_unit_price": 140, "default_taxable": true, "category_id": 7 } ],
  "deletes": [ 55, 56 ]
}
```
Response `200`:
```jsonc
{ "items": [ /* full listForManage snapshot, same shape as GET /items */ ],
  "summary": { "created": 1, "updated": 1, "deleted": 2 },
  "createdMap": [ { "clientKey": "tmp-1", "id": 128 } ] }
```
Error `422` (validation) / `404` (foreign id):
```jsonc
{ "error": "validation_failed", "message": "…",
  "details": [ { "scope": "creates"|"updates", "index": 0, "field": "name", "error": "Name is required" } ] }
```

## Behavior scenarios
1. **Edit existing rows** → `updates[]` carry `id` + only the 7 editable fields; other columns
   (`default_quantity`, `usage_count`, `last_used_at`, `created_by`) are preserved.
2. **Add rows** → non-empty `new` rows become `creates[]`; server inserts directly via `insertPreset`
   (no name-dedup — duplicates allowed). `createdMap` maps `clientKey`→new `id`.
3. **Delete rows** → server rows marked `deleted` become `deletes[]`; soft-delete via `archived_at`.
   New rows marked deleted are dropped client-side (never sent).
4. **Empty trailing rows** → fully-empty `new` rows are discarded (client and server), never validated.
5. **Save = one transaction** → BEGIN → creates → updates → deletes → COMMIT. Any failure → ROLLBACK,
   nothing written, structured error returned.
6. **Client-side search** filters loaded rows only; editing a hidden row keeps its draft.
7. **Discard** reverts the grid to the last server snapshot.
8. **Unsaved-changes guard** on tab switch + `beforeunload` while dirty.

## Validation (whole-batch, before COMMIT)
- `name`: required & non-empty on every non-deleted row; ≤ 200 chars.
- `default_unit_price`: finite number ≥ 0 (blank → 0).
- `description` ≤ 4000 chars.
- `category_id`: `null`/blank OR a category id owned by the company (foreign → error, not silently nulled).
- `updates[].id` / `deletes[]`: must belong to the company (foreign → 404 reject). Already-archived
  delete = idempotent skip (not counted, not an error).

## Edge cases
- Empty payload / all-empty rows → `200` with `summary {0,0,0}`, `items` unchanged.
- Duplicate names in the same save → allowed (no unique constraint).
- Concurrent saves → last-write-wins (no version column).
- Soft-deleted items disappear from the estimate/invoice inline picker and group expansion
  (both filter `archived_at IS NULL`); group membership rows survive (soft-delete).

## Non-goals
No hard delete, no inline category creation, no per-cell autosave, no optimistic-lock/versioning,
no `default_quantity` column, no mobile-specific panel fallback (grid + horizontal scroll everywhere).

## Files
- Backend: `estimateItemPresetsService.bulkSaveItems`, `estimateItemPresetsQueries.bulkSaveItems`
  (+ `listForManage` cap 200→1000), `routes/price-book.js` (`PUT /items/bulk`).
- Frontend: `PriceBookPage.tsx` (`ItemsTab` grid; `ItemPanel` removed from Items flow; controlled Tabs +
  guard), `priceBookApi.ts` (`bulkSaveItems`).
- Tests: `tests/priceBookBulk.test.js`.
