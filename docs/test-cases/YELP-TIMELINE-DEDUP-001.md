# Test Cases: YELP-TIMELINE-DEDUP-001 — one Yelp conversation → ONE contactless timeline (keyed by conv-id)

**Spec:** `docs/requirements.md#YELP-TIMELINE-DEDUP-001` + `docs/architecture.md` (§A–G).
**Status:** Test cases authored pre-implementation (Agent 04). Priority P1 feature; backend + one FE line.
**Foundation under test:** YELP-LEAD-AUTORESPONDER-002 (`d584997`) + YELP-CONVO-BOOKING-001 (`parseConversationId`, `yelp_conversations`).

---

## Coverage

- **Total test cases:** 15
- **P0:** 9 (TC-01…TC-09) | **P1:** 3 (TC-10…TC-12) | **P2:** 2 (TC-13, TC-14) | **P3:** 1 (TC-15)
- **Unit (jest-mocked, no DB):** 7 — TC-01, TC-03, TC-04, TC-05, TC-09, TC-10, TC-12
- **Integration (real Postgres, self-skip harness):** 6 — TC-02, TC-06, TC-07, TC-08, TC-11, TC-13
- **E2E / LIVE (manual, prod Yelp):** 2 — TC-14, TC-15
- **Every P0 carries a NAMED sabotage** (below) that must flip the case RED — the anti-tautology proof.

### Test files (all under top-level `tests/`; mock `../backend/src/...`; `mock*` factory vars)

| File | Kind | Cases |
|---|---|---|
| `tests/yelpTimelineDedup.test.js` | jest-mocked unit (mirrors `yelpLeadHook.test.js` / `yelpConvoIntercept.test.js` mocks) | TC-01, TC-03, TC-04, TC-05, TC-10, TC-12 |
| `tests/yelpTimelineResolve.db.test.js` | real-DB, self-skip | TC-02, TC-06, TC-08 |
| `tests/yelpTimelinePulse.db.test.js` | real-DB, self-skip | TC-07, TC-11 |
| `tests/yelpTimelineCleanup.db.test.js` | real-DB, self-skip | TC-13 |
| `tests/pulseContactItem.displayName.test.tsx` (or extend an existing FE render suite) | FE unit | TC-09 |
| — (runbook in this doc) | manual LIVE | TC-14, TC-15 |

**Run one file:**
`node /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js tests/<file> --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit`

### Real-DB harness contract (TC-02/06/07/08/11/13)

Copy the self-skip probe from `tests/yelpLeadClaim.db.test.js`: a `beforeAll` runs `SELECT 1 FROM timelines LIMIT 1` **and** probes the mig-165 column (`SELECT yelp_conversation_id FROM timelines LIMIT 1`); on failure set `dbReady=false` and each case no-ops with a `SKIPPED-NEEDS-DB` warning (the run does NOT fail). The DB seam is **not** mocked; external collaborators (`leadsService`, `emailService`, `realtimeService`) ARE mocked. Every seeded row uses `DEFAULT_COMPANY_ID` (`00000000-0000-0000-0000-000000000001`) except the explicit cross-tenant isolation rows. Clean up seeded ids in `afterAll`.

---

## PREREQUISITE — extend `tests/yelpFixtures.js`

The existing fixtures already give **three varying relay hexes on ONE conv-id** (`CONV_ID='9Xk2mZ7bQ1'`): `yNew` (first-form, hex `8160…`), `yReplyRespondable` (reply-form, hex `aa11…`), `yReply2` (reply-form, hex `ee55…`). Two of the shapes below are new and load-bearing for TC-01/TC-02/TC-04:

1. **`CONV_ID_2 = '7Yr4nP2wT9'`** — a second base64url conv-id (distinct from `CONV_ID`).
2. **`yNewOtherConvo(overrides)`** — a Yelp new-lead message carrying `CONV_ID_2` in **first-form** (`message_to_business_conversation/7Yr4nP2wT9`) from **yet another** hex relay (e.g. `reply+1122334455667788@messaging.yelp.com`). Proves "a 2nd conversation resolves to a DISTINCT timeline" (AC1).
3. **`yNoConvo(overrides)`** — a `@messaging.yelp.com` relay message whose body carries **NO** parseable conv-id (reuse the existing `Y_REPLY_BODY` — it has `utm_source=request_a_quote_new_message` but no `message_to_business_conversation/` and no `%2Fthread%2F`). `parseConversationId(yNoConvo())` MUST return `null`. (The existing `yReply()` already satisfies this and MAY be reused directly; add `yNoConvo` only if a clearer name is wanted.)
4. Export `CONV_ID_2`, `yNewOtherConvo` (and `yNoConvo` if added) alongside the current exports.

**Validation of the fixtures themselves** (fast guard, put in `tests/yelpTimelineDedup.test.js`): assert
`parseConversationId(yNew()) === parseConversationId(yReplyRespondable()) === parseConversationId(yReply2()) === CONV_ID`;
`parseConversationId(yNewOtherConvo()) === CONV_ID_2`;
`parseConversationId(yReply()) === null`. This pins that varying hexes share a conv-id and the 2nd convo differs, independent of any service wiring.

---

## Jest-mocked module setup (shared by `tests/yelpTimelineDedup.test.js`)

Mirror the mock block from `tests/yelpConvoIntercept.test.js` (lines 40–123) **plus** the two NET-NEW seam functions this feature adds:

- `../backend/src/db/timelinesQueries` mock MUST add **`resolveYelpTimeline: jest.fn()`** (alongside `findOrCreateTimelineByContact`, `markTimelineUnread`, `setActionRequired`, `createTask`).
- `../backend/src/db/emailQueries` mock MUST add **`getTimelineEmailByTimeline: jest.fn()`** (alongside `findEmailContact`, `getMessageLinkState`, `linkMessageToContact`, …).
- Keep `../backend/src/services/yelpLeadService` mocked with `maybeHandleYelpLead` / `maybeHandleYelpReply` (default `{handled:false}` unless a case overrides) so the timeline-unification branch is tested **independently of the greeter**.
- `process.env.YELP_AUTORESPONDER_ENABLED='true'` in `beforeEach`; `delete process.env.YELP_CONVO_ENABLED`.

> Default `resolveYelpTimeline.mockResolvedValue({ id: 7001, yelp_conversation_id: CONV_ID, display_name: 'Kim', external_source: 'yelp' })` and `linkMessageToContact.mockResolvedValue({ id: 1, direction:'inbound', thread_id:'ythr-NEW-1' })` in `beforeEach`.

---

## P0 — CRITICAL

### TC-01: conv-id is the timeline key — varying relay hex collapses to ONE resolve; 2nd conv-id is distinct
- **Priority:** P0 · **Type:** Unit (jest-mocked) · **File:** `tests/yelpTimelineDedup.test.js`
- **Requirements:** R1, R2, R7 · **AC:** AC1
- **Preconditions:** env enabled; `resolveYelpTimeline` mocked to echo its `convId` arg into `{id, yelp_conversation_id}` (e.g. `mockResolvedValue` per-call, or `mockImplementation((co,cid)=>({id: cid===CONV_ID?7001:7002, yelp_conversation_id:cid, display_name:'Kim'}))`).
- **Inputs:** call `svc.linkInboundMessage(COMPANY, yNew())`, then `yReplyRespondable()`, then `yReply2()` (three DIFFERENT `reply+<hex>@` addresses, SAME body conv-id), then `yNewOtherConvo()` (different conv-id).
- **Mocks:** `maybeHandleYelpLead`/`maybeHandleYelpReply` → `{handled:false}` (isolate the linker); `linkMessageToContact` → a row.
- **Steps:** invoke the four; capture `resolveYelpTimeline.mock.calls`.
- **Expected:**
  1. For the first three, `resolveYelpTimeline` is called with `(COMPANY, CONV_ID, <msg>, …)` **every time** — the 2nd arg is `CONV_ID` for all three (NOT the `reply+<hex>` from `from_email`).
  2. `resolveYelpTimeline` is NEVER called with a hex/relay string as the key.
  3. For `yNewOtherConvo()`, the 2nd arg is `CONV_ID_2` (distinct) → a distinct `id`.
  4. Each returns `linked:true` with the resolved `timelineId` (7001 for the first three, 7002 for the fourth).
- **NAMED SABOTAGE `SAB-KEY-ON-RELAY`:** make the branch pass `msg.from_email` (or the `reply+<hex>` token) as the resolver key instead of `parseConversationId(msg)`. → the three same-conversation messages resolve on three different keys (assertion 1/2 fail) → **RED**.

### TC-02: `resolveYelpTimeline` real upsert — same (company,conv) ⇒ one row; different conv ⇒ distinct; cross-tenant isolated
- **Priority:** P0 · **Type:** Integration (real-DB) · **File:** `tests/yelpTimelineResolve.db.test.js`
- **Requirements:** R1, R7, N1 · **AC:** AC1, AC5
- **Preconditions:** mig 165 applied (`timelines.yelp_conversation_id` + `uq_timelines_yelp_convo` + relaxed CHECK). `dbReady` gate.
- **Inputs:** `resolveYelpTimeline(DEFAULT_COMPANY_ID, 'CONV-DB-A', yNew({body override with CONV-DB-A}))` twice; then `'CONV-DB-B'` once; then `'CONV-DB-A'` under a SECOND company id.
- **Steps:** call the resolver directly against the real DB; read back the `timelines` rows.
- **Expected:**
  1. The two `CONV-DB-A` calls return the **same `id`** (upsert on `ON CONFLICT (company_id, yelp_conversation_id)`), contact_id NULL, phone_e164 NULL, `external_source='yelp'`.
  2. `CONV-DB-B` returns a **different `id`**.
  3. The second-company `CONV-DB-A` returns **another distinct `id`** (partial-unique is per `(company_id, conv)`, so tenants never collide) — N1.
  4. `display_name` is set from the parsed name on first insert; a later call with a NULL/absent name does **not** clobber it (COALESCE) — see TC-06 assertion 4 for the schema-level proof.
- **NAMED SABOTAGE `SAB-RESOLVE-PLAIN-INSERT`:** replace the `INSERT … ON CONFLICT … DO UPDATE RETURNING *` with a plain `INSERT`. → the 2nd `CONV-DB-A` call violates `uq_timelines_yelp_convo` and throws (or, without the index, creates a 2nd row) → assertion 1 fails → **RED**.

### TC-03: NO contact is ever created from a Yelp relay email
- **Priority:** P0 · **Type:** Unit (jest-mocked) · **File:** `tests/yelpTimelineDedup.test.js`
- **Requirements:** R3 · **AC:** AC2
- **Preconditions:** env enabled; `maybeHandleYelpLead`→`{handled:false}` (proves suppression is structural, not greeter-dependent).
- **Inputs:** `svc.linkInboundMessage(COMPANY, yNew())`.
- **Mocks:** `emailQueries.findEmailContact` (spy — should never fire); `mailAgentService.reviewInboundEmail` (spy — should never fire); `resolveYelpTimeline`/`linkMessageToContact` succeed.
- **Steps:** invoke once; inspect call spies + the `linkMessageToContact` argument.
- **Expected:**
  1. `emailQueries.findEmailContact` **NOT** called.
  2. `mailAgentService.reviewInboundEmail` **NOT** called (so `createEmailContact` at `mailAgentQueries.js:163` is structurally unreachable for Yelp — arch §C).
  3. `linkMessageToContact` called with `{ contact_id: null, timeline_id: <resolved>, on_timeline: true }`.
  4. The call **returns before** the no-contact branch (result carries `linked:true`, and the branch's `skipped` tag e.g. `yelp_convo`/`yelp_lead`).
- **NAMED SABOTAGE `SAB-DROP-EARLY-RETURN`:** remove the unconditional `return` at the end of the Yelp branch (let control fall through to `findEmailContact`). → `findEmailContact` fires (assertion 1) and, with no contact, `reviewInboundEmail({noContact:true})` fires (assertion 2) → **RED**.

### TC-04: no parseable conv-id ⇒ suppressed (`{skipped:'yelp_no_convo'}`), nothing created; non-Yelp still reaches Mail Secretary
- **Priority:** P0 · **Type:** Unit (jest-mocked) · **File:** `tests/yelpTimelineDedup.test.js`
- **Requirements:** R5 · **AC:** AC2
- **Preconditions:** env enabled.
- **Inputs (three sub-cases):**
  - (a) `yNoConvo()` / `yReply()` — a `@messaging.yelp.com` relay with **no** conv-id in the body.
  - (b) `yConfirm()` — Yelp `no-reply@notify.yelp.com` confirmation (no conv-id, wrong-for-messaging domain).
  - (c) `nonYelp()` — an ordinary inbound with no contact.
- **Mocks:** `findEmailContact`→null; `resolveYelpTimeline`/`linkMessageToContact` (spies — must not fire in (a)/(b)); `reviewInboundEmail` spy.
- **Expected:**
  - (a) returns `{ skipped: 'yelp_no_convo' }`; `resolveYelpTimeline`, `linkMessageToContact`, `findEmailContact`, `reviewInboundEmail` **all NOT called** — zero timeline, zero contact.
  - (b) `createEmailContact` path is **never** reached (`reviewInboundEmail` with `noContact:true` is NOT called with a create decision). **See coverage gap G-2:** whether (b) returns `{skipped:'yelp_no_convo'}` (branch gate broadened to `no-reply@*yelp.com`) or `{skipped:'no_contact'}` (gate stays messaging-only, Secretary find-or-create declines) is an Implementer decision — assert the invariant that holds either way: **no contact is created**. If the design broadens the gate, tighten (b) to `toEqual({skipped:'yelp_no_convo'})`.
  - (c) returns `{ skipped: 'no_contact' }` and `reviewInboundEmail` **IS** called with `{noContact:true}` — the normal pipeline for genuinely-unknown mail is untouched (regression guard).
- **NAMED SABOTAGE `SAB-DROP-CONVID-GATE`:** delete the `if (!convId) return { skipped:'yelp_no_convo' }` guard so the branch proceeds to `resolveYelpTimeline` even with a null conv-id. → sub-case (a) now calls `resolveYelpTimeline` (making a junk/`NULL`-keyed timeline) instead of skipping → **RED**.

### TC-05: contactless idempotency — same `provider_message_id` on push then poll ⇒ ONE link, no 2nd unread/SSE (guard keys on timeline/on_timeline, NOT contact_id)
- **Priority:** P0 · **Type:** Unit (jest-mocked) · **File:** `tests/yelpTimelineDedup.test.js`
- **Requirements:** R9 · **AC:** AC6
- **Preconditions:** env enabled; the message carries a valid conv-id (`yNew()`).
- **Mocks / sequencing:**
  - 1st delivery: `getMessageLinkState` → `null` (not yet linked). `linkMessageToContact` → a row.
  - 2nd delivery (redelivered push or poll overlap): `getMessageLinkState` → `{ contact_id: null, timeline_id: 7001, on_timeline: true }` (**contact_id NULL** — the contactless link).
  - `resolveYelpTimeline` → same `{id:7001}` both times (upsert).
- **Steps:** `linkInboundMessage(COMPANY, yNew())` twice with the sequenced `getMessageLinkState`.
- **Expected:**
  1. `linkMessageToContact` may run both times (its UPDATE is a harmless no-op the 2nd time), BUT
  2. `timelinesQueries.markTimelineUnread` and `realtimeService.publishMessageAdded` each fire **exactly once** (only on the 1st delivery).
  3. 2nd call returns an already-linked result (e.g. `{ linked:true, timelineId:7001, alreadyLinked:true }`) — no duplicate unread bump, no duplicate SSE.
- **NAMED SABOTAGE `SAB-GUARD-CONTACTID`:** implement the Yelp-branch idempotency read as the legacy `existing.on_timeline && existing.contact_id != null` (the misfiring guard at `emailTimelineService.js:204`). → because the contactless link has `contact_id === null`, `alreadyLinked` is false on redelivery → `markTimelineUnread` + `publishMessageAdded` fire a **2nd** time (assertion 2 fails) → **RED**.

### TC-06: migration 165 — CHECK relax lets a contactless+phoneless conv-id timeline INSERT; partial-unique blocks a duplicate; rollback restores
- **Priority:** P0 · **Type:** Integration (real-DB, DDL) · **File:** `tests/yelpTimelineResolve.db.test.js`
- **Requirements:** R1, N4 · **AC:** AC1 · **Arch:** §A, deviation #1 (BLOCKER)
- **Preconditions:** mig 165 applied. `dbReady` gate. (Number is expected **165**; last applied migration is `164_yelp_conversations`. RECHECK `ls backend/db/migrations` at build — worktree drift, arch deviation #8.)
- **Steps / Expected:**
  1. **CHECK relax:** `INSERT INTO timelines (company_id, yelp_conversation_id, external_source) VALUES ($co,'CONV-CHK-1','yelp')` with **contact_id NULL and phone_e164 NULL** SUCCEEDS. (Pre-relax this violates `chk_timelines_identity` from `029_revise_timelines.sql:20` — `CHECK (contact_id IS NOT NULL OR phone_e164 IS NOT NULL)`.)
  2. **Partial-unique:** a 2nd INSERT with the SAME `(company_id,'CONV-CHK-1')` raises `unique_violation` on `uq_timelines_yelp_convo` (assert the SQLSTATE `23505` / error).
  3. **Existing rows still valid:** a legacy contact-only row (`contact_id` set, `yelp_conversation_id` NULL) and a legacy orphan-phone row still INSERT/exist — the widened CHECK is additive (N4), `uq_timelines_contact` + `uq_timelines_orphan_phone` untouched.
  4. **COALESCE label:** `resolveYelpTimeline(co,'CONV-CHK-1', <msg with name 'Kim'>)` sets `display_name='Kim'`; a subsequent call with a name-less msg leaves `display_name='Kim'` (not nulled).
  5. **Rollback:** applying `rollback_165_*.sql` drops `yelp_conversation_id/display_name/external_source` + the partial-unique index and **restores** the strict `chk_timelines_identity` (a contactless+phoneless insert fails again). Run in a disposable schema/txn so it does not wreck the shared test DB.
- **NAMED SABOTAGE `SAB-KEEP-IDENTITY-CHECK`:** ship mig 165 WITHOUT the `DROP CONSTRAINT chk_timelines_identity … ADD … OR yelp_conversation_id IS NOT NULL` widening. → step 1 INSERT fails with a check violation → **RED** (the feature is dead — deviation #1). **Secondary sabotage `SAB-DROP-CONVO-UNIQUE`:** omit `uq_timelines_yelp_convo` → step 2 no longer raises → **RED**.

### TC-07: Pulse LIST — the contactless conv-id timeline surfaces, labeled by `display_name`, via `email_by_timeline` (keyed timeline_id, company-scoped)
- **Priority:** P0 · **Type:** Integration (real-DB) · **File:** `tests/yelpTimelinePulse.db.test.js`
- **Requirements:** R6, R7, N3 · **AC:** AC4, AC5 · **Arch:** §E1, deviation #2 (BIGGEST SURFACE)
- **Preconditions:** mig 165 + `idx_email_messages_timeline` applied. Seed: one contactless conv-id timeline (`yelp_conversation_id='CONV-PULSE-1'`, `display_name='Kim L.'`, `external_source='yelp'`) + an `email_messages` row linked to it (`contact_id NULL, timeline_id=<tl>, on_timeline=true, direction='inbound'`, a recent `gmail_internal_at`). Seed a SECOND company's contactless Yelp timeline to prove isolation.
- **Steps:** `getUnifiedTimelinePage({ companyId: DEFAULT_COMPANY_ID, limit:50, offset:0 })`.
- **Expected:**
  1. The contactless Yelp row is **present** in the page (surfaced by the new `email_by_timeline` leg — NOT dropped for lacking a contact/call/SMS).
  2. The row exposes `display_name = 'Kim L.'` (label source is the timeline column, NOT `to_json(co)` which is NULL).
  3. The row carries an email signal (`email_thread_id`/`email_last_message_at` from the timeline leg) and a non-null `last_interaction_at` so it orders by its latest Yelp message (R6 recency).
  4. **Company isolation (N1/N3):** company B's Yelp timeline does NOT appear in company A's page; every leg is `= tl.company_id` (no cross-tenant leak — regression on the closed LIST-PAGINATION SMS leak).
  5. **Keyed serve (AC5):** an `EXPLAIN` of the query shows `email_by_timeline` served by `idx_email_messages_timeline` (indexed group-by on `timeline_id`), not a per-row relay parse or seq-scan aggregate.
- **NAMED SABOTAGE `SAB-EMAIL-BY-CONTACT-ONLY`:** do NOT add the `email_by_timeline` CTE/leg (leave only `email_by_contact ON eml.contact_id = tl.contact_id`). → the contactless row has `tl.contact_id NULL` → no email signal → it fails the surfacing predicate and is absent (assertion 1/3 fail) → **RED**.

### TC-08: Pulse DETAIL — timeline-id entry path + `getTimelineEmailByTimeline` returns the contactless conversation's emails
- **Priority:** P0 · **Type:** Integration (real-DB) · **File:** `tests/yelpTimelineResolve.db.test.js`
- **Requirements:** R6 · **AC:** AC4 · **Arch:** §E2
- **Preconditions:** as TC-07 seed (a contactless conv-id timeline with ≥2 linked `email_messages` rows).
- **Steps:** call the new `emailQueries.getTimelineEmailByTimeline(DEFAULT_COMPANY_ID, <tlId>)` directly; also (if the route exists) drive the new detail entry `GET /api/pulse/timeline/by-id/:timelineId` → `buildTimeline(req,res,null,timeline)`.
- **Expected:**
  1. `getTimelineEmailByTimeline` returns the timeline's email rows (WHERE `company_id=$1 AND timeline_id=$2 AND on_timeline=true`), oldest→newest, mirroring `getTimelineEmailByContact`'s shape.
  2. It is **company-scoped**: passing company B returns `[]` for company A's timeline (tenant isolation; direct-access-by-id yields no cross-tenant rows).
  3. `buildTimeline` with a `timeline` (and `contact=null`) projects `email_messages` from the timeline leg (arch §E2b: project email when `timeline?.id` exists, not only when `contact?.id`).
- **NAMED SABOTAGE `SAB-DETAIL-CONTACT-ONLY`:** keep the detail email projection gated on `if (contact?.id)` only. → a contactless timeline detail returns `email_messages: []` (assertion 3 fails) → **RED**.

### TC-09: Frontend name fallback uses `display_name`
- **Priority:** P0 · **Type:** Unit (FE) · **File:** `tests/pulseContactItem.displayName.test.tsx` (or add to an existing PulseContactItem render suite)
- **Requirements:** R6 · **AC:** AC4 · **Arch:** §E3 (`PulseContactItem.tsx:115` fallback chain)
- **Preconditions:** render `PulseContactItem` with a `call`/row that has **no** `company`, no `leadName`, no `contact.full_name`, `tl_phone=null`, and `display_name='Kim L.'`, `external_source='yelp'`. Stub `useLeadByPhone` to return no lead.
- **Steps:** render; read the primary label.
- **Expected:** the primary text is **'Kim L.'** — the chain is `company || leadName || contactName || call.display_name || formatPhoneNumber(displayPhone)` (a Yelp badge from `external_source='yelp'` is a nice-to-have, not asserted here).
- **NAMED SABOTAGE `SAB-LABEL-FROM-CONTACT`:** omit `call.display_name` from the fallback chain (ship the current `company || leadName || contactName || phone`). → with no phone the label degrades to empty/`formatPhoneNumber(null)` instead of 'Kim L.' → **RED**.

---

## P1 — HIGH

### TC-10: safe-fail — a `resolveYelpTimeline` throw is contained (fail-open), ingest continues, NO junk contact, no double-processing
- **Priority:** P1 · **Type:** Unit (jest-mocked) · **File:** `tests/yelpTimelineDedup.test.js`
- **Requirements:** R10 · **AC:** AC7 · **Arch:** §G safe-fail
- **Preconditions:** env enabled; `yNew()` (valid conv-id).
- **Mocks:** `resolveYelpTimeline.mockRejectedValue(new Error('resolve boom'))`; `linkMessageToContact` spy; `findEmailContact` spy; `reviewInboundEmail` spy.
- **Steps:** `linkInboundMessage(COMPANY, yNew())`.
- **Expected:**
  1. The call does **not** throw (the whole Yelp branch is in try/catch; `linkInboundMessage` never rejects — the push route/poll tick keep running).
  2. It does **NOT** fall into the junk-contact path — `findEmailContact` / `reviewInboundEmail` **NOT** called (arch: "ветка уже вернулась" — the branch still returns before the contact path even on resolver fault, so a resolver fault never re-enables `createEmailContact`).
  3. The greeting side-effects (`maybeHandleYelpLead`/`maybeHandleYelpReply`) are still attempted best-effort (decoupling: timeline fault ≠ greeter fault).
  4. Returns a benign summary (e.g. `{ skipped:'yelp_no_convo' }`-style safe tag or a `{linked:false,…}` — assert it does NOT carry `error` that would crash a caller, and no `linked:true` on a failed resolve).
- **Coverage note:** also add a symmetric case where `linkMessageToContact` throws → same fail-open, no contact path re-enabled.

### TC-11: lead-path adopts the conv-id timeline — sets `contact_id` on the existing row, no 2nd timeline
- **Priority:** P1 · **Type:** Integration (real-DB) · **File:** `tests/yelpTimelinePulse.db.test.js`
- **Requirements:** R4 · **AC:** AC3 · **Arch:** §C (adopt) / requirements B6
- **Preconditions:** a contactless conv-id timeline already exists (from `resolveYelpTimeline(co, CONV_ID, …)`), with ≥1 linked contactless message. Then the lead path materializes a real contact (real customer name).
- **Steps:** simulate the adopt: resolve/create the contact, then attach it to the EXISTING conv-id timeline (the Implementer's adopt path — `UPDATE timelines SET contact_id=$c WHERE yelp_conversation_id=$conv AND company_id=$co`, NOT `findOrCreateTimelineByContact`). Re-query timelines for that conv-id.
- **Expected:**
  1. **Exactly ONE** timeline row for `(company, CONV_ID)` after adoption (COUNT = 1) — no second contact-keyed timeline was minted.
  2. That row now has `contact_id` set AND retains `yelp_conversation_id` — both `chk_timelines_identity` and `uq_timelines_contact` still hold (dual-anchored row is valid).
  3. Already-linked messages stay on the row (their `timeline_id` unchanged); the label may now flip to the contact name.
- **Jest companion (unit):** in `tests/yelpTimelineDedup.test.js`, assert the subsuming branch still calls `maybeHandleYelpLead` AFTER the link (the greeter/lead enqueue is not skipped by unification) — proves R4's lead path is still driven.
- **Coverage note (B6 edge):** if a conv-id timeline AND a pre-existing contact timeline for the same person both exist, the adopt must merge onto one (reuse relink) — flag as an Implementer edge; a P2 follow-up case may be warranted once the adopt semantics are pinned.

### TC-12: decoupling + regression — non-Yelp unchanged; greeter still enqueues under the subsuming branch; EXISTING suites updated
- **Priority:** P1 · **Type:** Unit (jest-mocked) + structural · **File:** `tests/yelpTimelineDedup.test.js`
- **Requirements:** R2 (subsumes short-circuits), N6, Protected-code · **Arch:** §B (branch subsumes `:120`/`:144`), deviation #3
- **Preconditions:** env enabled.
- **Steps / Expected:**
  1. **Non-Yelp untouched:** `linkInboundMessage(COMPANY, nonYelp())` with a matching contact behaves byte-for-byte as today (contact link, unread, SSE) — the Yelp branch does not intercept non-`@messaging.yelp.com` mail. `resolveYelpTimeline` NOT called.
  2. **Greeter still fires:** for `yNew()` and `yReplyRespondable()`, the branch links the contactless timeline **and** still invokes `maybeHandleYelpLead` / `maybeHandleYelpReply` (best-effort, after the link) — greeting/lead enqueue is preserved (YELP-CONVO/002 behavior intact even though the two `{skipped}` short-circuits at `:120`/`:144` are now subsumed).
  3. **Unification holds with the greeter OFF/failing:** with `maybeHandleYelpLead`/`maybeHandleYelpReply` mocked to `{handled:false}` OR throwing, `yNew()` still links onto the conv-id timeline (assert `linkMessageToContact` with `contact_id:null` still ran) — decouples "unify timeline" from "send greeting" (arch B2).
- **⚠ REGRESSION — existing suites MUST be updated (coverage note, not optional):** the new subsuming branch **links + emits SSE + returns a hybrid shape** (`{ linked:true, timelineId, skipped:'yelp_lead'|'yelp_convo' }`), which contradicts assertions baked into the CURRENT suites:
  - `tests/yelpConvoIntercept.test.js` lines 130/178/227/300 assert `res` `toEqual({ skipped:'yelp_lead'|'yelp_convo' })` (exact object — will fail once `linked/timelineId` are added), and lines 150/304 assert `realtimeService.publishMessageAdded).not.toHaveBeenCalled()` (will fail — the branch now publishes). Line 267/274 assert `yConfirm()` → `{skipped:'no_contact'}` (may flip to `yelp_no_convo` under the broadened gate — see G-2).
  - `tests/yelpLeadHook.test.js` YLA-M-02 (lines 99/108) similarly asserts exact `{skipped:'yelp_lead'}` and `publishMessageAdded).not.toHaveBeenCalled()`.
  These are **intended** contract changes; the Implementer must update those expectations (relax `toEqual`→`toMatchObject({skipped})` and assert `publishMessageAdded` IS called for the contactless link). Their `findEmailContact).not.toHaveBeenCalled()` assertions must STAY green (still no contact path). Run both suites after the change to confirm they were migrated, not broken.
- **Structural check:** extend `yelpLeadHook.test.js` E-03-style source assertion — the timeline-unification linker must NOT import `mailAgentService`/`reviewInboundEmail` (decoupled from the Secretary).

---

## P2 — MEDIUM

### TC-13: one-time cleanup script — group junk by conv-id → re-point → delete junk contacts; snapshot-first; idempotent
- **Priority:** P2 · **Type:** Integration (real-DB) · **File:** `tests/yelpTimelineCleanup.db.test.js`
- **Requirements:** R8, N5 · **AC:** AC8 · **Arch:** §F
- **Preconditions:** `dbReady` gate. Seed a miniature of the prod mess: 2 "junk" contacts (`full_name IN ('Yelp','Yelp Inbox')`, DEFAULT company) each with a junk timeline, and several `email_messages` whose stored `body_text` carries a parseable conv-id (some sharing one conv-id across different junk contacts, plus one message with NO parseable conv-id = "un-groupable residue").
- **Steps:** run the cleanup entrypoint (`backend/scripts/yelp_timeline_dedup_cleanup.js`) in dry-run then apply, against the seed.
- **Expected:**
  1. **Snapshot-first:** the script writes/records a snapshot of affected `timelines`/`contacts`/`email_messages` BEFORE any write (assert the snapshot artifact/log exists; a run that cannot snapshot must abort).
  2. **Group + re-point:** all messages sharing a conv-id are re-pointed to ONE resolved conv-id timeline: `contact_id=NULL, timeline_id=<convTl>, on_timeline=true`. Two junk contacts that were actually one conversation collapse to one timeline.
  3. **Delete junk contacts:** the `full_name IN ('Yelp','Yelp Inbox')` contacts are deleted; their now-empty timelines removed; FK `ON DELETE SET NULL` leaves no dangling references.
  4. **Un-groupable residue:** the no-conv-id message is left contactless/untouched (NOT guessed onto a conversation) — arch §F residue rule.
  5. **Idempotent:** a 2nd run re-points/deletes nothing (no-op) and does not error.
  6. **Not auto-run:** assert (grep/structural) the cleanup is a standalone script, NOT invoked from `linkInboundMessage`, the poll tick, or mig 165 (N5).
- **Sabotage (procedure):** point the re-point UPDATE at `mergeContacts` (survivor-contact semantics) instead of the contactless re-point → a survivor junk contact remains (assertion 3 fails). Confirms arch §F "`mergeContacts` НЕ подходит".

### TC-14: LIVE — a real Yelp conversation (2+ relay-varying messages) shows as ONE Pulse timeline labeled by the customer, no new junk contacts
- **Priority:** P2 · **Type:** E2E / LIVE (manual, prod, owner-gated) · **File:** runbook below (no jest)
- **Requirements:** R1, R2, R3, R6 · **AC:** AC1, AC2, AC4
- **Preconditions:** deployed to prod with `YELP_AUTORESPONDER_ENABLED` on for the default company; a real Yelp lead + at least one customer reply available (two DIFFERENT `reply+<hex>@messaging.yelp.com` senders, same conversation).
- **Steps:**
  1. Snapshot `SELECT count(*) FROM contacts WHERE full_name IN ('Yelp','Yelp Inbox')` and the conv-id timeline count before.
  2. Let the new-lead email ingest, then the reply.
  3. Open Pulse; find the conversation.
- **Expected:** ONE timeline row for the conversation, labeled with the **customer's parsed name** (not "Yelp"/a phone); both messages appear on it; the junk-contact count is **unchanged** (no new `contacts` row created); the row is openable and orders by the latest message.
- **Note:** this is the acceptance the owner will eyeball; capture before/after SQL counts as evidence.

### TC-15: LIVE — no-conv-id invariant holds on a REAL prod notification email
- **Priority:** P3 · **Type:** E2E / LIVE (manual, prod) · **File:** runbook below
- **Requirements:** R5 · **AC:** AC2 · **Arch:** deviation #4 ("подтвердить на реальном прод-письме")
- **Preconditions:** a REAL Yelp `no-reply@*yelp.com` / notification / "New message from ABC Homes" echo email in the prod mailbox (the fixtures are simplified — this validates the real-body invariant).
- **Steps:** confirm the message ingested; check DB.
- **Expected:** it created **no** timeline and **no** contact (`{skipped:'yelp_no_convo'}`-class outcome); crucially it never produced a `contacts` row. If a real customer message is ever found to lack a parseable conv-id, that is a parser gap (raise a bug) — but the invariant "no conv-id ⇒ no junk contact" must hold. Records the deviation-#4 confirmation the arch demands before trusting the suppress gate.

---

## Notes for the Implementer / Tester

- **jest-mocked vs real-DB vs live:** the 7 unit cases (TC-01/03/04/05/09/10/12) run anywhere with no DB and are the fast anti-regression gate (each P0 among them has a named sabotage). The 6 real-DB cases (TC-02/06/07/08/11/13) self-skip without a mig-165 DB — they are the ONLY proof for the CHECK relax, the partial-unique, `email_by_timeline`, `getTimelineEmailByTimeline`, the adopt, and the cleanup; they MUST be run against a migrated DB before deploy (do not treat a SKIP as a pass). The 2 LIVE cases (TC-14/15) are owner-gated prod checks — TC-15 specifically discharges arch deviation #4.
- **Named sabotage per P0:** TC-01 `SAB-KEY-ON-RELAY`; TC-02 `SAB-RESOLVE-PLAIN-INSERT`; TC-03 `SAB-DROP-EARLY-RETURN`; TC-04 `SAB-DROP-CONVID-GATE`; TC-05 `SAB-GUARD-CONTACTID`; TC-06 `SAB-KEEP-IDENTITY-CHECK` (+ `SAB-DROP-CONVO-UNIQUE`); TC-07 `SAB-EMAIL-BY-CONTACT-ONLY`; TC-08 `SAB-DETAIL-CONTACT-ONLY`; TC-09 `SAB-LABEL-FROM-CONTACT`. Each is a one-line reversal that must turn its case RED; revert immediately after confirming.
- **⚠ PIN THE LIVE PULSE-LIST IMPL (arch deviation #7):** the sidebar list is served by `GET /api/calls/by-contact` (`backend/src/routes/calls.js:140`) → `timelinesQueries.getUnifiedTimelinePage`. The architecture flags a *possible* second inline implementation near `calls.js:294`; verified here it is NOT a second list query (it's the `by-contact` row-map / enrichment for the same call). The Implementer must CONFIRM `getUnifiedTimelinePage` is the one live list path and add the `email_by_timeline` leg + `display_name` there (TC-07); if any inline variant is discovered, pin and patch the live one. TC-07 asserts against `getUnifiedTimelinePage` directly.

### Coverage gaps / open decisions flagged to the Implementer
- **G-1 — `isYelpRelay(msg)` does not exist.** The arch branch (`if (!opts.skipAgent && isYelpRelay(msg))`) references a gate that is NOT exported anywhere; today only the module-internal const `YELP_RELAY_DOMAIN_RE = /@messaging\.yelp\.com$/i` (`yelpLeadService.js:39`) exists. The Implementer must create/export `isYelpRelay` (or inline the regex). Tests assume its semantics = "from_email matches the Yelp relay domain"; TC-04/G-2 depends on how broad it is.
- **G-2 — no-reply@*yelp.com gate breadth (R5 vs the messaging-only relay).** A `no-reply@notify.yelp.com` confirmation does NOT match `@messaging.yelp.com`, so it would NOT enter the Yelp branch and would fall to the Mail-Secretary no-contact path today. R5/AC2 demand it "never reach `createEmailContact`". Either broaden the branch gate to `no-reply@*yelp.com` (then TC-04(b) asserts `{skipped:'yelp_no_convo'}`) or rely on the Secretary declining to create (weaker; TC-04(b) asserts only "no contact created"). TC-04 is written to hold under either, but this must be an explicit, tested decision — do not leave it implicit.
- **G-3 — return-shape / existing-suite migration (see TC-12).** `yelpConvoIntercept.test.js` and `yelpLeadHook.test.js` encode the OLD "no link / no SSE / exact `{skipped}`" contract. They will go RED on the intended new behavior and MUST be migrated as part of this feature, not worked around.
- **G-4 — migration number.** Expected **165** (last = `164_yelp_conversations`); recheck `ls backend/db/migrations` at build time (parallel-worktree drift, arch deviation #8). TC-06 hard-codes 165 in its skip-probe comment — update if the number moves.
