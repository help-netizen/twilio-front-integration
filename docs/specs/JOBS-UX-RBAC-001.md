# JOBS-UX-RBAC-001 — Mobile UX polish + Technician (provider) finance access

Umbrella for six related changes. Orchestrated. Status: in progress (no deploy until owner confirms).

## Clarified requirements & decisions (binding — from Step 0.5 interview)

| # | Question | Decision |
|---|----------|----------|
| 2 | City source for the tile | **Backend `city` column** — populate from ZB sync (`service_address.city`) + manual-create geocode; best-effort backfill existing rows from the address string. |
| 3 | Provider finance scope | **Full self-serve** — view payments+financials, view/create/**send** estimates & invoices, **collect** online/offline/keyed/terminal. **No refunds.** |
| 6 | Source-hide mechanism | **New permission** `lead_source.view`, granted to tenant_admin/manager/dispatcher, **denied to provider**. |
| 4 | Job-card primary buttons | **Promote both** — Submitted → framed [On the way] + [Start job]; En-route → [Start job]; In Progress → [Complete job]; remove secondary text links + the all-statuses quick row; odd transitions via the existing status dropdown. |

Orchestrator-decided (low-risk, no ask): item 1 → raise `.blanc-mobile-sheet` cap 70→85vh; item 5 → folded into item 4 (remove `ActionsBlock` quick row); item 2 typography → unify title + name·city to one size, lighter weight (validate in mobile preview).

## Sub-features

### SHEET-HEIGHT-001 (item 1) — frontend
Mobile filter/settings sheets are inconsistent: Schedule "View options" uses the `BottomSheet` component (`maxHeight: 85vh`); Jobs/Leads filter sheets use the `.blanc-mobile-sheet` CSS class (`max-height: 70vh`). **Fix:** set `.blanc-mobile-sheet` `max-height: 85vh` in `frontend/src/styles/design-system.css` (it is a *max*-height, so small dropdowns — Snooze, Quick Messages, Assign Owner, Column Settings — are unaffected; only tall content that hit the 70vh cap grows to match Schedule). Drop the now-redundant inline `85vh` override in `DateRangePickerPopover.tsx` (optional tidy).

### TILE-CITY-001 (item 2) — backend + frontend
The full address occupies its own row in the mobile job tile and is a Google-Maps `<a>` → techs mis-tap it instead of opening the job.
- **Backend:** migration **137** adds `jobs.city TEXT` + best-effort backfill (`split_part(address, ',', 2)` for "street, city, state zip"). `jobsService.zbJobToColumns` writes `city` from `zbJob.service_address?.city`; manual-create path writes city from the geocode result. `listJobs` SELECT + the schedule item query (`scheduleQueries`) SELECT `city`. Expose `city?: string | null` on `LocalJob` (`jobsApi.ts`) and `ScheduleItem` (`scheduleApi.ts`).
- **Frontend:** `JobMobileCard.tsx` and `ScheduleItemCard.tsx` (agenda layout only) render **`CustomerName, City`** on one line directly after the title; the address is **plain text (no Maps link)** so it can't intercept taps. Unify the title and the name·city line to one font size, lighter weight (title ink-1, name·city ink-2). Classic schedule layout untouched.

### PROVIDER-FINANCE-001 (item 3) — backend
Grant `provider` (Technician): `payments.view`, `financial_data.view`, `estimates.view`, `estimates.create`, `estimates.send`, `invoices.view`, `invoices.create`, `invoices.send`, `payments.collect_online`, `payments.collect_offline`, `payments.collect_keyed`, `payments.collect_terminal`. **Excludes** `payments.refund`. Edit `050_seed_role_configs.sql` provider block; onboarding bootstrap re-reads 050 (auto-covers new companies). Backfill existing companies in migration **138** (idempotent `ON CONFLICT DO NOTHING`, per the 118 template). Unlocks the Finance tab (`hasAnyPermission('financial_data.view','estimates.view','invoices.view')`) + the Payments nav (`payments.view`).

### SOURCE-PERM-001 (item 6) — backend + frontend
New permission `lead_source.view` ("View the lead/job marketing source — label + filter"). Add to `permissionCatalog`, seed to tenant_admin/manager/dispatcher in 050 (NOT provider), backfill in migration **138** (same migration as PROVIDER-FINANCE). **Frontend** gates on `hasPermission('lead_source.view')` — hide source at: `jobHelpers.tsx` (job_source column), `JobDetailHeader.tsx` (source pill), `LeadMobileCard.tsx` (split `typeSource` → show JobType only), `leadsTableHelpers.tsx`, `LeadDetailPanel.tsx` (source dropdown), `LeadCard.tsx`; and filters `JobsFilterBody.tsx`, `LeadsFilterBody.tsx`, `CalendarControls.tsx`.

### JOB-ACTIONS-SLIM-001 (items 4+5) — frontend
`frontend/src/components/jobs/JobStatusTags.tsx` (`JobOpsSection`): replace the primary/secondary split with a **curated framed-button set per state** — scheduled/Submitted → [On the way (onMarkEnroute)] + [Start job (onMarkInProgress)]; en-route → [Start job]; in-progress → [Complete job (onMarkComplete)]; terminal → none. **Delete** the secondary text-link row (En-route/Complete/Cancel) and the `<ActionsBlock>` quick-buttons row. Keep the status dropdown in `JobDetailHeader.tsx` (already handles arbitrary transitions, incl. Cancel). Shared mobile+desktop (responsive classes). No backend change (provider already may enroute/start via RBAC-FSM-FIX-001).

## Migrations
- **137** — `jobs.city` column + backfill (TILE-CITY-001).
- **138** — provider finance perms backfill + `lead_source.view` grants backfill (PROVIDER-FINANCE-001 + SOURCE-PERM-001).
(Renumber if a parallel branch claims 137/138 before merge.)

## Security / multi-tenant
- All new route access stays gated by `requirePermission` (OR-semantics); company_id only from `req.companyFilter`. No isolation changes.
- Provider remains scoped to own jobs (`getProviderScope`) — finance access does not widen job visibility.
- `payments.refund` intentionally withheld from provider.

## Test plan
- **P0** backend: provider (new seed) passes GET/POST estimates, invoices, payments view + collect routes; provider still **blocked** from `payments.refund`; `lead_source.view` absent for provider, present for the other 3 roles. Migration 138 idempotent (re-run no-op). City column populated on sync.
- **P1** frontend: `npm run build` (tsc -b strict). Mobile dev-preview: tile shows "Name, City" one line, no Maps mis-tap; sheets same height; job-card shows only framed buttons + dropdown; source hidden for a provider-perm'd session.
