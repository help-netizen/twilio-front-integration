---
title: "Sara v3 — CRM-Connected Voice Assistant Roadmap"
doc_type: roadmap
version: "0.1 (draft)"
status: draft
date: 2026-06-09
owner: "Voice / CRM"
builds_on:
  assistant: "Lead Qualifier v2 (Sara) — 30e85a87-9d7e-4694-828e-1fea7d10f3ef"
  endpoint: "POST /api/vapi-tools (x-vapi-secret)"
  live_tools: [checkServiceArea, validateAddress, checkAvailability, createLead]

# ─────────────────────────────────────────────────────────────────────────────
# The core problem v3 solves
# ─────────────────────────────────────────────────────────────────────────────
problem: >
  v2 (Sara) handles ONE intent well: a brand-new inbound repair lead. But ~half of
  inbound calls are EXISTING customers — asking about an appointment, a price, a
  reschedule, a cancel, or status. Today Sara would try to qualify them as a new
  lead, which is wrong and frustrating. v3 makes Sara identify who is calling and
  branch into the right flow, reading from and writing to the CRM safely.

# ─────────────────────────────────────────────────────────────────────────────
# Identity is the linchpin
# ─────────────────────────────────────────────────────────────────────────────
identity_strategy:
  why_hard: >
    ~50% of inbound numbers are masked/spoofed by lead generators (eLocal), so the
    calling number is NOT a reliable key. Caller lookup must be tolerant.
  resolution_order:
    - "1) Try the caller's phone (message.call.customer.number) — silent lookup."
    - "2) If no match or masked, ASK: full name + service ZIP or street, then look up."
    - "3) Disambiguate if multiple matches (e.g. by last appointment date or address)."
  verification_levels:
    L0_anonymous: "No match found → treat as a NEW lead (v2 flow)."
    L1_soft_match: "Matched by phone only → may READ low-sensitivity info (next appointment window, job status name). Verify a second factor (name or ZIP) before reschedule/cancel."
    L2_verified: "Matched + confirmed name AND (ZIP or address) → may reschedule, cancel, hear notes/estimate/invoice summaries."
  never_disclose_without_L2:
    - exact street address back to caller (only confirm yes/no)
    - invoice amounts / payment details
    - estimate line-item pricing
    - technician personal info
    - other customers' data (hard isolation by company_id)

# ─────────────────────────────────────────────────────────────────────────────
# New tools to add to /api/vapi-tools (handlers + assistant schema)
# READ tools are low-risk; WRITE tools require L2 verification.
# ─────────────────────────────────────────────────────────────────────────────
new_tools:
  - name: identifyCaller
    kind: read
    input: [phone, name, zip, street]
    output: [matchType, contactId, customerName, verified, ambiguousCount]
    backend: "leadsService.getLeadByPhone / contactsService lookup; timelinesQueries phone match"
    notes: "Returns a match summary, never raw PII dump. matchType ∈ new|existing|ambiguous."

  - name: getCustomerOverview
    kind: read
    requires: L1
    input: [contactId]
    output: [openJobsCount, nextAppointment, lastJobStatus, hasOpenEstimate, hasUnpaidInvoice]
    backend: "jobsService.listJobs({contactId, onlyOpen}); scheduleService.getScheduleItems"
    notes: "One-line snapshot to route the conversation. No amounts, no addresses."

  - name: getJobStatus
    kind: read
    requires: L1
    input: [contactId, jobId?]
    output: [jobId, serviceName, statusLabel, statusStage, appointmentWindow, technicianEtaText]
    backend: "jobsService.getJobById / listJobs; FSM BLANC_STATUSES → human label"
    notes: "Translate internal blanc_status to a caller-friendly phrase (see status_map)."

  - name: getJobHistory
    kind: read
    requires: L2
    input: [contactId, jobId]
    output: [timeline]  # list of {date, event, note_summary}
    backend: "jobsService notes + eventService.getEntityHistory / timelinesQueries"
    notes: "Summarize notes for speech; redact internal-only/technician-private notes."

  - name: getEstimateSummary
    kind: read
    requires: L2
    input: [contactId, jobId?, estimateId?]
    output: [estimateNumber, status, total, itemCount, summaryText]
    backend: "estimatesService.listEstimates / getEstimate"
    notes: "Spoken summary only; offer to text a link rather than read every line item."

  - name: getInvoiceSummary
    kind: read
    requires: L2
    input: [contactId, invoiceId?]
    output: [invoiceNumber, status, total, amountPaid, balanceDue]
    backend: "invoicesService.listInvoices / getInvoice"
    notes: "State balance + status; for payment, hand to a secure link/human — do NOT take card by voice."

  - name: getAppointments
    kind: read
    requires: L1
    input: [contactId]
    output: [appointments]  # [{jobId, serviceName, date, window, statusLabel}]
    backend: "scheduleService.getScheduleItems({contactId-ish}) + jobsService.listJobs"

  - name: rescheduleAppointment
    kind: write
    requires: L2
    input: [contactId, jobId, newPreferredSlot]
    output: [success, newWindow, conflict]
    backend: "scheduleService.getAvailableSlots → rescheduleItem('job', jobId, start, end)"
    notes: "Offer available windows (reuse checkAvailability logic); confirm before writing."

  - name: cancelAppointment
    kind: write
    requires: L2
    input: [contactId, jobId, reason, retentionAttempted]
    output: [success, status]
    backend: "jobsService.cancelJob(jobId) + addNote(reason)"
    notes: >
      MUST capture a reason and MUST log retentionAttempted=true only after one genuine
      save attempt (reschedule / discount-to-human / address the concern). Never cancel
      on the first ask.

# ─────────────────────────────────────────────────────────────────────────────
# Internal job status → caller-friendly language
# (jobsService BLANC_STATUSES; do not read internal codes aloud)
# ─────────────────────────────────────────────────────────────────────────────
status_map:
  Submitted: "We've got your request and are getting it scheduled."
  Review: "Our team is reviewing the details and will confirm shortly."
  Scheduled: "You're scheduled — a technician is set for your window."
  Enroute: "Your technician is on the way."
  In Progress: "The technician is working on it now."
  Waiting for parts: "We're waiting on a part to finish the repair."
  Job is Done: "The job is complete."
  Canceled: "That appointment is canceled."

security:
  - "All handlers stay company-scoped (DEFAULT_COMPANY_ID); never cross-company data."
  - "x-vapi-secret on every call (existing). Add per-tool verification gate (L1/L2)."
  - "Write tools (reschedule/cancel) require L2 verification in the same call."
  - "No card/payment capture by voice — ever. Offer secure link or human transfer."
  - "Read-back of address/PII is confirm-only ('is that the Walpole St address?'), not disclosure."
  - "Every write logs an audit note on the entity (who/what/when=AI Phone)."

phases:
  - phase: "P1 — Identify & Inform (read-only)"
    tools: [identifyCaller, getCustomerOverview, getJobStatus, getAppointments]
    goal: "Stop treating existing customers as new leads; answer 'where's my appointment / what's the status'."
  - phase: "P2 — Self-service changes (write)"
    tools: [rescheduleAppointment, cancelAppointment]
    goal: "Reschedule and (retention-gated) cancel by voice with reason capture."
  - phase: "P3 — Financial & history (sensitive read)"
    tools: [getJobHistory, getEstimateSummary, getInvoiceSummary]
    goal: "Spoken summaries + text-a-link; never read full pricing or take payment."

metrics:
  - "Existing-customer mis-qualification rate → near 0 (no existing caller pushed into new-lead flow)."
  - "Containment for status/appointment questions ≥ 70% without human."
  - "Reschedule self-service success ≥ 50% of reschedule intents."
  - "Cancel save-rate: % of cancel intents retained or downgraded to reschedule."
  - "Zero cross-customer data incidents."

open_questions:
  - id: OQ-V3-1
    q: "Verification strength: is name + ZIP enough for L2 writes, or require a booking/last-4 of phone on file?"
    owner: "Ops / Security"
  - id: OQ-V3-2
    q: "Cancellation policy: any fee/window rules the bot must state before canceling?"
    owner: Ops
  - id: OQ-V3-3
    q: "Reschedule: write to Blanc schedule only, or must it also push to Zenbooker while ZB is still live?"
    owner: Engineering
  - id: OQ-V3-4
    q: "Estimate/invoice: OK to text a secure link from the bot? Which number/sender?"
    owner: "Ops / Eng"
  - id: OQ-V3-5
    q: "Existing-customer leads: should a status/reschedule call ever create a Review lead, or only update the job?"
    owner: Product
---

# Sara v3 — CRM-Connected Voice Assistant Roadmap

**Status:** Draft · **Date:** 2026-06-09 · **Builds on:** Lead Qualifier v2 (Sara)

This document plans the evolution of the inbound voice assistant from a **new-lead
qualifier** into a **CRM-connected agent** that recognizes existing customers and
serves them: status, appointments, reschedules, retention-gated cancels, and
(carefully) estimates/invoices.

---

## 1. Why v3

v2/Sara is excellent at exactly one job: turning a cold inbound call into a qualified
repair lead. But production reality:

- **~50% of inbound calls are existing customers** (status check, "where's my tech?",
  reschedule, cancel, "how much was my estimate?").
- Today Sara would try to **qualify them as a new lead** — collecting appliance/ZIP/fee
  on someone who already has an open job. Wrong, slow, and erodes trust.

v3's thesis: **identify first, then branch.** A new caller gets the v2 flow. A known
caller gets a CRM-aware flow with read and (gated) write actions.

---

## 2. Architecture

### 2.1 The identity gate (the linchpin)

Because lead-gen masks numbers, identity can't rely on caller ID alone.

```
Inbound call
   │
   ▼
identifyCaller(phone)                ← silent, by call metadata
   ├─ no match ───────────────► NEW LEAD  → v2 flow (createLead → Review)
   ├─ 1 match (phone only) ───► L1 soft-verified → READ-only answers
   └─ ambiguous / masked ────► ASK name + ZIP/street → identifyCaller(name,zip)
                                   └─ match → confirm name+ZIP → L2 verified
                                              → READ + WRITE (reschedule/cancel)
```

**Verification levels**

| Level | How reached | What it unlocks |
|---|---|---|
| **L0** | no match | New-lead flow only |
| **L1** | matched by phone | Next appointment window, job status phrase, appointment list |
| **L2** | matched + confirmed name AND (ZIP or street) | Reschedule, cancel, job notes, estimate/invoice summaries |

**Never disclosed below L2:** full street address (confirm-only), invoice amounts,
estimate line items, technician personal info, and — always — any other customer's data.

### 2.2 Same secure endpoint

All new tools are added to the existing **`POST /api/vapi-tools`** (x-vapi-secret),
company-scoped to `DEFAULT_COMPANY_ID`, reusing existing services:

| Concern | Existing service to reuse |
|---|---|
| Caller lookup | `leadsService.getLeadByPhone/getLeadsByPhones`, contacts/timelines phone match |
| Jobs & status | `jobsService.listJobs({contactId})`, `getJobById`, `BLANC_STATUSES`, `getJobTransitions` |
| Notes/history | `jobsService.addNote`, `eventService.getEntityHistory` |
| Estimates | `estimatesService.listEstimates/getEstimate` |
| Invoices | `invoicesService.listInvoices/getInvoice` |
| Schedule | `scheduleService.getScheduleItems`, `getAvailableSlots`, `rescheduleItem`, `cancelJob` |

No new data model is required for P1–P2; v3 is mostly a **read/route layer** plus two
guarded writes.

---

## 3. Feature requirements

### FR-C1 — Separate existing customers from new leads
- **Intent:** any inbound call.
- **Behavior:** Run `identifyCaller` before qualifying. If a match exists, greet by name
  and branch to the existing-customer router; do **not** run the new-lead qualification.
- **Tool:** `identifyCaller`.
- **Guardrails:** masked number → ask name + ZIP rather than assume new. Ambiguous match →
  disambiguate before proceeding.
- **Acceptance:**
  - [ ] A caller with an open job is never pushed through new-lead qualification.
  - [ ] A truly new caller still flows to v2 (`createLead → Review`).
  - [ ] Masked-number existing customers are found via name+ZIP within 2 questions.

### FR-C2 — Customer & job information
- **Intent:** "what's going on with my repair?", "do I have anything scheduled?"
- **Behavior:** `getCustomerOverview` for a one-line snapshot, then `getJobStatus` /
  `getAppointments` for specifics. Speak the **status phrase**, not internal codes.
- **Tools:** `getCustomerOverview`, `getJobStatus`, `getAppointments`.
- **Data exposed (L1):** count of open jobs, next appointment window, current status phrase.
- **Acceptance:**
  - [ ] Internal `blanc_status` never read aloud; always mapped via `status_map`.
  - [ ] Multiple open jobs → ask which appliance/service to scope.

### FR-C3 — Distinguish job statuses
- **Behavior:** Map each `BLANC_STATUSES` value to a caller-friendly line (see `status_map`).
  Drive what the bot offers next from the stage (e.g. *Scheduled* → offer reschedule;
  *Enroute* → give ETA; *Waiting for parts* → set expectation; *Done* → offer review/new job).
- **Acceptance:**
  - [ ] Each status yields a correct phrase and a sensible next action.

### FR-C4 — History & notes on a job
- **Intent:** "what did the tech say last time?"
- **Behavior:** `getJobHistory` returns a **summarized**, speech-friendly timeline.
- **Tool:** `getJobHistory` (**L2**).
- **Guardrails:** redact internal-only/technician-private notes; summarize, don't read raw.
- **Acceptance:**
  - [ ] Internal/private notes are never read aloud.
  - [ ] L1 callers are asked to verify before any history is shared.

### FR-C5 — Estimates & invoices (sensitive)
- **Intent:** "how much was my estimate?", "what's my balance?"
- **Behavior:** Spoken **summary** (status, total, balance) + offer to **text a secure link**.
  Never read every line item; never take a card by voice.
- **Tools:** `getEstimateSummary`, `getInvoiceSummary` (**L2**).
- **Guardrails:** payment → secure link or human; balance stated, card details never collected.
- **Acceptance:**
  - [ ] No card/payment capture by voice under any path.
  - [ ] Amounts only after L2 verification.

### FR-C6 — Reschedule
- **Intent:** "can we move my appointment?"
- **Behavior:** Verify L2 → `getAvailableSlots` → offer 2–3 windows (choice-without-choice)
  → confirm → `rescheduleAppointment` (writes via `scheduleService.rescheduleItem`).
- **Tool:** `rescheduleAppointment` (**L2 write**).
- **Guardrails:** confirm old→new before writing; on conflict, offer the next window; log an
  audit note (`AI Phone`).
- **Acceptance:**
  - [ ] No write without explicit confirmation of the new window.
  - [ ] Reschedule appears on the dispatcher schedule immediately.

### FR-C7 — Cancellation (retention-gated)
- **Intent:** "I want to cancel."
- **Behavior (mandatory order):**
  1. **Acknowledge** + **ask the reason** (price, timing, found someone else, fixed itself,
     no longer needed).
  2. **One genuine save attempt** matched to the reason:
     - timing → offer a better/sooner window (reschedule);
     - price → restate the $95-credit and no-full-prepayment protection;
     - found someone → trust/anti-scam framing + soonest slot;
     - fixed itself → offer to keep a note / easy rebook.
  3. Only if they still insist → `cancelAppointment(reason, retentionAttempted=true)`.
- **Tool:** `cancelAppointment` (**L2 write**) → `jobsService.cancelJob` + `addNote(reason)`.
- **Guardrails:** never cancel on first ask; reason is **required**; `retentionAttempted`
  must be true; state any cancellation policy (OQ-V3-2) before writing.
- **Acceptance:**
  - [ ] Exactly one retention attempt before any cancel.
  - [ ] Reason captured on the job note every time.
  - [ ] Cancel reflected in CRM + dispatcher schedule.

### FR-C8 — Scheduled-appointment info
- **Intent:** "when is my appointment / who's coming?"
- **Behavior:** `getAppointments` → state the window and status phrase; offer reschedule if
  *Scheduled*, ETA if *Enroute*. Never promise an exact minute; tech calls/texts before arrival.
- **Tool:** `getAppointments` (**L1**).
- **Acceptance:**
  - [ ] Window stated as a range; ETA framed as "the tech will text before arriving."

---

## 4. Existing-customer conversation router (sketch)

```
Greet (Sara) → listen
   │
   ├─ new repair request ─────────► v2 new-lead flow (createLead → Review)
   │
   └─ sounds like an existing customer / asks about an appointment, status,
      estimate, invoice, reschedule, cancel
          │
          ▼
      identifyCaller (phone, then name+ZIP if needed)
          │  no match → "I don't see you in our system — let's get you set up" → v2
          ▼
      getCustomerOverview → route by intent:
          status?        → getJobStatus / getAppointments         (L1)
          reschedule?    → verify L2 → getAvailableSlots → rescheduleAppointment
          cancel?        → ask reason → ONE save attempt → cancelAppointment (L2)
          estimate/inv?  → verify L2 → getEstimateSummary/getInvoiceSummary → offer text link
          history/notes? → verify L2 → getJobHistory
          → always end with: recap + our number (508-290-4442) + "anything else?"
```

---

## 5. Security & privacy (hard rules for v3)

- Company isolation: every query stays scoped to the company; cross-customer access is a
  P0 defect.
- Verification gates enforced **server-side** in the tool handlers (don't trust the LLM to
  self-gate): READ-sensitive and WRITE tools check a `verified` flag derived from
  `identifyCaller` + confirmation, passed per call.
- No payment capture by voice — ever.
- Address/PII: **confirm, don't disclose** ("is this still the Walpole Street address?"
  → yes/no), never read the full address back unprompted.
- Every write (reschedule/cancel/note) writes an audit note attributing it to `AI Phone`.
- Disqualified/invalid still applies for genuinely new mis-routed leads (carry over v2's
  refund flagging).

---

## 6. Non-functional

- Tool round-trip p95 < 2000 ms (CRM reads can be heavier than v2 — index `contactId` /
  phone lookups).
- Identity lookup must be fast and tolerant (fuzzy name, normalized phone/ZIP).
- All new handlers: graceful degradation — on any error return a safe "let me have a
  teammate follow up" and never expose internals (carry over v2 behavior).

---

## 7. Phasing

| Phase | Tools | Outcome |
|---|---|---|
| **P1 — Identify & Inform** | identifyCaller, getCustomerOverview, getJobStatus, getAppointments | Existing customers recognized; status/appointment questions answered (read-only). |
| **P2 — Self-service changes** | rescheduleAppointment, cancelAppointment | Voice reschedule; retention-gated cancel with reason capture. |
| **P3 — Financial & history** | getJobHistory, getEstimateSummary, getInvoiceSummary | Spoken summaries + text-a-link; no payment by voice. |

Recommended: ship **P1** first (highest value, lowest risk — pure reads), measure
mis-qualification drop and containment, then P2 (writes) once verification is proven.

---

## 8. Out of scope (for now)

- Taking payment by voice.
- Creating estimates/invoices by voice.
- Multi-company / multi-tenant routing (single-company deployment).
- Warm transfer to a live human with context (tracked separately).
- Outbound calls (reminders, follow-ups) — a different assistant type.

---

## 9. Open questions

See YAML `open_questions` (OQ-V3-1…5): verification strength for writes, cancellation
policy/fees, reschedule write-target while Zenbooker is still live, secure-link texting
for estimates/invoices, and whether existing-customer calls ever create a Review lead.
