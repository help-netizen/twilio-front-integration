# Spec: AGENT-SKILLS-002 — Existing-customer relaxation, take-latest identity, lead-aware overview + book-on-lead

**Increment on AGENT-SKILLS-001** (the shipped provider-neutral CRM skill layer for the voice agent Sara). This spec changes four things in the existing layer; it does **not** re-architect it. Everything below cites the real code it modifies.

- **Base spec:** `docs/specs/AGENT-SKILLS-001.md` (§2 gate, §3 identity, §4 per-skill, §9 P0 invariants, §10 edges).
- **Base architecture:** `docs/architecture.md` §AGENT-SKILLS-001.
- **Files touched:** `backend/src/services/agentSkills/identityResolver.js`, `.../registry.js`, `.../skills/getCustomerOverview.js` (+ optionally `getJobStatus.js`, `getAppointments.js`), a NEW `.../skills/bookOnLead.js`, `backend/src/services/agentSkillsMcpRegistry.js`, `voice-agent/assistants/lead-qualifier-v2.json`. Reused unchanged: `leadsService.updateLead` / `createLead` / `getLeadByContact`, `slotEngineService.tzCombine` / `resolveTimezone`, `jobsService.getJobById` / `listJobs`, `verificationGate`, `index.runSkill`.
- **Migrations: NONE.** Confirmed on disk — see §5.

## 0. The four changes (owner-decided), in one line each

1. **Identity take-latest** — on the PHONE path, >1 distinct contact resolves to the MOST-RECENT contact (`contacts.created_at DESC`), with a name+(zip|street) preference; `ambiguous` survives ONLY on the name path with equal matches. The phone path never dead-ends.
2. **Verification relaxation** — the eight existing-customer skills drop from **L2 → L1**. A phone- **or** name+zip-identified caller is served without a second name+ZIP re-confirmation. name+zip stays an *identification* path, not a *gate*. P0 invariants (company isolation, per-`contactId` ownership pre-check, cancel retention, no card by voice) are untouched.
3. **Lead-aware existing customers + `bookOnLead`** — `getCustomerOverview` (and `getJobStatus`) surface the contact's open lead(s) and any proposed slot; a NEW `bookOnLead` skill writes a chosen slot as a schedule-blocking HOLD onto the contact's EXISTING open lead (UPDATE, never a duplicate), falling back to `createLead` when there is no open lead.
4. **Prompt redesign** — phone-identify → greet → serve directly; route existing-customer intents including the new book-on-lead path; drop the "confirm name + ZIP before any C/D/E" friction; keep cancel retention, no-card, confirm-don't-disclose-address.

---

## 1. Change 1 — Identity resolver: take-latest on the phone path

**File:** `backend/src/services/agentSkills/identityResolver.js`. **Function:** `resolve` (the multi-match block at lines ~356–379) plus the two phone-bridge queries (`bridgePhoneToContacts` ~177, `contactsFromJobsByPhone` ~202).

### 1.1 The problem today
`resolveByPhone` unions the lead-getter contact + `bridgePhoneToContacts` + `contactsFromJobsByPhone`, dedupes by id, and if `candidates.length > 1` (after an optional `contactId` pin) returns `matchType:'ambiguous'`. On a shared/rotated phone this **dead-ends** the caller into an L0 disambiguation loop — the owner does not want this.

### 1.2 The take-latest algorithm (phone path only)
Change the resolution so a phone-path multi-match resolves deterministically. Introduce a source-tagged candidate and a `created_at` on each candidate so the resolver can rank.

**(a) Fetch `created_at` (and keep it flowing).** Add `c.created_at` to the two contact-bridge SELECTs and carry it on the candidate object:

- `bridgePhoneToContacts` SELECT list becomes `c.id, c.full_name, c.first_name, c.last_name, c.created_at` (column confirmed present — `backend/db/schema.sql` contacts: `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`; `contactsService.js:35` maps `created_at: row.created_at`).
- `contactsFromJobsByPhone` SELECT list adds `c.created_at` (already a `SELECT DISTINCT c.id, ...` — add the column; `DISTINCT` over the extra column is fine because a contact's `created_at` is constant per id).
- The lead-getter candidate (from `getLeadByPhone`, which returns a `rowToLead` with **no** `created_at`) is tagged `createdAt: null`. A `null` `created_at` sorts **oldest** (least-preferred) so a lead-only echo never beats a real contact row; if it is the *only* candidate the single-candidate path already handles it.
- `dedupeById` keeps the **first-seen** entry per id — union order is lead-getter, then `byContact`, then `byJob`; the merged record should carry a `createdAt` if ANY source had one (prefer the contact-sourced value). Simplest correct rule: when merging duplicates, keep the max non-null `created_at` seen for that id.

**(b) Rank when >1 (after the existing `contactId` pin).** Replace the `candidates.length > 1 → ambiguous` block *for the phone path* with a **deterministic pick**:

1. **Claim pin (unchanged, first):** if `claims.contactId` matches a candidate id, that single candidate wins (already implemented lines ~360–364 — keep verbatim, it runs before ranking).
2. **Name+address preference:** if the caller supplied `name` AND (`zip` OR `street`), prefer the same-phone candidate whose stored record matches name + (zip OR street). Reuse the existing corroboration primitives: for each candidate build its record via `buildContactRecord(companyId, candidate)` and test `nameMatchesRecord && (zipInRecord || streetInRecord)` using the SAME normalization the gate/L2 path uses (`nameMatches`-equivalent on `candidate.name` vs the claimed `name`; `record.zips.includes(normalizeZip(zip))`; `record.streets.some(containment)`). If **exactly one** candidate matches name+(zip|street) → pick it. If **several** match, fall through to (3) among the matching subset. (Do the record-builds lazily/short-circuit to bound cost: only build records when name+addr were supplied AND there is a tie to break.)
3. **Most-recent fallback:** pick the candidate with the greatest `created_at` (DESC). Ties on `created_at` (or all-null) break by **greatest `id`** (a monotonic proxy for "most recently created"), so the result is always deterministic and never throws.

The chosen single candidate then flows into the EXISTING `matchType:'existing'` tail (build `buildContactRecord`, return `contactId/customerName/matchedPhone/contact`). The gate then computes L1 (phone match) or L2 (if the caller also confirmed name+zip/street) exactly as today — **no gate change needed for take-latest**; the resolver simply stops returning `ambiguous` on the phone path.

### 1.3 When `ambiguous` still applies
`ambiguous` is preserved ONLY for the **name path** (`resolveByNameAndAddress`, when there is no usable phone): if name+(zip|street) corroborates **>1** distinct contact with no phone signal to disambiguate, keep returning `matchType:'ambiguous'` with `ambiguousCount`. Rationale: a name-only multi-match has no "most recent contact by phone-ownership" semantics — picking latest there could serve the wrong person with only a shared name+ZIP, so the safe behavior (ask for more) stays. The phone path is the one the owner said "must never dead-end."

> Concretely: move the `if (candidates.length > 1) → ambiguous` decision so it is reached only when the candidates came from `resolveByNameAndAddress` (Path B) AND no usable `last10` was present. Path A (a real phone) always resolves to a single contact via §1.2.

### 1.4 Company isolation (unchanged, re-affirmed)
Every query in the resolver stays `company_id = $2`-scoped (the `created_at` column is additive to the existing `WHERE c.company_id = $2` predicates). A cross-company phone twin still returns `new`. The take-latest ranking operates only within the already-company-scoped candidate set. This preserves AGENT-SKILLS-001 §9.1 verbatim.

### 1.5 Edge cases (identity)
| # | Situation | Behavior |
|---|---|---|
| I1 | Phone → 2+ contacts, no name/addr given | Pick most-recent by `created_at` (id tiebreak). `matchType:'existing'` at L1. |
| I2 | Phone → 2+ contacts, caller gave name+zip matching exactly one | Pick that one (name+addr preference), even if it is not the newest. |
| I3 | Phone → 2+ contacts, name+zip matches two of them | Among the matching two, pick most-recent. |
| I4 | Phone → 2+ contacts, `contactId` claim matches one | Claim pin wins first (existing behavior, unchanged). |
| I5 | Name path (no phone) → 2+ contacts corroborated | **`ambiguous`** (unchanged) — force disambiguation. |
| I6 | Phone → exactly 1 contact | Unchanged single-candidate path. |
| I7 | Shared phone, most-recent contact is NOT the caller | **Accepted tradeoff (owner):** caller is served the most-recent contact's data. Documented for the reviewer in §6. |
| I8 | `created_at` NULL on the only phone candidate (lead-getter echo w/ no contact row) | Single-candidate path; no ranking needed. |
| I9 | DB error mid-resolve | Fail-closed to `new` (existing try/catch, unchanged). |

---

## 2. Change 2 — Verification relaxation: eight skills L2 → L1

**File:** `backend/src/services/agentSkills/registry.js` (the `SKILLS` array). **No logic change** — only the `requiredLevel` field per entry. The gate, choke-point, and each skill's ownership pre-check are unchanged; lowering the required level simply lets an L1 (identified) caller through the same `assert`.

### 2.1 The exact level-change table

| Skill | kind | OLD `requiredLevel` | NEW `requiredLevel` | Notes |
|---|---|---|---|---|
| `identifyCaller` | read | L0 | **L0** (unchanged) | Still derives the level. |
| `getCustomerOverview` | read | L1 | **L1** (unchanged) | Already L1. |
| `getJobStatus` | read | L1 | **L1** (unchanged) | Already L1. |
| `getAppointments` | read | L1 | **L1** (unchanged) | Already L1. |
| `getJobHistory` | read | **L2** | **L1** | Sensitive-read relaxed. |
| `getEstimateSummary` | read | **L2** | **L1** | **FLAGGED**: financial summary; owner may re-tighten (§6). |
| `getInvoiceSummary` | read | **L2** | **L1** | **FLAGGED**: financial summary; owner may re-tighten (§6). |
| `rescheduleAppointment` | write | **L2** | **L1** | Write; ownership pre-check unchanged. |
| `cancelAppointment` | write | **L2** | **L1** | Write; retention gate + ownership unchanged. |
| `bookOnLead` (NEW, §3) | write | — | **L1** | Ownership: lead must belong to identified contact + company. |
| 5 legacy tools | — | L0 | **L0** (unchanged) | Never block the call. |

Net: `getJobHistory`, `getEstimateSummary`, `getInvoiceSummary`, `rescheduleAppointment`, `cancelAppointment` change **L2 → L1**; the three already-L1 reads and `identifyCaller`/legacy stay. That is the owner's "identified by phone or name+zip → serve, hide nothing" instruction.

### 2.2 What "L1 is enough" means precisely
- **L1 is produced** when the resolver returns `existing` via ANY single-contact path — a phone match (now including a take-latest pick, §1) OR a name+(zip|street) corroboration that resolves to exactly one contact. Both yield `contactId` → the gate returns **at least** L1 (`verificationGate.deriveLevel` lines ~168–190).
- **L2 still exists** and is still *computed* (phone/identity + confirmed name AND zip|street). No skill *requires* it after this change, but the level is still surfaced (e.g. `identifyCaller.verificationLevel`) and MAY gate a future re-tightened financial read. Do **not** delete the L2 derivation.
- **name+zip becomes an identification path, not a gate:** a caller with a masked/absent phone can still reach L1 by giving name+zip (that is `resolveByNameAndAddress` → single contact → L1). The prompt (§4) asks for name+zip **only** in that no-phone/insurance case, never as a blanket pre-condition.

### 2.3 P0 invariants that MUST remain (non-negotiable)
Lowering the level changes the *entry bar*, nothing else. These stay exactly as in AGENT-SKILLS-001 and must be re-verified green:

1. **Company isolation** — every reused-service call scoped to `companyId` (unchanged in every skill).
2. **Ownership pre-check** — a read/write only touches the identified `verifiedContext.contactId`'s own job/lead. `rescheduleAppointment`/`cancelAppointment` still do `getJobById(jobId, companyId)` then `String(job.contact_id) === String(verifiedContactId)` BEFORE any mutation (rescheduleAppointment.js:174–182, cancelAppointment.js:108–117). `bookOnLead` does the analogous lead-ownership check (§3.4). A cross-contact/cross-company entity → safe refusal, no write.
3. **Cancel retention** — `retentionGate` (reason required + `retentionAttempted === true`, one save attempt) unchanged (cancelAppointment.js:62–69).
4. **No card by voice** — unchanged; estimate/invoice summaries still offer a secure link only.

Because L1 (not L0) is still required for these five skills, an unidentified L0 caller still gets the soft `needsVerification` shape — the relaxation only removes the **L1→L2 step-up**, it does not open anything to an unresolved caller.

### 2.4 Reviewer tradeoff note (carried into the spec body)
On a **shared phone**, take-latest (§1) means an L1 caller is served the **most-recent contact's** jobs/leads/estimates/invoices/appointments — and, post-relaxation, can reschedule/cancel that contact's appointment and read its history/financials at L1. This is **acceptable per the owner** ("identified by phone → hide nothing"). The residual risk is narrow (same physical phone line, multiple household/business contacts). Financial summaries are explicitly flagged (§6) so the owner can re-pin `getEstimateSummary`/`getInvoiceSummary` to L2 with a one-line registry revert if desired.

---

## 3. Change 3 — Lead-aware overview + the `bookOnLead` skill

### 3.1 The real-code surprise that shapes this
`leadsService.getLeadByContact(contactId, companyId)` returns the newest OPEN lead (`status NOT IN ('Lost','Converted')`) **but SUPPRESSES it when the contact has ANY job** (leadsService.js:1190–1196 — `SELECT 1 FROM jobs WHERE contact_id = $1 LIMIT 1`, and note that suppression check is **not** company-scoped). That is the exact "contact with both a lead and jobs" case the owner wants surfaced. **Therefore the overview CANNOT reuse `getLeadByContact` for surfacing** — it would hide the lead precisely when a job also exists.

**Decision:** add a small **non-suppressing, company-scoped** lead read used only for surfacing, and reuse `getLeadByContact`'s "open" definition (`status NOT IN ('Lost','Converted')`). Two implementation options — pick one in the task plan:

- **(3.1-A) preferred:** add `leadsService.getOpenLeadsByContact(contactId, companyId)` → returns ALL open leads for the contact (company-scoped, `ORDER BY lead_date_time DESC NULLS LAST, id DESC`), as `rowToLead` shapes, with **no** job-suppression. Newest-open-first; caller picks `[0]` as "the" open lead but has the full list for the multi-lead edge.
- **(3.1-B) minimal:** a direct company-scoped query inside `getCustomerOverview` (`SELECT ... FROM leads WHERE contact_id=$1 AND company_id=$2 AND status NOT IN ('Lost','Converted') ORDER BY lead_date_time DESC NULLS LAST, id DESC`). Simpler but duplicates SQL. Prefer 3.1-A so `bookOnLead` reuses the same read.

"Open lead" = `status NOT IN ('Lost','Converted')` (the shipped terminal set; matches `getLeadByContact`/`getLeadsByPhones`/`listLeads only_open`). Do not invent a new status set.

### 3.2 `getCustomerOverview` — surface open leads
**File:** `backend/src/services/agentSkills/skills/getCustomerOverview.js`. Additive to the existing output; existing fields (`openJobsCount`, `nextAppointment`, `lastJobStatus`, `hasOpenEstimate`, `hasUnpaidInvoice`, `speak`) stay.

**New fields:**
```jsonc
{
  // ... existing fields ...
  "hasOpenLead": true,                       // boolean: contact has ≥1 open lead
  "openLeadStatus": "string(phrase) | null", // caller-friendly lead-status phrase (see 3.2.1)
  "leadProposedWindow": "string | null",     // the lead's held slot window, if LeadDateTime set (see 3.2.2)
  "openLeadCount": 2                          // integer, for the multi-lead edge (optional but recommended)
}
```

**Derivation:**
1. Query the contact's open leads via §3.1's non-suppressing read (company-scoped). `hasOpenLead = openLeads.length > 0`; `openLeadCount = openLeads.length`.
2. Pick "the" lead = `openLeads[0]` (newest by `lead_date_time DESC NULLS LAST, id DESC`).
3. `openLeadStatus` = caller-friendly phrase for `openLeads[0].Status` (§3.2.1).
4. `leadProposedWindow` = if `openLeads[0].LeadDateTime` is set, format it (+ `LeadEndDateTime`) with the SAME `formatWindow(startIso, endIso)` already in this file (lines ~54–68). `rowToLead` returns `LeadDateTime`/`LeadEndDateTime` as ISO strings (leadsService.js:54–55), so `formatWindow` consumes them directly. Null when no proposed slot.

**Why it matters:** an existing customer whose ONLY record is a pending lead (a submitted request, or a MAIL-AGENT/insurance-email lead with no job yet) is now recognized with real state instead of `openJobsCount:0` → "no jobs." The `speak` composition (below) must reflect the lead.

#### 3.2.1 Lead-status → caller phrase
There is no `statusMap` for lead statuses (statusMap is job `blanc_status` only). Add a tiny local map in the skill (mirror the `CLOSED_ESTIMATE_STATUSES` style — a small object, not a new module):
| Lead `Status` | Caller phrase |
|---|---|
| `Submitted` / `New` / `Review` | "we have your request in" |
| `Scheduled` / has `LeadDateTime` | "you're penciled in for {window}" (window from 3.2.2) |
| anything else non-terminal | "your request is in progress" |
Never read the raw status token aloud. Terminal statuses (`Lost`/`Converted`) never appear (the read excludes them).

#### 3.2.2 Proposed-slot window
`leadProposedWindow` uses `formatWindow(LeadDateTime, LeadEndDateTime)` — a RANGE ("Tuesday between 10 AM and 12 PM"), never an exact minute, consistent with the job path. This is the VAPI-SLOT-ENGINE-001 hold surfaced back to the caller.

#### 3.2.3 `speak` composition (updated)
The current `speak` branches on `openJobsCount`. Extend so a contact with **no open jobs but an open lead** speaks its lead state instead of "no jobs":
- `openJobsCount === 0 && hasOpenLead`:
  - with `leadProposedWindow`: `"I see your request — you're penciled in for {leadProposedWindow}. Want me to lock that in?"` (routes to `bookOnLead` confirm).
  - without a window: `"I see your request is in — {openLeadStatus}. Want me to find you a time?"` (routes to recommendSlots → `bookOnLead`).
- `openJobsCount === 0 && !hasOpenLead`: unchanged ("I don't see any open jobs … book?").
- `openJobsCount >= 1`: unchanged job-centric branches (jobs take precedence in the spoken line; `hasOpenLead` still returned in the object so the agent can offer to book on the lead if the caller asks).

Isolation unchanged: every query scoped to `companyId` + `verifiedContext.contactId`.

### 3.3 `getJobStatus` / `getAppointments` — lead awareness (scoped)
- **`getJobStatus`** (recommended): when `jobs.length === 0`, instead of the flat "no open job" refusal, check the same open-lead read; if a lead exists, return an `ok` shape whose `speak` reflects the lead state ("I don't see an open repair yet, but I have your request — {openLeadStatus}{, penciled in for window}. Want me to get you booked?"). This keeps a lead-only existing customer from hearing "nothing on file." Keep it a **refusal-free** informative shape; do not fabricate a `jobId`.
- **`getAppointments`** (optional, lower priority): when there are no job appointments but the lead carries a `LeadDateTime`, it MAY surface the held window as a "tentative, not yet confirmed" line. Keep it clearly distinct from a booked job appointment (a lead hold is not a confirmed visit). If ambiguous to phrase safely, leave `getAppointments` job-only (defer) — the overview already surfaces the lead. Task plan marks this optional.

### 3.4 NEW skill — `bookOnLead` (write, L1)
**File:** `backend/src/services/agentSkills/skills/bookOnLead.js`. **Purpose:** the identified existing customer with an open lead picks a slot (from `recommendSlots`, or confirms the lead's already-proposed slot); write it as a **schedule-blocking HOLD on the EXISTING lead** (LeadDateTime/LeadEndDateTime + Latitude/Longitude), reusing `createLead`'s slot-persist logic as an **UPDATE**. Dispatcher later converts lead→job (unchanged flow). If the contact has NO open lead → create a fresh lead (fall back to `createLead`).

#### 3.4.1 Input
```jsonc
{
  // identity block (phone/name/zip/street/contactId) — claims, ignored for scoping
  "chosenSlot": { "date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM" }, // required, from recommendSlots
  "lat": 42.357,   // optional; written only if lat AND lng both finite
  "lng": -71.059,  // optional
  // fallback-create fields (used ONLY when the contact has no open lead):
  "firstName": "string?", "lastName": "string?", "phone": "string?", "email": "string?",
  "street": "string?", "apt": "string?", "zip": "string?", "city": "string?", "state": "string?",
  "unitType": "string?", "problemDescription": "string?"
}
```
`chosenSlot` shape/validation is IDENTICAL to `createLead`'s (`/^\d{4}-\d{2}-\d{2}$/`, `/^\d{1,2}:\d{2}$/`) and `rescheduleAppointment.isConfirmedSlot` — reuse that guard. A malformed/absent `chosenSlot` → soft refusal ("let's lock a window first"), never a write.

#### 3.4.2 Output (resultShapes)
```jsonc
{ "ok": true, "success": true, "bookedWindow": "Tuesday between 10 AM and 12 PM", "leadId": "…", "created": false, "speak": "You're all set — I've got you down for Tuesday between 10 and 12. A dispatcher will confirm shortly." }
```
`created:false` = updated the existing lead; `created:true` = fell back to a new lead. On failure → `resultShapes.refusal(...)` ("let me have a teammate lock that in") — never a false success.

#### 3.4.3 The update-vs-create rule + persist reuse (the core)
```
run(companyId, verifiedContext, input):
  contactId = verifiedContext.contactId            // server-verified; never input
  if !companyId or contactId == null → refusal (defensive; gate guarantees L1)
  if !isConfirmedSlot(input.chosenSlot) → refusal("lock a window first", { needsConfirmation:true })

  // Build the slot-hold body EXACTLY as createLead does (REUSE, not reinvent):
  tz = await slotEngineService.resolveTimezone(companyId)
  hold = {
    LeadDateTime:    slotEngineService.tzCombine(chosenSlot.date, chosenSlot.start, tz),
    LeadEndDateTime: slotEngineService.tzCombine(chosenSlot.date, chosenSlot.end,   tz),
    ...(Number.isFinite(lat) && Number.isFinite(lng) ? { Latitude: lat, Longitude: lng } : {}),
  }
  // (wrap the tzCombine in try/catch identical to createLead.js:110–117 — a slot-compose
  //  fault must not 500; on fault → refusal, no write.)

  // OWNERSHIP + branch: find THIS contact's open lead, company-scoped.
  openLeads = await leadsService.getOpenLeadsByContact(contactId, companyId)   // §3.1-A, non-suppressing
  if openLeads.length >= 1:
      lead = openLeads[0]                          // newest open (lead_date_time DESC, id DESC)
      // Ownership is inherent: the read is scoped to (contactId, companyId); the returned
      // lead's ContactId === contactId by construction. (Defensive re-assert allowed.)
      await leadsService.updateLead(lead.UUID, hold, companyId)   // ← REUSE updateLead
      created = false; leadId = lead.UUID
  else:
      // No open lead → fresh lead via the SAME createLead slot-persist path.
      // Delegate to the createLead SKILL with chosenSlot+lat+lng+identity/booking fields,
      // so the exact createLead body-mapping (phone guard, JobSource 'AI Phone',
      // chosenSlot→LeadDateTime, retry) is reused verbatim — no duplication.
      res = await createLeadSkill.run(companyId, verifiedContext, { ...input })  // input already carries chosenSlot/lat/lng
      if !res.success → refusal
      created = true; leadId = res.leadId

  bookedWindow = windowPhrase(chosenSlot)          // reuse rescheduleAppointment.windowPhrase or a local range formatter
  // Optional audit parity with other writes (recommended, non-fatal if it throws):
  try { eventService.logEvent(companyId, 'lead', <leadId-or-numeric>, 'lead_slot_held',
        { window: bookedWindow, actor: 'AI Phone', created }, 'system') } catch {}
  return resultShapes.ok(`You're all set — I've got you down for ${bookedWindow}. A dispatcher will confirm shortly.`,
                         { success:true, bookedWindow, leadId, created })
```

**Why `updateLead` is the right reuse:** `updateLead(uuid, fields, companyId)` maps `LeadDateTime/LeadEndDateTime/Latitude/Longitude` through the SAME `FIELD_MAP` (leadsService.js:131–163) that `createLead` uses, is **company-scoped** (`WHERE uuid=$… AND company_id=$…`, lines 421–425), and runs FSM validation **only when `columns.status` is set** (lines 389–405) — a slot-only update carries no `status`, so it bypasses FSM entirely and cannot be blocked. It emits a `lead.updated` event only on a status change (line 439) — a slot-only update is silent, which is correct (no badge churn). **No new leadsService function is required for the update itself** — the only new leadsService helper is the non-suppressing *read* `getOpenLeadsByContact` (§3.1-A).

#### 3.4.4 Ownership check (P0)
The lead-ownership guarantee is satisfied structurally: `getOpenLeadsByContact(contactId, companyId)` returns only leads where `contact_id = contactId AND company_id = companyId`, so `updateLead` targets a lead the identified contact owns in the identified company. A defensive re-assert (`String(lead.ContactId) === String(contactId)` before update) is allowed and cheap. There is **no jobId** in this flow, so there is no cross-job trap; the analogue of the `getJobById` pre-check is the company+contact-scoped lead read. A contact with an open lead in ANOTHER company is invisible (company-scoped) → falls to the create branch, which itself writes under `companyId`.

#### 3.4.5 Registry + adapters
- **`registry.js`:** add `{ name: 'bookOnLead', kind: 'write', requiredLevel: 'L1', run: lazyRun('bookOnLead') }`.
- **`vapi-tools.js`:** **no dispatch change** — the adapter is generic (`name = toolCall.function?.name` → `runSkill`; vapi-tools.js:103,119). `bookOnLead` MUST **not** be added to `LEGACY_TOOLS` — that set only *excludes* skills from the silent caller-ID injection (vapi-tools.js:43–48; `buildSkillInput`). `bookOnLead` is a NEW identity-aware skill and SHOULD receive the silent phone like the other new skills, so leaving it out of `LEGACY_TOOLS` is exactly right.
- **`agentSkillsMcpRegistry.js`:** add a WRITE tool `svc.book_on_lead` → `skill:'bookOnLead'`, `requiredLevel:'L1'`, `kind:'write'` (so `requiresConfirmation:true`, `requiredPermission:'service.crm.write'` via `normalizeTool`). Input schema = identity block + `chosen_slot` (reuse `newPreferredSlotSchema()` shape: `{date,start,end}` required) + optional `lat`/`lng` + the fallback-create fields. This keeps the MCP `svc.*` surface at parity with the VAPI surface (AC-10 equivalence).

#### 3.4.6 `bookOnLead` edge cases
| # | Situation | Behavior |
|---|---|---|
| B1 | Contact has 1 open lead | UPDATE that lead's hold; `created:false`. |
| B2 | Contact has 0 open leads | Fall back to `createLead` skill; `created:true`. |
| B3 | Contact has >1 open lead | UPDATE the newest (`lead_date_time DESC, id DESC`). Do not create a new one. (Overview's `openLeadCount>1` lets the agent scope first if it wants; default = newest.) |
| B4 | Lead already has a `LeadDateTime` (a prior hold) | UPDATE overwrites with the newly-confirmed slot (re-hold). Idempotent-ish; the latest confirmed window wins. |
| B5 | Malformed/absent `chosenSlot` | Soft refusal, no write. |
| B6 | `tzCombine` throws (bad tz/slot) | try/catch → refusal, no write (mirrors createLead.js:110–117). |
| B7 | `updateLead` throws (LEAD_NOT_FOUND / DB) | Caught by the skill → `resultShapes.refusal`; the choke-point also backstops to SAFE_FALLBACK. Never a false success. |
| B8 | lat/lng only one finite | Neither written (both-or-nothing, like createLead.js:106). |
| B9 | Cross-company/cross-contact lead | Invisible to the scoped read → create branch (writes under the caller's own company). No foreign lead is ever mutated. |
| B10 | Insurance/no-phone caller, identified by name+zip → L1, has an email-origin open lead | The scoped read finds it (leads carry `contact_id`); UPDATE the hold. This is the insurance path the owner described. |

---

## 4. Change 4 — Prompt redesign (existing-customer branch)

**File:** `voice-agent/assistants/lead-qualifier-v2.json` — the single `system` message (`model.messages[0].content`) + `model.tools[]`. The **live** assistant `30e85a87` is a SEPARATE owner-consent-gated REST PATCH (get-first; CLI `update` panics; re-inject `VAPI_TOOLS_SECRET` into every `model.tools[].server`; keep `answerOnBridge="true"`) — the repo JSON is edited here; the live push is a deploy-gated task.

### 4.1 Tools array
Add ONE tool-def `bookOnLead` (same `{ type:'function', server:{ url:'https://api.albusto.com/api/vapi-tools', secret:'REPLACE_WITH_VAPI_TOOLS_SECRET' }, function:{ name, description, parameters } }` shape as the existing 14). Parameters: `chosenSlot` (object `{date,start,end}`, required — description: "the window the caller confirmed, taken from a window recommendSlots offered"), optional `lat`/`lng` (from validateAddress), and optional booking fields for the no-lead fallback. Tools count 14 → 15.

### 4.2 Identify/branch step (§ lines 6–13 today)
Keep "GREET, then IDENTIFY → silently call `identifyCaller`." Update the branch table:
- `matchType "existing"` → greet by first name → **[Existing Customer]** (unchanged intent, but that section is rewritten below).
- `matchType "ambiguous"` → still ask name+ZIP then re-call `identifyCaller` — **but** note this now fires **only** on the name-path multi-match (phone multi-match auto-resolves take-latest server-side, §1.3); the prompt text can stay as-is (it is already correct for the ambiguous case).
- `matchType "new"` / no usable match → new-lead flow (unchanged).

### 4.3 Rewritten [Existing Customer] section (replaces today's lines 40–55)
Structure:

- **Header:** "known customers asking about their existing work OR wanting to book a time we already proposed. You never pass an account or contact id — the account is resolved from the call on the server. **You do NOT need to re-confirm their name and ZIP to look things up** — being identified is enough."
- **A) STATUS / general** → `getCustomerOverview`. Now: "It tells you open jobs AND whether they have an open request (lead) and any time we've penciled in. If they have only a pending request and no job, say so warmly and offer to book." (No name+ZIP step.)
- **B) APPOINTMENTS** → `getAppointments` (unchanged) + offer reschedule.
- **C) BOOK ON AN EXISTING REQUEST (NEW path)** → for an existing customer whose overview shows `hasOpenLead` and who wants to book:
  - If the overview already returned `leadProposedWindow`, confirm it directly: "We had you penciled in for {window} — want me to lock that in?" On yes → `bookOnLead` with that `chosenSlot`.
  - Else call `recommendSlots` (pass ZIP or lat/lng), offer the top 2–3 windows, and on confirm → `bookOnLead` with the chosen `{date,start,end}`. If `bookOnLead` returns `created:true` it just means it started a fresh request — still confirm the window. Never pass a jobId here (this is a lead, not a job).
- **D) RESCHEDULE** → `recommendSlots` → `rescheduleAppointment` (jobId + confirmed `newPreferredSlot`). **Remove** the "FIRST confirm full name AND ZIP" precondition — being identified is enough. Keep: confirm the new window before writing; handle `conflict:true` (offer next window). (needsVerification should now be rare — it only appears for an L0/unidentified caller.)
- **E) CANCEL** → **unchanged retention discipline** (reason + exactly ONE save attempt + `retentionAttempted=true`), but **remove** the "confirm full name + ZIP" precondition. Keep "cancel is free before the visit"; keep capturing the real reason; keep `needsReason`/`retentionRequired` handling.
- **F) ESTIMATE / INVOICE / HISTORY** → `getEstimateSummary` / `getInvoiceSummary` / `getJobHistory` directly (now L1). **Remove** "FIRST confirm full name AND ZIP." Keep: give the summary, offer a secure link, **NEVER read estimate line items or a full address aloud, NEVER take a card by voice** (these hard privacy rules stay verbatim).
- **Insurance / no-phone identify:** NEW short paragraph: "If the caller's number didn't match (matchType new) but they say they already have a request in — e.g. an insurance job or a request we took by email — ask for the name and ZIP, call `identifyCaller` again with name+zip to pull them up, then find their request with `getCustomerOverview` and book it with `bookOnLead`." This is the ONLY place name+ZIP is solicited for an existing customer.
- **Replace the "Verification discipline (all of C/D/E)" block (line 53):** the old text ("collect and CONFIRM full name and ZIP before any reschedule/cancel/estimate/invoice/history, pass them every time") is now obsolete and MUST be removed. Replace with: "Being identified from the call is enough to look things up and to reschedule, cancel, or read a summary — you do NOT ask for name+ZIP again. Only when the number didn't match (a masked line, or an insurance/email request) do you ask for name+ZIP to identify. Confirm, don't disclose: to check identity casually, ask 'is this still the Walpole Street address?' — never read the full address back. If a skill returns needsVerification, the caller isn't identified yet — get name+ZIP and retry. Never disclose amounts or a full address to an unidentified caller, and never take a card by voice."
- **Close** (unchanged): brief recap + number (508-290-4442) + "Anything else?"

### 4.4 What the prompt keeps (non-negotiable, restated in-prompt)
Cancel retention; no card/payment by voice; confirm-don't-disclose full address; never read estimate line items; never read internal status codes (use the friendly phrases). These are also enforced server-side, so a prompt regression cannot breach them.

---

## 5. Migrations — NONE (confirmed)

- **`contacts.created_at`** (Change 1) — **exists.** `backend/db/schema.sql` contacts: `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`; consumed today by `contactsService.js:35` (`created_at: row.created_at`) and `platformCompanyService` ordering. The resolver only needs to SELECT it — no DDL.
- **Lead hold columns** (Change 3) — **exist.** `backend/db/migrations/004_create_leads.sql:45–46` define `lead_date_time TIMESTAMPTZ`, `lead_end_date_time TIMESTAMPTZ` (+ `latitude`/`longitude`), with `idx_leads_lead_date_time`. `updateLead`/`createLead` already map them via `FIELD_MAP`.
- **`leads.contact_id`, `idx_leads_contact_id`** — exist (used by `getLeadByContact`).
- Highest migration on disk = **155** (`155_backfill_outbound_email_links.sql`); AGENT-SKILLS-001 §12 already states "max on disk = 155, migrations NONE." AGENT-SKILLS-002 adds no table, column, or index. **State in the PR: no migration.** A phone/`created_at` expression index is a *follow-up only* if load-test p95 proves the take-latest ranking hot (it operates on an already-tiny same-phone candidate set, so this is unlikely).

---

## 6. Open items carried to the owner (defaults applied)

1. **Financial summaries at L1 (FLAGGED).** `getEstimateSummary`/`getInvoiceSummary` drop to L1 per the owner's "hide nothing." If the owner later wants amounts to need name+ZIP, re-pin those two registry entries to `requiredLevel:'L2'` — a two-line revert, no other change (the L2 derivation is retained). Default applied: **L1**.
2. **Shared-phone take-latest tradeoff.** Documented (§1.5 I7, §2.4). Default applied: **serve most-recent contact.** Owner may request an id-tiebreak change or a "confirm which account" prompt for shared lines later.
3. **`getAppointments` lead-hold surfacing (§3.3).** Default applied: **defer** (overview already surfaces the lead; a lead hold is not a confirmed visit and is easy to misphrase). Owner may opt in.
4. **`bookOnLead` on >1 open lead (B3).** Default applied: **UPDATE newest**. Owner may prefer an explicit "which request?" scope.
5. **Prod deploy + live VAPI PATCH** remain owner-consent-gated (standing rule).

---

## 7. Verification bar

Reuse the AGENT-SKILLS-001 harnesses; the 5 legacy tools + all existing skills MUST stay green.
- **Jest:** extend `tests/agentSkillsIdentity.test.js` (take-latest cases; **update** `ASK-SKILL-ID-04` which currently asserts phone-multi-match → `ambiguous` — it must now assert take-latest, while a NEW name-path case keeps `ambiguous`), `tests/agentSkillsGate.test.js` (L1 now unlocks the five formerly-L2 skills; an L0 caller still refused), `tests/agentSkillsReadSkills.test.js` (overview lead fields), `tests/agentSkillsWriteSkills.test.js` (`bookOnLead` update-vs-create + ownership), `tests/agentSkillsMcp.test.js` (`svc.book_on_lead` present + gated), `tests/agentSkillsSensitiveReads.test.js` (history/estimate/invoice now pass at L1). Worktree runs need `--testPathIgnorePatterns "/node_modules/"` (project gotcha).
- **Golden:** `tests/agentSkills/golden/golden.json` is the 5 legacy tools — **must not change** (byte-for-byte). `bookOnLead` reusing the `createLead` skill for the no-lead branch must not alter `createLead`'s own output shape.
- **Real-DB pass (not mocked-only):** per the LIST-PAGINATION-001 / created_by-FK lessons, run the REAL take-latest resolve, the REAL `bookOnLead` UPDATE (assert `lead_date_time`/`lead_end_date_time`/`latitude`/`longitude` actually persisted on the existing lead, no duplicate row created) and the REAL fallback-create, against a prod-DB copy. Extend `scripts/verify-agent-skills-001.js` or add `scripts/verify-agent-skills-002.js` (same Module._load ZB-stub harness) to exercise both adapters (VAPI envelope + MCP JSON-RPC) end-to-end for the new skill and the relaxed levels.
