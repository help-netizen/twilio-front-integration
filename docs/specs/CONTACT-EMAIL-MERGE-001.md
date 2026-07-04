# CONTACT-EMAIL-MERGE-001 — email analogue of the phone-merge

**Status:** Spec · **Priority:** P1 · **Type:** feature — backend (new merge service + PATCH persists `contact_emails`) + frontend (multi-email editor) · **Surface:** `backend/src/services/contactEmailMergeService.js` (NEW), `backend/src/routes/contacts.js` `PATCH /:id`, `contactDedupeService`, `contactsService`, `emailQueries`, contact editor.
**From:** requirements CONTACT-EMAIL-MERGE-001 (D1–D3 binding) + architecture (Decisions A–D binding).

## General description

The contact editor gains a **multi-email list** (one primary + N additional), persisted to `contact_emails` — closing a real gap: `PATCH /api/contacts/:id` today writes only the `contacts.email` scalar and **never** `contact_emails`, so an added address is invisible to every `contact_emails`-keyed join and no correspondence merges. For **each newly-added** address, the backend resolves that address's existing correspondence (within the same company) and merges it onto the contact's timeline — the email counterpart of the shipped phone-merge (`timelineMergeService.mergeOrphanTimelines`). The merge runs **synchronously inside the PATCH handler, in one DB transaction** with the `contact_emails` writes (Decision A — diverges from the phone-merge's fire-and-forget deliberately, because a full-merge DELETEs a contact and the reloaded editor must show the merged result).

## Service contract — `contactEmailMergeService` (NEW)

Email analogue of `timelineMergeService.js`. Every function: **synchronous** (awaited in-request), **tx-aware** (optional trailing `client`; falls back to the `db` pool), **company-scoped** (every SQL leg filtered by `companyId`), **idempotent**. No cross-tenant read/move/delete on any leg.

### `resolveAddedEmail(targetContactId, emailNormalized, companyId, client)`
Per-address entry point the route calls for each newly-added address. Resolves who currently owns `emailNormalized` within `companyId` via a `findEmailContact`-style lookup (`lower(contacts.email) = $ OR contact_emails.email_normalized = $`, company-scoped), then **dispatches** on the owner:

| Owner of the address (within company) | Action | Req |
|---|---|---|
| **None (inbox-only)** — no contact resolves | `linkInboxMessages`: resolve target timeline via `findOrCreateTimelineByContact(target, companyId, client)`, then for every `email_messages` row with `lower(trim(from_email)) = emailNormalized AND company_id = companyId` call `linkMessageToContact(providerMessageId, companyId, { contact_id: target, timeline_id, on_timeline: true })` | D3 |
| **A separate contact that PASSES the emptiness test** (`isContactEmailOnly` → true) | `mergeContacts(survivorId = target, dupId = owner, companyId, client)` — FULL MERGE + delete owner | D2a |
| **A separate contact that FAILS the emptiness test** (has phone or any business entity) | Re-point ONLY that address's `email_messages` (+ thread linkage via `linkMessageToContact`) onto the target's timeline — same message loop as inbox-only, sourced from the owner's messages for that address; **owner is NOT deleted**, keeps all non-email data | D2b |
| **The target itself** (address already on this contact) | **No-op** (idempotent re-save) | FR-5 |

- Message-id source for the inbox-only / D2b loops is a new company-scoped helper `emailQueries.listMessageIdsForAddress(emailNormalized, companyId, client)` (messages by `lower(trim(from_email))`, served by the **mig-143** functional index — no new index).
- The re-link is a no-op UPDATE under redelivery/re-save (`linkMessageToContact` semantics), so the whole entry point is idempotent.

### `mergeContacts(survivorId, dupId, companyId, client)`
Reusable full-merge — the **codified dedup recipe** (no general contact-merge service existed; owner's prior dedup was ad-hoc SQL). Re-points every `contact_id` child from `dupId`→`survivorId`, adopts/merges the timeline, deletes `dupId` **last**. Built generic (a future manual-merge action can reuse it); for v1 reachable only via `resolveAddedEmail`'s D2a branch. FK order is load-bearing (see FK-order recipe below).

### `isContactEmailOnly(contactId, companyId, client)`
The D2a↔D2b gate. Returns `true` **only when** the contact has **no `phone_e164` AND no `secondary_phone` AND zero referencing rows** in ALL of the tables below — i.e. it exists solely to hold email(s). Single `SELECT` of `EXISTS(...) OR EXISTS(...) …` (each company-scoped where the table carries `company_id`), evaluated inside the tx.

**Exact table list checked** (every table with a `contact_id` FK to `contacts(id)`, audited from migrations):
`jobs`, `leads`, `estimates`, `invoices`, `payment_transactions`, `stripe_payment_sessions`, `portal_access_tokens`, `portal_sessions`, `portal_events`, `crm_account_contacts`, `crm_deal_contacts`, `crm_activities`, `tasks`, `contact_addresses`.

**Excluded** (they ARE the email footprint being moved — their presence must NOT block deletion): the dup's own `contact_emails` rows, its `email_messages`, and its `timelines` (adopted/merged, not counted; `timelines.contact_id` is SET NULL).

**Bias:** err toward **NOT empty**. Any doubt/failure degrades D2a→D2b (re-point only, keep the contact) — never a wrong delete. `tasks` counts as identity because an independent task NOT co-located on the email timeline being merged constitutes real activity.

## FK-order merge recipe (in `mergeContacts`, inside the tx)

CASCADE traps mirror ORPHAN-TASK-REHOME-001 (`tasks.thread_id` is `ON DELETE CASCADE`). **Exact sequence:**

1. **Adopt/merge the timeline FIRST** — `survivorTl = findOrCreateTimelineByContact(survivor, companyId, client)` (adopts orphans + re-homes shadow-orphan open tasks via `reassignShadowOrphanOpenTasks`); find the dup's timeline `dupTl`.
2. **Re-point OPEN tasks off `dupTl` BEFORE deleting ANY timeline** — `UPDATE tasks SET thread_id = survivorTl WHERE thread_id = dupTl AND status='open'` (skipping this silently destroys an open Action-Required task via the CASCADE). Also `UPDATE tasks SET contact_id = survivor WHERE contact_id = dup` (contact_id is SET NULL — re-point so history follows). `reassignShadowOrphanOpenTasks` is reused for shadow orphans on the survivor's number.
3. **Re-point `email_messages`** — `UPDATE email_messages SET contact_id = survivor, timeline_id = survivorTl, on_timeline = true WHERE contact_id = dup AND company_id = companyId`. (`email_threads` has NO `contact_id` — threads need no re-point; linkage lives on messages.)
4. **Re-point the remaining SET-NULL history children** — `jobs`, `leads`, `estimates`, `invoices`, `payment_transactions`, `stripe_payment_sessions`, `portal_events`, `crm_activities` → `SET contact_id = survivor` (company-scoped). (In the D2a path these are all empty by the emptiness test → 0 rows moved; `mergeContacts` does them unconditionally for reuse-safety.)
5. **Move M2M / CASCADE children with NOT-EXISTS guards** (dodge unique collisions) — `contact_emails` (`UNIQUE(contact_id, email_normalized)`), `contact_addresses`, `crm_account_contacts` (`UNIQUE(company_id, account_id, contact_id)`), `crm_deal_contacts`, `portal_access_tokens`, `portal_sessions` — `UPDATE … SET contact_id = survivor WHERE contact_id = dup AND NOT EXISTS (SELECT 1 … WHERE contact_id = survivor AND <unique-cols match>)`. Rows that would collide stay on the dup and die with its CASCADE delete (they are dup-of-survivor by definition).
6. **Delete the now-emptied dup timeline(s)**, then **DELETE the dup contact LAST** (after all children re-pointed) — residual CASCADE children (already-moved-or-duplicate) drop cleanly. `findEmailContact(address)` afterwards returns the survivor.

## API contract — `PATCH /api/contacts/:id`

- **Middleware chain unchanged:** `app.use('/api/contacts', authenticate, requireCompanyAccess, contactsRouter)`; route keeps `requirePermission('contacts.edit')`. **No new route, no `server.js` edit.**
- **`company_id` source:** `req.companyFilter?.company_id`, threaded into every merge-service call and SQL leg.
- **404 for a foreign/absent contact** (existing `contactsService.getById(id, companyId, providerScope)` guard) — returns `404 NOT_FOUND`, never revealing another company's data.
- **Request body gains `emails?`** (optional; when omitted, behavior is unchanged — **back-compatible**):
  ```
  emails?: Array<{ email: string; is_primary?: boolean }>
  ```
  Exactly one `is_primary:true` enforced server-side (first flagged primary wins; if none flagged, the first entry is primary).
- **Persistence (inside ONE tx, after the `contacts` row UPDATE, BEFORE `res.json`):**
  1. Normalize each: `email_normalized = lower(trim(email))`; drop blanks/invalid (basic email shape).
  2. **Upsert** each via `contactDedupeService.enrichEmail` semantics (`INSERT … ON CONFLICT (contact_id, email_normalized) DO NOTHING`); handled outside the scalar `allowedFields` loop (it is an array, not a column). Keep the scalar `contacts.email` **in sync with the primary** (existing consumers read it).
  3. **FR-8 non-destructive removal (default):** an address dropped from the list has its `contact_emails` row deleted, but already-linked `email_messages` history **stays** on the timeline (no reverse-merge).
  4. For each address **newly added** in this PATCH (not previously in `contact_emails`), call `contactEmailMergeService.resolveAddedEmail(id, emailNormalized, companyId, client)` **on the tx client**.
- **Response** reflects the **post-merge** state: `{ contact }`. Because the merge is synchronous and in-tx, a reload immediately shows link/merge results (no "just-added email whose merge hasn't run" window).
- **`GET /api/contacts/:id`** returns the email list for the editor to load: extend the detail with an `emails` array (reuse `getContactEmails(contactId, primaryEmail)` / `getAdditionalEmails`). NOTE — the route already surfaces `contact.contact_emails` (a primary-first de-duped `string[]`) at `contacts.js:111`; the editor may consume that existing field or a richer `{email,is_primary}[]` shape.
- **Reuse, don't hand-roll:** `contactDedupeService.enrichEmail` and `getAdditionalEmails` are **defined but NOT currently exported** (`module.exports` lists only `resolveContact`/`searchCandidates`/normalizers/`createNewContactPublic`) — **add both to the exports**. Logic unchanged.
- **Existing async legs stay async and OUTSIDE the tx, unchanged:** the leads cascade (`UPDATE leads … WHERE contact_id`) and the Zenbooker contact push (`syncContactToZenbooker`) — both must keep firing. The phone-merge `mergeOrphanTimelines` async trigger is **untouched** (email path added alongside).

## Behavior scenarios

Each scenario is one newly-added address, resolved independently.

#### S1 — Add an email with inbox-only correspondence → linked
- **Pre:** target has a phone; `x@a.com` has ≥1 inbound `email_messages` with `contact_id IS NULL`, not on any timeline; no contact owns `x@a.com`.
- **Steps:** editor adds `x@a.com`, Save → PATCH tx: `contact_emails` upsert; `resolveAddedEmail` → owner=none → `linkInboxMessages`: `findOrCreateTimelineByContact(target)`, then `linkMessageToContact(...)` for each message (`on_timeline=true`, target timeline, thread attached).
- **Result:** the messages link onto the target's timeline; the target's row surfaces in the Pulse unified list positioned by the thread's last-message time with the email icon (via the existing `email_by_contact` CTE — no list change); the thread shows in timeline detail.
- **Side effects:** `email_messages.{contact_id,timeline_id,on_timeline}` set; `contact_emails` row. No delete.

#### S2 — Add an email owned by an EMPTY auto-contact → full merge + delete
- **Pre:** `x@acme.com` earlier auto-created a bare contact (no name/phone; zero rows in every emptiness-test table) holding that email thread. Target = real contact "Jane".
- **Steps:** add `x@acme.com` to Jane, Save → PATCH tx: `resolveAddedEmail` → owner = auto-contact, `isContactEmailOnly` → **true** → `mergeContacts(survivor=Jane, dup=auto)` runs the FK-order recipe.
- **Result:** the auto-contact's email messages/thread/timeline and any open tasks re-point onto Jane; the emptied auto-contact is **DELETED**. `findEmailContact(x@acme.com)` afterwards returns Jane; the old contact id no longer exists; **no orphaned** `email_messages` / `contact_emails` / open tasks remain.

#### S3 — Add an email owned by a contact WITH a phone or a job → re-point emails only, keep the contact
- **Pre:** `bob@acme.com` belongs to "Bob" who also has a phone AND an open job. Target = "Acme Billing".
- **Steps:** add `bob@acme.com` to Acme Billing, Save → `resolveAddedEmail` → owner = Bob, `isContactEmailOnly` → **false** (phone + job) → re-point ONLY that address's `email_messages` (+ thread link) onto Acme Billing's timeline.
- **Result:** Bob's email correspondence now lives under Acme Billing; **Bob is NOT deleted** — keeps his phone, calls, job, and his own timeline (all non-email data intact). Owner-accepted consequence.

#### S4 — Add a brand-new email, no correspondence → just recorded
- **Steps:** add an address that has never appeared in any message, Save → `contact_emails` upsert (primary if the contact had none, else additional); `resolveAddedEmail` finds no owner and no messages → no link.
- **Result:** exactly one `contact_emails` row; **no** timeline/list change; future inbound/outbound for that address resolves to this contact (`findEmailContact`).

#### S5 — Multiple emails in one Save → each resolved
- **Steps:** editor lists primary + additional, allows adding several, marks exactly one primary; Save sends the full `emails[]`.
- **Result:** each **newly-added** address independently runs its own resolution (link / full-merge / re-point / record) within the same tx. Exactly one `is_primary=true` persisted.

#### S6 — Idempotent re-save (email already on contact) → no-op
- **Steps:** Save again with the same set (or the same address already in `contact_emails`).
- **Result:** `contact_emails` upsert `ON CONFLICT DO NOTHING`; `resolveAddedEmail` treats an address already owned by the target as a **no-op**; nothing re-merged, nothing deleted twice; identical end state.

#### S7 — Cross-tenant isolation → never merged
- **Pre:** the same address string also exists in company B.
- **Result:** every resolution/re-point/delete leg is filtered by the editing contact's `company_id` (`req.companyFilter.company_id`); an address used in company B is **never** read, moved, or deleted into a company-A contact. Verified against a two-company fixture.

#### S8 — Remove an email from the list → row gone, history stays
- **Steps:** drop an address from the editor, Save.
- **Result:** its `contact_emails` row is **deleted**; already-linked `email_messages` history **remains** on the timeline (FR-8 non-destructive default — no reverse-merge). Out of scope: destructive un-merge.

## Error handling

- **Whole PATCH is ONE transaction.** A merge failure (any leg of `resolveAddedEmail` / `mergeContacts`) **rolls back the `contact_emails` write too** — nothing half-done: never `contact_emails` written but merge incomplete, never a contact deleted with children orphaned. On rollback the handler returns `500 INTERNAL_ERROR` (existing `errorResponse` shape) and the DB is unchanged.
- **Foreign / absent contact →** `404 NOT_FOUND` (does not reveal other-company data — 404 not 403 for a foreign id).
- **No valid fields AND no emails →** existing `400 NO_FIELDS` (unchanged). `emails: []` with removals is a valid update.
- **Async legs (leads cascade, ZB push) failing** does not affect the committed tx — they run after `res.json`, errors caught + logged (unchanged).

## Component interaction

- `EditContactDialog.tsx` (multi-email list) → `contactsApi.updateContact({ …, emails })` → `PATCH /api/contacts/:id` → `contacts.js` handler → **tx**: `contacts` UPDATE + `contactDedupeService.enrichEmail` (per address) + `contactEmailMergeService.resolveAddedEmail` (per new address) → `emailQueries.{findEmailContact,listMessageIdsForAddress,linkMessageToContact}` + `timelinesQueries.{findOrCreateTimelineByContact,reassignShadowOrphanOpenTasks}`.
- `GET /api/contacts/:id` → `contactsService.getContactById` + `getContactEmails` → editor loads the list.
- **No SSE change.** The Pulse unified list surfaces the merged thread on its next fetch via the unchanged `email_by_contact` CTE (`getUnifiedTimelinePage`) — resolves contact→thread via `contact_emails.email_normalized`, both directions.

## Data isolation

- Every merge leg (owner resolution, message re-point, thread linkage, contact/timeline delete) is filtered by `req.companyFilter.company_id`. No cross-tenant path (LIST-PAGINATION-001 SMS-leak / ZB-ISO-001 precedents). Address collisions across companies are independent.

## Non-goals

- **No migration** (Decision D): mig 025 (`contact_emails` + `UNIQUE`, CASCADE, `idx_contact_emails_normalized`), mig 079/129 (`email_messages.{contact_id,timeline_id,on_timeline}`), and **mig 143** (`idx_email_messages_from_normalized ON email_messages(company_id,(lower(trim(from_email))))`) cover every lookup; mig 154 already backfilled `contact_emails` from `contacts.email`. No new index (PULSE-PERF-001: no speculative indexes), no historical backfill. Next free number is **156** if one ever becomes necessary (re-verify max immediately before creating — parallel branches).
- **No reverse-merge on removal** (FR-8 default is non-destructive).
- **Phone path untouched** — `mergeOrphanTimelines` + its async trigger + ORPHAN-TASK-REHOME-001 task re-home keep working byte-for-byte; email path is added ALONGSIDE.
- **No auto-merge outside an explicit user email-add** — mail-agent enrichment / `findEmailContact` query-time resolution stays as-is; merge fires only on the add action going forward.
- **No unified-list query change**, no Pulse timeline-detail projection change, no general "merge two arbitrary contacts" UI, no CC/BCC-based merge, no unread-model or ZB-email-push change.

## Verify plan (LIST-PAGINATION-001 lesson — mocked jest is not enough)

- **jest (mocks) — prove the dispatch:** `resolveAddedEmail` routes to link / full-merge / re-point / no-op per owner state; emptiness test toggles D2a↔D2b; exactly-one-primary; `emails` back-compat when omitted; `enrichEmail`/`getAdditionalEmails` now exported.
- **Real DB (prod-sized copy) — prove the merge:** run every branch against a prod-DB copy — inbox-only link, empty-auto-contact **full merge + delete** (assert dup gone, no dangling `email_messages`/`contact_emails`/open tasks), has-identity re-point (assert owner + its phone/job/timeline intact), no-correspondence record, multi-email, two-company cross-tenant isolation; and **idempotence** (run twice → identical state). Confirm FK order destroys no open task.
- **`EXPLAIN`** the inbox-only `from_email` lookup (`listMessageIdsForAddress`) to confirm the **mig-143** functional index `(company_id, lower(trim(from_email)))` is used. Document in the PR.
