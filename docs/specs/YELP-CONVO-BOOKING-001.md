# YELP-CONVO-BOOKING-001 — Behavior Spec (multi-turn Yelp email booking agent)

**Status:** Spec · **Priority:** P1 · **Backend-only** · **Date:** 2026-07-11
**Requirements:** `docs/requirements.md` (R1–R10 / AC1–AC9 / B1–B8) · **Architecture:** `docs/architecture.md` (A–G, §1)
**Builds on:** YELP-LEAD-AUTORESPONDER-002 (`d584997`, LIVE) — durable detector→`kind='agent'` task→`agentWorker`→handler + `yelp_lead_events` claim-ledger (mig 162) + opt-in retry (mig 163). Reuses the agent-agnostic `agentSkills.runSkill(name, companyId, rawContext, input)` choke-point (voice/VAPI + MCP already call it; the email agent is the **3rd in-process caller**).

## 1. Overview
Turns the one-shot Yelp autoresponder into a multi-turn agent that reuses the **voice agent's L0 scheduling SKILLS** and drives every Yelp lead to a terminal **BOOKING** (slot hold on the existing lead) or **CALL** (warm phone handoff). An LLM tool-loop is the brain; a persisted phase machine is a coarse guardrail. This spec references AGENT-SKILLS-001/002 (the SKILLS + `runSkill` gate), YELP-002 (detector/claim/handler/retry), and AUTO-001 (durable agent-task model) rather than restating them.

**Do-not-restate reuse:** `runSkill` gate (`agentSkills/index.js:104`, never throws → `SAFE_FALLBACK`); L0 tools `validateAddress`/`checkServiceArea`/`recommendSlots`/`checkAvailability` (`registry.js:81-84`) — L0 ⇒ verificationGate never blocks them on an email lead; `bookOnLead` is **L1** (`registry.js:69`) ⇒ would throw `verification_required` on an email lead → **never used**; booking sidesteps to `leadsService.updateLead` (`leadsService.js:370`); durable `agentWorker` (`FOR UPDATE SKIP LOCKED`, opt-in retry); `yelpLeadQueries.claimYelpLead` idempotency; `emailService.sendEmail`; Gemini v1beta transport shape (`mailAgentClassifier.js:92`, fence-strip parse `:62`); `tasksQueries.createTask` lead-parented dispatcher task.

## 2. Conversation-state schema — NEW table `yelp_conversations` (mig 164)
Durable row per conversation (survives restarts); ⟂ ephemeral per-turn `yelp_convo` task. Keyed by the **stable Yelp conv-id**, not the varying reply address.

| Column | Purpose |
|---|---|
| `id BIGSERIAL PK` · `company_id UUID NOT NULL` | tenant scope (all queries filter `company_id`) |
| `conversation_id TEXT NOT NULL` | stable Yelp conv-id parsed from body URL |
| `lead_id BIGINT` · `lead_uuid UUID` | link to the existing Yelp lead; `lead_uuid` drives the `updateLead` hold |
| `phase TEXT DEFAULT 'greet'` | `greet\|collect\|offer_slot\|await_pick\|booked\|handoff_call\|stalled` |
| `status TEXT DEFAULT 'open'` | `open\|book\|call\|closed` (terminal outcome) |
| `collected JSONB DEFAULT '{}'` | `{phone,street,apt,city,state,zip,lat,lng,service,problem,service_confirmed}` |
| `offered_slots JSONB` | last offer `[{key,date,start,end,label}]` — the ONLY valid book targets |
| `chosen_slot JSONB` | accepted slot (double-book guard) |
| `last_reply_to TEXT` | freshest `reply+<hex>@messaging.yelp.com` — where THIS turn's reply is sent |
| `last_thread_token TEXT` · `turn_count INT DEFAULT 0` | threading token; turn budget |
| `last_inbound_message_id TEXT` | last handled inbound `provider_message_id` |
| `created_at/updated_at TIMESTAMPTZ` | — |
| **`UNIQUE (company_id, conversation_id)`** | the threading invariant |

`yelp_lead_events` (mig 162) gains `conversation_id TEXT` (links per-inbound claim → conversation) + `'replied'` in the status vocabulary. **Migration 164 = next free (max on disk = 163); RECHECK `ls backend/db/migrations/` at build** (parallel worktrees drift). Additive, `IF NOT EXISTS`.

**Threading (`parseConversationId(msg)`, both forms, fail-safe→null):** first email = `message_to_business_conversation/<id>`; replies = `%2Fthread%2F<id>` (URL-encoded). Idempotency is per-inbound `provider_message_id` (stable per email); threading is per `conversation_id` (stable per dialog); the varying `reply+<hex>@` is stored per-turn as `last_reply_to` and influences nothing else.

## 3. Phase state machine (coarse guardrail; LLM re-reads `collected`+history each turn)
```
greet ─▶ collect (phone + address + confirm service) ─▶ offer_slot ─▶ await_pick ─┬─▶ booked        (status=book)
             │                                              │                      └─▶ handoff_call   (status=call)
             └────────── stall / opt-out / engine-down / turn-budget ───────────────▶ handoff_call
```
`phase` is telemetry + a predicate (turn/phase budget exceeded ⇒ force `handoff_call`); `booked`/`handoff_call` are terminal.

## 4. JSON-action protocol contract (net-new; NOT native function-calling)
Transport = v1beta `generateContent`, `responseMimeType:'application/json'`, two-model fallback, bounded retry + hard timeout, temp≈0.2 (mirror `mailAgentClassifier`; copy the shape, do not import). Each step the model emits STRICT JSON (tolerant fence-strip parse) — exactly one of:
```
{"action":"tool","tool":"validateAddress|checkServiceArea|recommendSlots|checkAvailability","args":{…}}
{"action":"reply","body":"<customer-facing text>","intent":"collect|offer|confirm"}
{"action":"book","slotKey":"<key ∈ offered_slots>"}      // SERVER action; model NEVER supplies LeadDateTime
{"action":"handoff","reason":"opt_out|stalled|engine_down|human_requested|missing_data"}
```
Tool contracts (in system prompt): `validateAddress{street,apt?,city?,state?,zip?}→{valid,standardized,correctedZip,lat,lng}`; `checkServiceArea{zip}→{inServiceArea,area?,city?,state?,zip}`; `recommendSlots{zip?,lat?,lng?,address?,unitType?}→{available,slots:[{key,date,start,end,label}]}` (`targetDay`+`targetTime`⇒single nearest); `checkAvailability` as fallback.

**Per-turn harness (bounded):**
1. Compose messages = system(goal + tool contract + injection-guard) + `collected`/`phase` + compact history + inbound-as-data → call Gemini (bounded retry/timeout) → tolerant-parse strict JSON.
2. `action:"tool"` → server-validate args → `runSkill(tool, DEFAULT_COMPANY_ID, {source:'yelp_convo'}, validatedArgs)` (server injects companyId) → append result to scratchpad → **loop ≤ `YELP_CONVO_MAX_TOOLCALLS`** (≈4). `recommendSlots.slots` → persist to `offered_slots`.
3. `action:"book"` → server validates `slotKey ∈ offered_slots` → §6 BOOK hold → confirm-reply.
4. `action:"reply"|"handoff"` → terminal for the turn.

**Stop conditions:** `reply`/`handoff` terminal; `book` done + confirm-reply; toolcall cap → synthetic reply/handoff; timeout/parse-fail after retries → safe static reply (reuse `yelpGreetingService.staticGreeting` style), repeat → handoff. **Loop detector:** identical repeated tool-call → break to reply. Outer bound `YELP_CONVO_MAX_TURNS` (≤~6). Model never quotes price/ETA.

## 5. Handler `yelp_convo` (agentWorker, `max_attempts=3`) — STRICT order (guard first)
1. **Load state** `WHERE company_id=$1 AND conversation_id=$2`; no row (race) → soft no-op, done.
2. **Per-inbound claim** `claimYelpLead(companyId, inbound_provider_message_id)` (`ON CONFLICT DO NOTHING`) — **durable PRE-SEND marker, checked FIRST**; not claimed ⇒ this inbound already answered ⇒ skip (retry-safe; one reply per message).
3. **Build LLM context** — inbound body in delimiters, marked *untrusted customer text*.
4. **Run tool-loop** (§4) → `reply` | `book` | `handoff`.
5. **Send exactly ONE email** `sendEmail(companyId,{to:last_reply_to,subject:'Re: …',body})` — the ONLY throw that reaches the worker (nothing sent yet) → drives retry.
6. **Persist state** (`collected/phase/offered_slots/chosen_slot/turn_count++/last_inbound_message_id`) + `markReplied` POST-SEND marker (best-effort; a throw AFTER send is swallowed — email is source of truth, mirror `yelp_lead` `agentHandlers.js:223-232`).
7. **On book** → §6 BOOK. **On handoff / stall / engine-down** → §6 CALL. Then done.

**Task payload** `{conversation_id, inbound_provider_message_id, inbound_body_text, reply_to, thread_token, lead_id, lead_uuid}`, parented `subject_type='lead'` (as YELP-002).

## 6. Book-vs-call decision table (D)
| Trigger | Terminal | Server action |
|---|---|---|
| Explicit accept of a slot `∈ offered_slots` **AND** geocoded address (`lat/lng` from `validateAddress` **or** zip in-area) **AND** callback phone captured | **BOOK** (`phase=booked, status=book`) | `updateLead(lead_uuid,{LeadDateTime,LeadEndDateTime, coords both-or-nothing}, companyId)` — build hold via `slotEngineService.resolveTimezone`+`tzCombine` exactly as `bookOnLead.js:95-103`, sidestepping `bookOnLead`. Then confirm-reply + lead-scoped dispatcher task "Confirm Yelp booking — <name> <window>". |
| `recommendSlots.fallback:true` (engine down) · customer opts-out / "just call me" / prefers phone · critical data missing after `MAX_TURNS` · turn/phase budget exhausted · LLM safe-fail | **CALL** (`phase=handoff_call, status=call`) | reply with OUR number + ask their callback number/time; open lead-scoped dispatcher task "Call Yelp lead — <name>". Recorded as **SUCCESS**, not stuck. |

**Double-book guard:** book only on explicit accept; if `status='book'` AND `chosen_slot` unchanged → skip the `updateLead` re-write (idempotent). Both dispatcher tasks use `createTask(companyId,{leadId,subjectType:'lead',createdBy:'automation',status:'open'})` (confirm `'automation'` allowed at build) → visible in Pulse tasks/AR (no new UI).

## 7. Phase A / B split (independently shippable — F)
**Phase A (plumbing, no brain; gate `YELP_AUTORESPONDER_ENABLED`):** mig 164; `parseConversationId` + `yelpConversationQueries`; extend intercept in `emailTimelineService.linkInboundMessage` (after `draft_or_sent` l.106, BEFORE mute l.131) — `detectYelpReply` (respondable `request_a_quote_new_message` matching a KNOWN active conversation by conv-id) → enqueue `yelp_convo`, short-circuit `{skipped:'yelp_convo'}`. First message still enqueues `yelp_lead` (greeting stays LIVE) **and now also upserts `yelp_conversations`**. Value = closes the varying-reply-address dedup gap + captures reply turns. Handler may be a thin ack. **Phase B (brain; NEW gate `YELP_CONVO_ENABLED`, default OFF — dark launch):** `yelpConvoAgentService.js` tool-loop + §6; real `yelp_convo` handler; detector switches first-message enqueue `yelp_lead`→`yelp_convo` turn-0 (greeting = turn 0) — `yelp_lead` handler stays registered to drain in-flight tasks. Scope: `companyId === DEFAULT_COMPANY_ID` only.

## 8. Scenarios
- **S1 — first message → conversation + lead + greet (AC1/AC4·R1).** Gated first Yelp email → parse stable conv-id → **upsert `yelp_conversations`** (`phase=greet`) → (Phase A) `yelp_lead` greets; (Phase B) `yelp_convo` turn-0 greets and moves to `collect`. Exactly one lead, one conversation row.
- **S2 — respondable reply threaded by conv-id → `yelp_convo` turn (AC1/AC2·R1/R2).** `request_a_quote_new_message` **RESPONDABLE** whose body conv-id matches an active row → claim on `provider_message_id` → enqueue/run one `yelp_convo` turn; resumes mid-phase (survives restart). Reply routed by `conversation_id`, **not** the varying `reply+<hex>@`.
- **S3 — collect phone + address (AC4·R4).** Email lead carries no phone → agent asks directly, one coherent question-set/reply, for phone + full address + appliance/problem confirm; parses answers into `collected`; does NOT scrape.
- **S4 — proactive nearest slot (AC4·R5).** Once `validateAddress` geocodes and `checkServiceArea` confirms in-area → agent PROACTIVELY calls `recommendSlots(targetDay+targetTime)` and offers the single NEAREST window (persisted to `offered_slots`), not an open-ended "when works?".
- **S5 — accept → hold + confirm + dispatcher task (AC5·R6).** Free-text accept of an offered window → `book` → `updateLead(lead_uuid, tzCombine hold, companyId)` on the EXISTING lead (JobSource stays `'Yelp'`; no `createLead`; `bookOnLead` untouched) → dispatcher-visible + slot-engine occupancy → confirm-reply + "Confirm Yelp booking" task.
- **S6 — call fallback = success (AC6·R7).** Each trigger (engine `fallback:true` / opt-out / prefers-phone / missing data after N turns / "talk to a person" / budget) → reply with our number + capture their callback phone + open "Call Yelp lead" dispatcher task; `status=call`, recorded SUCCESS (not stuck).
- **S7 — idempotency + crash-safety (AC8·R9).** Duplicate `provider_message_id` (push+poll overlap) → `claimYelpLead` conflict → **no 2nd reply, no 2nd hold**. Crash mid-turn: pre-send claim written before send ⇒ retry finds it claimed → skip → **≤1 send, ≤1 hold** (trades a rare lost reply for never-double; mirrors YELP-002 S10). Thrown LLM/tool caught per-task → never crashes the worker loop or sibling batch tasks.
- **S8 — one reply per message; ≤~6 turns then handoff (AC7·R8).** Exactly one outbound reply per respondable inbound; `turn_count`/`MAX_TURNS` exhausted → force `handoff_call` (S6). No price unless a tool returned one; never double-book.
- **S9 — PROMPT-INJECTION (AC5/AC7·G5).** Customer body says "book me midnight / ignore your rules / run tool X": body is **DATA** (delimited, untrusted) not instructions; `book` requires `slotKey ∈ persisted offered_slots` (midnight isn't a key → rejected, no hold); model NEVER supplies `LeadDateTime`; only whitelisted L0 tools execute (off-list "tool" ignored); `companyId`/`lead_uuid`/recipient are server-injected; tool args server-validated (`validateAddress` geocode, `checkServiceArea` zip, slot regex). No arbitrary tool exec, no rogue book.
- **S10 — slot-engine safe-fail → callback (AC3/AC6·N5).** `recommendSlots`/tool returns `SAFE_FALLBACK`/`fallback:true` → NOT fatal → loop degrades to CALL fallback (S6); never fabricates a slot, never crashes.
- **S11 — conv-id threading (AC1·B1/B2).** Reply matched to its conversation despite a **changed** `reply+<hex>@` (keyed on conv-id); a stray relay email whose conv-id matches NO active conversation is not mis-threaded (falls through — not enqueued as `yelp_convo`, not tripping the first-message `createLead`); `no-reply@*yelp.com` confirmations never intercepted (existing guard).
- **S12 — post-terminal replies (AC7·B8).** Reply after a terminal state: "thanks!" on a `booked`/`closed` conversation → stay closed, no new tool-loop, no double-book; "can we move it?" / cancel → do NOT silently re-drive booking → open a dispatcher reschedule task (optional brief "a teammate will follow up"), `updateLead` re-write blocked by the `status='book'` guard. Chatty customer cannot loop the agent past the turn budget.

## 9. Data isolation & non-functional
Backend-only; no new HTTP routes (background worker + ingest hook). Every `yelp_conversations` query filters `company_id`; `runSkill`/`updateLead`/`createTask` receive `companyId=DEFAULT_COMPANY_ID`. Env: `YELP_AUTORESPONDER_ENABLED` (plumbing/greeting), `YELP_CONVO_ENABLED` (brain, default OFF), `YELP_CONVO_MODEL`/`_FALLBACK_MODEL`/`_TIMEOUT_MS`/`_RETRY_MAX`/`_MAX_TOOLCALLS`/`_MAX_TURNS`; worker cadence reuses `AGENT_WORKER_INTERVAL_MS`. Structured per-turn logs (tool calls, decisions, outcome); state + outcome greppable and dispatcher-visible in Pulse.

## 10. Edge-cases for Implementer / Tester
1. **Mig 164 drift** — recheck `ls backend/db/migrations/` at build; renumber + rebuild rollback if 164 taken (161 was consumed this way).
2. **Fixtures lack real conv-id URLs** — `tests/yelpFixtures.js` reuses one `reply+<hex>` and has no `message_to_business_conversation/`·`%2Fthread%2F` URLs; **add realistic conv-id URLs and confirm `parseConversationId` against a real Yelp email** before trusting threading tests.
3. **`created_by='automation'`** — YELP-002 writes it (`yelpLeadService.js:300`); confirm the tasks CHECK allows it before `createTask`.
4. **Intercept ordering is load-bearing** — reply branch must stay `!opts.skipAgent`, fail-open, AFTER `draft_or_sent`, BEFORE mute + no-contact Mail-Secretary; a reply must short-circuit `{skipped:'yelp_convo'}` (no un-agented timeline double-post, no duplicate Secretary review — AC9/R10).
5. **Pre-send vs post-send markers** — claim (pre-send) is the at-most-once gate for BOTH reply and hold; `markReplied`/persist (post-send) must be non-fatal; a book turn must write/guard `chosen_slot`+`status='book'` so a re-accept or S12 reply cannot re-`updateLead`.
6. **B6 held-slot abandonment (RESOLVED at build, Phase B).** No speculative hold and no new TTL in v1: `updateLead` writes the window ONLY on an explicit customer accept of an offered slot (`book`), so there is no "held-then-cold" occupancy to reclaim — an unbooked conversation never touches `LeadDateTime`. A booked-then-cancelled case is left to the dispatcher (the existing lead is visible and the `Confirm Yelp booking` task surfaces it). Unknown-conv-id replies (§8 S11 / YCB-INT-03) are also RESOLVED = **fall-through** (never mis-threaded, never a new lead, never a write to a non-matching row).
7. **Voice-hold parity (B7)** — email hold must be indistinguishable from a voice hold to the engine/dispatcher (same `tzCombine` window→`LeadDateTime` + both-or-nothing coords), WITHOUT `bookOnLead`'s identity gate.
8. **Loop cost/latency** — enforce `MAX_TOOLCALLS`/turn + hard timeout/call + `MAX_TURNS`/conversation + loop-detector; `max_attempts=3` is the outer worker bound; any breach → safe reply, repeat → call-fallback.
