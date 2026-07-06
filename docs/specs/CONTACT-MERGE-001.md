# CONTACT-MERGE-001 — confirm-dialog merge/transfer when a user adds another contact's phone/email

**Status:** Spec · **Priority:** P1 · **Type:** feature — backend (conflict detection + 409 round-trip in `PATCH /api/contacts/:id`, phone-side resolution, `mergeContacts` extension for calls/phone slots, transfer primitives) + frontend (`MergeContactsDialog` confirmation + shared conflict-flow hook wired into both v1 editors) · **Surface:** `backend/src/services/contactEmailMergeService.js`, `backend/src/routes/contacts.js` `PATCH /:id`, `frontend/src/components/contacts/{MergeContactsDialog.tsx (NEW), useContactConflictFlow.ts (NEW), EditContactDialog.tsx, PulseContactPanel.tsx}`, `frontend/src/services/contactsApi.ts`.
**From:** requirements CONTACT-MERGE-001 (FR-1..FR-10, AC-1..AC-10, owner decisions 1–4 binding) + architecture (Decisions A–F binding). Partially replaces the silent D2a/D2b branches of **CONTACT-EMAIL-MERGE-001** (everything else of that spec stays in force).

## General description

When a user editing a contact adds a **phone or email that already belongs to ANOTHER contact of the same company**, the system no longer acts silently. `PATCH /api/contacts/:id` detects the conflict **at the top of its transaction** (before any write), ROLLBACKs, and returns **409 `CONTACT_ATTRIBUTE_CONFLICT`** with a full dialog payload. The client shows a two-column confirm dialog — Contact 1 (editing) / Contact 2 (owner) with each side's name + ALL phones + ALL emails, the conflicting attribute(s) highlighted — and offers: **Merge contacts** (full merge; survivor = the edited contact, its scalar fields win, dup deleted), **Transfer phone/email** (the single attribute + its thread move; the owner contact survives — offered only when the owner would keep ≥1 phone-or-email), or **Cancel** (nothing was ever committed). Confirmation is a **repeat of the SAME PATCH carrying `resolutions[]`**; detection re-runs inside the commit tx (`SELECT … FOR UPDATE` on target + each owner), so the executed action can never be stale.

This closes three real gaps: (1) the silent D2a auto-delete / D2b auto-re-point of CONTACT-EMAIL-MERGE-001 — no contact is ever deleted or stripped without explicit confirmation; (2) the **scalar-`email` hole** — `PulseContactPanel.tsx` (~line 82) sends `PATCH {email}` without `emails[]`, which today bypasses `contact_emails` and the merge entirely (the real 4175/4228 prod incident); the fix is **server-side** (Decision E), so EVERY client of the route is protected; (3) the **phone side**, previously uncovered — two contacts could silently share a number (`mergeOrphanTimelines` handles only ownerless orphan timelines).

**Silent branches stay silent (FR-9):** inbox-only email linking (D3 / `linkInboxMessages`), the owner==target no-op, and the async orphan-phone `mergeOrphanTimelines` are byte-for-byte unchanged. Background paths (lead-create, Mail Secretary, VAPI, email ingestion) never see a dialog and never change behavior.

## API contract — `PATCH /api/contacts/:id` (conflict round, Decision A)

- **Middleware chain unchanged:** `app.use('/api/contacts', authenticate, requireCompanyAccess, contactsRouter)` + `requirePermission('contacts.edit')`. **No new route, no `server.js` edit.** `company_id` only from `req.companyFilter?.company_id`; foreign/absent contact id → existing `404 NOT_FOUND` guard.
- **Request body** — everything of CONTACT-EMAIL-MERGE-001 plus:
  ```
  resolutions?: Array<{
    owner_contact_id: number,
    action: 'merge' | 'transfer',
    attributes: Array<{ kind: 'phone' | 'email', value: string }>
  }>
  ```
- **Round 1 (no/insufficient resolutions):** `BEGIN` → detect conflicts + lock (`FOR UPDATE` on target and each owner row) → any detected conflict lacks a matching resolution → **ROLLBACK** → **409**:
  ```
  {
    ok: false,
    error: { code: 'CONTACT_ATTRIBUTE_CONFLICT', message, correlation_id },
    conflict: { conflicts: [ {
      owner:   { id, full_name, company_name, phones: [{value, label, slot}], emails: [{email, is_primary}] },
      editing: { same shape },
      attributes: [ { kind: 'phone'|'email', value, normalized } ],
      transfer_allowed: boolean
    } ] }
  }
  ```
  (mirrors the `leads.js` `CONTACT_AMBIGUOUS` 409 precedent: `ok:false` error envelope + a data sibling). Conflicts are **grouped by owner**: several conflicting attributes of ONE owner = one array entry (one dialog); different owners = separate entries (sequential dialogs client-side, but **ONE retry PATCH** carrying all resolutions). `transfer_allowed` is the server-computed FR-3 flag — the client only renders it.
- **Round 2 (retry):** the client re-sends the **same body** + `resolutions[]`. Matching is **strict echo**: for every DETECTED conflict there must be a resolution with the same `owner_contact_id` AND the same detected attribute set (`attributes` echoed = staleness check). Mismatch/absence → ROLLBACK + fresh 409 (never a stale destructive action, AC-10). A resolution matching **no** detected conflict is **ignored** — this makes the confirmed retry idempotent (after success detection finds nothing; the leftover resolutions no-op; the PATCH degrades to a plain save).
- **Cancel (FR-7/AC-6):** the client simply does not retry. Round 1 committed nothing (detection precedes ALL writes) — DB byte-for-byte, nothing to undo.
- **Success response** unchanged: `{ ok:true, data:{ contact } }` reflecting the post-resolution state. Async post-commit legs — leads-cascade, `mergeOrphanTimelines`, ZB contact push — keep firing unchanged.
- **Frontend (`contactsApi.ts`):** `updateContact(contactId, fields, resolutions?)`; `ContactsApiError` gains `details?` carrying the 409 body's `conflict` payload; export `ContactConflict` / `ContactConflictResolution` types.

## Service contract — `contactEmailMergeService` extensions

All new functions: **tx-aware** (trailing `client`, falls back to `db`), **company-scoped on every SQL leg**, **idempotent**, called only inside the PATCH tx.

### `detectAttributeConflicts(targetContactId, { phones:[digits], emails:[normalized] }, companyId, client)` (Decision B)
Called FIRST inside the tx. Inputs: **added-phone set** = each submitted `phone_e164`/`secondary_phone` that is non-empty and (by digits) not already on the target; **added-email set** = newly-added `emails[]` entries **plus** the Decision-E scalar branch. Phone owner lookup (company-scoped, `id <> target`): full-digit equality legs on `phone_e164`/`secondary_phone` (served **verbatim** by the mig-149 expression indexes) OR `RIGHT(digits,10)` legs (correctness fallback for legacy non-E.164 rows; per-Save single lookup, not a hot path), `ORDER BY updated_at DESC LIMIT 1` (take-latest for legacy multi-owner dirt; the next Save surfaces the next owner). Email owner lookup = `findEmailContact` (reused). Owner rows AND the target are locked `FOR UPDATE` at detection; results grouped by owner id; `transfer_allowed` computed per owner (FR-3 gate below).

### `ContactConflictError` sentinel — no silent path left
`resolveAddedEmail`'s two **separate-owner** branches (old D2a full-merge, old D2b re-point) now **throw `ContactConflictError`** instead of acting. Its only caller is the PATCH; the route catches the sentinel → ROLLBACK → **fresh 409**. So even a conflict born INSIDE the tx (owner inserted after detection) can never be silently destroyed. The **inbox-only (D3)** and **owner==target** branches are byte-for-byte unchanged, as is `linkInboxMessages`.

### `mergeContacts(survivorId, dupId, companyId, client)` — extended additively (Decision C2, FR-4)
FK-recipe B3 preserved and mandatory (tasks → timelines → contact order; open-task re-home BEFORE any timeline delete; NOT-EXISTS M2M guards; dup deleted LAST; tenant-guard throw). Two steps inserted between existing steps 3 (email_messages re-point) and 4 (SET-NULL children):

- **3b. Re-point calls BEFORE the dup-timeline delete** — `calls.timeline_id` has **no ON DELETE action**, so deleting a dup timeline still holding calls violates the FK (v1's email-only dups never had calls; a generic dup does): `UPDATE calls SET timeline_id=$survivorTl, contact_id=$survivor WHERE timeline_id = ANY($dupTlIds)` (index scan on `idx_calls_timeline_id`) + `UPDATE calls SET contact_id=$survivor WHERE contact_id=$dup AND company_id=$` (calls carry company_id since mig 012).
- **3c. Phone-slot fill (OQ-2 default, binding)** — the dup's `phone_e164`/`secondary_phone` fill the survivor's **FREE slots only** (`phone_e164` first, then `secondary_phone`; `secondary_phone_name` carried when the filled slot is secondary and the number had a label). Overflow numbers are **NOT persisted** on the survivor; the fact is recorded via `eventService.logEvent(companyId, 'contact', survivorId, 'contact_merged', { merged_contact_id, merged_name, dropped_phones })` (visible in contact history) + a warn log. **Survivor scalars (name, company, notes, `zenbooker_customer_id`) are NEVER overwritten** — the editor's fields win; the dup's ZB linkage dies with the dup row; **no ZB API call**.
- **SMS need no write:** `sms_conversations` carry no contact/timeline FK — the Pulse lateral resolves them at query time by `customer_digits` against stored contact phones. A number landing in a survivor slot brings its SMS thread automatically. **Documented v1 limitation:** an overflow-dropped number's CALLS still move (they ride the dup timeline), but its SMS conversation **stops surfacing** on the survivor row (no stored phone matches; rows not deleted, just unreachable from the survivor card). Recorded in the `contact_merged` event; full fix = out-of-scope phone M2M.

### `transferPhone(targetId, ownerId, digits, companyId, client)` (Decision D, FR-5)
1. Resolve which owner slot matches by digits; **clear it**. **OQ-3 promotion (decided: yes):** if the cleared slot is `phone_e164` and `secondary_phone` is set → `phone_e164 = secondary_phone`, then clear `secondary_phone` + `secondary_phone_name` (the label names the secondary slot; no primary-label column exists — accepted micro-loss).
2. `targetTl = findOrCreateTimelineByContact(target, companyId, client)` (adopts orphans, re-homes shadow-orphan open tasks); resolve the owner's timeline; re-point **ONLY this number's calls**: `UPDATE calls SET timeline_id=$targetTl, contact_id=$target WHERE timeline_id=$ownerTl AND (RIGHT(digits(from_number),10)=$last10 OR RIGHT(digits(to_number),10)=$last10)` — `idx_calls_timeline_id` scan + per-row filter over ONE timeline's calls (bounded; no new index). The owner's other number and its calls stay put (AC-3).
3. **SMS: no write** — query-time digit resolution flips the conversation to the target automatically once the target's UPDATE carries the number and the owner's slot is cleared.
4. The number lands on the **target** via the normal PATCH field UPDATE (execution-order step 3), NOT inside `transferPhone`. Future inbound calls/SMS route to the target automatically (`findOrCreateTimeline` digit-match now finds only the target).

### `transferEmail(targetId, ownerId, emailNormalized, companyId, client)` (Decision D, FR-6)
Delete the owner's `contact_emails` row for the address; if it was the owner's scalar `contacts.email`, **sync the scalar** to the owner's remaining primary-or-first `contact_emails` row (or NULL); then `linkInboxMessages(target, emailNormalized, companyId, client)` re-points every `email_messages` row of the address onto the target's timeline (reused loop; mig-143 index; idempotent re-link). The target side (enrichEmail upsert + primary reconcile) is already done by the PATCH email block. Unlike old D2b, the address is **REMOVED from the owner** — single ownership.

### FR-3 single-attribute gate (drives `transfer_allowed`)
Server-side simulation: owner's inventory = `{phone_e164, secondary_phone} ∪ {scalar email + all contact_emails}` **minus ALL conflicting attributes of this dialog**; `transfer_allowed = (remaining ≥ 1)`. Computed at detection AND **re-checked when executing a `transfer` resolution** — a stale-allowed transfer aborts with the sentinel → fresh 409. When false, the dialog offers only Merge + Cancel (with a one-line explanation); **no silent auto-merge remains** even for email-only auto-contacts (D2a replaced).

## Execution order inside the ONE PATCH tx (Decision C)

`BEGIN` → **(1)** `detectAttributeConflicts` + `FOR UPDATE` locks → **(2)** validate `resolutions[]` against detected conflicts (strict echo; mismatch/absence → ROLLBACK + 409) → **(3)** the existing contact UPDATE + `contact_emails` upsert/primary-reconcile/FR-8 removal (unchanged) → **(4)** execute each validated resolution: `merge` → `mergeContacts(target, ownerId, companyId, client)`; `transfer` → `transferPhone`/`transferEmail` per attribute → **(5)** the existing per-new-address `resolveAddedEmail` loop for NON-conflicted addresses (inbox-only/self branches only; a separate-owner surprise throws the sentinel → ROLLBACK → fresh 409) → `COMMIT`. Post-commit, unchanged and outside the tx: leads-cascade, async `mergeOrphanTimelines` (adopts orphan timelines of the just-gained number), async ZB contact push.

## Decision E — scalar `email` handled server-side (closes 4175/4228 for every client)

When the body carries a scalar `email` **without** `emails[]`, and the normalized value is non-empty and not already on the contact (scalar or `contact_emails`): treat it as a **newly-added address** — include it in `detectAttributeConflicts`; on the no-conflict/resolved path run `enrichEmail(id, email, client)` + `resolveAddedEmail(id, email, companyId, client)` inside the tx (the scalar path now also persists `contact_emails`). The scalar column write itself is unchanged. `emails[]`, when present, takes precedence (scalar skipped — existing behavior). `PulseContactPanel` keeps its scalar payload — it only needs the 409→dialog→retry handling.

## UI — `MergeContactsDialog` + `useContactConflictFlow` (shared by both surfaces)

- **`MergeContactsDialog.tsx` (NEW)** — **center modal `<Dialog><DialogContent variant="dialog">`** (canonical confirmation surface, NOT `variant="panel"`; mobile renders as BottomSheet automatically per OVERLAY-CANON-002 — no extra code). Title "Merge contacts?"; **two-column grid** (`grid-cols-1 sm:grid-cols-2`) — Contact 1 (editing) / Contact 2 (owner): name (semibold), then all phones and all emails as plain rows (icons `size-3.5` `--blanc-ink-3`, no empty rows), the conflicting attribute(s) highlighted by weight + `--blanc-ink-1` vs `--blanc-ink-3` (Blanc tokens only, no hardcoded hex). Actions — literal, each with a one-line consequence hint (FR-2): primary **`Merge contacts`** ("Contact 2 will be deleted; all its history moves here"); secondary **`Transfer phone`** / **`Transfer email`** shown ONLY when `transfer_allowed` ("Only this number/email and its thread move; the contact stays") — when hidden, a one-liner explains why (a contact can't be left with no phone and no email); ghost **`Cancel`**. No input fields, no attribute picker (v1 constraint). Escape/backdrop = Cancel (shared overlay logic; no hand-rolled close button).
- **`useContactConflictFlow.ts` (NEW hook)** — the save→conflict→retry state machine: call `updateContact`; on `ContactsApiError` with `code === 'CONTACT_ATTRIBUTE_CONFLICT'` read `error.details.conflicts`; show the dialog **sequentially per owner**; collect `resolutions[]`; all confirmed → **ONE** retry `updateContact(body, resolutions)`; any Cancel → abort entirely, editor keeps its entered state (FR-7). A retry that 409s again (stale) restarts the dialog round with the fresh payload.
- **`EditContactDialog.tsx`** — `handleSubmit` routed through the flow; on cancel the panel stays open with entered values; on success proceeds as today (toast, close, `onSuccess`).
- **`PulseContactPanel.tsx`** — `handleSaveEmail` (scalar payload unchanged) routed through the same flow; renders the dialog.

## Behavior scenarios

Contexts below: "editor" = either v1 surface unless stated; all within one company unless stated.

#### S1 — Email conflict → Merge (owner has identity)
- **Pre:** target "Jane" (has phone, ZB-linked); owner "X Acme" holds `x@acme.com` (in `contact_emails` + scalar) and also has a phone, a lead, an open task, calls and SMS on his timeline.
- **Steps:** in `EditContactDialog` add `x@acme.com` to Jane, Save → PATCH detects the conflict at tx top → ROLLBACK → 409 (`conflicts[0] = { owner: X Acme, editing: Jane, attributes:[{kind:'email', value:'x@acme.com'}], transfer_allowed:true }`) → dialog shows both compositions with the address highlighted → user clicks **Merge contacts** → retry PATCH with `resolutions:[{owner_contact_id: xAcmeId, action:'merge', attributes:[{kind:'email', value:'x@acme.com'}]}]` → in-tx: detection re-confirms → contact UPDATE + email upsert → `mergeContacts(Jane, XAcme)` runs B3 + 3b/3c.
- **Result (AC-2):** Jane's name/company/notes untouched; X Acme's phone fills Jane's free slot (3c), his emails land in `contact_emails` (NOT-EXISTS guard); his lead/task/calls/SMS/emails all on Jane's timeline; the open task alive (re-homed BEFORE timeline delete); Jane's `zenbooker_customer_id` unchanged, X Acme's ZB linkage dropped, **no ZB API call**; X Acme deleted LAST; `findEmailContact`/phone resolve → Jane.
- **Side effects:** `contact_merged` event on Jane; Pulse list shows ONE merged conversation row for Jane (thread surfaces via unchanged `email_by_contact` CTE / SMS digit-lateral on next fetch — no SSE, no query change).

#### S2 — Email conflict → Transfer email
- **Pre:** owner "Bob" holds `bob@acme.com` (his scalar primary) plus a second address and a phone; his `email_messages` for the address are on his timeline. Target = "Acme Billing".
- **Steps:** add `bob@acme.com` to Acme Billing, Save → 409 (`transfer_allowed:true` — Bob keeps a phone + another email) → user clicks **Transfer email** → retry with `action:'transfer'` → in-tx: PATCH email block upserts the address on the target; `transferEmail` deletes Bob's `contact_emails` row, syncs his scalar to his remaining address, `linkInboxMessages` re-points every `email_messages` of the address onto Acme Billing's timeline.
- **Result (AC-4):** the address exists ONLY on Acme Billing; its messages are on Acme Billing's timeline; Bob survives with his phone, other email, calls, and the rest of his history untouched. Future inbound from the address resolves to Acme Billing.
- **Side effects:** Bob's scalar `contacts.email` now shows his remaining address (or NULL if the transferred one was his only… not here — FR-3 guaranteed he keeps ≥1).

#### S3 — Phone conflict → Merge
- **Pre:** target "Acme Billing"; owner "Bob" whose `phone_e164` = `+1617…22`; Bob has calls on that number and a job.
- **Steps:** add `+1617…22` as Acme Billing's `secondary_phone`, Save → detection digit-matches Bob (mig-149 index legs; `FOR UPDATE`) → 409 → user picks **Merge contacts** → retry → `mergeContacts(AcmeBilling, Bob)`: 3b re-points Bob's calls to the survivor timeline BEFORE Bob's timeline is deleted (calls FK trap), his job re-points (step 4), his phones fill free slots (3c), Bob deleted last.
- **Result:** one contact holding both numbers (slot capacity permitting), all calls/SMS/jobs/tasks under Acme Billing; Bob gone; inbound on the number routes to Acme Billing.
- **Side effects:** `contact_merged` event; if both contacts had 2 numbers, the overflow number is dropped per OQ-2 (S15).

#### S4 — Phone conflict → Transfer phone (with secondary→primary promotion)
- **Pre:** owner "Bob" — `phone_e164` = `+1617…22` (the conflicting number), `secondary_phone` = `+1617…33` with `secondary_phone_name` "Wife"; calls from BOTH numbers on his timeline; a job. Target = "Acme Billing" adding `+1617…22`.
- **Steps:** Save → 409 (`transfer_allowed:true` — Bob keeps `+1617…33`) → **Transfer phone** → retry → in-tx: PATCH field UPDATE writes the number onto the target; `transferPhone` clears Bob's `phone_e164`, **promotes** `+1617…33` to `phone_e164` and clears `secondary_phone`+`secondary_phone_name` (OQ-3; the "Wife" label is the accepted micro-loss); re-points ONLY calls whose from/to last-10 digits match `…22` from Bob's timeline to the target's (`findOrCreateTimelineByContact` on the target first — shadow-orphan open-task re-home included).
- **Result (AC-3):** the number is gone from Bob and lives on Acme Billing; `…22` calls are on Acme Billing's timeline; Bob's `…33` calls, job, and everything else stay put; Bob is NOT deleted. `…22`'s SMS conversation now surfaces on Acme Billing (query-time digit match — no SMS row written). Future inbound `…22` calls/SMS route to Acme Billing.
- **Side effects:** none beyond the above — no event is emitted for transfers (only `contact_merged` for merges).

#### S5 — Cancel (either kind) → byte-identical DB
- **Steps:** Save triggers the 409 dialog (round 1 ROLLBACKed everything, including non-conflicting field edits); user presses Cancel / Escape / backdrop.
- **Result (AC-6):** the client does not retry — DB is byte-for-byte unchanged (contact, `contact_emails`, timelines, calls, messages, tasks); the editor stays open with the entered values; the user can remove the conflicting attribute and re-Save (passes with no dialog).
- **Side effects:** none. Cancel in ANY dialog of a multi-owner sequence (S7) aborts the whole Save the same way.

#### S6 — Donor with a single attribute → merge-only dialog (D2a replacement)
- **Pre:** the added address belongs to an email-only auto-contact (one email, no phone, zero identity rows) — exactly what old D2a silently consumed. (Same behavior for an owner whose ONLY attribute is the phone being taken.)
- **Steps:** Save → 409 with `transfer_allowed:false` (FR-3 simulation: inventory minus the conflicting attribute = 0) → dialog shows both columns but ONLY **Merge contacts** + Cancel, with the one-line explanation; user confirms → retry `action:'merge'` → full merge + delete.
- **Result (AC-5):** the dup is merged and deleted **only after explicit confirmation** — no silent auto-merge remains anywhere. A retry attempting `action:'transfer'` against this owner is rejected (fresh 409; the gate is re-checked server-side at execution).
- **Side effects:** `contact_merged` event on the survivor.

#### S7 — Multiple conflicts in one Save → grouped by owner, sequential dialogs, ONE retry
- **Pre:** one Save adds a phone owned by contact A and an email owned by contact B; additionally A also owns a second attribute being added (e.g. his email too).
- **Steps:** Save → single 409 with `conflicts:[{owner:A, attributes:[phone, email], …}, {owner:B, attributes:[email], …}]` (A's two attributes in ONE entry = one dialog). `useContactConflictFlow` shows dialog for A → user resolves (merge or transfer) → dialog for B → user resolves → hook sends **ONE** retry PATCH with both resolutions → in-tx both execute in order.
- **Result:** each owner resolved independently per the user's choice; per FR-2 a transfer resolution covers the owner's whole attribute set of that dialog (no partial picker in v1). Cancel at either dialog = whole Save aborted (S5).
- **Side effects:** for each merge, one `contact_merged` event.

#### S8 — Scalar email via Pulse panel → same flow (4175/4228 closed)
- **Pre:** dispatcher types an email into `PulseContactPanel`'s inline editor (payload stays `PATCH {email}` — no `emails[]`).
- **Steps:** Decision E: the server treats the non-empty, not-already-owned scalar as a newly-added address — included in detection. (a) **No conflict:** the tx writes the scalar AND `enrichEmail` persists the `contact_emails` row AND `resolveAddedEmail` links any inbox-only correspondence — the address is now visible to every `contact_emails`-keyed join. (b) **Conflict:** 409 → the SAME `MergeContactsDialog` via `useContactConflictFlow` → merge/transfer/cancel with identical outcomes to S1/S2/S5.
- **Result (AC-7):** the scalar path can no longer create a silent duplicate from ANY client of the route; the inline editor keeps its UX (spinner during save; on cancel the draft stays).
- **Side effects:** as per the chosen branch.

#### S9 — Stale echo: owner changed between 409 and retry
- **Pre:** user got the 409 for owner O (attributes = {phone P}); before the retry, another session transferred P away from O (or gave O a new conflicting attribute).
- **Steps:** retry arrives with `resolutions:[{owner_contact_id:O, action:…, attributes:[P]}]` → in-tx detection re-runs under `FOR UPDATE`: either the conflict no longer exists (P is unowned/owned by the target now — the resolution matches nothing and is **ignored**; the save proceeds plainly) or the detected attribute set for O differs from the echoed one → strict-match failure → ROLLBACK + **fresh 409** with the current payload; the dialog round restarts.
- **Result (AC-10):** a stale resolution is NEVER executed; the user always confirms against current reality.
- **Side effects:** none on the mismatch path (full rollback).

#### S10 — Idempotent repeated retry (double-submit)
- **Steps:** the confirmed retry succeeds; a duplicate of the same request (double click / network retry) arrives.
- **Result (FR-10):** detection finds no conflicts (the attribute now belongs to the target; the merged dup is gone so the owner lookup finds nothing — the `mergeContacts` tenant-guard throw is never reached); the leftover `resolutions[]` match nothing → ignored; the PATCH degrades to a plain idempotent save. Re-run `transferPhone` semantics: owner slot already clear, calls already moved → 0-row UPDATEs; re-run `transferEmail`: no row to delete, re-link no-ops.
- **Side effects:** none — no duplicate events, no double-merge, no errors.

#### S11 — Cross-tenant isolation
- **Pre:** the identical number/address string belongs to a contact of company B; the editor works in company A.
- **Result (AC-9):** detection is company-scoped (`companyId` from `req.companyFilter?.company_id` on every leg) — the B-owner is invisible: **no conflict, no dialog**, the attribute saves normally for A; B's rows are never read, re-pointed, or deleted (mig-149/`findEmailContact` lookups scoped; `mergeContacts` tenant guard; transfers verify owner ∈ company at detection). A forged `resolutions[].owner_contact_id` pointing at a B-contact matches no detected conflict → ignored; a foreign `:id` → 404. Verified against a two-company fixture.

#### S12 — Conflict with self → no-op, no dialog
- **Steps:** Save re-submits an attribute the target already owns (idempotent re-save), or adds its own secondary number as primary.
- **Result:** the added-attribute sets exclude values already on the target (by digits / normalized address); `resolveAddedEmail`'s owner==target branch stays a no-op — **no detection hit, no dialog**, byte-identical outcome to today's re-save.

#### S13 — Owner deleted between rounds (unreachable branch)
- **Pre:** the 409 was issued for owner O; before the retry O was deleted (or merged away by another session).
- **Steps:** retry → detection finds no owner for the attribute (it is now inbox-only or unowned) → no conflict detected → the echoed resolution matches nothing → **ignored** → the save proceeds: the attribute lands on the target; for an email, `resolveAddedEmail` takes the now-silent inbox-only branch and links any stray messages.
- **Result:** no error, no stale merge against a ghost; the user's intent (attribute on the target) is fulfilled.

#### S14 — Error mid-resolution → full rollback
- **Steps:** any leg of the tx fails after confirmation (constraint violation, in-tx sentinel from a surprise owner, DB error during `mergeContacts`/transfer).
- **Result:** `ROLLBACK` — the contact UPDATE, `contact_emails` writes, and every resolution effect are all undone; **never** a half-merge, a deleted contact with orphaned children, or a cleared owner slot without the calls moved. Sentinel → fresh **409**; any other error → **500 INTERNAL_ERROR** (existing `errorResponse` shape). Async legs (leads-cascade, ZB push) run only after COMMIT, so a rollback never triggers them.

#### S15 — Phone-slot overflow on merge (OQ-2) + `contact_merged` audit
- **Pre:** both contacts carry 2 numbers each (4 total; the survivor has 2 slots).
- **Steps:** Merge confirmed → 3c fills nothing (no free slots); the dup's numbers are dropped from contact storage.
- **Result:** the dropped numbers' **calls still move** (3b re-points by timeline); their **SMS conversations stop surfacing** on the survivor (query-time digit match finds no stored phone; rows NOT deleted — documented v1 limitation, fix = out-of-scope phone M2M). `contact_merged` event logged on the survivor with `{ merged_contact_id, merged_name, dropped_phones }` (visible in contact history) + a warn log.
- **Side effects:** none further; no migration, no new table.

#### S16 — Silent branches unregressed + Pulse list after merge/transfer
- **Inbox-only (D3):** adding an address nobody owns still silently links its unowned `email_messages` onto the target — no dialog (FR-9/AC-8).
- **Orphan phones:** the async post-commit `mergeOrphanTimelines` still silently adopts ownerless timelines matching the contact's (possibly just-gained) numbers — byte-for-byte, including after a transfer.
- **Background ingestion** (Gmail push/`linkInboundMessage`, Mail Secretary, VAPI, lead-create): no dialogs, no behavior change — the sentinel lives only in the PATCH-called `resolveAddedEmail` branches, and those paths don't call it.
- **Pulse list:** after a merge, the dup's conversation row disappears and the **survivor's row surfaces** positioned by the merged thread's last activity; after a phone transfer, the SMS/call thread of that number flips from the owner's row to the target's on the next fetch. All via the **unchanged** `getUnifiedTimelinePage` / `email_by_contact` CTE / SMS digit-lateral — data-level moves only, no query or SSE change.

## Error handling

- **409 `CONTACT_ATTRIBUTE_CONFLICT`** — not an error toast: the flow hook intercepts and opens the dialog. Any other `ContactsApiError` keeps today's toasts (`Failed to update contact` / `Failed to save email`).
- **Whole PATCH is ONE transaction** — see S14. 409 always means "nothing committed".
- **Foreign/absent contact → 404** (never 403; no cross-company data in the message). Invalid id → `400 INVALID_ID`. No fields and no emails → `400 NO_FIELDS` (unchanged; `emails: []` remains a valid removal-only update).
- **Malformed `resolutions[]`** (unknown action, missing owner/attributes) → treated as non-matching → fresh 409 with the current conflict payload (never a 500 for a client-shape problem).

## Component interaction

- `EditContactDialog.tsx` / `PulseContactPanel.tsx` → `useContactConflictFlow` → `contactsApi.updateContact(body, resolutions?)` → `PATCH /api/contacts/:id` → `contacts.js` handler → **tx**: `contactEmailMergeService.detectAttributeConflicts` (locks) → resolution validation → contact UPDATE + email block → `mergeContacts` (+3b/3c) / `transferPhone` / `transferEmail` → `resolveAddedEmail` (silent branches; sentinel otherwise) → `emailQueries.{findEmailContact, listMessageIdsForAddress, linkMessageToContact}` + `timelinesQueries.{findOrCreateTimelineByContact, reassignShadowOrphanOpenTasks}` + `eventService.logEvent`.
- On 409: handler → `conflict` payload → `ContactsApiError.details` → `MergeContactsDialog` (sequential per owner) → one retry.
- **No SSE change**; the Pulse list reflects moves on its next fetch.

## Data isolation

Every leg — detection, owner lock, merge, transfers, call/message re-points, deletes — carries `company_id = req.companyFilter?.company_id` predicates (or contact-scoped equivalents for the no-company_id child tables per the IDENTITY_TABLES notes). Foreign contact id → 404. Same-string attributes in other companies are invisible to detection and untouchable by execution (LIST-PAGINATION-001 / ZB-ISO-001 precedents).

## Non-goals

- **No migration (Decision F):** `contacts` (+mig-027 secondary label), `contact_emails` (025), `calls` (012/028 + `idx_calls_timeline_id`), `email_messages` (079/129) + mig-143 from-email index, `sms_conversations.customer_digits`, mig-149 phone-digit expression indexes cover every lookup/re-point. Max migration verified = 155; next free 156 — **not used** (re-verify max immediately before ever creating one; parallel branches).
- No general "pick two contacts and merge" UI; no partial/checkbox attribute picker; no undo/merge history or dup restore; no phone M2M table (OQ-2 alternative); no conflict dialog in background paths or the mobile app; no unread-model, ZB-push-on-merge, or unified-list query changes.
- Protected untouched: `server.js`, `authedFetch`, `useRealtimeEvents`, `timelineMergeService.mergeOrphanTimelines` + its async trigger, inbox-only D3 linking, background ingestion, `getUnifiedTimelinePage`/`email_by_contact` CTE, `linkMessageToContact`/`findEmailContact` semantics, `contact_emails` invariants, leads-cascade + async ZB push, mig-143/149 indexes. `mergeContacts` B3 order extended additively, never reordered. Prod deploy only with explicit owner consent.

## Verify plan (real DB, not just mocked jest — LIST-PAGINATION-001 lesson)

- **jest (mocks) — the branch matrix:** detection (phone full-digit/last-10, email scalar/array, grouping by owner), strict resolution matching + staleness (S9), FR-3 gate incl. execution-time re-check, OQ-3 promotion, sentinel abort, Decision-E scalar branch, ignored-resolution idempotency, tenancy, malformed `resolutions[]` → 409.
- **Real DB (prod-sized copy) — the effects:** (1) full merge with a call+SMS+email+lead+open-task-bearing dup — full AC-2 checklist (task survives, ZB id kept, dup gone, no dangling children); (2) transfer-phone — this number's calls move, the owner's other number/calls stay, SMS thread flips, future `findOrCreateTimeline` resolves to the target; (3) transfer-email — row moves, scalar syncs, messages re-linked; (4) single-attribute owner → merge-only; (5) cancel → byte-identical dump diff; (6) two-company fixture → no detection/no touch; (7) double-submit → no-op; (8) slot overflow → `contact_merged` event carries `dropped_phones`, calls moved, SMS caveat observed.
- **`EXPLAIN`** the detection phone lookup (mig-149 expression indexes) and the transfer call-filter (`idx_calls_timeline_id`) on the prod copy — no new Seq Scan on hot paths. Document in the PR.
