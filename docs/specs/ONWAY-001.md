# Specification: ONWAY-001 — "On the way" / ETA notification

> **Status:** Spec · **Priority:** P1 · **Type:** Feature (technician dispatch UX + outbound SMS + new Job status)
> **Inputs:** `docs/requirements.md` → "ONWAY-001 — On-the-way ETA notification (2026-06-26)" (OW-R1..R7, AC-1..AC-12, SC-01..06); `docs/architecture.md` → "ONWAY-001 — design (2026-06-26)".
> **Related:** FSM-001 (Job SCXML workflow), SCHED-ROUTE-001 (`routeDistanceService`), PF008/Pulse (`conversationsService`).

---

## 1. General description

From a Job card in a **pre-visit** status (`Submitted` or `Rescheduled`), a technician (or dispatcher) with `messages.send` taps a primary **"On the way"** CTA. A modal opens, does **one** `navigator.geolocation.getCurrentPosition`, optionally computes a **Google travel-time ETA** (device coords → job service address, via `routeDistanceService.computePair`), and offers preset minute tiles + a custom-minutes entry. On **"Notify client"** the backend sends an **outbound SMS** (tech name + company + ETA) into the customer's conversation (recorded to the timeline) and **then** advances the job to a new **On the way** status.

**Hard ordering rule (AC-7):** **SMS first (primary success), status second (best-effort).** If the SMS fails (incl. wallet block) the status is NOT changed. If the status change fails *after* a successful SMS, the API still returns success with a non-blocking `warning` (no SMS rollback).

---

## 2. Modal behavior & state ladder

Component: **`frontend/src/components/jobs/OnTheWayModal.tsx`** — Shadcn `Dialog` mirroring `frontend/src/components/transactions/RecordPaymentDialog.tsx` (`Dialog open onOpenChange` + `DialogContent variant="panel"` + `DialogPanelHeader / DialogBody / DialogPanelFooter / DialogTitle / DialogDescription`). Props: `{ open: boolean; onOpenChange: (open:boolean)=>void; job: LocalJob; onNotified: (id:number)=>void }` (parent passes `afterMutation` from `useJobDetail` as `onNotified`).

### 2.1 State ladder (on open)

| State | Trigger | UI |
|---|---|---|
| **(0) Idle/closed** | `open=false` | not rendered |
| **(a) Requesting location** | On `open` transition → call `navigator.geolocation.getCurrentPosition(success, error, { timeout: 8000, enableHighAccuracy: false, maximumAge: 60000 })` | Spinner + "Finding your location…". Tiles already visible & selectable underneath (geolocation is enhancement, not a gate). |
| **(b) ETA computed** | Geolocation success **AND** job has usable origin/dest **AND** `estimateEta` returns `eta_minutes != null` | A highlighted, **pre-selected** option at top: **"Google ETA · ~{N} min"**. Tiles + custom also shown. |
| **(c) ETA unavailable** | Geolocation denied / unavailable / timeout (8s) / `getCurrentPosition` not in `navigator` / `estimateEta` returns `null` (NO_KEY, failed, or no job address) | Muted note: **"ETA unavailable — location is off."** **No Google option row.** Tiles + custom shown. No value pre-selected. |

- **Tiles always present** in (a)/(b)/(c): **10 · 15 · 20 · 30 · 45 · 60** (minutes) + a **"Set custom time"** affordance.
- **Custom time:** inline numeric entry (minutes), integer, **validated 1–600**. Invalid/empty → cannot be the active selection ("Notify client" stays disabled). Selecting/typing a valid custom value deselects any tile/Google option.
- **Exactly one selection active** at a time across {Google ETA | a tile | custom}. Selecting one clears the others.
- **"Notify client" disabled** until a value is chosen (no default unless Google pre-selected it in state (b)).
- The chosen integer minutes is the single `eta_minutes` sent to the backend and rendered in the SMS.

### 2.2 Geolocation contract

- **Single** `getCurrentPosition` per modal open. **No** `watchPosition`, no streaming, no map (out of scope).
- Coordinates never leave for Google directly; only `{ lat, lng }` is POSTed to the backend `estimate` endpoint (key stays server-side).
- Permission/availability handling is best-effort: any failure → state (c). Closing+reopening the modal re-requests once.

### 2.3 Notify action & success

1. User taps **"Notify client"** → button enters in-flight (disabled + spinner) → `jobsApi.notifyOnTheWay(job.id, { eta_minutes })`.
2. **Success (`{ ok:true }`):** success toast → close modal → `onNotified(job.id)` (refreshes the job via `useJobDetail.afterMutation`). The outbound SMS appears in the customer timeline automatically (written by `conversationsService.sendMessage`; no extra client work). The card now shows **On the way** and the CTA is no longer primary.
3. **Success-with-warning (`{ ok:true, warning:'status_not_advanced' }`):** the SMS was sent but the status did not advance. Show the warning toast (below), still close + refresh.
4. **Error:** keep modal open, re-enable button, show the matching error toast (§5.4). Technician may retry. (Backend guarantees no double-send / no double status-flip on the success path — see §4.4.)
5. **Idempotency / double-tap:** the button is disabled while in-flight (client-side guard). Server-side, a job already in `On the way` makes `updateBlancStatus` a `__NOOP__` (FSM same-state) so a stray second call is harmless for status — but it WOULD send a second SMS, so the **client in-flight disable is the primary dedup**; do not auto-retry on network timeout without user action.

---

## 3. Exact copy (English)

All copy English-only; Albusto design system; no user-facing "Blanc".

| Element | Exact text |
|---|---|
| **Primary CTA button label** | `On the way` |
| **Modal title** (`DialogTitle`) | `On the way` |
| **Modal description** (sr-only ok) | `Notify the customer that the technician is en route` |
| **Requesting-location line** (state a) | `Finding your location…` |
| **Google ETA option label** (state b) | `Google ETA · ~{N} min` (where `{N}` = returned integer minutes) |
| **ETA-unavailable note** (state c) | `ETA unavailable — location is off.` |
| **Geolocation-permission hint** (under the note in state c) | `Allow location access to get a live travel-time estimate, or pick a time below.` |
| **Preset section label** (optional eyebrow) | `Estimated arrival` |
| **Custom-time affordance** | `Set custom time` |
| **Custom-time field label / placeholder** | label `Minutes` · placeholder `e.g. 25` |
| **Custom-time validation hint** (when out of range) | `Enter 1–600 minutes.` |
| **Notify button label** | `Notify client` |
| **Notify button (in-flight)** | `Sending…` |
| **Success toast** | `Customer notified — you're marked On the way.` |
| **Success-with-warning toast** | `SMS sent, but the job status didn't update. You can change it manually.` |
| **Error — no phone (422 NO_PHONE)** | `No phone number on file for this customer.` |
| **Error — no sending number (422 NO_PROXY)** | `No sending number configured for your company.` |
| **Error — wallet blocked** | `Messaging is paused — top up your balance.` |
| **Error — generic send failure** | `Couldn't send the message. Please try again.` |

### 3.1 SMS body (exact — OW-R5 / AC-9)

Template, sent verbatim by the backend (the backend owns the template, NOT the client):

```
Hi! Your technician {tech} from {company} is on the way and should arrive in about {eta} minutes.
```

- **`{eta}`** = the chosen integer minutes (no decimals, no units suffix beyond the literal "minutes" already in the template).
- **`{company}`** = the company's display name from the company record (`companies.name`, fetched server-side via `companyQueries.getById(companyId).name`). If the company name is somehow null/empty, fall back to the literal `your service team` so the sentence still reads ("…from your service team is on the way…").
- **`{tech}` resolution:**
  - If `job.assigned_techs?.[0]?.name` is a non-empty string → use it as-is (e.g. `Mike`). Sentence: `Hi! Your technician Mike from ABC Homes is on the way and should arrive in about 25 minutes.`
  - If there is **no assigned tech / empty name** → substitute the lowercase phrase `your technician` for `{tech}` **and drop the leading word "technician"** so it doesn't read "Your technician your technician". The emitted sentence becomes:
    `Hi! Your technician from {company} is on the way and should arrive in about {eta} minutes.`
    Implementation note: build the lead-in as `` `Your technician ${techName} ` `` when a name exists, else `` `Your technician ` `` — i.e. the word "technician" stays, the name is simply omitted. (Result: `Hi! Your technician from ABC Homes is on the way…`.) This keeps a single grammatical template with the name slotted in.
- **Multiple assigned techs:** use only the **first** (`assigned_techs[0].name`); do not list all.

---

## 4. API contracts

Both endpoints live on the **existing jobs router** `backend/src/routes/jobs.js`, already mounted in `src/server.js` behind `authenticate` + `requireCompanyAccess`. **No new mount.** Auth: `requirePermission('messages.send')` on **both** (a user lacking it gets 403 and never sees the CTA). `company_id` is read **only** from `req.companyFilter?.company_id` (AC-12) — never from the body. The job is loaded **company-scoped** via `jobsService.getJobById(id, companyId)`; a cross-tenant or missing id → **404** (`getJobById` returns null when `company_id` doesn't match).

All responses use the project's `{ ... }` JSON convention; the frontend calls them via `jobsApi` (`jobsRequest<T>()` + `authedFetch`).

### 4.1 `POST /api/jobs/:id/eta/estimate`

Pure read — **no SMS, no status change.**

**Request**
```json
{ "origin": { "lat": 42.187, "lng": -71.205 } }
```

**Response (200)**
```json
{ "eta_minutes": 23, "status": "success" }
```
or, when no estimate can be produced:
```json
{ "eta_minutes": null, "status": "unavailable" }
```

**Behavior**
1. Load job company-scoped (`getJobById(id, companyId)`); null → 404.
2. Resolve destination: prefer `job.lat`/`job.lng`; if absent but a geocodable `job.address` exists, the route may geocode it (optional) to `{lat,lng}`. If no usable destination → return `{ eta_minutes: null, status: 'unavailable' }`.
3. If `origin.lat`/`origin.lng` is missing/invalid in the body (e.g. client never got a fix and called anyway) → return `{ eta_minutes: null, status: 'unavailable' }` (geolocation-not-sent path; the client normally just stays in state (c) and doesn't call).
4. Call `routeDistanceService.computePair(origin, dest, 'driving')`:
   - `{ status:'success', durationMinutes }` → `{ eta_minutes: durationMinutes, status:'success' }` (already an integer; driving, no traffic; global-cache-first).
   - `{ status:'failed', errorCode:'NO_KEY' | <google error> }` → `{ eta_minutes: null, status:'unavailable' }`.

**Errors:** `400` only for a malformed body that isn't an object; `403` (missing permission); `404` (cross-tenant/missing job). All compute/no-key/no-address conditions are **non-errors** returning `eta_minutes:null` (UI shows tiles only — SC-02/SC-04).

### 4.2 `POST /api/jobs/:id/eta/notify`

Notify = **SMS then status** (best-effort status).

**Request**
```json
{ "eta_minutes": 25 }
```
- Validate `eta_minutes` is an integer in **1–600**; otherwise `400 { "ok": false, "error": "invalid_eta" }`. (Defense-in-depth; the UI already validates.)

**Success (200)**
```json
{ "ok": true, "status": "On the way", "eta_minutes": 25, "conversation_id": "<uuid>" }
```

**Success with non-blocking warning (200)** — SMS sent, status set failed:
```json
{ "ok": true, "warning": "status_not_advanced", "eta_minutes": 25, "conversation_id": "<uuid>" }
```

**Error shapes**

| Condition | HTTP | Body | Side effects |
|---|---|---|---|
| No phone (SC-03) | `422` | `{ "ok": false, "error": "NO_PHONE", "message": "No phone number on file for this customer." }` | **none** (checked before send; status unchanged) |
| No sending number / proxy (DID) | `422` | `{ "ok": false, "error": "NO_PROXY", "message": "No sending number configured." }` | **none** (checked before send; status unchanged) |
| Wallet blocked (SC-05) | passthrough from `sendMessage` (`walletService.assertServiceActive` throw) → `402`/`403` per existing wallet behavior | `{ "ok": false, "error": "WALLET_BLOCKED", "message": "Messaging is paused — top up your balance." }` | **no SMS, status unchanged** |
| SMS send failure (SC-06, Twilio/network) | `502`/`500` | `{ "ok": false, "error": "SMS_FAILED", "message": "Couldn't send the message." }` | **status unchanged** |
| Missing permission | `403` | standard authorization error | none |
| Cross-tenant / missing job | `404` | standard not-found | none |

> The wallet block uses the **same** thrown error `sendMessage` already raises; the route maps it to the `WALLET_BLOCKED` shape (detect by the wallet error's code/message) but must NOT introduce a second wallet check — `walletService.assertServiceActive` inside `sendMessage` stays the single cost-enforcement point (Protected).

### 4.3 `notify` step order (route handler)

1. Load job company-scoped (`getJobById(id, companyId)`) → null → 404.
2. `customerE164 = job.customer_phone` (denormalized column). Absent/blank → **422 NO_PHONE**, return immediately (no side effects).
3. `techName = job.assigned_techs?.[0]?.name || null`; `companyName = (await companyQueries.getById(companyId))?.name || null`.
4. `proxyE164 = await resolveCompanyProxyE164(companyId)` (§4.5). Null → **422 NO_PROXY**, return (no side effects).
5. Build `body` from the exact OW-R5 template (§3.1) with `{tech}`/`{company}`/`{eta}` resolved.
6. `conv = await conversationsService.getOrCreateConversation(customerE164, proxyE164, companyId)`; `await conversationsService.sendMessage(conv.id, { body, author: 'agent' })`.
   - Any throw here → classify wallet vs generic → return the matching error (`WALLET_BLOCKED` / `SMS_FAILED`). **Status NOT changed.**
7. On send success → `await jobsService.updateBlancStatus(id, 'On the way', companyId)`.
   - Throws (e.g. transition not allowed because the job left the pre-visit set between open & notify, or DB error) → **catch**, return `{ ok:true, warning:'status_not_advanced', conversation_id: conv.id, eta_minutes }`. **Do not** roll back the SMS (AC-7).
   - Succeeds → `{ ok:true, status:'On the way', conversation_id: conv.id, eta_minutes }`.

Because `updateBlancStatus` reuses the same path as `PATCH /:id/status`, it emits `eventService.logEvent('status_changed')` + `eventBus 'job.status_changed'` for free (audit/history/automation, AC-11).

### 4.4 Idempotency

- **Client:** "Notify client" disabled while in-flight (single submission). On error the user re-enables by acknowledging; no silent auto-retry.
- **Server (status):** if the job is **already** `On the way`, `fsmService.resolveTransition('On the way','On the way')` returns the `__NOOP__` event (verified in `fsmService.js`), so `updateBlancStatus` does not error and does not double-flip. (It would still re-send an SMS — hence the client in-flight guard is the real dedup; this endpoint is not a true idempotency-key endpoint and double-send prevention is client-owned, by design/scope.)

### 4.5 Twilio proxy DID resolution (server-side) — `resolveCompanyProxyE164(companyId)`

New small server-side helper (place in the route or export from `conversationsService`). Order:
1. **MRU** of recent conversations (reuses pulse's proven query):
   `SELECT proxy_e164 FROM sms_conversations WHERE proxy_e164 IS NOT NULL AND company_id = $1 ORDER BY last_message_at DESC LIMIT 1`.
2. Fallback `process.env.SOFTPHONE_CALLER_ID`.
3. Both null → return null → route returns **422 NO_PROXY**, status unchanged.

No live Twilio `incomingPhoneNumbers.list` call on the hot path. **Open boundary (carried from architecture):** for a tenant owning several SMS-capable DIDs, MRU-then-env is the v1 rule; a per-company "default sending number" setting is deferred. (Customer to confirm.)

---

## 5. Status / FSM spec

### 5.1 New status

Add **`On the way`** as a NEW, **non-terminal** Job status:
- Reachable **into** from `Submitted` and `Rescheduled` (pre-visit set).
- Reachable **out** to `Visit completed` and `Canceled` (lands the job on the normal completion path — `Visit completed` already has onward `→ Job is Done / Canceled`).
- Color **`#0EA5E9`** (sky/cyan — distinct from Submitted `#3B82F6` and the amber ZB `en-route`).
- **No Zenbooker outbound mapping** — `OUTBOUND_MAP`/ZB block is untouched; `updateBlancStatus`'s `if (newStatus === 'Job is Done'…) / Canceled` guards simply skip `On the way` (no ZB call).

### 5.2 "Scheduled" is NOT a current status — CONFIRMED

Verified against `backend/src/services/jobsService.js`: `BLANC_STATUSES` = `[Submitted, Waiting for parts, Follow Up with Client, Visit completed, Job is Done, Rescheduled, Canceled]` and `ALLOWED_TRANSITIONS` has **no `Scheduled` key and no transition targeting `Scheduled`**. The same is true of `fsm/job.scxml` (states: `Submitted, Waiting_for_parts, Follow_Up_with_Client, Visit_completed, Rescheduled` + finals `Job_is_Done, Canceled`). **Therefore the CTA-visible / "into On the way" set is `{Submitted, Rescheduled}` only.** (A future `Scheduled` status would also be a pre-visit source, but it does not exist today and is out of scope here.)

### 5.3 The migration — `backend/db/migrations/127_job_fsm_on_the_way.sql` (NEW)

**Why a migration (not just file edits):** the Job FSM is dual-sourced — a hardcoded fallback in `jobsService.js` **and** a per-company published SCXML row (`fsm_machines`/`fsm_versions`). At runtime `updateBlancStatus` calls `fsmService.resolveTransition` first; for already-seeded companies the **DB graph is authoritative**, so editing only `fsm/job.scxml` or the `073` heredoc would NOT reach existing tenants. Modeled **exactly** on precedent `095_add_review_lead_status.sql`.

**Idempotent injection algorithm (per the 095 precedent, applied to `machine_key='job'`):**
```
FOR each row in:
    SELECT m.id AS machine_id, m.company_id, v.scxml_source
    FROM fsm_machines m
    JOIN fsm_versions v ON v.id = m.active_version_id
    WHERE m.machine_key = 'job'
      AND v.scxml_source NOT LIKE '%id="On_the_way"%'   -- idempotency guard
LOOP
  new_scxml := scxml_source with TWO replace() passes:

  (A) Inject the new state. Insert immediately BEFORE the Canceled <final> marker
      (or after Rescheduled's </state>) a new block:
        <state id="On_the_way" blanc:label="On the way" blanc:statusName="On the way">
          <transition event="TO_VISIT_COMPLETED" target="Visit_completed" blanc:action="true" blanc:label="Visit completed" blanc:order="1" />
          <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:order="2" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
        </state>

  (B) Inject the inbound transition into BOTH source states by replacing each state's
      opening tag with the tag + the new transition as first child:
        replace '<state id="Submitted" blanc:label="Submitted">'
           with '<state id="Submitted" blanc:label="Submitted">
             <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label="On the way" blanc:order="0" />'
        replace '<state id="Rescheduled" blanc:label="Rescheduled">'
           with '<state id="Rescheduled" blanc:label="Rescheduled">
             <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label="On the way" blanc:order="0" />'

  IF new_scxml == scxml_source  → RAISE NOTICE 'job FSM % not updated: markers not found'; CONTINUE;

  UPDATE fsm_versions SET status='archived' WHERE machine_id=... AND status='published';
  INSERT INTO fsm_versions (machine_id, company_id, version_number, status,
                            scxml_source, change_note, created_by, published_by, published_at)
    SELECT machine_id, company_id, COALESCE(MAX(version_number),0)+1, 'published',
           new_scxml, 'Add On the way status (ONWAY-001)', 'system', 'system', NOW()
    FROM fsm_versions WHERE machine_id=... RETURNING id INTO new_version_id;
  UPDATE fsm_machines SET active_version_id=new_version_id, updated_at=NOW() WHERE id=machine_id;
END LOOP;
```
Notes:
- The `WHERE … NOT LIKE '%id="On_the_way"%'` guard makes the migration safe to re-run and convergent with the `073`/`fsm/job.scxml` edits (if the state is already present, the loop skips).
- Match the precedent's version-id type and join shape (`v.id = m.active_version_id`, `version_number+1`). Optional `backend/db/migrations/rollback_127_*.sql` may reverse to the prior published version.

### 5.4 Mirrored edits (must stay consistent with the migration)

1. **`fsm/job.scxml` (EDIT)** — add the same `<state id="On_the_way" …>` block (with `TO_VISIT_COMPLETED` + `TO_CANCELED`) and inject the `TO_ON_THE_WAY` transition into the `Submitted` and `Rescheduled` states, so the canonical file matches the DB and fresh `073` seeds stay correct.
2. **`backend/db/migrations/073_seed_fsm_machines.sql` (EDIT)** — add the same state + two inbound transitions to the embedded `$scxml_job$`/heredoc so a from-scratch DB already includes On-the-way (keeps `073` and `127` convergent; both running is safe via the `NOT LIKE` guard).
3. **`backend/src/services/jobsService.js` (EDIT)** — fallback map mirror:
   - Append `'On the way'` to `BLANC_STATUSES`.
   - In `ALLOWED_TRANSITIONS`: add key `'On the way': ['Visit completed', 'Canceled']`; add `'On the way'` to the `'Submitted'` array and the `'Rescheduled'` array.
   - **`OUTBOUND_MAP` / ZB block untouched.** No existing status/transition removed or altered (protects FSM-001 §8 completeness).
4. **`frontend/src/components/jobs/jobHelpers.tsx` (EDIT)** — add `'On the way'` to the `BLANC_STATUSES` array (lines ~6–12) and `'On the way': '#0EA5E9'` to `BLANC_STATUS_COLORS` (lines ~15–22). `BlancBadge` then colors it automatically; filters/badges render it.

### 5.5 Exact transition names

| Direction | Event | From → To |
|---|---|---|
| Into On the way | `TO_ON_THE_WAY` | `Submitted` → `On_the_way` |
| Into On the way | `TO_ON_THE_WAY` | `Rescheduled` → `On_the_way` |
| Out of On the way | `TO_VISIT_COMPLETED` | `On_the_way` → `Visit_completed` |
| Out of On the way | `TO_CANCELED` | `On_the_way` → `Canceled` |

> State **id** is `On_the_way` (underscored, SCXML id rules); **status name / label** is `On the way` (the `blanc:statusName`/`blanc:label` and the value persisted in `jobs.blanc_status` + the fallback `ALLOWED_TRANSITIONS` keys). **Caveat:** `On the way` (a `blanc_status`) is orthogonal to the existing Zenbooker `zb_status:'en-route'` substatus and the `/enroute` route / `markEnroute` — they must not be conflated.

---

## 6. Frontend interaction & component wiring

- **Primary CTA** in `frontend/src/components/jobs/JobStatusTags.tsx` → the live `JobOpsSection` (NOTE: `JobActionBar.tsx` is a dead `// Merged…` stub — do not use). Render an **"On the way"** button using the **same full-width orange-gradient primary slot** as "Start Job"/"Complete Job" (`minHeight:40, borderRadius:12, linear-gradient(180deg,#f5874a,#e06020)`, white text, box-shadow). Show it **only when** `job.blanc_status ∈ {Submitted, Rescheduled}` AND the user has `messages.send` (hide otherwise). It coexists with the FSM `ActionsBlock` (already mounted at the bottom), which will also list `On the way` as a transition button — but the styled primary CTA + modal is the intended entry point. Clicking it opens `OnTheWayModal` (not the bare ActionsBlock transition).
  - `JobOpsSection` is rendered by `JobDetailPanel.tsx`; thread `job` + an `onNotified`/`afterMutation` callback through to the modal.
- **Modal** `OnTheWayModal.tsx` — §2. On success → `onNotified(job.id)` (calls `useJobDetail.afterMutation`, which refetches the job and re-renders the card with `On the way`).
- **`frontend/src/services/jobsApi.ts`** — add two methods on the existing client (using `jobsRequest<T>()` + `JOBS_BASE`):
  - `estimateEta(id, { origin }): Promise<{ eta_minutes: number|null; status: string }>` → `POST ${JOBS_BASE}/${id}/eta/estimate`.
  - `notifyOnTheWay(id, { eta_minutes }): Promise<{ ok:boolean; status?:string; warning?:string; conversation_id?:string; eta_minutes?:number }>` → `POST ${JOBS_BASE}/${id}/eta/notify`.
  - `LocalJob` already carries `blanc_status`, `customer_phone`, `address`, `assigned_techs[]`, `lat`, `lng` — **no type changes** beyond the two method signatures.

### 6.1 Component/data flow

```
JobDetailPanel → JobOpsSection (JobStatusTags.tsx)
   └─ [primary CTA "On the way", gated on blanc_status∈{Submitted,Rescheduled} + messages.send]
        └─ OnTheWayModal (open)
             ├─ navigator.geolocation.getCurrentPosition  (8s timeout)
             │     └─(fix)→ jobsApi.estimateEta(id,{origin})
             │                 → POST /api/jobs/:id/eta/estimate
             │                     → routeDistanceService.computePair(origin,dest,'driving')  [cache-first; no SMS/status]
             ├─ tiles 10/15/20/30/45/60 + custom(1–600)  [always]
             └─ "Notify client" → jobsApi.notifyOnTheWay(id,{eta_minutes})
                   → POST /api/jobs/:id/eta/notify
                       ├─ getJobById(id,companyId) → customer_phone, assigned_techs[0].name
                       ├─ companyQueries.getById(companyId).name
                       ├─ resolveCompanyProxyE164(companyId)  [MRU sms_conversations → SOFTPHONE_CALLER_ID]
                       ├─ conversationsService.getOrCreateConversation + sendMessage(body, author:'agent')  [wallet gate inside]
                       └─ jobsService.updateBlancStatus(id,'On the way',companyId)  [best-effort; emits status_changed event/SSE]
                   → on ok: toast + close + afterMutation(id)
```

No new SSE event is introduced — the standard `job.status_changed` (from `updateBlancStatus`) and the conversation/timeline write (from `sendMessage`) already drive the existing real-time refresh paths.

---

## 7. Edge cases (consolidated)

| # | Case | Behavior |
|---|---|---|
| E1 | **No geolocation API / denied / timeout (8s)** | State (c): "ETA unavailable — location is off." + hint; **no** `estimate` call; tiles + custom only. Notify still works with chosen minutes (SC-02). |
| E2 | **Estimate fails / NO_KEY / Google error** | `estimate` returns `eta_minutes:null` → state (c) (no Google row). Tiles + custom only (SC-02/SC-04). |
| E3 | **No service address / no lat,lng** | `estimate` returns `eta_minutes:null` (dest unresolved) → state (c). Notification + status change still proceed (SC-04). |
| E4 | **No customer phone** | `notify` → **422 NO_PHONE** *before* any send; status unchanged; toast "No phone number on file for this customer." (SC-03). |
| E5 | **No proxy DID** (MRU empty + no `SOFTPHONE_CALLER_ID`) | `notify` → **422 NO_PROXY**; status unchanged; toast "No sending number configured for your company." |
| E6 | **Wallet blocked** | `sendMessage` throws via `walletService.assertServiceActive`; route → `WALLET_BLOCKED`; **no SMS, status unchanged**; toast "Messaging is paused — top up your balance." (SC-05). |
| E7 | **SMS send throws (Twilio/network, non-wallet)** | route → `SMS_FAILED` (`502`/`500`); **status unchanged**; toast "Couldn't send the message. Please try again."; user may retry (SC-06). |
| E8 | **Status-set fails AFTER successful SMS** | catch in route → `{ ok:true, warning:'status_not_advanced' }`; **SMS NOT rolled back**; warning toast; modal closes + refresh (AC-7). |
| E9 | **Job not in a pre-visit status** (e.g. already `On the way`, `Waiting for parts`, terminal) | Primary CTA **hidden** (gated on `{Submitted, Rescheduled}`). If the job changed underneath and a stale call reaches `notify`, `updateBlancStatus` rejects the disallowed transition → falls into E8 path (`status_not_advanced`) after the SMS, OR (if already `On the way`) the FSM `__NOOP__` keeps status as-is. |
| E10 | **Multiple assigned techs** | Use `assigned_techs[0].name` only; never list all. |
| E11 | **Missing company name** | `{company}` falls back to `your service team`; sentence still reads. |
| E12 | **No assigned tech / empty name** | `{tech}` omitted; sentence renders `Hi! Your technician from {company} is on the way…` (§3.1). |
| E13 | **Double-tap "Notify client"** | Button disabled in-flight (client). Server status is `__NOOP__`-safe if already `On the way`. No auto-retry on timeout. |
| E14 | **Cross-tenant / unknown job id** | `getJobById(id, companyId)` → null → **404** on both endpoints (AC-12). |
| E15 | **Missing `messages.send`** | CTA hidden client-side; endpoints return **403** server-side (AC-2). |
| E16 | **Invalid `eta_minutes`** (non-int, <1, >600) | Client keeps Notify disabled; if it still reaches the server → **400 `invalid_eta`**. |

---

## 8. Security & data isolation

- `company_id` exclusively from `req.companyFilter?.company_id` (AC-12); never from the body.
- Customer phone derived server-side from `job.customer_phone` (job loaded company-scoped); proxy DID resolved server-side. Neither is client-supplied.
- Both endpoints enforce `requirePermission('messages.send')` + company scoping; cross-tenant job → 404.
- Google key stays server-side (`GOOGLE_GEOCODING_KEY || GOOGLE_PLACES_KEY`); only `{lat,lng}` is POSTed by the client. Key never sent to the browser.
- Wallet gate (`walletService.assertServiceActive` inside `sendMessage`) remains the single outbound-SMS cost-enforcement point — not duplicated here (Protected).

---

## 9. Protected / untouched (must not break)

- `walletService` gate inside `sendMessage`; `conversationsService` send path (reused unchanged); `routeDistanceService` (reused unchanged).
- `OUTBOUND_MAP` / Zenbooker outbound sync, and all existing Job FSM states/transitions & the `073` seed completeness (FSM-001 §8) — `On the way` is purely additive.
- `frontend/src/lib/authedFetch.ts`, `useRealtimeEvents.ts`, `src/server.js` (jobs router already mounted — no new mount).
- `On the way` (`blanc_status`) must not be conflated with ZB `en-route` (`zb_status`) / `markEnroute` / `/enroute`.

## 10. File-touch summary

- **NEW:** `backend/db/migrations/127_job_fsm_on_the_way.sql`; `frontend/src/components/jobs/OnTheWayModal.tsx`. (Optionally `backend/db/migrations/rollback_127_*.sql`.)
- **EDIT backend:** `services/jobsService.js` (BLANC_STATUSES + ALLOWED_TRANSITIONS); `routes/jobs.js` (+2 routes + `resolveCompanyProxyE164` helper); `fsm/job.scxml`; `db/migrations/073_seed_fsm_machines.sql`. (`conversationsService.js`, `routeDistanceService.js`, `companyQueries.js` reused.)
- **EDIT frontend:** `components/jobs/JobStatusTags.tsx` (primary CTA + modal mount); `components/jobs/jobHelpers.tsx` (status + color); `services/jobsApi.ts` (2 methods).
