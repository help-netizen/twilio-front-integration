---
id: TIMELINE-REVPAGE-001
title: Messenger-style Pulse conversation timeline — reverse cursor pagination (20-item merged batches), bottom-anchored open, scroll-up history, sticky Action-Required bar
status: final_for_implementation
priority: P1
created_at: "2026-07-13"
language: en
owner: product_engineering
requirements: "Docs/requirements.md § TIMELINE-REVPAGE-001 (:5924, FR-01..FR-15, N1-N3, binding owner decisions 1-6)"
architecture: "Docs/architecture.md § TIMELINE-REVPAGE-001 (:6440, binding)"
implementer: GPT (has NOT seen the design conversation — this spec is self-sufficient)
constraints:
  - "`GET /api/pulse/timeline-by-phone` (route + response) and its consumers (softphone widget, AppLayout) — byte-untouched (owner decision 6)"
  - Legacy `ConversationPage.tsx` + `components/conversations/*` — untouched (owner decision 6); `CreateLeadJobWizard` is rendered only by PulsePage and is NOT modified
  - "`getUnifiedTimelinePage` (Pulse LEFT list SQL, LIST-PAGINATION-001/PULSE-PERF-001) — shape/semantics/plan unchanged"
  - No-`limit` requests to the two detail endpoints return the legacy `buildTimeline()` response BYTE-IDENTICAL (arrays, order, fields)
  - Batch size = 20 merged items (owner decision 4); cursor-based, newest→oldest ONLY; NOT offset, NOT day-based
  - Permission/tenant filtering BEFORE the 20-cut — a page is never shrunk post-query (FR-02)
  - "`company_id` strictly from `req.companyFilter?.company_id` on EVERY SQL leg (LIST-PAGINATION-001 cross-tenant discipline)"
  - SSE event EMISSION (names/payloads) untouched — only consumption scope on the Pulse page changes
  - No virtualization, no unread divider, no search/permalinks/jump-to-date (non-goals)
  - "`src/server.js` untouched (mount + `authenticate, requireCompanyAccess` already exist at :156); router-level `requirePermission('pulse.view')` already applied (`routes/pulse.js:18`)"
  - UI copy English; product = Albusto (never "Blanc" in UI strings); design tokens only (no hardcoded hex outside the `--blanc-*` set)
  - Prod deploy ONLY on the owner's explicit «да» (standing deploy-consent rule) — out of scope for the implementer
---

# TIMELINE-REVPAGE-001 — Behavior Spec

## 1. Overview

The Pulse conversation feed (right column: calls + SMS + emails + financial events, merged) today loads the ENTIRE history on every open and on every SSE event (`buildTimeline` in `backend/src/routes/pulse.js`: calls query with NO LIMIT + 4 recording/transcript LATERALs per call; up to 200 SMS per conversation across all matched conversations; ALL estimates + invoices; all timeline emails), and renders it oldest→newest top-down.

This feature makes it a messenger (WhatsApp/Telegram model):

- **Backend:** the two detail endpoints gain an opt-in paged mode `?limit=20[&before=<cursor>]` returning pages of exactly 20 merged items newest→oldest under a strict total order `(ts DESC, kind ASC, id DESC)`, assembled from 5 bounded per-source SQL legs and merged in a NEW pure, jest-testable module `backend/src/services/timelinePage.js`. Thread meta rides on page 1 only. No `limit` → legacy response byte-identical.
- **Frontend:** `usePulseTimeline` becomes a `useInfiniteQuery` (`@tanstack/react-query` 5.90.20 — verified in `frontend/package.json`) where `fetchNextPage` = "load OLDER". Opening a thread lands at the BOTTOM (newest items + composer visible, pre-paint anchored — no top-anchored flash). Scrolling up loads older batches with scroll-position preservation. SSE refreshes ONLY the newest page via a manual head fetch + cache union-merge (v5 removed `refetchPage`; `invalidateQueries` on an infinite query refetches every cached page — forbidden for SSE). New inbound while scrolled up does NOT yank the scroll — a unified "Jump to latest" pill lights up; auto-stick only at/near the bottom. The Action-Required bar becomes `position: sticky` at the top of the right column.

Single scroller stays `.pulse-right-column`; the Lead/Contact card and CreateLeadJobWizard stay ABOVE the feed inside it, reachable by paging up through history (binding owner decision 3 — resolved in architecture; do NOT move the cards out of the scroll region).

---

## 2. API contract (backend)

### 2.1 Routing & mode detection

Both existing GET handlers in `backend/src/routes/pulse.js` keep their guards exactly as today (order unchanged): param parse → `getTimelineInCompany` / contact tenant lookup → provider `assigned_only` check via `isContactVisibleToProvider` (404 on miss) — and only THEN branch:

```
req.query.limit != null  →  buildTimelinePage(req, res, contact, timeline, { limit, before })
otherwise                →  buildTimeline(req, res, contact, timeline)   // legacy, byte-identical
```

```
GET /api/pulse/timeline-by-id/:timelineId?limit=20              → page 1 (+meta)
GET /api/pulse/timeline-by-id/:timelineId?limit=20&before=<c>   → older page (no meta)
GET /api/pulse/timeline/:contactId?limit=20[&before=<c>]        → same, contact-keyed
GET /api/pulse/timeline-by-id/:timelineId                       → legacy full shape (unchanged)
GET /api/pulse/timeline/:contactId                              → legacy full shape (unchanged)
```

Param validation (before any SQL):
- `limit`: must match `/^[1-9]\d*$/`; then `limit = Math.min(parseInt(limit, 10), 50)`. FE always sends 20. Non-match (e.g. `limit=abc`, `limit=0`, `limit=-5`) → `400 {"error":"Invalid limit"}`.
- `before`: only valid together with `limit`. `before` present without `limit` → `400 {"error":"Invalid cursor"}`. Malformed cursor (see §3.1 validation) → `400 {"error":"Invalid cursor"}`.
- No new routes, no `src/server.js` change, no new middleware. `pulse.view` continues to gate router-wide (`routes/pulse.js:18`).

### 2.2 Paged response shape

```json
{
  "page": {
    "items": [
      { "ts": "2026-07-12T18:22:01.123456Z", "src": "call",      "id": "8412",
        "data": { /* formatCall output — §2.3.1, byte-compatible with legacy `calls[]` */ } },
      { "ts": "2026-07-12T18:20:59.000210Z", "src": "sms",       "id": "b3f0c9a2-…-uuid",
        "data": { /* sms row — §2.3.2, byte-compatible with legacy `messages[]` */ } },
      { "ts": "2026-07-12T17:03:11.550000Z", "src": "email",     "id": "912",
        "data": { /* email projection — §2.3.3, byte-compatible with legacy `email_messages[]` */ } },
      { "ts": "2026-07-11T09:00:00.000000Z", "src": "financial", "id": "estimate-33",
        "data": { /* financial event — §2.3.4, byte-compatible with legacy `financial_events[]` */ } }
    ],
    "next_cursor": "eyJ2IjoxLCJ0cyI6IjIwMjYtMDctMTFUMDk6MDA6MDAuMDAwMDAwWiIsImsiOjMsImlkIjoiMzMifQ",
    "has_more": true
  },
  "meta": {
    "timeline_id": 123,
    "display_name": null,
    "external_source": null,
    "contact": { /* contacts row + contact_emails: string[] — exactly as legacy `contact` */ },
    "conversations": [ /* sms_conversations rows — exactly as legacy `conversations` (composer needs proxy_e164) */ ]
  }
}
```

- `page.items` are **newest→oldest** (server total order, §3.4). The envelope (`ts`, `src`, `id`) is NEW and additive; `data` shapes are byte-compatible with today's four legacy arrays (DTO parity — additive-only; no bubble redesign).
- `src` is 4-valued for the FE: `'call' | 'sms' | 'email' | 'financial'` (`financial` covers both estimates and invoices; internal kind is derived from the `estimate-*`/`invoice-*` id prefix).
- Envelope `id` (string): calls → `String(calls.id)` (bigint digits); sms → `sms_messages.id` (uuid); email → `String(email_messages.id)` (bigint digits); financial → `estimate-<id>` / `invoice-<id>` (same as `data.id`).
- `next_cursor`: opaque cursor (§3.1) of the LAST emitted item; `null` when `has_more` is `false`.
- `has_more`: `true` iff more (older) items may exist (§5.8). A thread with exactly 20 items reports `has_more=true` once; the next fetch returns `{"items":[],"next_cursor":null,"has_more":false}` — accepted (one cheap extra request; FE handles the empty page gracefully).
- `meta` is present on **page 1 only** (`before` absent). Older pages carry no `meta` key at all.

### 2.3 Item `data` field lists (byte-parity with legacy — shared mapper code, §5.7)

**2.3.1 `src:"call"`** — output of the existing `formatCall(row)` (`routes/pulse.js:357`), UNCHANGED field set:
`id, call_sid, parent_call_sid, direction, from_number, to_number, status, is_final, started_at, answered_at, ended_at, duration_sec, answered_by, price, price_unit, created_at, updated_at, contact {id, phone_e164, full_name, email} | null, call_count?, recording? {recording_sid, status, playback_url, duration_sec}, transcript? {status, text, gemini_summary}`.

**2.3.2 `src:"sms"`** — the existing buildTimeline sms mapping block, UNCHANGED: all `sms_messages` row columns plus
`conversation_id: conv.id`, `from_number: direction==='inbound' ? conv.customer_e164 : conv.proxy_e164`, `to_number:` the inverse, `media:` parsed array (string → `JSON.parse`).

**2.3.3 `src:"email"`** — the existing email projection, UNCHANGED:
`id, type:'email', direction, is_outbound, from_email, from_name, to_email (raw to_recipients_json), subject, body_text (quote-stripped via toTimelineBody(row.body_text, {snippet: row.snippet})), body_html (raw || null), sent_at (gmail_internal_at), thread_id, sent_by_user_email`.

**2.3.4 `src:"financial"`** — the existing estimate/invoice mapping, UNCHANGED:
`id ('estimate-<id>'|'invoice-<id>'), type ('estimate_created' | invoice classification: amount_paid>=total → 'invoice_paid', >0 → 'invoice_partial_payment', else 'invoice_created'), reference, status, amount (total), occurred_at (created_at), contact_id`.

### 2.4 Error cases (paged mode — mirror existing semantics)

| Condition | Response |
|---|---|
| `:timelineId` / `:contactId` not an int | `400 {"error":"Invalid timelineId"}` / `400 {"error":"Invalid contactId"}` (existing) |
| `limit` present, fails `/^[1-9]\d*$/` | `400 {"error":"Invalid limit"}` |
| `before` present without `limit`, or cursor fails ANY §3.1 validation | `400 {"error":"Invalid cursor"}` |
| Timeline/contact not in tenant | `404 {"error":"Timeline not found"}` / `404 {"error":"Contact not found"}` (existing — foreign tenant indistinguishable from missing) |
| Provider `assigned_only` and contact not visible / orphan timeline | `404` same as above (existing) |
| No/invalid auth; missing `pulse.view` | `401` / `403` from the existing middleware chain (unchanged) |
| Unexpected error | `500 {"error":"Failed to fetch timeline"}` (existing catch) |

### 2.5 Legacy mode — byte-identity requirement

With no query params the response is the EXACT legacy shape and content:
`{calls, messages, conversations, email_messages, financial_events, timeline_id, display_name, external_source, contact}` — same arrays, same array ORDER (calls `ORDER BY started_at DESC NULLS LAST`; messages built per-conversation via `convQueries.getMessages(conv.id, {limit:200})` oldest-first per conversation; emails ASC; estimates/invoices DESC), same fields. Refactoring `buildTimeline` to use the shared helpers (§5.7) must not change a byte of this JSON. The only permitted SQL delta in legacy mode is the calls helper gaining `AND c.company_id = $2` (§5.3) — provably result-neutral because the route 404s foreign timelines first and every call row on a timeline carries that timeline's `company_id` (mig 012).

---

## 3. Cursor & total order (single source of truth)

### 3.1 Cursor format (opaque)

`base64url(JSON.stringify({v:1, ts, k, id}))` where:
- `ts` — ISO-8601 UTC **with microseconds**: `2026-07-12T18:22:01.123456Z`
- `k` — kind rank (integer 0..4, §3.3) of the cursor item
- `id` — RAW row id as string: bigint digits (`"8412"`, `"33"`) or uuid. For financial items the cursor id is the NUMERIC part (e.g. `"33"`), NOT `estimate-33` — it is compared against `estimates.id`/`invoices.id` in SQL.

Server-side validation (`parseCursor`, §4) — ALL must hold, else `400 Invalid cursor`:
- base64url decodes and parses as JSON object;
- `v === 1`;
- `k` is an integer in `0..4`;
- `ts` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$` (exactly 6 fractional digits — a millisecond-precision ts is REJECTED);
- `id` is a string matching `^[0-9a-fA-F-]{1,40}$`.

Cursors stay valid under live inserts: new items land only at the newest end, so previously issued cursors never dup/skip (FR-01). A cursor pointing at a since-deleted item stays well-defined — all predicates are strictly-less/equal forms (§3.5); the page simply continues past where it was.

### 3.2 Per-source timestamp expression table (THE canonical `ts`)

The SAME expression is used in the leg's ORDER BY, in its cursor predicate, and in the returned envelope `ts` (via `to_char`, §3.6):

| Source | `ts_expr` | Note |
|---|---|---|
| calls | `COALESCE(c.started_at, c.created_at)` | exactly what FE `callToCallData.startTime` uses; NULL-safe |
| sms | `m.created_at` | **ORDERING-KEY CHANGE (accepted, deliberate):** today the FE sorts SMS by `date_created_remote \|\| created_at`; the paged feed orders/keys by `created_at` (matches `idx_sms_msg_conversation_created`). Divergence is bounded by ingest latency. Bubble-INTERNAL time labels (which read `date_created_remote`) are untouched — only the feed order/cursor key changes. N3 harness compares against legacy order to confirm no thread visibly reorders. |
| email | `COALESCE(e.gmail_internal_at, e.created_at)` | defensive: `gmail_internal_at` is treated as nullable elsewhere (`getNewestThreadIdForContact`). `data.sent_at` stays raw `gmail_internal_at` (byte-parity). |
| estimates | `created_at` | == today's `occurred_at` |
| invoices | `created_at` | == today's `occurred_at` |

### 3.3 Kind rank

`KIND_RANK = { call: 0, sms: 1, email: 2, estimate: 3, invoice: 4 }`. The envelope `src` stays 4-valued (`financial` = ranks 3 and 4); internal kind is recovered from the financial id prefix.

### 3.4 Strict total order

`ts DESC, k ASC, id DESC`.

- `ts` compared as the µs ISO-UTC STRING (lexicographic == chronological for this fixed format).
- `id` compared numerically for digit ids, as a lowercase string for uuids — identical to PG `bigint`/`uuid` ordering. Digit-string numeric compare without BigInt: longer string is larger; equal length → lexicographic.
- This order is used by: the SQL predicates + ORDER BY (per leg), the JS merge (`compareDesc` in the pure module), and the FE display sort (which is its exact REVERSE, §7.3).

### 3.5 Per-leg cursor predicate (items strictly AFTER cursor C in DESC order)

For a leg of kind `S`, the pure module emits a mode; the SQL builders apply it:

| Condition | Mode | SQL form |
|---|---|---|
| `KIND_RANK[S] > C.k` | `lte` | `ts_expr <= $ts::timestamptz` (equal-ts items of a later-ranked kind were NOT yet emitted before the cursor item) |
| `KIND_RANK[S] === C.k` | `tuple` | `(ts_expr, id) < ($ts::timestamptz, $id::<idtype>)` — PG row-value comparison; id cast to the leg's native type (`::bigint` for calls/email/estimates/invoices, `::uuid` for sms) |
| `KIND_RANK[S] < C.k` | `lt` | `ts_expr < $ts::timestamptz` |

This is exact across equal-timestamp runs (N3 test case). No cursor (page 1) → no predicate on any leg.

### 3.6 Microsecond-precision discipline (MUST — FR-02 correctness)

node-pg returns `Date` (millisecond-lossy) while PG stores microseconds — a ms-truncated cursor makes boundary comparisons skip rows. Therefore:

- EVERY leg SELECTs `to_char(<ts_expr> AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts` — this STRING is the envelope `ts` and the only value that ever enters a cursor.
- Cursor `ts` is passed back into SQL as a parameter cast `$n::timestamptz` (lossless round-trip; the µs string parses exactly).
- **Never let a JS `Date` touch the cursor or envelope ts** — no `new Date(ts)` anywhere on the cursor path (FE may `new Date(item.ts)` for DISPLAY-only purposes: date separators).

---

## 4. Pure module `backend/src/services/timelinePage.js` (NEW)

Zero imports (no db, no express) — the jest seam. CommonJS (`module.exports`), matching the backend.

```js
// Exported surface (exact):
KIND_RANK                     // { call:0, sms:1, email:2, estimate:3, invoice:4 }  (frozen)
encodeCursor({ ts, k, id })   // → base64url string of {v:1, ts, k, id}. Assumes fields already valid (internal use).
parseCursor(str)              // → { ts, k, id }. Throws InvalidCursorError (exported class or
                              //   an Error with .code === 'INVALID_CURSOR') on ANY §3.1 validation failure,
                              //   including non-string / empty input.
compareDesc(a, b)             // total-order comparator over {ts, kind, id} triples (kind = internal 5-kind
                              //   string OR precomputed rank — pick ONE representation and document it):
                              //   ts string DESC → rank ASC → id DESC (digit-vs-uuid rule §3.4). Returns -1/0/1.
predicateModeFor(kind, cursor)// kind ∈ 'call'|'sms'|'email'|'estimate'|'invoice'; cursor = parsed {ts,k,id} or null.
                              //   → null (no cursor) | 'lte' | 'tuple' | 'lt'  per §3.5.
mergePage(legs, limit, cursor)// legs: Array<{ kind: 'call'|'sms'|'email'|'estimate'|'invoice',
                              //               rows: Array<{ ts: string, id: string|number, data: object }> }>
                              //   rows within a leg MAY be unsorted (sms leg concatenates per-conversation
                              //   batches); mergePage sorts globally with compareDesc.
                              //   → { items, nextCursor, hasMore }:
                              //   items      = first `limit` envelopes in DESC order:
                              //                { ts, src: kind==='estimate'||kind==='invoice' ? 'financial' : kind,
                              //                  id: financial ? `${kind}-${id}` : String(id), data }
                              //   nextCursor = hasMore ? encodeCursor({ts, k: KIND_RANK[kindOfLastEmitted], id: String(rawIdOfLastEmitted)}) : null
                              //   hasMore    = (leftover after cut > 0) OR legs.some(l => l.rows.length >= limit)
```

Behavioral notes:
- `parseCursor` MUST reject a tampered payload (`v:2`, `k:7`, ms-precision ts, id with `../`, etc.) with the typed error; the route maps that error (and `before`-without-`limit`) to `400 {"error":"Invalid cursor"}`.
- `mergePage` with all legs empty → `{ items: [], nextCursor: null, hasMore: false }`.
- `mergePage` never inspects permissions — the route simply does not pass financial legs for a user without `financial_data.view` (filter-before-cut; pages still full from the remaining kinds).
- `hasMore` rule is intentionally conservative (never false-negative): a leg whose `rows.length >= limit` may be exhausted exactly at the boundary → one extra empty page, accepted.

---

## 5. Backend — `buildTimelinePage` flow + per-source SQL

`buildTimelinePage(req, res, contact, timeline, { limit, before })` in `routes/pulse.js`. All queries parameterized; `companyId = tenantCompanyId(req)` (i.e. `req.companyFilter?.company_id`) appears on EVERY leg.

Flow:
1. `parseCursor(before)` via the pure module when `before` present (typed error → 400).
2. Conversation discovery (§5.2) — page-independent, same semantics as legacy.
3. 5 bounded legs in parallel (`Promise.all`) — §5.3–§5.6. Legs that don't apply are SKIPPED entirely (not blanked): financial legs only when `contact?.id && canViewFinancials` (gate expression verbatim from legacy: `req.user?._devMode || (req.authz?.permissions || []).includes('financial_data.view')`); sms leg only when conversations were found; email leg keyed by contact OR timeline (§5.5); calls leg only when `timeline?.id`.
4. Map rows through the SAME shared mappers as legacy (§5.7) into `{ts, id, data}` leg rows.
5. `mergePage(legs, limit, cursor)` → `{items, nextCursor, hasMore}`.
6. Page 1 (no `before`): build `meta` with the SAME code legacy uses: `contactOut` = contact + `contact_emails` via `contactsService.getContactEmails(contact.id, contact.email)` (try/catch as today); `conversations` from discovery; `timeline_id/display_name/external_source` from `timeline`.
7. `res.json({ page: { items, next_cursor: nextCursor, has_more: hasMore }, ...(before ? {} : { meta }) })`.

### 5.2 Conversation discovery (per request — cheap, byte-equivalent to legacy)

Page 1's 20 calls would under-populate legacy's `callPhones` set, so discovery runs a bounded 2-column scan instead (no LATERALs, parent-only to mirror legacy's `callRows` exactly):

```sql
SELECT DISTINCT from_number AS n FROM calls
 WHERE timeline_id = $1 AND company_id = $2 AND parent_call_sid IS NULL AND from_number IS NOT NULL
UNION
SELECT DISTINCT to_number FROM calls
 WHERE timeline_id = $1 AND company_id = $2 AND parent_call_sid IS NULL AND to_number IS NOT NULL
```

Then EXACTLY the legacy composition: `phonesToSearch` = normalized `contact?.phone_e164 || timeline?.phone_e164` (`'+' + digits`) + normalized `contact?.secondary_phone` + all discovered numbers; digits-matched against `sms_conversations` with the EXISTING query (`regexp_replace(customer_e164,'\D','','g') = ANY($1) AND company_id = $2 ORDER BY last_message_at DESC NULLS LAST` — PULSE-PERF-001 expression indexes). Result = `conversations` (meta + sms leg input). Conversation ids are NOT embedded in the cursor (rejected alternative: stale-set risk) — rediscovery every page.

### 5.3 Calls leg — inner LIMIT subquery, LATERALs OUTSIDE (the perf move)

Factor a local helper used by BOTH paths — one SQL string, mode-dependent tail:

`fetchTimelineCalls(timelineId, companyId, { window })` where `window = null` (legacy) or `{ limit, predicate }` (paged):

```sql
SELECT c.*, to_json(co) as contact,
    COALESCE(r.recording_sid, cr.recording_sid) as recording_sid,
    COALESCE(r.status, cr.status) as recording_status,
    COALESCE(r.duration_sec, cr.duration_sec) as recording_duration_sec,
    COALESCE(t.status, ct.status) as transcript_status,
    COALESCE(t.text, ct.text) as transcript_text,
    COALESCE(t.raw_payload, ct.raw_payload) as transcript_raw_payload
FROM (
    SELECT *,
           to_char(COALESCE(started_at, created_at) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
    FROM calls
    WHERE timeline_id = $1
      AND company_id = $2
      AND parent_call_sid IS NULL
      -- paged mode only, per predicateModeFor('call', cursor):
      --   lte:   AND COALESCE(started_at, created_at) <= $3::timestamptz
      --   tuple: AND (COALESCE(started_at, created_at), id) < ($3::timestamptz, $4::bigint)
      --   lt:    AND COALESCE(started_at, created_at) < $3::timestamptz
    -- paged mode only:
    --   ORDER BY COALESCE(started_at, created_at) DESC, id DESC
    --   LIMIT $n
) c
LEFT JOIN contacts co ON c.contact_id = co.id
LEFT JOIN LATERAL ( /* recordings — VERBATIM from legacy buildTimeline */ ) r ON true
LEFT JOIN LATERAL ( /* child-leg recordings — VERBATIM */ ) cr ON r.recording_sid IS NULL
LEFT JOIN LATERAL ( /* transcripts — VERBATIM */ ) t ON true
LEFT JOIN LATERAL ( /* child-leg transcripts — VERBATIM */ ) ct ON t.status IS NULL
-- legacy mode: ORDER BY c.started_at DESC NULLS LAST          (byte-identical array order)
-- paged  mode: ORDER BY COALESCE(c.started_at, c.created_at) DESC, c.id DESC
```

The inner LIMIT bounds the 4 LATERALs to ≤`limit` rows per page (today they run for EVERY call in the thread — this is the N1 win). The extra `ts` column is additive; legacy `formatCall` picks named fields only, so the legacy JSON is unchanged. `buildTimeline` switches to this helper with `window=null`.

### 5.4 SMS leg — NEW `conversationsQueries.getMessagesPageDesc(conversationIds, companyId, { limit, cursorPred })`

One query; per-conversation LATERAL guarantees index-backward scans on `idx_sms_msg_conversation_created (conversation_id, created_at)` (a plain `= ANY() ORDER BY` would sort the whole thread):

```sql
SELECT sub.*
FROM unnest($1::uuid[]) AS conv(cid)
JOIN LATERAL (
    SELECT m.*,
           to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
           COALESCE(
               (SELECT json_agg(json_build_object(
                   'id', md.id, 'twilio_media_sid', md.twilio_media_sid,
                   'filename', md.filename, 'content_type', md.content_type,
                   'size_bytes', md.size_bytes, 'preview_kind', md.preview_kind
               )) FROM sms_media md WHERE md.message_id = m.id), '[]'
           ) AS media
    FROM sms_messages m
    WHERE m.conversation_id = conv.cid
      AND m.company_id = $2
      -- cursor predicate per predicateModeFor('sms', cursor), tuple id cast ::uuid
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT $3
) sub ON true
```

Returns up to `limit × conversations.length` rows (bounded; merged/cut in JS). `has_more` contribution: the sms leg counts as "hit limit" when the TOTAL rows returned `>= limit` (covered by the `mergePage` rule — no special-casing needed). The existing `getMessages` (ASC, legacy Conversation consumers + legacy buildTimeline) stays UNTOUCHED.

Known legacy bug fixed by construction (do not "preserve" it): legacy `getMessages(limit:200)` is `ORDER BY created_at ASC LIMIT 200` — a >200-message conversation silently showed only the OLDEST 200. Reverse pagination reads newest-first.

### 5.5 Email leg — NEW DESC twins in `emailQueries`

`getTimelineEmailPageByContact(companyId, contactId, { limit, cursorPred })` and `getTimelineEmailPageByTimeline(companyId, timelineId, { limit, cursorPred })` — SAME SELECT list as the existing ASC pair (row-shape parity) + `ts`:

```sql
SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
       to_recipients_json, subject, body_text, body_html, snippet, gmail_internal_at,
       sent_by_user_email,
       (direction = 'outbound') AS is_outbound,
       to_char(COALESCE(gmail_internal_at, created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
FROM email_messages
WHERE company_id = $1 AND contact_id = $2 AND on_timeline = true
  -- cursor predicate per predicateModeFor('email', cursor), tuple id cast ::bigint,
  -- ts_expr = COALESCE(gmail_internal_at, created_at)
ORDER BY COALESCE(gmail_internal_at, created_at) DESC, id DESC
LIMIT $n
```

(`…ByTimeline` twin: `AND timeline_id = $2` instead of `contact_id` — serves contactless YELP timelines, idx from mig 165.) Existing ASC functions stay (legacy path). Leg selection mirrors legacy: `contact?.id` → by-contact, else `timeline?.id` → by-timeline.

### 5.6 Financial legs — windowed variants of the two inline queries

Only when `contact?.id && canViewFinancials` (gate unchanged). Estimates:

```sql
SELECT id, estimate_number AS reference, status, total, created_at AS occurred_at,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
FROM estimates
WHERE contact_id = $1 AND company_id = $2
  -- cursor predicate per predicateModeFor('estimate', cursor), tuple id cast ::bigint
ORDER BY created_at DESC, id DESC
LIMIT $3
```

Invoices: same + `amount_paid` in SELECT, `predicateModeFor('invoice', …)`. They are TWO legs (kinds 3 and 4) into `mergePage`.

### 5.7 Shared row mappers (extract from `buildTimeline`, behavior byte-identical)

Extract into local helpers used by BOTH paths: `mapSmsRow(conv, m)` (spread + conversation_id/from/to/media-parse), `projectEmailRow(row)` (the `emailMessages` mapping incl. `toTimelineBody`), `mapEstimateRow(r, contactId)` / `mapInvoiceRow(r, contactId)` (incl. the paid/partial classification). `formatCall` reused as-is. Paged path wraps each mapped object as `{ts: row.ts, id: <raw id>, data: mapped}` per leg; the sms leg resolves `conv` by `conversation_id` from a `Map` over the discovered conversations.

### 5.8 Page assembly invariant (FR-02)

Fetch up to `limit` rows per leg (sms: per conversation) → `mergePage` sorts DESC (pure) → cut to `limit` → `next_cursor` from the last emitted item → `has_more` per §4. Permission filtering (financial legs skipped) and tenancy happen at source-selection, BEFORE the cut: a page always contains exactly `limit` items visible to THIS user (fewer only on the final oldest page); a page is NEVER shrunk post-query. The strict total order guarantees no skipped and no duplicated items across page boundaries, including equal-timestamp runs.

---

## 6. Migration 168 (index-only; ships with the feature)

Next free number: **168** (167 = `technician_time_off`, applied on prod). **RECHECK `ls backend/db/migrations/` at build time** — parallel worktrees drift (precedent: 161).

`backend/db/migrations/168_timeline_revpage_call_page_index.sql`:

```sql
-- TIMELINE-REVPAGE-001: reverse-cursor page over a thread's parent calls.
-- COALESCE(started_at, created_at) is the canonical feed timestamp (matches the FE).
CREATE INDEX IF NOT EXISTS idx_calls_timeline_page
    ON calls (timeline_id, (COALESCE(started_at, created_at)) DESC, id DESC)
    WHERE parent_call_sid IS NULL;
```

`backend/db/migrations/rollback_168_timeline_revpage_call_page_index.sql`:

```sql
-- TIMELINE-REVPAGE-001 rollback
DROP INDEX IF EXISTS idx_calls_timeline_page;
```

Notes: `COALESCE` of two `timestamptz` columns is immutable → indexable. Existing `idx_calls_timeline_id` stays (other consumers). NO new indexes for sms (`idx_sms_msg_conversation_created` serves the backward scan), email (partials from migs 129/165 narrow the filter; volumes small), estimates/invoices (`idx_estimates_contact`/`idx_invoices_contact` partials). If the N1 EXPLAIN on the prod copy disagrees for email, an expression twin of 129/165 is the sanctioned follow-up — do not add it speculatively.

---

## 7. Frontend — data layer

### 7.1 `frontend/src/services/pulseApi.ts`

NEW method; DELETE `getTimeline` and `getTimelineById` after the hook rewrite (verified single consumer: `usePulseTimeline` → `usePulsePage`; `ContactDetailPanel` only navigates to the ROUTE; native tech app doesn't call these endpoints):

```ts
getTimelinePage: async (opts: {
    mode: 'timeline' | 'contact';
    key: number;
    before?: string;
    signal?: AbortSignal;
}): Promise<PulseTimelinePageResponse> => {
    const path = opts.mode === 'timeline'
        ? `/pulse/timeline-by-id/${opts.key}`
        : `/pulse/timeline/${opts.key}`;
    const response = await apiClient.get<PulseTimelinePageResponse>(path, {
        params: { limit: 20, ...(opts.before ? { before: opts.before } : {}) },
        signal: opts.signal,
    });
    return response.data;
},
```

### 7.2 `frontend/src/types/pulse.ts` — additive types

```ts
export type TimelinePageSrc = 'call' | 'sms' | 'email' | 'financial';

export interface TimelinePageItem {
    ts: string;                    // ISO-8601 UTC with microseconds — string, never parsed for ordering
    src: TimelinePageSrc;
    id: string;                    // envelope id (financial: 'estimate-<n>'/'invoice-<n>')
    data: any;                     // per-src legacy shape (raw call | SmsMessage | EmailTimelineItem | FinancialEvent)
}

export interface TimelinePage {
    items: TimelinePageItem[];     // newest→oldest
    next_cursor: string | null;
    has_more: boolean;
}

export interface PulseTimelineMeta {
    timeline_id: number | null;
    display_name: string | null;
    external_source: string | null;
    contact: any | null;           // contacts row + contact_emails: string[]
    conversations: SmsConversation[];
}

export interface PulseTimelinePageResponse {
    page: TimelinePage;
    meta?: PulseTimelineMeta;      // page 1 only
}
```

`PulseTimelineResponse` (legacy shape) may remain exported for documentation; the two functions that produced it are removed.

### 7.3 `frontend/src/hooks/usePulseTimeline.ts` — `useInfiniteQuery` rewrite

**queryKey decision: UNCHANGED — `['pulse-timeline', mode, key]`.** Verified: no other file reads/writes this key; no query persistence is configured (`persistQueryClient` absent), so the cached shape changing from a plain object to `InfiniteData` has zero cross-session/collision implications — all readers and writers of the key live in this one file after the rewrite.

```ts
useInfiniteQuery({
    queryKey: ['pulse-timeline', mode, key],
    queryFn: ({ pageParam, signal }) =>
        pulseApi.getTimelinePage({ mode, key, before: pageParam ?? undefined, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.has_more ? lastPage.page.next_cursor : undefined,
    enabled: !!key,
    staleTime: 30000,
})
```

- Direction convention: **`pages[0]` = newest; `fetchNextPage()` = load OLDER**. NO `getPreviousPageParam`, NO `maxPages`, no reversed-pages trickery — newest-side growth happens via `refreshNewestPage` (§7.4).
- React Query's AbortSignal flows into axios — rapid thread switching cancels in-flight requests (KEEP; this is existing behavior).
- Default `refetchOnWindowFocus` etc. are NOT overridden. Note (do not "fix"): a stale-window focus refetch on an infinite query re-runs all cached pages sequentially — each is a bounded 20-item query with stable cursors, strictly cheaper than today's full scan; accepted.

Derived values (all `useMemo`):

```ts
// 1) Flatten + dedupe by `src:id` — FIRST occurrence wins (pages[0] is freshest after union-merge).
// 2) Sort with the SERVER comparator (ts string DESC, kindRank ASC, id DESC — §3.4,
//    financial rank from the id prefix), then .reverse() → display order is the EXACT
//    reverse of the server total order (correct across page-boundary equal-ts runs).
const items: TimelinePageItem[] = ...;

// Decomposition (feeds usePulsePage derivations; data only):
const calls           = items.filter(i => i.src === 'call').map(i => i.data);
const messages        = items.filter(i => i.src === 'sms').map(i => i.data);
const emailMessages   = items.filter(i => i.src === 'email').map(i => i.data);
const financialEvents = items.filter(i => i.src === 'financial').map(i => i.data);

const meta = query.data?.pages?.[0]?.meta;   // page-1 payload; refreshed on every head refresh
```

Return shape:

```ts
return {
    items, calls, messages, emailMessages, financialEvents, meta,
    isLoading: query.isLoading, isError: query.isError,
    fetchOlder: query.fetchNextPage,
    hasOlder: !!query.hasNextPage,
    isFetchingOlder: query.isFetchingNextPage,
    refreshNewestPage,
};
```

The FE comparator helpers (`KIND_RANK`, financial-prefix kind derivation, digit/uuid id compare) are implemented locally in this file, mirroring §3.4 exactly.

### 7.4 `refreshNewestPage()` — SSE-scoped head refresh (FR-10, precise v5 mechanics)

v5 removed `refetchPage`; `invalidateQueries` on an infinite query refetches ALL cached pages sequentially — that is today's full-history reload and is FORBIDDEN on the SSE path. Instead:

```
refreshNewestPage(): Promise<void>   // single-flight via ref
1. If a refresh is already in flight for this key → return the in-flight promise.
2. fresh = await pulseApi.getTimelinePage({ mode, key })          // no `before` → newest 20 + meta
3. queryClient.setQueryData(['pulse-timeline', mode, key], old => {
     if (!old || old.pages.length === 0)
         return { pages: [fresh], pageParams: [null] };
     const oldHead = old.pages[0];
     // Union by `src:id`, FRESH copy wins (picks up call-status / transcript / delivery
     // updates for items in the head window), sorted DESC with the server comparator.
     const items = unionByKey(fresh.page.items, oldHead.page.items);
     const newHead = {
         page: {
             items,
             // KEEP the OLD head's boundary whenever an old head existed: the merged head's
             // oldest item IS the old head's oldest, so its next_cursor/has_more stay correct.
             // (fresh.page.next_cursor covers only the newest 20 and would skip/dup.)
             next_cursor: oldHead.page.next_cursor,
             has_more: oldHead.page.has_more,
         },
         meta: fresh.meta ?? oldHead.meta,   // adopt fresh meta — first outbound SMS creates a conversation
     };
     return { ...old, pages: [newHead, ...old.pages.slice(1)] };   // pageParams unchanged; pages[1..] untouched
   })
4. Errors: console.warn and swallow (SSE-triggered refresh must not toast); clear the in-flight ref in finally.
5. The in-flight ref is reset when mode/key changes (thread switch).
```

Loaded older pages NEVER refetch on SSE. Accepted v1 limitation (stated in requirements): a server-side change to an item living only in an older loaded page stays stale until the thread is reopened.

### 7.5 `frontend/src/hooks/usePulsePage.ts` — wiring

- Consume the new hook shape: `items`, decomposed arrays, `meta`, `fetchOlder/hasOlder/isFetchingOlder`, `refreshNewestPage`.
- `conversations` = `meta?.conversations || []`; `contact` = `meta?.contact || contactCalls[0]?.contact`; `contactCalls` = the decomposed `calls`. `display_name`/`external_source` stay unconsumed on this page (parity only).
- Derivations `lastUsedPhone`, `defaultTarget`, `hasActiveCall`, `derivedProxy`, `phone` keep their code; they now read the LOADED window — all are newest-biased (latest inbound / active call / newest conversation), so the loaded window (which always contains the newest items) is semantically equivalent.
- `callDataItems` is REMOVED (PulseTimeline converts call envelopes itself, §8); `messages/emailMessages/financialEvents` remain returned (derivations + compatibility).
- **SSE handlers (`useRealtimeEvents` options) — gates unchanged, action changes:**
  - `onCallUpdate`: same `parent_call_sid` skip + same contact/timeline gate; `refetchTimeline()` → `refreshNewestPage()`. `refetchContacts()` stays.
  - `onMessageAdded`: same `timelineId` gate logic (both branches); `refetchTimeline()` → `refreshNewestPage()`. `refetchContacts()` stays.
  - `onTranscriptFinalized`: `finalizeTranscript(e.callSid, e.text)` stays (in-place patch via the useLiveTranscript store); `refetchTimeline()` → `refreshNewestPage()`.
  - `onCallCreated`, `onContactRead`, `onGenericEvent`, `onTranscriptDelta` — untouched.
  - Live robot-call rows (OUTBOUND-CALL-TIMELINE-001 placement→live→finalize) keep working: they are calls in the head window; the DB row id is stable across the vapi→CallSid re-key, so the `src:id` union key holds.
- **Send path (FR-12):** in `handleSendMessage`, BOTH branches (email + SMS) replace `refetchTimeline()` with `await refreshNewestPage(); setScrollToBottomSignal(s => s + 1);`. New state: `const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0)` — returned. Error handling/toasts unchanged.
- `refetchTimeline` STAYS in the returned API as an alias for `refreshNewestPage` (one remaining consumer: `PulsePage.tsx:431` `CreateLeadJobWizard.onLeadCreated` — a head refresh delivers the new contact/lead via fresh `meta`; a brand-new lead has no pre-existing financial/email history that older loaded pages could be missing).
- Returned API adds: `items`, `hasOlder`, `isFetchingOlder`, `fetchOlder`, `scrollToBottomSignal`, `refreshNewestPage`. Everything else keeps its name and meaning.

---

## 8. Frontend — scroll mechanics (`PulseTimeline.tsx` + `PulsePage.css`)

Scroll container discovered as today: `endRef.current?.closest('.pulse-right-column')` (existing precedent in the file). The column contains (top→bottom): AR card → Lead/Contact/Wizard card → PulseTimeline → SmsForm card; it is the ONLY scroller on both breakpoints (mobile 'content' panel keeps `.pulse-right-column` scrolling — verified in PulsePage.css).

New props (replaces `calls`/`messages`/`financialEvents`/`emailMessages`):

```ts
interface PulseTimelineProps {
    items: TimelinePageItem[];        // ASC (exact reverse of server order) — from usePulsePage
    loading: boolean;                 // initial page load
    timelineKey?: string | number;
    hasOlder: boolean;
    isFetchingOlder: boolean;
    onLoadOlder: () => void;          // wraps fetchOlder
    scrollToBottomSignal?: number;    // bump → scroll to bottom (post-send)
}
```

Rendering per item: `src==='call'` → `<PulseCallListItem call={callToCallData(item.data)} />` (conversion memoized over `items`); `'sms'` → `<SmsListItem>`; `'email'` → `<EmailListItem>`; `'financial'` → `<FinancialEventListItem>`. Row wrappers/keys as today (`call-<id>`, `sms-<id>`, `email-<id>`, `fin-<id>` — envelope data ids). Bubble components UNTOUCHED.

CSS (in `PulsePage.css`):

```css
.pulse-right-column { overflow-anchor: none; }   /* add to the existing rule — Chrome's native
                                                    anchoring would double-compensate prepends;
                                                    Safari lacks it → manual compensation is the
                                                    one cross-browser path */
.pulse-feed-spinner-row {                        /* reserved-height sentinel/spinner row */
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}
```

### 8.1 Bottom anchor on open (FR-07)

- `anchoredRef` (boolean) resets to `false` on `timelineKey` change.
- `useLayoutEffect` on `[timelineKey, loading, items.length]`: when `!loading && !anchoredRef.current` → `container.scrollTop = container.scrollHeight`; set `anchoredRef.current = true`; `setIoEnabled(true)`. Runs PRE-PAINT → the feed never visibly renders top-anchored and then snaps (SC-01 "no flash").
- The IntersectionObserver attaches only AFTER anchoring (`ioEnabled` state flag) — prevents a spurious page-2 fetch during the first frame while the sentinel is momentarily in view.

### 8.2 nearBottom stick + ResizeObserver belt (FR-11 auto-stick, SC-04)

- `nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 120`, tracked on the container's `scroll` event; stored in BOTH a ref (logic) and state (pill visibility). Initial value `true`.
- A `ResizeObserver` on the feed content wrapper: while `nearBottomRef.current` → `requestAnimationFrame(() => container.scrollTop = container.scrollHeight)`. This also absorbs async media/image loads right after open.
- New-items effect: watch the newest item key (`items[items.length-1]` → `src:id`); when it CHANGES for the same `timelineKey`: `nearBottomRef.current ? scrollToBottom() : setHasNewActivity(true)`.

### 8.3 Top sentinel / spinner row + one-in-flight (FR-08)

- When `hasOlder`: render `<div className="pulse-feed-spinner-row">` as the FIRST feed row — it doubles as the IO sentinel, so its appearance never shifts layout (reserved 36px). Content: the existing small spinner (border `var(--blanc-line)` / top `var(--blanc-info)`, `spin` animation) ONLY while `isFetchingOlder`; empty otherwise.
- IO (root: the container, threshold 0.1) callback: `if (isIntersecting && hasOlder && !isFetchingOlder && ioEnabled) { prevScrollHeightRef.current = container.scrollHeight; onLoadOlder(); }` — at most ONE older-page request in flight (RQ's `isFetchingNextPage` is the guard; same pattern as the left list's `loadMoreRef`).
- Short content note (accepted, desirable): if the rendered feed is shorter than the viewport and `hasOlder`, the visible sentinel immediately triggers older loads until the viewport fills or history is exhausted.
- When `has_more=false` on page 1 (short thread): NO sentinel row, NO observer (FR-14).

### 8.4 Prepend scroll-position preservation (FR-08)

- `prevScrollHeightRef` is set ONLY right before `onLoadOlder()` (§8.3).
- `useLayoutEffect` on `[items, isFetchingOlder]`: when `!isFetchingOlder && prevScrollHeightRef.current != null` → `const delta = container.scrollHeight - prevScrollHeightRef.current; container.scrollTop += delta; prevScrollHeightRef.current = null;` and ALSO re-assert the same assignment inside a `requestAnimationFrame` (belt for iOS momentum scrolling — N2 verifies on a real 375px viewport).
- `delta` may be NEGATIVE (final page: sentinel row unmounts, −36px) — apply it unconditionally.
- This runs on fetch failure too (delta 0, ref cleared) — no stale compensation later.
- Items under the user's eyes DO NOT move on screen (SC-02).

### 8.5 Unified Jump-to-latest pill (FR-11) — REPLACES the band-aid button

Delete the existing fixed button and its `showJumpBtn` state/effect/handler (`PulseTimeline.tsx:39, 87-101, 169-185`). New pill in the SAME fixed slot (`position: fixed; bottom: 90px; right: 40px; z-index: 20` — 20 is well below `OVERLAY_Z.panel`=80, so the pill never paints over dialogs/sheets/bottom-sheets, which portal to body at 80+):

- Visible ⇔ `!nearBottom && items.length > 0`.
- `hasNewActivity` state: set by §8.2 when new items arrive while `!nearBottom`; cleared when `nearBottom` becomes true and on click.
- Indication: an 8px dot (`background: var(--blanc-danger)`) absolutely positioned at the pill's top-right corner when `hasNewActivity`; label stays `Jump to latest` (aria-label `Jump to latest — new activity` when lit).
- Click → `container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })`; clear `hasNewActivity`.
- Styling otherwise as the current button (`var(--blanc-ink-1)` bg, white text, rounded-full, shadow). Exactly ONE such affordance exists after this change.

### 8.6 `scrollToBottomSignal` (FR-12)

Effect on `[scrollToBottomSignal]` (skip initial 0): `container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })`. Fired by `usePulsePage` after a successful send + head refresh → the just-sent message is visible.

### 8.7 Date separators (FR-09)

Keep the existing single-pass logic (day-key change inserts `<DateSeparator>`), now over the merged LOADED ASC window; item timestamp for the day key = `new Date(item.ts)` (envelope ts; display-only `Date` use — allowed). By construction: one separator per day-transition, no dupes/misplacements across prepends — the separator always sits above the OLDEST loaded item of its day and moves up as older same-day items load in. **Accepted, stated behavior:** the oldest loaded page boundary shows the day label of what is loaded; a day's separator may be missing for that day's yet-unloaded older items until the next page loads.

### 8.8 Empty / short / loading states (FR-14)

- `loading && items.length === 0` → the existing centered spinner block (unchanged).
- `!loading && items.length === 0` → the existing empty state (`No activity found for this contact`), unchanged; cards + composer render as today.
- `has_more=false` on page 1 → full render, zero pagination affordances; still bottom-anchored (a short feed doesn't scroll — anchor is a no-op).

### 8.9 Mobile parity (FR-15)

Identical DOM/logic — the mobile 'content' panel IS `.pulse-right-column` (its own scroller per PulsePage.css `@max-767px`). No separate mobile data path. List⇄content panel switching untouched. iOS momentum: rAF re-asserts in §8.1/§8.4 are the belts; N2 verifies at 375px.

### 8.10 `PulsePage.tsx` wiring

```tsx
<PulseTimeline
    items={p.items}
    loading={p.timelineLoading}
    timelineKey={p.timelineId || p.contactId}
    hasOlder={p.hasOlder}
    isFetchingOlder={p.isFetchingOlder}
    onLoadOlder={p.fetchOlder}
    scrollToBottomSignal={p.scrollToBottomSignal}
/>
```

---

## 9. Sticky Action-Required bar (FR-13)

**`PulsePage.tsx`** — the AR card wrapper (currently `className="pulse-card pulse-card-visible-overflow"` at :287) gains ONE class:

```tsx
<div
    className="pulse-card pulse-card-visible-overflow pulse-ar-sticky"
    style={{ backgroundColor: isSnoozed ? 'var(--blanc-surface-muted)' : '#fff7ed' }}
>
```

Everything INSIDE the card — Action Required/Snoozed chip, reason, due, task text, Mail-Secretary reason block, Done/Snooze/Assign, `TaskActionButtons` (OUTBOUND-PARTS-CALL-BTN) — is byte-identical. When no open task exists nothing renders (unchanged).

**`PulsePage.css`** — add:

```css
/* TIMELINE-REVPAGE-001: AR bar pinned while the thread has an open task.
   Works on both breakpoints because .pulse-right-column is the scroll container.
   z=5: above in-flow content (accent stripes use z-1), below the jump pill (20)
   and every overlay (OVERLAY_Z.panel = 80+; dialogs/sheets portal to body). */
.pulse-ar-sticky {
    position: sticky;
    top: 0;
    z-index: 5;
}
```

The card's own opaque background (`#fff7ed` / `var(--blanc-surface-muted)`) prevents show-through. The 16px column gap shows the canvas under the stuck card's bottom edge while items scroll behind — accepted flat-canvas look (N2 visual check). `pulse-card-visible-overflow` stays (its dropdowns portal anyway).

---

## 10. Scenarios

### S-01 — Open a long thread (SC-01)
- **Pre:** thread with 500+ items; user has `pulse.view`.
- **Steps:** open `/pulse/timeline/:id` → `usePulseTimeline` fires page-1 (`?limit=20`) → guards → `buildTimelinePage` (discovery + 5 bounded legs + merge) → 20 envelopes + meta → render → pre-paint bottom anchor (§8.1).
- **Expected:** newest 20 items + composer visible with zero scrolling and no top-anchored flash; AR bar (if open task) pinned at column top; no multi-second full-history load (calls LATERALs ran for ≤20 rows).

### S-02 — Read history (SC-02)
- Scroll up → sentinel intersects → spinner spins in the reserved row → older 20 prepend → `scrollTop += scrollHeight delta` → items under the cursor don't move; repeat until `has_more=false` → sentinel disappears → continuing up reaches the Lead/Contact card (and wizard where applicable) above the feed.

### S-03 — New inbound while scrolled up (SC-03)
- SSE `message.added` (matching timeline) → `refreshNewestPage()` → head union grows → newest-item key changes while `!nearBottom` → reading position unmoved; pill shows the new-activity dot → click → smooth scroll to bottom, dot clears.

### S-04 — At/near the bottom (SC-04)
- Within 120px of the bottom when a new item lands (inbound SMS, live robot-call row, email) → newest-item effect + ResizeObserver belt scroll the feed to show it.

### S-05 — Send (SC-05)
- Composer send (SMS or email) → send API → `await refreshNewestPage()` (fresh meta includes a conversation created by a FIRST outbound SMS → targetConv resolvable) → `scrollToBottomSignal++` → feed scrolls to bottom; sent message visible.

### S-06 — Short thread (SC-06)
- 7 items → page 1 `has_more=false` → all 7 render, NO sentinel/spinner, still bottom-anchored, composer visible.

### S-07 — Restricted users (SC-07)
- No `financial_data.view`: financial legs are never queried; pages are still exactly 20 items of the remaining kinds (filter-before-cut). Provider `assigned_only`: same 404 semantics as today (foreign/orphan threads never reach `buildTimelinePage`).

### S-08 — Mobile (SC-08)
- Same behaviors in the mobile 'content' panel (same column, same code); panel switching and softphone-disabled-on-mobile untouched.

---

## 11. Edge cases

- **E-1 Equal timestamps across kinds at a page boundary:** the three predicate modes (§3.5) make the boundary exact — later-ranked kinds at the SAME ts use `lte` and re-emit only rows after the cursor id/tuple; no dup, no skip (jest + N3).
- **E-2 Cursor pointing at a deleted item:** predicates are strictly-relative to the cursor VALUES, not row existence — the next page continues correctly; no error.
- **E-3 Thread with ONLY financial events for a non-permitted user:** all queried legs empty → page 1 `{items:[], has_more:false}` → existing empty state; cards + composer render as today. If OTHER kinds exist, pages are full of them (never short pages).
- **E-4 Contactless conv-id timeline (YELP-TIMELINE-DEDUP-001):** contact null → financial legs skipped, sms discovery usually finds nothing, email leg keyed by `timeline_id`, calls by timeline id; `meta.contact = null`, `display_name`/`external_source` from the timeline row. Pagination works by construction (FR-04).
- **E-5 Anonymous timelines:** composer hidden (existing `isAnonymousPhone` logic untouched) — bottom anchor still applies; the feed is simply the last content unit.
- **E-6 Rapid thread switching:** per-key queries + AbortSignal cancellation (KEEP); `anchoredRef`/`ioEnabled`/`hasNewActivity`/`prevScrollHeightRef` reset on `timelineKey` change; `refreshNewestPage`'s in-flight ref resets on key change.
- **E-7 Exactly-20 thread:** page 1 `has_more=true` → sentinel renders → next fetch returns the empty page → `has_more=false` → sentinel unmounts; compensation applies the −36px delta; assert no visual flicker (N2).
- **E-8 First outbound SMS creates the conversation:** send-triggered head refresh adopts `fresh.meta` → `meta.conversations` fresh → send path's `targetConv` resolution works (N2 smoke).
- **E-9 Live robot-call rows:** placement→live→finalize arrive via `call.updated` SSE → head refresh union by `src:id`; the DB call id is stable across the vapi→CallSid re-key → the row updates in place. Live transcript deltas keep flowing through the useLiveTranscript store (unchanged).
- **E-10 Update to an item living only in an older loaded page** (e.g., transcript finalized for an old call): head refresh won't contain it → stays stale until reopen — ACCEPTED v1 (FR-10).
- **E-11 Valid-format cursor with a future ts / arbitrary values:** predicates are well-defined for any valid cursor — returns whatever is strictly after it; no error, no leak (company_id on every leg).
- **E-12 `limit` clamping:** `limit=50` ok; `limit=999` → clamped to 50; `limit=0`/`-1`/`abc` → 400.
- **E-13 Straggler legacy consumer:** any no-param request keeps getting the byte-identical legacy shape (defensive back-compat; verified consumers are migrated in this change).
- **E-14 Calls with NULL `started_at`:** canonical ts falls back to `created_at` (COALESCE) — envelope/cursor ordering well-defined. Legacy mode keeps `started_at DESC NULLS LAST` array order (byte-identity); FE always re-sorted anyway.
- **E-15 SMS `media`:** per-row `json_agg` subselect bounded by the page window; string→`JSON.parse` mapping identical to legacy.
- **E-16 `before` on a thread whose history got shorter than a page:** returns fewer than 20 with `has_more=false` — FE stops; no special casing.

---

## 12. Error handling

| Situation | Reaction |
|---|---|
| Backend: invalid `limit` / invalid or orphan `before` | `400 {"error":"Invalid limit"}` / `400 {"error":"Invalid cursor"}` (§2.4) |
| Backend: tenant/provider miss | `404` — messages identical to today (no data disclosure; foreign == missing) |
| Backend: leg SQL error | existing route catch → `500 {"error":"Failed to fetch timeline"}`; nothing partial is sent |
| FE: page-1 load error | React Query `isError`; feed area keeps the existing loading→empty semantics (no new error UI in v1); RQ default retries apply |
| FE: `fetchOlder` rejection | RQ retry/backoff; sentinel stays; `prevScrollHeightRef` cleared with delta 0 (§8.4); user can scroll to re-trigger |
| FE: `refreshNewestPage` fetch error | `console.warn` + swallow (no toast — SSE-triggered); next SSE event retries naturally |
| FE: send error | existing toasts (`sonner`) unchanged; NO scroll-to-bottom on failure (signal bumps only after a successful refresh) |

---

## 13. Security & data isolation

- All Pulse routes remain behind `authenticate → requireCompanyAccess` (server.js:156) + router-wide `requirePermission('pulse.view')`.
- `company_id` comes ONLY from `req.companyFilter?.company_id` and appears explicitly on EVERY leg: calls inner subquery, conversation-discovery scans, sms LATERAL, email twins, estimates, invoices (LIST-PAGINATION-001 cross-tenant leak is the cautionary precedent — one missing predicate leaked SMS across tenants).
- Tenant misses and provider `assigned_only` misses 404 BEFORE any feed SQL runs (guards precede the mode branch) — foreign ids indistinguishable from missing.
- `financial_data.view` gate expression is byte-identical to legacy; absence ⇒ the financial legs are never queried (excluded from the stream, not blanked).
- The cursor is opaque but UNTRUSTED: strict validation (§3.1) + parameterized SQL only — no string interpolation of cursor values anywhere.
- No new permission keys; no RBAC catalog change.

---

## 14. Invariants

- **INV-1.** `GET /api/pulse/timeline-by-phone` (route code + response) and its consumers (`useSoftPhoneWidget.ts`, `OpenTimelineButton.tsx`, `AppLayout.tsx`) — zero diff.
- **INV-2.** `ConversationPage.tsx` + `components/conversations/*` — zero diff (`CreateLeadJobWizard` included).
- **INV-3.** `getUnifiedTimelinePage` (left list) — zero diff; left-list UX untouched.
- **INV-4.** No-`limit` responses of the two detail endpoints are byte-identical to pre-feature (same arrays, same order, same fields) — the refactor to shared helpers is behavior-neutral; the only SQL delta is the result-neutral `company_id` predicate on the calls helper (§2.5).
- **INV-5.** Item DTO parity: `formatCall` (incl. `gemini_summary`, `playback_url`, `answered_by`), sms mapping, email projection (`toTimelineBody`/`body_html`), financial mapping — additive-only; the envelope is the ONLY new wrapper; bubble components untouched.
- **INV-6.** SSE event names/payloads and emission points — zero diff; only Pulse-page consumption changes (`refetchTimeline` full-invalidate is gone from the SSE path).
- **INV-7.** Composer flows (`SmsForm.tsx`, channel routing, send APIs) untouched except the post-send `refreshNewestPage` + scroll signal in `usePulsePage`.
- **INV-8.** AR bar content/actions byte-identical; the ONLY presentation change is the sticky wrapper class + CSS (never paints over overlays: z=5 < OVERLAY_Z.panel=80).
- **INV-9.** Exactly ONE Jump-to-latest affordance exists (the old fixed button is deleted).
- **INV-10.** Merging, permission filtering and tenant/provider scoping happen BEFORE the 20-cut; pages are never shrunk post-query; the total order `(ts DESC, k ASC, id DESC)` is byte-consistent across SQL, JS merge, cursor, and (reversed) FE display.
- **INV-11.** Cursor/envelope timestamps are µs `to_char` strings end-to-end; no JS `Date` on the ordering path.
- **INV-12.** `convQueries.getMessages` and the existing ASC email functions stay untouched (legacy consumers).
- **INV-13.** `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`, sseManager — zero diff.
- **INV-14.** No virtualization; no `maxPages`; pages accumulate in memory for the session (accepted v1).
- **INV-15.** Migration 168 is index-only (no schema/data reshaping) and idempotent (`IF NOT EXISTS`), with a rollback file.

---

## 15. Verification (binding for the Tester agent)

### 15.1 Pure-module jest — `tests/timelinePage.test.js` (NEW)

Repo convention: the jest suite lives at the repo ROOT `tests/` (166 existing files; root `package.json` runs jest with `testPathIgnorePatterns` for worktrees). The architecture doc wrote `backend/tests/` — use `tests/` (root); jest discovers it either way, root is the house pattern.

- **T-1 cursor roundtrip:** `encodeCursor→parseCursor` identity for digit-id, uuid-id, and financial (k=3/4, numeric id) cursors.
- **T-2 malformed cursor rejection:** non-base64url; base64 of non-JSON; `v:2`; `k:-1`/`k:5`/`k:'1'`; ts with 3 fractional digits (ms) or no `Z`; id with illegal chars (`../`, `;`, 41 chars); empty string; each throws the typed error.
- **T-3 compareDesc:** equal-ts run across all 5 kinds orders `call, sms, email, estimate, invoice` (rank ASC within the same µs); digit ids compare numerically (`"9"` vs `"10"`); uuids compare as lowercase strings; µs difference in ts dominates.
- **T-4 predicateModeFor matrix:** all 5 kinds × cursor k∈0..4 → `lt`/`lte`/`tuple` exactly per §3.5; `null` cursor → `null`.
- **T-5 mergePage cut + next_cursor:** legs summing >20 → exactly 20 items, DESC order, `nextCursor` = last emitted item's `{ts,k,id}` (verify at an equal-ts boundary: cursor k = the internal kind of item #20, raw id without prefix).
- **T-6 mergePage has_more edges:** a leg with exactly `limit` rows and zero leftover → `hasMore=true`; all legs `< limit` and leftover 0 → `hasMore=false, nextCursor=null`; leftover >0 → `true`.
- **T-7 permission-filtered merge:** no estimate/invoice legs passed → page still full (20) from remaining kinds.
- **T-8 empty legs:** → `{items:[], nextCursor:null, hasMore:false}`.
- **T-9 sms unsorted-leg input:** per-conversation concatenated rows out of global order → mergePage still emits correct DESC order.
- **T-10 simulated page-walk (pure):** build a synthetic 100-item multi-kind stream with µs ties; walk `mergePage` with cursors 20-at-a-time; concatenation == full DESC sort; no dup/skip (set equality + order).

### 15.2 Route-level jest (mocked db) — validation branch only

- **T-11:** `?limit=abc|0|-5` → 400 `Invalid limit`; `?before=<junk>` (with limit) → 400 `Invalid cursor`; `?before=<valid>` WITHOUT limit → 400 `Invalid cursor`.
- **T-12:** no query params → legacy `buildTimeline` branch taken (spy); `?limit=20` → paged branch taken. Router-level `requirePermission('pulse.view')` line untouched (401/403 semantics ride the existing middleware — asserted by the existing auth-route pattern, not re-mocked here).

### 15.3 N3 real-DB harness — `backend/scripts/verify-timeline-revpage.mjs` (NEW; run against a prod-DB copy)

Mocked jest is NOT enough (LIST-PAGINATION-001 lesson). The script connects to the DB copy (env `DATABASE_URL`), imports the route's leg builders + pure module (or reimplements the exact SQL), and asserts:

- **H-1 page-walk vs legacy diff (heaviest thread):** walk pages until `has_more=false`; the concatenated envelope stream must equal the legacy full-feed item SET exactly (calls+sms+emails+financials by `src:id` — no dup, no skip), and its order must be a valid DESC total order; log a WARNING diff of SMS ordering vs legacy `date_created_remote` order (accepted divergence — §3.2 — must be ingest-latency-bounded, i.e., no cross-day reorders).
- **H-2 equal-timestamp boundary:** find (or seed) an equal-µs run spanning a page cut; assert no dup/skip across the boundary.
- **H-3 permission fullness:** run with financial legs excluded → every non-final page has exactly 20 items.
- **H-4 provider scope:** foreign/orphan thread under an `assigned_only` scope resolves to the 404 path (assert `isContactVisibleToProvider` gating decision), and leg SQL is never reached.
- **H-5 cross-tenant isolation:** foreign-company timeline id → `getTimelineInCompany` null (404 path); run every leg with a WRONG company_id → 0 rows (no foreign rows ever).
- **H-6 contactless email-only timeline (YELP):** pages serve the email leg only; meta contactless fields correct.
- **H-7 cardinality edges:** threads with exactly 20 / fewer than 20 / zero items → `has_more` sequence `true→(empty,false)` / `false` / `false`.
- **N1:** `EXPLAIN (ANALYZE)` the calls leg (must use `idx_calls_timeline_page`, inner LIMIT bounding LATERALs) and the sms leg (backward scan on `idx_sms_msg_conversation_created`) on the heaviest prod-copy timeline; record before/after timings vs the legacy calls query.
- House gotcha: scripts are NOT in the Docker image — `scp` + `docker cp` to run on a server-side copy.

### 15.4 Build gates

- Backend: `npm test` green (root).
- Frontend: `cd frontend && npm run build` (tsc -b; prod Docker is stricter — `noUnusedLocals`: remove `callDataItems` and any now-unused imports cleanly).

### 15.5 N2 manual real-browser checklist (live preview; desktop AND 375px mobile)

1. Open a long thread → lands at bottom, composer visible, NO top-anchored flash; AR bar pinned (thread with an open task).
2. Scroll up → reserved spinner row, older batch prepends, visible items DO NOT shift; repeat to exhaustion → Lead/Contact card reachable.
3. While scrolled up, trigger an inbound (SMS/webhook or second session) → position unmoved; pill lights with dot; click → bottom, dot clears.
4. At bottom, new item arrives → auto-stick shows it.
5. Send SMS and email → feed scrolls to bottom; first-outbound-SMS case: conversation created and send targets resolve (fresh meta).
6. Short thread (<20) → no pagination UI, bottom-anchored. Exactly-20 thread → one extra empty fetch, no flicker.
7. Sticky AR bar: scroll items behind it; open Done/Snooze/Assign dropdowns and TaskActionButtons — all work; open a dialog/sheet → AR bar never paints over it.
8. Contactless YELP thread and Anonymous thread render and paginate; empty thread shows the empty state.
9. Mobile 375px: all of the above in the 'content' panel; iOS momentum scroll during prepend keeps position (rAF belt); pill placement clears the bottom nav.
10. Left list, softphone widget, ConversationPage unaffected (spot-check).

---

## 16. Files to change / new files (exact paths)

Backend:
- `backend/src/routes/pulse.js` — paged branch in both GET handlers; NEW `buildTimelinePage()`; extract shared helpers (`fetchTimelineCalls`, `mapSmsRow`, `projectEmailRow`, `mapEstimateRow`, `mapInvoiceRow`) reused by the behavior-identical `buildTimeline()`.
- `backend/src/services/timelinePage.js` — NEW pure module (§4).
- `backend/src/db/conversationsQueries.js` — NEW `getMessagesPageDesc` (§5.4); `getMessages` untouched.
- `backend/src/db/emailQueries.js` — NEW `getTimelineEmailPageByContact` / `getTimelineEmailPageByTimeline` (§5.5); ASC pair untouched.
- `backend/db/migrations/168_timeline_revpage_call_page_index.sql` + `rollback_168_timeline_revpage_call_page_index.sql` (§6).
- `tests/timelinePage.test.js` — NEW (§15.1); optional `tests/pulseTimelinePageRoute.test.js` for §15.2.
- `backend/scripts/verify-timeline-revpage.mjs` — NEW N3 harness (§15.3).

Frontend:
- `frontend/src/services/pulseApi.ts` — NEW `getTimelinePage`; DELETE `getTimeline`/`getTimelineById`.
- `frontend/src/types/pulse.ts` — additive types (§7.2).
- `frontend/src/hooks/usePulseTimeline.ts` — `useInfiniteQuery` rewrite + `refreshNewestPage` + flatten/dedupe/sort + decomposition + meta (§7.3–7.4).
- `frontend/src/hooks/usePulsePage.ts` — new hook consumption; SSE handlers → `refreshNewestPage`; send path + `scrollToBottomSignal`; `refetchTimeline` alias (§7.5).
- `frontend/src/components/pulse/PulseTimeline.tsx` — envelope-driven rendering; sentinel/spinner row; bottom anchor; prepend compensation; nearBottom/auto-stick; unified pill (§8).
- `frontend/src/pages/PulsePage.tsx` — `pulse-ar-sticky` class; new PulseTimeline props (§8.10, §9).
- `frontend/src/pages/PulsePage.css` — `.pulse-ar-sticky`; `overflow-anchor: none`; `.pulse-feed-spinner-row` (§8, §9).

NOT touched (protected — verify zero diff): `src/server.js`, `GET /api/pulse/timeline-by-phone` + softphone/AppLayout consumers, `ConversationPage.tsx` + `components/conversations/*`, `getUnifiedTimelinePage`/left-list SQL, `calls.js` mark-read/unread, `SmsForm.tsx`, `authedFetch.ts`/`apiClient` plumbing, `useRealtimeEvents.ts`, sseManager event names/payloads, `DateSeparator.tsx`, `PulseCallListItem`/`SmsListItem`/`EmailListItem`/`FinancialEventListItem`, `permissionCatalog.js`.
