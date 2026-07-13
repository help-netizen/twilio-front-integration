# RELY-LEADS-SETTINGS-001 — Behavior Spec (Rely Leads settings + ingest acceptance filter with rejected-lead marker)

**Status:** Spec · **Priority:** P2 · **Full-stack (2 API routes + filter service + createLead opts + FE panel/chip/filter) · NO migration** · **Date:** 2026-07-13
**Requirements:** `Docs/requirements.md` «RELY-LEADS-SETTINGS-001» (US-1..6, FR-1..11, NFR-1..8; [OWNER]/[PRODUCT] binding) · **Architecture:** `Docs/architecture.md` «RELY-LEADS-SETTINGS-001 — architecture» (A1-A4, D1-D9, authoritative)
**Builds on:** MARKETPLACE-LEADGEN-SPLIT-001 (mig 169, `rely-leads` app + seeded default-co installation), SERVICE-TERR-002 (`territoryService.isZipInTerritory` containment seam), APP-MKT-001 (083 installations model). Code refs verified in this worktree 2026-07-13.

## 1. Overview

The connected **Rely Leads** marketplace tile gets a **Settings** slide-over (FORM-CANON) with three AND-combined acceptance filters: **zone** (company territory via SERVICE-TERR-002 or a custom ZIP list), **unit types** (12-entry catalog), **brands** (15-entry catalog). A Rely lead (`POST /api/v1/integrations/leads`, `JobSource='Rely'`) that fails a filter is **still created** (normal path, status `Submitted`, FSM-valid) but carries a server-written marker `leads.metadata.rely_filter = {rejected:true, reason, …}` — shown as a Rejected chip in the Leads UI, excluded from the new-leads nav badge, filterable client-side. Non-Rely ingestion is byte-identical; every internal failure fails OPEN (lead accepted exactly as today). Settings live in `marketplace_installations.metadata.settings` (top-level `||` merge — seeded keys survive), served by new `GET/PUT /api/marketplace/apps/:appKey/settings` whitelisted to `rely-leads`. No schema change anywhere.

Do-not-restate here (see architecture): full file list, jest mock tables, D5 code block. This spec defines *behavior* — exact contracts, scenario matrix, pinned edge semantics.

---

## 2. Pinned semantics (resolved edges — binding for TestCases/Planner/Implementer)

These were ambiguous or under-specified upstream; the resolutions below are code-verified and final for v1.

**P-1. Token matcher (FR-5).** `norm(s) = s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()`; catalog entry `E` matches raw value `R` iff `` ` ${norm(R)} ` `` contains `` ` ${norm(E)} ` `` (space-padded token-sequence containment). Consequences, all deliberate:
- `Issue: Dishwasher - not draining` → **Dishwasher** (matches).
- `Brand: GE Profile` → **GE**; `Brand: ridge` → no match for GE (`' ridge '` does not contain `' ge '` — word-boundary safe); **`Brand: General Electric` does NOT match GE** → unrecognized → treated as MISSING → brand filter passes (fail-open). v1 has no alias table; the safe direction is accept.
- `Sub-Zero` (norm `sub zero`) matches `sub-zero`, `sub zero`, `SUB ZERO`; **does NOT match `SubZero`** (norm `subzero`, single token) → unrecognized → pass. Same for `SpeedQueen` vs `Speed Queen`.
- **Catalog array order = matcher precedence** (first entry that matches wins, deterministic): `Issue: Microwave oven` → **Oven** (Oven precedes Microwave in the catalog); `Issue: Refrigerator ice maker` → **Refrigerator** (precedes Ice Maker); `Issue: Washer and Dryer` → **Washer** (multi-appliance → single first match; may reject when only the second appliance is serviced — owner-approved v1, architecture risk 4).

**P-2. Parser (FR-5).** Line-by-line scan of `payload.Description`: unit = capture of the FIRST line matching `/^\s*issue\s*:\s*(.+)$/i`, brand = FIRST `/^\s*brand\s*:\s*(.+)$/i`, trimmed. **`Issue 2: Dryer` never matches** (the digit breaks the pattern) — secondary units are out of scope v1. No `Description` / no matching line ⇒ value missing ⇒ that filter passes when active.

**P-3. Geocode soft-failure is a decision, not an internal error.** `territoryGeoService.geocodeZip` **never throws** (verified — its entire body is inside try/catch; transport errors, missing `GOOGLE_GEOCODING_KEY`, and non-OK Google statuses all return `null`). `isZipInTerritory` maps `geo=null` to `{inside:false, mode:'radius'}`. Therefore in **radius mode with radii present**, a Google outage on a never-cached ZIP yields **REJECT `out_of_area`** (via the activity guard path), NOT a fail-open accept. This supersedes the architecture's shorthand "a transport failure fail-opens": the fail-open guarantee (FR-6 internal-error row) covers **thrown exceptions only** (DB down, query errors). Bounded and self-healing: `zip_geocache` is checked first, failures are intentionally not cached, and Rely volume ≈ 0.6/day. The seam is reuse-as-is (protected) — do NOT modify it to distinguish these cases.

**P-4. Zone activity is resolved lazily (cheap-accept-first, D4 step 3).** Company mode with a present ZIP calls `isZipInTerritory` FIRST; `inside:true` ⇒ pass with **no activity queries** (containment implies data exists). Only `inside:false` OR missing ZIP triggers the activity guard (`territoryRadiusQueries.getSettings` → `countListZips` in list mode / `listRadii().length` in radius mode): **no territory data ⇒ zone filter INACTIVE ⇒ pass** ([PRODUCT] guard — a territory-less company never rejects on day one); data present ⇒ reject `out_of_area`.

**P-5. Missing ZIP under an ACTIVE zone filter ⇒ reject `out_of_area`** [OWNER]. Custom mode: `custom_zips` non-empty + `normalizeZip(payload.PostalCode)` empty ⇒ reject (0 queries). Company mode: missing ZIP ⇒ activity guard decides (data ⇒ reject; none ⇒ pass, filter inactive).

**P-6. `mode:'custom'` with an empty `custom_zips` is VALID** (PUT accepts it) and means the zone filter is simply inactive (FR-6 activity) — it is not an error state.

**P-7. Settings self-heal at read.** `resolveRelySettings(metadata)` deep-defaults per key (absent/malformed `settings` ⇒ full defaults; unknown `zone.mode` ⇒ `'company'`; non-array lists ⇒ `[]`) and **drops values no longer present in the current catalogs** — a catalog shrink (code change) requires no data migration.

**P-8. Settings API requires `status === 'connected'`.** `marketplaceQueries.findActiveInstallation` returns rows with status IN `('connected','provisioning_failed')` (verified) — the service must additionally reject `provisioning_failed` with 404 `APP_NOT_INSTALLED`. Consistent with NFR-8 (no *connected* installation ⇒ filter inactive) and the FE gate (button only on `connected`).

**P-9. The reserved-key strip is global and permanent.** `RESERVED_METADATA_KEYS = ['rely_filter']` is deleted from external metadata inside `extractCustomMetadata` — the seam used by BOTH `createLead` and `updateLead` for EVERY caller (integrations, UI, Yelp, VAPI). Consequence: no caller, internal UI included, can set, overwrite, or clear the marker (clearing was already impossible — `updateLead` merges `{...existing, ...meta}` and merge never deletes). "Un-reject" is a non-goal v1. No `lead_custom_fields.api_name='rely_filter'` exists today (grep-verified).

**P-10. Marker rides the SAME INSERT** (`createLead` third options arg `{systemMetadata}` merged AFTER `extractCustomMetadata`, server value wins). Decisive: `emitLeadChange('lead.created')` fires immediately after INSERT and the client refetches `/new-count`; a post-create UPDATE would open a badge-miscount window that nothing re-closes (no SSE fires on metadata UPDATE).

**P-11. Exactly ONE `[RelyLeadFilter]` log line per *evaluated* Rely lead** — accepts included, emitted AFTER `createLead` returns (so uuid/serial exist). Non-Rely payloads: zero lines, zero queries (`isRelyLead` is a pure string check).

**P-12. `isRelyLead` discriminator:** `String(payload?.JobSource ?? '').trim().toLowerCase() === 'rely'`. `' RELY '` ⇒ true; `'RelyX'`, `'rely leads'`, absent ⇒ false (non-Rely path).

**P-13. NFR-5 deviation (recorded per orchestrator acceptance).** Honest per-Rely-lead query counts: custom zone = 1; company zone **list** accept = 3 (settings read + seam's internal `getSettings` + `search`), list reject/zero-data ≤ 5 (adds the activity-guard pair; one `getSettings` is a knowing duplicate of the seam's internal read — the seam is reused as-is, never bypassed); company zone **radius** accept = 4 (settings + seam `getSettings` + geocache read + `listRadii`), radius reject = 6, geocode-null reject = 5 (seam returns before `listRadii` when geo is null). Band = **1-6**, above NFR-5's literal "≤1-2"; **ACCEPTED by orchestrator** — all PK/index lookups, guard pair only on the non-inside path, Rely ≈ 57/90 days ≈ 0.6/day.

**P-14. `getConnectedRelySettings` deliberately skips `ensureMarketplaceSchema`/`reconcileRevokedInstallations`** (documented deviation from the marketplaceQueries convention): the hot ingest path must not pay schema-ensure cost; a missing table on a fresh DB throws ⇒ fail-open accept ≡ NFR-8 semantics.

---

## 3. Catalogs (verbatim, owner-binding — FR-3)

Single source: `backend/src/services/relyLeadsCatalog.js` (frozen arrays). The FE has **no mirror** — the settings GET response carries `catalogs` and the dialog renders from it (A3). Stored settings values are the EXACT catalog strings; array order = display order = matcher precedence.

**`RELY_UNIT_TYPES` (12):** Washer · Dryer · Refrigerator · Freezer · Dishwasher · Range · Oven · Cooktop · Microwave · Ice Maker · Garbage Disposal · Vent Hood

**`RELY_BRANDS` (15):** Whirlpool · GE · Samsung · LG · Maytag · Kenmore · KitchenAid · Frigidaire · Bosch · Electrolux · Amana · Sub-Zero · Viking · Thermador · Speed Queen

---

## 4. API contracts

### 4.1 `GET /api/marketplace/apps/:appKey/settings`

- **Mount chain (inherited, `src/server.js:268` — file untouched):** `authenticate` → `requirePermission('tenant.integrations.manage')` → `requireCompanyAccess` → router. Company = `req.companyFilter?.company_id` via the existing `companyId(req)` helper (marketplace.js:5) — **never** from params/body/query.
- Auth: authedFetch (Bearer) — same as every marketplace call.
- **Resolution order (both verbs):** ① `appKey ∉ SETTINGS_ENABLED_APP_KEYS` (= `{'rely-leads'}`) → 404 `SETTINGS_NOT_SUPPORTED` · ② `getPublishedAppByKey(appKey)` null → 404 `APP_NOT_FOUND` · ③ `findActiveInstallation(companyId, app.id)` null **or `status !== 'connected'`** (P-8) → 404 `APP_NOT_INSTALLED`.
- **Response 200** (GET and PUT-200 identical shape):

```json
{
  "success": true,
  "app_key": "rely-leads",
  "installation_id": 7,
  "settings": { "zone": { "mode": "company", "custom_zips": [] }, "unit_types": [], "brands": [] },
  "catalogs": { "unit_types": ["Washer", "…12 entries…"], "brands": ["Whirlpool", "…15 entries…"] },
  "territory": { "active_mode": "list", "has_data": true },
  "request_id": "…"
}
```

- `settings` is always **effective** (defaults-applied + self-healed, P-7); `updated_at`/`updated_by` are stored but NOT part of the `settings` echo contract (implementation may include them — clients must not depend on it).
- `territory` = 2 cheap reads (`territoryRadiusQueries.getSettings`; then `countListZips > 0` in list mode / `listRadii().length > 0` in radius mode). Row absent in `company_territory_settings` ⇒ `active_mode:'list'` (query-layer default, verified).

### 4.2 `PUT /api/marketplace/apps/:appKey/settings`

- Same chain + resolution as GET. Request body (canonical):

```json
{
  "zone": { "mode": "custom", "custom_zips": ["02301", "02302", "02043", "02744"] },
  "unit_types": ["Dishwasher", "Washer"],
  "brands": ["Whirlpool", "GE"]
}
```

- **Input tolerance:** `zone.custom_zips` accepts `string[]` OR one free-form string (`"02301, 02302; 02043\n02744"`); `parseZipList` splits on `/[\s,;]+/`, `normalizeZip`s each token (leading-zero recovery: `"2301"` → `"02301"`; ZIP+4 → first 5), requires `/^\d{5}$/` after normalization, dedupes preserving order. `unit_types`/`brands` entries are matched case-insensitively and **canonicalized to the exact catalog string** (`"dishwasher"` → `"Dishwasher"`) before storage. Absent top-level keys default (omitting `brands` ⇒ `[]`). `updated_at` (ISO now) + `updated_by` (`req.user?.crmUser?.id || null` — the crm_users.id, NOT the Keycloak sub) are server-set; client-supplied values ignored.
- **Validation taxonomy (all 400, `MarketplaceServiceError(message, code, 400)` through the existing `handleError` envelope):**

| code | trigger |
|---|---|
| `INVALID_SETTINGS` | body / `zone` not an object; list fields of wrong type |
| `INVALID_ZONE_MODE` | `zone.mode` ∉ {`company`,`custom`} |
| `INVALID_ZIPS` | any token fails 5-digit normalization; message lists up to 10 offending RAW tokens |
| `ZIP_LIST_TOO_LARGE` | > 500 parsed ZIPs |
| `INVALID_UNIT_TYPES` | entry matches no unit catalog value |
| `INVALID_BRANDS` | entry matches no brand catalog value |

- **Write:** whole-`settings`-object top-level merge (never a deep `jsonb_set` path — the missing-parent no-op gotcha):

```sql
UPDATE marketplace_installations
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('settings', $3::jsonb),
       updated_at = NOW()
 WHERE company_id = $1 AND id = $2  RETURNING *
```

Seeded keys `seeded_by` / `shared_credential` (mig 169) survive every write. Validation error ⇒ **no write, no event**.
- **Audit:** exactly one `marketplaceQueries.writeEvent({companyId, installationId, appId, actorId, eventType:'settings_updated', requestId, payload:{app_key, zone_mode, custom_zip_count, unit_type_count, brand_count}})` per successful PUT — **counts only, never the ZIP list** (PII-lean). Ingest rejects are NOT evented (log + marker are the record).
- **Error envelope** (existing `handleError`): `{success:false, code, message, request_id}`; unknown errors → 500 `INTERNAL_ERROR`.

### 4.3 Frozen external contract (FR-11)

`POST /api/v1/integrations/leads` response for a REJECTED Rely lead is **byte-identical** in shape and status to today: `201 {success:true, lead_id, serial_id, contact_id, request_id}`. The Vultr poster never learns about rejection and must not retry. Error paths (400 `PAYLOAD_INVALID`, 500) unchanged.

### 4.4 Leads API surfacing (FR-8, no route changes)

The marker reaches list (`GET /api/leads`), detail (`GET /api/leads/:uuid`), and by-id DTOs automatically via `rowToLead`'s metadata spread (`leadsService.js:100` — verified: `Metadata: row.metadata || {}` plus top-level `...(row.metadata || {})`). Typed FE contract: `lead.rely_filter?: {rejected, reason, evaluated_at, zip, unit, brand} | null` — trustworthy at top level precisely because of the P-9 strip.

---

## 5. Filter decision matrix (FR-6 — normative table)

Evaluation order **zone → unit → brand**; first failing filter supplies the SINGLE reason; inactive filter ⇒ pass. "—" = not reached / not applicable.

| # | Installation | Zone config | ZIP state | Unit state (filter {…} = selection) | Brand state | Verdict | Reason | Queries |
|---|---|---|---|---|---|---|---|---|
| M1 | none `connected` | any | any | any | any | **accept** (all filters inactive, NFR-8) | — | 1 |
| M2 | connected, no `settings` key | defaults: zone=company | — | — | — | per M6-M11 (zone=company active iff territory data) | — | — |
| M3 | connected | custom, zips=[] (P-6) | any | inactive | inactive | **accept** | — | 1 |
| M4 | connected | custom, `02744 ∈` list | `02744` | inactive | inactive | **accept** | — | 1 |
| M5 | connected | custom, `02888 ∉` list | `02888` | inactive | inactive | **reject** | `out_of_area` | 1 |
| M5a | connected | custom, non-empty | missing (P-5) | — | — | **reject** | `out_of_area` | 1 |
| M6 | connected | company, list mode, ZIP in `service_territories` | present | inactive | inactive | **accept** (no activity guard — P-4) | — | 3 |
| M7 | connected | company, list mode, ZIP not found, `countListZips>0` | present | — | — | **reject** | `out_of_area` | 5 |
| M8 | connected | company, list mode, **zero rows** | present or missing | — | — | **accept** (zone inactive, [PRODUCT] guard) | — | ≤5 |
| M9 | connected | company, radius mode, geocache hit, inside a circle | present | inactive | inactive | **accept** | — | 4 |
| M10 | connected | company, radius mode, outside all circles, radii exist | present | — | — | **reject** | `out_of_area` | 6 |
| M10a | connected | company, radius mode, **geocode null** (transport / no key / unknown ZIP — P-3), radii exist | present | — | — | **reject** (decision, not error) | `out_of_area` | 5 |
| M11 | connected | company, any mode, missing ZIP, territory data exists (P-5) | missing | — | — | **reject** | `out_of_area` | 3 |
| M12 | connected | zone passed/inactive | — | filter {Dishwasher}, extracted **Dishwasher** | inactive | **accept** | — | — |
| M13 | connected | zone passed/inactive | — | filter {Dishwasher}, extracted **Washer** | not reached | **reject** | `unit_not_serviced` | — |
| M14 | connected | zone passed/inactive | — | filter {Dishwasher}, no `Issue:` line OR unrecognized (`Issue: Furnace`) | inactive | **accept** (fail-open [OWNER]) | — | — |
| M15 | connected | zone passed/inactive | — | passed/inactive | filter {Whirlpool,GE}, extracted **Kenmore** | **reject** | `brand_not_serviced` | — |
| M16 | connected | zone passed/inactive | — | passed/inactive | filter {Whirlpool,GE}, no `Brand:` line (US-4) or unrecognized (`General Electric`, `SubZero` — P-1) | **accept** | — | — |
| M17 | connected | zone FAILS + unit would also fail | — | — | — | **reject**, unit/brand never evaluated | `out_of_area` (first fail only) | — |
| M18 | any | **any thrown exception** (settings read incl. missing table P-14, parser, territory/geocache DB error) | — | — | — | **accept** + error log; lead byte-identical to pre-feature; NO marker | — | — |
| M19 | — | `JobSource ≠ 'Rely'` (P-12) | — | — | — | filter never runs: 0 queries, 0 log lines, createLead 2-arg | — | 0 |

Verdict object (D4): `{accepted, reason, extracted:{zip,unit,brand}, active:{zone,unit_types,brands}, error}` — `extracted` carries CANONICAL catalog strings (or null), `zip` the normalized ZIP (or null).

---

## 6. Scenario groups

### S — Settings API

**S-1. GET, defaults on absent settings (US-6).**
- *Pre:* seeded default-co installation (`metadata = {seeded_by, shared_credential}`, no `settings`), caller has `tenant.integrations.manage`.
- *Steps:* FE dialog opens → `GET /api/marketplace/apps/rely-leads/settings`.
- *Expected:* 200; `settings = {zone:{mode:'company',custom_zips:[]}, unit_types:[], brands:[]}`; `catalogs` = the two verbatim lists (§3); `territory.active_mode` per company row (absent ⇒ `'list'`), `has_data` per mode counts. No write occurs on GET.

**S-2. GET, stored settings are self-healed (P-7).**
- *Pre:* stored `settings = {zone:{mode:'teleport'}, unit_types:['Dishwasher','Toaster'], brands:'x'}`.
- *Expected:* 200 with effective `{zone:{mode:'company',custom_zips:[]}, unit_types:['Dishwasher'], brands:[]}` — unknown mode → `company`, non-catalog `Toaster` dropped, non-array → `[]`. Stored row NOT rewritten (read-time healing only).

**S-3. PUT happy path — canonicalize, merge, audit.**
- *Input:* body §4.2 with `custom_zips` as the free-form string `"02301, 02302; 2043\n02744, 02301"` and `unit_types:['dishwasher']`.
- *Expected:* 200; echo `settings.zone.custom_zips = ['02301','02302','02043','02744']` (normalized `2043`→`02043`, deduped, order preserved); `unit_types = ['Dishwasher']` (canonicalized). DB row: `metadata.seeded_by` + `metadata.shared_credential` **unchanged** (top-level `||` merge, §4.2 SQL); `metadata.settings.updated_at`/`updated_by` server-set. Exactly one `settings_updated` event with `{app_key:'rely-leads', zone_mode:'custom', custom_zip_count:4, unit_type_count:1, brand_count:0}`.

**S-4. PUT validation taxonomy — one 400 per field class.**
- Table §4.2 verbatim; per-case: `{zone:{mode:'custom', custom_zips:'02301, ABCDE'}}` → `INVALID_ZIPS` with `ABCDE` named in message (≤10 raw tokens); 501 ZIPs → `ZIP_LIST_TOO_LARGE`; `unit_types:['Toaster']` → `INVALID_UNIT_TYPES`; `brands:['Sony']` → `INVALID_BRANDS`; `zone.mode:'radius'` → `INVALID_ZONE_MODE`; `zone: 'custom'` (non-object) → `INVALID_SETTINGS`. On every 400: **no DB write, no event**.

**S-5. 404 taxonomy.**
- `GET /apps/nsa-leads/settings` (published but not whitelisted) → 404 `SETTINGS_NOT_SUPPORTED` (same for `pro-referral-leads`, `lhg-leads`, `lead-generator`, garbage keys).
- Whitelisted key with no published app row → 404 `APP_NOT_FOUND`.
- Company without an active rely-leads installation, OR installation `status='provisioning_failed'` (P-8), OR disconnected → 404 `APP_NOT_INSTALLED`. PUT behaves identically (resolution precedes validation — a 404 wins over a would-be 400).

**S-6. Tenancy + permission (US-5, NFR-6).**
- No/invalid token → 401 (mount `authenticate`). Authenticated user WITHOUT `tenant.integrations.manage` → 403 (mount `requirePermission` — fires before the router). Cross-tenant: addressing is app-key + own company (`req.companyFilter.company_id` set by `requireCompanyAccess`) — there is **no foreign id to probe**; a company-B user always resolves B's own installation (404 `APP_NOT_INSTALLED` if none) and can never read or write A's settings. No error message reveals other-tenant existence.

**S-7. PUT `mode:'custom'` + empty list (P-6).**
- *Expected:* 200, stored as-is; zone filter inactive at ingest (matrix M3). The UI hint (U-5) — not a server error — communicates "no filter".

### F — Ingest filter

**F-1. Non-Rely byte-identical (NFR-2, matrix M19).** `JobSource='Yelp'` / absent / `'RelyX'` → `isRelyLead` false: `evaluateRelyLead` never called, `createLead` called WITHOUT third arg, zero added queries, zero `[RelyLeadFilter]` lines, response and row identical to pre-feature.

**F-2. No connected installation (NFR-8, M1).** `getConnectedRelySettings` returns no row (never installed / disconnected / `provisioning_failed` — the hot-path SQL filters `status='connected'`) → `{accepted:true}`, all `active:*` false; lead created marker-free; ONE accept log line.

**F-3. Custom zone hit (US-1, M4).** Settings `custom` + `['02301','02302','02043','02744']`; payload `PostalCode='02744'` → accept, 1 query total. `PostalCode='2744'` (dropped zero) also accepts — normalized before comparison.

**F-4. Custom zone miss (M5).** `PostalCode='02888'` → reject `out_of_area`; unit/brand not evaluated (M17 ordering); lead created WITH marker (§7).

**F-5. Custom zone active + missing ZIP (P-5, M5a).** No `PostalCode` → reject `out_of_area`, 0 territory queries.

**F-6. Company zone, list mode, hit (US-2, M6).** `isZipInTerritory(companyId, zip).inside=true` (exact-text `service_territories` lookup via `findByZip`, normalize-tolerant) → pass; **activity guard NOT executed** (P-4); 3 queries.

**F-7. Company zone, list mode, miss with data (M7).** `inside:false` + `countListZips>0` → reject `out_of_area`; ≤5 queries (settings, seam getSettings, search, guard getSettings, countListZips).

**F-8. Company zone, zero territory data (M8 — [PRODUCT] guard).** `inside:false` (or missing ZIP) + list mode `countListZips=0` (or radius mode `listRadii=[]`) → zone INACTIVE → pass. A fresh company with the seeded installation and no territory setup accepts everything on day one except nothing — i.e., no rejects at all.

**F-9. Company zone, radius mode, hit (US-2, M9).** `company_territory_settings.active_mode='radius'`; ZIP in `zip_geocache`; haversine ≤ some `territory_radii.radius_miles` → `inside:true` → pass. No Google call on cache hit.

**F-10. Company zone, radius mode, miss + geocode-null pin (M10/M10a, P-3).** Outside all circles → reject. **Geocode returns null** (Google transport error / missing key / ZERO_RESULTS on a never-cached ZIP) → seam returns `inside:false` → radii exist → reject `out_of_area` — a decision, NOT the internal-error path; no fail-open. Self-heals once the ZIP geocodes successfully later (failures not cached).

**F-11. Company zone + missing ZIP (M11).** Guard decides: territory data ⇒ reject `out_of_area`; none ⇒ pass.

**F-12. Unit filter (M12-M14).** Selection `{Dishwasher}`: `Issue: Dishwasher - not draining` → pass; `Issue: Washer` → reject `unit_not_serviced`; no `Issue:` line, or `Issue: Furnace` (unrecognized) → pass (fail-open [OWNER]). Empty selection ⇒ inactive ⇒ pass regardless.

**F-13. Brand filter (US-4, M15-M16).** Selection `{Whirlpool, GE}`: `Brand: Kenmore` → reject `brand_not_serviced`; no `Brand:` line (the common case) → pass; `Brand: General Electric` / `Brand: SubZero` → unrecognized (P-1) → pass. Symmetric with unit; evaluated LAST.

**F-14. AND ordering + first-fail reason (M17).** Payload failing zone AND unit AND brand → single reason `out_of_area`; unit/brand matchers never run. Zone pass + unit fail + brand fail → `unit_not_serviced`. Cheap-accept-first: zone-company `inside:true` short-circuits every activity query (P-4).

**F-15. Parser/matcher edge set (P-1, P-2 — table-driven).** `Issue 2: Dryer` alone → unit missing → pass; `Issue: Dishwasher\nIssue: Washer` → first wins (Dishwasher); `issue :  Oven` (space before colon) → matches per `/^\s*issue\s*:\s*(.+)$/i`; `Brand: ridge` → GE not matched; `Brand: GE Profile` → GE; `Issue: Microwave oven` → **Oven** (catalog order); `Issue: Washer and Dryer` → **Washer**; `Sub-Zero`/`sub zero` → Sub-Zero, `SubZero` → miss→pass.

**F-16. Internal error ⇒ fail-open (M18).** Force `getConnectedRelySettings` to throw (e.g. missing table, P-14) OR `serviceTerritoryQueries.search` DB error → `evaluateRelyLead` catches, `console.error('[RelyLeadFilter] fail-open', err)` with stack, returns `{accepted:true, error:<message>}` → lead created with NO marker, response byte-identical; the single decision log line carries `fail_open_error`.

**F-17. Discriminator edges (P-12).** `JobSource=' RELY '` → filter runs; `'rely'` → runs; `'Rely Leads'` → does not; numeric/object JobSource → `String(...)` coercion, does not match, non-Rely path.

### R — Rejected-lead write

**R-1. Same-INSERT marker (P-10).** Rejected verdict → `createLead(payload, companyId, {systemMetadata:{rely_filter: buildMarker(verdict)}})` → ONE INSERT whose `metadata` contains the marker; status `Submitted` (default), FSM-valid — convert/lost/all transitions keep working. Marker shape (exact):

```json
"rely_filter": { "rejected": true, "reason": "out_of_area",
                 "evaluated_at": "<ISO>", "zip": "02888", "unit": "Dishwasher", "brand": null }
```

`zip/unit/brand` = the verdict's canonical extracted values (null when missing). No post-create UPDATE anywhere.

**R-2. Injection guard on create (P-9).** External payload `{Metadata:{rely_filter:{rejected:false}}, rely_filter:'x', …}` → both the `Metadata` object key AND any registered flat key are stripped by `extractCustomMetadata`; when the server ALSO rejects, `systemMetadata` wins (merge order `{...meta, ...systemMetadata}`); when the server accepts, the row has NO `rely_filter` at all. Other custom-metadata keys keep flowing exactly as before.

**R-3. Injection guard on update.** `updateLead` with `Metadata:{rely_filter:{...}}` → stripped; existing marker survives untouched (merge never deletes); no way to clear (P-9). `updateLead` gains NO systemMetadata support (marker is create-time-only, NFR-7).

**R-4. Badge exclusion (FR-9).** `countNewLeads` predicate gains `AND NOT COALESCE(metadata @> '{"rely_filter":{"rejected":true}}'::jsonb, false)`. Rejected+`Submitted` lead ⇒ not counted; **`metadata = NULL` legacy row ⇒ still counted** (the COALESCE is load-bearing — bare `NOT (NULL @> …)` would silently drop NULL-metadata rows; `leads.metadata` is nullable, 007 has no NOT NULL). `NEW_LEAD_STATUSES` unchanged.

**R-5. SSE badge coherence.** `lead.created` fires after the marker-bearing INSERT → client refetch of `/new-count` already sees the excluded row — badge never flashes +1. Event payload/contract untouched (genericEventTypes AND namedEvents; `/new-count` route stays above `/:uuid`).

**R-6. DTO exposure (FR-8).** List, detail, and by-id responses carry the marker both under `Metadata.rely_filter` and as top-level `rely_filter` (rowToLead spread, verified) — no route/DTO wiring. `listLeads only_open` (excludes only Lost/Converted) keeps rejected `Submitted` leads in the default view.

**R-7. Accepted lead is marker-free.** Acceptance = ABSENCE of `rely_filter` (never `{rejected:false}`); `createLead` third arg omitted entirely on accept (D5) — accepted Rely rows byte-identical to pre-feature rows.

### U — Frontend

**U-1. Settings button gate.** `IntegrationsPage` generic branch (`:294-316`): render `Settings` (outline, sm) before Disconnect **only when** `app.app_key === 'rely-leads' && app.installation?.status === 'connected'`. Not rendered: other four lead tiles (non-goal), `provisioning_failed` (Retry/Disconnect only), not-installed (Enable only). Follows the existing per-app-key precedent (vapi-ai/stripe/google-email/telephony).

**U-2. Panel canon (FR-4).** `RelyLeadsSettingsDialog.tsx` — FORM-CANON verbatim: `<Dialog><DialogContent variant="panel">` → `DialogPanelHeader` "Rely Leads settings" → `DialogBody className="md:px-8 md:py-7"` with `mx-auto w-full max-w-[740px] space-y-6` → `DialogPanelFooter` ghost Cancel + primary Save. Auto bottom-sheet on mobile; OverlayClose/Escape/backdrop built in — no hand-rolled close. Blanc tokens only; no "Blanc" in any string (NFR-6). Data: `useQuery(['rely-leads-settings'], enabled: open)`; loading → skeleton/disabled body; GET error → toast + panel stays usable for retry.

**U-3. Zone group.** `.blanc-eyebrow` "SERVICE AREA"; two native radio rows (label beside, non-floated): **"Same as company settings"** with hint from `territory` — `list` ⇒ "Currently: ZIP list", `radius` ⇒ "Currently: radius areas"; `has_data:false` ⇒ warning line "Your company has no service territory data yet — leads are accepted everywhere until you add some" (the [PRODUCT] guard made visible); **"Custom ZIP list"** reveals the textarea (U-4). Switching radios never destroys typed ZIPs within the open session.

**U-4. ZIP textarea.** `FloatingField` textarea rows=4 label "ZIP codes", accepts commas/spaces/newlines/semicolons; live count `text-xs var(--blanc-ink-3)`: "N ZIP codes recognized" from the client-side `/[\s,;]+/` split + 5-digit preview (client preview is advisory — **server re-parses on PUT and is the authority**); tokens failing the 5-digit preview are surfaced ("2 entries don't look like ZIP codes") without blocking typing. Save with invalid tokens → server 400 `INVALID_ZIPS` → `toast.error` naming the offending tokens (≤10).

**U-5. Checkbox grids.** "UNIT TYPES" and "BRANDS" eyebrow groups; `grid grid-cols-2 sm:grid-cols-3 gap-2` of `Checkbox` + label rows rendered FROM `catalogs` in the GET payload (no FE constants — A3). Empty selection under a group shows the literal hint "No filter — all leads accepted". Checkboxes are non-floated controls (FORM-CANON).

**U-6. Save flow.** Save → `saveRelyLeadsSettings` (PUT, body = canonical settings) → onSuccess: invalidate `['rely-leads-settings']`, `toast.success('Settings saved')`, close panel; onError: `toast.error(message)` (panel stays open, input preserved). Cancel/Escape/backdrop → close without write. Settings apply prospectively only (NFR-7) — no re-evaluation of existing leads.

**U-7. Rejected chip + reason (US-3).** Copy constant `REJECTED_REASON_COPY = {out_of_area:'Rejected — out of service area', unit_not_serviced:'Rejected — unit type not serviced', brand_not_serviced:'Rejected — brand not serviced'}` (`components/leads/leadConstants.ts`). Desktop table: status cell (`leadsTableHelpers.tsx` case `'status'`) appends a small "Rejected" pill when `lead.rely_filter?.rejected` — 10% tint of `#DC2626` via existing `hexToRgba` (from `leadStatusStyles.ts`), `title` = full reason copy. Mobile: same pill appended in `LeadMobileCard` row 1 beside the status chip (flex-wrap safe). Detail: `LeadDetailPanel` header — pill in the pills row + literal reason line (`text-[13px]`, `#DC2626`) beneath. Unknown/future `reason` values render the pill with fallback title "Rejected". No pill anywhere when the key is absent (R-7).

**U-8. FLAGS filter (A4).** `LeadsPage`: `rejectedOnly` boolean state; `filteredLeads` gains `if (rejectedOnly) result = result.filter(l => l.rely_filter?.rejected === true)` — client-side over loaded pages (100/page), exactly like source/jobType filters. Plumbed through `LeadsFilters` (desktop popover) and `LeadsMobileBar` (View-options sheet) into `LeadsFilterBody`, rendered as a 4th `FilterColumn` (title "FLAGS", `items={['Rejected']}`, selected ⇒ `['Rejected']`); active-chip row shows a removable "Rejected" badge; `onClearAll` resets it; `activeFilterCount` includes it. `FilterColumn` itself untouched; grid columns adjust (`sm:grid-cols-3` → responsive 4th column). `only_open`/server params unchanged. Count of rejected = visible row count while toggled (no server count endpoint — non-goal).

### D — Observability

**D-1. Decision log line (FR-10, P-11).** Exactly one per evaluated Rely lead, emitted after `createLead`:
`[RelyLeadFilter] {"decision":"reject","reason":"out_of_area","extracted":{"zip":"02888","unit":"Dishwasher","brand":null},"active":{"zone":true,"unit_types":true,"brands":false},"company_id":"…","lead_uuid":"…","serial_id":123}`
— accepts log `"decision":"accept","reason":null`; fail-open adds `"fail_open_error":"<message>"`; non-Rely emits nothing. Plus the separate `console.error('[RelyLeadFilter] fail-open', err)` with stack on M18 (error level).

**D-2. Settings audit event.** One `settings_updated` row in `marketplace_installation_events` per successful PUT (payload = counts only, §4.2); GETs and failed PUTs write nothing; ingest rejects write nothing (deliberate — the log line + lead marker are the record).

---

## 7. Component interaction

```
Settings:  RelyLeadsSettingsDialog (React Query) → authedFetch GET/PUT /api/marketplace/apps/rely-leads/settings
             → marketplace.js router (mount: authenticate → requirePermission → requireCompanyAccess)
             → marketplaceService.getAppSettings / updateAppSettings
             → marketplaceQueries (findActiveInstallation, setInstallationSettings, writeEvent)
             + territoryRadiusQueries (getSettings, countListZips/listRadii) for the territory block

Ingest:    Vultr poster → POST /api/v1/integrations/leads (auth chain untouched)
             → isRelyLead? → relyLeadFilterService.evaluateRelyLead(payload, req.integrationCompanyId)
                  → marketplaceQueries.getConnectedRelySettings (1 query)
                  → zone: custom set | territoryService.isZipInTerritory (+ activity guard on non-inside)
                  → unit → brand (pure, catalog constants)                       [ANY throw ⇒ accept]
             → leadsService.createLead(payload, companyId, {systemMetadata:{rely_filter}}?)
                  → extractCustomMetadata (RESERVED strip) → merged meta → ONE INSERT
                  → emitLeadChange('lead.created') → SSE → client refetches /new-count (excludes marker)
             → ONE [RelyLeadFilter] log line → 201 (frozen envelope)

Leads UI:  rowToLead spread → lead.rely_filter → chip (table/mobile/detail) + FLAGS client filter
```

## 8. Security & data isolation

- Settings endpoints: company_id ONLY from `req.companyFilter?.company_id` (set by `requireCompanyAccess`); app-key addressing means no cross-tenant id exists to probe; foreign/no installation → 404 (never 403 hinting existence); 401/403 enforced at the mount before the router.
- Ingest: company = `req.integrationCompanyId` (integration auth chain, untouched); filter and marker are strictly company-scoped through it.
- Injection: `rely_filter` is a server-owned metadata namespace — external `Metadata` objects and registered flat keys are stripped at the single extraction seam for ALL lead write paths (P-9).
- The audit event and log line carry counts/decision data only — never the full ZIP list; log payload has no customer PII beyond ZIP + extracted appliance/brand words.

## 9. Invariants checklist (must hold after implementation — verify each)

1. `POST /api/v1/integrations/leads` 201 envelope byte-identical for accepted AND rejected leads (FR-11).
2. Non-Rely payloads: zero added queries, zero log lines, `createLead` arity-2 call (NFR-2).
3. `api_integrations` row 1, `integrationsAuth`/`integrationScopes`/rate limiter — untouched (NFR-1).
4. No FSM/SCXML/`fsm_versions` change; no new status value; `markLost`/`activateLead`/`convertLead` untouched (NFR-3).
5. `territoryService.isZipInTerritory` + territory queries + SERVICE-TERR-002 endpoints — reused, never edited, never bypassed.
6. `NEW_LEAD_STATUSES` list unchanged; SSE event stays in BOTH genericEventTypes AND namedEvents; `/new-count` route order above `/:uuid`.
7. Seeded `metadata.seeded_by`/`shared_credential` survive every settings PUT (top-level `||`, no deep jsonb_set).
8. `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts` untouched; `backend/db/` untouched (NO migration 170).
9. countNewLeads keeps counting `metadata IS NULL` rows (COALESCE pin).
10. Rejected leads remain fully workable (default list visible, transitions valid) — no `only_open` change.
11. No user-visible string contains "Blanc" (product name = Albusto).
12. Disconnect → reinstall creates a new installation row ⇒ settings reset to defaults — expected, document in support notes (architecture risk 7).

## 10. Non-goals (frozen scope)

- Settings for `pro-referral-leads` / `nsa-leads` / `lhg-leads` / `lead-generator` (whitelist stays 1 key; no buttons on their tiles).
- Ingestion ENFORCEMENT (disconnect still doesn't block posts — LEADGEN-SPLIT FR-6 unchanged).
- Catalog admin UI / DB catalogs / alias tables for the matcher (P-1 consequences accepted).
- Un-reject affordance, retroactive re-evaluation, background re-checks, server-side rejected count endpoint.
- Any Vultr rely-lead-processor change; any payload contract change.
- Multi-appliance (`Issue 2:`) parsing; company-territory editing UI (lives in SERVICE-TERR-002).

## 11. Test seams

As specified in architecture «Test seams» (mock tables per `tests/marketplaceLeadgenSplit.test.js:6-29` pattern): `tests/relyLeadFilter.test.js` = matrix §5 table-driven + parser/matcher set F-15 + fail-open F-16 + NFR-2 pin F-1; `tests/relyLeadsSettings.test.js` = S-group (validation taxonomy, 404 trio, canonicalization, merge-SQL shape, event payload); leadsService additions = R-2/R-3/R-4 (incl. NULL-metadata row). UI scenarios U-1..U-8 = manual/harness verification against FORM-CANON.
