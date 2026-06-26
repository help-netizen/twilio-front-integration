# REC-SETTINGS-001 — Configurable Recommendation Settings

**Status:** Specification
**Priority:** P1
**Type:** New feature — per-company configuration layered over the merged SLOT-ENGINE-001.
**Requirements:** `docs/requirements.md` → "REC-SETTINGS-001 — configurable recommendation settings (2026-06-26)" (RS-R1..RS-R6)
**Architecture:** `docs/architecture.md` → "REC-SETTINGS-001 — design (2026-06-26)"
**Sibling feature:** SLOT-ENGINE-001 (`technician_base_locations` — mirrors its route/service/queries/API-client patterns)

---

## Общее описание

Replace the **hardcoded** `config_override` in `backend/src/services/slotEngineService.js` with **per-company settings** a dispatcher edits in a "Recommendation settings" block on Settings → Technicians (`frontend/src/pages/TechnicianPhotosPage.tsx`). The slot engine already deep-merges any `config_override` over `slot-engine/src/config.js` `DEFAULT_CONFIG` (`mergeConfig`) — so the *only* change is **where the override comes from**. **No engine code change, no engine redeploy.** Exactly **5** parameters are user-editable; **2** further values are always injected into the built override but never shown. One DB row per company; defaults are well-defined for every company before anyone saves.

---

## Параметры (the 5 user-set + 2 fixed)

Storage shape (the `config` jsonb — discrete keys, NOT a full engine blob):

```
{ max_distance_miles, overlap_minutes, min_buffer_minutes, horizon_days, recommendations_shown }
```

| # | Storage key (jsonb) | UI label | Control | Default | Validation (integer) | Engine `config_override` key(s) |
|---|---------------------|----------|---------|---------|----------------------|---------------------------------|
| 1 | `max_distance_miles` | Max distance (mi) | number input | **10** | **1–100** | `geography.max_distance_from_existing_job_miles` **AND** `geography.max_distance_from_base_if_empty_day_miles` (ONE radius → BOTH keys) |
| 2 | `overlap_minutes` | Allow overlapping arrival windows | picker {0,30,60,custom} | **0** | **0–240** | `overlap.max_timeframe_overlap_minutes` |
| 3 | `min_buffer_minutes` | Min buffer between jobs | picker {0,30,60,custom} | **15** | **0–240** | `feasibility.min_required_slack_minutes` |
| 4 | `horizon_days` | Planning horizon (days) | number input | **3** | **1–14** | `planning.horizon_days` |
| 5 | `recommendations_shown` | Recommendations shown | number input | **3** | **1–10** | `ranking.top_n` |

**Fixed values — ALWAYS in the built override, NEVER in the UI, NOT stored:**
- `geography.allow_empty_day_candidates = true`
- `workload.max_day_utilization = 0.95`

All 8 engine key paths above are confirmed present in `slot-engine/src/config.js` `DEFAULT_CONFIG` (geography{max_distance_from_existing_job_miles, max_distance_from_base_if_empty_day_miles, allow_empty_day_candidates}, overlap.max_timeframe_overlap_minutes, feasibility.min_required_slack_minutes, planning.horizon_days, ranking.top_n, workload.max_day_utilization).

---

## `DEFAULTS` constant (single source of truth — lives in `slotEngineSettingsService.js`)

```
DEFAULTS = {
  max_distance_miles:    10,
  overlap_minutes:        0,
  min_buffer_minutes:    15,
  horizon_days:           3,
  recommendations_shown:  3,
}
```

`VALIDATION` (integer ranges): `max_distance_miles` 1–100 · `overlap_minutes` 0–240 · `min_buffer_minutes` 0–240 · `horizon_days` 1–14 · `recommendations_shown` 1–10.

---

## `buildConfigOverride(settings) → object` (the exact deep-merge override sent to the engine)

Single place the engine-key mapping lives. Input is a fully-resolved settings object (all 5 keys present — `resolve`/`get` guarantee no partials). Output:

```
{
  geography: {
    max_distance_from_existing_job_miles:      settings.max_distance_miles,
    max_distance_from_base_if_empty_day_miles: settings.max_distance_miles,   // ONE radius → BOTH keys
    allow_empty_day_candidates:                true,                          // fixed, always
  },
  overlap:     { max_timeframe_overlap_minutes: settings.overlap_minutes },
  feasibility: { min_required_slack_minutes:    settings.min_buffer_minutes },
  planning:    { horizon_days:                  settings.horizon_days },
  ranking:     { top_n:                         settings.recommendations_shown },
  workload:    { max_day_utilization:           0.95 },                       // fixed, always
}
```

Notes:
- The two fixed keys are emitted unconditionally regardless of the stored row's content (AC-2).
- `planning.horizon_days` is the **same** value the backend uses to compute the snapshot date window (`latest_allowed_date`) — see below — so the engine config and the pushed snapshot window agree (AC-5).
- Arrays are not involved; `mergeConfig` deep-merges these nested objects over `DEFAULT_CONFIG`, leaving every unexposed key (travel.*, scoring.*, candidate_timeframes, durations.*, the other ranking/geography caps) untouched at its engine default (out-of-scope list, RS requirements).

---

## Сценарии поведения

### Сценарий 1: View settings (first run / no row)
- **Предусловия:** Dispatcher has `tenant.company.manage`; opens Settings → Technicians; company has no `slot_engine_settings` row yet.
- **Шаги:**
  1. `RecommendationSettings.tsx` mounts → calls `slotEngineSettingsApi.get()` → `GET /api/settings/slot-engine-settings`.
  2. Backend `svc.get(companyId)` finds no row → returns `DEFAULTS`.
  3. Block renders the 5 controls populated with `10 / 0 / 15 / 3 / 3`.
- **Ожидаемый результат:** A well-defined, non-empty form even with no saved row. The 2 fixed values are not surfaced.
- **Побочные эффекты:** None (read-only; no row is created by GET).

### Сценарий 2: Edit + save
- **Предусловия:** Block is loaded (row or defaults).
- **Входные данные:** Dispatcher changes one or more fields (e.g. Max distance 10→15, Recommendations shown 3→5).
- **Шаги:**
  1. Save button (enabled once the form is dirty) → `slotEngineSettingsApi.save(body)` → `PUT /api/settings/slot-engine-settings` with all 5 keys.
  2. Backend `svc.save(companyId, body)` → `validate(body)` (coerce + range, all-or-nothing) → `queries.upsert(companyId, config)`.
  3. Response `{ ok:true, data:<saved 5 values> }`; success toast; form reflects saved values.
- **Ожидаемый результат:** Row persisted (INSERT or UPDATE) scoped to `company_id`; `updated_at` bumped by the trigger.
- **Побочные эффекты:** One `slot_engine_settings` row upserted. No SSE/real-time event needed (settings page is request/response).

### Сценарий 3: Recommendations use the saved values
- **Предусловия:** Company has saved settings (or none → defaults); a new-job slot recommendation is requested.
- **Шаги:**
  1. `slotEngineService.getRecommendations(companyId, …)` calls `settingsService.resolve(companyId)` once.
  2. The snapshot date window uses `settings.horizon_days` for `latest_allowed_date`.
  3. `config_override = settingsService.buildConfigOverride(settings)` is sent to the engine.
  4. Engine deep-merges and returns ranked slots reflecting the new settings (wider radius surfaces farther techs; `top_n` caps how many cards return).
- **Ожидаемый результат:** Next recommendation fetch reflects current settings immediately (no engine redeploy, no cache to bust — settings are read per request).
- **Побочные эффекты:** None beyond the existing engine call.

### Сценарий 4: Reset to defaults
- **Предусловия:** A non-default row exists.
- **Шаги:** Dispatcher restores defaults in the form and saves → `PUT` with the 5 default values → upsert writes a config equal to `DEFAULTS`.
- **Ожидаемый результат:** Recommendations behave exactly as the untouched first-run case. (No separate DELETE endpoint; "reset" = saving defaults.)

---

## `resolve()` / `get()` behavior (RS-R2, safe-failure)

- **Row exists** → its 5 values. Any **missing/malformed individual key** falls back to that key's `DEFAULTS` value (never `undefined`/partial). `get` merges `{ ...DEFAULTS, ...row.config }` then re-coerces.
- **No row** → `DEFAULTS`.
- `resolve(companyId)` = `get(companyId)` **but degrades to `DEFAULTS` on any DB error** (safe-failure parity with `slotEngineService`). `resolve` **never throws** — recommendations must keep working even if the settings table is unreadable.
- `get` is used by the GET route (defaults on no-row, but a hard DB error there surfaces 500); `resolve` is used by `slotEngineService` (defaults on any fault).

---

## `validate(payload)` (RS-R5, server-enforced, all-or-nothing)

- Reads **only** the 5 known keys; **unknown keys are ignored/stripped** (never persisted).
- Each value must be an **integer** within its range (see `VALIDATION` table). `"15"`→15 coercion is allowed; non-integer (`12.5`, `"abc"`, `NaN`), out-of-range, or missing → reject.
- For the two minute-pickers, the `{0,30,60}` presets and the **custom** path both resolve to an integer that must satisfy 0–240; "custom" cannot bypass validation (AC-11).
- **PUT replaces all 5** (simplest contract — the body always carries the full set; not a partial PATCH/merge).
- On any failure: throw `{ httpStatus: 422, code: 'INVALID_SETTINGS', field, message }` — **no partial save** (validation runs fully before `upsert`).
- On success: returns the 5 coerced integers, which are stored as the `config` jsonb.

---

## API-контракты

Mounted in `src/server.js` next to the base-locations line:
`app.use('/api/settings/slot-engine-settings', authenticate, requireCompanyAccess, require('../backend/src/routes/slotEngineSettings'));`
`companyId(req) = req.companyFilter?.company_id`. Permission `tenant.company.manage` enforced **per-route** (like its sibling).

### `GET /api/settings/slot-engine-settings`
- **Middleware:** `authenticate, requireCompanyAccess` (mount) + `requirePermission('tenant.company.manage')` (route).
- **Request:** none.
- **Response 200:**
  ```json
  { "ok": true, "data": {
      "max_distance_miles": 10, "overlap_minutes": 0, "min_buffer_minutes": 15,
      "horizon_days": 3, "recommendations_shown": 3 } }
  ```
  (Resolved row-or-defaults — always the full 5-key object.)
- **Ошибки:** `401` no auth · `403` missing permission · `500` unexpected DB error (GET uses `get`, not `resolve`).

### `PUT /api/settings/slot-engine-settings`
- **Middleware:** same chain as GET.
- **Request body:** the 5 keys only —
  ```json
  { "max_distance_miles": 15, "overlap_minutes": 0, "min_buffer_minutes": 30,
    "horizon_days": 5, "recommendations_shown": 5 }
  ```
  `company_id` is **never** read from the body.
- **Flow:** `svc.save(companyId(req), req.body)` → `validate` → `queries.upsert`.
- **Response 200:** `{ ok: true, data: <saved 5 values> }`.
- **Ошибки:** `422 { code:'INVALID_SETTINGS', field, message }` (on `err.httpStatus`) · `401` · `403` · `500` (other).

### Безопасность и изоляция данных
- `company_id` comes **only** from `req.companyFilter` (AC-9); a request without a resolvable company scope is rejected; a caller can never read or write another tenant's settings.
- `slotEngineSettingsQueries.getByCompany` / `upsert` **always** filter/scope by `company_id` (PK = FK, one row/company). No `:id` path exists, so no cross-tenant direct-ID access surface.
- RBAC: both endpoints under `requirePermission('tenant.company.manage')`.

---

## Взаимодействие компонентов

```
RecommendationSettings.tsx
   │  slotEngineSettingsApi.get()/save()   (authedFetch, unwraps json.data)
   ▼
GET/PUT /api/settings/slot-engine-settings   (authenticate, requireCompanyAccess, requirePermission('tenant.company.manage'))
   ▼
slotEngineSettingsService  (DEFAULTS · validate · get · resolve · save · buildConfigOverride)
   ▼
slotEngineSettingsQueries  (getByCompany / upsert — company_id-scoped; ensureSchema replays migration 128)
   ▼
slot_engine_settings (PostgreSQL, one row per company)

Consumption (separate path, no UI):
slotEngineService.getRecommendations(companyId)
   ├─ settings = settingsService.resolve(companyId)            // DB error → DEFAULTS
   ├─ latest_allowed_date window uses settings.horizon_days    // replaces dropped HORIZON_DAYS=2
   └─ config_override = settingsService.buildConfigOverride(settings)  // replaces hardcoded literal
         ▼  POST SLOT_ENGINE_URL (deep-merge over DEFAULT_CONFIG) → ranked slots
```

### slotEngineService edits (only consumer change)
- `require('./slotEngineSettingsService')`; resolve once at the top of `getRecommendations`.
- **Drop** the module constant `HORIZON_DAYS = 2`; the date window uses `newJob.latest_allowed_date || addDaysLocal(today, settings.horizon_days)` (AC-5).
- **Replace** the hardcoded `config_override: { geography: { allow_empty_day_candidates: true, max_distance_from_base_if_empty_day_miles: 40 } }` with `config_override: settingsService.buildConfigOverride(settings)` (AC-4).
- Existing safe-failure (empty/flagged result on engine fault / missing `SLOT_ENGINE_URL`) is untouched; `resolve` never throwing keeps that path intact.

---

## Frontend states & copy (English, Albusto tokens)

**Block:** `frontend/src/components/settings/RecommendationSettings.tsx`, mounted in `TechnicianPhotosPage.tsx` directly under `<CompanyBaseAddress …>` inside its own `mb-6` wrapper.

- **Section header:** "Recommendation settings" in `.blanc-eyebrow` style. No `<hr>`/separators (design canon). Optional one-line sublabel: "How the scheduler suggests arrival windows and technicians."
- **The 5 controls (labels + units):**
  1. **Max distance (mi)** — number input. Helper text: *"Limits how far a technician can be from the nearest existing job — and from their base on an empty day — to be recommended."* (explains it bounds **both** base + nearest-job radii).
  2. **Allow overlapping arrival windows** — minute-picker {0 / 30 / 60 / Custom}; default 0. Helper: *"Minutes a new arrival window may overlap an existing one (0 = no overlap)."*
  3. **Min buffer between jobs** — minute-picker {0 / 30 / 60 / Custom}; default 15. Helper: *"Minimum slack required between consecutive jobs."*
  4. **Planning horizon (days)** — number input; default 3. Helper: *"How many days ahead to look for open slots."*
  5. **Recommendations shown** — number input; default 3. Helper: *"Maximum number of suggested slots returned."*
- **Minute-pickers:** segmented presets `0 / 30 / 60 / Custom`. Selecting **Custom** reveals a number input; the typed value must satisfy 0–240 (client-side, mirroring the server). A value not in {0,30,60} loaded from the server pre-selects **Custom** with that value shown.
- **Save button:** primary; **disabled until the form is changed** (dirty). While the request is in flight: label "Saving…", disabled. Re-enables on completion.
- **Loading state:** on mount, while `get()` is pending, show the controls disabled (or a light skeleton); fall back to `DEFAULTS` if the load fails so the form is always usable.
- **Toasts (sonner):** success → "Recommendation settings saved"; error/validation 422 → surface `field` + `message`, e.g. "Max distance must be between 1 and 100".
- **Validation hints:** inline per-field range hints mirroring the server ranges; client validation gates the Save button and pre-empts obvious 422s, but the server is authoritative.
- **API client:** `frontend/src/services/slotEngineSettingsApi.ts` — `authedFetch` from `./apiClient`, unwraps `json.data`; `interface SlotEngineSettings { max_distance_miles; overlap_minutes; min_buffer_minutes; horizon_days; recommendations_shown }`; `get(): Promise<SlotEngineSettings>`, `save(body): Promise<SlotEngineSettings>`; exports a `DEFAULTS` mirror + the validation ranges for client-side echo.

---

## Граничные случаи

1. **No row (first run)** → GET returns `DEFAULTS`; form shows `10/0/15/3/3`; `buildConfigOverride(DEFAULTS)` is what the engine receives. No request is ever sent with an undefined/partial parameter (AC-3).
2. **Partial / corrupt jsonb** (e.g. a key missing or non-numeric in the stored `config`) → `get`/`resolve` fill each missing/bad key from `DEFAULTS`; the returned object is always complete and integer-typed.
3. **Out-of-range / non-integer PUT** (e.g. `max_distance_miles: 250`, `horizon_days: 0`, `overlap_minutes: 30.5`) → `422 { code:'INVALID_SETTINGS', field, message }`; **nothing is saved** (validate runs before upsert; all-or-nothing).
4. **Unknown keys in PUT body** → ignored/stripped; only the 5 known keys are validated and stored.
5. **Custom picker value out of range** (e.g. Allow overlap custom = 300) → rejected the same as any 0–240 violation; "custom" cannot bypass validation (AC-11).
6. **Concurrent save** (two dispatchers) → upsert is **last-write-wins** on the single `(company_id)` row; `updated_at` reflects the latest write. No locking/versioning in P0.
7. **Distance / horizon change affecting the engine** → takes effect on the **next** recommendation fetch (settings resolved per request; no caching layer in `slotEngineSettingsService`). Wider `max_distance_miles` surfaces farther technicians; larger `horizon_days` widens both the engine config **and** the snapshot date window consistently (AC-5).
8. **First-run radius regression (known boundary):** the old hardcoded empty-day base radius was **40 mi**; the new shared default is **10 mi**, so on first run (no row) the empty-day radius drops 40 → 10. This is intentional per the architecture's "Open boundary question" — confirm with the customer whether 10 is the intended shared default or the empty-day radius should default wider. (Spec assumes the pinned binding: one shared **10** default for both radii.)

---

## Обработка ошибок

1. **DB error during `resolve` (consumption path)** → degrade to `DEFAULTS`; recommendations still run (safe-failure parity). Never throws.
2. **DB error during GET (`get`)** → `500` to the client; the UI falls back to its local `DEFAULTS` mirror so the form remains editable, and surfaces a non-blocking error toast.
3. **Validation failure on PUT** → `422 { code:'INVALID_SETTINGS', field, message }`; UI shows the field error via toast/inline; no save.
4. **Missing company scope** (`req.companyFilter` unresolved) → request rejected by the mount/permission chain before the handler touches data (no cross-tenant leak).
5. **Engine fault / missing `SLOT_ENGINE_URL`** → unchanged existing behavior (empty, flagged result); REC-SETTINGS does not alter it.

---

## Storage & migration (RS-R1)

- **NEW** `backend/db/migrations/128_create_slot_engine_settings.sql` (highest existing = 127 / ONWAY):
  ```sql
  CREATE TABLE IF NOT EXISTS slot_engine_settings (
      company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      config      JSONB NOT NULL,   -- { max_distance_miles, overlap_minutes, min_buffer_minutes, horizon_days, recommendations_shown }
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TRIGGER trg_slot_engine_settings_updated_at
      BEFORE UPDATE ON slot_engine_settings
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  ```
  `company_id` is both PK and FK (one row per company). The 2 fixed values are NOT stored (injected at build time).
- `slotEngineSettingsQueries.ensureSchema()` replays `128_*.sql` (mirrors `technicianBaseLocationQueries.js`).

---

## Защищённые части кода (НЕЛЬЗЯ ломать)

- `slot-engine/` — `DEFAULT_CONFIG` + `mergeConfig` deep-merge contract (`slot-engine/src/config.js`). **No engine change, no redeploy.**
- `slotEngineService` safe-failure path (empty/flagged result on engine fault) and snapshot-building logic (technicians, scheduled jobs, coverage).
- `technician_base_locations` table, its Settings screen, and its `GET/PUT/DELETE` routes — REC-SETTINGS adds a **sibling**, must not alter base-location behavior.
- `frontend/src/lib/authedFetch.ts` / `frontend/src/services/apiClient.ts` — reused, not rewritten.
- `src/server.js` core — only **one** new mount line added.
- Multi-tenant isolation via `req.companyFilter` + the `tenant.company.manage` permission convention.

---

## Out of scope

- Any engine parameter outside the 5 exposed (travel.*, scoring.* weights/thetas, `geography.min_geo_confidence_for_auto_recommendation`, `candidate_timeframes`, `workday.*`, `durations.*`, `ranking.max_recommendations_per_technician`, `ranking.max_recommendations_per_same_timeframe`).
- Per-technician / per-territory overrides (per-company only).
- A DELETE endpoint / explicit "reset" route (reset = saving defaults).
- Engine redeploy / algorithm / API-contract changes.
- i18n (English only); settings versioning/audit/import-export.

---

## File-touch summary

- **NEW backend:** `db/migrations/128_create_slot_engine_settings.sql`; `db/slotEngineSettingsQueries.js`; `services/slotEngineSettingsService.js` (DEFAULTS + buildConfigOverride live here); `routes/slotEngineSettings.js`.
- **EDIT backend:** `services/slotEngineService.js` (drop `HORIZON_DAYS`; resolve settings; horizon from `settings.horizon_days`; `config_override = buildConfigOverride`); `src/server.js` (+1 mount line).
- **NEW frontend:** `services/slotEngineSettingsApi.ts`; `components/settings/RecommendationSettings.tsx`.
- **EDIT frontend:** `pages/TechnicianPhotosPage.tsx` (mount the block under `CompanyBaseAddress`).
