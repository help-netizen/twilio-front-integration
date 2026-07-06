# MOBILE-TECH-APP-002 — Spec (Finance-on-job / Tasks / Search)

**Status:** Detailed Spec (pre-build) · **Date:** 2026-07-06 · **Product:** Albusto (UI shows "Albusto" only)
**Parents (authoritative):** `Docs/requirements.md` §MOBILE-TECH-APP-002 (FR-FIN/FR-TSK/FR-SRCH, AC-1..11) + `Docs/architecture.md` §MOBILE-TECH-APP-002 (screen/module map, pinned backend contract). This spec deepens both — behavior, exact contracts, edge cases, copy. Where they conflicted with live code, **code wins** (corrections in §0).
**Scope:** `albusto-mobile` repo ONLY (RN/Expo, master @ 59b8860). **ZERO backend diffs, zero migrations (max stays 155)** — AC-11.
**Continuity:** builds on `Docs/specs/MOBILE-TECH-APP-001-SPEC.md` (v1 core). v1 LOCKED decisions stand: offline = READ-ONLY, every write needs network, no payments (v1.5), softphone desktop-only, iOS only.

---

## §0. Ground-truth corrections (code-verified 2026-07-06 — these override requirements/architecture wording)

| # | Verified fact | Source | Consequence |
|---|---|---|---|
| G1 | **Estimates / invoices / tasks error envelope is NESTED:** `{ok:false, error:{code, message}}` (e.g. `ARCHIVED`, `NOT_FOUND`, `ACCESS_DENIED`). The app's `client.ts` today parses only flat `{code,message}` / `{error:string}` — for the nested shape `ApiError.code` comes out **undefined** and `message` degenerates to `[object Object]`. Architecture §1 claim "client.ts already parses both" is **wrong** for this envelope. | `routes/estimates.js:67`, `routes/tasks.js:33`, `albusto-mobile/src/api/client.ts:47-53` | **§2.4 pins an app-side extension of `client.ts` error parsing** (also read `parsed.error.code` / `parsed.error.message` when `error` is an object). App-only change, backwards compatible, AC-11 intact. |
| G2 | **Task `parent_type` has a SIXTH value: `'timeline'`** (thread-parent tasks from AR-TASK-UNIFY-001, label `'Conversation'`), beyond mig-136's job/lead/contact/estimate/invoice. | `db/tasksQueries.js:39-61` (`SELECT_TASK` CASE incl. `t.thread_id`) | `timeline` parents render **info-only** exactly like other non-job parents (§4.4). Never crash on an unknown `parent_type` either — default to info-only. |
| G3 | **Tasks list server ordering is `due_at ASC NULLS LAST, created_at DESC`** — there is no server-side "overdue first" bucket; overdue rows sort first only *among dated* rows naturally. Default `limit` clamp = **100**, max 500. Default `status='open'` when the param is absent; `status=all` disables the filter. | `db/tasksQueries.js:158-178`, `routes/tasks.js:45` | Overdue/undated grouping is a **client lib concern** (§4.1). Pagination pages by `limit/offset` (§4.1.5). |
| G4 | **Estimate CREATE and UPDATE both require ≥1 item OR a non-empty `summary`** (`400 VALIDATION 'Estimate requires at least one item or Summary'`). A bare `POST {job_id}` fails. | `services/estimatesService.js:66-73, validateSavePayload` | **Editor-first create** (§3.3): no server object exists until first Save; Save is client-gated on ≥1 line (the mobile editor does not expose `summary` — see §3.4.7). |
| G5 | **Invoice create has NO items requirement**; `contact_id` auto-resolves from `job_id` (else `400 VALIDATION`); `due_date` (template `default_due_days`, fallback +14d) and `invoice_number` auto-generate. | `services/invoicesService.js:60-155` | Zero-item invoices are legal on the server; §3.4.7 still gates mobile Save on ≥1 line for UX parity, §3.6.6 pins send behavior. |
| G6 | **Estimate send requires items** (`assertHasItems` → `400 VALIDATION` with a **Russian** message «В эстимейте нет items»). **Invoice send does NOT require items.** | `services/estimatesService.js:343-348,384`, `services/invoicesService.js:360-376` (no assertHasItems) | Client must pre-guard (disable Send on a zero-item estimate) and must never surface that raw server string (§3.6.6, §7). |
| G7 | **Send `channel` accepts `'text'` as an alias** (normalized to `'sms'` server-side). | `services/*Service.js sendX` | App always sends the canonical `'sms'`. |
| G8 | **Estimate PUT on ANY non-draft status resets `status→'draft'`** and clears `sent_at/accepted_at/declined_at`; an `approved` estimate additionally gets a revision snapshot. Invoice PUT does **not** reset status (revision snapshot only). | `services/estimatesService.js:213-218`, `services/invoicesService.js:157+` | The "returns to draft" hint (§3.4.6) applies to **estimates only**. |
| G9 | `GET /api/price-book/groups` takes only `search`/`includeArchived` — **no `category_id` param** (requirements assumed one). `GET /api/price-book/items` DOES take `search`/`category_id`/`limit`(default 50)/`offset`. Price-book errors are flat `{error, message}` (handled by `client.ts` today). | `routes/price-book.js:55-95` | Groups are filtered **client-side** on the returned `category_id` field (§3.5.3). |
| G10 | `GET /api/jobs` list envelope = `{ok,data:{results, total, offset, limit, has_more}}`; `results[]` = `rowToJob` — same shape as `SyncJob`. `GET /api/jobs/:id` errors are flat `{ok:false,error:string}`. Contacts list = `{ok,data:{results, pagination:{offset,limit,returned,has_more}}, meta}`; `has_more` is the heuristic `returned >= limit`. | `services/jobsService.js:826-841`, `services/contactsService.js:113-123` | §6 contract tables. |
| G11 | Estimate/invoice **detail** joins `contact_email`, `contact_phone` (`phone_e164`), `service_address`; list rows carry `_total`-derived `total` and (invoices) `amount_paid`/`balance_due`. pg `numeric/int8` arrive as **JSON strings**. | `db/estimatesQueries.js:120-130`, `db/invoicesQueries.js:128-135` | Send-recipient prefill (§3.6.2); money coercion everywhere (§2.5). |

Everything else in the architecture's §1 pinned-contract table was re-verified and holds (permission gates, `scopeOwnerId` forcing for non-`tasks.manage`, `PATCH /api/tasks/:id` ownership → `403 ACCESS_DENIED`, task text field = `description` aliasing `title`, completion value = `'done'`, INVOICE-EDIT-ITEMS-001 `Array.isArray` guard, archived-estimate PUT → `409 ARCHIVED`).

---

## §1. Overview

Three online-only additions to the v1 app: (A) an **Estimates & Invoices** section on JobDetail with a shared document detail / editor / Price Book picker / send sheet; (B) a **Tasks** tab (own open tasks: view / complete / create) plus in-job task creation; (C) **two-tier search** (instant local over the SQLite jobs cache + server jobs & contacts). None of the new data ever touches SQLite or the sync delta (owner decision D1). The server is the sole authority for scoping and permissions (D6, NFR).

**New routes (expo-router):** `(tabs)/tasks`, `doc/[kind]/[id]` (kind ∈ `estimate|invoice`), `doc/editor` (params `{kind, id?, jobId?}`), `search` (root-level `presentation:'modal'`). Price Book picker, Send sheet, and TaskComposer are RN `Modal` components, not routes. (Architecture §2 — binding.)

---

## §2. Shared foundations (all three areas build on these)

### §2.1 `useOnlineQuery` — the one online-read contract

Every new network read renders exactly one of **four** states; there is no fifth.

| State | Trigger | Render |
|---|---|---|
| `loading` | fetch in flight, no data yet | inline `ActivityIndicator` (ink3), never full-screen inside JobDetail sections |
| `data` | 2xx | content |
| `offline` | `useSync().offline` is true at fetch time, OR the throw is a non-`ApiError` (network-classified, same rule the SyncEngine uses) | `NeedsConnection` placeholder (§2.2) |
| `error` | `ApiError` (incl. 403 → `forbidden` flag) | §2.3 error rendering; 403 → "Not available for your account" (no Retry uselessly hammering) |

- **Refetch on focus** (`useFocusEffect`) — matches JobDetail's existing focus-reload pattern; also refetch on a manual Retry tap.
- A completed refetch **replaces** data wholesale (no merging).
- `loading` must resolve — no infinite spinners: every fetch settles into `data | offline | error`.
- Hook exposes `{data, loading, offline, forbidden, error, reload}` (architecture §3 — binding).

### §2.2 `NeedsConnection` placeholder

Shared component: message + **Retry** button. Default copy: title **"Needs connection"**, body **"Connect to the internet and try again."** Callers may override the body (e.g. search §5.4). Styling: ink2/ink3 text, no border, follows v1's empty-state look (`job/[id].tsx` "Job not available" pattern). Retry calls `reload()`; while retrying show the button in an in-flight spinner state.

### §2.3 Write canon (save / send / complete / create)

Identical to v1 `JobStatusActions`:
1. **Pre-check** `useSync().offline` → `Alert.alert("You're offline", "Reconnect to save your changes.")` (verb adjusted per action, §7) and do nothing. Buttons render dimmed (+ "Needs connection" caption) while offline.
2. **In-flight**: the tapped button shows a spinner and ALL sibling action buttons disable (client-side dedup — double-tap protection).
3. **Success**: apply the server response (never the optimistic guess — except tasks §4.2), toast/alert only where the user needs confirmation.
4. **`ApiError`**: map by status/code per §7. **Non-`ApiError`**: treat as offline → same alert as step 1 with "Nothing was saved."
5. **No queueing, ever** (LOCKED).

### §2.4 `ApiError` envelope handling (fixes G1 — app-side only)

`client.ts` error parsing is extended to understand all four live envelopes:

| Envelope | Producers | Extraction |
|---|---|---|
| `{code, message}` | auth middleware | as today |
| `{error: "string"}` | jobs.js, sync.js | as today (message) |
| `{error: {code, message}}` | estimates, invoices, tasks | **NEW:** `code = error.code`, `message = error.message` |
| `{error: "code_string", message}` | price-book | as today (message wins, `code` stays from top level if present) |

Rule: `code = parsed.code ?? (typeof parsed.error === 'object' ? parsed.error?.code : undefined)`; `message = parsed.message ?? (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ?? rawBody`. Jest-covered for all four shapes. Error mapping in this spec keys on **HTTP status first, `code` second** — never on message text (messages can be localized/raw, G6).

### §2.5 Money & numerics (house rule)

pg `numeric`/`int8` arrive as **JSON strings** (`total`, `balance_due`, `amount_paid`, `quantity`, `unit_price`, ids). All arithmetic goes through `lib/documents.ts` coercers (`toNumber`, `formatMoney` → `$1,234.50`). Client-computed totals are a **preview only**; after any save the displayed totals re-render from the server response (rounding authority — architecture §1 totals math is the preview formula). Id comparisons (dedup §5.2, navigation) always compare `String(id)`.

### §2.6 Security posture (binding, NFR)

- The app sends **no** owner/assignee/company/role filters on any list — `scopeOwnerId` (tasks), `getProviderScope` (jobs/contacts), `req.companyFilter` (everything) are 100 % server-side. Grep-level AC: no `assignee_id`, no `owner_user_id` in any query string the app builds.
- No client-side permission logic: a `403` renders the polite unavailable-state, never hides/shows features preemptively.
- Online job fetches (`GET /api/jobs/:id` fallback §5.5) and all finance/tasks/search responses are **never written to SQLite** — `db/jobsRepo` gains no new write callers (grep-level AC).
- No new tokens/secrets; Bearer flow unchanged (M01/M03).

---

## §3. Finance on the job card (FR-FIN-1..7)

### §3.1 JobFinanceSection on JobDetail (FR-FIN-1)

Replaces the read-only `Field label="Invoice"` line (which is superseded and removed).

**S-FIN-1 (happy path).** Given a cached job open in JobDetail with connectivity — When the card renders — Then the cached part (identity/status/notes) renders instantly and the "ESTIMATES & INVOICES" section loads independently via two parallel `useOnlineQuery` fetches: `GET /api/estimates?job_id={id}` and `GET /api/invoices?job_id={id}` (no `include_archived` — OQ-M2-4 closed). Each document row shows: number (`estimate_number`/`invoice_number`), status pill, total; invoice rows additionally "Balance $X" when `balance_due > 0`. Rows are ordered estimates first then invoices, each list newest-first as the server returns them. Tapping a row pushes `doc/[kind]/[id]`.

**S-FIN-2 (empty).** Both lists empty → no rows, no "—": only two affordances **"+ Estimate"** and **"+ Invoice"**. (The create affordances are ALSO present when documents exist, below the rows.)

**S-FIN-3 (offline).** `sync.offline` or network-classified failure → the section body is one `NeedsConnection` placeholder (both lists share it); the rest of the cached card renders normally (AC-1). Create affordances render dimmed; tap → offline alert (§2.3).

**S-FIN-4 (one list fails, one succeeds).** e.g. estimates 200, invoices 500 → render the successful list's rows plus a compact inline error row for the failed kind: "Couldn't load invoices. Retry". Never blank the whole section over one failure.

**S-FIN-5 (403).** Provider lacking `estimates.view`/`invoices.view` (misconfigured tenant) → section renders "Not available for your account" once (no Retry). No crash, no logout.

**S-FIN-6 (huge job).** > 20 documents on one job — render all (a job realistically has < 10; both routes default `limit 50`). No pagination UI in the section; if `total > rows.length` append a passive row "…and N more in the office CRM".

**S-FIN-7 (job disappears mid-view).** The v1 reassign flow already handles the card (overlay + back). The finance fetches may race it and return 200 (finance routes are company-scoped, not provider-scoped) — harmless: the card's job-gone overlay wins; on `onGone` all section queries are abandoned.

### §3.2 Document detail — `doc/[kind]/[id]` (FR-FIN-2)

**S-FIN-8 (happy path).** `GET /api/estimates/:id` / `GET /api/invoices/:id` via `useOnlineQuery` → renders: number as screen title; status; created/sent dates (only those that exist); line items (name, qty × unit price, amount); totals block (subtotal, discount if any, tax if any, total); invoices additionally Amount paid / **Balance due** (display-only — D5/FR-FIN-7). Header actions: **Edit** → `doc/editor?kind&id`; **Send** → SendDocumentSheet (§3.6). Focus-refetch: returning from the editor re-fetches (architecture §4).

**S-FIN-9 (404).** Document deleted/archived-out server-side → alert "This document is no longer available." → `router.back()` (JobDetail's section refetches on focus and drops the row).

**S-FIN-10 (archived estimate opened from a stale link).** Detail GET still returns archived docs; if `data.status === 'archived'` (estimates) render read-only: hide Edit/Send, show a passive line "Archived — read-only." (Archived rows normally never appear in the section — S-FIN-1.)

**S-FIN-11 (offline open).** Straight to `NeedsConnection` full-screen state with Retry; back navigation always available.

**S-FIN-12 (zero-item document).** Renders with an empty items area ("No items yet") and totals $0.00; estimates: Send disabled with caption "Add at least one item to send." (G6); invoices: Send enabled (G6).

### §3.3 Create from the job (FR-FIN-3) — editor-first (G4)

**S-FIN-13 (create estimate).** "+ Estimate" (online) → `doc/editor?kind=estimate&jobId={id}` opens with an **empty local draft** (no POST yet — G4). User adds lines (§3.4/§3.5) → **Save** → `POST /api/estimates` `{job_id, items:[...], tax_rate?, discount_type?, discount_value?}` → 201 → `router.replace('doc/estimate/{newId}')` (replace, so Back from detail returns to JobDetail, not a dead editor). Contact/lead/number auto-resolve server-side from `job_id` — the app sends **only `job_id`** as context.

**S-FIN-14 (create invoice).** Same flow; `POST /api/invoices` `{job_id, items:[...], tax_rate?, discount_amount?}`; `due_date`/`invoice_number`/contact auto-generate (G5).

**S-FIN-15 (abandon create).** Back/dismiss with unsaved lines → confirm: "Discard this estimate?" / "Discard this invoice?" [Keep editing / Discard]. Nothing was created server-side (G4) — no cleanup needed.

**S-FIN-16 (create offline mid-flow).** Editor stays usable (local draft); Save pre-checks offline → "You're offline — Reconnect to save your changes." Draft survives in component state; killing the app loses it (accepted — no offline write queue, LOCKED).

**S-FIN-17 (create 400 VALIDATION).** e.g. deleted job (`'Job not found'`) → alert "Couldn't save — {server message}". Stay in the editor.

### §3.4 Editor — `doc/editor` (FR-FIN-4)

Local draft model in `lib/documents.ts` (pure, jest-covered). Seeded from `GET` (edit) or empty (create).

1. **Line CRUD:** add via Price Book picker or "Add custom item" (freeform: name required, qty default 1, unit price default 0); edit name/qty/price inline; swipe-to-delete; qty > 0, price ≥ 0 enforced at input level (mirror server `normalizeItem` rules: `400 VALIDATION 'Item title is required' / 'Qty must be greater than 0' / 'Unit price cannot be negative'` should be unreachable).
2. **`itemsTouched` dirty flag (AC-3 hinge):** set by ANY add/remove/edit/reorder of lines; never set by scalar-only edits (tax rate, discount). Payload builder: `itemsTouched === true` → `items` = the full normalized array (possibly `[]`); `false` → the `items` key is **omitted entirely** (not `null`, not `[]`). Jest: touched → array; emptied → `[]`; untouched → key absent.
3. **Save (edit):** `PUT /api/estimates/:id` / `PUT /api/invoices/:id` with changed scalars + items per rule 2 → 200 → back to detail (which focus-refetches). Invoice `[]` ⇒ transactional clear; omitted ⇒ items untouched (INVOICE-EDIT-ITEMS-001).
4. **Totals preview:** live footer computed by the lib — line `amount = qty × unit_price`; estimate `discount = pct (cap 100) | fixed (cap subtotal)`, `tax = round((taxable_subtotal − discount)⁺ × tax_rate/100, 2)`; invoice `tax = round(subtotal × tax_rate/100, 2)`, flat `discount_amount`. Label the footer "Preview" — saved totals come from the response (§2.5).
5. **Item payload shape (both kinds):** `{name (required), description?, quantity>0, unit_price≥0, unit?, taxable?, sort_order?, price_book_item_id?}` — exactly `normalizeItem`.
6. **Sent-document warning (estimates only, G8):** when the seeded `status ≠ 'draft'` show a persistent one-line hint under the title: **"Saving returns this estimate to draft."** No such hint for invoices.
7. **Zero-line Save guard:** estimates — Save disabled while the draft has 0 lines, caption "Add at least one item." (the mobile editor does not expose `summary`, so the server's item-or-summary alternative is moot on create; on **edit** of a summary-only estimate emptying the lines is allowed only if the doc has a summary — the lib knows `hasSummary` from the GET and otherwise blocks with the same caption, keeping the server's `400` unreachable). Invoices — same UX gate on **create** (S-FIN-14 sends ≥1 line); on **edit**, clearing all lines is legal (AC-3 "emptied ⇒ cleared") and allowed after a confirm: "Remove all items from this invoice?".
8. **S-FIN-18 (409 ARCHIVED on save).** Someone archived the estimate mid-edit → alert "This estimate was archived — it's now read-only. Ask the office to restore it." → back to detail (refetch shows archived state, S-FIN-10).
9. **S-FIN-19 (404 on save).** "This document is no longer available." → pop to JobDetail.
10. **S-FIN-20 (concurrent edit, last-write-wins).** No version/ETag exists server-side; a PUT overwrites. Accepted risk (same as web). Mitigation: the editor always seeds from a fresh GET on open, and detail focus-refetch makes the loser visible immediately. No client conflict UI.
11. **S-FIN-21 (offline mid-edit).** Typing continues; Save → offline alert; draft preserved in state. Connectivity back → Save proceeds normally (no auto-retry).

### §3.5 Price Book picker (FR-FIN-5) — full-screen Modal inside the editor

**S-FIN-22 (browse → single item).** Open picker → level 1: Categories (`GET /api/price-book/categories`, `{categories:[]}`) + an "All items" search field. Tap a category → level 2: its Groups (client-filtered from `GET /api/price-book/groups` on `category_id` — G9) and its Items (`GET /api/price-book/items?category_id=&limit=50`). Tap an **Item** → one draft line (name/price prefilled from the item, `price_book_item_id` carried, qty 1, editable after add) → picker stays open for multi-add; "Done" closes.

**S-FIN-23 (group bulk-add).** Tap a **Group** → `GET /api/price-book/groups/:id/expand` → `{items:[{name, description, quantity:string, unit, unit_price:string, taxable}]}` → ALL member rows map to draft lines (string→number coercion in `lib/priceBook.ts`), appended in returned order. A group row shows `item_count` + `total` as a preview before tapping.

**S-FIN-24 (search).** The search field queries `GET /api/price-book/items?search=&limit=50` (server-side, debounced 300 ms) across all categories; results replace the browse list while the query is non-empty.

**S-FIN-25 (empty catalog).** No categories → picker body: "No price book yet. Add a custom item instead." with a button that closes the picker and focuses the freeform line flow.

**S-FIN-26 (offline / error).** Picker opens only online (the editor's "Add from price book" is dimmed offline). Mid-browse network loss → level content shows `NeedsConnection`; already-added lines are unaffected. Price-book `403` (no `price_book.view`) → "Not available for your account"; freeform lines remain fully usable.

**S-FIN-27 (read-only guarantee).** No mutation call sites for `price_book.manage` routes exist in the app (grep-level AC).

### §3.6 Send (FR-FIN-6, OQ-M2-2 closed = both channels)

SendDocumentSheet (Modal over detail):

1. **Channel selector:** **Email** / **Text** (two options — web parity, SEND-DOC-001).
2. **Recipient prefill:** Email → `contact_email`; Text → `contact_phone` (G11). Editable single field, keyboard type per channel. Empty prefill → field empty + hint "No email on file" / "No phone on file".
3. **Optional message** (multiline, appended to the body/SMS).
4. **Send** → `POST /api/estimates/:id/send` / `POST /api/invoices/:id/send` with `{channel:'email'|'sms', recipient, message?}`. Invoices: `includePaymentLink` is **always omitted** (server default applies; no payment framing in-app — D5). Success → sheet closes, toast "Sent", detail refetches (status flips to `sent` server-side only after real dispatch).
5. **S-FIN-28 (error mapping)** — by status/code (§2.4), alerts per §7: `409 MAILBOX_NOT_CONNECTED` → office-facing copy; `422 NO_PROXY` → office-facing copy; `422 NO_PHONE` → "Enter a valid phone number."; `402 WALLET_BLOCKED` → office-facing copy; `400 VALIDATION` → "Couldn't send — check the recipient and try again."; `404` → S-FIN-9 behavior. The sheet stays open on recoverable errors (422 NO_PHONE, 400) and closes onto the alert for tenant-level ones (409/402 — the tech can't fix them).
6. **S-FIN-29 (zero-item estimate).** Send entry point disabled on the detail per S-FIN-12 — the server's Russian-message `400` (G6) must be unreachable from the UI.
7. **S-FIN-30 (offline).** Send button in the sheet pre-checks offline (§2.3): "You're offline — Reconnect to send."

### §3.7 No payment surfaces (FR-FIN-7, AC-5)

No record-payment, no Tap-to-Pay, no pay-link composer anywhere. `balance_due`/`amount_paid`/`invoice status` are display-only. Grep-level AC: no call sites for `/record-payment`, `/stripe-terminal` beyond the dormant v1.5 seed already in the repo.

---

## §4. Tasks tab (FR-TSK-1..6)

### §4.1 List — `(tabs)/tasks` (FR-TSK-1)

**S-TSK-1 (happy path).** Tab opens → `GET /api/tasks?limit=100` (NO `status` param — server defaults to `open`, G3; NO owner/assignee params — server forces `scopeOwnerId` for non-manage, D6/AC-6). `lib/tasks.ts` groups client-side: **Overdue** (open, `due_at < now`) first, then **Upcoming** by `due_at` ascending, then **No due date** (`due_at` null) last — matching the server's `NULLS LAST` order so grouping is a stable partition, not a re-sort. Row = TaskRow: checkbox, `description`, due line ("Due today" / "Due Jul 8" / "Overdue — Jul 2" in warning color), parent chip (§4.4).

**S-TSK-2 (empty).** "No open tasks." + subtle "Tasks assigned to you show up here." No error styling.

**S-TSK-3 (offline).** Full-tab `NeedsConnection` (FR-TSK-6 — tasks never cached). Pull-to-refresh offline → same placeholder (no toast storm).

**S-TSK-4 (refresh).** Pull-to-refresh + focus-refetch (§2.1). After completing/creating a task the list refetches (see §4.2/§4.3).

**S-TSK-5 (pagination).** If exactly `limit` rows returned, show "Load more" footer → next `offset += limit` page appended (dedup by task id defensively). Realistic provider volumes (< 30) never hit this; it exists so a pathological tenant can't truncate silently.

**S-TSK-6 (403).** Provider missing `tasks.view` → "Not available for your account" tab body. Tab itself always renders (no permission probing — §2.6).

### §4.2 Complete — optimistic with revert (FR-TSK-2)

**S-TSK-7 (happy path).** Checkbox tap → `lib/tasks.ts` reducer optimistically flips the row to done (checked + strikethrough, stays in place) → `PATCH /api/tasks/:id` `{status:'done'}` → 200 → reconcile with the returned task; on the NEXT list refresh the row leaves the list (server default filter `open`). Badge count re-polls (§4.5).

**S-TSK-8 (failure → revert).** Any error → reducer reverts the row, then: `404 NOT_FOUND` → alert "This task is gone — it may have been deleted." + refetch list; `403 ACCESS_DENIED` → "You can't change this task." (shouldn't happen for own tasks; defensive) + refetch; offline/non-ApiError → "You're offline — Reconnect to complete tasks."

**S-TSK-9 (double-tap).** While the PATCH is in flight the checkbox is locked (per-row in-flight flag). No queue, no toggle-back race.

### §4.3 Create — TaskComposer Modal (FR-TSK-3, OQ-M2-3 closed)

**S-TSK-10 (from JobDetail).** "Add task" on the job card → composer with parent **pinned** to that job (non-editable context line "For {customer_name}"). Fields: description (required, multiline), due date (optional, native date picker, sends ISO). Save → `POST /api/tasks` `{parent_type:'job', parent_id: job.id, description, due_at?}` → 201 → toast "Task added", composer closes. **No `owner_user_id` is sent** — the server defaults owner = author = the tech (AC-6/AC-7).

**S-TSK-11 (from the Tasks tab).** "+" opens the same composer with a **parent picker**: the tech's own jobs from the SQLite cache (`listAllJobs()`, most-recent `start_date` first, searchable by customer name). Picking a job is **required** — Save disabled until description + parent are set. (Only-jobs picker — binding; no lead/contact/document pickers.)

**S-TSK-12 (validation / errors).** Empty description → Save disabled client-side (server `400 DESCRIPTION_REQUIRED` unreachable). `404 NOT_FOUND` (parent job vanished — e.g. stale cache row) → alert "That job is no longer available — pick another." and, when it came from the picker, refresh the picker list. Offline → §2.3 write canon.

**S-TSK-13 (composer dismiss).** Back/swipe-down with typed text → confirm "Discard this task?".

### §4.4 Parent context & navigation (FR-TSK-4, OQ-M2-1 closed, G2)

`lib/tasks.ts` parent row model:

| `parent_type` | Chip label | Tap behavior |
|---|---|---|
| `job` | `parent_label` (service/customer name) | navigate: cached (`getJobById`) → `job/[id]`; not cached → `job/[id]` renders via the online fallback (§5.5) |
| `lead` / `contact` / `estimate` / `invoice` | `parent_label` prefixed by type ("Lead · Chen") | **info-only** — no navigation, no press affordance |
| `timeline` (G2) | "Conversation" (`parent_label`) | info-only |
| unknown/future | `parent_label` or the raw type | info-only (never crash — AC-7) |

**S-TSK-14 (job-parent tap, cache miss).** Task's job is outside the 30-day cache window → `job/[id]` finds no cached row → fetches `GET /api/jobs/:id` online and renders (never cached — §5.5). 404 (job unassigned/gone) → the existing "Job not available" screen.

### §4.5 Tab badge (FR-TSK-5 — nice-to-have)

`useTaskCount`: `GET /api/tasks/count` → `{ok,data:{count}}` → `tabBarBadge` (hidden when 0). Polled on: tab focus, AppState → active, after a successful complete/create. **All failures are silent** (badge simply absent) — no alert, no retry UI. Offline → skip the call entirely.

---

## §5. Search (FR-SRCH-1..4)

Entry: a pressable search-field-look affordance in the Schedule header → `router.push('/search')` (root-level modal, autofocused input, Cancel dismisses).

### §5.1 Tier 1 — instant local (works offline)

**S-SRCH-1.** Every keystroke synchronously filters the in-memory jobs cache (`listAllJobs()` loaded once on screen mount + on `lastSyncedAt` change): case-insensitive substring over `customer_name`, `address`, `city`, `service_name` (`lib/search.ts` predicate; SQLite untouched — no new SQL/index). Results section "On your schedule" renders as `JobCard` rows → tap → `job/[id]` (cached path, as today). Budget: < 100 ms at 300 jobs (trivially met in-memory; jest asserts the predicate, perf asserted by construction).

**S-SRCH-2 (empty query).** Blank input → no sections, a hint "Search your jobs, past visits, and customers." Whitespace-only = blank.

### §5.2 Tier 2 — server jobs (online-only)

**S-SRCH-3.** The same query, debounced ≥ 300 ms and only for `query.trim().length ≥ 2`, fires `GET /api/jobs?search={q}&limit=20` in parallel with contacts (§5.3). **Latest-request-wins**: a stale response for an outdated query is dropped (`lib/search.ts` guard helper). Results render in a "More results" section **deduped against local hits by `String(job.id)`** — a job both cached and matched server-side appears only once, in the local section. Server rows are `SyncJob`-shaped (G10) → rendered by the same `JobCard`.

**S-SRCH-4 (open a server hit).** Tap → `job/[id]`. Cached → normal path. Not cached → §5.5 online fallback. The SQLite cache contents and the sync cursor are **byte-identical** before/after (AC-8).

**S-SRCH-5 (server tier errors).** Query fails (5xx/network) → the "More results" section shows one compact row "Couldn't search the server. Retry" — the local section stays. No alert, no toast storm (FR-SRCH-4).

### §5.3 Tier 3 — contacts → call (online-only)

**S-SRCH-6.** Same debounce fires `GET /api/contacts?search={q}&limit=20` (server matches `full_name/phone_e164/secondary_phone/email` ILIKE; provider-scoped server-side — contacts linked to assigned jobs only, AC-9). Section "Contacts": row = `full_name` + phone(s); a **Call** button per phone → `tel:{phone_e164}` native dialer (MOBILE-NO-SOFTPHONE-001). No contact detail screen, no edit/create.

**S-SRCH-7 (contact rows without phones).** Render name + email if present, no Call button; row is non-interactive otherwise.

### §5.4 Offline behavior (FR-SRCH-4)

**S-SRCH-8.** Offline: the local tier keeps working exactly as §5.1; the two server sections collapse into ONE compact needs-connection row: "Server search needs a connection." No Retry spinner loop — reconnecting + typing re-triggers naturally.

### §5.5 JobDetail online fallback (shared by §4.4 & §5.2)

**S-SRCH-9.** `job/[id]` load order: `getJobById(cache)` → hit ⇒ current v1 behavior. Miss ⇒ `GET /api/jobs/:id` (online) → render the SAME detail UI from the response, held in **component state only** (never written to SQLite — D1). Distinctions in online mode: status actions and notes composer stay functional (they're online-only writes anyway; after a write, refresh re-fetches `GET /api/jobs/:id` instead of relying on `syncNow` cache reload); the "reassigned away" overlay logic keys on the online 404. Offline + cache miss ⇒ the existing "Job not available" screen with the §2.2 hint "Connect to the internet and try again."

**S-SRCH-10 (online-mode 404).** `{ok:false, error:'Job not found'}` → "Job not available" screen (it may be another tech's job the server scoped away — never distinguish).

---

## §6. API contracts consumed (complete list — nothing else is called)

All under the existing client (`getJson/postJson`), Bearer auth, `{ok,data}` success envelope unless noted. Errors per §2.4. **No backend change (AC-11).**

| # | Call | Params / body | Success payload | Errors the app must handle |
|---|---|---|---|---|
| 1 | `GET /api/estimates?job_id=` | — | `{rows: Estimate[], total}` | 401, 403, 5xx |
| 2 | `GET /api/invoices?job_id=` | — | `{rows: Invoice[], total}` (rows carry `amount_paid`, `balance_due`) | 401, 403, 5xx |
| 3 | `GET /api/estimates/:id` · `GET /api/invoices/:id` | — | `{...doc, items[], contact_email, contact_phone, service_address}` | 404, 403 |
| 4 | `POST /api/estimates` | `{job_id, items, tax_rate?, discount_type?, discount_value?}` | 201 doc+items | 400 `VALIDATION` (incl. item-or-summary G4, job not found), 403 |
| 5 | `POST /api/invoices` | `{job_id, items, tax_rate?, discount_amount?}` | 201 doc+items | 400 `VALIDATION` (contact unresolvable), 403 |
| 6 | `PUT /api/estimates/:id` | scalars + `items?` (§3.4.2) | doc+items (status may reset to draft — G8) | 400 `VALIDATION`, **409 `ARCHIVED`**, 404 |
| 7 | `PUT /api/invoices/:id` | scalars + `items?` (§3.4.2; `[]` = clear, omitted = untouched) | doc+items | 400 `VALIDATION`, 404 |
| 8 | `POST /api/estimates/:id/send` | `{channel:'email'\|'sms', recipient, message?}` | doc (status→sent) | **409 `MAILBOX_NOT_CONNECTED`**, **422 `NO_PROXY`/`NO_PHONE`**, **402 `WALLET_BLOCKED`**, 400 `VALIDATION`, 404 |
| 9 | `POST /api/invoices/:id/send` | same; `includePaymentLink` omitted | doc (status→sent) | same set |
| 10 | `GET /api/price-book/categories` | — | `{categories[]}` (flat envelope; errors `{error,message}`) | 403, 5xx |
| 11 | `GET /api/price-book/groups` | `search?` (NO category param — G9) | `{groups[{…, category_id, category_name, item_count, total}]}` | 403, 5xx |
| 12 | `GET /api/price-book/groups/:id/expand` | — | `{items[{name, description, quantity:string, unit, unit_price:string, taxable}]}` | 404, 403 |
| 13 | `GET /api/price-book/items` | `search?, category_id?, limit(50), offset` | `{items[]}` | 403, 5xx |
| 14 | `GET /api/tasks` | `limit(100 default, 500 max), offset` — NOTHING else (§4.1) | `{tasks: Task[]}` (row: `id, description, status:'open'\|'done', due_at, completed_at, created_at, parent_type (§4.4 six values), parent_id, parent_label, owner_user_id, author_user_id, assignee_name, author_name, kind, …`) | 403, 5xx |
| 15 | `GET /api/tasks/count` | — | `{count}` | ALL silent (§4.5) |
| 16 | `POST /api/tasks` | `{parent_type:'job', parent_id, description, due_at?}` — never `owner_user_id` | 201 `{task}` | 400 (`MISSING_PARENT`/`DESCRIPTION_REQUIRED`/`INVALID_DUE_AT` — all client-unreachable), 404 `NOT_FOUND` (parent gone) |
| 17 | `PATCH /api/tasks/:id` | `{status:'done'}` | `{task}` | 404 `NOT_FOUND`, 403 `ACCESS_DENIED` |
| 18 | `GET /api/jobs` | `search, limit=20` | `{results: SyncJob-shaped[], total, offset, limit, has_more}` | 5xx (compact row §5.2) |
| 19 | `GET /api/jobs/:id` | — | job (SyncJob shape) | 404 flat `{ok:false,error:string}` |
| 20 | `GET /api/contacts` | `search, limit=20` | `{results[{id, full_name, phone_e164, secondary_phone, email, …}], pagination{offset,limit,returned,has_more}}` | 5xx (compact row) |

Explicitly NOT called: estimates approve/decline/convert/archive/restore/delete/public-link/pdf/items subroutes, invoices void/record-payment/sync-items, price-book writes/import/export, tasks DELETE/assignees/entity, `include_archived` anywhere.

---

## §7. Error & UI copy catalog (English; tone = v1's short Alert style)

| Situation | Copy (title / body) |
|---|---|
| Offline read placeholder | **Needs connection** / "Connect to the internet and try again." [Retry] |
| Offline write (generic) | **You're offline** / "Reconnect to save your changes." (send: "…to send." · task complete: "…to complete tasks." · task create: "…to add tasks.") |
| Non-ApiError mid-write | **You're offline** / "Nothing was saved." |
| 403 any read | "Not available for your account" (inline state, no alert) |
| 403 task PATCH | **You can't change this task** |
| Doc 404 | **This document is no longer available** → back |
| Task 404 (complete) | **This task is gone** / "It may have been deleted." |
| Task-create parent 404 | **That job is no longer available** / "Pick another job." |
| 409 `ARCHIVED` | **This estimate was archived** / "It's now read-only. Ask the office to restore it." |
| 409 `MAILBOX_NOT_CONNECTED` | **Email isn't set up** / "Ask the office to connect the company mailbox." |
| 422 `NO_PROXY` | **Text isn't set up** / "Ask the office — there's no company sending number yet." |
| 422 `NO_PHONE` | **Enter a valid phone number** (sheet stays open) |
| 402 `WALLET_BLOCKED` | **Sending is paused** / "Ask the office to top up the messaging balance." |
| 400 on send | **Couldn't send** / "Check the recipient and try again." |
| 400 on save | **Couldn't save** / server message when human-readable, else "Please try again." |
| Editor sent-hint (estimate) | "Saving returns this estimate to draft." |
| Zero-item gates | "Add at least one item." · Send: "Add at least one item to send." |
| Discard confirms | "Discard this estimate?" / "Discard this invoice?" / "Discard this task?" / "Remove all items from this invoice?" |
| Success toasts | "Sent" · "Task added" (document save = silent navigation back, matching v1's minimal-toast habit) |
| Section load failure (partial) | "Couldn't load invoices. Retry" (kind-specific) |
| Search server failure | "Couldn't search the server. Retry" |
| Search offline row | "Server search needs a connection." |
| Empty states | Finance: create affordances only · Tasks: "No open tasks." / "Tasks assigned to you show up here." · Picker: "No price book yet. Add a custom item instead." · Search idle: "Search your jobs, past visits, and customers." |

Tenant-level failures (409/422 proxy/402) deliberately say "ask the office" and never leak internals (Gmail, Twilio, wallet mechanics) — architecture risk 7.

---

## §8. Non-functional

- **§8.1 Performance.** Local search predicate synchronous, < 100 ms @ 300 cached jobs (in-memory array filter). Server search debounce ≥ 300 ms + min 2 chars + latest-wins. All lists use virtualized primitives (`FlatList`/`SectionList` — the app's existing pattern) regardless of size; server tiers are capped at `limit 20` (search) / `100` (tasks) / `50` (price-book items) per page. JobFinanceSection fetches never block the cached card render (independent queries — AC-1).
- **§8.2 Security.** §2.6 in full. Additional grep-level ACs: no `include_archived`, no `assignee_id`, no `price_book.manage`/`record-payment` call sites; `db/` has no new write callers.
- **§8.3 A11y (consistent with v1 screens).** Every interactive row: `accessibilityRole="button"`, label = its visible text (task rows: "{description}, due {date}, {parent_label}"). Task checkbox: `accessibilityRole="checkbox"` + `accessibilityState.checked`, hit target ≥ 44 pt. Money strings rendered as text (Dynamic Type friendly, no fixed-width truncation of totals). `NeedsConnection` Retry is a labeled button. Modals dismissible by the standard swipe + a visible Cancel/Done.
- **§8.4 Quality gates.** App `jest` stays green (44/44 existing) + NEW named suites: `lib/documents` (itemsTouched matrix: touched/emptied/untouched ⇒ array/`[]`/absent; totals preview both formulas; money coercion), `lib/priceBook` (expand-rows→lines string coercion; category client-filter), `lib/tasks` (overdue/undated grouping; optimistic-complete/revert reducer; parent model incl. `timeline` + unknown types), `lib/search` (predicate fields; case-insensitivity; dedup by String(id); latest-wins guard), `api/client` (four error envelopes — §2.4). `tsc --noEmit` clean; `expo prebuild` applies cleanly.
- **§8.5 Release verification (house lesson — jest mocks the DB).** Before build hand-off: exercise create→edit→send (both kinds) and tasks list/complete/create against a real backend + prod-DB copy under a REAL provider account; confirm a non-manage provider's task list excludes a second seeded user's tasks (AC-6); confirm SQLite bytes + sync cursor unchanged after opening a server-search job (AC-8). App build/TestFlight remains owner-gated.

---

## §9. Out of scope / protected (must not change)

- **Protected v1 core:** `src/db/schema.ts` (SCHEMA_VERSION stays 1) and all `src/db/` write paths · `src/sync/` engine + `(updated_at,id)` cursor · `GET /api/sync/jobs` payload (never grows estimates/invoices/tasks) · M01 auth/Keychain · M02 cache isolation · M07 status FSM · M08 notes/photos · M11 push.
- **Backend repo:** zero diffs; migrations stay at 155; all consumed gates (`getProviderScope`, `scopeOwnerId`, `requirePermission`) used as-is, never worked around.
- **Out of scope:** payments of any kind (Tap-to-Pay = v1.5/M12; `record-payment`, `payments.collect_offline`) · company-wide document list screens (D2) · Price Book editing · offline caching/queueing of the new areas (D1) · task delete UI + managing others' tasks · non-job task-parent navigation and deep links to the web CRM (OQ-M2-1 closed) · Pulse/Contacts CRUD/Leads/Telephony/Settings surfaces · Android.

---

## §10. Consolidated edge-case matrix (cross-references)

| # | Situation | Behavior | § |
|---|---|---|---|
| E1 | Offline on any new read surface | `NeedsConnection` + Retry; cached v1 surfaces unaffected | §2.1–2.2 |
| E2 | Offline on any write | pre-check alert; nothing sent; no queue | §2.3 |
| E3 | Nested error envelope | client.ts extraction extension | §2.4 (G1) |
| E4 | 403 anywhere | polite inline state; no client permission logic | §2.6, §7 |
| E5 | One finance list fails | partial render + kind-specific retry row | §3.1 S-FIN-4 |
| E6 | Job reassigned while finance section loads | job-gone overlay wins; queries abandoned | §3.1 S-FIN-7 |
| E7 | Archived estimate: on list / opened / saved | excluded / read-only view / 409 alert | S-FIN-1, S-FIN-10, S-FIN-18 |
| E8 | Zero-item document | estimate: Send+Save gated; invoice: send OK, clear-items confirm | S-FIN-12, §3.4.7, §3.6.6 |
| E9 | Editing a sent estimate | persistent draft-reset hint; server resets on PUT | §3.4.6 (G8) |
| E10 | Save untouched items | `items` key omitted — invoice items byte-untouched (AC-3) | §3.4.2 |
| E11 | Concurrent edit (two editors) | last-write-wins; fresh seed + focus-refetch surface it | S-FIN-20 |
| E12 | Create abandoned | local-only draft discarded; no server orphan | S-FIN-15 (G4) |
| E13 | Send prerequisites missing (tenant-level) | 409/422/402 → "ask the office" copy | S-FIN-28, §7 |
| E14 | Optimistic complete fails | row reverts + status-specific alert | S-TSK-8 |
| E15 | Task parent job vanished | create: 404 → re-pick; row-tap: online 404 → "Job not available" | S-TSK-12, S-TSK-14 |
| E16 | `timeline`/unknown task parent | info-only chip, never crashes | §4.4 (G2) |
| E17 | Badge count fails | silently absent | §4.5 |
| E18 | Stale search response | latest-request-wins drop | §5.2 |
| E19 | Job in both search tiers | deduped by String(id), local wins | §5.2 |
| E20 | Server-search job opened | online render, zero SQLite writes, cursor untouched | §5.5 (AC-8) |
| E21 | Huge lists | virtualized + limit caps + Load more (tasks) / passive "N more" (finance) | §8.1, S-TSK-5, S-FIN-6 |
| E22 | App backgrounded mid-write | fetch either lands (server state moves; focus-refetch reconciles) or throws → §2.3 step 4. No retry, no queue | §2.3 |
| E23 | 401 mid-flow | existing M01 token-refresh seam handles it below the API layer; unrecoverable → v1 re-login flow, drafts lost (accepted) | §2.6, 001-spec §C2 |

---

**Readiness:** every FR is covered by numbered scenarios (30 S-FIN/TSK/SRCH + matrix), all 20 consumed calls pinned with verified envelopes and error sets, copy catalog complete, AC-1..11 all traceable (AC-3 → §3.4.2/E10; AC-6 → §4.1/§8.5; AC-8 → §5.5/E20; AC-11 → §0/§6/§9). Next pipeline steps: Test Cases (Agent 04) referencing §-numbers, then the atomic plan (Agent 05).
