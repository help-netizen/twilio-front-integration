# PRICEBOOK-002 — Test Cases

Legend: P0 = must-pass/blocking, P1 = important, P2 = nice. Types: U=unit(jest), I=integration, E=e2e/manual.

## Backend — `bulkSaveItems` service (jest, queries mocked)
- **TC-PB2-001 (P0, U)** creates+updates+deletes in one call → queries called with partitioned rows;
  returns `{items, summary:{created,updated,deleted}, createdMap}`; `createdMap` maps clientKey→id.
- **TC-PB2-002 (P0, U)** fully-empty new row (no name/code/desc/unit, price blank/0, no category) is
  **discarded** — not validated, not inserted; doesn't block an otherwise-valid save.
- **TC-PB2-003 (P0, U)** a `new`/`update` row with empty name → `422 validation_failed` with
  `details[{scope,index,field:'name'}]`; **no** query mutation happens (rejected before txn / rolled back).
- **TC-PB2-004 (P0, U)** `default_unit_price` non-numeric/negative → validation error; blank price coerces to 0.
- **TC-PB2-005 (P0, U)** `category_id` not owned by company → validation/`404` error, not silently nulled.
- **TC-PB2-006 (P0, U)** `updates[].id` foreign (updatePresetScoped→null) → whole request rejected (ROLLBACK),
  nothing committed.
- **TC-PB2-007 (P1, U)** `deletes[]` already-archived (archivePresetScoped→null) → idempotent skip, not counted,
  not an error; valid siblings still commit.
- **TC-PB2-008 (P1, U)** update payload carries only the 7 grid fields → helper does NOT pass through
  `default_quantity`/`usage_count`/`created_by` (no clobber).
- **TC-PB2-009 (P1, U)** empty payload `{creates:[],updates:[],deletes:[]}` → `200`, summary `{0,0,0}`.
- **TC-PB2-010 (P1, U)** duplicate names in one batch → both inserted (no dedup, no error).

## Backend — route / security
- **TC-PB2-011 (P0, I)** `PUT /items/bulk` without `price_book.manage` → `403`.
- **TC-PB2-012 (P0, I)** unauthenticated → `401`.
- **TC-PB2-013 (P0, I)** company scoping: an item id from another company in `updates`/`deletes` cannot be
  mutated (foreign → reject / 404); no cross-company write.
- **TC-PB2-014 (P1, U)** `listForManage` honors a high limit (cap raised to 1000) — returns >50 rows.

## Frontend — grid (manual/E2E on local stack)
- **TC-PB2-020 (P0, E)** Items tab renders an editable grid (all 7 columns), no per-item slide-over opens on row click.
- **TC-PB2-021 (P0, E)** edit a cell → row marked dirty, **Save changes** enables; **Discard** reverts.
- **TC-PB2-022 (P0, E)** "+" appends a blank row; typing a name makes it savable; empty "+" row is ignored on save.
- **TC-PB2-023 (P0, E)** trash marks a row struck-through (undo restores); Save archives it; grid re-hydrates.
- **TC-PB2-024 (P0, E)** one Save persists create+edit+delete together; success toast shows counts; DB reflects all.
- **TC-PB2-025 (P1, E)** client-side Search filters visible rows; an edit to a filtered-out row survives.
- **TC-PB2-026 (P1, E)** unsaved-changes guard fires on tab switch + navigation while dirty.
- **TC-PB2-027 (P1, E)** validation error from server highlights the offending cell + toast; nothing saved.
- **TC-PB2-028 (P1, E)** design conformance: Blanc tokens, IBM Plex/Manrope, no decorative `<hr>`; horizontal
  scroll on a narrow viewport.
- **TC-PB2-029 (P2, E)** archived item disappears from the estimate/invoice inline item picker.
