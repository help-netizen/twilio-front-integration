# MAIL-MUTE-001 — excluding a sender in Mail Secretary also mutes that sender's EMAIL signal in the Pulse timeline (email channel only; calls/SMS unaffected)

**Status:** Spec (ready for TestCases/Planner) · **Priority:** P1 · **Date:** 2026-07-05
**Area:** Mail Secretary mute verdict (backend service) · inbound-email link path · Pulse unified-list SQL
**Type:** feature — backend-only. **No migration. No new endpoint. No new user-facing list, input type, or settings field.**
**Depends on:** MAIL-AGENT-001 (mig 152 — `mail_agent_settings.exclusion_rules`, `mailAgentRules` DSL, `matchEmail`), EMAIL-TIMELINE-001 / EMAIL-OUTBOUND-001 / CONTACT-EMAIL-MERGE-001 / EMAIL-LEAD-ORIGIN-001 (email as a first-class Pulse citizen, `email_by_contact` CTE), LIST-PAGINATION-001 (`getUnifiedTimelinePage`).
**Follows precedent:** PULSE-PERF-001 (do NOT reintroduce Seq Scan/per-row regex in the hot list query; EXPLAIN on a prod copy), ONBOARD-FIX-001 / ZB-ISO-001 (company scoping), MAIL-AGENT-001 ("never throw from the email link pipeline").

---

## Problem

Adding a sender to the Mail Secretary exclusion list today only stops **task creation**. `mailAgentService.reviewInboundEmail` returns `{verdict:'skipped_excluded'}` on a `from:` match, but that verdict **only gates the task** — the inbound email is **still linked** to the sender's contact timeline: it flips the timeline **unread** and **bumps it to the top** of the Pulse list. Vendor / no-reply senders (e.g. `customerservice@relyhome.com` → timeline `/pulse/timeline/2915`) therefore keep cluttering the Pulse list even though the operator has explicitly said "ignore this sender."

This feature **widens what an exclusion match means**: a `from:`-matched inbound email now also contributes nothing to Pulse — no link, no unread, no bump, no list surfacing — **in addition to** today's "no task," while leaving **calls and SMS untouched** (channel-specific) and staying per-company and reversible. The existing `mail_agent_settings.exclusion_rules` list is the **single source of truth**; there is no separate "muted senders" list.

---

## Binding design (from the Architect — this spec encodes it faithfully)

- **Migration-free, param-passing (decision (a)).** No schema. The Pulse-list route parses the `from:` mutes out of the already-~60s-cached Mail Secretary settings into `mutedEmails[]` + `mutedDomains[]` per request and passes them as query params; `getUnifiedTimelinePage` computes a per-row `email_muted` scalar and gates the email terms with `AND NOT email_muted`. Un-excluding a sender simply drops it from the next request's set — zero cleanup, inherently reversible. **Latest migration in repo = 155; 156 stays unused by this feature.**
- **DECISION-B — only `from:`-derived mutes affect Pulse.** Only mutes derived from exclusion rules whose **every token targets `field==='from'`** drive muting (both the ingestion skip AND the list suppression). Rules that match on `subject`/`body`/`any` — or **mixed** lines like `from:X subject:Y` — keep **today's** behavior (suppress the *task* only; the email still links & surfaces). Same-line negation is honored verbatim by `matchEmail` (a `from:` hit rescued by a `-from:` on the same line is NOT muted).
- **Reuse `matchEmail`, do not fork matching (C-2).** The mute verdict is the exact `.excluded` result of the existing `mailAgentRules.matchEmail` over the **from-only** rule subset. No new match engine, no divergent DSL logic.
- **Fail-open (FR-10).** Any parse/settings/DB failure in the mute check → behaves as today (email links & surfaces). Muting is best-effort clutter reduction, never a delivery or data-loss risk.
- **Gated on Mail Secretary being active (C-4).** Mute semantics apply only when the `mail-secretary` marketplace app is connected/enabled and `mail_agent_settings.enabled` for the company (the reused `getActiveState` returns inactive otherwise → nothing muted).

---

## Two internal contracts (no new HTTP endpoint)

There is **no new API route** and **no change to any response shape**. `GET /api/calls/by-contact` keeps its existing envelope, middleware (`authenticate, requireCompanyAccess`), and `callsRead`/`pulse.view` permission gate; rows may simply be **fewer** when senders are muted. Two **internal** signatures change / are added.

### Contract 1 — `mailAgentService.isSenderMuted(companyId, msg) → Promise<boolean>` — NEW (ingestion side)

- **Input:** `companyId` (the ingestion company), `msg` (normalized inbound message: `from_name`, `from_email`, `subject`, `body_text`, `provider_message_id`).
- **Behavior:** reads the **cached** settings via `getActiveState` (NFR-2 — no extra DB read per email); returns `false` immediately when Mail Secretary is not active (C-4). Filters the parsed rule set to **from-only** rules (`fromOnlyRules(parsed)` — keep only `rules[i]` where `tokens.every(t => t.field === 'from')`), then runs `matchEmail({ rules: fromOnly }, buildRuleInput(msg))` and returns `.excluded`. The `from` surface is composed by the existing `buildRuleInput` (`"${from_name} <${from_email}>"`), byte-identical to the task path.
- **Full-DSL from-only support:** because it delegates to `matchEmail`, it honors `/regex/i` `from:` tokens, quoted strings, and same-line negation exactly as the operator sees for tasks.
- **Fail-open:** any throw → `false` (FR-10).
- **Returns:** `true` ⇒ the sender is `from:`-muted for this company; `false` otherwise (including inactive, no from-only rule, or error).

### Contract 2 — `mailAgentService.getMutedSenderSet(companyId) → Promise<{ emails: string[], domains: string[] }>` — NEW (list side)

- **Input:** `companyId`.
- **Behavior:** reads the same cached settings; returns `{ emails: [], domains: [] }` when inactive (C-4) or on any parse error (fail-open, FR-10). Takes the **from-only** rule subset and extracts **literal** `from:` `contains` tokens that are **not negated** (`kind === 'contains' && !negate`) into:
  - **`emails`** — token value that contains an `@` with a `.` after it → treated as a full address; lower-cased (values are already lower-cased at parse time).
  - **`domains`** — token value starting with `@`, or a bare `host.tld` with no local-part → normalized to the bare domain (`@` stripped), lower-cased.
- **Deliberately NOT projected into the set:** `/regex/i` `from:` tokens and **negated** tokens (the SQL path can only do exact-address / exact-domain membership — see the v1 limitation in **OQ-MM-4** below). These still mute new inbound via `isSenderMuted`, but do not retro-hide an existing thread from the list.
- **Returns:** the tiny per-company `{emails, domains}` used as SQL params `$4`/`$5`.

### Contract 3 — `getUnifiedTimelinePage({ ..., mutedEmails = [], mutedDomains = [] })` — CHANGED (two new optional params)

- **New params:** `mutedEmails` (text[], `$4`) and `mutedDomains` (text[], `$5`), both **defaulted to `[]`** so every existing caller (LIST-PAGINATION-001's sync callers, etc.) is byte-for-byte unaffected — an empty set makes `email_muted` always false → **zero behavior change when nothing is muted**.
- **Only the Pulse-sidebar caller** (`GET /api/calls/by-contact`) passes non-empty values; all other callers pass nothing and get today's behavior.
- **Response/return shape unchanged:** the same row shape as today (`COUNT(*) OVER()` total, ordering fields, `any_unread`, etc.). The page still returns ≤ `limit` rows; suppressed email-only rows simply never enter the window or the count.

---

## Behavior scenarios

Each scenario lists **Preconditions → Steps → Expected / side-effects** and maps to acceptance criteria (AC-n) and functional requirements (FR-n) below.

### S1 — Mute a vendor no-reply (email-only sender) → new inbound does not link, does not surface

- **Preconditions:** Mail Secretary is active for company A. Operator has `from:customerservice@relyhome.com` (or the domain form `from:relyhome.com` / `from:@relyhome.com`) on a line whose **only** token is that `from:` (from-only line). A fresh inbound email arrives from `customerservice@relyhome.com`.
- **Steps:**
  1. The provider push/poll calls `emailTimelineService.linkInboundMessage(companyId, msg)`.
  2. After the `no_message` / `outbound` / `draft_or_sent` guards and **before** `findEmailContact`, the new guard calls `mailAgentService.isSenderMuted(companyId, msg)`.
  3. `isSenderMuted` reads cached active settings, filters to the from-only line, `matchEmail` returns `.excluded = true`.
- **Expected / side-effects:** `linkInboundMessage` returns **`{ skipped: 'muted_sender' }`** immediately. **No** link row is written for this email; **no** unread flip (`markContactUnread` / `markTimelineUnread` not reached); **no** Pulse bump; **no** SSE unread/thread broadcast. Callers treat `{skipped:*}` as "no side effects" (parity with existing skips). Historical `email_messages` / `email_threads` rows are **not** touched (FR-9). (FR-2, AC-1)

### S2 — Existing email-only timeline (relyhome / 2915) drops out of the Pulse list while muted

- **Preconditions:** company A already has the relyhome timeline `2915` (contact's only email = `customerservice@relyhome.com`, **no phone**, no call/SMS/open-task/`has_unread` signal). Operator adds the from-only mute (S1's rule). Operator opens `/pulse`.
- **Steps:**
  1. `GET /api/calls/by-contact` computes `companyId = req.companyFilter?.company_id`, then calls `getMutedSenderSet(companyId)` → `{ emails:['customerservice@relyhome.com'], domains:[] }` (or `{emails:[], domains:['relyhome.com']}` for the domain form).
  2. It passes `mutedEmails`/`mutedDomains` into `getUnifiedTimelinePage`.
  3. For the relyhome row, `email_muted` evaluates **true** (`lower(co.email) = ANY($4)` or `split_part(lower(co.email),'@',2) = ANY($5)`, also checked against `contact_emails.email_normalized`).
  4. The surfacing predicate's email term (`OR eml.email_thread_id IS NOT NULL`) is gated with `AND NOT email_muted`; the row has **no** call/SMS/task/unread signal → it fails the surfacing predicate entirely.
- **Expected:** timeline `2915` **does not appear** in the Pulse list (it never enters the window or `total_count`, so pagination stays ≤ limit). Opening `/pulse/timeline/2915` **directly** still renders the retained thread in the detail view (data is not deleted — FR-9). (FR-4, FR-5, AC-2)

### S3 — Un-exclude restores both link-on-inbound and list surfacing

- **Preconditions:** S2 state, timeline `2915` hidden. Operator removes the `from:` rule from `exclusion_rules` and saves (PUT /settings fires `invalidateCache`).
- **Steps:** within the ~60s settings cache window (typically the next uncached read), `isSenderMuted` → `false` and `getMutedSenderSet` → `{emails:[],domains:[]}`. New inbound from relyhome links normally; the next `/pulse` load computes `email_muted = false` for the relyhome row.
- **Expected:** future relyhome emails link, flip unread, and bump as before; the **retained** `2915` email rows again satisfy the surfacing predicate → the timeline **reappears** in the list (no cleanup, no re-import). (FR-6, AC-6, resolves OQ-MM-3)

### S4 — Channel split: phone+email contact, email muted → call/SMS still surface & bump; email does not

- **Preconditions:** company A has a contact with **both** a phone (`phone_e164` set) and an email at a muted address (`customerservice@relyhome.com` in `contacts.email` or `contact_emails`). The from-only mute is active. The contact's timeline is currently in the list.
- **Steps & Expected (list-ordering, exact):**
  1. **A new muted email arrives** → S1 applies: it does **not** link, does **not** flip unread, does **not** bump. In `getUnifiedTimelinePage`, `email_muted = true` for this contact, so: (a) the `eml.last_message_at` term is dropped from `last_interaction_at` (`GREATEST(latest_call.started_at, sms.last_message_at, CASE WHEN NOT email_muted THEN eml.last_message_at END)`), so the email does **not** move the row up; (b) `eml.unread_count > 0` is dropped from `any_unread` (`… OR (COALESCE(eml.unread_count,0) > 0 AND NOT email_muted) …`), so the email does **not** raise the row into the unread tier. The row remains ranked purely by its **call/SMS/open-task/has_unread** signals.
  2. **A new inbound CALL arrives** → `latest_call` is **untouched** by this feature: `last_interaction_at` picks up `latest_call.started_at`, `tl.has_unread` / call unread behave exactly as today → the timeline **surfaces and bumps to the top** normally.
  3. **A new inbound SMS arrives** → the `sms` lateral is **untouched**: `sms.last_message_at` feeds `last_interaction_at`, `sms.has_unread` feeds `any_unread` → the timeline **surfaces and bumps** normally.
- **Net:** for a phone+email contact, muting removes only the **email** clutter; the contact still ranks and rises on calls and SMS. (FR-4, FR-5, AC-3)

### S5 — Email-only muted contact drops out entirely (already covered as S2's shape, restated for the tester)

- **Preconditions:** a muted contact whose **only** signal is email (no phone, no call/SMS/open-task/`has_unread`).
- **Expected:** `email_muted = true` + gated surfacing predicate ⇒ the timeline is absent from the list while muted; reappears on un-mute (S3). This is the email-only drop-out case that motivates gating the **surfacing predicate** (l.549), not just the ordering terms. (FR-5, AC-2)

### S6 — Redelivery / duplicate of a muted email → still no link, no contact, dedup intact

- **Preconditions:** a muted sender's email is delivered twice (provider redelivery, or push+poll overlap).
- **Steps:** each delivery hits `linkInboundMessage`; the new mute guard returns `{skipped:'muted_sender'}` **before** the provider-message-id dedup and before contact lookup.
- **Expected:** neither delivery links, flips unread, or creates a contact; dedup is **unweakened** (the early return precedes it and never mutates state). No duplicate side effects. (FR-8, AC-5)

### S7 — Muted first-time (unknown) sender → NO contact auto-created (agent create path never reached)

- **Preconditions:** the from-only mute matches a sender who has **no** contact yet. Mail Secretary's `create_contact_for_unknown` is on.
- **Steps:** `linkInboundMessage` reaches the new guard (which is gated on `!opts.skipAgent`, so it evaluates on the primary call). `isSenderMuted` → true → returns `{skipped:'muted_sender'}` **before** the `no_contact` branch (l.112–127) that calls `reviewInboundEmail(..., {noContact:true})` — the ONLY agent entry that can hit `create_contact_for_unknown` → `createEmailContact`.
- **Expected:** the muted first-time sender **never materializes** a contact or timeline (else the timeline would reappear). This early return is the load-bearing guarantee (strictly earlier than `skipped_excluded`, which also happens to block creation for the full-DSL exclusion). (FR-3, AC-4)

### S8 — Multi-tenant isolation: mute in company A never suppresses email in company B

- **Preconditions:** company A has `from:relyhome.com` muted; company B does **not**. Both have relyhome email traffic.
- **Steps:** `getMutedSenderSet` is called with each request's own `companyId` (parsed from that company's `mail_agent_settings`). The SQL `email_muted` only ever evaluates on rows already `WHERE tl.company_id = $1`. `isSenderMuted` is called with the ingestion `companyId`.
- **Expected:** company A's relyhome timelines are muted; company B's relyhome timelines **link and surface normally**. No cross-tenant read or suppression. (FR-7, AC-7)

### S9 — Fail-open on mute evaluation (link time OR list time) → behaves as today

- **Preconditions:** the settings row is malformed, absent, or a DB/parse error is thrown while evaluating the mute.
- **Steps / Expected:**
  - **Link time:** `isSenderMuted` catches and returns `false` → `linkInboundMessage` proceeds down its normal path → the email **links, flips unread, bumps** as today. No throw escapes the pipeline (MAIL-AGENT-001 contract preserved).
  - **List time:** `getMutedSenderSet` catches and returns `{emails:[],domains:[]}` → `email_muted` is always false → the list **surfaces email as today**. The Pulse page never errors or drops rows due to a mute failure.
- **Expected:** muting failure is invisible and non-destructive — never a dropped email, never a 500. (FR-10, NFR-3)

### S10 — Negation / mixed-line DSL: mute follows `matchEmail` and the from-only filter exactly

- **Preconditions:** three rule lines exist:
  - **(a)** `from:notifications@github.com -from:security` — a from-only line with a same-line `-from:` negation.
  - **(b)** `from:relyhome.com subject:invoice` — a **mixed** line (from + subject).
  - **(c)** `subject:unsubscribe` — a subject-only line.
- **Steps / Expected:**
  - **(a)** An email from `notifications@github.com` whose subject contains "security alert" but whose **from** contains `security`? The negation is on `from:`, so `-from:security` rescues only when the *from* text matches `security` — for a normal github notification (`from` has no "security"), the line matches → **muted** at link time. If the from address itself contained `security`, `-from:security` rescues it → **not muted**. Mute follows `matchEmail`'s final `.excluded` verbatim (C-2); no divergent mute logic. Because line (a) is **from-only**, its literal address `notifications@github.com` is **also** projected into `getMutedSenderSet.emails` (list suppression applies).
  - **(b)** Line (b) is **mixed** (from + subject) → excluded from the mute subset entirely by `fromOnlyRules`. It keeps **today's** behavior: it can still gate the **task** (via the full-DSL `reviewInboundEmail`), but the email **still links and surfaces** in Pulse — it does **not** mute. `relyhome.com` from line (b) is **not** projected into the muted set.
  - **(c)** Line (c) is subject-only → not from-only → no mute; task-only behavior unchanged.
- **Expected:** only from-only lines mute; negation on a from-only line is honored; mixed/subject/body lines are task-only. (DECISION-B, FR-1, C-2)

### S11 — Interplay with the agent: muted ⇒ no task AND no timeline; subject/body exclusion ⇒ task suppressed but email still appears

- **Preconditions:** two senders: **(x)** matched by a from-only rule; **(y)** matched only by a `subject:`/`body:`/`any` (or mixed) rule.
- **Expected:**
  - **(x)** from-only muted → `linkInboundMessage` returns `{skipped:'muted_sender'}` before the agent's link-path review AND before the no-contact review → **no task, no link, no unread, no contact, no timeline surfacing**.
  - **(y)** subject/body/any/mixed excluded → **today's behavior unchanged**: `reviewInboundEmail` returns `skipped_excluded` (**no task**), but `linkInboundMessage` still links the email → the **email appears** in Pulse (surfaces/bumps/unreads) exactly as before this feature.
- **Expected:** the two exclusion outcomes are cleanly separated by DECISION-B. (DECISION-B, FR-1, FR-2)

### S12 — Contact with multiple emails where only ONE is muted → **the contact is muted** (address-in-set rule)

- **Preconditions:** a contact has two emails, `a@vendor.com` (muted via `from:vendor.com` or `from:a@vendor.com`) and `b@personal.com` (not muted). The contact's Pulse email thread is the `email_by_contact`-collapsed most-recent thread for that contact.
- **Rule chosen (stated so the tester and implementer agree):** `email_muted` is **true** if **ANY** of the contact's addresses (its `contacts.email` OR any `contact_emails.email_normalized`) is in the muted `emails` set OR its domain is in the muted `domains` set. There is **no** per-thread "which address produced this thread" resolution — the `email_by_contact` CTE has already collapsed the contact to a single most-recent thread, and no address column is carried on that collapsed row in the hot query. So a contact with **any** muted address has its **email contribution suppressed** in the list.
  - **Rationale:** (1) it is the simplest defensible rule that stays cheap in the hot query (a set-membership over the contact's addresses, no regex, no extra join beyond the existing `contact_emails(contact_id)` PK-indexed EXISTS); (2) it matches the operator's intent — "ignore this sender" — since the muted address belongs to that contact; (3) it never over-hides another **contact** (the mute is keyed on *this* contact's own addresses).
  - **Consequence (documented, accepted for v1):** if a genuinely-wanted email arrives at `b@personal.com` for a contact who *also* carries a muted `a@vendor.com` address, that contact's email signal is suppressed in the list while the vendor address remains muted. The remedy is operator-side (don't attach an actively-used personal address to the same contact as a muted vendor address, or un-mute). This is an intentional simplicity trade for v1; a per-address thread attribution would require carrying the producing address on the collapsed CTE row and is out of scope.
- **Expected:** the multi-email contact's **email** contribution is suppressed while ANY of its addresses is muted; its **call/SMS/task** contributions are unaffected (S4). (FR-4, FR-5)

### S13 — Mid-thread mute → history retained, list contribution stops, new inbound stops linking

- **Preconditions:** a thread with the muted sender was already linked before the mute was added.
- **Expected:** the already-linked emails stay in history (FR-9) and remain reachable in the detail view; once muted, that thread stops contributing to the list (S2/S4); new inbound from the sender stops linking (S1). (FR-9, FR-2, FR-4)

---

## Edge cases (explicit)

1. **Empty muted set (nothing muted / Mail Secretary inactive / not connected)** → `email_muted` is always false (`ANY(empty)=false`); `isSenderMuted` returns false → **zero behavior change** everywhere (FR-1, C-4). No email is dropped or hidden.
2. **Domain vs exact** → `from:relyhome.com` (or `@relyhome.com`) mutes **all** `*@relyhome.com` (projected into `domains`); `from:customerservice@relyhome.com` mutes **only** that address (projected into `emails`). Both drive link-skip and list suppression. (FR-1)
3. **Regex `from:` token (e.g. `from:/rely.*/i`)** → mutes **new inbound** (via `isSenderMuted` → `matchEmail`) but is **NOT** projected into the SQL set → a pre-existing linked timeline for that sender **keeps showing** in the list until a non-email signal ages it out. Documented v1 limitation — see **OQ-MM-4** and the worked example. (accepted)
4. **Negated from-only token** (`-from:security` on a from-only line) → honored at link time by `matchEmail`; **not** projected into the SQL set (negation can't be expressed as positive membership) → link-time-only. (C-2, OQ-MM-4)
5. **Mixed line `from:X subject:Y`** → excluded from the mute subset entirely; keeps task-only behavior; email still surfaces. (DECISION-B, S10b)
6. **Contact whose primary `contacts.email` is muted but whose thread was matched via `contact_emails`** (CONTACT-EMAIL-MERGE-001) → `email_muted` checks **both** `co.email` and every `contact_emails.email_normalized`, so either path triggers suppression. (FR-4)
7. **Outbound reply TO a muted address** → see **OQ-MM-2 (resolved)** below — the conversation is contact-scoped, so a muted contact's collapsed email thread is suppressed regardless of the latest leg's direction; **sending/composing outbound is never blocked** (no write-path change). (OQ-MM-2)
8. **Staleness after a rule edit** → the effect lands within the existing ~60s settings cache; `invalidateCache` already fires on settings writes so both the ingestion and list paths pick up the change on the next uncached read — consistently (NFR-4). ≤ ~60s is acceptable (matches task-gating today). (OQ-MM-3, resolved)
9. **Pagination integrity** → a suppressed email-only row never enters the `COUNT(*) OVER()` window; the page stays exactly ≤ `limit`; the frontend "page < limit ⇒ no more pages" contract is preserved (LIST-PAGINATION-001). (NFR-1)
10. **Call/SMS-only muted contact** (contact has a muted email address but the row is currently ranked by a call/SMS) → the row stays; only the email terms are gated; call/SMS ordering is byte-for-byte today's. (S4)

---

## Error handling

1. **Parse error / missing `mail_agent_settings` at link time** → `isSenderMuted` returns `false` (caught) → email links & surfaces as today; no throw escapes `linkInboundMessage` (MAIL-AGENT-001 pipeline contract). (FR-10)
2. **Parse error / DB error at list time** → `getMutedSenderSet` returns `{emails:[],domains:[]}` (caught) → `email_muted` false → list unchanged; `GET /api/calls/by-contact` does not 500. (FR-10)
3. **Malformed token that survived PUT /settings validation** → cannot occur for regex (validated at save); a defensive `try/catch` in both helpers still guarantees fail-open. (FR-10)
4. **Mail Secretary disconnected mid-session** → `getActiveState` returns inactive → both helpers no-op → today's behavior (C-4).
5. **`getUnifiedTimelinePage` called by a non-Pulse caller** (sync jobs) → params default to `[]` → identical to today (no accidental suppression in other consumers).

---

## Component interaction

```
INBOUND (Gmail push / IMAP poll)
  → emailTimelineService.linkInboundMessage(companyId, msg)
       guards: no_message → outbound → draft_or_sent
       → (NEW, FR-2/FR-3, gated on !opts.skipAgent)
            mailAgentService.isSenderMuted(companyId, msg)   // reuses getActiveState(cache) + fromOnlyRules + matchEmail
            → true  ⇒ return { skipped: 'muted_sender' }     // no link, no unread, no bump, no contact, no SSE
            → false ⇒ continue to findEmailContact … (today's path)

PULSE LIST
  → GET /api/calls/by-contact  (authenticate, requireCompanyAccess, callsRead/pulse.view)
       companyId = req.companyFilter?.company_id
       → mailAgentService.getMutedSenderSet(companyId)  // reuses getActiveState(cache); {emails,domains}; fail-open
       → queries.getUnifiedTimelinePage({ limit, offset, companyId, search, mutedEmails, mutedDomains })
            computes per-row  email_muted  (co.email / contact_emails vs $4/$5)
            gates the 5 email-term sites with  AND NOT email_muted
       → successResponse (SAME shape; possibly fewer rows)
```

- **CALLS / SMS are not touched anywhere** — `linkInboundMessage` is the **email** path only; `latest_call`, the `sms` lateral, `open_task`, `is_action_required`, `tl.has_unread`, the orphan-shadow dedup, and pagination are **byte-for-byte unchanged** (protected).
- **No SSE change.** The mute guard returns before any broadcast; suppressed rows simply don't emit unread/thread events.

---

## Concrete change points (for the Planner / Implementer — spec, not code)

> Line numbers are anchors from the current files; the Planner re-confirms before editing.

- **`backend/src/services/mailAgentService.js`** — ADD `isSenderMuted(companyId, msg)`, `getMutedSenderSet(companyId)`, and an internal `fromOnlyRules(parsed)` helper (keep `rules[i]` where `tokens.every(t => t.field === 'from')`). Reuse `getActiveState` (l.29), `safeParseRules` (l.69), `buildRuleInput` (l.80), and `mailAgentRules.matchEmail`. **Extend `module.exports`** (l.312 — currently `{ isActive, reviewInboundEmail, dryRun, invalidateCache }`) with the two new functions. Both fail-open.
- **`backend/src/services/mailAgentRules.js`** — **NO change** (it exports `{parseRules, matchEmail}`; token shape `{negate, field, kind:'contains'|'regex', value|regex}` with `value` already lower-cased — the from-only filter and literal extraction read this shape). Do not fork matching.
- **`backend/src/services/email/emailTimelineService.js`** — ADD the `{skipped:'muted_sender'}` early return in `linkInboundMessage` **after** the `draft_or_sent` guard (l.104) and **before** `findEmailContact` (l.112), gated on `!opts.skipAgent`. New skip value joins the documented set (`no_message`/`outbound`/`draft_or_sent`/`no_contact`) in the header comment (l.85).
- **`backend/src/db/timelinesQueries.js`** — `getUnifiedTimelinePage` gains `mutedEmails = []` (`$4`) + `mutedDomains = []` (`$5`) appended to `params` **before** the `searchFilter` param growth (search shifts to `$6+`; the existing `params.length + 1` idiom stays dynamic). Compute the `email_muted` scalar and gate **exactly these five sites**:
  - **l.499** `last_interaction_at = GREATEST(latest_call.started_at, sms.last_message_at, eml.last_message_at)` → email term becomes `CASE WHEN NOT email_muted THEN eml.last_message_at END`.
  - **l.500–501** `any_unread` OR-chain → email term becomes `(COALESCE(eml.unread_count,0) > 0 AND NOT email_muted)`.
  - **l.549** surfacing predicate `OR eml.email_thread_id IS NOT NULL` → `OR (eml.email_thread_id IS NOT NULL AND NOT email_muted)`.
  - **l.591** ORDER-BY unread tier `COALESCE(eml.unread_count,0) > 0` → `(COALESCE(eml.unread_count,0) > 0 AND NOT email_muted)`.
  - **l.598** ORDER-BY `GREATEST(latest_call.started_at, sms.last_message_at, eml.last_message_at)` → same `CASE WHEN NOT email_muted THEN eml.last_message_at END` on the email term.
  - **`email_muted` definition** (Postgres forbids referencing a SELECT alias in WHERE/ORDER-BY): compute it **once** by wrapping the current query (minus its final ORDER/LIMIT) in a subselect / CTE so both SELECT and ORDER-BY reference `email_muted` by name; **or** inline the identical cheap expression at each of the 5 sites. Whichever keeps the EXPLAIN clean is chosen at implementation; the expression is:
    ```
    (
      lower(co.email) = ANY($4)
      OR split_part(lower(co.email), '@', 2) = ANY($5)
      OR EXISTS (
           SELECT 1 FROM contact_emails ce2
           WHERE ce2.contact_id = tl.contact_id
             AND ( ce2.email_normalized = ANY($4)
                OR split_part(ce2.email_normalized, '@', 2) = ANY($5) )
         )
    )
    ```
  Everything else (`latest_call`, `sms` lateral, `open_task`, `is_action_required`, `tl.has_unread`, `co.has_unread`, orphan-shadow dedup, `COUNT(*) OVER()`, `LIMIT/OFFSET`) is **unchanged**.
- **`backend/src/routes/calls.js`** — in `GET /api/calls/by-contact` (~l.106), before calling the query (~l.122), fetch `const { emails: mutedEmails, domains: mutedDomains } = await require('../services/mailAgentService').getMutedSenderSet(companyId);` and pass `mutedEmails`/`mutedDomains` into `getUnifiedTimelinePage`. Existing `authenticate, requireCompanyAccess`, `callsRead`/`pulse.view` gate, and `req.companyFilter?.company_id` (401 on missing tenant) unchanged. `queries.getUnifiedTimelinePage` re-export in `backend/src/db/queries.js` (l.33) needs **no** change (params flow through the object arg).

---

## Resolved open questions

- **OQ-MM-4 — regex/negated `from:` tokens (v1 limitation, ACCEPTED).** `getMutedSenderSet` projects **only literal, non-negated** `from:` addresses/domains into the SQL suppression set. `/regex/i` `from:` tokens and negated `from:` tokens are muted at **link time** (`isSenderMuted` runs the full from-only DSL incl. regex/negation, so **new inbound** from such a sender stops linking) but are **NOT** retro-hidden from the existing Pulse list (a per-row regex in the hot query is banned by PULSE-PERF-001).
  - **Worked example:** a plain `from:relyhome.com` works **everywhere** — new inbound skips linking **and** the existing relyhome timeline drops out of the list. A `from:/rely.*/i` regex mutes **new** inbound (stops linking) but a **pre-existing** relyhome timeline **keeps showing** in the list until a non-email signal ages it out (or the operator replaces the regex with the literal domain form). This asymmetry **never over-hides** (it only ever declines to hide) and keeps the hot query regex-free. **Accepted for v1.** (If regex retro-hiding is ever needed, escalate to a derived-persisted-set approach for regex mutes only — out of scope here.)
- **OQ-MM-2 — outbound to a muted address (RESOLVED).** Mute governs the **inbound** email *signal* and (for list display) the **conversation with that address**, not the operator's ability to send. Two facets:
  1. **Composition/sending is never blocked** — there is no write-path change; an operator can always email a muted address (EMAIL-OUTBOUND-001 send path untouched).
  2. **List display of a muted contact's thread** — because `email_by_contact` collapses each contact to a **single** most-recent thread and `email_muted` keys on the **contact's own address(es)** being in the muted set, a muted contact's collapsed email thread is suppressed from the list **regardless of whether the latest message on it was inbound or outbound**. This is the correct, consistent outcome — the whole point is to declutter that vendor's conversation — and it never force-hides a **non-muted** sender's thread. (i.e. "outbound stays visible" holds for **non-muted** contacts; for a **muted** contact the entire email thread is decluttered, which is the intent.) The detail view remains reachable directly (FR-9).
- **OQ-MM-3 — staleness after rule edits (RESOLVED).** Acceptable staleness = the existing ~60s settings cache; **no new cache**. `invalidateCache` already fires on `PUT /settings`, so edits reflect on the next uncached read for **both** the ingestion and list paths — consistently (NFR-4). ≤ ~60s matches today's task-gating behavior.

---

## Multiple-email rule (decision, restated)

**`email_muted` is true when ANY of the contact's addresses (its `contacts.email` OR any `contact_emails.email_normalized`) is an exact member of the muted `emails` set, OR that address's domain is a member of the muted `domains` set.** There is no per-thread producing-address attribution (the collapsed CTE row carries no address column in the hot query). Consequence: a contact carrying **any** muted address has its **email** contribution suppressed (its call/SMS/task contributions are not). Simplest defensible rule; keeps the hot query cheap; matches operator intent. (See S12.)

---

## Non-functional requirements

- **NFR-1 — No Pulse-list latency regression.** `email_muted` is false for empty sets (`ANY(empty)=false`) → no plan change when nothing is muted. The `contact_emails` `EXISTS` is a PK-indexed `contact_id` lookup; no regex, no Seq Scan. **MANDATORY gate:** run `EXPLAIN (ANALYZE, BUFFERS)` of the modified `getUnifiedTimelinePage` against a **prod-DB copy** with a non-empty `mutedEmails`/`mutedDomains` and confirm: (1) no new Seq Scan on `contacts`/`contact_emails`/`email_messages`; (2) the phone-digit expression indexes still drive the plan; (3) the `contact_emails` EXISTS uses the `contact_id` index; (4) latency parity with today's ~0.3s. Document in the PR (PULSE-PERF-001 / LIST-PAGINATION-001 methodology — **not** mocked jest).
- **NFR-2 — Bounded per-email overhead.** Both helpers reuse the ~60s `getActiveState` settings cache; **no** extra `mail_agent_settings` read per email.
- **NFR-3 — Data-safe.** No migration, no destructive change to historical email data; suppression is query-time and reversible (FR-9, FR-6).
- **NFR-4 — Consistency between the two seams.** The ingestion skip (JS/DSL) and the list suppression (SQL) both derive from the same company's `exclusion_rules` via the same cache, so a sender never links-but-hides or hides-but-links inconsistently. (The literal-only SQL projection vs. full-DSL link skip is the single documented, one-directional narrowing — OQ-MM-4 — which only ever *shows* rather than *hides* extra.)

---

## Protected parts (MUST NOT break)

- **`linkInboundMessage` contract & existing skips** (`no_message`/`outbound`/`draft_or_sent`/`no_contact`) and its "never throw from the pipeline" posture — the `muted_sender` return is additive and fail-open (FR-10).
- **MAIL-AGENT-001 exclusion semantics** — the DSL, `matchEmail`, and today's `skipped_excluded` task-gating stay intact; mute reuses them, never redefines them.
- **CALL and SMS contributions to `getUnifiedTimelinePage`** — `latest_call`, the `sms` lateral, `open_task`, `is_action_required`, `tl.has_unread`, `co.has_unread`, the orphan-shadow dedup, and pagination correctness (page ≤ limit; PULSE-PERF-001 indexes) — byte-for-byte preserved.
- **EMAIL-OUTBOUND-001 / EMAIL-LEAD-ORIGIN-001 surfacing for NON-muted senders** — unchanged; the `email_by_contact` CTE shape is unchanged (only the three consuming email terms are gated for muted contacts).
- **Tenant isolation** — the muted set and all suppression stay `company_id`-scoped (FR-7).
- **Historical email data** — no deletion / mutation (FR-9); reversibility preserved (FR-6).
- **Other `getUnifiedTimelinePage` callers** — defaulted params leave them at today's behavior.

---

## Acceptance criteria (for the TestCases agent)

- **AC-1 (link skip).** With a from-only mute active for the company, a fresh inbound email from the muted address makes `linkInboundMessage` return `{skipped:'muted_sender'}` — verified: **no** email link row created, **no** unread flip on the contact/timeline, **no** Pulse bump, **no** SSE unread/thread broadcast, and historical email rows untouched. (S1, S6; FR-2, FR-8)
- **AC-2 (email-only drop-out + restore).** An email-only timeline (e.g. relyhome / 2915) whose only signal is a muted sender's email is **absent** from `GET /api/calls/by-contact` while muted, and **present** again after un-muting — verified against a **prod-DB copy**, not mocked jest. Direct navigation to the timeline detail still renders it. (S2, S3, S5; FR-4, FR-5, FR-6, FR-9)
- **AC-3 (channel split).** For a contact with **both** a phone and a muted email address: after a new **muted email**, the row does **not** bump or become unread via email; after a new inbound **call** or **SMS**, the row **surfaces and bumps** normally. The exact ordering: email terms are excluded from `last_interaction_at` and `any_unread` for that contact; call/SMS terms are unchanged. (S4; FR-4, FR-5)
- **AC-4 (no contact auto-created).** A muted **first-time** (unknown) sender does **not** cause a contact/timeline to be auto-created (the mute early return precedes the no-contact agent path). Verified: no new `contacts`/`timelines` row for the muted sender. (S7; FR-3)
- **AC-5 (idempotency / dedup).** A redelivered/duplicate muted email stays `{skipped:'muted_sender'}` with no link and no contact; provider-message-id dedup is not weakened. (S6; FR-8)
- **AC-6 (reversible within cache window).** After removing the rule and saving (`invalidateCache` fires), within the ~60s settings cache the sender's future emails link/surface again and the previously-hidden timeline reappears. (S3; FR-6, OQ-MM-3)
- **AC-7 (multi-tenant).** Company A's mute never suppresses company B's identical-sender email; `getMutedSenderSet`/`isSenderMuted`/the SQL `email_muted` are all company-scoped. (S8; FR-7)
- **AC-8 (fail-open).** A forced parse/settings/DB error in `isSenderMuted` → the email links & surfaces as today (no throw escapes the pipeline); a forced error in `getMutedSenderSet` → the list surfaces email as today (`GET /api/calls/by-contact` does not 500). (S9; FR-10)
- **AC-9 (DECISION-B).** A **from-only** rule mutes (link skip + list suppression); a **subject/body/any/mixed** rule keeps today's task-only behavior — the email still links and surfaces. A **same-line negation** on a from-only line is honored (rescued sender is not muted). Unit-tested on `isSenderMuted`/`getMutedSenderSet` (from-only filtering, domain vs exact, negation rescue, regex→link-only-not-projected, inactive→empty, fail-open→empty/false). (S10, S11; DECISION-B, FR-1, C-2)
- **AC-10 (regex/negated v1 limitation, OQ-MM-4).** A `/regex/i` `from:` mute stops **new** inbound from linking, but a **pre-existing** timeline for that sender **remains** in the list (not retro-hidden). A literal `from:domain.tld` mute retro-hides the existing timeline **and** stops new inbound. (S/edge-case 3; OQ-MM-4)
- **AC-11 (no latency regression).** `EXPLAIN (ANALYZE, BUFFERS)` on a prod-DB copy with a non-empty muted set shows no new Seq Scan, the phone-digit indexes still drive the plan, the `contact_emails` EXISTS uses the `contact_id` index, and latency ≈ today's ~0.3s; empty muted set = no plan change. Documented in the PR. (NFR-1)
- **AC-12 (no migration / data-safe).** No schema migration ships; latest migration remains 155; no historical `email_messages`/`email_threads`/link rows are deleted or mutated. (NFR-3, FR-9)

---

## Out of scope

- Any change to CALL or SMS contributions to the Pulse list, or to the `email_by_contact` CTE **shape** (only the three consuming email terms are gated for muted contacts).
- A new "muted senders" list / UI / settings field (the existing `exclusion_rules` list is the single source of truth) — no frontend change.
- Retro-hiding **regex/negated** `from:` mutes from the existing list (link-time only for v1 — OQ-MM-4); any derived-persisted-set (migration 156) approach.
- Blocking outbound composition/sending to a muted address (never blocked; OQ-MM-2).
- Deleting or archiving historical email data for muted senders (retained; FR-9).
- Muting when Mail Secretary is not connected/enabled (behavior is exactly today's; C-4).
