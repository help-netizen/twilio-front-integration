# ADDR-UX-001 — Base-address entry UX fix (Company + technician base)

Status: PLANNED (orchestrate, 2026-06-27). Owner-reported prod UX bug.

## Problem
The base-address editors (`CompanyBaseAddress.tsx`; per-tech base in `TechnicianPhotosPage.tsx`)
**misuse** the otherwise-correct controlled `AddressAutocomplete`:
1. **Auto-save on select** — `CompanyBaseAddress` wires `onChange={save}` and `save` commits as soon as
   coords arrive (i.e. the instant you pick a Google suggestion) → no chance to add an apt/unit or correct.
2. **Broken edit** — it passes a constant `value={EMPTY_ADDRESS}`, so the edit form is always empty; the
   saved address shows as a string above with empty structured fields below. Storage
   (`technician_base_locations`, mig 125) keeps only a composed **string + lat/lng**, no structured fields.

(The lead/job/contact forms use `AddressAutocomplete` correctly — out of scope.)

## Decisions (owner interview)
- D1: **Explicit Save** (no auto-save on suggestion select). User can add apt/unit before saving.
- D2: **Edit pre-fills** all fields from the stored structured address.
- D3: **Manual entry allowed** → backend **geocodes on Save**; if no coordinates found → clear error, no save.
- D4: **Scope = base-address editors only** (`CompanyBaseAddress` + per-tech base in `TechnicianPhotosPage`).
  Leave the working lead/job/contact `AddressAutocomplete` usages untouched.
- D5: **Store structured fields** (street/apt/city/state/zip) in `technician_base_locations` (additive
  migration); keep `lat/lng/address/label` for the slot-engine + compatibility.

## UX (designed)
- **Not set** → "Set address" button.
- **Set** → one-line formatted address + **Edit** (and **Clear**).
- **Edit/Set** → expanded form: street autocomplete + **Apt/Unit** + City + State + ZIP (controlled by a
  parent-held `draft: AddressFields`; NO auto-save), with **Save** + **Cancel**. Helper: "Pick a suggestion
  or type the address — we'll find the coordinates on save." On geocode-fail → error toast, stay in edit.
- Google pick populates all fields (incl. lat/lng/place_id); user can then add the apt before Save.

## Tasks
| ID | Area | Files | Notes |
|----|------|-------|-------|
| T1 | BE | migration 135 (technician_base_locations + street/apt/city/state/zip), `technicianBaseLocationsService`, `...Queries`, route `technicianBaseLocations.js` | persist structured fields; geocode-on-save when lat/lng missing → 422 if unresolved |
| T2 | FE | `components/settings/CompanyBaseAddress.tsx` | parent-held draft, controlled AddressAutocomplete, explicit Save/Cancel, Edit pre-fill from structured fields (fallback: parse string for pre-migration rows), Clear |
| T3 | FE | `pages/TechnicianPhotosPage.tsx` (per-tech base editor) | same pattern as T2 |
| T4 | FE | `services/technicianBaseLocationsApi.ts` | add street/apt/city/state/zip to type + upsert body |
| T5 | tests | tests/* | upsert structured + geocode-on-save + 422; tenant scope; frontend build |
| T6 | deploy | — | migration 135 + app rebuild + logout-all (FE changed) |
