# JOBS-MOBILE-001 — Mobile Jobs view (tiles + one-gear filters)

**Type:** UI improvement · **Area:** frontend only · **No backend/migration** (the `/api/jobs`
query already supports search/filter/sort/offset; payment uses existing `invoice_status`/`invoice_total`).
**Surface:** the Jobs list page on **mobile** (`useIsMobile`, bp 768). **Desktop = unchanged** (full
table + toolbar). Mirrors the shipped mobile-Schedule pattern (SCHED-MOBILE-001 + SCHED-TILE-001).

## Problem
On mobile, [JobsPage.tsx](frontend/src/pages/JobsPage.tsx) renders the desktop `<table>` (JobsTable),
which only scrolls horizontally — unusable on a phone. Technicians will use mobile to see jobs.

## Decisions (owner-confirmed)
1. **Default scope:** show **ALL jobs** (no auto tech-scoping). Filters live under the gear; **no
   persistence** (reset each session).
2. **Layout:** mobile replaces the table with a **tile list grouped by date**.
3. **Tile:** Schedule-style (SCHED-TILE-001) **plus a payment pill**.
4. **Pagination:** **"Load more"** button (append next page).

## Architecture
`useIsMobile()` (reactive, hooks/useIsMobile.ts) branches JobsPage. Reuse `ui/BottomSheet.tsx`,
`getProviderColor` (utils/providerColors), `formatTimeInTZ` (utils/companyTime), `BLANC_STATUS_COLORS`
(components/jobs/jobsFilterHelpers), and the date-key TZ helper used by Schedule (utils/companyTime).
All Jobs state already comes from `useJobsPage`/`useJobsData` — reuse it; do not duplicate fetching.

### Modified files
- **JobsPage.tsx** — wrap the existing desktop `blanc-unified-header` + `blanc-page-card` (JobsTable)
  in `!isMobile`. When `isMobile`, render `<JobsMobileBar …/>` + `<JobsMobileList …/>` instead. The
  `FloatingDetailPanel` (job detail — already responsive) and `NewJobDialog`s stay shared (outside the
  branch). Desktop JSX is otherwise byte-identical.
- **components/jobs/JobsFilters.tsx** — **extract** the inline `filterContent` (the active-filter chip
  row + the 5 `FilterColumn`s STATUS/PROVIDERS/SOURCE/JOB TYPE/TAGS) into a new reusable
  `JobsFilterBody` (below). JobsFilters renders `<JobsFilterBody …/>` in BOTH its desktop popover and
  its existing mobile sheet — **behavior/markup must stay identical** (pure extraction, desktop must not
  change).
- **hooks/useJobsData.ts** — add `loadMoreJobs()` that fetches the next offset and **appends**
  (`setJobs(prev => [...prev, ...results])`, advance offset, update hasMore). Leave `loadJobs(offset)`
  (replace, used by desktop prev/next) untouched. Default mobile sort: set `sortBy='start_date'`,
  `sortOrder='desc'` when mobile on first mount so date paging is coherent (don't override a user choice).

### New files (components/jobs/)
- **JobsFilterBody.tsx** — props: all filter arrays + setters (status/provider/source/jobType/tag +
  startDate/endDate), `providerNames`, `statuses`, `dynamicJobTypes`, `allTags`. Renders the chips +
  5 columns exactly as today. (Pure move out of JobsFilters.)
- **JobMobileCard.tsx** — one job tile, mirroring SCHED-TILE-001 agenda composition, reading `LocalJob`:
  - Container: provider gradient + **4px left border = `getProviderColor(assigned_techs[0])`** + 1px
    border + 18px radius + card shadow; `role=button`, Enter/Space, `onClick(job)`; canceled
    (`blanc_status` Canceled) → `opacity .6`.
  - **Top row:** time hero (left, ~16px/600 — `formatTimeInTZ(start_date)[–end_date]`; if no time →
    title becomes hero) · right cluster = technician (`assigned_techs[0].name` `+N`, else `Unassigned`,
    13px) + **status dot** (8px, `BLANC_STATUS_COLORS[blanc_status]`, omit if no status, `title=status`).
  - **Title:** `service_name` (15px Manrope, truncate; omitted if it was the hero).
  - **Customer:** `customer_name` (13px, omit if empty).
  - **Address:** `address` (13px, same size as customer, map-pin icon, truncate; omit if empty). Optional
    Maps link: `https://www.google.com/maps/search/?api=1&query=<encoded address>` with stopPropagation.
  - **Payment pill** (bottom): only when finance-permitted AND `invoice_status` present — map to
    Paid (green) / Unpaid (red) / Partial (amber) using `invoice_status`; append `· $invoice_total` when
    available. Hidden otherwise. Gate via the same permission JobDetailPanel uses (`financial_data.view`,
    fall back to `invoices.view`) through `useAuthz().hasPermission`.
- **JobsMobileList.tsx** — props: `filteredJobs`, `loading`, `hasMore`, `onLoadMore`, `onSelectJob`,
  `onCopyJob`, finance flag, timezone. **Group by scheduled date** (date-key in company TZ from
  `start_date`; jobs with no `start_date` → a trailing **"No date"** group). Group order: by date
  **descending** (nearest/recent first). Friendly headers: "Today" / "Tomorrow" / "Yesterday", else
  `EEE, MMM d`. Under each header a `flex-col gap` of `JobMobileCard`s. Empty → "No jobs" message. A
  **"Load more"** button at the end when `hasMore` (calls `onLoadMore`, shows a spinner while loading).
- **JobsMobileBar.tsx** — sticky mobile header: "Jobs" title + search `<input>` (bound to
  `searchQuery`/`setSearchQuery`) + a single **gear ⚙** with an active-filter-count badge. Gear opens a
  `<BottomSheet>` titled "View options" containing, stacked: `<JobsFilterBody …/>`, the date-range
  (`DateRangePickerPopover` inputs or inline), a **Sort** selector (field + asc/desc, via
  `handleSortChange`), a **Reset** row when filters are active, **Export CSV** (`handleExportCSV`), and a
  **New Job** button (gated by the same permission the desktop button implies; closes the sheet then
  opens NewJobDialog). Mirror MobileScheduleBar's structure/タokens.

## Data mapping (LocalJob → tile)
time=`start_date`/`end_date` · title=`service_name` · customer=`customer_name` · address=`address` ·
tech=`assigned_techs` · status=`blanc_status` (color via BLANC_STATUS_COLORS) · payment=`invoice_status`
+`invoice_total`. **Job number is NOT shown** (per the tile design).

## Edge cases
No time → title is hero, no empty time slot. · Missing customer/address → row omitted (Blanc, no "—").
· No tech → "Unassigned". · No status → no dot. · No invoice / no finance permission → no payment pill.
· No `start_date` → "No date" group. · Canceled → opacity .6. · Long text → single-line ellipsis,
top row `min-width:0`. · Tap → existing `handleSelectJob` (→ `/jobs/:id` detail). · Desktop unaffected.

## Test cases (deferred — frontend has NO component-test harness; verify via strict build + review)
P0: mobile renders tiles (no `<table>`); job number absent; customer + address present. · P0: desktop
(≥768) still renders the table (no regression). · P1: group headers by date; "No date" group for null
start. · P1: status dot color = BLANC_STATUS_COLORS[status]; absent when no status. · P1: payment pill
shown only with finance permission + invoice_status; hidden otherwise. · P1: "Load more" appends, hidden
when `!hasMore`. · P1: JobsFilterBody renders identically in desktop JobsFilters (extraction = no change).

## Constraints
Frontend only; `npm run build` (tsc -b strict, noUnusedLocals) green. Desktop Jobs page byte-identical
besides the `!isMobile` wrapper + the JobsFilterBody extraction (which must be behavior-preserving).
Follow CLAUDE.md Blanc principles. Reuse existing tokens/utilities; no new color systems.
