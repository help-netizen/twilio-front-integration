# SCHEDULE-MOBILE-MAP-001 — Map view for the mobile Schedule day

**Type:** UI feature · **Area:** frontend only · **No backend, no migration.**
**Surface:** the **mobile** Schedule page (`useIsMobile()` true → viewMode forced to `'day'`).
Desktop Schedule and the `CustomTimeModal` slot-picker map are **unchanged**.

## Общее описание

On the mobile Schedule, the day view currently shows a stacked **list** (`DayView`, mobile
branch) of the selected day's jobs for the selected technician filter. This feature adds a
**map** rendering of *the same jobs currently listed* — numbered, per-technician-colored pins
with straight connector lines in route (stop) order — reachable via a single icon-button that
sits **next to the mobile filter (gear) button** and swaps its icon by the current mode
(Map icon in list mode → tap shows map; List icon in map mode → tap returns to list). The map
replaces the list area full-width; it is not an overlay. Un-geocoded jobs are excluded and
counted in a small note. The pin/map rendering reuses the desktop slot-picker's proven
approach (shared `makePinSvg` + `getProviderColor`).

## Reused / extracted units

- **`frontend/src/utils/mapPins.ts` (NEW, extracted):** `makePinSvg(num, colorHex)` — the exact
  teardrop-with-number SVG data-URI from `CustomTimeModal.JobMap.makePinSvg` (28×40, white
  stroke). Pure. `CustomTimeModal` is refactored to import it (behavior byte-identical) so the
  SVG lives in one place.
- **`getProviderColor(providerId)`** from `frontend/src/utils/providerColors.ts` — the per-tech
  color used across schedule views (deterministic by id). Its `.accent` hex feeds `makePinSvg`
  and the connector `Polyline` stroke. **Reused as-is** (no change). This makes the mobile map's
  per-tech colors match the tiles' left-border color on the same page (consistency the local
  `TECH_COLORS` array in CustomTimeModal does not give — that array stays internal to the modal).
- **`loadGoogleMaps()`** from `frontend/src/utils/loadGoogleMaps.ts` — **reused as-is**, but the
  new component **`await`s** it in its init effect (CustomTimeModal relies on the global
  fire-and-forget load in `main.tsx` and bails silently if not ready; the new map must not bail,
  so it awaits and only builds the map once `google.maps` resolves).
- **`ScheduleItem`** shape (`frontend/src/services/scheduleApi.ts`) already carries `lat`, `lng`,
  `geocoding_status`, `start_at`, `customer_name`, `title`, `subtitle`, `address_summary`,
  `google_maps_url`, `assigned_techs`. The map reads these directly — **no new API, no fetch**.

**Not reused / deliberately separate:** `CustomTimeModal.JobMap` is left in place. It does
geocode-on-miss + `updateJobCoords` write-back and a green "new job ★" pin — behaviors this
feature explicitly does **not** want (owner decision 3: un-geocoded jobs are simply not
plotted). Forcing both onto one component would bloat the live slot picker. The shared surface
is the pin SVG helper + the color helper only — minimal, low-risk reuse.

## Component API

### `ScheduleJobsMap` — `frontend/src/components/schedule/ScheduleJobsMap.tsx` (NEW)

Presentational, self-contained map for an already-filtered set of schedule items.

```ts
interface ScheduleJobsMapProps {
  /** The SAME items the mobile day list shows (already provider/tag filtered,
      already scoped to the selected day). Parent passes schedule.scheduledItems. */
  jobs: ScheduleItem[];
  /** Company IANA tz (schedule.settings.timezone) — for InfoWindow time formatting. */
  companyTz: string;
}
```

Behavior:
- On mount: `await loadGoogleMaps()`; if it rejects (no API key) → render a friendly inline
  message ("Map unavailable") instead of a broken map. Build `new google.maps.Map` with the
  same options as the slot picker (`mapTypeControl/streetView/fullscreen: false`, POI+transit
  hidden).
- **Plottable set:** `jobs.filter(j => j.geocoding_status === 'success' && j.lat != null && j.lng != null)`.
  No geocoding fallback (owner decision 3).
- **Grouping & numbering:** group plottable jobs by their assigned technician id
  (`assigned_techs[0]?.id`; jobs with no tech → an "Unassigned" group). Within each group sort
  by `start_at` ascending; the pin number is the 1-based index in that per-tech order (route
  order). Pin color = `getProviderColor(techId).accent` (Unassigned → a neutral gray).
- **Markers:** per job `new google.maps.Marker({ icon: { url: makePinSvg(num, colorHex), scaledSize 28×40, anchor (14,40) } })`, `title` = `${techName} #${num} — ${customer_name}`. Click →
  `google.maps.InfoWindow` with tech + number (colored), time (`formatTimeInTZ(start_at)`),
  title/subtitle, address.
- **Connectors:** for each tech group with ≥2 plotted stops, one `new google.maps.Polyline`
  through the stops in order (`geodesic:false`, stroke = the tech color, `strokeOpacity ~0.7`,
  weight ~3). Straight lines only — **no Directions API** (owner decision 4).
- **Fit:** `bounds.extend` each plotted point + `fitBounds`; clamp max zoom (~14) on first idle
  (mirror slot picker). If **zero** plotted points → keep a default center/zoom and show the
  empty message.
- **No-geo note:** if `unplottable = jobs.length − plottable.length > 0`, render a small
  overlay note "N job(s) without a location" (`--blanc-ink-3`, no border/box beyond a subtle
  chip). Counts jobs the list shows but the map can't place.
- **Legend:** small per-tech legend (color dot + name) like the slot picker's, for the techs
  actually plotted.
- **Re-render on prop change:** a `useEffect` keyed on `jobs` (identity) + `companyTz` clears
  and re-places markers/polylines/legend and re-fits — so a filter or day change (which changes
  `jobs`) updates the map without remount.
- **Cleanup:** clear markers, polylines, listeners and `InfoWindow` on unmount / before each
  re-place (no leaks; the mobile page can toggle in/out repeatedly).

### Toggle wiring (state lifted to `SchedulePage`)

- `SchedulePage` owns `const [mobileMapOpen, setMobileMapOpen] = useState(false)`.
- **Mount point:** in `renderCalendarView()`, the `case 'day':` branch — when `isMobile &&
  mobileMapOpen`, return `<ScheduleJobsMap jobs={schedule.scheduledItems} companyTz={schedule.settings.timezone} />`
  **instead of** `<DayView …/>`. All other branches unchanged. (`scheduledItems` is already
  provider/tag-filtered and, on mobile, day-scoped — exactly the listed jobs.)
- `MobileScheduleBar` gains two optional props: `mapOpen: boolean` and `onToggleMap: () => void`.
  It renders **one** icon-button immediately to the **left of the existing gear (filter) button**
  in the top bar's right cluster: shows a **`Map`** lucide icon when `!mapOpen` (aria-label "Show
  map"), a **`List`** lucide icon when `mapOpen` (aria-label "Show list"); `onClick` calls
  `onToggleMap`. Same 44×44 tap target and `controlBtn` styling as the gear. **Not** two buttons —
  one button whose icon + label swap by `mapOpen`.
- SchedulePage passes `mapOpen={mobileMapOpen}` and `onToggleMap={() => setMobileMapOpen(v => !v)}`.
- **Auto-return to list:** a `useEffect` in SchedulePage resets `mobileMapOpen` to `false` when
  `isMobile` becomes false (rotate to desktop width) so desktop never renders the mobile map.
  (Day/provider changes intentionally **keep** map mode — the map just re-renders the new jobs.)

## Сценарии поведения

### S1 — List → Map shows the listed jobs' pins (numbered + per-tech colored)
- **Предусловия:** mobile Schedule, viewMode `'day'`, a day with ≥1 geocoded job for the
  selected provider filter, list mode.
- **Шаги:** tap the map-icon button (left of gear). `mobileMapOpen → true`.
- **Ожидаемый результат:** the list area is replaced by a full-width map; each geocoded listed
  job is a numbered pin; pins for the same tech share that tech's color (= tile left-border
  color) and are numbered 1..N in `start_at` order; the button icon is now the List icon.
- **Побочные эффекты:** none (no fetch, no write). `google.maps` loaded via awaited loader.

### S2 — Tech filter change reflects on the map
- **Предусловия:** map mode open.
- **Шаги:** open the gear sheet, change the Provider chip selection, close the sheet.
- **Ожидаемый результат:** `schedule.scheduledItems` changes → the `ScheduleJobsMap` effect
  re-places pins to exactly the new provider's geocoded jobs and re-fits bounds; stays in map
  mode. Selecting a second provider shows both techs' pins in their two colors.

### S3 — Day change reflects on the map
- **Предусловия:** map mode open.
- **Шаги:** tap another day in the week strip (or ‹ / ›).
- **Ожидаемый результат:** `currentDate` changes → items reload → `scheduledItems` changes →
  map re-places to the new day's geocoded jobs; stays in map mode.

### S4 — Un-geocoded jobs excluded + counted
- **Предусловия:** the day's listed jobs include some with `geocoding_status !== 'success'`
  (or null lat/lng).
- **Ожидаемый результат:** those jobs get **no pin**; a small note reads "N job(s) without a
  location" with N = count of listed-but-unplottable jobs. Geocoded jobs plot normally.
  Edge: **all** listed jobs un-geocoded → empty map + the count note (see S7).

### S5 — Tap a pin → InfoWindow
- **Шаги:** tap a pin.
- **Ожидаемый результат:** an InfoWindow opens showing "TechName #num" (in the tech color),
  time (company-tz), the job title/customer, and address. Tapping another pin opens its window.

### S6 — Connector lines per tech in stop order
- **Предусловия:** a tech has ≥2 geocoded jobs that day.
- **Ожидаемый результат:** a straight polyline connects that tech's stops in `start_at` order
  (1→2→3…), colored in the tech's color. Two techs → two independent polylines, no cross-tech
  line. A tech with 1 stop → no line. **No** road-following/Directions.

### S7 — Empty day → empty map + message
- **Предусловия:** the selected day + provider filter yields zero listed jobs (or zero
  geocoded).
- **Ожидаемый результат:** map renders at a default center/zoom (no pins), with an empty-state
  message ("No mapped jobs for this day"); if there were listed-but-unplottable jobs, the
  "N without a location" note also shows. No crash, no infinite fit.

### S8 — Back to list
- **Шаги:** in map mode tap the (now) List-icon button.
- **Ожидаемый результат:** `mobileMapOpen → false`; the map unmounts (listeners/markers
  cleaned) and `DayView` list returns with the same jobs; button shows the Map icon again.

### S9 — Desktop + CustomTimeModal unchanged
- **Ожидаемый результат:** on desktop widths no toggle button and no mobile map render
  (`isMobile` false; auto-reset guard). `CustomTimeModal`'s slot-picker map still renders its
  numbered colored pins + green "new job" star + geocode-on-miss exactly as before — only
  difference is it now imports `makePinSvg` from the shared util (same bytes).

## Граничные случаи

1. `google.maps` not yet ready at mount → component awaits `loadGoogleMaps()` then builds
   (never silently blank as long as the key is set).
2. Missing API key → `loadGoogleMaps()` rejects → inline "Map unavailable" message (no throw).
3. Job with `assigned_techs` empty/null → grouped under "Unassigned" (neutral gray pins,
   numbered among themselves, own connector if ≥2).
4. Job assigned to multiple techs → use the first tech for color/number/group (mirrors the
   list's left-border convention); document that multi-tech jobs count once under tech[0].
5. Duplicate/again toggling map↔list repeatedly → each mount awaits loader (idempotent),
   each unmount cleans up → no marker/listener leaks.
6. All jobs geocoded but all at the same coords → `fitBounds` on a zero-area bounds → the
   max-zoom clamp on first idle prevents an over-zoom.
7. Very large day (200 jobs cap from the list) → straightforward marker loop; acceptable on
   mobile (no per-marker network — geocoding is skipped entirely here).

## Обработка ошибок

1. `loadGoogleMaps()` rejects → inline non-blocking message; the toggle still works (tapping
   List returns to the normal list). No sonner toast needed (it's a config/asset condition,
   not a user action failure).
2. A single job with malformed `start_at` → excluded from ordering gracefully (sort treats
   missing as 0), still plotted if it has coords; never throws.
3. No provider colors edge (unknown id) → `getProviderColor` is total (hashes any string) →
   always returns a color; Unassigned uses the explicit neutral.

## Взаимодействие компонентов

- `SchedulePage` (owns `mobileMapOpen`) → passes `mapOpen`/`onToggleMap` → `MobileScheduleBar`
  (renders the single swap-icon button next to the gear).
- `SchedulePage.renderCalendarView()` `case 'day'` → when `isMobile && mobileMapOpen` renders
  `<ScheduleJobsMap jobs={schedule.scheduledItems} companyTz={settings.timezone}/>` else
  `<DayView …/>`.
- `ScheduleJobsMap` → `loadGoogleMaps()` (util) → Google Maps JS; reads `ScheduleItem` fields
  in-memory; `makePinSvg` (util) + `getProviderColor` (util) for pins/lines. **No backend
  call, no SSE, no React Query.** Realtime job updates already flow through
  `useScheduleData`'s SSE refresh → `scheduledItems` change → map re-renders via its effect.

## Безопасность и изоляция данных

No new data path. The map renders only `schedule.scheduledItems`, which are already fetched
and company-scoped by the existing `/api/schedule` endpoint (server enforces `company_id` and
provider scope); this feature adds no query and cannot widen visibility. Google Maps is a
client asset via the existing `VITE_GOOGLE_MAPS_API_KEY`.
