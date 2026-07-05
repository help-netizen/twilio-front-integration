# Spec: AGENT-SKILLS-001 — Provider-neutral CRM skill layer + existing-customer voice skills (P1–P3) + service-CRM MCP surface

**Status:** Spec · **Priority:** P1 · **Date:** 2026-07-04 · **Owner:** Voice / CRM / Platform
**Type:** feature — backend (new provider-neutral skill layer + verification gate; `/api/vapi-tools` → thin adapter; new service-CRM MCP triplet; ZB write-through for reschedule; audit note on every write) + repo config (`voice-agent/assistants/lead-qualifier-v2.json` routing prompt + tool-defs).

**Upstream inputs (read before implementing):**
- Requirements: `Docs/requirements.md → ## AGENT-SKILLS-001` (AR-1…AR-6, FR-S1…FR-S9, AC-1…AC-13).
- Architecture: `Docs/architecture.md → ## AGENT-SKILLS-001` (lines ~3711–3895) — module layout, parallel `svc.*` MCP triplet, verification gate, per-skill table, ZB reschedule seam, **corrected `status_map` (§6.1)**.
- Skill semantics / guardrails / retention flow: `voice-agent/assistants/lead-qualifier-v3-crm-roadmap.md` (FR-C1…FR-C8).

**This spec is the source of truth for the Test-Cases and Planner agents.** It restates behavior precisely as JSON contracts. Where the roadmap and the real code disagree, the **real code + architecture §6.1 win** (called out inline). All prose/spoken text uses **"Albusto"** (product name); code identifiers `blanc_status` / `BLANC_STATUSES` / `--blanc-*` stay as-is (D5, MEMORY: product-name-albusto).

---

## 0. Naming, terms, and the one principle

**The principle (D2):** *the voice agent must be swappable for any other agent, with everything still working.* Therefore **all skill logic + all verification gating lives inside the CRM**, in a provider-neutral skill layer at `backend/src/services/agentSkills/`. VAPI/Sara and MCP are **thin adapters** carrying **zero** business logic.

**Terms:**
- **Skill** — a pure async function `run(companyId, verifiedContext, input) → resultObject`. One per capability (9 total, + 5 relocated L0 legacy tools).
- **Adapter** — a transport shim (VAPI REST, or MCP JSON-RPC/stdio) that translates an envelope to/from the skill layer and calls `agentSkills.runSkill(...)`.
- **`verifiedContext`** — the server-built object `{ level, contactId, customerName, matchedPhone }` produced by `verificationGate.deriveLevel` on **every** call. Never taken from the LLM/client.
- **Identity block** — the *claims* the adapter passes in `input`: `{ phone?, name?, zip?, street?, contactId? }`. Claims, not proof; the gate re-verifies against the DB.
- **L0/L1/L2** — verification levels (§2). L0 = anonymous/new; L1 = phone-matched; L2 = phone/identity match + server-confirmed name AND (ZIP or street).
- **`DEFAULT_COMPANY_ID`** = `'00000000-0000-0000-0000-000000000001'` (`vapi-tools.js:27`; == `ZENBOOKER_DEFAULT_COMPANY_ID`). Single-tenant hardwire for the voice/public-MCP surface.

---

## 1. Overall behavior (the router)

The assistant identifies **first**, then branches. This is enforced by the assistant prompt (repo JSON) but every gate is re-enforced server-side.

```
Inbound call (Sara / any agent)
   │
   ▼
identifyCaller(phone from call metadata)            ← silent, L0-entry skill
   ├─ matchType:'new'      → v2 NEW-LEAD flow (checkServiceArea/validateAddress/
   │                          checkAvailability/recommendSlots/createLead → Review)
   ├─ matchType:'existing' → greet by name; verificationLevel L1 or L2
   │        │
   │        ├─ status / appointments?   → getJobStatus / getCustomerOverview / getAppointments   (L1)
   │        ├─ reschedule?              → (L2) offer windows → confirm old→new → rescheduleAppointment  (write)
   │        ├─ cancel?                  → (L2) ask reason → ONE save attempt → cancelAppointment       (write)
   │        ├─ estimate / invoice?      → (L2) getEstimateSummary / getInvoiceSummary → offer text link
   │        └─ history / notes?         → (L2) getJobHistory
   │
   └─ matchType:'ambiguous' → disambiguate (ask ZIP / last appt) → re-run identifyCaller → resolve
```

**Existing-customer service calls only UPDATE the job — they NEVER spawn a Review lead** (Decided default D, resolves OQ-V3-5). Only an L0 `matchType:'new'` result routes to the existing `createLead → Review` flow. *(Default — owner may override.)*

---

## 2. The verification contract (server-side, stateless-per-call)

### 2.1 Per-call contract (identical for both adapters)

Every skill invocation carries, inside `input`, an **identity block**:

```json
{ "phone": "string?", "name": "string?", "zip": "string?", "street": "string?", "contactId": "string?" }
```

These are **claims** the agent has learned so far in the call. The adapter also passes a server-built `rawContext` (`{ source:'vapi'|'mcp', call?, req? }`) that the skill layer uses for logging only — never for authorization.

**`agentSkills.runSkill(skillName, companyId, rawContext, input)`** does, in order:
1. Resolve `skill` from `registry.js`. Unknown skill → SAFE_FALLBACK (§6), never a crash.
2. `verifiedContext = verificationGate.deriveLevel(companyId, identityBlock)` — **recompute the level from scratch** by re-running `identityResolver` against the DB (never read a claimed level).
3. `verificationGate.assert(skill.requiredLevel, verifiedContext.level)` — throws typed `verification_required` if `derived < required`.
4. `raw = await skill.run(companyId, verifiedContext, input)`.
5. Wrap in the graceful-degradation guard (§6): any throw → SAFE_FALLBACK; a soft `verification_required` on a sensitive skill → a soft "I'll need to verify a couple details first" shape.

### 2.2 What the gate re-derives and re-checks against the DB

`verificationGate.deriveLevel(companyId, { phone, name, zip, street, contactId })`:

| Derived level | Server-side condition (all scoped to `companyId`) |
|---|---|
| **L0** | No match: `identityResolver` finds no lead/contact/job for the given phone/name/ZIP. Only `identifyCaller` proceeds (returns `matchType:'new'`); every other skill's `assert` fails and the caller is routed to new-lead. |
| **L1** | A **real phone match** to exactly **one** contact (server-side lookup, not the caller's word). If `contactId` was supplied, it must correspond to that same resolved contact. |
| **L2** | A phone/identity match **AND** a server-confirmed `name` match **AND** (`zip` **OR** `street`) match against that contact's stored record (contact / its jobs / its leads). The gate compares the caller-supplied `name` and `zip`/`street` to the stored fields; the LLM saying "their name is X" only matters because the server independently confirms X against the row. |

- **Ambiguity** (multiple contacts match phone, or name+ZIP match >1) → level does **not** rise to L1/L2; `deriveLevel` returns `L0` with an `ambiguous` marker so `identifyCaller` can return `matchType:'ambiguous'` and force disambiguation. No sensitive read/write is permitted on an ambiguous identity.
- **Masked number never auto-upgrades.** A masked/spoofed inbound number that matches nothing yields L0; L2 is reachable only via a confirmed name + ZIP/street.

### 2.3 Why an LLM-asserted `verified:true` is ignored (AC-8)

The gate **only** trusts `deriveLevel`'s DB-derived result. If the adapter's `input` contains `verified:true`, `level:"L2"`, or any self-asserted verification field, it is **discarded** — the gate never reads it. A call to a sensitive/write skill that supplies `verified:true` but whose identity block does not independently resolve to L2 on the server is **rejected** with `verification_required`. Verification is stateless: because it is re-derived every call, a mid-call "downgrade" (agent forgets to resend the name/ZIP) simply fails the gate again — **fail-closed**, never stale-trust escalation.

### 2.4 What each L-level unlocks

| Level | Reads unlocked | Writes unlocked |
|---|---|---|
| **L0** | `identifyCaller` only | none |
| **L1** | `identifyCaller`, `getCustomerOverview`, `getJobStatus`, `getAppointments` (low-sensitivity: open-job count, **next appointment window**, **status phrase**, existence of estimate/invoice) | none |
| **L2** | all L1 reads **plus** `getJobHistory`, `getEstimateSummary`, `getInvoiceSummary` (amounts, line-item existence, notes) | `rescheduleAppointment`, `cancelAppointment` |

### 2.5 What is NEVER disclosed below L2 (hard privacy rules)

- **Full street address** — **confirm-only** ("is this still the Walpole Street address?" → yes/no). Never read the full address back unprompted, at any level.
- **Invoice amounts** (`total`, `amountPaid`, `balanceDue`) — L2 only.
- **Estimate line items / per-item pricing** — never read line-by-line at any level; L2 gets a summary + total + a text-a-link offer only.
- **Technician personal info** (name/phone/PII) — never disclosed; ETA is framed as "the tech will text before arriving."
- **Any other customer's data / any other company's data** — never (P0 company isolation).

---

## 3. Identity resolution (S1 detail)

`identityResolver` resolves across **leads + contacts + jobs**, NOT open leads alone. **Why (real-code fact):** `leadsService.getLeadByPhone` (leadsService.js:1104) deliberately **`return null` when the matched lead's contact already has a job** (lines 1140–1146 — for PulsePage) and `getLeadsByPhones` (line 1041) applies the same filter (line 1081). That is *exactly* the existing-customer case identity must catch, so the resolver must **not** rely on those getters' return alone.

**Resolution order:**
1. **Silent phone lookup** from call metadata (`message.call.customer.number` on VAPI). Normalize to last-10 digits. Try `leadsService.getLeadsByPhones([phone], companyId)` / `getLeadByPhone(phone, companyId)`.
2. **If null-but-digits-present** (the getter suppressed a lead that has a job): bridge phone → contact via a contacts/timeline phone match (`contactsService` has **no** native phone getter — use a leads/timeline phone match to find `contact_id`), then pull that contact's jobs with `jobsService.listJobs({ contactId, companyId })`. A contact with jobs but a suppressed lead = **existing customer**.
3. **If masked / no usable phone:** resolve by `name` + `zip`/`street` against contacts + their jobs/leads (fuzzy name, normalized ZIP).
4. **Disambiguate** multiple matches by last appointment date / address before returning; if still >1, return ambiguous.

**`matchType` outcomes:** `new` (no match → L0), `existing` (resolved to exactly one contact → L1, or L2 if name+ZIP/street confirmed), `ambiguous` (>1 candidate → force disambiguation, stays L0-with-marker until resolved).

---

## 4. Per-skill behavior

Conventions for every skill below:
- **Inputs** always additionally accept the identity block fields; only skill-specific fields are listed.
- **Outputs** are provider-neutral, speech-safe: no raw PII dump, no internal codes, no stack traces. `blanc_status` is **never** returned raw — always the mapped phrase from `statusMap` (§4.10).
- **Isolation:** every reused-service call is scoped to `companyId` and the verified `contactId`. A skill re-checks ownership by scoping — it never trusts `input` for company/contact/entity ownership.
- Where a skill is a **write**, it emits an "AI Phone" audit note (§5.1) + a domain event.
- On any internal error → SAFE_FALLBACK (§6).

Each output object also carries a `speak` string (the phrase the agent should say) and an `ok` boolean, so a swapped agent needs no mapping table. `speak` never contains PII beyond what the L-level allows.

### 4.1 `identifyCaller` — read, L0 (derives L1/L2) — FR-S1 / FR-C1

- **Purpose:** resolve who is calling; the linchpin that branches new vs. existing and produces the verification level for the rest of the call.
- **Input:**
  ```json
  { "phone": "string?", "name": "string?", "zip": "string?", "street": "string?" }
  ```
- **Output:**
  ```json
  {
    "ok": true,
    "matchType": "new | existing | ambiguous",
    "contactId": "string | null",
    "customerName": "string | null",
    "verificationLevel": "L0 | L1 | L2",
    "ambiguousCount": "integer | null",
    "speak": "string"
  }
  ```
  Never a raw PII dump. `customerName` is the display name only (used to greet); no phone/email/address echoed.
- **Required level:** L0 (this skill is how a level is *produced*). It runs for anyone.
- **Service calls:** `identityResolver` over `leadsService.getLeadByPhone`/`getLeadsByPhones` + `contactsService` (bridge) + `jobsService.listJobs({contactId})` (§3).
- **Guardrails:** masked number → return `matchType` reflecting no phone match and prompt the agent (via `speak`) to ask name + ZIP, rather than assuming `new`; ambiguous → return `matchType:'ambiguous'` + `ambiguousCount` and prompt disambiguation before any further skill; tolerant of masked/spoofed numbers, fuzzy name, normalized phone/ZIP.

### 4.2 `getCustomerOverview` — read, L1 — FR-S2 / FR-C2

- **Purpose:** one-line snapshot to route the conversation.
- **Input:** `{ "contactId": "string" }`
- **Output:**
  ```json
  {
    "ok": true,
    "openJobsCount": "integer",
    "nextAppointment": { "jobId": "string", "window": "string" } | null,
    "lastJobStatus": "string(phrase) | null",
    "hasOpenEstimate": "boolean",
    "hasUnpaidInvoice": "boolean",
    "speak": "string"
  }
  ```
  **No amounts. No addresses.** `hasOpenEstimate`/`hasUnpaidInvoice` are existence booleans only (not counts, not totals).
- **Required level:** L1.
- **Service calls:** `jobsService.listJobs({ contactId, onlyOpen:true, companyId })`; appointment window derived from the job's `start_date`/`end_date` (schedule items expose `entity_type='job'`, `entity_id=job.id`, `start_at=start_date`, `end_at=end_date`); estimate/invoice **existence** via `estimatesService.listEstimates(companyId, {contactId/jobId})` / `invoicesService.listInvoices(companyId, {...})` reduced to a boolean (no totals surfaced at L1).
- **Guardrails:** multiple open jobs → `speak` asks which appliance/service to scope; `lastJobStatus` is a mapped phrase, never a code.

> **Code-vs-architecture note:** `scheduleService.getScheduleItems` filters do **not** natively accept `contactId` (`scheduleQueries.js` has no `contact_id` param). So the "next appointment" is derived from `jobsService.listJobs({contactId})` (jobs carry `start_date`/`end_date`), optionally correlated with `getScheduleItems` by `entity_id === jobId` when a fuller schedule view is needed. Do **not** pass `{contactId}` straight into `getScheduleItems` expecting a filter.

### 4.3 `getJobStatus` — read, L1 — FR-S3 / FR-C3

- **Purpose:** answer "what's going on with my repair?" for a specific/relevant job.
- **Input:** `{ "contactId": "string", "jobId": "string?" }` (if `jobId` omitted → most relevant open job).
- **Output:**
  ```json
  {
    "ok": true,
    "jobId": "string",
    "serviceName": "string",
    "statusLabel": "string(phrase)",
    "statusStage": "string(internal-stage-key, not spoken)",
    "appointmentWindow": "string | null",
    "technicianEtaText": "string | null",
    "nextAction": "string(hint)",
    "speak": "string"
  }
  ```
- **Required level:** L1.
- **Service calls:** `jobsService.getJobById(jobId, companyId)` / `listJobs({contactId})`; `statusMap` maps `blanc_status`; optionally `getJobTransitions(companyId, currentState, roles)` to drive the offer.
- **Guardrails:** never read internal `blanc_status` aloud (map via `statusMap`, §4.10); drive `nextAction` from stage — `On the way` → ETA "the tech will text before arriving"; `Waiting for parts` → set expectation; `Visit completed`/`Job is Done` → offer review / new job; a booked-not-started job (`Submitted` + a schedule window) → offer reschedule. `technicianEtaText` never contains the tech's name/number.

### 4.4 `getAppointments` — read, L1 — FR-S4 / FR-C8

- **Purpose:** "when is my appointment / do I have anything scheduled?"
- **Input:** `{ "contactId": "string" }`
- **Output:**
  ```json
  {
    "ok": true,
    "appointments": [
      { "jobId": "string", "serviceName": "string", "date": "string", "window": "string", "statusLabel": "string(phrase)" }
    ],
    "speak": "string"
  }
  ```
- **Required level:** L1.
- **Service calls:** `jobsService.listJobs({ contactId, companyId })` (windows from `start_date`/`end_date`) correlated with `scheduleService.getScheduleItems(companyId, {startDate,endDate})` by `entity_id===jobId` for scheduled items.
- **Guardrails:** window stated as a **range** (e.g. "between 10 and 12"); never promise an exact minute.

### 4.5 `rescheduleAppointment` — write, L2 — FR-S5 / FR-C6

- **Purpose:** move a verified customer's appointment; write Albusto **and** push Zenbooker.
- **Input:**
  ```json
  { "contactId": "string", "jobId": "string", "newPreferredSlot": { "date": "string", "start": "HH:MM", "end": "HH:MM" } }
  ```
  (`newPreferredSlot` is one of the windows previously offered and confirmed.)
- **Output:**
  ```json
  { "ok": true, "success": "boolean", "newWindow": "string | null", "conflict": "boolean", "speak": "string" }
  ```
- **Required level:** **L2** (re-checked server-side).
- **Service calls:**
  - **Read (offer step):** `scheduleService.getAvailableSlots(companyId, {...})` — returns `{ slots: [{ date, label, start, end }] }` (human `label` phrases) or `{ slots: [], error }`; or the `recommendSlots`/engine path (gated on `smart-slot-engine`, §Gate-E). The offer step surfaces 2–3 windows.
  - **Write:** `scheduleService.rescheduleItem(companyId, 'job', jobId, newStartAt, newEndAt)` **+ the new ZB reschedule push (AR-4, §5.2)** + `jobsService.addNote(jobId, text, [], 'AI Phone', 'AI Phone')` + `eventService.logEvent(companyId, 'job', jobId, 'job_rescheduled', {...}, 'system')`.
- **Guardrails:** **confirm old→new before writing** — no write without explicit confirmation of the new window (the offer/confirm happen across turns; the write skill is only called after confirmation). On conflict, return `conflict:true` and `speak` offers the next window (no write). The reschedule must appear on the dispatcher schedule immediately (the Albusto write does that synchronously). See §5.3 for the **blocking-with-recovery** ZB-failure posture.

### 4.6 `cancelAppointment` — write, L2, retention-gated — FR-S6 / FR-C7

- **Purpose:** cancel a verified customer's appointment, but only after exactly one genuine retention attempt.
- **Input:**
  ```json
  { "contactId": "string", "jobId": "string", "reason": "string", "retentionAttempted": true }
  ```
- **Output:**
  ```json
  { "ok": true, "success": "boolean", "status": "string(phrase)", "speak": "string" }
  ```
- **Required level:** **L2**.
- **Service calls:** ownership pre-check via `jobsService.getJobById(jobId, companyId)` (see note), then `jobsService.cancelJob(jobId)` (**already ZB-pushes** — `zenbookerClient.cancelJob(zenbooker_job_id)` with `forceSyncOnZbError`, jobsService.js:1225) + `jobsService.addNote(jobId, reason-text, [], 'AI Phone', 'AI Phone')` + `eventService.logEvent(companyId, 'job', jobId, 'job_canceled', { reason, retentionAttempted:true, actor:'AI Phone' }, 'system')`.
- **Guardrails (mandatory order, enforced by both prompt AND server):**
  1. **Acknowledge + require a `reason`** (price / timing / found-someone / fixed-itself / no-longer-needed). A cancel call with empty `reason` is **rejected** (the skill returns a soft "I need to note why" shape, no cancel).
  2. **Exactly one** genuine save attempt matched to the reason (this happens in the conversation before the write; the write skill requires `retentionAttempted:true`):
     - timing → offer a better/sooner window (reschedule);
     - price → restate the **$95-credit** / no-full-prepayment protection;
     - found-someone → trust / anti-scam framing + soonest slot;
     - fixed-itself → offer to keep a note / easy rebook.
  3. Only if the customer still insists → cancel with `retentionAttempted:true`. **Never cancel on first ask**; a call with `retentionAttempted` falsey/absent is **rejected** (no cancel).
  - **Cancellation policy / fee wording (Decided default A, OQ-V3-2):** cancel is **free before the visit**; the skill **captures the reason** and **states no fee**. *(Default — owner may override; if a fee/window policy is later provided, the skill states it before writing.)*
  - Cancel is reflected in CRM + dispatcher schedule + ZB; the reason is on the job note **every time**.

> **Code-vs-architecture note (real signature):** `jobsService.cancelJob(jobId)` takes **only** `jobId` — no `companyId` param. To keep isolation absolute, the skill MUST first `getJobById(jobId, companyId)` and confirm the job belongs to `companyId` **and** to the verified `contactId` before calling `cancelJob`. Same pattern for `rescheduleAppointment`'s ownership check.

### 4.7 `getJobHistory` — read, L2 (sensitive) — FR-S7 / FR-C4

- **Purpose:** "what did the tech say last time?" — a summarized, speech-friendly timeline.
- **Input:** `{ "contactId": "string", "jobId": "string" }`
- **Output:**
  ```json
  {
    "ok": true,
    "timeline": [ { "date": "string", "event": "string", "note_summary": "string" } ],
    "speak": "string"
  }
  ```
- **Required level:** **L2**.
- **Service calls:** `jobsService` notes + `eventService.getEntityHistory(companyId, 'job', jobId, notes)`.
- **Guardrails:** **redact internal-only / technician-private notes** — never read raw; summarize. L1 callers are asked to verify (to L2) before any history is shared (the gate enforces this — an L1 call returns the soft verify shape, §6).

### 4.8 `getEstimateSummary` — read, L2 (sensitive) — FR-S8 / FR-C5

- **Purpose:** "how much was my estimate?" — a spoken summary + text-a-link, never line items.
- **Input:** `{ "contactId": "string", "jobId": "string?", "estimateId": "string?" }`
- **Output:**
  ```json
  {
    "ok": true,
    "estimateNumber": "string",
    "status": "string",
    "total": "number",
    "itemCount": "integer",
    "summaryText": "string",
    "speak": "string"
  }
  ```
- **Required level:** **L2**.
- **Service calls:** `estimatesService.listEstimates(companyId, {contactId/jobId})` / `getEstimate(companyId, estimateId)` — scoped to `companyId` **and** the verified contact's job(s).
- **Guardrails:** spoken **summary** only; **do not read every line item** (`itemCount` is a count, not a list); offer to text a secure link via the **SEND-DOC-001 channel** (Decided default C — the company's configured SMS/email sender; *default — owner may override the sender identity, OQ-V3-4*); amounts only after **L2**.

### 4.9 `getInvoiceSummary` — read, L2 (sensitive) — FR-S9 / FR-C5

- **Purpose:** "what's my balance?" — state balance + status; hand payment to a secure link / human.
- **Input:** `{ "contactId": "string", "invoiceId": "string?" }`
- **Output:**
  ```json
  {
    "ok": true,
    "invoiceNumber": "string",
    "status": "string",
    "total": "number",
    "amountPaid": "number",
    "balanceDue": "number",
    "speak": "string"
  }
  ```
- **Required level:** **L2**.
- **Service calls:** `invoicesService.listInvoices(companyId, {contactId})` / `getInvoice(companyId, invoiceId)` — scoped to `companyId` + verified contact.
- **Guardrails:** state balance + status; **for payment, hand off to a secure link (SEND-DOC-001) or a human — NEVER collect a card by voice** (P0); amounts only after **L2**.

### 4.10 `status_map` — the CORRECTED map (architecture §6.1, reconciled to real `BLANC_STATUSES`)

**Real `BLANC_STATUSES` (jobsService.js:25):** `['Submitted','Waiting for parts','Follow Up with Client','Visit completed','Job is Done','Rescheduled','Canceled','On the way']`. **There is NO `Scheduled` label** — a booked-but-not-started job is `Submitted` **with a schedule window**; "you're scheduled" is driven by the presence of a `scheduleService` window, not by a status label. (The roadmap's `Scheduled`/`Review`/`Enroute`/`In Progress` set was illustrative — **do not use it**; use this table.)

| `blanc_status` | Spoken phrase | `nextAction` hint |
|---|---|---|
| `Submitted` | "We've got your request and are getting it scheduled." | offer reschedule if a window exists |
| `Waiting for parts` | "We're waiting on a part to finish the repair." | set expectation |
| `Follow Up with Client` | "Our team needs to follow up with you to move forward." | capture callback |
| `Visit completed` | "The technician has completed the visit." | offer review / new job |
| `Job is Done` | "The job is complete." | offer review / new job |
| `Rescheduled` | "Your appointment has been rescheduled." | confirm the new window |
| `On the way` | "Your technician is on the way." | give ETA ("the tech will text before arriving") |
| `Canceled` | "That appointment is canceled." | offer to rebook |
| *(ZB substatus)* `en-route` / `in-progress` (`zb_status`) | "on the way" / "working on it now" | — |

`statusMap.js` is the single place this lives; a skill never emits a raw code. An unmapped/unknown status → a neutral safe phrase ("Let me check the latest on that for you") + no code leak.

---

## 5. Write flows, ZB write-through, and audit

### 5.1 Audit note on every write (AR-5)

Every write skill records an **"AI Phone" audit note** on the job:
`jobsService.addNote(jobId, text, /*attachments*/ [], /*author*/ 'AI Phone', /*createdBy*/ 'AI Phone')` — real signature `addNote(jobId, text, attachments=[], author=null, createdBy=null, noteId=null)` (jobsService.js:1157; it also mirrors the note text to ZB when the job is linked). Additionally: `eventService.logEvent(companyId, 'job', jobId, <'job_rescheduled'|'job_canceled'>, { ...details, actor:'AI Phone' }, 'system')` — real signature `logEvent(companyId, aggregateType, aggregateId, eventType, eventData={}, actorType='system', actorId=null)` (fire-and-forget; safe to call). The **cancel** note MUST include the captured reason and record that a retention attempt was made.

### 5.2 Reschedule ZB seam (AR-4 — the GAP to close)

`scheduleService.rescheduleItem(companyId, entityType, entityId, newStartAt, newEndAt)` (lines 141–186) today writes **only** the Albusto DB + an internal `job_rescheduled` provider push — it does **NOT** call Zenbooker, though `zenbookerClient.rescheduleJob(id, data)` (POST `/jobs/{id}/reschedule`, line 372) exists. The Planner/Implementer must extend `rescheduleItem` so that, **after** the successful local `scheduleQueries.rescheduleJob` write and **only for `entityType==='job'` on a ZB-linked job**, it pushes to ZB, mirroring the two established disciplines already in the codebase:
- `cancelJob`'s **pre-check + `forceSyncOnZbError`** shape (skip if not linked; on ZB error, force-sync from ZB then surface the friendly 409) — because a reschedule is a state-changing write we want reconciled (ZB is master); and
- `reassignItem`'s **best-effort guard** for the non-critical `job_rescheduled` provider push (stays best-effort / never-fatal).

ZB target = `getClient()` bound to `ZENBOOKER_DEFAULT_COMPANY_ID` (= `…0001` = `DEFAULT_COMPANY_ID`); `getClientForCompany` returns null for non-default tenants (ZB-ISO-001) — so this path is default-company-only by construction. `rescheduleJob` needs `start_date` ISO 8601; where ZB requires `address.state`, reuse `ensureAddressState` (ZB job-create-state discipline) if applicable.

### 5.3 Reschedule ZB-failure posture — **blocking-with-recovery** (Decided default B)

If the ZB push fails, the reschedule **does NOT silently diverge**. At the **service layer**, mirror cancel: attempt `forceSyncOnZbError` recovery; if it cannot reconcile, throw the friendly 409 (state stays recoverable/consistent — ZB is master). At the **skill layer**, `rescheduleAppointment` catches that 409 and returns a graceful shape:
```json
{ "ok": false, "success": false, "conflict": true, "speak": "Let me have a teammate confirm that time and follow up with you shortly." }
```
So the *service* blocks on the master, the *call* continues gracefully, and the customer is never told a reschedule succeeded when the master didn't accept it. *(Default — owner may override to best-effort; recommended blocking-with-recovery since ZB is master.)*

### 5.4 Cancel flow (retention discipline)

L2 → ask reason → **exactly one** save attempt matched to the reason → only then `cancelJob` + reason note. The write skill enforces: non-empty `reason` **and** `retentionAttempted:true` (never cancel on first ask). Cancel already pushes to ZB via `cancelJob`; the skill adds the "AI Phone" note (with reason) + the `job_canceled` domain event. See §4.6 for the exact order and policy wording.

---

## 6. Error handling / graceful degradation (NFR)

**SAFE_FALLBACK shape** (from `resultShapes.js`), returned on ANY internal error:
```json
{ "ok": false, "speak": "Let me have a teammate follow up with you on that." }
```
- **Skill layer:** `agentSkills.index.runSkill` wraps every call; on any thrown error (service throw, ZB 409, unknown tool) it logs internally and returns SAFE_FALLBACK — **never** a stack, SQL, PII, or internal code. The call **always continues** (LQV2 rule); lead creation / call completion is never blocked. p95 round-trip **< 2000 ms** (index `contactId`/phone lookups; ZB/engine calls respect a timeout and fall back on slowness).
- **Verification failures on a sensitive skill** return a soft shape (not a hard 4xx to the caller):
  ```json
  { "ok": false, "needsVerification": true, "speak": "I'll need to verify a couple details first — can I get the name and ZIP on the account?" }
  ```
- **MCP surface:** additionally goes through `crmMcpResponse.mapError` + `sanitizeDetails` (drops any key matching `/token|secret|password|oauth|sql|stack/i`, truncates strings) — **reused unchanged** (crmMcpResponse.js:105–110), so the MCP transport's sanitized-error contract is inherited (AC-12).
- **Fix an existing leak:** the current adapter's `catch` sets `result = { error: err.message }` (vapi-tools.js:381) — after the refactor the adapter must NOT surface `err.message`; the skill layer's SAFE_FALLBACK replaces it (no internals reach the caller).

---

## 7. Transport contract A — REST via `vapi-tools.js` (thin adapter)

### 7.1 The VAPI envelope (unchanged shape)

- **Route:** `POST /api/vapi-tools` — mounted **without** `authenticate`/`requireCompanyAccess` (`src/server.js:220`). Auth = `vapiSecretAuth`: `x-vapi-secret` header vs `process.env.VAPI_TOOLS_SECRET`, **fail-closed** — **503** `{ error: 'vapi tools not configured' }` if the env is unset, **401** `{ error: 'Unauthorized' }` on mismatch (vapi-tools.js:34–46).
- **Request body:**
  ```json
  { "message": { "type": "tool-calls",
      "toolCallList": [ { "id": "string", "function": { "name": "string", "arguments": "JSON-string-or-object" } } ],
      "call": { "customer": { "number": "string" }, "...": "..." } } }
  ```
  Non-`tool-calls` message → `res.json({})`. `arguments` parsed defensively (a bad JSON string → `{}`).
- **Response body:**
  ```json
  { "results": [ { "toolCallId": "string", "result": "JSON-string" } ] }
  ```
  (`result` is `JSON.stringify(skillOutput)`.) Handler-level failure → `res.status(500).json({ error })`.

### 7.2 What changes (AR-2 / AC-11)

The `if (name === 'checkServiceArea') … else if …` chain (vapi-tools.js:365–381) collapses to a **table-driven dispatch into the skill registry**. Each per-tool body becomes only:
```
const raw = await agentSkills.runSkill(name, DEFAULT_COMPANY_ID, { source:'vapi', call: message.call }, args);
results.push({ toolCallId: toolCall.id, result: JSON.stringify(raw) });
```
`agentSkills.index` handles unknown-tool + graceful degradation, so the adapter's `catch` is a **thin backstop only** (and no longer surfaces `err.message`). After the refactor, `vapi-tools.js` contains **no** CRM logic, no verification decision, no SQL, no service composition — the `https`/Geocoding code moves into `skills/validateAddress.js`.

The identity block reaches the skills via `args` (the assistant re-sends `phone`/`name`/`zip`/`street`/`contactId` it has learned), plus `message.call.customer.number` is threaded in as the silent phone for `identifyCaller`.

### 7.3 Mandatory byte-identical BACK-COMPAT for the 5 LIVE tools

`checkServiceArea`, `validateAddress`, `checkAvailability`, `recommendSlots`, `createLead` move **verbatim** into skill modules under `agentSkills/skills/` at **`requiredLevel:'L0'`** (they run for anonymous callers = the new-lead flow, so `deriveLevel` never blocks them → "never block the call" preserved). Their internals are **relocated, not rewritten** — same functions, now behind the registry:
- `checkServiceArea` — `stQueries.search(DEFAULT_COMPANY_ID, zip)` behavior unchanged.
- `validateAddress` — Google Geocoding key fallback unchanged (the `https` code moves into the skill module).
- `checkAvailability` — `scheduleService.getAvailableSlots(DEFAULT_COMPANY_ID, {...})` fallback path unchanged.
- `recommendSlots` — `smart-slot-engine` marketplace gate + `SLOT_FALLBACK` safe-fail + `formatSlotLabel` unchanged (`isAppConnected(DEFAULT_COMPANY_ID,'smart-slot-engine')`, short-circuits to `{ available:false, slots:[], fallback:true }` when not connected — per VAPI-SLOT-ENGINE-001).
- `createLead` — `leadsService.createLead(body, DEFAULT_COMPANY_ID)` + `chosenSlot` slot-persist + 1-retry + disqualified-lead shape unchanged.

**Regression bar:** for identical inputs, each of the 5 tools returns a **byte-identical** `result` JSON before and after the refactor. This is a hard AC (AC-11) and a Test-Cases must (compare the old handler output to the new skill output on a matrix of inputs).

---

## 8. Transport contract B — the service-CRM MCP surface (`svc.*`)

**Reuse the `crmMcp*` framework — do NOT build a second one.** Add a **parallel triplet** that reuses the same machinery and contracts but points at the skill layer (the sales executor/protocol are hardwired to `crm.*` and `crmAccountsService…`, so they can't be overloaded — mirror them):

| New file | Mirrors | Difference |
|---|---|---|
| `agentSkillsMcpRegistry.js` | `crmMcpToolRegistry.js` | Same tool-def shape + `objectSchema/integerSchema/enumSchema/stringSchema` helpers + `normalizeTool(tool, kind)` → `{ ...tool, kind, requiresConfirmation:(kind==='write'), requiredPermission }`. **Adds per-tool `requiredLevel`**; a projection of the skill `registry.js`. Names namespaced `svc.*`. |
| `agentSkillsMcpExecutor.js` | `crmMcpToolExecutor.js` | Reuses `crmMcpSchemaValidator.validateArguments` + `crmMcpResponse` **unchanged**. `buildContext(req)` reads `companyId` from **`req.companyFilter?.company_id`** (never client). `requireWriteAccess` keeps the write-permission + `confirmation.confirmed`+`confirmation_id` gate. `dispatch()` calls `agentSkills.runSkill(skillFor(toolName), companyId, mcpContext, args)` — the **same** skill layer as Adapter A; passes the MCP identity block through so `verificationGate` runs identically. |
| `agentSkillsMcpProtocolService.js` | `crmMcpProtocolService.js` | Same JSON-RPC (`initialize`/`ping`/`tools/list`/`tools/call`), `toProtocolTool` annotations, `crmMcpResponse.mapError`. `serverInfo.name='albusto-service-crm-mcp'`. |
| `routes/agentSkillsMcp.js` | `crmMcp.js` | Authenticated JSON-RPC. Mounted `app.use('/api/agent-skills/mcp', authenticate, requireCompanyAccess, router)` (same chain as `/api/crm/mcp`). |
| `routes/agentSkillsMcpPublic.js` + `agentSkillsMcpPublicAuth.js` | `crmMcpPublic.js` + `crmMcpPublicAuth.js` | Token-gated public transport, **env-bound company context**, **writes disabled unless explicitly enabled**. Env: `SVC_MCP_PUBLIC_ENABLED`, `SVC_MCP_PUBLIC_TOKEN`, `SVC_MCP_PUBLIC_COMPANY_ID` (= `…0001`), `SVC_MCP_PUBLIC_WRITE_ENABLED`. Mounted `app.use('/mcp/agent-skills', router)`. |
| `cli/agentSkillsMcpStdio.js` | `crmMcpStdio.js` | Optional stdio (`SVC_MCP_STDIO_*`). |

`crmMcpSchemaValidator.js` and `crmMcpResponse.js` are **generic** → reused as-is. Only registry/executor/protocol + public-auth are duplicated (they carry sales/env wiring).

### 8.1 Each skill's MCP tool schema

Read tools → `kind:'read'`, `requiresConfirmation:false`, `requiredPermission:null`. Write tools → `kind:'write'`, `requiresConfirmation:true`, `requiredPermission` (a service-CRM write permission key, e.g. `service.crm.write` — Planner picks the exact key; the sales default is `sales.crm.write`). Every tool additionally declares `requiredLevel` (L0/L1/L2) which the **skill layer** enforces.

| MCP tool name | kind | `requiresConfirmation` | `requiredLevel` |
|---|---|---|---|
| `svc.identify_caller` | read | false | L0 (derives) |
| `svc.get_customer_overview` | read | false | L1 |
| `svc.get_job_status` | read | false | L1 |
| `svc.get_appointments` | read | false | L1 |
| `svc.get_job_history` | read | false | L2 |
| `svc.get_estimate_summary` | read | false | L2 |
| `svc.get_invoice_summary` | read | false | L2 |
| `svc.reschedule_appointment` | write | true | L2 |
| `svc.cancel_appointment` | write | true | L2 |

Input schemas mirror §4 (snake_case fields per MCP convention: `contact_id`, `job_id`, `new_preferred_slot`, `reason`, `retention_attempted`, plus the identity block `phone`/`name`/`zip`/`street`). `inputSchema` built with the reused `objectSchema(...)`/`integerSchema(...)`/`stringSchema()` helpers.

### 8.2 Tenant-from-context + how verification composes with the framework's write/confirmation gate (D4)

- **Company** comes from `req.companyFilter.company_id` (authenticated route) or the env-bound `SVC_MCP_PUBLIC_COMPANY_ID` (public), **never** the client payload — identical rule to the sales MCP.
- **Verification** (L0/L1/L2) is **still** derived server-side by the skill layer from the identity block in `arguments`. The MCP framework's write-permission + `confirmation` gate is an **additional outer gate**, it does **NOT** replace L0/L1/L2. So an MCP `svc.reschedule_appointment` call must satisfy **both** the framework write-gate (permission + `confirmation.confirmed`+`confirmation_id`) **and** the skill-layer **L2** gate. This is strictly stronger — correct for a non-voice caller.
- **Public MCP writes disabled unless explicitly enabled** (`SVC_MCP_PUBLIC_WRITE_ENABLED`), bearer-token + env-bound-company gated (CRM-MCP precedent).

### 8.3 Marketplace gate (Decided default E, architecture Open-E)

- **NO gate on `identify` + reads** — inbound calls must **always** resolve identity + read status regardless of marketplace connection state.
- The existing **`smart-slot-engine` gate applies ONLY to the reschedule slot-offer step** (reuse `recommendSlots`/`getRecommendations`, gated on `isAppConnected(companyId,'smart-slot-engine')` with graceful fallback to `scheduleService.getAvailableSlots`). The reschedule *write* itself is not gated.
*(Default — owner may override; Architect leaned this way.)*

---

## 9. Security invariants (P0)

1. **Company isolation on every query.** Every reused-service call is scoped to `companyId` (all accept it) = hardwired `DEFAULT_COMPANY_ID` on voice/public-MCP, or `req.companyFilter.company_id` on the authed MCP route. A cross-customer or cross-company disclosure/mutation is a **P0 defect**. (Note the `cancelJob(jobId)`-has-no-companyId caveat, §4.6 — ownership pre-checked via `getJobById(jobId, companyId)`.)
2. **Verification enforced server-side** in `verificationGate`, DB-derived, re-checked every call; an LLM/client `verified:true` has no effect (AC-8).
3. **No payment / card capture by voice — ever.** Payment → SEND-DOC-001 secure link or human handoff.
4. **Audit note on every write** ("AI Phone") + a `domain_events` entry.
5. **No cross-customer / cross-company disclosure.** Ambiguous identity never unlocks a read/write; masked numbers never auto-upgrade; full address is confirm-only; other customers'/companies' data is never reachable.
6. **Sanitized errors** — SAFE_FALLBACK from the skill layer; `crmMcpResponse.sanitizeDetails` on the MCP surface (drops token/secret/password/oauth/sql/stack).

---

## 10. Edge cases

| # | Situation | Expected behavior |
|---|---|---|
| E1 | **Empty / zero / first-run** — resolved contact has no jobs/appointments/estimates/invoices | Reads succeed with empty shapes (`openJobsCount:0`, `appointments:[]`, `hasOpenEstimate:false`); `speak` says nothing is on file and offers to help book — never an error. |
| E2 | **Multiple open jobs** | `getCustomerOverview`/`getJobStatus` `speak` asks which appliance/service to scope; the skill does not guess. Once scoped by `jobId`, proceed. |
| E3 | **Ambiguous identity** (>1 contact matches phone, or name+ZIP matches >1) | `identifyCaller` → `matchType:'ambiguous'` + `ambiguousCount`; level stays L0-with-marker; no sensitive read/write until disambiguated (ask ZIP / last appt date). |
| E4 | **ZB down / ZB error on reschedule** | Blocking-with-recovery (§5.3): `rescheduleItem` attempts `forceSyncOnZbError`, throws friendly 409 if unreconciled; skill returns `{ok:false, conflict:true, speak:"let me have a teammate confirm that time"}`. Local state stays consistent with the master (never a silent divergence). |
| E5 | **ZB down / ZB error on cancel** | `cancelJob` already handles it (`forceSyncOnZbError`); the Albusto cancel still records; skill returns success or SAFE_FALLBACK per the recovery result. |
| E6 | **Slot engine down / not connected** (reschedule offer) | Gate/fallback: `recommendSlots` short-circuits to `{available:false, slots:[], fallback:true}` or falls back to `scheduleService.getAvailableSlots`; if no windows, `speak` offers a teammate callback. Never blocks the call. |
| E7 | **No appointments** | `getAppointments` → `appointments:[]`; `speak` states nothing scheduled and offers to book. |
| E8 | **Already-canceled job** — cancel requested on a `Canceled` job | Skill detects the terminal status and returns "that appointment is already canceled" (no duplicate `cancelJob`; `cancelJob` also pre-checks `zb_canceled`). No error. |
| E9 | **Concurrent reschedule** — the chosen window was taken between offer and confirm | `rescheduleItem`/availability check surfaces the conflict; skill returns `conflict:true` and `speak` offers the next window; no write. |
| E10 | **L1 tries an L2 action** (asks history/estimate/invoice, or reschedule/cancel, only phone-matched) | `verificationGate.assert` fails; skill returns the soft `needsVerification` shape (§6) prompting name + ZIP to reach L2. Never a hard error, never disclosure. |
| E11 | **Masked / spoofed number** | Phone matches nothing → L0; `identifyCaller` prompts name + ZIP/street; resolves an existing customer within ~2 questions; reaching L2 requires the confirmed name + ZIP/street. |
| E12 | **Unknown estimate/invoice id** (or none on file) | `getEstimateSummary`/`getInvoiceSummary` return a not-found-safe shape (`ok:false` or empty) with `speak` "I don't see an estimate/invoice on file for that" — no error, no other customer's doc, amounts never guessed. |
| E13 | **Unknown skill name** (bad tool call) | `runSkill` returns SAFE_FALLBACK; VAPI adapter still returns a well-formed `results[]` entry; MCP returns a sanitized error via `crmMcpResponse`. |
| E14 | **Empty/missing `reason` or `retentionAttempted` on cancel** | Rejected (no cancel); skill returns a soft "I need to note why, and let me try one thing first" shape — enforces the retention discipline server-side, not just in the prompt. |
| E15 | **Client sends `verified:true` without a real match** | Ignored; L2 skills reject with the `needsVerification` shape (AC-8). |

---

## 11. Component interaction (summary)

```
VAPI (Sara)  ──x-vapi-secret──►  routes/vapi-tools.js (THIN)  ─┐
                                                               ├─► services/agentSkills/index.runSkill
MCP agent    ──JSON-RPC/stdio─►  routes/agentSkillsMcp*.js  ───┘        │  → verificationGate (L0/L1/L2)
             (authed or token-gated public)                            │  → skills/<name>.run(companyId, verifiedContext, input)
                                                                       ▼
        leadsService · contactsService · jobsService · scheduleService ·
        estimatesService · invoicesService · eventService · zenbookerClient · marketplaceService
                                                                       │
                                        writes ──► jobsService.addNote('AI Phone') + eventService.logEvent
                                        reschedule ──► scheduleService.rescheduleItem + NEW zenbookerClient.rescheduleJob (AR-4)
                                        cancel ──────► jobsService.cancelJob (already ZB) + reason note
```

- **No SSE / no frontend change** — this is a backend skill/route layer + repo-config change. The dispatcher schedule reflects writes because the Albusto write is synchronous (existing schedule queries), same as any other reschedule/cancel.
- **Repo config:** `voice-agent/assistants/lead-qualifier-v2.json` — add the 9 skill tool-defs to `model.tools[]` (same `function`/`server` shape as the existing five; `server.url = https://api.albusto.com/api/vapi-tools`; secret placeholder injected at push) + rewrite the routing/scheduling prompt so Sara identifies first and branches existing-vs-new, offering only skill-shaped arguments. The **live** assistant (`30e85a87`) is a **separate owner-consent-gated PATCH** (get-first; live drifts; CLI `update` panics → use REST PATCH; re-inject `VAPI_TOOLS_SECRET` into every `model.tools[].server`; keep `answerOnBridge="true"`).

---

## 12. Migrations, non-functionals, verification bar

- **Migrations: NONE** (architecture §8). Max on disk = 155. P1–P3 are a read/route layer + two guarded writes over existing tables (`jobs.notes` jsonb, `domain_events`, schedule tables, leads/contacts/estimates/invoices), reusing existing indexes (`idx_leads_contact_id`, PULSE-PERF-001 phone regex indexes, `jobs.contact_id`). A supporting phone expression index is a *follow-up* only if load-test p95 proves hot.
- **Latency:** p95 < 2000 ms per skill/tool round-trip.
- **Availability:** ≥ existing VAPI/backend posture; ≥ 10 concurrent inbound calls (LQV2).
- **Verify against a real DB / real ZB — not just mocked jest** (LIST-PAGINATION-001 / created_by-FK lessons): run the real identity lookup (including the leads-getter-returns-null-with-job case), the real reschedule (Albusto write + ZB push) and cancel, and the real estimate/invoice reads against a prod-DB copy; exercise **both** adapters (VAPI envelope + MCP JSON-RPC) end-to-end; compare the 5 legacy tools byte-for-byte pre/post-refactor. **Prod deploy and the live VAPI push are owner-consent-gated** (standing rule).

---

## 13. Traceability (requirements → this spec)

| Requirement | Covered in |
|---|---|
| AR-1 provider-neutral skill layer | §0, §2.1, §4, §11 |
| AR-2 thin vapi-tools adapter | §7 |
| AR-3 new MCP surface (reuse crmMcp*) | §8 |
| AR-4 ZB write-through (reschedule gap) | §5.2, §5.3 |
| AR-5 audit note on every write | §5.1 |
| AR-6 isolation + server-side verification (P0) | §2, §9 |
| FR-S1…FR-S9 (per-skill) | §4.1–§4.9 |
| `status_map` (corrected) | §4.10 |
| AC-1…AC-3 (identify/status/appts) | §1, §4.1–§4.4, §10(E1–E3,E11) |
| AC-4 reschedule | §4.5, §5.2, §5.3 |
| AC-5 cancel (retention) | §4.6, §5.4, §10(E8,E14) |
| AC-6 history redaction | §4.7, §10(E10) |
| AC-7 estimate/invoice / no card by voice | §4.8, §4.9, §9 |
| AC-8 server-side verification | §2.3, §10(E15) |
| AC-9 isolation (cross-tenant) | §9, §10 |
| AC-10 swappability / MCP equivalence | §8 |
| AC-11 thin adapter + legacy byte-compat | §7.2, §7.3 |
| AC-12 graceful degradation | §6, §10(E13) |
| AC-13 repo-config routing | §11 |
| Decided defaults A–E | §4.6 (A), §5.3 (B), §4.8/§4.9 (C), §1 (D), §8.3 (E) |

---

## 14. Open items carried to the owner (defaults applied; may override)

- **A — Cancellation policy/fee** (OQ-V3-2): default **free before the visit, capture reason, state no fee**. Owner may supply exact fee/window copy the cancel skill states before writing.
- **B — Reschedule ZB-failure posture**: default **blocking-with-recovery** (mirrors cancel; ZB is master). Owner may switch to best-effort.
- **C — Secure-link sender** (OQ-V3-4): default **SEND-DOC-001 channel** (company's configured SMS/email sender). No card by voice is settled; the exact sender identity may be pinned by Ops.
- **D — Review lead on existing-customer calls** (OQ-V3-5): default **existing-customer service call only UPDATES the job, never spawns a Review lead; only L0 new callers create leads.**
- **E — Marketplace gate**: default **no gate on identify + reads; `smart-slot-engine` gate only on the reschedule slot-offer step.**

*These are flagged as "default — owner may override" everywhere they appear.*
