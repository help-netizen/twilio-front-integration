# Blanc Contact Center — Changelog

> Лог изменений проекта.

---

## 2026-06-30 — NOTES-ID-STABLE-001: fix "add a note → editing/deleting it right away fails" on ZB-linked jobs

Adding a note to a job and then editing or deleting it immediately failed ("Note not found") until the page was refreshed. Root cause: on a Zenbooker-linked job, when Zenbooker echoed the new note back (`job.note_added`), `jobsService.mergeNotes` couldn't correlate the echo to the just-created local note — its text-match fallback was gated on `!ln.id`, but a freshly-created note has a local `id` (UUID) and no `zb_note_id` yet — so it **re-id'd the note to the Zenbooker id**. The client kept using the now-stale UUID, so `PATCH/DELETE /notes/:id` 404'd; a refresh re-read the new id and worked.

Fix (`mergeNotes`): (1) text-match **any** not-yet-correlated local note (dropped the `!ln.id` gate) so the echo re-correlates and **preserves the local id**; (2) carry forward Albusto-authored notes Zenbooker hasn't echoed yet (`id` + `created_by`, not soft-deleted, no `zb_note_id`) so a sync firing before the echo can't drop or re-id a fresh note. Genuine ZB-side deletes of already-correlated notes are still honoured. Exported `mergeNotes` + added `tests/mergeNotesIdStability.test.js` (6 cases: id-preserved-on-echo, no-drop, no-dup, ZB-delete-honoured, soft-delete-not-resurrected, local-edit-wins); existing notes + jobsService tests stay green.

Also checked **Tasks** (per the report): NOT affected — `createTask` returns the real serial id and `TaskStack` refetches, with no Zenbooker sync, so create→edit/delete works immediately. Leads/contacts notes aren't Zenbooker-synced, so this was job-only. Backend-only, no migration.

---

## 2026-06-30 — JOB-CARD-TITLE-001: job card title is the job type (not the contact name)

The job detail card used the **contact's name** as its big heading, with the job type (service) duplicated in small font up in the eyebrow (`JOB · #832990 · Repair`). The list tile, meanwhile, already titles each job by its **service**. Now the card matches the list: the large heading is `job.service_name` (falling back to "Job"), and the redundant service is removed from the eyebrow (which is now just `JOB · #<number>` + the ZB link). The customer is unchanged in the **Contact** row just below (still a link to the contact), so nothing is lost — the title just stops linking to a person (a service name shouldn't), and the card/list read consistently.

`frontend/src/components/jobs/JobDetailHeader.tsx` only (shared by mobile + desktop job cards): `mainTitle = job.service_name || 'Job'`; dropped `showServiceInEyebrow` + `customerName`; title is now plain text (the `contactInfo`/`navigate` props stay on the interface — passed by `JobDetailPanel` — but are no longer read here, to avoid a prop-removal cascade up the tree). `npm run build` green. Frontend-only, no migration. (Visual confirmation pending on live job data.)

---

## 2026-06-30 — AR-TASK-UNIFY-001: Pulse "Action Required" is now a Task

"Action Required" and Tasks were two views of the same `tasks` table seen through disjoint windows — a Pulse thread-task (via `thread_id`) was invisible to the Stacks UI. They're now **one model**: a Pulse **timeline (thread) is a first-class task parent** (`parent_type='timeline'`, reusing the existing `tasks.thread_id` column), and **"Action Required" = the timeline has an open task** (derived, not a separate flag).

- **Flagging a timeline** (the `⋮ → Action Required` action) now **creates a default "Follow up" task** on that timeline (assigned to the current user) and **immediately opens the task editor** (slide-over) to refine it — cancel keeps the default, so it's flagged either way. Replaces the old bare `set-action-required` flag write.
- **The timeline's tasks show in its view card**, a `TaskStack` **beside the Notes** in `PulseContactPanel` — add / edit / complete / snooze, exactly like a Job or Lead stack. A timeline can hold **many** open tasks.
- **Everywhere AR is shown** — the sidebar "Action Required" section (PULSE-LIST-GROUP-001), the `action_required` filter chip, the `PulseContactItem` badge (now shows the task title + "+N" + due), and the content-column AR bar — is driven by **`has_open_task`** instead of `is_action_required`. Completing the last open task (or "Mark Handled", which closes all open thread tasks) clears it automatically.
- **Global `/tasks`**: user-created timeline tasks appear like any entity task (labeled by contact/phone, click → opens the Pulse conversation). System/automation auto-tasks stay **Pulse-only** (excluded from the global list) so it doesn't flood.
- **Inbound / unread: untouched.** The deprecated, config-gated inbound auto-AR path is left as-is per owner instruction.

Backend: **migration 139** drops the `uq_tasks_one_open_per_thread` unique index (a timeline can now hold many open tasks); `timelinesQueries.createTask` replaces its `ON CONFLICT (thread_id)` upsert with an app-level "find-open-auto-task-or-insert" so inbound/rules keep a single auto-task per thread and **never clobber a user task**; `tasksQueries` gains the `timeline` parent (SELECT projection + company-scoped `timelines`/`contacts` joins + a global-list filter that shows only user-created timeline tasks); the sidebar list query swaps its `LEFT JOIN tasks` (which would fan out duplicate rows now) for a `LATERAL … LIMIT 1` + `open_task_count`, exposing `has_open_task`. Frontend: `TaskStack` gains an `onTasksChanged` hook so card edits refresh the sidebar AR.

Verify: `npm run build` green; backend syntax-checked (`tasksQueries` loads `timeline` as a valid parent). Independent adversarial review **found + fixed one blocker** — SMS-only timelines (a call-less inbound text, the dominant Action-Required case) are built in a *second* `calls.js` code path that wasn't emitting `has_open_task`, so they'd have lost their AR indicator; that branch now batch-loads open tasks too. Also broadened the background auto-unsnooze to task-only threads. All other review checks (SQL fan-out, upsert provenance, multi-tenant scoping, AR-derivation completeness, permissions, mark-handled) passed. Live-data visual confirmation pending (authed Pulse data can't load against the local backend). **NOT yet merged/deployed.**

---

## 2026-06-30 — PULSE-LIST-GROUP-001: Pulse conversation list — Action Required section + day grouping + mobile full-bleed

The Pulse sidebar (the list of conversations/timelines) was a flat list. Now it's organized like the Jobs list:
- **"Action Required" section pinned at the top** — conversations flagged `is_action_required` and not currently snoozed (snoozing still drops them out of the pinned section).
- **The rest grouped by activity day** (`last_interaction_at` in company TZ) with **sticky day headers** (Today / Yesterday / "EEE, MMM d"), most-recent day first; within a day the backend's recent-first order is kept. (Same component on desktop + mobile, so both get the grouping.)
- **Mobile full-bleed:** the sidebar's floating `.pulse-card` box (border/radius/shadow/bg) is stripped on mobile so the list runs edge-to-edge on the screen; the desktop floating card is unchanged.

Implemented as a render-only change in `PulsePage.tsx` (an O(n) grouping `useMemo` + a shared `renderItem` helper so every `PulseContactItem` keeps all its callbacks) + `PulsePage.css` (sticky header + mobile rule). Filter chips (all/unread/action_required), infinite scroll, dedup, active-highlight, real-time, and send are all untouched; a `NO_DATE` guard prevents a crash if a conversation lacks any timestamp. Grouping logic demo-verified (AR pinning, snoozed→day, descending days, every item placed once); `npm run build` green. Frontend-only, no backend/migration. (Visual confirmation pending on a device with live conversations.)

---

## 2026-06-30 — DETAIL-PANEL-MOBILE-CLOSE-002: mobile detail close is a top-right × (no content shift)

Follow-up to DETAIL-PANEL-MOBILE-BACK-001: the back-arrow lived in a thin top BAR that pushed the card content down. Replaced it with a close **× at the panel's top-right corner** (mobile only), rendered as a *child* of the full-screen panel so it stays visible (same stacking fix), with NO content shift. Headers that have a top-right cluster get a mobile-only right-gutter (`max-md:pr-14`) so the cluster sits just left of the × — e.g. JobDetailHeader's `⋮` kebab and ContactDetailPanel's action icons now read `[ … ⋮ × ]`. The × is a single 40px affordance shared by every `FloatingDetailPanel` card; the redundant own `md:hidden` ×'s in the Estimate/Invoice/Transaction detail panels were removed (no more double-× on mobile; their nested Radix-dialog render keeps its own ×). Desktop hover-left × + Esc/backdrop untouched. Independent review APPROVED (verified the own-close removal is safe at all 7 render sites and `onClose` was dead-wired only to the removed button); `npm run build` green; frontend-only.

---

## 2026-06-30 — JOB-TILE-PAYMENT-001: readable paid/due payment status on the mobile job tile

The mobile job tile showed "{status} · ${invoice_total}" (e.g. "Partial · $100") — it paired the Zenbooker status with the invoice *total*, so it never revealed how much was actually owed (and mixed a Zenbooker-cached total with a locally-summed `amount_paid`). Now the tile reads paid vs. due from one consistent source and shows it plainly:

- **Fully paid** → `Paid · $100` (green). **Partial** → `$30 paid · $70 due` (amber). **Nothing paid** → `$100 due` (red). **No invoice / nothing billed** → no pill. Money is compact (whole = no decimals, fractional = 2; thousands separators).
- **Data:** the jobs list query's existing per-job batch aggregate (one query, no N+1, company-scoped) now also sums `invoices.balance_due` alongside `amount_paid`, **excluding void/voided/refunded** invoices so a refund can't skew it. `total = paid + due`. A job with no local invoice gets `balance_due = null` → the tile falls back to the coarse Zenbooker `invoice_status` pill (unchanged for those). New `LocalJob.balance_due` field; no migration.
- **Logic** lives in a pure, exported `jobPaymentDisplay()` + compact `money()` in `JobMobileCard.tsx` (overpay clamped, NaN/null → no amount, `paid<=0` ⇒ "unpaid" not "partial"). Gated by `canViewFinance` (unchanged). Desktop table + `ScheduleItemCard` untouched (candidates for the same treatment later).
- **Verify:** logic demo across all states/edges (paid/partial/unpaid/$0/overpaid/fractional/large/ZB-fallback/draft) ✓; independent review APPROVED (backend sums, company scope, void-exclusion, null-signal correct); `npm run build` green. Frontend + a 1-line backend aggregate; no migration.

---

## 2026-06-30 — DETAIL-PANEL-MOBILE-BACK-001: restore the close affordance on mobile detail cards (regression fix)

On a phone, opening a detail card (Job/Lead/Contact + a few pages — all use the shared `FloatingDetailPanel`) left no visible way to close it and return to the list. **Regression from OVERLAY-CLOSE-CANON-001:** the mobile close `<OverlayClose variant="corner">` was a *sibling* of the panel with `z-index:auto`, while the mobile panel is full-screen `z-index:120` — so the panel painted over the close button and it was buried/untappable. (Desktop's hover-left × is `z-[141]`, so only mobile broke.) Fix: replaced it with a mobile-only **back-arrow (←) at the top-left**, rendered as a *child* of the panel (inside its stacking context → visible), in a slim `md:hidden` top bar so the content flows below it. Tapping it calls `onClose` → back to the list. Applies to every `FloatingDetailPanel` mobile detail card. Desktop unchanged. Independent review APPROVED; `npm run build` green; frontend-only.

---

## 2026-06-30 — JOBS-MOBILE-ORDER-001: mobile Jobs reads earliest-first within each day

On the mobile Jobs list (date-grouped tiles) the jobs inside each day were ordered latest→earliest — the first job of the day sat at the bottom. The list is globally `start_date` DESC for coherent date-grouped paging, so each day rendered bottom-up. Fixed in `JobsMobileList.tsx` by sorting each *dated* day-bucket ascending by `start_date` (earliest→latest) inside the grouping `useMemo`; the day-group order (most-recent day first) and the "No date" bucket are untouched, and paging/loadMore + the desktop table are unaffected. Frontend-only; independent review APPROVED; `npm run build` green.

---

## 2026-06-29 — OVERLAY-CLOSE-CANON-001: one shared close logic for every overlay

Overlay "close" had grown two dialects (slide-over hover-left × from LAYER-CLOSE-CANON-001 vs the bottom-sheet's own ×/swipe/backdrop) and the close BEHAVIOR (Esc/backdrop/scroll-lock/focus) was hand-re-implemented in every non-Radix overlay. Now there is **one source of truth** — edit it once, it changes everywhere.

- **`hooks/useOverlayDismiss.ts` (behavior):** one hook encapsulating Esc, backdrop-click, **ref-counted** body-scroll-lock (nested overlays no longer clobber each other's restore), focus-trap/restore, and swipe-down drag-to-dismiss — each independently togglable. The drag/focus/Esc logic was lifted verbatim from BottomSheet, so no behavior changed.
- **`components/ui/OverlayClose.tsx` (affordance):** one renderer of the close control — `variant="corner"` (inside top-right ×) and `variant="slideover"` (desktop hover-left ×, anchored via the shared `PANEL_CLOSE_RIGHT` table or an `anchorRight` override). `forwardRef` + prop-spread so it drops into `<DialogPrimitive.Close asChild>`.
- **Adopted by all hand-rolled overlays:** `BottomSheet` (keeps its fixed height + all 4 close methods — ×/swipe/backdrop/Esc — now from the hook), `FloatingDetailPanel` (stays non-modal on desktop: no scroll-lock/focus-trap; keeps its 420px/`--blanc-layer-width` widths via `anchorRight`), `FullscreenImageViewer` (Esc+scroll-lock; keeps arrow/zoom keys), `AIAssistantModal` (Esc+backdrop, **gains** scroll-lock). `ui/dialog.tsx` keeps Radix's native Esc/scroll-lock/focus and only adopts the shared `OverlayClose` affordance. `TwoFactorGate` stays intentionally non-dismissible. Decisions: sheets keep all 3 affordances; Radix keeps its own behavior; all hand-rolled overlays unified.
- **Net:** removed ~330 lines of duplicated close boilerplate; deleted the dead `.blanc-floating-close-*` CSS. Independent review APPROVED (after fixing a panel-width regression — panels are NOT resized). `npm run build` green; dev-preview confirmed a bottom sheet still closes via × / swipe / backdrop / Esc at its fixed height, app error-free. Frontend-only, no backend/migration. Cosmetic side-effects to confirm: centered-modal × now uses the shared soft-pill look.

---

## 2026-06-29 — SHEET-CANON-001: one canonical mobile BottomSheet (guaranteed-equal heights)

Mobile bottom sheets rendered at inconsistent heights. Root cause: **two parallel mechanisms** that shared no code — a real `ui/BottomSheet.tsx` component (used only by Schedule "View options") and a hand-rolled `.blanc-mobile-sheet` CSS class copy-pasted across ~9 sheets — and **every one of them was content-driven `max-height`**, so a filter sheet with many rows and one with few rows were genuinely different heights no matter the cap. (The earlier 70→85vh cap bump couldn't fix that.)

- **Canonical component:** evolved `ui/BottomSheet.tsx` into the single source of truth — `size` variants where **`standard`/`full` are a FIXED `dvh` height** (`var(--blanc-sheet-h, 85dvh)` / `92dvh`) so any two standard sheets are pixel-identical, with the body scrolling internally (flex column, `min-height:0`). `auto` stays content-sized (capped) for small action menus. Unified `dvh` (was `vh` — fixes the iOS URL-bar resize), radius (22px), animation (`blancSlideUp`), backdrop colour, z-index (190/200), plus drag-to-dismiss, focus trap/restore, body-scroll-lock, SSR guard.
- **Migrated all 9 sheets** to it (mobile branch only — desktop popovers byte-for-byte untouched): Jobs/Leads/Payments **filters** + Jobs "Visible Fields" → `standard`; Payments/DateRange **date pickers** → `full`; Snooze / Assign owner / Quick messages → `auto`. The Schedule/Jobs/Leads "View options" bars are explicitly `standard`.
- **Removed** the `.blanc-mobile-sheet` / `-header` / `-backdrop` CSS (kept the `blancSlideUp`/`blancFadeIn` keyframes, still used by `dialog.tsx`). FORM dialogs (`ui/dialog.tsx`) are a separate canon — untouched, only share tokens.
- **Proof:** dev-preview at 375×812 — Jobs / Leads / Schedule "View options" all measure **690px (0.850 × viewport)**, identical, where they previously varied. Independent review APPROVED (height guarantee confirmed structurally; no z-index occlusion in the 9). `npm run build` green. Frontend-only, no backend/migration. Note: Schedule's sheet animation/radius shifted (0.22s/28px → 0.25s/22px) — intentional, now matches the system.

---

## 2026-06-29 — JOBS-UX-RBAC-001: mobile UX polish + technician finance access

Six related changes (one orchestrated pass, independently reviewed — verdict APPROVED, 0 blockers). Spec: `docs/specs/JOBS-UX-RBAC-001.md`.

- **SHEET-HEIGHT-001** — mobile filter/settings sheets were inconsistent (Schedule "View options" = 85vh `BottomSheet`; Jobs/Leads filters = 70vh `.blanc-mobile-sheet`). Raised `.blanc-mobile-sheet` `max-height` 70vh→**85vh** to match Schedule; dropped the now-redundant DateRange inline override. It's a *max*-height, so small dropdowns (Snooze/Quick-Messages/etc.) are unaffected.
- **TILE-CITY-001** — the full address took its own row in the mobile job tile **and** was a Google-Maps link → techs mis-tapped it instead of opening the job. Now the tile shows **"Customer, City"** on one line after the title as plain text (no Maps link), and the title + name·city lines are unified to one size / lighter weight (more air, fewer lines). New backend `jobs.city` column (migration **137**) populated from Zenbooker sync (`service_address.city`) + structured create, refreshed on re-sync (COALESCE), with a heuristic backfill for existing rows; exposed on `LocalJob` + `ScheduleItem`. Applies to `JobMobileCard` + the `ScheduleItemCard` **agenda** layout (classic untouched).
- **PROVIDER-FINANCE-001** — the Technician (`provider`) role is now **full self-serve finance**: view payments + financials, view/create/**send** estimates & invoices, and **collect** (online link / offline / keyed / terminal). **No refunds.** Seeded in `050` (covers new companies via the onboarding bootstrap) + backfilled to existing companies in migration **138** (idempotent). Unlocks the Finance tab + Payments nav for techs; job visibility stays scoped to their own jobs.
- **SOURCE-PERM-001** — new permission **`lead_source.view`** (granted to Admin/Manager/Dispatcher, **denied to Technician**) hides the lead/job marketing **source** — both display (job/lead tiles, detail headers, tables — header *and* cell) and the source **filter** column (Jobs/Leads/Schedule) — from anyone without it.
- **JOB-ACTIONS-SLIM-001** — the job card's status actions were three stacked layers (primary buttons + plain-text secondary links + an all-statuses "quick buttons" row). Slimmed to a curated set of **framed primary buttons per state** — Submitted → [On the way] + [Start job]; En-route → [Start job]; In Progress → [Complete job] — and removed the secondary text-links + the quick-buttons row. Cancel and any non-standard transition stay available via the existing status dropdown under the job title. Shared mobile + desktop.

Backend Jest: `tests/providerFinanceRbac.test.js` (14) + `tests/jobsRbacGates.test.js` regression (12) — 26/26 green; provider blocked from `payments.refund`. `npm run build` green. Backend + migrations 137/138 (no schema risk; both re-runnable). Not yet deployed.

---

## 2026-06-29 — RBAC-FSM-FIX-001: technicians can operate their jobs + role-model audit

Owner-reported 403s. Two things: (1) the reporter (`a5085140320`) is a **tenant_admin** whose
403 was an **onboarding race** — the account existed ~40 s before the company's role configs
were seeded, resolving to 0 perms in that window (verified on the live resolver; a re-login fixes
their client). (2) The real bug: the **Technician (`provider`) role genuinely can't operate jobs.**

- **Provider FSM/notes gates (jobs.js):** `start` / `enroute` / `PATCH /:id/status` and notes
  `POST`/`PATCH`/`DELETE /:id/notes` required `jobs.edit` (which `provider` lacks) — only
  `complete` had the provider-friendly gate. Now all accept `requirePermission('jobs.edit',
  'jobs.done_pending_approval')`. Handlers already scope to the assignee (`getProviderScope` →
  404 on a foreign job) and note edit/delete stay author-only (`notesMutationService`), so a tech
  can run/annotate **only their own** job. Managers/dispatchers/admins are unaffected (they have
  `jobs.edit`).
- **Cancel stays dispatch-only:** the `/status` closing guard was **split** — `Canceled` requires
  `jobs.close`; `Job is Done` allows `jobs.close` OR `jobs.done_pending_approval`. An adversarial
  review caught a **parallel side-door** (`fsm.js POST /:machineKey/apply`) with the old un-split
  guard that let a `dispatcher` cancel — mirrored the split there too.
- **Resolver lockout fix (authorizationService.js):** `resolveEffectivePermissionsAndScopes` no
  longer early-returns `[]` on a missing role config — the MANDATORY_ADMIN baseline still applies
  for `tenant_admin` (never 0-perms / locked out of their own company).
- **Audit:** full 4-role × main-entity gate matrix in `docs/specs/RBAC-FSM-FIX-001.md` — the only
  false-403s were the provider FSM + notes gaps (fixed); `tasks` PATCH/DELETE's `tasks.view` gate
  is correct (inner `canActOn` enforces own/manage); no over-grants found.
- **Tests:** `tests/jobsRbacGates.test.js` (provider start/enroute/status/done pass, cancel blocked,
  view-only blocked, `/apply` cancel side-door blocked, resolver baseline) — 12; regression suites
  green. Backend-only, no migration (providers already hold `jobs.done_pending_approval`). Deploy:
  app rebuild (frontend bundle unchanged).

---

## 2026-06-29 — LAYER-CLOSE-CANON-001: one slide-over close affordance (hover-left)

Every slide-over "layer" now closes the SAME way — a hover-reveal × to the **left, outside** the panel (the
`FloatingDetailPanel` pattern). The inside top-right × on desktop is gone; it remains only for the mobile
bottom-sheet and for genuinely centered modals.

- **`ui/dialog.tsx` (`variant="panel"`):** the hover-left close now renders for **all** panel sizes
  (previously only default/sm), with `right` anchored to the panel's actual width so it sits just outside
  the left edge even on the full-width document editors. The inside top-right × is now `md:hidden` for **all**
  panel sizes (desktop hidden, mobile sheet keeps it). This fixes the Estimate/Invoice editors + Estimate
  preview (`size="full"`) and unifies every form dialog (New job, task, etc.).
- **Hand-rolled drawers → `FloatingDetailPanel`:** `RoutingLogsPage` "Call Details" (read-only) and
  `AutomationPage`'s rule-editor + run-history drawers dropped their bespoke `position:fixed`/backdrop/×
  markup and now render inside `FloatingDetailPanel` (hover-left, ESC, adaptive width).
- Centered modals (User Groups, Workflow Builder) keep the conventional top-right × — they're not slide-over
  layers. Frontend-only, no migration; `npm run build` green; dev-preview confirmed (desktop: hover-left
  shown, inside × hidden; mobile flips).

---

## 2026-06-29 — ZIP normalization made consistent across services (0a3830c follow-up)

The leading-zero ZIP fix (0a3830c) only normalized inside `vapi-tools.js`, so other service-area lookups
still missed on a dropped zero. Promoted `normalizeZip` to a shared util (`backend/src/utils/zip.js`) and
applied it **inside the service-territory query layer** (`serviceTerritoryQueries.findByZip`/`search`/
`create`/`bulkReplace`/`remove`) — so **every** caller now recovers a dropped leading zero, not just
vapi-tools. This fixes `GET /api/zip-check` (the SPA serviceability check), which previously passed the raw
zip (`"1721"`) straight to the exact-text lookup and silently missed `"01721"`. `vapi-tools.js` now imports
the shared util (deduped). Also fixed a **stale test**: `vapi-tools.test.js` "zip outside service area"
expected `{inServiceArea:false}` but the fix correctly echoes the normalized `{inServiceArea:false,
zip:"03801"}`. No migration; backend-only. New `tests/serviceTerritoryZip.test.js`; route suite 22/22 green.

---

## 2026-06-29 — NOTE-ATTACH-UPLOAD-001: pre-upload note attachments with progress

Fixes the silent ~30s freeze when adding a note with a file (the file used to upload at submit, with the
button merely disabled + no feedback). Now files **upload immediately on attach** (staged), show a **spinner**
per file, and **"Add note"/"Save" is disabled until uploads finish** — for both the new-note composer and the
edit flow, all entities (job/lead/contact), mobile + desktop.

- **Backend:** new `POST /api/note-attachments/upload` stages files to S3 with `note_index = NULL` (the
  staged marker — excluded from display). `noteAttachmentsService`: `stageAttachments`,
  `associateStagedAttachments` (note-create/edit stamps `note_id`+`note_index` onto staged rows; ignores
  foreign ids), `getAttachmentsForEntity` excludes staged, `deleteStaleStagedAttachments` + `entityExistsInCompany`.
  Note POST/PATCH on jobs/leads/contacts + `notesMutationService.editNote` accept `attachment_ids` (associate)
  with the raw-files path kept as fallback. **No migration** (reuse nullable columns). Company-isolated.
- **Cleanup:** removing a file deletes it immediately (`DELETE /api/note-attachments/:id`); a new
  `stagedAttachmentCleanupScheduler` (6h) sweeps abandoned staged rows (>24h) + their S3 objects.
- **Frontend:** new `services/noteAttachmentsApi.ts`; `NoteAttachmentInput` uploads on attach (spinner /
  error+retry / remove), reports staged ids + a `blocked` flag; `NotesSection` gates submit on `blocked`,
  sends `attachment_ids`, and no longer collapses the composer mid-upload.
- **Verify:** backend Jest 22/22 (stage/associate/exclude/cleanup/route isolation), existing note suites
  green; `npm run build` green; dev-preview confirmed (attach → "Uploading…" spinner + filename chip,
  "Add note" disabled during upload, composer stays open).

---

## 2026-06-29 — TASKS-FORM-PANEL-001: task form as a right-side panel

The New/Edit Task form (`TaskFormDialog`) now opens as a **right-side slide-out layer**
(`<DialogContent variant="panel">`) — the same mechanic as estimate creation — instead of a centered modal,
for **both** create ("New task") and edit (pencil) modes. Fields adopt the FORM-CANON floating-label style
(`FloatingField` description textarea, `FloatingSelect` assignee, `FloatingLabel`-wrapped date+time). All
behavior unchanged (required description, self-default assignee, deadline → ISO in company TZ, Delete on
edit, toasts); no prop/contract change, callers untouched. Frontend-only; `npm run build` green;
dev-preview confirmed the panel renders with floating labels. Spec: `docs/specs/TASKS-FORM-PANEL-001.md`.

---

## 2026-06-28 — TASKS-001: cross-entity Tasks (no standalone card)

A **Task** = assignee + deadline (date **and** time) + description, always attached to **one** parent
(Job / Lead / Contact / Estimate / Invoice) with **no standalone view**. Spec: `docs/specs/TASKS-001.md`.

- **In the parent card:** tasks render as a **stack** pinned at the top of the Notes feed (Job/Lead/Contact,
  via shared `NotesSection`) with an **"Add task"** button beside "Add note"; on Estimate/Invoice (no notes
  feed) the same stack is a compact block near the top. One task → a card; many → a stack that **expands on
  click**. Per task: **Done** (optimistic + undo), **Snooze** (15 min / 1 h / 3 h / tomorrow 08:00 / pick a
  date → 08:00, company TZ — reschedules `due_at`), and a **pencil** edit dialog.
- **Global `/tasks` page** (new nav tab, gated `tasks.view`): cross-entity list grouped by due bucket
  (Overdue/Today/Tomorrow/This week/Later/No date); clicking a row opens the **parent entity's card**
  (jobs/leads/contacts by path, estimates/invoices via the existing `?openId`). Mobile = date-grouped tiles.
- **Data:** migration **136** extends the existing `tasks` table (job/lead/estimate/invoice FK +
  `author_user_id` + indexes; `contact_id` already existed; **no breaking CHECK**). Task text lives in the
  NOT NULL `title` column, exposed to the API as `description`.
- **RBAC:** new `tasks.view` / `tasks.create` / `tasks.manage` — seeded for existing companies (136) **and**
  new-company bootstrap (`050`), + added to `permissionCatalog.js` so the Roles & Access editor lists them.
  Provider (Technician) gets view+create and acts on **own** tasks; manage ⇒ see/act on all. Visibility:
  `tasks.manage` → all company tasks, else own (assigned).
- **API:** new `routes/tasks.js` (`/api/tasks`) — `GET /` (role-scoped list), `GET /assignees`,
  `GET /entity/:type/:id`, `POST /`, `PATCH /:id`, `DELETE /:id`; all `company_id`-scoped, foreign id → 404,
  exactly-one-parent enforced in-app, author/owner = `crmUser.id`. New `db/tasksQueries.js`.
- **Verify:** backend `tests/routes/tasks.test.js` **23/23**; full route suite **223/223**; R4 suite 15/15
  (catalog edit non-breaking); frontend `npm run build` (tsc -b strict) green; dev-preview verified (Tasks
  page renders grouped rows + Done/Snooze, snooze popover shows the 5 presets, no console errors). Independent
  adversarial backend review APPROVED after fixing the new-tenant seeding gap (the `050` addition above).

---

## 2026-06-29 — JOB-TECH-ASSIGN-001: reassign the technician from the Job card (no reschedule)

Owner: changing a job's technician used to require the **Reschedule** flow, which also
moves the appointment time. Now the technician can be assigned / changed / unassigned
straight from the job-detail card, leaving the schedule untouched.

- **Frontend:** new `JobTechnicianControl` (a "Change"/"Assign" button → popover with a
  **searchable** technician list + an **Unassign** row that asks to confirm) replaces the
  read-only "Providers" block in `JobInfoSections`. Gated on `schedule.dispatch` (non-
  dispatchers see the tech read-only); optimistic update + parent refresh. New
  `hooks/useProviders.ts` (lazy `/api/zenbooker/team-members`). Desktop + mobile; not on list tiles.
- **Backend (two bugs fixed in the reused reassign path — they also hit the Schedule
  drag-reassign):** `scheduleQueries.reassignJob` **appended** the new tech (and stored a
  nameless `{id}`) instead of replacing → reassigning an already-assigned job accumulated
  stale, unnamed techs. Now it **replaces** with exactly `[{id,name}]` (or `[]` to unassign);
  the display name is threaded through `reassignItem`/the route/`scheduleApi`. And the
  reassign route rejected `assignee_id: null`, so **Unassign was impossible** — now `null`
  is the explicit unassign sentinel (only a *missing* field is a 400). Never touches `start_at`/`end_at`.
- **Tests:** `tests/scheduleReassign.test.js` (replace / null-unassign / name) + updated
  `tests/scheduleRoute.test.js` (name threading, null→200, missing→400); 12 green. Frontend
  build green; independent review found+confirmed both backend bugs (fixed). Spec:
  `docs/specs/JOB-TECH-ASSIGN-001.md`. Deploy: app rebuild (frontend bundle changed → logout-all).

## 2026-06-28 — RBAC-ROLES-EDITOR-001 (RBAC-AUDIT-001 Wave 2 / R4): in-app access-grid editor

Closed the one missing piece from the audit: the role matrix + per-member overrides existed as data +
resolution but had no editor. New desktop-only **Settings → Roles & Access** page (gated `tenant.roles.manage`).
No DB migration (tables 046/047 already exist).

- **Backend:** new `services/permissionCatalog.js` (runtime `PERMISSION_CATALOG` for the 56 seeded permission
  keys, grouped by area + labels — single UI source) + new gated route `routes/rolesPermissions.js`
  (`/api/settings/roles`): `GET /` (catalog + per-role permission maps, lazy-seeds role configs),
  `PUT /:roleKey/permissions` (toggle a role permission — **rejects the locked Admin role** + validates the
  key), `GET /members`, `PUT /members/:membershipId/overrides` (per-user allow/deny/clear). Added
  `roleQueries.setRolePermission` + `ensureRoleConfigs`, `membershipQueries.setPermissionOverride`,
  `userService.listUsers` membership_id. Writes use `crmUser.id`; all tenant-scoped; audited.
- **Frontend:** `RolesAccessPage` — **Roles** tab (permission×role matrix, Admin column locked, optimistic
  toggles) + **People** tab (per-member tri-state Inherit/Allow/Deny overrides); desktop-only (mobile notice).
  New `services/rolesApi.ts`, route in App.tsx, gated nav item.
- **Guards (reviewer-verified):** Admin uneditable; cross-tenant isolation (no IDOR); **last-admin lockout
  impossible** (resolver always re-adds MANDATORY_ADMIN_PERMISSIONS); resolver/seeds untouched. Edits apply
  on the affected user's next request (no cache). Backend test 15/15; full route suite 200/200; frontend
  build green. Spec: `docs/specs/RBAC-ROLES-EDITOR-001.md`.

---

## 2026-06-28 — RBAC-AUDIT-001 (Wave 1): role-system audit + hardening

Audited the RBAC system (4 preset roles tenant_admin/manager/dispatcher/provider, 42 permissions, 5 scopes,
per-company role configs + per-member overrides). Verdict: **core is solid** — roles seeded + resolve;
business routes (payments/invoices/estimates/leads/jobs/contacts) heavily permission-gated + company-scoped;
recent features respect RBAC; the mobile reworks did not regress gating. Audit report: `docs/specs/RBAC-AUDIT-001.md`.

Wave 1 remediation (R1 UI gating + R2 hardening + R3 route gating):
- **R1 (frontend):** permission-gate action buttons so a role doesn't see actions it can't perform —
  Create Lead (`leads.create`), New Job (`jobs.create`), Send estimate/invoice (`estimates.send`/
  `invoices.send`), Collect/Record payment (`payments.collect_online|offline`); desktop + mobile.
- **R3 (backend) — add `requirePermission` to authed-but-ungated routes** (matches their frontend route
  gating; over-gating reviewed — no legit role loses access): telephony admin (overview/provider/
  phoneNumbers/callFlows/userGroups[except GET /my]/phoneSettings) → `tenant.telephony.manage`; `vapi` →
  `tenant.integrations.manage`; `quick-messages` + `text-polish` → `messages.send`; `notification-settings`
  PUT → `tenant.company.manage` (GET left open for the SSE bridge).
- **R2 (hardening):** `vapi-tools` now **fails closed** (503 when `VAPI_TOOLS_SECRET` unset, was open
  "dev mode"). `crmMcpPublic` reviewed = **already protected** (env-flag + timing-safe bearer + company/user
  scope + write-gating); no change.
- Backend suite green for affected routes (6 route-test mocks updated to grant the new permissions; the 21
  pre-existing unrelated failures are unchanged). Frontend `npm run build` green. Reviewer APPROVED.
- **Deferred → Wave 2:** R4 (in-app editor for the access grid — role permission matrix + per-member
  overrides; schema/resolution exist but no edit API/UI yet). Frontend-only Wave 1, no migration.

---

## 2026-06-28 — LEADS-MOBILE-001: mobile Leads view (tiles + one-gear filters)

The Leads twin of JOBS-MOBILE-001. On mobile the Leads page rendered the desktop `<table>` (horizontal
scroll); reworked the **mobile** view (desktop ≥768 untouched) to tiles + a one-gear bottom-sheet.

- **Tiles** grouped by **created date** (Today/Yesterday else date; null → "No date") — new
  `components/leads/LeadMobileCard.tsx`: **name (hero) → phone → "Job type · Source"**, a **worded status
  chip** top-right (`getLeadStatusPillStyle`/`LEAD_STATUS_COLORS`), **left border = status color**, no
  id/email/address, no call button (tap opens the lead detail); `LeadLost` → dimmed. New
  `components/leads/LeadsMobileList.tsx` (grouping + **"Load more"**).
- **One gear ⚙** → `ui/BottomSheet` "View options" — new `components/leads/LeadsMobileBar.tsx`: search in
  the header; sheet holds status/source/job-type filters + date range + only-open toggle + sort
  (Created/Name/Status) + reset + New lead.
- **Desktop-safe refactor:** extracted `components/leads/LeadsFilterBody.tsx` (shared by desktop
  `LeadsFilters` + the mobile sheet — behavior-preserving). `LeadsPage.tsx` branches on `useIsMobile`;
  added `loadMoreLeads()` (append via `offset: leads.length`; desktop `loadLeads`/offset-effect/prev-next
  untouched); date grouping uses `company?.timezone`.
- Tap a tile → existing lead detail (`/leads/:id`). Frontend-only, no backend/migration. `npm run build`
  (tsc -b strict) green; reviewer APPROVED (desktop no-regression verified). **Verified on dev preview**
  (tiles grouped by date + worded status chips + the filter bottom-sheet). Spec:
  `docs/specs/LEADS-MOBILE-001.md`. Tests deferred — no frontend component-test harness.

---

## 2026-06-28 — JOBS-MOBILE-001: mobile Jobs view (tiles + one-gear filters)

On mobile the Jobs page rendered the desktop `<table>` (horizontal scroll, unusable on a phone). Reworked
the **mobile** view (desktop ≥768 untouched) to mirror the Schedule mobile pattern; techs can now read jobs
on a phone.

- **Tiles instead of a table** (`useIsMobile` branch in `pages/JobsPage.tsx`): jobs **grouped by date**
  (Today/Tomorrow/Yesterday else `EEE, MMM d`; null `start_date` → trailing "No date" group) rendered as
  Schedule-style tiles — new `components/jobs/JobMobileCard.tsx`: time hero → service → customer → address
  (same size), technician + colored status dot (`BLANC_STATUS_COLORS`) top-right, 4px left provider border,
  **no job number**, plus a **payment pill** (Paid/Partial/Unpaid · $total) gated by finance permission + a
  real `invoice_status` (draft/void show no pill). New `components/jobs/JobsMobileList.tsx` (grouping +
  **"Load more"**).
- **One-gear toolbar** — new `components/jobs/JobsMobileBar.tsx`: title + search + a single gear ⚙ →
  `ui/BottomSheet` "View options" holding all secondary controls (filters, date range, sort, reset, export,
  New job). Filters reset each session (no persistence); default shows ALL jobs.
- **Shared, desktop-safe refactor:** extracted the filter UI into `components/jobs/JobsFilterBody.tsx` (used
  by both desktop `JobsFilters` and the mobile gear sheet — behavior-preserving). `hooks/useJobsData.ts`
  gained `loadMoreJobs()` (append; desktop prev/next `loadJobs` untouched) + a once-only mobile
  `start_date desc` default sort (ref-guarded; never affects desktop).
- Tap a tile → existing job detail (`/jobs/:id`). Frontend-only, no backend/migration. `npm run build`
  (tsc -b strict) green; reviewer APPROVED (desktop no-regression verified). Spec:
  `docs/specs/JOBS-MOBILE-001.md`. Tests deferred — the frontend has no component-test harness.

---

## 2026-06-27 — SCHED-TILE-001: Schedule job-tile recomposition (agenda layout)

Owner feedback: a job tile in the calendar list had too many rows in a weak order (job# → status →
title → time → …). Recomposed into a **timeframe-led** card — applied to the **mobile agenda** and the
**desktop List view** only; all time-positioned views (day-grid, timeline, week, month) untouched.

- New `layout` prop on `components/schedule/ScheduleItemCard.tsx`: `'classic'` (default — today's exact
  rendering, byte-for-byte, everywhere it's already used) and `'agenda'` (additive early-return branch).
  Plus `detailed?` (desktop List adds a customer-phone row).
- Agenda composition: **timeframe = hero (largest, top-left)** → title → customer → address (customer &
  address same 13px size). **Technician name + small colored status dot top-right** (status Variant A);
  the left 4px border keeps the technician color. Job number, the uppercase status line, subtitle, and
  the geocoding hint are dropped from this layout (all remain in the JobDetailPanel / classic views).
- Edge cases: no time → title becomes the hero; missing customer/address/phone → row omitted (Blanc:
  no empty placeholders); `Unassigned` when no tech; status dot omitted when no status; Maps + `tel:`
  links keep `stopPropagation`; tap-to-open + Enter/Space preserved.
- Call sites changed: DayView mobile branch (`layout="agenda"`) and ListView (`layout="agenda" detailed`).
- Frontend-only, no backend/migration. `npm run build` (tsc -b strict) green; reviewer APPROVED.
- Spec: `docs/specs/SCHED-TILE-001.md`. **Test deviation:** the spec's Jest+RTL cases were not written —
  the frontend has no component-test harness (no RTL/jsdom/vitest); verified by strict build + adversarial
  review. Adding a frontend test harness is a separate infra follow-up.

---

## 2026-06-27 — SCHED-MOBILE-002: mobile Schedule week strip (date navigation)

Follow-up to SCHED-MOBILE-001 (owner feedback): the standalone **Today button confused** — it sat on
screen on every date, so you'd read "Today" while looking at another day. Replaced the `‹ / Today / ›`
row with a swipeable **7-day week strip** (mobile only; desktop untouched).

- New `WeekStrip` (`components/schedule/WeekStrip.tsx`): one row of 7 day cells (Sun→Sat) — weekday label,
  a **day-of-month circle**, and a **job-count caption**. **Selected day = filled accent circle**
  (`--sched-job`); **today = thin accent ring** (distinct even on different days). **Tap** a day to load
  its agenda; **swipe** left/right to page weeks — swiping changes only the **visible** week, the selection
  stays put until you tap (a swipe can't accidentally select — the synthesized click is swallowed).
- New `useWeekJobCounts` (`hooks/useWeekJobCounts.ts`): fetches the visible 7-day range with the same
  filters as the agenda, applies the **same provider/tag filter**, and buckets scheduled items by
  **company-TZ day** (`dateKeyInTZ`) → per-day counts that match what each day shows when tapped.
  Client-side, best-effort (error → no counts). **No backend, no migration.**
- `MobileScheduleBar`: the big date headline is now a **button — tap returns to today** (and snaps the strip
  to today's week); a subtle ↺ affordance shows only when off-today. The old nav row + total-count pill are
  gone. Refactor: the agenda's provider/tag filter was extracted to a shared pure
  `services/scheduleFilters.ts#filterItemsByProviderTags` (used by both the hook and the strip; behavior
  identical → desktop unaffected).

Frontend-only; `npm run build` green (strict); independent review APPROVED (extraction byte-identical,
desktop provably untouched, counts/today-marker consistent with the existing DayView agenda).
Spec: `docs/specs/SCHED-MOBILE-002.md`. Deploy: app rebuild + logout-all (bundle changed).

## 2026-06-27 — SCHED-MOBILE-001: mobile Schedule reworked for the field technician

Mobile-only Schedule rework (desktop unchanged). On a phone the toolbar is now just the
**date as the hero** (large) + ‹ Today › nav + a single **gear ⚙** button; below it the
existing clean job-list agenda. Every secondary control — search, filters, technician
selector, reset, and (dispatch-only) New job / AI Assistant / Settings — moved into a new
**bottom-sheet** (`ui/BottomSheet.tsx`) that slides up full-width (max 85vh + scroll, safe-
area), fixing the old filters popover that ran off-screen (fixed 520px, right-anchored).
The giant page title and the Unscheduled drag-panel are hidden on mobile (dispatch chrome).
`CalendarControls` was refactored to share `ScheduleFilterBody`/`ScheduleProviderChips`
between the desktop popover and the mobile sheet (same filter/provider/search state — no
duplication). New `MobileScheduleBar`. All behind `isMobile`; reviewer APPROVED, build green.

## 2026-06-27 — MOBILE-NO-SOFTPHONE-001: hide the browser softphone on mobile

The softphone is a Twilio WebRTC Device — unreliable on mobile browsers (backgrounded/locked tab drops
registration → no ring; flaky audio). On mobile it only caused confusion (warm-up modal on every
load/login + a non-working incoming-call screen). Decided to disable it on mobile; desktop unchanged.

- `AppLayout.tsx`: `softPhoneEnabled = !isMobile && …` (reuses `useIsMobile`, bp 768). On mobile this
  fully disables it — **Twilio Device never registers** (no token/register/getUserMedia), no nav button,
  no warm-up modal, no incoming auto-open; the `<SoftPhoneWidget>` render is also gated on `!isMobile`.
  (Verified the Device tears down via `destroy()` if the viewport flips desktop→mobile.)
- `ClickToCallButton`: on mobile the per-row "Call" button opens the **native dialer** (`tel:`) instead of
  the dead in-browser softphone (so you can still call from your phone); desktop keeps the in-app dialer.

Frontend-only; no backend/Twilio/Keycloak/DB change. `npm run build` green; reviewer APPROVED (desktop
byte-for-byte unchanged; no other softphone UI on mobile). Deploy: app rebuild + logout-all.

## 2026-06-27 — AUTH-SESSION-001: stay logged in on mobile (30-day Remember Me)

Owner: mobile browser logged out after ~5 min of backgrounding. Root cause: `rememberMe=false` →
Keycloak's SSO identity cookie was a non-persistent **session cookie**, which mobile browsers drop when
they discard a backgrounded tab → cold reload finds no session → login. (The 5-min timing is the
`accessTokenLifespan`, which is fine and stays at 300s.)

- **Keycloak realm (crm-prod):** `rememberMe=true`, `ssoSessionIdleTimeoutRememberMe` +
  `ssoSessionMaxLifespanRememberMe` = **2592000 (30 days)**. Applied live via kcadm; mirrored in
  `keycloak/realm-export.json` for fresh imports. A remembered session now sets a **persistent** cookie
  that survives mobile background/restart.
- **Login theme** (`login.ftl`): the "Remember me" checkbox is **default-checked** so users get the
  persistent 30-day session automatically.
- **Frontend** (`AuthProvider.tsx`): on tab resume (`visibilitychange`/`focus`) the Keycloak token is
  refreshed immediately, so a woken mobile tab never calls the API with an expired token (complements the
  existing 30s interval + onTokenExpired + apiClient 401-refresh).

**Tradeoff:** a 30-day persistent session means a lost/shared device stays logged in for 30 days
(accepted). Access tokens stay short (5 min). **One more login is needed** to mint the new persistent
cookie (deploy does a logout-all). Frontend build green; no DB migration.

## 2026-06-27 — ADDR-UX-001: base-address entry UX fix (Company + technician base)

Owner-reported: the base-address editors **auto-saved** the instant you picked a Google suggestion (no
chance to add an apt/unit), and on **Edit** showed the saved address as a string with an empty form below.

Root cause: the base editors MISUSED the (otherwise-correct controlled) `AddressAutocomplete` — passing a
constant `value={EMPTY_ADDRESS}` + `onChange={save}` (commit-on-coords), and storing only a composed
string + lat/lng (mig 125, no structured fields). Lead/job/contact forms use it correctly — left alone.

- **Frontend:** new shared `BaseAddressForm` holds a `draft: AddressFields`, renders the controlled
  autocomplete (no auto-save), with explicit **Save / Cancel**. `CompanyBaseAddress` + the per-tech base
  editor (`TechnicianPhotosPage`) now pre-fill the form on Edit (structured-first; `parseDescription`
  fallback for pre-migration string-only rows), keep the Apt field editable until Save, and surface a
  geocode-fail 422 as a toast while staying in edit. `addressAutoHelpers.fieldsFromStored` does the pre-fill.
- **Backend:** migration **135** adds `technician_base_locations.{street,apt,city,state,zip}` (additive);
  the upsert/list persist + return them. Manual entry (no Google pick → lat/lng null) **geocodes on save**
  (existing fallback); geocode-fail → 422 `GEOCODE_FAILED` (no row written). lat/lng/string/label kept for
  the slot-engine.

**Tests:** `tests/baseLocationStructured.test.js` (12) + existing tech-base/slot-engine/jobsEta (140) =
152 green; frontend build green. Reviewer APPROVED. Deploy: migration 135 + app rebuild + logout-all.

## 2026-06-27 — COMPANY-PROFILE-001: editable Company Profile in Settings

Owner couldn't change the company name that goes out in the "on the way" SMS, and wanted a real
company profile (name, contacts, address, logo, bank details).

- **Settings → Company** (`/settings/company`) is now a full profile editor (was address-only):
  company **name** (flows into the ONWAY customer SMS — `jobs.js` already reads `companies.name` —
  and into email subjects), contact email/phone, billing email, the existing address block, a
  **logo** upload (S3 via storageService, mirrors technician photos), and **bank/payment details**
  (bank name, account name, account number, routing, SWIFT, free-text instructions).
- Backend: tenant-scoped `GET/PATCH /api/settings/company-profile` + `POST .../logo`
  (`companyProfileService`, permission `tenant.company.manage`, whitelisted fields — never status/
  company_id/keys). Migration **134** adds `companies.logo_storage_key` + `payment_*` columns.
- **Documents source-of-truth:** `documentTemplatesService.resolveTemplate` now overlays the company
  profile brand (name/address/email/phone/logo/ach) onto the **factory** descriptor, so a tenant
  without a custom template gets its real brand on invoices/estimates instead of the "ABC Homes /
  Bank of America" placeholder. **A stored template still wins** ("templates can override") — so
  Boston Masters' invoices keep their "ABC Homes" DBA; only the SMS/display name follows the profile.
  Overlay only applies non-empty fields and safe-fails (never throws / never mutates the frozen factory).
- Fixed a stale `documentTemplatesService` test (`invoice` is a registered type since SEND-DOC-001;
  now asserts a genuinely-unknown type → null).

**Tests:** `tests/companyProfile.test.js` (13) + `documentTemplatesService` (14) green; frontend
build green. Pre-existing unrelated failures (PDF `@react-pdf/renderer` ESM-in-Jest, etc.) untouched.
Deploy: migration 134 + app rebuild + logout-all (frontend changed).

## 2026-06-27 — ZB-ISO-001 (SECURITY): fix Zenbooker cross-tenant data leak

**Owner-reported, P0.** The Schedule technician quick-filter showed technicians from
*another* company. Root cause: `zenbookerClient.getClientForCompany()` fell back to the
shared env `ZENBOOKER_API_KEY` (the default/Boston-Masters account) for **any** tenant
without its own key, so every tenant saw the default account's team — and, via the same
fallback, its jobs/services/territories/timeslots. `GET /api/zenbooker/team-members` made it
worse by not passing `companyId` at all.

Fix (`backend/src/services/zenbookerClient.js` + routes):
- The shared env key now belongs to ONE company — `ZENBOOKER_DEFAULT_COMPANY_ID` (env,
  default = seed company `…0001`). `getClientForCompany` returns the env client **only** for
  that company; any other tenant without its own `zenbooker_api_key` gets **null** (no
  cross-tenant fallback).
- Callers degrade safely: `getTeamMembers` → `[]`; `/api/zenbooker/team-members` now passes
  `companyId`; `POST /api/jobs/sync` no-ops with a clear message; `GET /api/integrations/
  zenbooker/jobs` (customer jobs) uses the company client (was global) → `[]` for non-connected
  tenants. The default company (Boston Masters) is unaffected.

**Note:** "jobs/leads empty on mobile" was NOT a bug — that session was logged into a different,
empty tenant; the leaked technician names made it look like the wrong company.

**Tests:** `tests/zenbookerTenantIsolation.test.js` (null for non-default, env only for default,
`[]` roster for non-connected) + 162 existing Zenbooker-caller tests green. No migration.
## 2026-06-27 — AUTH-FLOW-FIX-001: post-signup email-verify UX + 2FA SMS loop & throttle

Owner-reported after a real prod signup. Spec: `Docs/specs/AUTH-FLOW-FIX-001.md`.

**2FA SMS loop killed (P0).** After onboarding, `phone_verified_at` was set but the device wasn't
trusted, so landing on `/pulse` returned `401 PHONE_VERIFICATION_REQUIRED` → the "Confirm it's you"
gate opened and **auto-sent an SMS**; a full-page reload re-mounted the gate → another SMS → loop.
Fixes: (1) `routes/onboarding.js` now **trusts the device** (sets the `albusto_td` cookie, same attrs
as trust-device) on signup completion → no immediate gate/2nd SMS; (2) `OnboardingPage` lands via
client-side navigation instead of a hard `window.location` reload; (3) `apiClient.rawFetch` +
`TwoFactorGate.authFetch` now send `credentials:'include'` so the trust cookie actually sticks on the
retry (was the root of the reopen loop on a cross-origin API base); (4) the gate auto-sends **at most
once per open** and treats `429` as a soft "wait" state.

**Escalating per-phone SMS throttle (R6).** `otpService.sendCode` replaces the flat 5/hr+30s with a
ladder counted per E.164 across purposes, **since the last successful verify** (1h idle reset): ≤3
sends keep the 30s base cooldown, then min-gap 1 min → 5 min → 15 min → 1 h before each further send.
Throttled sends return `429 { code:'OTP_RATE_LIMITED', message, retry_after_sec }`. `verifyCode` stamps
`verified_at` to reset the ladder. Migration **133** adds `phone_otp.verified_at`. Applies to both
`/api/public/otp/send` (signup) and `/api/auth/otp/send` (login).

**Email-verification UX (Keycloak `albusto` theme).** New `info.ftl` (calls the layout with
`displayMessage=false` → **no more duplicated text**; auto-proceeds past KC's "» Click here to proceed"
via meta-refresh + `location.replace`; terminal state is a branded "You're all set" success page with
a **"Sign in to Albusto"** button) + `login-verify-email.ftl` + `messages/messages_en.properties` +
`theme.properties` `appUrl`. "Why Albusto" benefits stay signup-only; product name stays Albusto.

**Tests:** `tests/otpThrottle.test.js` (ladder + reset-on-verify), updated `otpService.test.js` to the
new semantics; full backend suite + frontend `npm run build` green. Reviewer APPROVED-WITH-NITS (the
flagged stale test fixed; nits addressed). Deploy: backend rebuild + migration 133 + KC
`up -d --force-recreate` (theme gzip cache).

## 2026-06-27 — SEND-DOC-001: send Estimate/Invoice by email or SMS + Gmail→marketplace app

**Send (was a non-functional stub):** the "Send" button on the Estimate/Invoice view now actually delivers. A dialog (email | SMS, editable recipient + message) sends: **email** = the document **PDF attached** + a link to the online doc (`emailService.sendEmail`); **SMS** = text + link (`conversationsService`, wallet-gated). Status flips to `sent`+`sent_at` **only after dispatch succeeds** (fixes the invoice flip-first bug). Error matrix: 400 (recipient/channel), 409 `MAILBOX_NOT_CONNECTED` (→ connect CTA), 402 `WALLET_BLOCKED`, 422 `NO_PROXY`/`NO_PHONE`, 404/403.

**Estimate public page (new):** migration 131 `estimates.public_token`; public routes `GET /api/public/estimates/:token` (PII-safe view JSON) + `/pdf`; branded view-only SPA page `/e/:token` (mirrors the invoice pay page). Invoice link uses the existing `/pay/:token` pay page. `EstimateSendDialog` upgraded to `InvoiceSendDialog` parity; `JobFinancialsTab`/`LeadFinancialsTab` route through the dialog (no more empty-recipient sends).

**Gmail connect → marketplace app (declutter settings):** migration 132 seeds a `google-email` marketplace app; its connected-state is a backend overlay off the REAL mailbox (`marketplaceService`, no install row). Connect reuses the existing Google OAuth (callback now redirects to `/settings/integrations/google-email`). The standalone `/settings/email` route + nav item are removed (route → redirect; refs repointed; `mail-secretary` dependency_cta repointed); `EmailSettingsPage` → `GoogleEmailSettingsPage` under the marketplace.

**Tests:** 45 backend (public routes/tenant-safety, dispatch + status-after-success ordering for both docs, full error matrix, marketplace overlay) + frontend build green. Reviewer APPROVED. Migrations 131/132 run on deploy.

## 2026-06-26 — EMAIL-TIMELINE-001: email in the contact timeline

Email now lives in the same contact conversation as SMS and calls — inbound Gmail
lands on the timeline and replies go back out as email, with the composer routing
by channel. Run through the full orchestration (Product → Architect → Spec →
Test-cases → Planner → Implement → Test → Review).

### Follow-up — outbound emails on the timeline
- **Both sides now show.** Previously only inbound was linked (matched by `from_email`),
  so a contact's timeline showed one side of the conversation. Outbound emails — the
  agent's replies, **including ones sent directly from Gmail** — now land right-aligned
  on the contact's timeline, matched by **recipient** (`to_recipients_json` / `msg.to`)
  via the existing `findEmailContact`.
- New `emailTimelineService.linkOutboundMessage` mirrors the inbound linker but: matches
  by recipient (first match wins), **excludes drafts** (the `DRAFT` label is dropped — draft
  activity still creates **zero** timeline entries), sets **no unread / no Action-Required**
  (the agent sent it), and publishes the `message.added` SSE so a Gmail-sent reply appears
  live. Wired into push (route by direction) and the 5-min poll (a second outbound
  reconciliation pass over the new `emailQueries.listUnlinkedOutboundForTimeline`).
- A one-time backfill links pre-existing outbound rows so historical sent emails surface.

### Receive
- **Real-time push:** Gmail `users.watch` (INBOX) → Google Pub/Sub → `POST /api/email/push/google`.
  The endpoint mounts BEFORE `express.json` with a raw body parser (like the Stripe
  webhook), verifies first (shared `?token=` primary / OIDC `aud` secondary), then
  **fast-acks 200** and ingests detached so Pub/Sub never retry-storms.
- **Fallback:** the existing 5-min poll (`EMAIL_SYNC_INTERVAL_MS`) reconciles inbound,
  so email keeps landing on the timeline even before Pub/Sub is provisioned.
- Inbound filtering: **draft/sent excluded**, `from_email` matched to a contact,
  body **quote-stripped** (latest reply only), persisted **unread**.

### Send
- Reply-to-thread (keeps the Gmail thread) or initiate a fresh email.
- Composer is **channel-routed**: phone selected → SMS, email selected → email; a
  **connect CTA** is shown instead when the company's Gmail isn't connected yet.

### Plumbing
- **MailProvider abstraction** — `GmailProvider` today, IMAP-ready seam
  (`startWatch`/`renewWatch`/normalized pull) behind a provider registry.
- **Migration 129** (`129_email_timeline_link.sql`) — email↔timeline link.
- New env (see `.env.example`): `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFICATION_TOKEN`,
  `GMAIL_PUSH_OIDC_AUDIENCE`, `GMAIL_PUBSUB_SA_EMAIL`, `GMAIL_WATCH_RENEW_INTERVAL_MS`.

**OPS prerequisite for LIVE push:** a GCP Pub/Sub **topic** + a **push subscription**
targeting `https://<host>/api/email/push/google?token=<GMAIL_PUSH_VERIFICATION_TOKEN>`,
and **Pub/Sub Publisher** on the topic for `gmail-api-push@system.gserviceaccount.com`.
Until that's provisioned, inbound runs on the 5-min poll.

**Pending:** **NOT yet deployed** — run migration 129 against prod + deploy + provision
GCP Pub/Sub (topic/subscription/IAM) for real-time push.

## 2026-06-26 — REC-SETTINGS-002: `max_distance_miles` now drives empty-day coverage

Follow-up to REC-SETTINGS-001. **Problem (verified on prod):** `max_distance_miles` only drove the engine's GEO pre-filter, but empty-day candidates were then rejected by the engine's internal travel-feasibility caps (`travel.max_extra_travel_minutes:35` / `max_edge_travel_minutes:45`, haversine MVP @ 25 mph) — so effective coverage was only ~5 mi regardless of the setting.

**Fix:** `slotEngineSettingsService.buildConfigOverride` now also emits a `travel` block scaled from `max_distance_miles` (D), so the GEO radius is the binding constraint and the technician workday is the natural ceiling (customer decision: radius = limit, no extra hard drive-time cap). Formula derived from the engine source (`slot-engine/src/geo.js` `driveMinutes=(D/25·60)·1.10+10`, `engine.js` empty-day `extra=2(K·D+10)−10`):
- `K=2.64`, `BUF=10`; `max_edge_travel_minutes = max(45, ceil((2.64·D+10)×1.10))`; `max_extra_travel_minutes = max(35, ceil((5.28·D+10)×1.10))`.
- Floored at the engine defaults (45/35) → never more restrictive than before. D=10 → 45/70, D=25 → 84/157, D=1 → 45/35, D=100 → 302/592.

**Verified on the live prod engine:** at D=10, empty-day coverage now extends to the full ~10 mi radius (then the geo gate cuts at 11 mi) vs ~5 mi before; the Newton centroid (7 mi from nearest base) went 0 → 24 feasible candidates. D=25 → ~25 mi.

**Scope:** one function (`buildConfigOverride`) + tests only. No engine change/redeploy (config_override already deep-merges `travel.*`), no UI change, no migration. Tests: `tests/slotEngineSettings.test.js` extended (TC-RS2-001..014) — 81 passing across it + `slotEngineProxy.test.js`. Reviewer APPROVED (formula cross-checked against engine source). Specs: `docs/specs/REC-SETTINGS-002.md`.

**Pending:** deploy (rsync `slotEngineSettingsService.js` + rebuild app; no migration, no engine rebuild).

## 2026-06-26 — REC-SETTINGS-001: per-company configurable recommendation settings

Replaces the **hardcoded** engine `config_override` in `slotEngineService` (previously `{ geography: { allow_empty_day_candidates: true, max_distance_from_base_if_empty_day_miles: 40 } }`) with **5 per-company parameters** a dispatcher edits in the UI. Defaults tightened: the empty-day base radius drops 40 → **10 mi** (one shared radius now governs both the base-distance and the nearest-existing-job checks). No engine change / redeploy — the deployed engine already honors `config_override` (deep-merge).

**The 5 editable parameters** (defaults): `max_distance_miles` (10) → mapped to BOTH `geography.max_distance_from_existing_job_miles` and `geography.max_distance_from_base_if_empty_day_miles`; `overlap_minutes` (0 = no overlap) → `overlap.max_timeframe_overlap_minutes`; `min_buffer_minutes` (15) → `feasibility.min_required_slack_minutes`; `horizon_days` (3) → `planning.horizon_days` (also widens the snapshot date window); `recommendations_shown` (3) → `ranking.top_n`. Two values stay fixed/hidden and are always injected: `geography.allow_empty_day_candidates=true`, `workload.max_day_utilization=0.95`.

**Backend**
- Migration **128** `slot_engine_settings(company_id PK→companies ON DELETE CASCADE, config jsonb, timestamps)` — idempotent, `updated_at` trigger (mirrors 125).
- `slotEngineSettingsQueries.js` (getByCompany / upsert ON CONFLICT / ensureSchema) + `slotEngineSettingsService.js` — `DEFAULTS`, `get` (row-or-defaults, per-key fallback, propagates DB error), `resolve` (safe-fail → DEFAULTS, never throws — engine path), `validate` (server-authoritative ranges: distance 1–100, overlap/buffer 0–240, horizon 1–14, shown 1–10 → 422 `INVALID_SETTINGS` + offending `field`), `save`, `buildConfigOverride`.
- `slotEngineService` now resolves per-company settings and builds the override from them (hardcode + `HORIZON_DAYS` removed; horizon comes from settings); existing safe-failure + base-coverage reporting preserved.
- Routes `GET`/`PUT /api/settings/slot-engine-settings` (`requirePermission('tenant.company.manage')`; `company_id` ONLY from `req.companyFilter`). GET uses `get` → a hard DB error surfaces **500** (UI shows defaults + "couldn't load" toast) rather than masking it.

**Frontend**
- `slotEngineSettingsApi.ts` (get/save + typed `SlotEngineSettingsError` carrying the server's 422 message/field; DEFAULTS + range mirrors for first-paint/load-failure).
- `RecommendationSettings.tsx` — Albusto card on **Settings → Technicians**, under the company base-address block: 3 number inputs (max distance / horizon / shown) + 2 minute-pickers (overlap, buffer) with `0/30/60/Custom` presets; Save dirty-gated, inline range hints, 422 → server message. The 2 fixed values are not shown.

**Tests:** `tests/slotEngineSettings.test.js` (44 — service / validate / queries / routes / migration) + `tests/slotEngineProxy.test.js` extended to 23 (config_override now built from resolved settings) = **67 passing**; frontend `npm run build` green. Reviewer **APPROVED** (multi-tenant scoping, safe-failure, override mapping, idempotent migration confirmed).

**Pending:** run migration 128 against prod + deploy.

## 2026-06-26 — ONWAY-001: «On the way» / ETA-уведомление клиента

Техник, выезжая на работу, жмёт главную CTA-кнопку **«On the way»** в карточке
работы → открывается окно с расчётным ETA и пресетами → по «Notify client»
клиенту уходит SMS, работа переходит в статус **«On the way»**, а сообщение
появляется в таймлайне переписки с клиентом. Прогон через оркестрацию
(Product → Architect → Spec → Test-cases → Planner → Implement → Test → Review).

### Новый статус работы «On the way» (FSM)
- Миграция `127_job_fsm_on_the_way.sql` — идемпотентно (по образцу `095`) внедряет
  состояние `On_the_way` в активную published SCXML-машину каждой компании:
  переходы **в** статус из Submitted/Rescheduled, **из** статуса → Visit completed/
  Canceled. Зеркала: `fsm/job.scxml`, seed `073`, hardcoded fallback
  `BLANC_STATUSES`/`ALLOWED_TRANSITIONS` в `jobsService.js`, цвет `#0EA5E9`.
- Чистый хелпер `fsm/onTheWayTransform.js` (`injectOnTheWay`) — DB-free путь для
  тестов; inline-SQL миграции byte-identical его выводу. Только additive (FSM-001
  не ломается). Без ZB-маппинга для нового статуса.

### Бэкенд (jobs router, requirePermission('messages.send'), company_id из req.companyFilter)
- `POST /api/jobs/:id/eta/estimate { origin:{lat,lng} }` → `{ eta_minutes|null }`
  (pure-read; `routeDistanceService.computePair`; null если нет origin/адреса/ключа).
- `POST /api/jobs/:id/eta/notify { eta_minutes }` → резолв телефона клиента
  (422 NO_PHONE) + sending-DID (MRU `sms_conversations` → `SOFTPHONE_CALLER_ID`,
  422 NO_PROXY) → `conversationsService.sendMessage` (wallet-gate внутри, пишется в
  таймлайн как outbound) → затем `updateBlancStatus('On the way')`; если статус не
  обновился после отправки → `{ ok:true, warning:'status_not_advanced' }` (SMS не
  откатываем). SMS: `Hi! Your technician {tech} from {company} is on the way and
  should arrive in about {eta} minutes.`

### Фронтенд
- `OnTheWayModal.tsx` — одна геолокация (`getCurrentPosition`, таймаут 8с); если
  координаты есть → показывает «Google ETA · ~N min», иначе «ETA unavailable —
  location is off». Плитки **10/15/20/30/45/60** + «Set custom time» (1–600);
  ровно один выбор; «Notify client» заблокирован до выбора и во время отправки
  (без дабл-сенда); коды ошибок → дружелюбные тосты.
- Главная CTA **«On the way»** в `JobStatusTags.tsx` показывается только для
  статусов Submitted/Rescheduled и при праве `messages.send`; после успеха —
  авто-рефреш карточки (`onNotified`→`afterMutation`).

Тесты: `tests/jobsEta.test.js` — **45/45** (estimate/notify контракты, NO_PHONE/
NO_PROXY/wallet/SMS-fail/status-after-send, мультитех, изоляция company_id, FSM
additive + идемпотентность transform). `tsc -b` green. Docs: requirements
(OW-R1..R7), architecture, спека `specs/ONWAY-001.md`, тест-кейсы, tasks.

⚠️ Деплой этой фичи требует применить миграцию **127** на проде (FSM-машины).

---

## 2026-06-26 — SLOT-ENGINE-001: UX-полировка пикера рекомендаций (Albusto)

Закрыт набор дефектов дизайн-критики поверх уже слитой фичи рекомендаций слотов
(движок не переделывался, архитектура/контракты/БД/мультитенант не менялись —
только UX/консистентность/копирайт). Прогон через оркестрацию (Product → Architect
→ Spec → Test-cases → Planner → Implement → Test → Review).

### Движок (slot-engine)
- **P0:** `explain(m)` теперь возвращает чистую английскую причину (раньше — русский
  текст с опечаткой «технік» в полностью английском UI, плюс дублировал
  дату/время/имя техника). Только плюсы: `tech already working nearby · little extra
  driving · comfortable schedule gap`; фолбэк `Good fit for this route`. Сигнатура
  упрощена до `explain(m)`, функция экспортируется для юнит-тестов.
- Тесты: новый `slot-engine/test/explain.test.js` (EXP-01..12) — английский-only,
  отсутствие кириллицы/snake_case/префикса, граничные пороги. `node --test` → 39/39.

### Фронтенд (CustomTimeModal — пикер слота)
- **Сигнал качества:** вместо сырых `score`+`confidence`+жаргона — тонкий
  вертикальный «температурный» мини-бар на кромке карточки (заполнение ∝ score,
  цвет по confidence: high→`--blanc-success`/Best match, medium→`--blanc-job`/Good
  fit, low→`--blanc-warning`/Worth a look). Голое число ушло с лица карточки в
  `title`/`aria-label` (для диспетчера).
- **Точность адреса:** `Dispatch confirm` → человеческое `Approx. address — confirm`
  (янтарная пилюля, только при `requires_dispatch_confirmation`).
- **Словарь:** панель `Suggested times` → `Recommended times`; пилюля
  скопированного техника `Suggested` → `Preselected`; рекомендации движка — везде
  `Recommended`. Убрана утечка snake_case `reason_codes` в фолбэке.
- **Пустой результат:** при включённом движке и нуле рекомендаций панель больше не
  исчезает молча — показывает `No nearby openings — try another day` (лесенка
  состояний: loading → unavailable → empty → list).
- **Тёплые токены Albusto** в таймлайне/date-nav/часовых метках/карте
  (`--muted-foreground`/`--border` → `--blanc-ink-3`/`--blanc-line`); удалены
  мёртвые dark-фолбэки.
- **Кнопки/доступность:** стрелки пагинации техников → `Button variant="ghost"
  size="icon"` (как стрелки даты); бэнды-рекомендации на таймлайне получили
  клавиатурную доступность (`role/tabIndex/onKeyDown`/`aria-label`); убраны эмодзи
  🕓🔧 из инфо-окна карты. Удалён мёртвый CSS `.ctm-timelines__dots/__footer/__legend*`.
- Инвариант: режим reschedule/edit не затронут (бар/панель/бэнды не рендерятся при
  `isNewJob===false`). `tsc -b` → green.

Docs: `requirements.md` (SE-UX-1..7 / AC-1..16), `architecture.md`, спека
`specs/SLOT-ENGINE-001-UX-POLISH.md`, тест-кейсы `test-cases/SLOT-ENGINE-001-UX-POLISH.md`,
`tasks.md` (PT-1..PT-5).

---

## 2026-06-24 — JOB-CREATE-001: Direct Job creation (one-form, Zenbooker-linked)

Jobs can now be created directly (previously only via lead→job conversion), from
a "+ New Job" button on the Jobs page. Single form, no steps, modeled on a phone
call: **Contact · Address · Time & technician · Work**. Creating a job still
creates the linked Zenbooker job (territory from ZIP, customer, address, service,
the picked slot + technician); on a Zenbooker failure the local job is kept and a
warning is surfaced. Built UI/UX-first — minimal fields only, no price/duration/
territory/internal fields.

### Backend
- `jobsService.createDirectJob(companyId, input)` — verify an existing contact
  (tenant-scoped) or dedupe-create, build the ZB payload, create the Zenbooker job
  (reuses `zenbookerClient.createJob` + `ensureAddressState`), persist the local
  job from the synced ZB detail; on ZB error persist a company-scoped local-only
  job and return `zb_warning` (real reason via `error.message`).
- `POST /api/jobs` — `requirePermission('jobs.create')`, company from
  `req.companyFilter`; returns `{ job_id, zenbooker_job_id, zb_warning }`.
- Tests `tests/jobsCreate.test.js` (8): permission gate, cross-company contact
  isolation, ZB-failure keeps local + warns, happy path.

### Frontend
- `NewJobDialog` — one-screen form reusing `AddressAutocomplete`, contact search
  (`contacts/search-candidates`), and the reschedule slot engine `CustomTimeModal`
  (one slot pick = arrival window + technician). `+ New Job` button on the Jobs
  page; `jobsApi.createJob`.

Merge-to-master only — not deployed (pending broader QA).

---

## 2026-06-14 — F018 / STRIPE-PAY-001: Stripe Payments — Phases 3–5

Completed the remaining phases on top of the Phase 1–2 foundation. Tap to Pay
on-device NFC remains blocked on a native/RN mobile shell (web-only SPA); its
backend is shipped so a mobile client can integrate without further backend work.

### Backend
- `stripeConnectProvider`: `createPaymentIntent` (direct-charge manual card),
  `createConnectionToken`, `createTerminalLocation`, `createTerminalPaymentIntent`
  (card_present), `cancelPaymentIntent`, `createRefund` (all with idempotency keys).
- `stripePaymentsService`: `createManualCardSession` (Phase 3), `getConnectionToken` /
  `createTapToPayIntent` / `cancelTerminalIntent` (Phase 4), `refundStripePayment` +
  idempotent `applyStripeRefund` (Phase 5). Webhook now handles `charge.refunded`
  (idempotent refund recording, invoice reversal) and `charge.dispute.created`
  (marks tx, audit). Manual-card/Tap-to-Pay success reconciles via the existing
  `payment_intent.succeeded` webhook path.
- Migration 111 `stripe_terminal_locations`; migration 112 seeds
  `payments.collect_keyed` / `payments.collect_terminal` to roles
  (admin/manager both; dispatcher keyed; provider terminal) + dev-mode list.
- Routes: invoice + job `stripe-manual-card-session` (`payments.collect_keyed`) and
  `tap-to-pay/payment-intent` (`payments.collect_terminal`); `routes/stripeTerminal.js`
  (`/connection-token`, `/payment-intents/:id/cancel`); `POST /api/payments/:id/stripe-refund`
  (`payments.refund`). Ledger `source` filter (`stripe`/`zenbooker`/`manual`).

### Frontend
- `utils/loadStripe.ts` (dependency-free Stripe.js loader, direct-charge stripeAccount);
  `components/invoices/ManualCardDialog.tsx` (Payment Element) wired into the Collect menu.
- Public `pages/PublicInvoicePayPage.tsx` at unauthenticated `/pay/:token` (added to
  `PUBLIC_AUTH_PATHS`); `InvoiceSendDialog` "Include payment link" toggle.
- TransactionsPage **Source** filter (Stripe/Zenbooker/Manual); refunds on Stripe
  payments routed through the Stripe refund endpoint in `useTransactions`.

### Tests
- `tests/stripePayments.test.js` now 26 passing (added manual-card session, terminal
  connection token, refund flow + refund idempotency, non-Stripe refund rejection).
  Frontend `tsc --noEmit` 0 errors. No billing/payments regressions.

### Still requires a mobile shell
- On-device Tap to Pay NFC UI (the web SPA cannot drive the Terminal SDK). Backend is
  ready: connection-token + card_present payment-intent + cancel endpoints.

---

## 2026-06-14 — F018 / STRIPE-PAY-001: Stripe Payments Marketplace (Phases 1–2)

Tenant customer payments via Stripe Connect (direct charges, no application fee),
delivered through the `orchestrate` pipeline. Extends PF004's canonical ledger,
reuses the F016 VAPI marketplace pattern, and stays fully separate from the
platform-billing Stripe code (ADR-001 / BILLING-UI). Tap to Pay and manual card
entry deferred; refunds/reporting are later phases.

### Backend
- Migrations 107–110: `stripe_connected_accounts`, `stripe_payment_sessions`,
  `stripe_webhook_events`, seed `stripe-payments` marketplace app; partial unique
  index `payment_transactions(company_id, external_id) WHERE external_source='stripe'`
  for ledger idempotency. Wired into `marketplaceQueries.ensureMarketplaceSchema`.
- `services/stripeConnectProvider.js` — zero-SDK Connect REST (account create,
  account links, getAccount, direct-charge Checkout Session with `Stripe-Account`
  header + idempotency key, `parseConnectWebhook` HMAC verify via a SEPARATE
  `STRIPE_CONNECT_WEBHOOK_SECRET`).
- `services/stripePaymentsService.js` — readiness state machine + gating,
  connect/onboarding/refresh/disconnect, invoice payment-link create/reuse/send,
  public Pay-now, and idempotent webhook → ledger sync via
  `paymentsService.createTransaction` (`external_source='stripe'`), invoice
  paid/partial via the canonical path. Tenant-scope verified by connected-account id.
- `db/stripePaymentsQueries.js`; `paymentsQueries.findByExternalSourceId` (idempotency).
- Routes: `routes/stripePayments.js` (`/api/stripe-payments/*`, `tenant.integrations.manage`),
  `routes/stripePaymentsWebhook.js` (raw body, no auth, mounted before `express.json`,
  separate from `/api/billing/webhook`), invoice payment-link endpoints in
  `routes/invoices.js` (`payments.collect_online` / `payments.view`), public
  `pay-info` / `pay` in `routes/public-invoices.js`. `src/server.js` mount-only.

### Frontend
- `pages/StripePaymentsSettingsPage.tsx` (Blanc design) — checklist, readiness
  panels, Connect/Resume/Refresh/Dashboard/Disconnect; `services/stripePaymentsApi.ts`.
- `pages/IntegrationsPage.tsx` — `stripe-payments` card → setup page (mirrors VAPI).
- `App.tsx` route `/settings/integrations/stripe-payments` (guard `tenant.integrations.manage`).
- `components/invoices/InvoiceDetailPanel.tsx` — split into **Collect payment**
  (send/copy Stripe link; card/Tap to Pay shown "soon") and **Record offline payment**.

### Tests
- `tests/stripePayments.test.js` — 20 passing: readiness state machine, webhook
  signature, event + ledger idempotency, tenant-scope rejection, link reuse, gating.
  No regressions to platform billing / payments suites (pre-existing env-dependent
  paymentsRoute failures unchanged).

### Follow-ups (not in this run)
- Public Pay-now has backend endpoints; a dedicated public pay page/CTA is a small
  frontend follow-up. Invoice send-dialog "Include payment link" toggle to be wired
  into the existing send dialog. Phases 3–5 (manual card, Tap to Pay, refunds,
  reporting filters) tracked in STRIPE-PAY-001.

## 2026-06-14 — SCHED-ROUTE-001: Schedule routes & address geocoding (SR-09…SR-12)

Completes the route-scheduling feature on top of the backend foundation
(migration 107, route engine, workers). Branch-only — NOT deployed; migrations
107 + 108 and the seed script run on prod only after explicit approval.

### Backend
- **C-3 tz-aware day filter** (`scheduleQueries.getScheduleItems`) — jobs/leads/
  tasks day boundaries are grouped in the company timezone (sargable `AT TIME
  ZONE` on the date bounds only) so the route day matches the visible day.
  Validated against ephemeral postgres (a 22:00-local job no longer leaks into
  the next UTC day).
- **Schedule read exposes geocoding state** — `lat/lng/normalized_address/
  geocoding_status` added to the unified UNION (jobs real, leads lat/lng, tasks
  null) plus a generated `google_maps_url`; zero Google calls on read.
- **SR-10 backfill** — migration 108 marks coord-bearing jobs
  `geocoding_status='success'` with no paid call (idempotent); `scripts/
  backfill-route-segments.js` seeds today+future tech-days per company-local tz
  via the idempotent `reconcileTechDay` (with `--dry-run`).

### Frontend
- Clickable Google Maps address on schedule cards (stopPropagation) + job
  detail panel; subtle geocoding hint (Locating… / Approx. / No location).
- Route connectors between consecutive jobs in List / Timeline-Week (stacked)
  and Timeline (hourly grid — leg label anchored to each card, pointer-events
  -none); shows `distance · duration` or a human status. Pure formatters in
  `utils/routeFormat.ts`. No client-side Google calls.
- New Job modal (title + AddressAutocomplete) on slot click → `createFromSlot`
  with address/coords (server skips paid geocode when coords present). Created
  unassigned by design (slot ids are ZenBooker ids, not crm_users.id).

### Tests
- SR-12 fills recalc edge cases: address-change re-stale+recalc, reconcile
  idempotency, multi-tech fan-out + before/after dedupe, schedule-read makes
  zero Google calls. Full suite 85/85 green. Frontend: `tsc` + production build
  clean (no frontend test runner in this project).

### Gap closure (SR-13…SR-16) — full implementation before deploy
- **FR-002 job location editing** — `PATCH /api/jobs/:id/location` +
  `jobsService.updateJobLocation`: edits the service address (and/or coords from
  AddressAutocomplete), sets `geocoding_status`, enqueues async geocode when an
  address arrives without coords, and recalcs the affected technician/day
  segments (capturing before-tech-days so a moved job repairs its old sequence).
  `/:id/coords` is now recalc-aware. Inline AddressAutocomplete editor added to
  the job detail Location section.
- **FR-001.4 assign-on-create** — NewJobModal passes the lane provider (ZenBooker
  shape); `createManualJob` resolves the internal crm_users.id mirror via the
  provider bridge, so a job created in a lane is both assigned and routed
  correctly (C-2).
- **C-12 ZenBooker best-effort sync** (enabled) — `FEATURE_ZENBOOKER_SYNC`
  (default ON) + async `zb_job_sync` agent: one-shot, dedupe-guarded (skips if a
  `zenbooker_job_id` already exists), stores the returned id, marks
  `jobs.zb_sync_status`, and never rolls back the local job on ZB failure.
  Migration 109 adds `jobs.zb_sync_status`.
- **C-13 retention** — `purgeStaleSegments(>30d)` + `pruneRouteCache(>180d)` +
  `scripts/purge-route-data.js` (`--dry-run`) so neither table grows unbounded.
- Tests: +10 gap cases (location edit, assign resolve, ZB dedupe/success/failure,
  flag default, retention SQL). Full SCHED-ROUTE-001 suite 95/95 green; migration
  109 idempotency verified on ephemeral postgres; frontend `tsc` + build clean.
- Known follow-up: distance units still `mi`-only (no company unit/locale field
  yet); ZB job-address PATCH not available in their API, so address edits on an
  already-synced job are recorded locally only.

---

## 2026-06-14 — AUTH-2FA-GATE: global 2FA re-verification gate (P1 lockout fix)

Functional testing of new-tenant signup found a P1 bug: the frontend had ZERO
handling of `401 PHONE_VERIFICATION_REQUIRED`, so a user with a verified phone
got locked out of the whole app (raw "HTTP 401") once the trusted-device cookie
expired (30d) or on a new device.

### Frontend
- `services/twoFactorGate.ts` — coordinator deduping concurrent 401s into one
  in-flight re-verification.
- `services/apiClient.ts` `authedFetch` — intercepts 401
  `PHONE_VERIFICATION_REQUIRED`, surfaces the gate, awaits re-trust, retries once.
- `components/auth/TwoFactorGate.tsx` — Blanc overlay; auto-sends a code to the
  user's stored phone (masked hint, no re-entry), 6-digit input + resend, verify
  -> trust-device (30d cookie) -> unblock. Mounted at App root.

### Confirmed (no change needed)
- Phone reuse across accounts already works (identity = email; trusted-device
  keyed by user.id; no phone uniqueness constraint or "in use" check).

### Backend
- Unchanged (authDevice.js endpoints already existed, 2FA-exempt).

### Validation
- tsc clean; browser E2E on prod (qa-test): gate -> auto-send -> resend -> verify
  -> trusted -> billing loaded seamlessly, no re-login; device stays trusted.

---

## 2026-06-13 — PAY-CONS-001: consolidate zb_payments into the canonical ledger (debt #6)

Zenbooker is the master payment system, so its data is authoritative. The legacy
`zb_payments` cache is now projected into the canonical `payment_transactions`
ledger, removing the dual-source read in analytics. `zb_payments` is kept as the
Zenbooker staging cache (the payments UI reads its denormalised fields).

### Backend
- Migration `104_consolidate_zb_payments_into_ledger.sql` — partial unique index
  `uq_payment_tx_external_zb (company_id, external_id) WHERE external_source='zenbooker'`
  + idempotent backfill of `zb_payments` → `payment_transactions`
  (`payment_method='zenbooker_sync'`, status mapped succeeded→completed /
  failed / voided, job resolved via `jobs.zenbooker_job_id`). Zenbooker-priority
  on conflict. Does NOT touch `fact_payments`/marts (external /pulse ETL).
- `zenbookerPaymentsSyncService.projectCompanyLedger(companyId)` — write-through
  called after each sync so the ledger stays current (idempotent, non-fatal).
- `analyticsService.listJobs` now reads only `payment_transactions` with
  Zenbooker-priority (prefer `zenbooker_sync` rows when present, else native);
  the `zb_payments` fallback is gone.

### Validation (prod-data copy)
- Backfill 1027 rows; ran twice — idempotent. Per-job paid totals **0/1164
  mismatches** vs the legacy path; grand total $197,253.26 identical to the cent.
- Write-through projection re-verified independently: 1027 rows, ledger total =
  zb succeeded total.

### Tests
- `tests/paymentsConsolidation.test.js` — projection SQL (Zenbooker-priority
  upsert, status mapping, company scope) + analytics single-source read. Full
  suite: 699 pass, 22 pre-existing failures unchanged (no new regressions).

### Decisions (owner-confirmed mapping; recommended defaults elsewhere)
- Master = Zenbooker → zb data wins on conflict (owner, 2026-06-13).
- Keep `zb_payments` as staging (not dropped) — reversible, UI depends on it.
- `fact_payments`/marts untouched (fed externally).

---

## 2026-06-13 — ARM-001: faithful AR-config → rules migration (debt #3)

Closes the un-blocked half of refactor debt #3 so flipping
`FEATURE_RULES_ENGINE_AR` on prod no longer silently resets customised
action-required behaviour.

### Backend
- `ruleActions.create_task` now accepts `sla_minutes` → computes a relative
  `due_at` (an explicit `due_at` still wins). Carries the legacy AR
  `task_sla_minutes` faithfully.
- `rulesSeed.js` refactored around a shared `buildRulesFromConfig(config)`:
  - `seedDefaultRules` — static defaults for fresh companies, `ON CONFLICT DO
    NOTHING` (never clobbers admin edits).
  - `migrateCompanyARConfig` — reads the company's real
    `action_required_config` (priority / SLA / enabled) and upserts the system
    rules `DO UPDATE` (authoritative cutover).
- `POST /api/automation/rules/migrate-ar` (`tenant.company.manage`) triggers the
  per-company cutover.
- `voicemail` trigger intentionally not migrated — no domain-event source yet
  (documented in REFACTOR-REPORT §7).

### Tests
- `tests/arConfigMigration.test.js` — 8 tests: config→rule mapping (custom
  priority/SLA, disabled propagation, legacy defaults), `migrate-ar` DO UPDATE +
  scope, `seed-defaults` DO NOTHING, and `create_task` SLA→dueAt (relative,
  explicit-wins, null). Existing `automationE2E` still green. Full suite: 696
  pass, 22 pre-existing failures unchanged (no new regressions).

### Still open (not done tonight)
- Debt #3 physical removal: gated on prod verification of
  `FEATURE_RULES_ENGINE_AR` (no deploy per owner).
- Debt #5 (Redis/BullMQ queue): deferred until load grows.
- Debt #6 (`payment_transactions`↔`zb_payments` consolidation): needs owner
  sign-off on mapping semantics — analytics-regression risk.

---

## 2026-06-12 — BILLING-UI: subscription & billing cabinet (tenant-admin)

UX-first subscription cabinet at `/settings/billing` (`tenant.company.manage`),
completing the Stripe foundation from ADR-001 / commit 588c0d8.

### Frontend
- New `frontend/src/pages/BillingPage.tsx` — owner-facing cabinet on the Blanc
  design system: plan + status (trial "N days left", human "Free until <date>"),
  this-month usage bars (Text messages / Call minutes / Automations run) with
  green/amber/red thresholds against per-plan allowances, plan cards with Stripe
  Checkout upgrade, and an invoice list (date · amount · status · hosted link).
  No technical IDs (customer_id / subscription_id) surfaced.
- `frontend/src/services/billingApi.ts` client; route in `App.tsx`; "Billing"
  entry in the settings nav (`appLayoutNavigation.tsx`).
- Degraded mode: when online payments aren't enabled, upgrade buttons disable
  with an explanatory note; status/usage/invoices still render.

### Backend
- Migration `103_billing_included_units.sql` — `billing_plans.included_units`
  jsonb allowances (sms / call_minutes / agent_runs) backfilled for
  trial/starter/pro. Idempotent; verified on a prod-schema copy.
- `billingService.getInvoices`, `providerConfigured`; `GET /api/billing` now
  returns `invoices` + `billing_enabled`; new `GET /api/billing/invoices`.
- `routes/billingWebhook.js` — Stripe webhook (raw body, no auth, signature
  verified), mounted in `src/server.js` before `express.json` (path-scoped, no
  effect on other routes).
- `createCheckout` returns 422 `PROVIDER_NOT_CONFIGURED` when `STRIPE_SECRET_KEY`
  is absent (degraded mode).
- `bootstrapCompany` starts the 14-day trial on signup (idempotent, non-blocking).
- Hardened `stripeProvider.parseWebhook`: length-guard before `timingSafeEqual`
  (a malformed signature now rejects cleanly instead of throwing `RangeError`)
  and a try/catch around `JSON.parse`.

### Tests
- `tests/billingUI.test.js` — 8 tests: trial start idempotency, usage/invoice
  mapping + tenant scope, degraded-mode 422, webhook signature accept/reject,
  route isolation. Full suite: no new regressions vs `master` (22 pre-existing
  failures unchanged, unrelated to billing).

---

## 2026-06-03 — CRM-SALES-MCP Stage 6 Testing and Rollout

### Backend
- Mounted `/api/crm` and `/api/crm/mcp` in `src/server.js` behind `authenticate, requireCompanyAccess`.
- Mounted public `/mcp/crm` transport separately with token/env-context guards.
- Hardened MCP error detail sanitization so arrays containing objects are redacted instead of leaking nested data.

### Tests
- Added rollout gate coverage for CRM/MCP route mounts, 401/403 behavior, tenant isolation SQL scopes, write permission gates, no delete tools, secret redaction, stale activity queries, slippage/history calculations, and predefined Sales workflow lists.
- Full rollout run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Stage 5 Sales Workflow Selections

### Backend
- Added `crm.list_sales_workflows` discovery metadata for ready-made Sales workflow selections.
- Centralized Sales workflow keys and defaults in `crmListsService`.
- Exposed explicit read-only MCP workflow aliases for my open deals, closing this month/quarter, deals without activity, deals without next step, risky deals, top accounts by pipeline, accounts needing follow-up, contacts missing role/title/email, and tasks due this week.
- Changed `crm.find_deals_without_activity` to support the workflow default inactivity window when `days` is omitted.
- Made `tasks_due_this_week` use the current calendar week instead of a rolling seven-day window.
- Closed Stage 5 gaps: workflow date windows now use company timezone, `my_open_deals` requires current actor scope and rejects cross-owner scope, and invalid explicit `days` values are no longer masked by defaults.

### Tests
- Full CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Stage 4 Write Tools

### Backend
- Added typed MCP write tools for the allowed update surface: `deal.next_step`, `deal.stage`, `deal.forecast_category`, `deal.close_date`, `deal.amount`, `deal.risk_summary`, `deal.competitor`, and `task.status`.
- Kept writes routed through CRM services so tenant scope, allowlist checks, before/after responses, request id propagation, and audit logging stay centralized.
- Added runtime schema support for `number` and nullable typed write values; `amount` rejects negative/non-number values and `close_date` rejects invalid calendar dates before dispatch.
- Closed Stage 4 gaps: executor now generates `crm-mcp-*` request ids when upstream context is missing, generic `crm.update_deal_field` validates `value` by selected field, create task/note write tools return before/after envelopes, and empty `forecast_category` clears to `null`.
- Confirmed no bulk/delete MCP tools are registered.

### Tests
- Full CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Cross-stage Audit

### Backend
- Verified Stage 0-3 CRM/MCP alignment across `/api/crm`, MCP registry/executor, public/SSE/stdio transports, read-only tools, and pipeline/forecast analytics.
- Tightened MCP runtime schema validation so required typed fields reject `null`; nullable typed write values remain allowed only for explicit field clearing.
- Confirmed registry has 40 read tools and 11 write tools; all write tools require confirmation and `sales.crm.write`; no bulk/delete tools are registered.

### Tests
- Targeted CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-05-10 — INV-001 Invoices MVP (with manual payment recording)

### Goal
Allow users to create invoices from approved estimates with full UX parity to the new estimate detail panel (inline edit, auto-save, item search combobox, document-templates PDF). Manual payment recording reflects directly in invoice status and balance.

### Backend
- Migration `backend/db/migrations/086_document_templates_invoice.sql`: extends `document_templates.document_type` CHECK to `('estimate','invoice')` and seeds a default invoice template per company.
- `backend/src/services/documentTemplates/factory.js`: added `INVOICE_FACTORY` with the teal accent (`#0f766e`) to visually distinguish invoices from estimates. **Terms & Warranty body is now shared with estimates** (`DEFAULT_INVOICE_TERMS = DEFAULT_TERMS_AND_WARRANTY`) per product spec.
- `backend/src/services/documentTemplates/invoiceAdapter.js`: renderer adapter for `document_type='invoice'`, registered alongside the estimate adapter in `documentTemplates/index.js`.
- `backend/src/services/documentTemplates/invoicePdfDocument.js`: react-pdf Document mirroring estimate layout. Section headings: "Summary", "Items", "Totals", "Terms & Warranty". Totals additionally show Amount paid (green), Balance Due with status badge (PAID / PARTIALLY PAID / OVERDUE / AMOUNT DUE / VOID).
- `backend/src/services/invoicesService.js`: added `generatePdf(companyId, id)`; `updateInvoice` now recalculates totals when `tax_rate` or `discount_amount` change.
- `backend/src/db/invoicesQueries.js`: `updateInvoice` allowedFields now includes `discount_amount`.
- `backend/src/routes/invoices.js`: replaced 501 PDF stub with working `GET /:id/pdf`. Added `getCompanyId(req)` helper and applied to every route (fix for a latent bug — old code read `req.companyId` which was never set by middleware). `POST /:id/sync-items` falls back to the invoice's linked `estimate_id` when body is empty.

### Frontend
- Rewrote `frontend/src/components/invoices/InvoiceDetailPanel.tsx` for full UX parity with `EstimateDetailPanel`:
    - Two-column layout (main + aside); header shows invoice number (linked to Job when present), status, Balance Due / Total.
    - Inline auto-save (no separate editor dialog) via `updateInvoice` + optimistic state.
    - Summary section (Notes field, labeled "Summary") with pencil-to-edit dialog (reuses `EstimateSummaryDialog`).
    - Items list with pencil-edit + trash-delete; per-item dialog reuses `EstimateItemDialog`.
    - `ItemPresetSearchCombobox` for adding items (shared catalog with estimates via `estimate_item_presets`).
    - Inline editable Tax rate, Discount, Due date, Payment terms.
    - **Manual payment recording** is behind a footer button → opens a `Popover` with Amount + Full-balance shortcut + Method (Card / Cash / Check / ACH / Other) + Submit. Recording immediately refreshes invoice totals, balance, and status.
    - "Preview PDF" button opens `/api/invoices/:id/pdf` in a new tab.
- `frontend/src/pages/InvoicesPage.tsx`: switched `FloatingDetailPanel` to `wide`; passes `onChanged` to refresh the list; added `?openId=<id>` URL param handler that auto-opens an invoice on arrival.
- `frontend/src/components/estimates/EstimateDetailPanel.tsx`: fixed missing `FileText` icon import; `Create Invoice` button now navigates to `/invoices?openId=<id>` so the new invoice opens automatically.
- `frontend/src/services/invoicesApi.ts`: corrected endpoint paths (`record-payment`, `sync-items`) to match backend routes.

### Decisions
- **PDF via F015 document templates**, not the legacy hardcoded builder. One adapter per document type; per-tenant customization is through stored descriptors.
- **Shared item catalog** between estimates and invoices via `estimate_item_presets` (table name kept to avoid migration churn; data is genuinely per-company shared).
- **Manual payment recording only** — no payment-gateway integration in this iteration. Recorded payments are stored as `invoice_events` of type `payment_recorded` plus immediate `amount_paid` / `balance_due` / `status` updates.
- Invoices share Terms & Warranty text with estimates — companies want one canonical warranty disclosure across both documents.

---

## 2026-05-07 — TWC-001 Twilio API Client Singleton

### Backend
- Added `backend/src/services/twilioClient.js` — process-wide lazy singleton via `getTwilioClient()`. One `twilio(sid, token)` instance per process; one `https.Agent` keep-alive pool toward `api.twilio.com`.
- Removed per-call `twilio(sid, token)` instantiation in `backend/src/services/reconcileStale.js`, `backend/src/services/callAvailability.js`, `backend/src/services/inboxWorker.js`, and `backend/src/routes/phoneSettings.js` — all now resolve the client lazily via `getTwilioClient()`.
- Migrated existing module-level singletons in `backend/src/services/conversationsService.js`, `backend/src/services/twilioSync.js`, and `backend/src/services/reconcileService.js` to thin lazy `Proxy` wrappers around `getTwilioClient()`. Public surface (`client.calls`, `client.conversations`, etc.) unchanged at every call site.
- Webhook signature validation (`backend/src/webhooks/twilioWebhooks.js`, `backend/src/webhooks/conversationsWebhooks.js`, `src/routes/webhooks.js`) and JWT minting (`backend/src/services/voiceService.js`) untouched — they use static `twilio.validateRequest` / `twilio.jwt.AccessToken` factories, not REST clients.

### Documentation
- Added requirement TWC-001 to `docs/requirements.md` (resource NFRs, multi-tenant scope guard).
- Added architecture section TWC-001 to `docs/architecture.md` (module map, failure modes, operational acceptance check).
- Added spec `docs/specs/TWC-001-twilio-client-singleton.md`.
- Added test cases `docs/test-cases/TWC-001-twilio-client-singleton.md` (9 cases, 5 P0 / 3 P1 / 1 P2).
- Added task plan to `docs/tasks.md`.

### Tests / Verification
- Added `tests/services/twilioClient.test.js` — 5 unit tests (singleton identity, lazy init, missing-env errors, recovery after env becomes available).
- Added `tests/services/twilioClient.regression.test.js` — guard against re-introducing per-request `twilio(process.env...)` in the four hot-spot files.
- Added `tests/services/twilioClient.bootstrap.test.js` — confirms requiring Twilio-using modules without `TWILIO_*` env does not throw.
- All 16 new tests pass. Adjacent suites verified green: `tests/zenbookerSyncService.test.js`, `tests/routes/integrations-analytics.test.js`, `tests/middleware/integrationScopes.test.js`.

### Decisions
- Singleton is process-global only. Per-tenant Twilio credentials (analogue of `getClientForCompany` in `zenbookerClient.js`) are out of scope for TWC-001.
- Deferred: custom `https.Agent` tuning. Twilio SDK defaults are sufficient once a single agent is shared across the process.

### Operational acceptance (post-deploy on `abc-metrics`)
- Steady-state outbound HTTPS connections to Twilio CloudFront should drop from ~199 to ≤20.
- CLOSE_WAIT count should drop from ~28 to ≤5.
- No expected change in node memory footprint or in Twilio API behavior at call sites.

---

## 2026-04-27 — PF002-R2 Estimates Composer Refresh

### PDF Generation
- Implemented `GET /api/estimates/:id/pdf` for client-facing estimate PDFs.
- PDF output includes ABC Homes company details, customer/job context, Summary, items, totals, default Terms & Warranty, and ACH payment details.
- Added `PDF` action to estimate detail and `tests/estimatePdfService.test.js`.

### Product / UX
- Reworked estimates around Lead/Job-context creation rather than global creation.
- Added Summary-before-items flow, Add custom item dialog, client-facing Preview, read-only default Terms & Warranty, discount controls, signature toggle, and disabled `Deposit required: No`.
- `/estimates` is now a searchable list/detail workspace with `Only Open / All` archive visibility, not a global create surface.

### Backend
- Added migration `082_pf002_r2_estimates_refresh.sql` for `summary`, discount type/value, archive fields, approved snapshots, signature fields, estimate sequence, and future Price Book item references.
- Rebuilt estimate queries/service/routes around `approved`, archive/restore, non-mutating send stub, decline reason, company-scoped Lead/Job numbering, and draft reset after edits.
- Portal document access now rejects archived estimates.

### Frontend
- Updated `estimatesApi` types/actions for `approved`, archive/restore, Summary, discount type/value, and signature fields.
- Rebuilt editor/detail/send/preview components and integrated them into Lead/Job Financials plus `/estimates`.

### Tests
- Added `tests/estimatesLifecycleR2.test.js`.
- Updated `tests/estimatesConvert.test.js` from `accepted` to `approved`.
- Targeted estimate tests pass; frontend production build passes. Full Jest still has pre-existing unrelated failures in payments/Twilio worker/webhook/state-machine suites.

---

## 2026-04-22 — F014: Ads Analytics Microservice

### New Feature
- **External read-only analytics API** for Google Ads / ABC Homes weekly reporting
- 4 token-authenticated endpoints under `/api/v1/integrations/analytics/*`:
  - `GET /summary` — aggregated funnel metrics (calls → leads → jobs → revenue)
  - `GET /calls`, `GET /leads`, `GET /jobs` — paged raw rows for drill-down
- New scope `analytics:read` — keeps Ads reporting key isolated from `leads:create`
- Period in `America/New_York` (ABC Homes TZ); hard cap 92 days
- Default tracking DID `+16176444408`; overridable via `tracking_number` query param

### Database
- Migration 080: `COMMENT ON COLUMN api_integrations.scopes` — no-op DDL marker documenting the canonical scope list (`leads:create`, `analytics:read`)

### Backend
- `backend/src/services/analyticsService.js` — `getSummary`/`listCalls`/`listLeads`/`listJobs` with shared CTE trio `tracked_calls → period_leads → attributed_leads`
- `backend/src/routes/integrations-analytics.js` — 4 GET endpoints mirroring `integrations-leads` middleware chain (`rejectLegacyAuth → validateHeaders → authenticateIntegration → rateLimiter`) + `requireScope('analytics:read')` guard
- `src/server.js` — 3-point patch (require, mount at `/api/v1/integrations`, boot log)
- `backend/scripts/issue-analytics-key.js` — CLI to generate and persist `analytics:read` API keys (peppered SHA-256 hash, secret printed once)

### Tests
- `tests/routes/integrations-analytics.test.js` — 11 tests (happy path, 403 scope, 400 validation pass-through, 500 on unexpected, paged list endpoints)
- `tests/services/analyticsService.test.js` — 4 tests for pure helpers (`parsePeriod` cases, `normalizePhone` cases)
- Full Jest run: **15 / 15 passing**

### Docs
- Added F014 entry to `docs/requirements.md`
- Added F014 slice to `docs/architecture.md`
- Added `docs/test-cases/F014-ads-analytics-microservice.md`
- Added F014 task breakdown (8 tasks) to `docs/tasks.md`

---

## 2026-04-17 — F013 Schedule Finalization Sprint Scope

### Documentation
- Создан consolidated closing spec: `docs/specs/F013-schedule-finalization-sprint.md`
- Создан test-cases пакет: `docs/test-cases/F013-schedule-finalization-sprint.md`
- В `docs/feature-backlog.md` schedule gap больше не размазан по старым `F013` sprint-итерациям
- В `docs/current_functionality.md` schedule updated как implemented core + one remaining finalization sprint

### Product Planning Decision
- Все оставшиеся недоработки `F013 Schedule` сведены в один sprint scope
- После завершения этого scope `F013` должен считаться закрытым
- Дальнейшие schedule-улучшения должны идти уже отдельными enhancement-пакетами

---

## 2026-04-17 — EMAIL-001 Implementation (Full Stack)

### Backend
- Created migration `079_create_email_tables.sql`: 5 tables (`email_mailboxes`, `email_threads`, `email_messages`, `email_attachments`, `email_sync_state`), 12 indexes, 4 triggers
- Created `backend/src/db/emailQueries.js`: full CRUD + sync queries with tenant isolation
- Created `backend/src/services/emailMailboxService.js`: AES-256-GCM token encryption, HMAC-signed OAuth state, mailbox lifecycle
- Created `backend/src/routes/email-settings.js`: 4 settings endpoints (GET status, POST connect, POST disconnect, POST sync)
- Created `backend/src/routes/email-oauth.js`: public Google OAuth callback with state validation
- Created `backend/src/services/emailSyncService.js`: Gmail backfill, incremental history sync, interval scheduler
- Created `backend/src/services/emailService.js`: raw MIME send/reply, sent-message hydration, attachment proxy
- Created `backend/src/routes/email.js`: 7 workspace endpoints (mailbox, threads, thread detail, mark-read, compose, reply, attachment download)
- Modified `src/server.js`: mounted 3 route groups + email sync scheduler at boot

### Frontend
- Created `frontend/src/services/emailApi.ts`: typed API wrapper for all email endpoints
- Created `frontend/src/pages/EmailSettingsPage.tsx`: mailbox status, connect/reconnect/disconnect, manual sync
- Created `frontend/src/pages/EmailPage.tsx`: three-pane workspace (rail, thread list, thread detail)
- Created email components: `MailboxRail`, `EmailThreadList`, `EmailThreadRow`, `EmailThreadPane`, `EmailMessageItem`, `EmailComposer`
- Modified `frontend/src/App.tsx`: added `/settings/email` and `/email` routes
- Modified `frontend/src/components/layout/appLayoutNavigation.tsx`: added Email to Settings dropdown

### Tests
- Created 3 test suites (41 tests): `emailMailboxService.test.js`, `emailSyncService.test.js`, `email.test.js`
- Coverage: encryption round-trip, OAuth state signing, parsing helpers, route guards, CRUD operations

### Dependencies
- Added `googleapis` npm package

---

## 2026-04-17 — EMAIL-001 Pipeline Docs

### Architecture
- В `docs/architecture.md` добавлен полноценный architecture slice для `EMAIL-001`.
- Зафиксированы:
  - отдельные backend routes/services/query-layer для Gmail mailbox, sync и `/email`
  - отдельная `email_mailboxes` persistence layer для encrypted OAuth credentials
  - локальная thread/message/attachment sync-модель вместо live-only Gmail reads
  - отдельный `/email` workspace без изменения top-level navigation

### Spec / Test Cases / Tasks
- Создан новый spec: `docs/specs/EMAIL-001-gmail-shared-mailbox-workspace.md`
- Создан новый test-cases файл: `docs/test-cases/EMAIL-001-gmail-shared-mailbox-workspace.md`
- В `docs/tasks.md` добавлен полный task breakdown для `EMAIL-001`:
  - migration
  - OAuth/settings
  - sync service
  - send/reply service
  - backend routes
  - frontend settings page
  - `/email` workspace UI
  - verification

### Requirements Alignment
- В `docs/requirements.md` уточнён persistence slice:
  - `company_settings` оставлен для non-secret email prefs / UI metadata
  - добавлена отдельная `email_mailboxes` table для mailbox state и secure token storage

## 2026-04-16 — EMAIL-001 Requirements Alignment

### Documentation
- В `docs/requirements.md` добавлен новый formalized requirement `EMAIL-001: Gmail Shared Mailbox + Email Workspace`.
- Зафиксированы продуктовые решения для первой итерации:
  - отдельный route `/email`, без выноса в top navigation
  - отдельная settings page для подключения Gmail в `Settings`
  - один shared Gmail mailbox на компанию
  - scope v1 ограничен `send / receive / thread / search / attachments`
  - personal mailbox, delegated access, comments, shared drafts, assignment, snooze/later/done остаются вне scope

### Backlog
- В `docs/feature-backlog.md` обновлён email-эпик:
  - вместо `Email in Pulse` теперь зафиксирован отдельный `Gmail shared mailbox + /email workspace`
  - сохранена связь с текущими `Pulse`/Contacts/Leads/Jobs через deep-links, без слияния email в существующий `Pulse` timeline на этой фазе

## 2026-04-16 — Backlog Status Refresh

### Documentation
- Актуализирован `docs/feature-backlog.md` под фактическое состояние продукта на 2026-04-16.
- Добавлены:
  - legend по статусам `done / partial / planned`
  - отдельный status-summary по backlog-эпикам
  - обновлённый раздел "Что уже есть как база"
- Стало явно видно, что уже не является чистым backlog:
  - `Schedule` уже в активной разработке
  - `Estimates / Invoices / Transactions` уже существуют как реальные routes/pages
  - `Client Portal` уже имеет backend/API foundation
  - `AI communication` уже частично реализован через summary/transcript/polish
  - `Automation`, `Tasks`, `Voicemail`, `Phone ops` имеют partial baseline, а не zero-state

### Current Functionality
- Обновлён `docs/current_functionality.md`
- Добавлен новый раздел с кратким статусом более новых модулей:
  - `Schedule`
  - `Estimates / Invoices / Transactions`
  - `Client Portal foundation`
  - `Company / Admin / Territory management`
  - `Workflow editor / FSM builder`


## 2026-04-15 — RL-001: Routing Logs — Real Data + Day Grouping

### Improvement
- **Routing Logs page** (`/settings/telephony/routing-logs`) now displays real call data from `GET /api/calls` instead of mock data
- **Day grouping** — calls grouped by date with Pulse-style DateSeparator headings (no lines)
- **Redesigned UI** — Blanc design system: call rows with direction icons, contact names, result badges, duration, time
- **Detail panel** — click a call to see session ID, flow path, and latency
- **200 most recent calls** loaded by default

### Files Modified
- `frontend/src/pages/telephony/RoutingLogsPage.tsx` — full rewrite with day grouping and Blanc design
- `frontend/src/services/telephonyApi.ts` — `listLogs()` now calls real `/api/calls` endpoint, maps to `RoutingLogEntry`
- `frontend/src/types/telephony.ts` — added `direction` and `contact_name` fields to `RoutingLogEntry`

---

## 2026-04-15 — SCHED-LIST-001: Schedule List View

### New Feature
- **List view mode** for Schedule page — vertical job lists per technician column
- Jobs grouped by day with Pulse-style DateSeparator headings (no lines/borders)
- Each job tile shows time slot (start – end) via existing `ScheduleItemCard`
- Provider columns sorted alphabetically, "Unassigned" always last
- Empty days are not rendered (no empty headings)
- DnD reassign between provider columns supported
- Week-based navigation (same as Team Week view)

### Files Added
- `frontend/src/components/schedule/ListView.tsx` — new list view component

### Files Modified
- `frontend/src/hooks/useScheduleData.ts` — added `'list'` to ViewMode, dateRange, navigateDate
- `frontend/src/components/schedule/CalendarControls.tsx` — added List to VIEW_OPTIONS and getDateLabel
- `frontend/src/pages/SchedulePage.tsx` — added `case 'list'` with ListView import

---

## 2026-04-15 — IMG-001: Fullscreen Image Viewer

### New Feature
- **Shared fullscreen image viewer** (lightbox) component at `frontend/src/components/shared/FullscreenImageViewer.tsx`
- Opens on click in AttachmentsSection preview area (Telegram-like UX)
- Arrow key navigation between images, side buttons
- 90-degree rotation with scale compensation for sideways images
- Thumbnail strip at bottom, body scroll lock
- Close via Escape / backdrop click / X button
- Open original in new tab

### Files Added
- `frontend/src/components/shared/FullscreenImageViewer.tsx` — exports `FullscreenImageViewer`, `RotatableImage`

### Files Modified
- `frontend/src/components/payments/PaymentDetailPanel.tsx` — removed inline `FullscreenViewer` + `RotatableImage`, imports from shared

---

## 2026-04-06 — ELK-LAYOUT-001: Production ELK Layered Auto Layout

### Improvement
- **Replaced basic ELK layout** with production-grade `layoutWithElkLayered()` per `elk_layered_auto_layout_spec.md`
- **Layer constraints**: Root/initial nodes → FIRST_SEPARATE (top), Final nodes → LAST_SEPARATE (bottom)
- **Improved config**: ORTHOGONAL edge routing, NETWORK_SIMPLEX layering, BRANDES_KOEPF node placement, TWO_SIDED greedy switch, PREFER_NODES model order
- **Real node sizes**: Uses `node.measured.width/height` with 220×72 fallback (was hardcoded 200×60)
- **Stable ordering**: Nodes sorted by `data.order` then `id` before layout for deterministic results
- **Port support**: Multi-handle nodes use ELK ports with FIXED_ORDER constraint
- **Disconnected components**: `elk.separateConnectedComponents = true`
- **fitView after layout**: Canvas auto-fits viewport after layout recalculation via `ReactFlowInstance.fitView()`

### Files Changed
- `frontend/src/utils/workflowElkLayout.ts` — Full rewrite (spec-compliant `layoutWithElkLayered`)
- `frontend/src/pages/workflows/WorkflowBuilderPage.tsx` — `useReactFlow` instance for fitView, updated layout calls

---

## 2026-04-06 — Visual Workflow Builder

### New Feature
- **Full-screen visual FSM editor** at `/settings/workflows/:machineKey` replacing embedded Monaco editor
- **@xyflow/react canvas** with custom WorkflowStateNode, WorkflowFinalNode, WorkflowInsertableEdge components
- **Inspector sidebar** (300px): Flow properties, State inspector, Transition inspector with full SCXML attribute editing
- **SCXML codec**: Bidirectional `scxmlToGraph()` / `graphToScxml()` conversion
- **Toolbar**: Undo/Redo, Auto Layout, Add State, Validate, Save, Publish, Export
- **Edge insertion**: "+" button on edge hover to splice new states
- **Edge healing**: Deleting a node reconnects incoming→outgoing edges

### Files Added
- `frontend/src/pages/workflows/WorkflowBuilderPage.tsx`
- `frontend/src/pages/workflows/workflowScxmlCodec.ts`
- `frontend/src/pages/workflows/workflowNodeTypes.tsx`
- `frontend/src/pages/workflows/workflowInspectors.tsx`
- `frontend/src/utils/workflowElkLayout.ts`

### Files Modified
- `frontend/src/App.tsx` — Route `/settings/workflows/:machineKey`
- `frontend/src/components/workflows/MachineList.tsx` — Navigate to full-screen builder
- `frontend/src/pages/LeadFormSettingsPage.tsx` — Simplified Workflows tab

---

## 2026-04-06 — FSM-001: FSM/SCXML Workflow Editor

### New Features
- **SCXML-based workflow engine** replacing hardcoded status constants for Jobs and Leads
- **Admin Workflow Editor** (tab inside Lead & Job Settings):
  - Monaco SCXML editor with live diagram preview via state-machine-cat
  - Validation with error/warning display and click-to-navigate
  - Draft/Publish version management with audit logging
  - Version history with restore capability
- **Dynamic action buttons** (ActionsBlock) in Job cards driven by published SCXML transitions
- **Manual status override** for users with `fsm.override` permission
- **Feature flags**: `FSM_EDITOR_ENABLED`, `FSM_PUBLISHING_ENABLED` (default: true)

### Database
- Migration 072: `fsm_machines`, `fsm_versions`, `fsm_audit_log` tables
- Migration 073: Seed Job and Lead FSM machines per company
- Migration 074: FSM permission roles (`fsm.viewer`, `fsm.editor`, `fsm.publisher`, `fsm.override`)

### Backend
- `backend/src/services/fsmService.js` — SCXML parser, validator, CRUD, runtime (transition resolution, action filtering, caching)
- `backend/src/routes/fsm.js` — 12 API endpoints (read, write, runtime)
- `jobsService.js` — FSM delegation with hardcoded fallback
- `leadsService.js` — FSM validation on status changes with fallback

### Frontend
- `WorkflowEditor.tsx` — Split-pane SCXML editor + diagram preview
- `DiagramPreview.tsx` — SCXML→smcat→SVG rendering with zoom/pan
- `MachineList.tsx` — Machine selector in Workflows tab
- `ProblemsPanel.tsx` — Validation errors/warnings display
- `VersionHistory.tsx` + `PublishDialog.tsx` — Modals
- `ActionsBlock.tsx` — Dynamic FSM-driven action buttons with confirmation dialogs
- `useFsmEditor.ts` + `useFsmActions.ts` — React Query hooks

### Tests
- 98 tests (58 parser/runtime unit tests + 40 API integration tests) — all passing

### Dependencies
- Backend: `fast-xml-parser`
- Frontend: `@monaco-editor/react`, `state-machine-cat`


## 2026-05-09 — F015: Document Templates Customization (estimates)

**Added**
- New backend module `backend/src/services/documentTemplates/` with factory descriptor (estimate), inline JSON-Schema validator (no Ajv dep), renderer registry, and estimate adapter.
- DB layer `backend/src/db/documentTemplatesQueries.js`; service `backend/src/services/documentTemplatesService.js` with `resolveTemplate`, list/get/update/reset.
- REST API at `/api/document-templates` (list, get, update, reset, factory, preview), mounted in `src/server.js` behind `tenant.integrations.manage` (P0; dedicated `tenant.documents.manage` to follow).
- Migration `backend/db/migrations/084_create_document_templates.sql` — table + unique partial index for one default per (company, document_type) + idempotent factory seed per existing company.
- Frontend Settings: `pages/DocumentTemplatesPage.tsx` (list grouped by document type), `pages/DocumentTemplateEditorPage.tsx` (form-based editor: brand / theme / sections visibility / Terms & Warranty Markdown / reset). Routes `/settings/document-templates[/:id]`. Typed API client in `services/documentTemplatesApi.ts`; types in `types/documentTemplates.ts`.

**Changed**
- `backend/src/services/estimatePdfService.js` now accepts an optional `descriptor` parameter (DocumentTemplateDescriptor v1); falls back to factory when omitted; legacy exports `COMPANY_PROFILE` and `DEFAULT_TERMS_AND_WARRANTY` preserved (now derived from factory). Section rendering iterates `descriptor.sections` honoring per-section `visible` flag.
- `backend/src/services/estimatesService.js#generatePdf` resolves the company's default template via `documentTemplatesService.resolveTemplate('estimate')` and passes it to the renderer.

**Tests**
- `tests/services/documentTemplatesService.test.js` — validator + service unit tests (12 cases).
- `tests/services/estimatePdfRendererTemplate.test.js` — renderer integration: factory fallback, descriptor parity, section toggling, brand override (5 cases).
- Existing `tests/estimatePdfService.test.js` continues to pass.

**Notes**
- No new runtime dependencies (validator is hand-rolled, ~80 lines).
- Designed for `invoice` and `work_order`: extending `document_type` CHECK + adding a factory + registering an adapter is sufficient; the Settings page already lists by registered type label.

## 2026-06-03 — F016: VAPI AI Marketplace Integration + Call Flow Gating

**Added**
- New marketplace app `vapi-ai` registered via `backend/db/migrations/088_seed_vapi_ai_marketplace_app.sql` (provisioning_mode: none, category: telephony, status: published).
- `backend/src/db/marketplaceQueries.js` — migration 088 added to `ensureMarketplaceSchema`, idempotent seed runs on startup.
- `frontend/src/services/vapiApi.ts` — typed API client for `/api/vapi/*`: `getConnections`, `createConnection`, `getResources`, `createResource`.
- `frontend/src/pages/VapiSettingsPage.tsx` — full settings page at `/settings/integrations/vapi-ai`: step 1 API key verify, step 2 SIP resource, Finish Setup → marketplace install. View mode when already connected. Disconnect with confirmation.
- Route `/settings/integrations/vapi-ai` registered in `App.tsx` with `tenant.integrations.manage` permission.

**Changed**
- `frontend/src/pages/IntegrationsPage.tsx` — VAPI AI tile shows "Configure"/"Manage" button that navigates to `VapiSettingsPage` instead of opening the generic `MarketplaceConnectDialog`.
- `frontend/src/pages/telephony/CallFlowBuilderPage.tsx` — `vapi_agent` node gated behind active VAPI connection: on mount fetches `GET /api/vapi/connections`, hides node from insert picker if no active connection found.

**Tests**
- `tests/routes/vapi.test.js` — 8 test cases covering: connections list, missing api_key (400), invalid key (400), network error (400), missing resource fields (400), API key not exposed in response, server mount middleware.
- `tests/routes/marketplaceMount.test.js` — 2 new cases: migration 088 file content check, marketplaceQueries.js loads 088.

**Architecture**
- Connection flow: `POST /api/vapi/connections` → `POST /api/vapi/resources` → `POST /api/marketplace/apps/vapi-ai/install` (provisioning_mode: none → instant connected).
- Disconnect: standard `POST /api/marketplace/installations/:id/disconnect`.

## AUTO-001 — Automation/Rules Engine E2E (2026-06-13)
Делает заложенный в ADR-001 rules-engine рабочим end-to-end.
- **eventCatalog.js** + `GET /api/automation/catalog` — каталог событий/действий/agent-типов для редактора.
- **agentWorker.js** + **agentHandlers.js** — фоновый исполнитель kind=agent задач (atomic claim FOR UPDATE SKIP LOCKED, queued→running→succeeded/failed, эмит agent_task.*); хендлеры mcp_tool (вызов CRM MCP в tenant-контексте), summarize_thread, noop.
- **rulesSeed.js** + `POST /rules/seed-defaults` — AR-эквивалентные системные правила (sms.inbound, call.missed), идемпотентно.
- conversationsService/inboxWorker эмитят `sms.inbound`/`call.missed`; legacy AR за флагом FEATURE_RULES_ENGINE_AR; arConfigHelper → @deprecated.
- Frontend: AutomationPage + RuleEditor (trigger→conditions→actions, превью шаблонов) + run history + nav `/settings/automation` (tenant.company.manage).
- API: agent-tasks list + retry (409 на running, 404 на чужой).
- Миграция 102 (is_system marker). Тесты: 13 новых (worker claim, handlers, route guards 422/404/409, seed идемпотентность). Полный сьют 687 pass.

## NOTES-001 — Unified Notes: edit, soft-delete, attachment edit & audit (2026-06-25)

Unified the notes thread across Jobs/Leads/Contacts onto the single `NotesSection` component and added full lifecycle management.

**Backend**
- Migration `124_notes_edit_delete_audit.sql`: stable `id` backfilled onto every note in `jobs.notes` / `leads.structured_notes` / `contacts.structured_notes`; `note_attachments.note_id` added + backfilled from the positional `note_index` (idempotent).
- New `services/notesMutationService.js`: `canMutateNote` (admin → any; owner → own; legacy/no-author/Zenbooker → admin-only), `editNote` (text + add/remove attachments), `softDeleteNote` (`deleted_at` tombstone, element retained).
- New endpoints (PATCH + DELETE `…/notes/:noteId`) on jobs/leads/contacts, `requirePermission('*.edit')` + server-side ownership/admin gate (non-admin editing another's note → 403; cross-company → 404). New notes now stamp `id` + `created_by` (Keycloak sub).
- Soft-deleted notes excluded from every GET /notes and from `getEntityHistory`. `eventService` logs `note_edited` (old→new + attachment deltas) and `note_deleted`, rendered in History.
- Zenbooker merge preserves locally-edited text (`edited_at`) + `created_by`/`deleted_at`/`id` across re-sync.

**Frontend**
- `NotesSection`: per-note kebab (⋮, shown only when permitted) → Edit / Delete; edit mode (textarea + ✕ to remove each attachment + add new files), `window.confirm` delete; refetch after.
- `HistorySection`: icons for `note_edited` (Pencil) / `note_deleted` (Trash2).
- Removed dead `StructuredNotesSection.tsx` + `JobNotesSection.tsx`; extracted `JobDescription.tsx`.

**Out of scope:** Estimate "Summary" and Invoice "Notes" (separate single document fields).

**Verification:** backend Jest `tests/notesAuthz.test.js` + `tests/notesEditDelete.test.js` (13 cases) green; frontend `npm run build` green. Migration reviewed (idempotent) but not yet run against a live DB; full end-to-end click-through pending a deploy.

## SLOT-ENGINE-001 Phase 2+3 — Albusto integration of the slot recommendation engine (2026-06-25)

Marketplace-gated integration of the standalone `slot-engine` (Phase 1) into the schedule slot-picker.

**Backend**
- Migration 125 `technician_base_locations` (per-tenant tech base coords); migration 126 seeds the
  `smart-slot-engine` marketplace app (+ added to the `ensureMarketplaceSchema` replay list).
- Base-location CRUD: `GET/PUT/DELETE /api/settings/technician-base-locations` (`tenant.company.manage`),
  Zenbooker roster merge, geocode-on-save fallback (`googlePlacesService`).
- `marketplaceService.isAppConnected` gating helper.
- `slotEngineService` assembles the engine snapshot (techs + bases + local jobs → window/duration/status,
  company-tz) and calls `SLOT_ENGINE_URL` with a 4s timeout + safe-failure.
- Proxy `POST /api/schedule/slot-recommendations` (`schedule.dispatch`), gated on install.
- Jest: technicianBaseLocations + slotEngineProxy (34 cases); no schedule regressions (48/48).

**Frontend**
- `slotRecommendationsApi` + `technicianBaseLocationsApi`.
- Base-location editor on `/settings/technicians` (address autocomplete → geocode).
- `CustomTimeModal` (new jobs only): recommendation cards side panel (click applies slot+tech) +
  `Recommended` tech-bar pill + clickable timeline overlay bands; graceful when disabled/engine-down.

`SLOT_ENGINE_URL` added to `.env.example`. Verified: 34 + 48 backend tests, frontend build green, engine 18/18.
