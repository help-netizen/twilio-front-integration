# LEADS-MOBILE-001 — Mobile Leads view (tiles + one-gear filters)

**Type:** UI improvement · **Area:** frontend only · **No backend/migration.**
**Surface:** the Leads list page on **mobile** (`useIsMobile`, bp 768). **Desktop = unchanged.**
This is the **Leads twin of JOBS-MOBILE-001** — mirror those components/patterns closely.

## Problem
On mobile [LeadsPage.tsx](frontend/src/pages/LeadsPage.tsx) renders the desktop `<table>`
([LeadsTable.tsx](frontend/src/components/leads/LeadsTable.tsx)) — horizontal scroll, unusable on a phone.

## Decisions (owner-confirmed in interview)
1. **Tiles** instead of the table, **grouped by created date**.
2. **Tile composition:** name (hero) → phone → "Job type · Source"; **status as a worded colored chip**
   top-right; **left border = status color**. No id, no email, no address (kept in the detail panel).
3. **No call button** — tapping the tile opens the lead detail (the call action lives there).
4. Mirror Jobs for the rest: one gear → "View options" bottom-sheet; **Load more**; desktop untouched.
5. **Default scope unchanged** — reuse LeadsPage's existing default filters (last 30 days + only-open);
   do NOT change desktop defaults. Secondary filters reset each session (no persistence).

## Architecture (mirror JOBS-MOBILE-001 — read those files as the template)
Jobs reference files: `components/jobs/JobsMobileBar.tsx`, `JobsMobileList.tsx`, `JobMobileCard.tsx`,
`JobsFilterBody.tsx`; `ui/BottomSheet.tsx`; the `JobsPage.tsx` `useIsMobile` branch.

### Modified
- **LeadsPage.tsx** — wrap the existing desktop `blanc-unified-header` + `blanc-page-card`(LeadsTable) in
  `!isMobile`; when `isMobile`, render `<LeadsMobileBar …/>` + a scrollable `<LeadsMobileList …/>`. Keep
  `FloatingDetailPanel` + all dialogs (Create/Edit/ColumnSettings/Convert) shared, outside the branch.
  Desktop JSX otherwise byte-identical. Add **`loadMoreLeads()`** — fetch `listLeads({ ...filters, offset:
  leads.length })`, `setLeads(prev => [...prev, ...results])`, update `hasMore`. (Does NOT touch
  `filters.offset`, so the desktop replace-on-offset effect and prev/next stay untouched.)
- **components/leads/LeadsFilters.tsx** — extract its inline filter columns (status / source / job type +
  active-filter chips + clear-all) into a new `LeadsFilterBody`; render `<LeadsFilterBody/>` in both the
  desktop popover and its existing mobile sheet. **Behavior-preserving — desktop must not change.** (Date
  range + only-open may stay where they are; the mobile bar re-adds them around the body.)

### New (components/leads/)
- **LeadsFilterBody.tsx** — status/source/job-type columns + chips + clear, props-driven (status via
  `filters.status`+`onFiltersChange`, source/jobType arrays + setters, statuses/sources/jobTypes lists).
- **LeadMobileCard.tsx** — one lead tile (mirror JobMobileCard structure):
  - Container: near-white surface, 1px border, 18px radius, card shadow; **4px left border =
    `LEAD_STATUS_COLORS[lead.Status]`** (fallback gray); `role=button` + Enter/Space + `onClick(lead)`;
    if `LeadLost` truthy → `opacity .6`.
  - **Row 1:** name `${FirstName} ${LastName}`.trim() (fallback `Company` else "No name"), hero ~17px
    Manrope `--blanc-ink-1`, truncate · **status chip** top-right — worded, colored via
    `leadStatusStyles.getLeadStatusPillStyle(lead.Status)` (bg tint + status color text), `nowrap`.
  - **Row 2:** phone — `formatPhoneDisplay(lead.Phone)` (util used by LeadsTable), 14px `--blanc-ink-2`,
    plain text (NOT a tel: link — tap must open detail, per "no call button"). Omit if no phone.
  - **Row 3:** `[JobType, JobSource].filter(Boolean).join(' · ')`, 13px `--blanc-ink-3`, truncate. Omit if
    both empty.
  - No id number, no email, no address, no call button.
- **LeadsMobileList.tsx** — group `filteredLeads` by created-date key (company TZ, `dateKeyInTZ` from
  utils/companyTime, on `CreatedDate`); null `CreatedDate` → trailing "No date". Groups ordered date
  **descending** (freshest first; matches the default CreatedDate-desc client sort). Friendly headers
  Today/Tomorrow/Yesterday else `EEE, MMM d`. Empty → "No leads". **"Load more"** button (spinner while
  loading) when `hasMore`.
- **LeadsMobileBar.tsx** — sticky header: "Leads" + search input (`searchQuery`/`setSearchQuery`) + one
  gear ⚙ (active-filter-count badge) → `<BottomSheet title="View options">` with: `<LeadsFilterBody/>`,
  the **date range** (`DateRangePickerPopover` via `onFiltersChange`), an **Only-open** toggle
  (`filters.only_open`), a **Sort** selector (fields: Created date / Name / Status, + asc/desc via
  `onSortChange`), a **Reset** row when filters are active, and a **New lead** action (opens
  CreateLeadDialog). No export, no column-settings (irrelevant to tiles).

## Lead → tile field mapping
name = `FirstName`+`LastName` (fallback `Company`) · status = `Status` (`LEAD_STATUS_COLORS`) ·
phone = `Phone` (`formatPhoneDisplay`) · type = `JobType` · source = `JobSource` · group = `CreatedDate`.

## Edge cases
No name → `Company` → "No name". · No phone → omit row. · No type/source → omit row. · `LeadLost` →
opacity .6. · No `CreatedDate` → "No date" group. · Long values → single-line ellipsis; top row
`min-width:0`. · Tap → existing `handleSelectLead` (→ `/leads/:id` detail). · FSM statuses: use the same
`statuses` source LeadsFilters uses (FSM states with `LEAD_STATUSES` fallback); unknown status → gray chip.

## Test cases (deferred — no frontend test harness; verify via strict build + review + dev preview)
P0: mobile renders tiles (no `<table>`); name shown; no id column. · P0: desktop (≥768) still the table
(no regression). · P1: status chip color = LEAD_STATUS_COLORS; left border matches. · P1: grouped by
created date; "No date" group for null. · P1: tap opens the lead detail. · P1: "Load more" appends + hides
when `!hasMore`. · P1: LeadsFilterBody identical in desktop LeadsFilters (extraction = no change).

## Constraints
Frontend only; `npm run build` (tsc -b strict, noUnusedLocals) green. Desktop Leads byte-identical besides
the `!isMobile` wrapper + the behavior-preserving LeadsFilterBody extraction. Reuse `ui/BottomSheet`,
`leadStatusStyles`, `LEAD_STATUS_COLORS`, `formatPhoneDisplay`, `dateKeyInTZ`. Follow CLAUDE.md Blanc
principles. No new color system.
