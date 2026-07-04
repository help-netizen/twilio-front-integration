# EMAIL-LEAD-ORIGIN-001 — email-only Pulse timelines are first-class: show the contact card, let a lead be born from an email (phone optional)

**Status:** Spec (ready for TestCases/Planner) · **Priority:** P1 · **Date:** 2026-07-04
**Area:** Pulse detail card (frontend) · Leads write-path + by-contact lookup (backend) · Contacts panel robustness
**Depends on:** EMAIL-TIMELINE-001 / EMAIL-OUTBOUND-001 / LIST-PAGINATION-001 (email-only timeline + Pulse-list email signal), CONTACT-EMAIL-MERGE-001 (the email-only contact), mig 023 (`leads.contact_id` + `idx_leads_contact_id`), mig 004 (`leads.phone` NULLABLE, `leads.email`).
**Follows precedent:** ONBOARD-FIX-001 / ZB-ISO-001 (company scoping), PULSE-PERF-001 (do NOT touch the hot list query), LEADS-NEW-BADGE-001 (status-based, phone-independent).

## Problem

An email-only Pulse timeline (a contact exists — or is resolvable — but has **no phone**) is invisible and inert today:

1. **The Pulse detail card is phone-gated.** `PulsePage.tsx:361` renders the whole Lead/Contact/Wizard tri-state only when `!isAnonTimeline && (p.contactId || p.timelineId) && p.phone`. For an email-only timeline `p.phone === ''` (`usePulsePage.ts:69` falls through to `''`), so **no card renders at all** — no identity, no actions, no way to create a lead.
2. **Leads are phone-born.** `CreateLeadJobWizard` takes a mandatory `phone: string` prop, inits its phone field from it, and puts `Phone: toE164(phoneNumber)` into the create payload. `POST /api/leads` hard-requires `Phone` ≥ 5 chars (`leads.js:202`). There is **no way to create a lead from an email without a phone**.
3. **No lead-by-`contact_id` lookup exists.** Leads are looked up only by phone digits (`useLeadByPhone` / `getLeadByPhone` / `GET /by-phone`). A phoneless contact card **cannot tell whether a lead already exists** → it would wrongly offer "create lead" and risk a duplicate.

**Storage is already ready** — `leads.phone` NULLABLE (mig 004), `leads.email` VARCHAR(200), `leads.contact_id` + `idx_leads_contact_id` (mig 023). A phoneless, email-origin lead is storable **today**; only the write-path validation, the create wizard, and the missing lookup block it.

## Scope

Two additive parts. **Every phone path stays byte-for-byte; phone is OPTIONAL, never removed.**

- **PART A — show the contact card for phoneless timelines.** Ungate the Pulse tri-state on **identity** rather than on phone; harden `PulseContactPanel` so phone-only affordances (`tel:`, `ClickToCallButton`, `OpenTimelineButton`) never render with an empty phone. Email affordances (`mailto:`, email composer) stay.
- **PART B — let a lead be born from an email, phone OPTIONAL.** Relax `POST /api/leads` validation to **phone OR email OR `selected_contact_id`**; add a **lead-by-`contact_id`** lookup (route + service + hook) so the card detects an already-linked lead and shows `LeadDetailPanel` instead of re-offering the wizard (duplicate-prevention); make the wizard phone-optional with an email/`contactId` origin. An email-origin lead is **LEAD-ONLY** (no ZB job — ZB needs a phone).

---

## Behavior scenarios

### S1 — Open an email-only timeline → the contact card renders
- **Preconditions:** a Pulse conversation is an email thread whose contact has `phone_e164` NULL; `timeline.contact_id` is set so `pulse.js` loads the company-scoped contact into `p.contact`.
- **Steps:** dispatcher opens the conversation → `PulsePage` evaluates the ungated gate `!isAnonTimeline && (p.contactId || p.timelineId) && (p.phone || p.contact?.id)` → `p.contact?.id` is truthy (phone is `''`) → the tri-state renders.
- **Expected:** the detail card appears (not blank space); shows the contact's **name + email** as identity. **No** `tel:`/call/SMS affordance is present; **no** console error / thrown render. The email thread and (where present) email composer remain. (AC-1)

### S2 — The card shows the existing lead when one is linked by `contact_id`
- **Preconditions:** the email-only contact already has an **open** lead (`status NOT IN ('Lost','Converted')`, contact has no job).
- **Steps:** `usePulsePage` calls `useLeadByContact(contact?.id)` alongside `useLeadByPhone(phone||undefined)`; `getLeadByContact` returns the lead → `p.lead` resolves.
- **Expected:** the card renders **`LeadDetailPanel`** (status + actions), exactly as a phone contact with a lead would. It does **not** offer "create lead". (AC-2, first half)

### S3 — No lead yet → offer "create lead from email" (lead-only)
- **Preconditions:** the email-only contact has **no** open linked lead (`getLeadByContact` → null) and no job.
- **Steps:** the tri-state falls to the wizard branch; `PulsePage` passes `contactId={p.contact?.id}` + `email` to `CreateLeadJobWizard`.
- **Expected:** the wizard renders in **email-origin mode** — phone field blank (not required), email pre-filled, name entry. Because phone is blank the wizard offers **only "Create Lead"** (the "Create Lead & Job" leg is hidden/disabled — ZB needs a phone). (AC-2 second half, AC-4)

### S4 — Create a phoneless lead from an email (email + name, phone blank)
- **Preconditions:** S3 state; dispatcher fills name (email pre-filled), leaves phone blank, submits "Create Lead".
- **Steps:** wizard sends `POST /api/leads` with `FirstName`/`LastName`, `Email`, `selected_contact_id: contactId`, `contact_update_mode: 'attach'`, and **omits `Phone`** (sent only when non-blank). Validation passes (email + contact present); the `attach` branch sets `body.contact_id = selectedContactId` (no `resolveContact`, no phone touched); `createLead` sees no `Phone` → `columns.phone` unset → column omitted.
- **Expected / side effects:** a `leads` row is stored with `phone` **NULL**, `email` set, `contact_id` set — **no fabricated phone**, no validation error. The lead links to **the timeline's contact** (not a deduped/created one). It appears on the **Leads page** (which lists independently of phone) and, if its status is a "new" status, is counted by the **LEADS-NEW-BADGE-001** new-leads badge unchanged. The async contact→lead cascade, push, address sync, and `contact_resolution` echo all fire as today. Reopening the same timeline now shows `LeadDetailPanel` (→ S2). (AC-3, AC-4)

### S5 — by-contact returns null when the contact already has a job, or the lead is Lost/Converted
- **Preconditions:** either (a) the contact has a job (`SELECT 1 FROM jobs WHERE contact_id=$1 LIMIT 1` hits), or (b) the only lead's status ∈ {Lost, Converted}.
- **Expected:** `getLeadByContact` returns `null` (mirroring `getLeadByPhone`'s post-filter and status filter). The card shows the contact panel (case a) / the create affordance (case b) rather than a stale lead card — no duplicate wizard-vs-panel confusion. (AC-2, AC-6)

### S6 — Phoneless `PulseContactPanel` does not crash; phone-only actions absent
- **Preconditions:** `PulseContactPanel` rendered for a contact with `phone_e164` NULL.
- **Expected:** the primary-phone row (`tel:${contact.phone_e164}` → would be `tel:null`, `ClickToCallButton`, `OpenTimelineButton`) is **omitted** — wrapped in `{contact.phone_e164 && (…)}` exactly as the already-guarded secondary-phone row (`PulseContactPanel.tsx:123`). The SMS composer stays hidden (its `{p.phone && !isAnonTimeline && …}` guard at `PulsePage.tsx:415` already hides it phoneless). The email row + `mailto:` + inline add-email render normally. No render throw, no empty `tel:`. (AC-1, AC-4)

### S7 — Cross-tenant: by-contact for a foreign-company `contactId` → null
- **Preconditions:** a `contactId` belonging to another company is requested.
- **Steps:** `getLeadByContact(contactId, req.companyFilter?.company_id)` filters `l.company_id = $2`; a foreign contact has no lead row under the caller's company.
- **Expected:** empty result (`{ lead: null }`), no cross-tenant read. (AC-5, AC-7)

### S8 — Regression: phone timeline / phone-origin lead UNCHANGED
- **Preconditions:** a normal phone contact (with a lead, or without).
- **Expected:** the card renders exactly as before (phone actions present), `useLeadByPhone` still drives `p.lead` (its result wins if both lookups resolve — for a normal phone contact both resolve the same lead), `POST /api/leads` with a phone is unchanged, the wizard's existing `phone={p.phone}` invocation and the ZB with-job leg keep working, and the LEADS-NEW-BADGE-001 badge behaves identically. No duplicate lead is created for an email-only contact that already has one. (AC-6)

---

## Backend

### `leadsService.getLeadByContact(contactId, companyId)` — NEW

Byte-for-byte the shape of `getLeadByPhone` (`leadsService.js:1104`) with the phone-digit condition replaced by a `contact_id` predicate.

- **WHERE:** `l.contact_id = $1 AND l.status NOT IN ('Lost','Converted')` `[AND l.company_id = $2]` (company predicate appended when `companyId` is passed, exactly as `getLeadByPhone`).
- **Team aggregation:** same `LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id` + `json_agg(... FILTER (WHERE lta.id IS NOT NULL), '[]') AS team`, `GROUP BY l.id`.
- **Ordering:** `ORDER BY l.id DESC LIMIT 1` (newest match).
- **"Contact has a job → return null" post-filter:** same as `getLeadByPhone:1140-1146` — after fetching the row, if `lead.contact_id`, run `SELECT 1 FROM jobs WHERE contact_id = $1 LIMIT 1`; if it hits, return `null` (so the card shows the contact panel, not a stale lead). Here `$1` is the contactId itself.
- **Return:** `rowToLead(row)` or `null`.
- **Index:** uses `idx_leads_contact_id` (mig 023) — no seq-scan, no new index (verified with `EXPLAIN` per verify plan).
- **Company scoping:** the predicate scopes the lead row; the job-check inherits scope from that already-scoped row (identical model to `getLeadByPhone`).
- **Export:** add `getLeadByContact` to `module.exports` (alongside `getLeadByPhone`, ~line 1211).

### `GET /api/leads/by-contact/:contactId` — NEW route

- **Placement:** in `leads.js` with the other static-segment `by-*` routes (`by-phone`, `by-id`, `new-count`), **above** `GET /:uuid` (`leads.js:175`) — else Express matches `by-contact` as `uuid`.
- **Permission:** `requirePermission('leads.view', 'pulse.view')` — identical gate to `by-phone` (`leads.js:104`).
- **Validation:** `contactId` must be a positive integer; else `400 INVALID_ID` (mirror `by-id`'s `Number()` + `isNaN`/`< 1` check).
- **Handler:** `const lead = await leadsService.getLeadByContact(Number(contactId), req.companyFilter?.company_id); res.json(successResponse({ lead }, reqId));`
- **Middleware chain (inherited, NO `server.js` edit):** `app.use('/api/leads', authenticate, requireCompanyAccess, leadsRouter)` (`server.js:160`) → this route's `requirePermission`.
- **Response envelope:** `successResponse({ lead })` i.e. `{ ok, data: { lead }, meta }` — same as `by-phone`.

### `POST /api/leads` — validation relaxation + one `update_contact` guard (Decision C)

- **Validation (`leads.js:202`):** replace the unconditional
  `if (!body.Phone || body.Phone.length < 5) errors.push('Phone is required (min 5 chars)')`
  with a **phone-OR-email-OR-contact** rule:
  - `const hasPhone = body.Phone && String(body.Phone).length >= 5;`
  - `const hasEmail = !!(body.Email && String(body.Email).trim());`
  - `const hasContact = !!body.selected_contact_id;`
  - `if (!hasPhone && !hasEmail && !hasContact) errors.push('Phone, Email, or a selected contact is required');`
  - `FirstName` / `LastName` rules (`leads.js:200-201`) unchanged.
- **Resolve branches — NO new path** (all four existing branches already handle phoneless):
  - **`selected_contact_id` + `attach` / default (`leads.js:273`):** sets `body.contact_id = selectedContactId` directly — no `resolveContact`, no phone. Phoneless-safe as-is (this is the wizard's email-origin path).
  - **`selected_contact_id` + `update_contact` (`leads.js:220`):** the one required change — the `phone_e164` write at **`leads.js:235`** (`updates.push('phone_e164 = $…'); params.push(toE164(body.Phone) || body.Phone);`) is currently **unconditional** and would null-out an existing phone on a blank submit. **Guard it with `if (body.Phone) { … }`** (matching the already-conditional email/secondary/company writes at 236-239). Phone-origin `update_contact` is unchanged.
  - **`only_lead` (`leads.js:288`) and default (`leads.js:361`):** call `resolveContact({ first_name, last_name, phone: body.Phone, email: body.Email }, companyId)` **as today**. With `phone` absent it flows to email-match/create or name-only→ambiguous (`409`, correct). `createNewContact` writes `phone_e164` NULL for a blank phone (already true via `toE164(null) === null`). **No `resolveContact` signature change.**
- **Stored lead:** `createLead` sees no `Phone` → `if (columns.phone)` (`leadsService.js:320`) is false → the column is omitted → NULL. `Email` → `email`, `contact_id` → `contact_id` (both already in `FIELD_MAP`, `leadsService.js:161`). The async contact→lead cascade, ZB sync, push, address sync, and `contact_resolution` echo keep firing unchanged.

## Frontend

### `frontend/src/services/leadsApi.ts` — `getLeadByContact(contactId)` — NEW
`GET /by-contact/:id`, returns the same `LeadDetailResponse` envelope as `getLeadByPhone`.

### `frontend/src/hooks/useLeadByContact.ts` — NEW
Verbatim shape of `useLeadByPhone` (`useLeadByPhone.ts`), keyed on `contactId`:
- `queryKey: ['lead-by-contact', contactId]`
- `queryFn`: `if (!contactId) return null; const res = await getLeadByContact(contactId); return res.data.lead as Lead | null;`
- `enabled: !!contactId`, `staleTime: 60_000`, `retry: false`
- returns `{ lead: query.data ?? null, isLoading: query.isLoading }`.

### `frontend/src/hooks/usePulsePage.ts` — wire both lookups
- Call `useLeadByContact(contact?.id)` **alongside** the existing `useLeadByPhone(phone || undefined)` (`usePulsePage.ts:72`).
- `lead = leadOverride || fetchedLeadByPhone || fetchedLeadByContact` (extend line 77). **Phone wins** when both resolve — for a normal phone contact that's the same lead; email-origin has no by-phone result.
- `leadLoading = phoneLoading || contactLoading` — each query's `enabled` gate means a phone timeline never fires the contact query and vice-versa; both are cheap and idempotent. This flows into the `contactDetail` effect guard (`usePulsePage.ts:92`, `if (lead || leadLoading || !contact?.id)`) so the contact panel doesn't flash before the lookup settles.
- **Override/target reset (`usePulsePage.ts:78`):** currently keys off `[phone]`; **extend the deps to also react to `contact?.id`** so switching between phoneless timelines clears `leadOverride` + `selectedTarget`.
- Return the by-contact source alongside the existing return object (line 227).

### `frontend/src/pages/PulsePage.tsx` — ungate + wizard origin (Decision E, D)
- **Gate (`PulsePage.tsx:361`):** replace `… && p.phone` with `… && (p.phone || p.contact?.id)`:
  `!isAnonTimeline && (p.contactId || p.timelineId) && (p.phone || p.contact?.id)`.
  Same tri-state resolves for email-only: `LeadDetailPanel` (lead via by-phone **or** by-contact) → `PulseContactPanel` (contact, no lead) → `CreateLeadJobWizard` (no contact-lead). **`!isAnonTimeline` untouched** — anonymous timelines stay excluded (ungating keys on identity, not on removing the anon guard).
- **Wizard invocation (`PulsePage.tsx:394-399`):** pass `contactId={p.contact?.id}` and `email={…}` (from the contact) in addition to `phone={p.phone}`, so the wizard runs its email-origin mode when phone is blank.
- **SMS composer (`PulsePage.tsx:415`):** `{p.phone && !isAnonTimeline && (<SmsForm … />)}` — **unchanged**; it already hides for a phoneless contact. No new SMS code. (A phoneless contact simply has no SMS leg — email stays reachable via the panel's `mailto:`; acceptable for v1 per Out of scope.)

### `frontend/src/components/contacts/PulseContactPanel.tsx` — null-guard the primary-phone row (Decision E)
Wrap the primary-phone row (`PulseContactPanel.tsx:117-122` — `tel:${contact.phone_e164}` link + `ClickToCallButton` + `OpenTimelineButton`) in `{contact.phone_e164 && ( … )}`, **exactly** as the secondary-phone row (`:123`) is already guarded. So `tel:null` / `ClickToCall('')` / `OpenTimeline('')` never render. The email row + `mailto:` + inline add-email (`:132+`) are unchanged.
> `LeadDetailPanel` / `LeadInfoSections` need **no change** — already `{phone && …}`-guarded (`LeadInfoSections.tsx:85`).

### `frontend/src/components/conversations/CreateLeadJobWizard.tsx` — phone-optional + email/contactId origin (Decision D)
- **Props (`:25-30`):** `phone?: string` (make optional); add `contactId?: number` and `email?: string` (origin prefill). The existing `phone={p.phone}` invocation keeps compiling.
- **Phone field init (`:47`):** `useState(formatUSPhone(phone || ''))` — blank when email-origin; the dispatcher **may** type a phone but isn't required to. Prefill `email` state from the `email` prop.
- **Lead payload (`handleCreate`, `:126`):** currently `Phone: toE164(phoneNumber)` (unconditional). Change to:
  - send `Phone` **only when non-blank**: `...(toE164(phoneNumber) ? { Phone: toE164(phoneNumber) } : {})`;
  - always send `Email` when present;
  - when `contactId` is set, add `selected_contact_id: contactId` + `contact_update_mode: 'attach'` (link to the timeline's contact — no dedup, no fabricated phone).
- **Invalidation:** after create also `invalidateQueries` for `['lead-by-contact', contactId]` (so the card flips to `LeadDetailPanel` immediately).
- **Header phone-row (`:221-224`):** gate `<span>{formatPhone(phone)}</span>` + the `<Phone>` icon on `phone` being present (the `ClickToCallButton`/`OpenTimelineButton` already self-hide via `if(!phone) return null`, but the label/icon would leave an empty stub). Email-origin → no phone row.
- **ZB / with-JOB leg — email-origin lead is LEAD-ONLY:**
  - `zbJobPayload.customer` (`:142`) **already** spreads phone conditionally (`...(phoneNumber && { phone: toE164(phoneNumber) })`) — no change.
  - `convertLead` customer (`:170`) hardcodes `phone: toE164(phoneNumber)` (→ `null` when blank) — **make it conditional too**: `...(phoneNumber && { phone: toE164(phoneNumber) })`.
  - When phone is blank, the wizard offers **only "Create Lead"** — the "Create Lead & Job" button/leg is **hidden/disabled** until a phone is entered (ZB job creation requires a phone). Existing phone-carrying ZB creates unchanged.

### `frontend/src/components/conversations/WizardStep1.tsx` — (if origin prefill is surfaced here)
The phone `PhoneInput` stays but is **non-required** (no `*` label); no structural change.

---

## API contracts

- **`GET /api/leads/by-contact/:contactId`** — newest OPEN lead linked to a contact.
  - **Request:** path param `contactId` (positive int). No body.
  - **Response:** `200 { ok:true, data: { lead: Lead | null }, meta }`.
  - **Errors:** `400 INVALID_ID` (non-positive/NaN); `401`/`403` from the auth/permission chain; `500` on server error (`handleError`).
  - **Auth / middleware:** `authenticate` → `requireCompanyAccess` (mount `server.js:160`) → `requirePermission('leads.view','pulse.view')`.
  - **Isolation:** `company_id` from `req.companyFilter?.company_id`; a foreign `contactId` → `{ lead: null }` (404-style empty, not 403 — no cross-tenant disclosure).

- **`POST /api/leads`** — unchanged contract **except** the phone-mandatory rule.
  - **Request (email-origin):** `{ FirstName, LastName, Email, selected_contact_id, contact_update_mode:'attach' }`, **no `Phone`**.
  - **Response:** unchanged (`{ ok:true, data: { …lead, UUID }, meta }`).
  - **Errors:** `400 VALIDATION_ERROR` when **none** of phone(≥5)/email/`selected_contact_id` is present (and the existing name errors); `409` only via the pre-existing name-only ambiguous `resolveContact` path (unchanged).
  - **Isolation:** `req.companyFilter?.company_id` (→ `resolveContact` / `createLead`), unchanged.

## Component interaction

```
PulsePage (gate on identity)
  └─ usePulsePage
       ├─ useLeadByPhone(phone||undefined) ──► GET /by-phone/:phone ──► getLeadByPhone
       └─ useLeadByContact(contact?.id)   ──► GET /by-contact/:id  ──► getLeadByContact ──► idx_leads_contact_id
       lead = override || byPhone || byContact
  tri-state:
    lead present            → LeadDetailPanel
    no lead, contact.id     → PulseContactPanel (primary-phone row guarded on phone_e164)
    no lead, no contact     → CreateLeadJobWizard(contactId,email) [lead-only when phone blank]
                                 └─ POST /api/leads (Phone omitted when blank)
                                      └─ attach branch: body.contact_id = selectedContactId
                                      └─ createLead: columns.phone unset → NULL
```
No new SSE events — the conversation already surfaces via its **email** signal (`email_by_contact` CTE); LEADS-NEW-BADGE-001 already refetches on `lead.created`/`lead.updated` (status-based, phone-independent).

## Edge cases

1. **Blank phone in `update_contact` mode** → the `phone_e164` write is skipped (`if (body.Phone)`), so an existing contact phone is **not** nulled. (Guarded write, `leads.js:235`.)
2. **Name-only, no email, no contact** in the default/`only_lead` resolve → `resolveContact` returns ambiguous → `409` (pre-existing, correct behavior — not a new error path).
3. **Both a phone and a contact lead resolve** (normal phone contact) → by-phone wins (`lead = … || byPhone || byContact`); no duplicate card.
4. **Contact acquires a job after the lead** → `getLeadByContact` returns null (job post-filter) → card shows contact panel, not the stale lead. (S5)
5. **Anonymous timeline** (`isAnonTimeline`) → still excluded (gate keeps `!isAnonTimeline`); no card.
6. **Empty-string phone must never reach** `tel:`, `ClickToCallButton`, `OpenTimelineButton`, or the ZB customer payload — enforced by the guards in `PulseContactPanel` (S6), the wizard header-row gate, and the conditional `convertLead` phone.

## Error handling

- `GET /by-contact/:contactId` bad id → `400 INVALID_ID` toast-agnostic (hook `retry:false`, returns `{lead:null}` on non-200 → card treats as "no lead", offers wizard).
- `POST /api/leads` validation failure → `400 VALIDATION_ERROR` surfaced by the wizard's existing error handling (unchanged).
- by-contact query failure → hook returns `null` (fails safe to "no lead"); does not crash the card.

## Migration

**NONE.** `leads.phone` NULLABLE + `leads.email` (mig 004); `leads.contact_id` + `idx_leads_contact_id` (mig 023) cover storage **and** the by-contact lookup's index. `getLeadByContact` filters the indexed `contact_id`. **Max migration = 155; no new file.** (A migration is expected **only** if the Planner/Architect adds a supporting index — there already is one, so none is anticipated. Re-verify the max migration number immediately before creating any, per the parallel-branch rule.)

## Company scoping & protected

- **Every new leg company-scoped** via `req.companyFilter?.company_id`: `getLeadByContact`'s lead predicate; the relaxed POST resolve (companyId already threaded to `resolveContact` / `createLead`). No cross-tenant read/attach/create (ONBOARD-FIX-001 / ZB-ISO-001). (AC-7)
- **Protected (untouched):**
  - `getUnifiedTimelinePage` / `email_by_contact` CTE — **FR-B4 (sidebar lead-signal by contact_id) is DEFERRED for v1** (architect Decision A): the hot list query has **no** unconditional "has_open_lead" sidebar signal (its only `leads` refs are inside the search-filter branch, matching phone digits — an email-origin lead can't and needn't match), and the conversation already surfaces as its email thread. **What the user does/doesn't see:** the email-only conversation still appears in the Pulse sidebar (as the email thread) and shows `LeadDetailPanel` once a lead exists; it does **not** gain a separate lead-styled sidebar badge keyed off the lead (phone-origin leads get that only via the phone-digit search-match path, unchanged). If ever pursued, it is index-only per PULSE-PERF-001 (EXPLAIN on a prod copy; index expression = exact predicate copy). **Do NOT casually modify this query.**
  - Phone lead path — `useLeadByPhone` / `useLeadsByPhones`, `getLeadByPhone` / `getLeadsByPhones`, `GET /by-phone` + `POST /by-phones`, the wizard's phone invocation — **added-alongside, not changed**.
  - `resolveContact` signature — reused, not changed (no phoneless branch added; existing branches already cover it).
  - `leads.phone` nullable invariant + migs 004/023 — no destructive schema change.
  - `POST /api/leads` phone-origin contract — name rules, `selected_contact_id`/`contact_update_mode` resolution, async cascade + ZB sync all keep firing; **only** the phone-mandatory rule relaxes.
  - Anonymous-timeline handling — gate keys on identity, anon stays excluded.
  - LEADS-NEW-BADGE-001 — status/`lead_lost`-based, phone-independent; an email-origin "new" lead counts the same; no badge/SSE change.

## Verify plan (real DB, not just mocked jest)

Jest **mocks the DB** (LIST-PAGINATION-001 / created_by-FK lessons — a phoneless-insert or by-contact bug hides behind mocks), so against a **prod-DB copy**:
1. `EXPLAIN` `getLeadByContact` → confirm `idx_leads_contact_id` is used (no seq-scan).
2. Run the **real** phoneless create — `POST /api/leads` with `Email` + name + `selected_contact_id`, **no phone** → assert the stored row has `phone` **NULL**, `email` set, `contact_id` set.
3. `getLeadByContact` returns: the open lead / **null when the contact has a job** / **null when the only lead is Lost or Converted**.
4. Tenancy: a **foreign-company** `contactId` → `null`.
5. Regression: a phone create + `GET /by-phone` are **byte-identical** to today.

Jest still covers the validation branches (phone-only / email-only / contact-only / **none → 400**), company scoping, and no-duplicate.

## Files to change

| File | Change |
|---|---|
| `backend/src/routes/leads.js` | Relax POST validation (`:202`) to phone-OR-email-OR-`selected_contact_id`; guard the `update_contact` `phone_e164` write (`:235`) with `if (body.Phone)`; add `GET /by-contact/:contactId` (`requirePermission('leads.view','pulse.view')`, int-validate, company-scoped) with the other `by-*` routes above `/:uuid`. Resolve branches otherwise unchanged. |
| `backend/src/services/leadsService.js` | Add `getLeadByContact(contactId, companyId)` (clone of `getLeadByPhone`: `contact_id` predicate, `status NOT IN ('Lost','Converted')`, company scope, job-exists→null, `team` agg, `rowToLead`); export it. |
| `frontend/src/services/leadsApi.ts` | Add `getLeadByContact(contactId)` → `GET /by-contact/:id` (`LeadDetailResponse`). |
| `frontend/src/hooks/useLeadByContact.ts` | **NEW.** Clone of `useLeadByPhone` keyed on `contactId` (`['lead-by-contact', contactId]`, `enabled: !!contactId`). |
| `frontend/src/hooks/usePulsePage.ts` | Call `useLeadByContact(contact?.id)` alongside `useLeadByPhone`; `lead = override || byPhone || byContact`; `leadLoading` reflects both `enabled` queries; extend the override/target reset (`:78`) to react to `contact?.id`. |
| `frontend/src/pages/PulsePage.tsx` | Ungate the tri-state (`:361`) to `… && (p.phone || p.contact?.id)`; pass `contactId={p.contact?.id}` + `email` to `CreateLeadJobWizard`. SMS `{p.phone && …}` guard unchanged. |
| `frontend/src/components/contacts/PulseContactPanel.tsx` | Wrap the primary-phone row (`:117-122`) in `{contact.phone_e164 && ( … )}` (mirror the secondary-phone guard). Email row unchanged. |
| `frontend/src/components/conversations/CreateLeadJobWizard.tsx` | `phone?` optional + `contactId?`/`email?` props; init phone `formatUSPhone(phone||'')`, prefill email; send `Phone` only when non-blank, `Email` always when present, `selected_contact_id`+`contact_update_mode:'attach'` when `contactId` set; invalidate `['lead-by-contact', contactId]`; gate the header phone-row (`:221-224`) on `phone`; make `convertLead` customer phone conditional (`:170`); hide/disable the with-JOB leg when phone blank. |
| `frontend/src/components/conversations/WizardStep1.tsx` | (If email-origin prefill surfaces here) phone `PhoneInput` stays but non-required; no structural change. |
| `backend/tests/` (jest) | `getLeadByContact` (open/none/job-exists/Lost-Converted/tenancy) + phoneless email-origin `POST /api/leads` (validation branches, company scope, no-duplicate) + documented real-DB-copy verification. |
| **Migration** | **NONE** (mig 004 nullable phone + email; mig 023 `contact_id` + `idx_leads_contact_id`). Max = 155. |

## Non-goals / out of scope

- Any change to the unified-list query shape / Pulse timeline-detail projection **beyond** the optional FR-B4 (deferred to the Architect; if ever taken, index-only per PULSE-PERF-001).
- A schema/storage migration for phoneless leads (already supported) — only if the Architect adds a supporting index (none anticipated).
- Reworking the manual `CreateLeadDialog` to be phone-optional (the in-scope creation surface is the Pulse email-origin wizard; extending the manual dialog is a separate scoping call). `CreateLeadDialog`'s Email field + `Status:'Submitted'` default is the **reference** for the email-origin field set only.
- Making the browser softphone / SMS work for a phoneless contact (no phone target — affordances hidden/disabled, not re-engineered); mobile-softphone rules unchanged.
- Auto-creating a lead from an email without a dispatcher action (creation stays explicit via "create lead from email").
- Deploy to prod only with explicit owner consent (standing rule).
