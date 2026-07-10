# YELP-LEAD-AUTORESPONDER-001 — Behavior Spec (Phase 1a, email-only, backend)

**Status:** Spec
**Related:** requirements `YELP-LEAD-AUTORESPONDER-001`; surrounding flow — `EMAIL-TIMELINE-001` (inbound linking via `linkInboundMessage`), `MAIL-SECRETARY-001`, `EMAIL-001`.
**Feature flag:** `YELP_AUTORESPONDER_ENABLED` (default OFF) + default-company scope for 1a rollout.
**Migration:** `backend/db/migrations/124_yelp_lead_events.sql` (124 = next free at write time; verify/bump at build if a parallel session claimed it).

## 1. Overview
When a Yelp **new-lead** email is ingested, auto-send exactly **one** LLM-personalized greeting back through the Yelp relay **and** create a `JobSource='Yelp'` lead — customer answered in seconds, dispatcher sees a lead, 24/7 unattended. Purely additive to the Mail Secretary; all non-Yelp mail behaves exactly as before.

## 2. Placement in the ingest flow (do not restate EMAIL-TIMELINE-001 / MAIL-SECRETARY-001)
New service `backend/src/services/yelpLeadService.js` → `maybeHandleYelpLead(companyId, msg)`. **Never throws** (fail-open). Hooked in `emailTimelineService.linkInboundMessage`, **after** the outbound/DRAFT guards (~:107) and **before** the mute guard + contact lookup + Mail Secretary handoff. Gated on `!opts.skipAgent`.
- Returns handled → `linkInboundMessage` short-circuits with `{ skipped: 'yelp_lead' }` so Mail Secretary never sees Yelp relay mail (no duplicate task). The lead still surfaces in Pulse via the `lead.created` SSE, not via a Mail-Secretary task.
- Returns not-handled → normal pipeline continues untouched (mute guard, contact lookup, Mail Secretary).
- Internal order: **env/scope gate → detect → CLAIM → parse → createLead → greet → send.**

## 3. Detection truth table (§ R2/R3 — greeting fires for exactly one class)
Both conditions required to greet: `from_email` matches `/@messaging\.yelp\.com$/i` **AND** a first-message signal.

| Class | from_email | First-message signal | Action |
|---|---|---|---|
| **New-lead quote request** | `reply+<hextoken>@messaging.yelp.com` | YES — body `utm_source=request_a_quote_first_message` OR header `"<Name> requested a quote from <Biz> for a <service>."` / `"New quote request"` | **HANDLE** → claim→parse→lead→greet→send; return `skipped:'yelp_lead'` |
| In-thread customer reply | `@messaging.yelp.com` | NO — `utm_source=request_a_quote_new_message`; `"…response to <Biz>"` / `"New Message from <Name>"` | fall through → normal pipeline; **never greeted** (customer's reply must reach dispatcher) |
| Yelp confirmation / no-reply | `no-reply@yelp.com` / `no-reply@notify.yelp.com` | NO — `"Good news! Your request was sent."` | fall through → normal pipeline; **never greeted** |
| Any non-Yelp mail | not `messaging.yelp.com` | n/a | fall through → Mail Secretary as today |

## 4. Parse contract (§ R4 — regex on labeled Q&A + header; fail-safe)
Extract `{ customer_name, service_type, problem_text, zip, reply_to, thread_token, magic_link }`. Real sample: name `"Kim"`, service `"dishwasher repair"`, problem `"Maytag dishwasher stuck in mid cycle"` (brand+appliance+symptom), zip `"02467"`, from `reply+8160b36a…@messaging.yelp.com`.
- **Fail-safe partial:** any missing field = `null`; the lead is **always** still created with a raw-body fallback carried in `Comments`.
- **`reply_to`** = the real relay `From` (`reply+<token>@messaging.yelp.com`); `thread_token` = the hextoken. If a valid `reply+<token>` cannot be recovered → **BAIL the send** (never misroute mail); still create the lead (see S7).

## 5. Claim / idempotency (§ R6/R8 — at-most-once greeting)
New table **`yelp_lead_events`**: `id`, `company_id UUID`, `provider_message_id TEXT`, `thread_token TEXT`, `lead_id`, `greeting_provider_message_id`, `status`, `created_at`, **`UNIQUE(company_id, provider_message_id)`**.
- Claim via `INSERT … ON CONFLICT DO NOTHING RETURNING` **before** greet/send. Row returned = we own this message → proceed. No row (conflict) = already handled → **no-op** (no second greet, no second lead).
- Absorbs the 5-min poll re-scan (contact-less Yelp mail is re-returned forever) and Gmail push history-replay.

## 6. Lead field mapping (§ R7 — `leadsService.createLead(fields, companyId)`, leadsService.js:312; PascalCase FIELD_MAP)
| Parsed source | createLead field | column | Notes |
|---|---|---|---|
| `customer_name` split on first space | `FirstName` / `LastName` | `first_name` / `last_name` | Title-Cased by createLead |
| — (deferred to Phase 1b) | `Phone` | `phone` | `null` in 1a |
| `zip` | `PostalCode` | `postal_code` | |
| derived from `zip`, else `"MA"` | `City` / `State` | `city` / `state` | |
| `service_type` | `JobType` | `job_type` | e.g. `"dishwasher repair"` |
| constant `'Yelp'` | `JobSource` | `job_source` | |
| `problem_text` | `Description` | `lead_notes` | e.g. `"Maytag dishwasher stuck in mid cycle"` |
| `thread_token` + `magic_link` + `reply_to` + raw-body fallback | `Comments` | `comments` | Yelp thread reference / degraded-parse fallback |
| default `'Submitted'` | `Status` | `status` | fires `lead.created` SSE → surfaces in Pulse / LeadsPage, zero frontend work |

Do **not** create a contact from the relay address (`reply+…@messaging.yelp.com` is not the customer).

## 7. Greeting (§ R5)
New `backend/src/services/yelpGreetingService.js` — Gemini (reuse the existing Gemini transport shape, cf. `callSummaryService.js` / `textPolishService.js`) generating a short warm greeting that references the appliance/problem and asks best phone + preferred time, **NO price**. **Static-template fallback** on any Gemini failure/quota (cf. gemini-spend-cap outage). Delivered via `emailService.sendEmail(companyId, { to: reply_to, subject: "Re: <service> request", body })` → Yelp relays it to the customer.

## 8. Scenarios
- **S1 — New lead (happy path).** New-lead email → gate ON → detect HANDLE → CLAIM ok → parse → `createLead` (`JobSource='Yelp'`, `Status='Submitted'`) → Gemini greeting → `sendEmail(to=reply_to)`. Customer receives exactly one greeting **within seconds**; lead appears in Pulse. Returns `skipped:'yelp_lead'`.
- **S2 — Customer reply on thread.** `utm request_a_quote_new_message` / "response to…" → no first-message signal → fall through → normal pipeline; **not greeted, no lead**; reply reaches dispatcher as usual.
- **S3 — Yelp confirmation / no-reply.** `no-reply@…yelp.com`, "Good news! Your request was sent." → fall through; **not greeted, no lead**.
- **S4 — Duplicate ingest (poll re-scan / push replay / same message re-delivered).** Same `provider_message_id` → CLAIM conflict → **no-op**; no second greeting, no second lead.
- **S5 — Gemini down / quota.** Detect HANDLE, lead created, greeting generation fails → **static-template greeting** sent instead; lead still present. If send itself fails after claim → logged, not retried (accepted).
- **S6 — Parse partial / HTML drift.** Some labeled fields missing → those fields `null`, raw body preserved in `Comments`; **lead still created** with available fields; greeting sent if `reply_to` recovered.
- **S7 — `reply+token` absent / mangled.** No valid relay address → **BAIL the send** (never misroute); lead still created from whatever parsed; logged. No greeting.
- **S8 — Env gate OFF / non-default company.** `YELP_AUTORESPONDER_ENABLED` unset or company outside 1a scope → `maybeHandleYelpLead` returns not-handled immediately (no claim, no detect side effects) → normal pipeline. Total no-op.

## 9. Success criterion & safe-fail
- **Success (AC-1/N3):** a real Yelp new-lead email → customer receives **exactly one** greeting within seconds AND a `JobSource='Yelp'` lead with `{name, service, problem, zip}` surfaces in Pulse.
- **Safe-fail (AC-3/R9):** Gemini fail → static greeting; parse fail → partial, lead still created; greeting/send failure **after** claim → logged, not retried (accepted); **any** failure never crashes ingest and never blocks other mail (fail-open, `maybeHandleYelpLead` never throws).

## 10. Data isolation
All reads/writes `company_id`-scoped end-to-end (`companyId` passed from `linkInboundMessage`); the greeting is sent only via that company's own mailbox; `yelp_lead_events` uniqueness is per `company_id`.

## 11. Open edge-cases for Implementer / Tester
1. **Hook file gap:** `backend/src/services/email/emailTimelineService.js` / `linkInboundMessage` is not present in this worktree branch (only `emailService.js` + `emailSyncService.js` exist); the requirements name `emailSyncService.importGmailThread` as the seam. Implementer must reconcile the exact inbound-ingest insertion point while preserving the locked order/guards (after outbound/DRAFT, before mute + contact + Mail Secretary) and the `{ skipped:'yelp_lead' }` short-circuit.
2. **Claim key vs. one-per-thread:** the locked claim is `UNIQUE(company_id, provider_message_id)` (handles poll/replay). To fully guarantee R6 (Yelp allows one reply per **thread**) even if Yelp emits two distinct first-message messages on one `thread_token`, also guard the **send** on `thread_token` (secondary check for an existing greeting on the thread) before dispatch.
3. **Migration number** must be re-verified as the next free integer at build (parallel sessions add migrations).
4. **`reply_to` bail policy:** confirm whether a `reply_to` bail (S7) should still create the lead (spec says yes — dispatcher follow-up) or suppress both; Tester should assert "no misrouted send" as the hard invariant.
5. **City/State derivation:** decide zip→city lookup source; `State='MA'` fallback is acceptable for 1a.
