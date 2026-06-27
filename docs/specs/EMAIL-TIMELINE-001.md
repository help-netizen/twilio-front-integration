# EMAIL-TIMELINE-001 — Email in the contact timeline (send + receive) — Functional Spec

Source of truth: `docs/requirements.md › EMAIL-TIMELINE-001` (FR/AC numbering) and `docs/architecture.md › EMAIL-TIMELINE-001 — design` (the seam, migration 129, files). This spec turns that design into precise, testable behavior + contracts. It deliberately **reuses EMAIL-001** (see `docs/specs/EMAIL-001-…md`) and never rebuilds Gmail OAuth/token/MIME/history logic.

## Overview

Wire inbound + outbound email into the Pulse contact timeline (`GET /api/pulse/timeline/:contactId`), behind a **`MailProvider`** abstraction so the timeline/exchange layer depends on an interface (Gmail today) and not on `googleapis`. Inbound email from a known contact appears as a left-aligned timeline bubble and raises unread exactly like inbound SMS; the agent replies-in-thread or initiates a new thread from the same composer by picking an email in the "To" selector. Near-real-time inbound is delivered by Gmail `users.watch` → Google Pub/Sub push, with the existing 5-minute poll kept as reconciliation. The standalone EMAIL-001 `/email` inbox is unchanged.

**The seam (architectural invariant, AC-12):** `emailTimelineService` and `buildTimeline` import **only** the `MailProvider` interface / `providerRegistry` and `emailQueries`. They MUST NOT import `googleapis`, `emailService`, `emailSyncService`, or `emailMailboxService` directly. All Gmail specifics live in `GmailProvider` + EMAIL-001 services.

---

## 1. `MailProvider` interface contract

File: `backend/src/services/mail/MailProvider.js` — a base class with throwing stubs + JSDoc contract; `GmailProvider extends MailProvider`. `providerRegistry.get(companyId)` returns the provider bound to the company's mailbox (`email_mailboxes.provider`; v1 always `GmailProvider`). All methods are tenant-scoped by `companyId` and **safe-fail** (see error semantics).

### `getConnectionStatus(companyId) → { connected: boolean, status: string, email_address: string|null }`
- Source for the composer CTA (FR-UI-3) and the outbound send guard.
- `status ∈ { 'connected','reconnect_required','disconnected','sync_error', null }` (mirrors EMAIL-001 mailbox status; `null`/`connected:false` when no mailbox row).
- Gmail impl: delegates to `emailMailboxService.getMailboxStatus(companyId)`.
- Never throws for "no mailbox" — returns `{ connected:false, status:null, email_address:null }`.

### `startWatch(companyId) → { history_id: string, expires_at: ISO8601 }`
- Registers provider push for INBOX and **persists** the cursor + expiry to `email_mailboxes.watch_history_id` / `watch_expires_at`.
- Gmail impl: `gmail.users.watch({ userId:'me', requestBody:{ topicName: GMAIL_PUBSUB_TOPIC, labelIds:['INBOX'], labelFilterAction:'include' } })`, then writes the returned `historyId` + `expiration` via `emailQueries.updateWatchState`.
- Idempotent: calling twice re-arms and overwrites the stored cursor/expiry; never creates a second mailbox.

### `renewWatch(companyId)` / `stopWatch(companyId) → void`
- `renewWatch`: same as `startWatch` (Gmail `users.watch` is idempotent re-arm) — used by the renewal scheduler.
- `stopWatch`: tear down on disconnect. Gmail: `gmail.users.stop({ userId:'me' })`; clears `watch_history_id`/`watch_expires_at`. Safe-fail (logs) if already stopped.

### `handlePushNotification(payload) → { companyId: string, cursor: string } | null`
- **Decode only** — provider-specific verification (OIDC/token) happens in the **route** (`email-push.js`), not here.
- Gmail impl: base64-decode the Pub/Sub `message.data` → `{ emailAddress, historyId }`, then resolve the company/mailbox by `emailAddress` (`emailQueries.getMailboxByEmail`, company-scoped by the resolved row). Returns `{ companyId, cursor: historyId }`.
- Returns `null` (no throw) when the address resolves to no connected mailbox — the route still fast-acks 200 (a stale/foreign push is not our error).

### `pullChanges(companyId, sinceCursor) → { messages: NormalizedInboundMessage[], cursor: string }`
- Runs the provider's history walk **and the existing thread hydration so the inbox stays populated**, then yields a provider-neutral array of the messages touched since `sinceCursor`, plus the new cursor to persist.
- Gmail impl: same semantics as `emailSyncService.syncIncrementalHistory` (history.list → affected threads → `importGmailThread`), exposed via a new exported helper `emailSyncService.pullChangesNormalized(companyId, sinceCursor)` that returns the per-message `NormalizedInboundMessage[]` (today's `syncIncrementalHistory` only re-imports threads and returns a count; the normalized helper is additive and does not change the inbox-facing checkpoint behavior).
- On a Gmail **history-gap** (`404`/invalid `historyId`) it falls back to the existing bounded backfill and returns the backfilled messages normalized (so a gap self-heals onto the timeline).

### `sendMessage(companyId, { to, subject, body, inReplyTo, references, providerThreadId, userId, userEmail }) → { provider_message_id, provider_thread_id }`
- **Reply** when `providerThreadId` (the **local** `email_threads.id` of the contact's most-recent thread) is present; else **initiate** a new thread.
- Gmail impl: present → `emailService.replyToThread(companyId, providerThreadId, { to, subject, body, userId, userEmail })` (subject defaults to `Re: <thread.subject>`, `In-Reply-To`/`References` from the thread's last message — existing behavior). Absent → `emailService.sendEmail(companyId, { to, subject, body, userId, userEmail })` (new thread). v1 sends **no `files`**.
- Surfaces the EMAIL-001 `reconnect_required` 409 (`error.statusCode = 409`) unchanged — the timeline route maps it to a 409.

### `NormalizedInboundMessage` shape (the ONLY shape `emailTimelineService` consumes)
```
{
  provider_message_id : string,   // Gmail message id; unique with company_id (079)
  provider_thread_id  : string,   // Gmail thread id
  message_id_header   : string,   // RFC Message-ID
  in_reply_to_header  : string|null,
  references_header   : string|null,
  from_email          : string,   // normalized lower-case in matching, raw kept here
  from_name           : string|null,
  to                  : string[],
  subject             : string|null,
  body_text           : string,   // plain text as stored; quote-stripping is a projection step, NOT applied here
  snippet             : string|null,
  internal_at         : ISO8601,  // Gmail internalDate → email_messages.gmail_internal_at
  labelIds            : string[], // e.g. ['INBOX'] / ['SENT'] / ['DRAFT']
  is_outbound         : boolean   // from === mailbox address OR direction computed outbound
}
```
No Gmail types leak above the provider. `body_text/html` are stored intact on `email_messages` for the inbox; the timeline derives its display body by quote-stripping `body_text` at read/projection time and never mutates the stored row.

### Error / safe-failure semantics
- Provider methods **never crash the push route or the poll tick**. `pullChanges`/`handlePushNotification`/watch methods catch provider errors, log with `companyId`, and return empty/`null` so the caller fast-acks and the poll reconciles later.
- `sendMessage` is the one method allowed to **throw** (it is called from an authed request that must surface failures): `reconnect_required` → 409; mailbox missing/disconnected → 409; transport error → 502/500 per the route.

---

## 2. Inbound push endpoint — `POST /api/email/push/google`

### Request shape (Google Pub/Sub push envelope)
```json
{
  "message": {
    "data": "<base64( {\"emailAddress\":\"support@company.com\",\"historyId\":\"987654\"} )>",
    "messageId": "12345",
    "publishTime": "2026-06-26T10:00:00Z"
  },
  "subscription": "projects/<proj>/subscriptions/gmail-inbound-push"
}
```

### Mounting + body parsing (load-bearing)
- Mounted in **`src/server.js` BEFORE `express.json`**, with `express.raw({ type: '*/*' })`, exactly like `stripePaymentsWebhook` at `src/server.js:75`. Pub/Sub sends `application/json`, but raw body is required so OIDC/token verification (and JSON parse) happen on the unmodified payload.
- It is the **only** email route mounted on the raw-body, pre-JSON path; all other `/api/email/*` routes stay on the authed JSON router.

### Verification (FR-IN-2 / FR-SEC-2 / AC-10)
Two supported modes (configured on the Pub/Sub subscription):
1. **Shared token** (default, simplest): subscription push URL includes `?token=<GMAIL_PUSH_VERIFICATION_TOKEN>`. The route compares the query token to the env secret in constant time. Mismatch/missing → **401**, no work.
2. **OIDC bearer JWT**: subscription configured with a service-account OIDC token. The route verifies the JWT signature against Google's public keys, checks `aud` = our endpoint URL and `email` = `GMAIL_PUBSUB_SA_EMAIL`. Invalid → **403**, no work.
- Verification runs **before** any DB access or body decode-to-action. There is **no `company_id` from a session** — tenant context is derived only from the verified payload's `emailAddress`.

### Fast-ack + async ingest (idempotency / no retry storm)
- On valid verification the route **returns 200 immediately** (empty body), then schedules processing via `setImmediate` (detached). Pub/Sub at-least-once means a slow handler triggers retries → we never block on processing.
- Even if async processing throws, the HTTP response is already 200 (Pub/Sub does not retry); the error is logged and the 5-minute poll reconciles.
- Async path: `provider.handlePushNotification(payload)` → `{ companyId, cursor }` → `emailTimelineService.ingestForCompany(companyId)`.
- **Idempotency** rests on the existing unique `(company_id, provider_message_id)` on `email_messages` (079): re-delivered pushes re-walk history but linkage is an upsert/no-op, so no duplicate timeline rows and no double unread (AC-1, AC-11).

---

## 3. Inbound processing pipeline (the load-bearing behavior)

Triggered by **both** the push (`ingestForCompany`) and the 5-minute poll (`syncIncrementalHistory`), sharing one function `emailTimelineService.linkInboundMessage(normalized, companyId)`. Steps (a)–(d) run per `NormalizedInboundMessage`.

### (a) Exclusion filter — drop non-INBOX-external (FR-IN-3, AC-2)
A message is **excluded** (no timeline, no unread, return early) when **either**:
- `msg.is_outbound === true` (from-address equals the mailbox address), **or**
- `msg.labelIds ∩ { 'SENT', 'DRAFT' } ≠ ∅`.

**Draft activity never creates timeline entries (explicit):** composing, saving, or editing a Gmail draft addressed to a contact emits `messagesAdded`/`labelsAdded` history whose message carries the `DRAFT` label. Every such event is dropped here → **zero** timeline activity and **zero** unread for that contact, no matter how many times the draft is edited (the "draft-edit push storm" dies at this filter). The agent's own **sent** timeline emails are projected by the **send path** (§5, which stamps `on_timeline`), never by inbound ingest — so there is no double-count. A self-send (agent emails the shared mailbox from the mailbox's own address) is excluded by `is_outbound`.

**Outbound projection (EMAIL-TIMELINE-001 follow-up — Gmail-sent replies):** the §5 send path only stamps emails sent *from the composer*. A reply the agent sends **directly from Gmail** still needs to appear (right-aligned) so the contact's timeline shows both sides. `emailTimelineService.linkOutboundMessage(companyId, msg)` mirrors `linkInboundMessage` with three deliberate differences: (1) it **matches by recipient** — `extractRecipientEmails(msg)` reads `msg.to` (push) or `to_recipients_json` (stored row; tolerates a JSON string) and runs `findEmailContact` per address, first match wins; (2) it **excludes drafts** via `labelIds ∩ {DRAFT}` when labels are present (the same hard rule as inbound — draft activity never projects); (3) it sets **no unread / no Action-Required** (the agent sent it), but **does** publish the `message.added` SSE so the bubble appears live. Routing: `ingestPushNotification` sends `is_outbound`/`SENT` messages to `linkOutboundMessage` (inbound otherwise); `ingestPolledForCompany` adds a second reconciliation pass over `emailQueries.listUnlinkedOutboundForTimeline` (`direction='outbound' AND contact_id IS NULL AND on_timeline=false`). The stored row carries no Gmail label column (079), so the poll query's `direction='outbound'` is its discriminator and the **push path is the one that filters drafts by label**; both passes are idempotent via `getMessageLinkState`. (A one-time backfill of pre-existing outbound rows is required so historical sent emails appear.)

### (b) Contact match (FR-IN-4, AC-1) + tie-break
`findEmailContact(from_email, companyId)`:
- Normalize `from_email` → `lower(trim(from_email))`.
- Query, **company-scoped**, matching either `lower(contacts.email)` **or** `contact_emails.email_normalized` (the `idx_contact_emails_normalized` index already exists):
  ```sql
  SELECT c.* FROM contacts c
  LEFT JOIN contact_emails ce ON ce.contact_id = c.id
  WHERE c.company_id = $1
    AND ( lower(c.email) = $2 OR ce.email_normalized = $2 )
  ORDER BY c.updated_at DESC NULLS LAST, c.id ASC
  ```
- **Multiple matches (same email on >1 contact in the company):** v1 links to a **single deterministic** contact — the **most-recently-active** match: highest `contacts.updated_at`, tie broken by **lowest `id`** (the `ORDER BY` above). It logs a warning and **never fans the message onto several timelines**. (Contact-merge is out of scope; documented limitation.)
- **No match (FR-IN-6, AC-3):** return null → the message is **not** linked; it stays visible only in the standalone EMAIL-001 inbox. No `contact_id`/`timeline_id` is set, `on_timeline` stays `false`, no unread, no SSE, no contact is created.

### (c) Quote / thread stripping — timeline projection (FR-IN-8, AC-4)
Deterministic, plain-text-only. Applied to a **copy** of `body_text` for display; the stored `email_messages.body_text/html` are never mutated. Algorithm `toTimelineBody(body_text)`:
1. Operate on `body_text` only (never HTML). If `body_text` is empty but `html` exists, the projection uses an HTML→text extraction of `html` (strip tags, collapse whitespace) as the input — see §"HTML-only" edge case.
2. Split into lines. Find the **earliest** line index that matches any quote-boundary marker, and **discard that line and everything after it**:
   - **Attribution line**: matches `/^\s*On .+ wrote:\s*$/` (Gmail/Apple "On <date>, <name> <addr> wrote:"), tolerant of a trailing line-wrapped continuation (an attribution that wraps onto 2 lines: a line matching `/^\s*On .+$/` immediately followed by a line ending in `wrote:` also counts).
   - **Outlook/header block**: a line matching `/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i`, **or** the start of a forwarded/replied header block detected as a line matching `/^\s*From:\s.+/` that is followed within the next 4 lines by a line matching `/^\s*(Sent|Date):\s/` and a line matching `/^\s*To:\s/` (the classic Outlook quoted-header block).
   - **Leading-`>` block**: the first line of a contiguous run of `>`-prefixed lines (`/^\s*>/`). A single stray `>` mid-body does not trigger; the cut is at the first line of the first run that continues to (or past) end-of-body, i.e. the trailing quoted block.
3. From the kept region, **trim trailing blank lines** and a trailing run of pure-quote leftovers; **collapse** 3+ consecutive blank lines to 1.
4. **Keep the signature**: do NOT strip a trailing signature delimiter (`-- `) or the lines after it — signatures are retained (AC-4 keeps "new body + signature"). Only the quoted **history** is removed.
5. If stripping would remove everything (e.g. a body that is only a quote), fall back to `snippet` (and if that is empty, to the original `body_text` truncated) so the bubble is never blank.

Result example (AC-4): body `Sounds good, Tuesday works\n\nOn Mon, … <agent@co.com> wrote:\n> previous…` → timeline body `Sounds good, Tuesday works` (+ signature if present); the inbox still shows the full original.

### (d) Link + unread + live (FR-IN-4/5, AC-1)
On a contact match for a surviving inbound message:
1. **Resolve timeline:** `timelinesQueries.findOrCreateTimelineByContact(contactId, companyId)` (new — phone-less analogue of `findOrCreateTimeline`, reusing the orphan-adopt logic in `pulse.js POST /ensure-timeline`).
2. **Link:** `emailQueries.linkMessageToContact(provider_message_id, companyId, { contact_id, timeline_id, on_timeline:true })` — keyed on the unique `(company_id, provider_message_id)`; **re-link is a no-op `UPDATE`** (idempotent under redelivery/poll overlap).
3. **Unread (mirror SMS):** `contactsQueries.markContactUnread(contactId, internal_at)` and `timelinesQueries.markTimelineUnread(timelineId)`. (Email has no `sms_conversations` row; the SMS-only `sms_conversations.has_unread` flag is N/A — the contact+timeline pair is the email equivalent, and `GET /api/pulse/unread-count` already reads `contacts.has_unread`.)
4. **Action-Required:** run the same per-company trigger evaluation SMS uses, keyed `'inbound_email'` (`arConfigHelper.getTriggerConfig(companyId, 'inbound_email')`); broadcast `thread.action_required` when it fires (mirrors `conversationsService`).
5. **SSE:** `realtimeService.publishMessageAdded(<emailItem>, null, timelineId)` (the `messageAdded`-equivalent already carries `timelineId`), so an open `usePulsePage` `refetchTimeline()`s and the contact list refreshes unread.
- **Idempotent re-delivery:** because (2) is a no-op on a row already linked and (3) uses `GREATEST(last_incoming_event_at, …)` / a boolean set, replays do not duplicate rows, do not move ordering, and do not "re-unread" beyond the already-true flag.

---

## 4. Watch lifecycle

- **Start on connect (FR-IN-1):** EMAIL-001's OAuth-callback / connect path calls `provider.startWatch(companyId)` after the mailbox reaches `connected`, storing `watch_history_id` + `watch_expires_at`.
- **Renew (FR-IN-7, AC-11):** a new interval — `emailWatchScheduler` (sibling to the existing poll), started next to `src/server.js:413` — runs every `GMAIL_WATCH_RENEW_INTERVAL_MS` (default 12h). Each tick: `emailQueries.listMailboxesForWatchRenewal()` returns connected mailboxes whose `watch_expires_at` is within **48h** (or null); for each, `provider.renewWatch(companyId)`. Gmail `users.watch` expires **≤7 days**; a 12h tick + 48h threshold keeps re-arm well inside the window.
- **Stop on disconnect:** `emailMailboxService.disconnectMailbox` calls `provider.stopWatch(companyId)` and clears the watch columns.
- **Poll reconciliation (unchanged):** the existing 5-minute `emailSyncService` scheduler keeps running and now also calls `linkInboundMessage` per message — so a dropped/failed push is recovered within 5 minutes, idempotently (degraded latency, never loss).

---

## 5. Outbound — `POST /api/email/timeline/contacts/:contactId/send`

### Contract
- **Route:** mounted under the existing authed `/api/email` router (`backend/src/routes/email.js`).
- **Middleware chain:** `authenticate` → `requireCompanyAccess` → `requirePermission('messages.send')` (same gate as SMS-send and EMAIL-001 compose/reply).
- **Tenant:** `company_id = req.companyFilter?.company_id`; the `:contactId` is validated to belong to that company (404 if not — never 403, no cross-company leak).
- **Request body:** `{ "body": string, "toEmail": string }` — **no subject field** (FR-OUT-2). `toEmail` must equal `contacts.email` or one of the contact's `contact_emails` (company-scoped); otherwise 422.
- **Response 200:** the created outbound timeline email item (same shape buildTimeline emits, §6) so the FE can render/refetch the right-aligned bubble.

### Behavior — `emailTimelineService.sendForContact(companyId, contactId, body, toEmail, user)`
1. **Guard:** `provider.getConnectionStatus(companyId)` must be `connected`; else **409** (`reconnect_required`/disconnected), and the FE surfaces the connect CTA.
2. **Reply vs initiate (FR-OUT-1/2/3, AC-5/6):** look up the contact's **most-recent email thread** = the newest `email_messages.thread_id` where `contact_id = :contactId` (any direction, on or off timeline). 
   - **Found → reply:** `provider.sendMessage(companyId, { to: toEmail, body, providerThreadId: <local thread id>, userId, userEmail })` → `emailService.replyToThread` → subject `Re: <thread subject>`, `In-Reply-To`/`References` from the thread's last message, sent in the **same Gmail thread**.
   - **None → initiate:** `provider.sendMessage(companyId, { to: toEmail, body, subject: 'Message from <company.name>', userId, userEmail })` → `emailService.sendEmail` → **new** Gmail thread, auto subject (company display name resolved server-side; no user input).
   - A reply is taken **only** when a prior thread exists — prevents accidental cross-thread merges when initiating.
3. **Hydrate + link (FR-OUT-4):** `emailService.{reply,send}` already re-imports the thread via `importGmailThread`, so the just-sent message lands in `email_messages`. The service then stamps it: `emailQueries.linkMessageToContact(returned.provider_message_id, companyId, { contact_id, timeline_id, on_timeline:true })`, so it shows **right-aligned** (outbound) in the timeline.
4. **Broadcast:** `realtimeService.publishMessageAdded(<emailItem>, null, timelineId)` so the bubble appears immediately.
- **Reused as-is (NOT duplicated):** `emailService.sendEmail`, `replyToThread`, `buildMimeMessage`, `getValidAccessToken`, `importGmailThread`. v1 sends **no attachments** on this path.

---

## 6. `buildTimeline` projection

`buildTimeline` (`backend/src/routes/pulse.js`, after the SMS block, gated on `contact?.id`) runs **one additional query** and adds **one array** to the existing JSON; SMS/calls/financial arrays are untouched (FR-IN proj, AC-13).

Query (company-scoped, contact-scoped, only projected rows):
```sql
SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
       to_recipients_json, subject, body_text, snippet, gmail_internal_at,
       sent_by_user_email
FROM email_messages
WHERE company_id = $1 AND contact_id = $2 AND on_timeline = true
ORDER BY gmail_internal_at ASC;
```
Each row → a timeline email item:
```
{
  type: 'email',
  id, thread_id,
  direction: 'inbound' | 'outbound',
  from: { name, email },           // from_name/from_email
  to: to_recipients_json,
  subject,
  body_text: toTimelineBody(body_text),   // quote-stripped display body (§3c)
  sent_at: gmail_internal_at,
  sent_by_user_email               // outbound attribution (nullable)
}
```
Returned in a **new `email_messages` array** on the response, alongside `calls`/`messages`/`conversations`/`financial_events`. The FE fuses + sorts by timestamp client-side (as it already does for the heterogeneous sources). Permission/visibility unchanged (`pulse.view`, provider `assigned_only`). `GET /api/pulse/unread-count` is **unchanged** — it reads `contacts.has_unread`, which inbound email already set, so email-unread surfaces in the existing badge.

**EMAIL-001 inbox response is unchanged**: `getThreads`/`getMessagesByThread` never filter on the new nullable columns; the standalone `/email` payloads are byte-for-behavior identical.

---

## 7. Composer / UI behavior

### "To" selector (FR-UI-1/3, AC-7/9) — `SmsForm.tsx`
- The dropdown generalizes from "phones only" to a **target list**: `[{kind:'sms', value:phone, label} …, {kind:'email', value:email, label} …]`. Email options come from `contact.email` + `contact_emails`. Always render the list when there is ≥1 secondary phone **or** ≥1 email (today it only renders when a secondary phone exists).
- **Selecting a phone** → routes to the SMS send path (unchanged). **Selecting an email** → routes to the email send path.
- **Connect-CTA state (mailbox not connected):** when `mailboxStatus !== 'connected'`, email entries render as a **non-selectable CTA row** with copy `Google email not connected — connect to message clients by email`; clicking it `navigate`s to the email settings/connect route (`/settings/email`) — mirroring the existing "+ Add New" row that navigates to `/settings/quick-messages`. The CTA is **not a selectable send target**; phone options still send SMS normally.
- **No subject field is ever shown** for email. For an email target the char-counter is hidden and the placeholder copy adjusts (email vs SMS).

### Channel routing + default (FR-UI-2, AC-8) — `usePulsePage.ts`
- Add `mailboxStatus` from `emailApi.getWorkspaceMailbox` (React-Query cached) and build the email target list from `contact`/`contactDetail` (`contact_emails` surfaced to the composer via `types/contact.ts`).
- **`onSend` signature** extends from `(message, files, targetPhone)` to carry channel + target: `onSend(message, files, { channel:'sms'|'email', value })`. `handleSendMessage` branches on `channel`:
  - `'sms'` → unchanged (`messagingApi.sendMessage` / `startConversation`).
  - `'email'` → `emailApi.sendTimelineEmail(contactId, { body: message, toEmail: value })`.
- **Default channel = last inbound channel:** extend the existing `lastUsedPhone` logic to also consider the newest inbound `email_messages` timestamp on the timeline; if email is the newest inbound activity → preselect that email target; else keep the SMS default (existing last-used-phone). With no inbound email, behavior is exactly as today.
- **Optimistic / refetch:** on a successful email send, the FE refetches the timeline (`refetchTimeline`) so the outbound bubble appears; SSE `messageAdded` also triggers a refetch for other open sessions. (Mirror SMS-send UX; no separate optimistic insert required for v1.)

### Timeline render (FR-UI-4) — `PulseTimeline.tsx` + new `EmailListItem.tsx`
- Add an `email` item type alongside `sms` in the `useMemo` fusion (timestamp = `sent_at`/`gmail_internal_at`).
- `EmailListItem` (sibling to `SmsListItem.tsx`): **inbound left / outbound right** chat bubble, plain text (quote-stripped body), timestamp, a small mail glyph / `Email` eyebrow to distinguish channel. **No HTML, no attachment chips** in v1. `types/pulse.ts` gets an `EmailTimelineItem` type; the timeline hook maps the new `email_messages` array.

---

## 8. Edge cases & error handling

| # | Situation | Behavior |
|---|---|---|
| E-1 | **Mailbox disconnected / `reconnect_required`** on send | Outbound route **409**; FE surfaces the connect CTA (toast + selector CTA state). Inbound simply isn't arriving (no watch). |
| E-2 | **No contact email** but agent picks email | Not possible from the selector (email options only exist when an email is present); a direct call with a `toEmail` not on the contact → **422**. |
| E-3 | **Pub/Sub duplicate / redelivery / reorder** | Idempotent on `(company_id, provider_message_id)`; re-link no-op; unread already-true; ordering by `gmail_internal_at` is stable. No duplicate bubbles (AC-1/AC-11). |
| E-4 | **Watch expired mid-window** | Renewal scheduler re-arms within 48h; if a watch lapses, the 5-min poll still ingests inbound onto the timeline (degraded latency, not loss). |
| E-5 | **Contact has email but the From differs** | Inbound from a different address that maps to no contact → inbox-only (no timeline). Outbound still goes to the agent-selected `toEmail`. |
| E-6 | **Threading when initiating** | No prior thread ⇒ `sendEmail` (new thread); reply path only when a prior contact thread exists ⇒ no accidental cross-thread merge (AC-6). |
| E-7 | **Very long body** | Stored intact; timeline bubble shows quote-stripped text (long bodies render in full plain text; no truncation beyond the bubble's own scroll). |
| E-8 | **Non-text / HTML-only email** | Projection extracts text from `html` (strip tags + collapse whitespace) when `body_text` is empty, then quote-strips; the inbox still renders the original HTML. |
| E-9 | **Self-send** (agent's own/mailbox address as From) | Excluded by `is_outbound` (§3a) — never an inbound timeline entry. |
| E-10 | **Multiple contacts share the From email** | Deterministic single link to most-recently-active match (highest `updated_at`, then lowest `id`); warning logged; never fans out (§3b). |
| E-11 | **Push endpoint spoofing / bad token** | Verification rejects with **401** (token) / **403** (OIDC) before any DB work (AC-10). |
| E-12 | **Async ingest throws after fast-ack** | 200 already sent (no Pub/Sub retry); error logged; poll reconciles. |
| E-13 | **History gap (404) on pull** | Falls back to EMAIL-001 bounded backfill; backfilled messages run the same `linkInboundMessage` → self-heals onto the timeline. |

---

## 9. Component interaction summary

- **Inbound (push):** Gmail → Pub/Sub → `POST /api/email/push/google` (raw body, verify, fast-ack) → `GmailProvider.handlePushNotification` → `emailTimelineService.ingestForCompany` → `provider.pullChanges` → per msg `linkInboundMessage` (filter → match → strip-at-projection → link → unread) → `realtimeService.publishMessageAdded` → SSE → `usePulsePage.refetchTimeline`.
- **Inbound (poll, reconciliation):** `emailSyncService` 5-min tick → `syncIncrementalHistory` → same `linkInboundMessage`.
- **Outbound:** `SmsForm` (email target) → `usePulsePage.handleSendMessage('email')` → `emailApi.sendTimelineEmail` → `POST /api/email/timeline/contacts/:id/send` (`messages.send`) → `emailTimelineService.sendForContact` → `provider.sendMessage` → `emailService.reply|send` → stamp `on_timeline` → SSE → bubble.
- **Read:** `GET /api/pulse/timeline/:contactId` → `buildTimeline` (+`email_messages` query) → `PulseTimeline`/`EmailListItem`.
- **Watch:** connect → `startWatch`; `emailWatchScheduler` (12h) → `renewWatch`; disconnect → `stopWatch`.

## 10. Security & tenancy (FR-SEC, AC-10)

- Every email read/write filters by `company_id` from `req.companyFilter?.company_id`; the projection, send, match, and link queries all carry it. Cross-company email never appears in another company's timeline or inbox.
- Direct access by `:contactId` validates company ownership → **404** (not 403) for a foreign contact.
- Timeline-email **read** follows existing Pulse gating (`pulse.view`, provider `assigned_only`); **send** requires `messages.send` (403 otherwise).
- The push endpoint is **unauthenticated by user** but authenticated by **token/OIDC verification**; it derives tenant from the verified payload only — it never trusts a caller-supplied id, and a missing/invalid token does no DB work.

## 11. Protected / backwards-compat (AC-13)

- EMAIL-001 standalone inbox (`email.js` existing endpoints, `email-oauth.js`, `email-settings.js`, `components/email/*`, search, attachments, OAuth, settings) is byte-for-behavior unchanged; the new `email_messages` columns are nullable and never filtered by inbox queries.
- EMAIL-001 services unchanged in semantics: `getValidAccessToken`/refresh, `importGmailThread` upsert, `email_sync_state` checkpointing — extended only via additive hooks/exports (`pullChangesNormalized`, the `linkInboundMessage` call in the history path).
- SMS/calls/financial timeline arrays + the SMS send path are intact; email is additive (new array + new composer branch). The 5-minute scheduler still runs. No change to slot-engine, `src/server.js` boot core, `authedFetch.ts`, `useRealtimeEvents.ts`, or migration 079 / prior migrations (new migration 129 only).
