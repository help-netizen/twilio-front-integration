# YELP-TIMELINE-DEDUP-001 — Behavior Spec (one Yelp conversation → ONE contactless timeline)

**Status:** Spec · **Priority:** P1 · **Backend + a small Pulse-render tweak** · **Date:** 2026-07-11
**Requirements:** `docs/requirements.md` (R1–R10 / AC1–AC8 / non-func N1–N6) · **Architecture:** `docs/architecture.md` (A–G)
**Builds on:** YELP-CONVO-BOOKING-001 (`yelp_conversations` mig 164, `parseConversationId(msg)`) · YELP-LEAD-AUTORESPONDER-002 (`d584997`, detector→`maybeHandleYelpLead`/`maybeHandleYelpReply`, `yelp_lead_events` claim-ledger). Reuses EMAIL-TIMELINE-001's `linkInboundMessage` ingest seam (push + poll) and PULSE-PERF-001's pre-aggregated-CTE discipline.

## 1. Overview
A single Yelp customer conversation reaches us as N inbound emails whose relay `From` (`reply+<hex>@messaging.yelp.com`) **varies per message** while the customer-facing conversation is stable. Today each new relay is an unseen sender → `findEmailContact` misses → the no-contact Mail-Secretary branch (`reviewInboundEmail({noContact:true})` → `createEmailContact`) fabricates a **junk contact + junk timeline per message** (8 on prod). This feature keys ONE timeline off the stable conv-id, links every message of the conversation onto it **contactlessly**, and **never creates a contact from a Yelp email**. Identity = a denormalized `display_name`. A contact is materialized only later via the lead path, which adopts the same timeline. Do-not-restate: `parseConversationId` two-form parser (YELP-CONVO-BOOKING §2), the `yelp_lead`/`yelp_convo` short-circuit semantics (YELP-002), and the `email_by_contact` pre-aggregation pattern (PULSE-PERF-001).

## 2. Schema delta — migration `165_yelp_timeline_dedup.sql` (RECHECK next-free at build; max on disk = 164)
Additive; `IF NOT EXISTS` throughout. `display_name` is **required, not optional** — a Phase-1a Yelp lead has no phone, so the existing Pulse name mechanisms (`co.full_name`, lead-by-phone, `sms.friendly_name`) yield no label.
```sql
ALTER TABLE timelines
  ADD COLUMN IF NOT EXISTS yelp_conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS display_name         TEXT,   -- customer name from parseYelpLead; COALESCEd, never nulled
  ADD COLUMN IF NOT EXISTS external_source      TEXT;   -- 'yelp' — badge + list-leg/cleanup target

CREATE UNIQUE INDEX IF NOT EXISTS uq_timelines_yelp_convo
  ON timelines(company_id, yelp_conversation_id) WHERE yelp_conversation_id IS NOT NULL;

-- [BLOCKER] relax the identity CHECK (029_revise_timelines.sql:19-20) or a contactless+phoneless INSERT throws:
ALTER TABLE timelines DROP CONSTRAINT IF EXISTS chk_timelines_identity;
ALTER TABLE timelines ADD  CONSTRAINT chk_timelines_identity
  CHECK (contact_id IS NOT NULL OR phone_e164 IS NOT NULL OR yelp_conversation_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_email_messages_timeline
  ON email_messages (company_id, timeline_id, gmail_internal_at) WHERE timeline_id IS NOT NULL;

ALTER TABLE yelp_conversations ADD COLUMN IF NOT EXISTS timeline_id BIGINT REFERENCES timelines(id) ON DELETE SET NULL; -- optional
```
Ship `rollback_165_…` (drop index/column/constraint; re-add the 2-key CHECK). The widened CHECK stays valid for every existing row (additive third disjunct).

## 3. Resolver + placement (the one Yelp branch)
**`resolveYelpTimeline(companyId, convId, msg, client=db)`** — new in `timelinesQueries.js` (beside `findOrCreateTimelineByContact:242` but SEPARATE; that one is contact-centric). Upsert on the partial-unique index; COALESCE the name so a later name-less email never nulls a good one:
```sql
INSERT INTO timelines (company_id, yelp_conversation_id, external_source, display_name)
VALUES ($1,$2,'yelp',$3)
ON CONFLICT (company_id, yelp_conversation_id) WHERE yelp_conversation_id IS NOT NULL
DO UPDATE SET updated_at = now(),
              display_name = COALESCE(timelines.display_name, EXCLUDED.display_name)
RETURNING *;
```
`$3` = `parseYelpLead(msg)` name if present, else NULL. **Placement:** a single Yelp-domain node at the TOP of `linkInboundMessage` (`emailTimelineService.js`) — AFTER the outbound/draft guards (`:102-107`) and BEFORE the two existing `yelp_lead`/`yelp_convo` short-circuits (`:120`, `:144`), which it **subsumes**:
```
if (!opts.skipAgent && isYelpRelay(msg)) {                          // reuse relay-gate (yelpLeadService.js:39/77)
    const convId = require('../yelpConversationId').parseConversationId(msg);
    if (!convId) return { skipped: 'yelp_no_convo' };               // §5: ZERO timeline, ZERO contact
    try {
        const tl = await timelinesQueries.resolveYelpTimeline(companyId, convId, msg);
        const linked = await emailQueries.linkMessageToContact(msg.provider_message_id, companyId,
              { contact_id: null, timeline_id: tl.id, on_timeline: true });   // contact_id NULL (nullable, :466)
        const st = await emailQueries.getMessageLinkState(msg.provider_message_id, companyId);
        if (linked && !(st && st.on_timeline && st.timeline_id === tl.id)) { … } // see §S7 re-key
        await timelinesQueries.markTimelineUnread(tl.id);           // Pulse surfacing signal
        realtimeService.publishMessageAdded(toEmailItem(linked), { id:null }, tl.id);  // SSE
    } catch (e) { console.error('[EmailTimeline] resolveYelpTimeline fail-open:', e.message); }
    try { await require('../yelpLeadService').maybeHandleYelpLead(companyId, msg); }  catch (e) {…}  // greeting/lead
    try { await require('../yelpLeadService').maybeHandleYelpReply(companyId, msg); } catch (e) {…}
    return { linked: true, timelineId: convId /* tl.id */, skipped: 'yelp_convo' };   // ALWAYS return here
}
```
**Guard-order invariant:** the branch **always returns before `findEmailContact` (`:182`)**, so no `@messaging.yelp.com` email reaches `reviewInboundEmail({noContact})` → `createEmailContact` (`mailAgentService.js:197`). Resolve+link runs BEFORE the greeting handlers, so handled- and fall-through emails land on the SAME conv-id timeline; the link is idempotent on `(company_id, provider_message_id)`. Covers push AND poll (poll supplies `body_text`, enough for the parser).

## 4. Behavior scenarios

- **S1 — first Yelp message (has conv-id):** inbound `reply+A@…`, body carries `message_to_business_conversation/<id>`. → `resolveYelpTimeline` INSERTs a contactless timeline (`contact_id NULL`, `yelp_conversation_id=<id>`, `external_source='yelp'`, `display_name=`parsed name); the message links to it (`on_timeline=true`); `markTimelineUnread` + SSE fire; existing `maybeHandleYelpLead` still greets/creates the lead exactly as YELP-002. **Effect:** one contactless timeline, one linked email, greeting unchanged.

- **S2 — reply from a DIFFERENT relay + hex, SAME conv-id:** inbound `reply+B@…`, body carries `%2Fthread%2F<id>` (same `<id>`). → `resolveYelpTimeline` hits `ON CONFLICT` and returns the **SAME** timeline row (no new row); the reply links onto it. The varying relay is NEVER the key. **Effect:** timeline count for the conversation stays 1; AC1.

- **S3 — a 2nd, distinct conversation:** inbound with a different `<id2>`. → a **new** timeline (distinct `yelp_conversation_id`); does not collide onto S1's. **Effect:** two conversations = two timelines; AC1.

- **S4 — NO contact ever created:** across S1–S3 no `contacts` row is written and `createEmailContact` is never called — structurally unreachable because the Yelp branch returns before `findEmailContact`/`reviewInboundEmail`. The timeline stays contactless; identity = `display_name`. **Effect:** AC2; zero junk contacts.

- **S5 — no-conv-id / `no-reply@*yelp.com` (suppress):** Yelp-domain email with no parseable conv-id (notification echo "New message from ABC Homes", welcome/confirmation, `no-reply@`). → `return { skipped: 'yelp_no_convo' }`: **zero** timeline, **zero** contact, no link, no SSE. Gate is (Yelp-domain **AND** no conv-id) so non-Yelp mail is untouched and still flows the normal pipeline. Rationale: real customer messages ALWAYS carry a conv-id (both forms in `parseConversationId`). **Effect:** AC2 tail; no new Pulse surface.

- **S6 — contactless timeline VISIBLE in Pulse:** the conv-id timeline appears in the unified list labeled by `display_name`, surfaces on its email signal (via the new `email_by_timeline` leg — §5), orders by its own last-message recency, and its detail view loads the conversation's emails. **Effect:** AC4; read-path changes below.

- **S7 — idempotent re-ingest (push+poll overlap, same `provider_message_id`):** re-delivery resolves to the SAME timeline and adds **no** second link, **no** duplicate unread, **no** duplicate SSE — even though `contact_id` is NULL. The existing `alreadyLinked` guard (`emailTimelineService.js:204`) tests `existing.contact_id != null`, which **misfires** for a contactless link (always treats it as new). **Re-key** the idempotency read on `on_timeline && timeline_id === tl.id` (or `provider_message_id` presence), NOT on a non-null `contact_id`. **Effect:** AC6.

- **S8 — safe-fail (resolver fault):** any throw in `parseConversationId` / `resolveYelpTimeline` / `linkMessageToContact` is caught (fail-open); `linkInboundMessage` and the push route / poll tick keep running. Because the branch has ALREADY decided this is Yelp and returns, a fault **never** re-enables the junk-contact path (the email does not fall through to `findEmailContact`). **Effect:** AC7; no crash, no junk contact, no double-processing.

- **S9 — lead path adopts the conv-id timeline (if/when built):** when the autoresponder lead path materializes a contact (real name), it attaches that `contact_id` to the EXISTING conv-id timeline (`resolveYelpTimeline` can `SET contact_id` / adopt) rather than minting a second, contact-keyed timeline. Conversation timeline count stays 1. Out-of-scope to force in this feature (owner: "don't create contacts — even better"); spec'd so the Implementer preserves adopt-in-place if the lead path is wired. **Effect:** AC3.

- **S10 — cleanup consolidation (one-time, owner-run):** the 8 junk contacts' messages are grouped by parsed conv-id, each group re-pointed onto one `resolveYelpTimeline` timeline, the junk contacts + emptied timelines deleted (§6). **Effect:** AC8.

## 5. Pulse read-path change (contactless email must surface + open)
Contactless timelines today do NOT surface email: `getUnifiedTimelinePage` joins `email_by_contact ON eml.contact_id = tl.contact_id` (`timelinesQueries.js:571`) → NULL contact ⇒ no email; `buildTimeline` projects email only `if (contact?.id)` (`pulse.js:299`). Minimal real changes:

1. **LIST** — add a pre-aggregated CTE leg `email_by_timeline` (mirror of `email_by_contact`, but `GROUP BY em.timeline_id` from `email_messages WHERE timeline_id IS NOT NULL AND on_timeline`, served by `idx_email_messages_timeline`); `LEFT JOIN … ON eml_tl.timeline_id = tl.id`; fold into the surfacing predicate, into `last_interaction_at`/`GREATEST`, and into the SELECT; expose `tl.display_name AS display_name`. PULSE-PERF-001 discipline: one pre-aggregation, index-only, no per-row correlation.
2. **DETAIL** — the `GET /api/pulse/timeline-by-id/:timelineId` route + `buildTimeline(req,res,contact,timeline)` **already exist** (`pulse.js:57,130`), but the email projection is still `contact?.id`-gated (`:299`). Add `getTimelineEmailByTimeline(companyId, timelineId)` in `emailQueries.js` (`WHERE company_id=$1 AND timeline_id=$2 AND on_timeline=true` — mirror of `getTimelineEmailByContact:605`) and project email when `timeline?.id` is present (contactless → timeline-leg only). **Reconcile the drift**, don't add a duplicate route.
3. **FE** — one line: add `call.display_name` to the name fallback in `PulseContactItem.tsx` (`:113-114`): `company || leadName || contactName || call.display_name || formatPhoneNumber(displayPhone)`.

Surfacing signal for a contactless row = `has_unread` (from `markTimelineUnread`) and/or the attached Yelp task via `tasks.thread_id`; recency = the `email_by_timeline` last-message timestamp. `external_source='yelp'` drives a "Yelp" badge. No net-new Pulse screen.

## 6. Cleanup outline (separate one-time script — NOT a migration; owner "да", snapshot-first)
`backend/scripts/yelp_timeline_dedup_cleanup.js`, idempotent, per-company txn, DEFAULT_COMPANY scoped:
1. `pg_dump` the affected `timelines`/`contacts`/`email_messages` BEFORE any write.
2. Find the 8 junk contacts (`full_name IN ('Yelp','Yelp Inbox')` + `createEmailContact` `created_by` heuristic, company=DEFAULT).
3. For each junk contact's `email_messages`: `parseConversationId(body_text)` → group by conv-id → `resolveYelpTimeline` per group (sets `yelp_conversation_id` + `display_name`).
4. **Re-point** (targeted, NOT `mergeContacts`): `UPDATE email_messages SET contact_id=NULL, timeline_id=<convTl>, on_timeline=true WHERE contact_id=<junk>`.
5. DELETE the junk contacts (FK `ON DELETE SET NULL` unlinks) + their now-empty timelines.
`mergeContacts`/`mergeOrphanTimelines` are the WRONG primitives (they need a survivor contact / a phone key; the goal is contactless). **Un-groupable residue** (echo/welcome mail with no parseable conv-id): leave as a contactless `display_name` timeline OR leave untouched — never guess a conv-id. Irreversible → snapshot-first + explicit owner confirmation; never auto-run by ingest or a migration.

## 7. Edge cases & non-functional
- **Tenant isolation (N1):** every leg (`resolveYelpTimeline`, `email_by_timeline`, `getTimelineEmailByTimeline`, cleanup) filters `company_id`; the previously-closed cross-tenant SMS list-leak must not regress (all joins `= tl.company_id`).
- **`ON CONFLICT` inference:** specify the partial-index predicate (`WHERE yelp_conversation_id IS NOT NULL`) in the conflict target; COALESCE `display_name` so a later name-less email never nulls a good name.
- **Protected behavior:** NON-Yelp mail path (contact match, mute, Mail-Secretary, unread/AR/SSE) stays byte-for-byte unchanged; `findOrCreateTimelineByContact` + `uq_timelines_contact` untouched; the widened CHECK + orphan-phone dedup (mig 029) valid for every existing row.
- **Two possible Pulse-list implementations** (inline vs `getUnifiedTimelinePage`) — Implementer must confirm the LIVE one and edit it.
- **no-conv-id invariant** ("customer messages always carry a conv-id") — confirm on a real prod Yelp email before trusting the suppress; when unsure, only no-timeline (never block non-Yelp).
