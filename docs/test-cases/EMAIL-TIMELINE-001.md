# EMAIL-TIMELINE-001 — Test Cases

Derived from `docs/specs/EMAIL-TIMELINE-001.md` + the FR/AC in `docs/requirements.md › EMAIL-TIMELINE-001`. Covers the inbound pipeline branches, outbound reply/initiate + routing, buildTimeline projection, provider seams, the push endpoint, watch lifecycle, security/tenancy, and EMAIL-001 regression.

**Run (backend Jest):** `npx jest --runTestsByPath <file> --testPathIgnorePatterns "/node_modules/"`. Backend tests live in `tests/*.test.js`. External APIs (Gmail `googleapis`, Pub/Sub) are **mocked** — the timeline layer is tested against the `MailProvider` interface (a fake provider), and `GmailProvider`/push verification are unit-tested with the Gmail client mocked. Frontend = React Testing Library / component; Manual = staged Pub/Sub or Gmail-account checks.

## Coverage
- **Total: 56** — **P0: 27** | **P1: 20** | **P2: 6** | **P3: 3**
- **Unit: 25** | **Integration: 23** | **Frontend: 5** | **Manual: 3**
- Mapped to AC-1…AC-13 + FR-IN/OUT/UI/PROV/SEC. Quote-stripping cases (TC-ET-013…018) need representative fixtures (see "Fixtures" at end).

---

## A. Inbound exclusion filter — draft/sent/own (P0, AC-2, FR-IN-3, §3a)

### TC-ET-001: Gmail DRAFT label is excluded — no timeline, no unread
- **Priority:** P0 · **Type:** Unit · **File:** `tests/emailTimelineService.test.js`
- **Scenario:** §3a draft exclusion (AC-2).
- **Input:** `NormalizedInboundMessage` with `labelIds:['DRAFT']`, `from_email` = a matched contact's email.
- **Mocks:** fake provider feeds the message; `findEmailContact` would match if reached.
- **Expected:** `linkInboundMessage` returns early; **no** `linkMessageToContact`, **no** `markContactUnread`/`markTimelineUnread`, **no** SSE. `on_timeline` stays false.

### TC-ET-002: Repeated draft edits never create timeline activity (push-storm)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailPushIngest.test.js`
- **Scenario:** AC-2 draft-edit storm.
- **Input:** N (≥3) consecutive history deliveries for the same draft (each carries `DRAFT`).
- **Mocks:** `pullChanges` yields the DRAFT message each time.
- **Expected:** after all N, zero timeline rows / zero unread for the contact; no SSE emitted.

### TC-ET-003: SENT label is excluded from inbound ingest
- **Priority:** P0 · **Type:** Unit · **File:** `tests/emailTimelineService.test.js`
- **Input:** message `labelIds:['SENT']` (or `['INBOX','SENT']`).
- **Expected:** excluded (no timeline/unread). (Outbound is projected by the send path, not inbound — see TC-ET-024.)

### TC-ET-004: Own-address (is_outbound) excluded — self-send
- **Priority:** P0 · **Type:** Unit · **File:** `tests/emailTimelineService.test.js` · (AC-2, E-9)
- **Input:** `is_outbound:true`, `from_email` = mailbox address.
- **Expected:** excluded; no contact match attempted.

### TC-ET-005: Genuine INBOX external inbound passes the filter
- **Priority:** P0 · **Type:** Unit · **File:** `tests/emailTimelineService.test.js`
- **Input:** `labelIds:['INBOX']`, `is_outbound:false`, `from_email` external.
- **Expected:** proceeds to contact match (filter does not drop it).

---

## B. Contact match / no-match / multi-match (P0–P2, AC-1/AC-3, FR-IN-4/6, §3b)

### TC-ET-006: Match via contacts.email (case-insensitive, company-scoped)
- **Priority:** P0 · **Type:** Unit · **File:** `tests/findEmailContact.test.js`
- **Input:** `from_email:'Alice@X.com'`, contact `email:'alice@x.com'`, same company.
- **Expected:** returns that contact (case-insensitive); query carries `company_id`.

### TC-ET-007: Match via contact_emails.email_normalized
- **Priority:** P0 · **Type:** Unit · **File:** `tests/findEmailContact.test.js`
- **Input:** `from_email` matches a `contact_emails.email_normalized` row (not `contacts.email`).
- **Expected:** returns the owning contact.

### TC-ET-008: No match → inbox-only, no timeline/unread/contact (AC-3)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailPushIngest.test.js`
- **Input:** `from_email:'nobody@unknown.com'`, no contact in company.
- **Expected:** message remains in `email_messages` (inbox) with `contact_id` NULL, `on_timeline` false; no `markContactUnread`, no SSE, no contact created.

### TC-ET-009: Multi-match tie-break = most-recently-active (updated_at desc, id asc) (E-10)
- **Priority:** P1 · **Type:** Unit · **File:** `tests/findEmailContact.test.js`
- **Input:** two contacts in the company share the From email; differing `updated_at`.
- **Expected:** returns the highest-`updated_at` contact; tie → lowest `id`; warning logged; single contact only.

### TC-ET-010: Cross-company isolation — From matches a contact in company B only
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailPushIngest.test.js` · (AC-10, FR-SEC-1)
- **Input:** push resolves to company A's mailbox; the From email matches a contact in company **B**.
- **Expected:** no match in A → inbox-only in A; company B's timeline is untouched.

---

## C. Quote / signature stripping (P0–P2, AC-4, FR-IN-8, §3c) — needs fixtures

### TC-ET-011: toTimelineBody does not mutate stored body_text
- **Priority:** P0 · **Type:** Unit · **File:** `tests/toTimelineBody.test.js`
- **Expected:** projection returns a stripped string; the input `email_messages.body_text` is byte-identical afterward (inbox parity).

### TC-ET-012: Gmail "On … wrote:" attribution stripped, new body + signature kept (AC-4)
- **Priority:** P0 · **Type:** Unit · **File:** `tests/toTimelineBody.test.js` · **Fixture:** `gmail-on-wrote.txt`
- **Input:** `Sounds good, Tuesday works\n\nOn Mon, Jun 23 … <agent@co.com> wrote:\n> previous…\n\n-- \nAlice`
- **Expected:** `Sounds good, Tuesday works` + the `-- \nAlice` signature; quoted history removed.

### TC-ET-013: Leading `>`-quoted block stripped
- **Priority:** P0 · **Type:** Unit · **File:** `tests/toTimelineBody.test.js` · **Fixture:** `caret-quoted.txt`
- **Input:** new lines followed by a contiguous run of `>`-prefixed lines to end-of-body.
- **Expected:** only the new lines remain; a single stray `>` mid-sentence does NOT trigger a cut.

### TC-ET-014: Outlook "From:/Sent:/To:" header block stripped
- **Priority:** P0 · **Type:** Unit · **File:** `tests/toTimelineBody.test.js` · **Fixture:** `outlook-header-block.txt`
- **Input:** new body then `From: …\nSent: …\nTo: …\nSubject: …` + quoted prior message.
- **Expected:** the header block and everything after is removed; new body kept.

### TC-ET-015: "----- Original Message -----" delimiter stripped
- **Priority:** P1 · **Type:** Unit · **File:** `tests/toTimelineBody.test.js` · **Fixture:** `original-message.txt`
- **Expected:** cut at the delimiter line; new body kept.

### TC-ET-016: Signature-only / no-quote body is returned unchanged
- **Priority:** P1 · **Type:** Unit · **File:** `tests/toTimelineBody.test.js`
- **Input:** body with a `-- ` signature but **no** quoted history.
- **Expected:** full body incl. signature returned (nothing stripped).

### TC-ET-017: Quote-only body falls back to snippet/original (never blank)
- **Priority:** P2 · **Type:** Unit · **File:** `tests/toTimelineBody.test.js`
- **Input:** body that is entirely a quote.
- **Expected:** falls back to `snippet` (then truncated original) → non-empty bubble text.

### TC-ET-018: HTML-only email → text extracted then stripped (E-8)
- **Priority:** P2 · **Type:** Unit · **File:** `tests/toTimelineBody.test.js` · **Fixture:** `html-only.html`
- **Input:** `body_text` empty, `html` present with quoted block.
- **Expected:** tags stripped + whitespace collapsed → text, then quote-stripped; stored `html` untouched.

---

## D. Link + unread + idempotency (P0–P1, AC-1/AC-11, §3d)

### TC-ET-019: Match links contact_id/timeline_id/on_timeline + sets unread + SSE (AC-1)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailPushIngest.test.js`
- **Input:** INBOX inbound from a matched contact.
- **Mocks:** fake provider; spy `realtimeService.publishMessageAdded`.
- **Expected:** row gets `contact_id`/`timeline_id`/`on_timeline=true`; `contacts.has_unread`=true; `timelines.has_unread`=true; `publishMessageAdded` called with `timelineId`.

### TC-ET-020: findOrCreateTimelineByContact reuses existing / adopts orphan
- **Priority:** P1 · **Type:** Unit · **File:** `tests/timelinesQueries.test.js`
- **Expected:** returns the contact's existing timeline if present; otherwise creates/adopts (orphan-adopt logic), company-scoped; never duplicates a timeline.

### TC-ET-021: Idempotent re-delivery — push then poll process same message once (AC-1/AC-11)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailPushIngest.test.js`
- **Input:** same `provider_message_id` ingested twice (push, then 5-min poll).
- **Expected:** single `email_messages` row; `on_timeline` set once; no duplicate timeline item; unread not re-toggled beyond true. Keyed on unique `(company_id, provider_message_id)`.

### TC-ET-022: Action-Required uses 'inbound_email' trigger config
- **Priority:** P2 · **Type:** Unit · **File:** `tests/emailTimelineService.test.js`
- **Mocks:** `arConfigHelper.getTriggerConfig(companyId,'inbound_email')` → enabled.
- **Expected:** on match, `thread.action_required` broadcast fires (mirrors SMS).

### TC-ET-023: Poll path shares linkInboundMessage (one code path, two triggers)
- **Priority:** P1 · **Type:** Integration · **File:** `tests/emailSyncTimeline.test.js`
- **Expected:** `syncIncrementalHistory` per-message handling invokes `emailTimelineService.linkInboundMessage`; a missed-push message reconciles onto the timeline via the poll, idempotently.

---

## E. Outbound — reply vs initiate, routing, gating (P0–P1, AC-5/6/7/9/10, FR-OUT, §5)

### TC-ET-024: Reply threads correctly (Re: + In-Reply-To/References + same thread) (AC-5)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailTimelineSend.test.js`
- **Precond:** contact has an existing inbound email thread.
- **Mocks:** provider/`emailService.replyToThread` spy.
- **Expected:** `sendForContact` resolves the contact's newest `thread_id` → `provider.sendMessage({providerThreadId})` → `replyToThread`; subject `Re: <thread subject>`; outbound row stamped `on_timeline`, linked to contact; returns the created item.

### TC-ET-025: Initiate creates a new thread with auto subject, no subject field (AC-6)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailTimelineSend.test.js`
- **Precond:** contact has **no** prior email thread.
- **Expected:** `provider.sendMessage` with no `providerThreadId` → `emailService.sendEmail`; subject `Message from <company.name>`; new thread; outbound row stamped + linked; appears in timeline.

### TC-ET-026: Outbound stamps on_timeline so the bubble is right-aligned (FR-OUT-4)
- **Priority:** P1 · **Type:** Integration · **File:** `tests/emailTimelineSend.test.js`
- **Expected:** after send, the just-sent `email_messages` row (matched by returned `provider_message_id`) has `on_timeline=true`, `direction='outbound'`, `contact_id` set; SSE broadcast.

### TC-ET-027: Disconnected/reconnect_required mailbox → 409 on send (AC-9, E-1)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailTimelineSend.test.js`
- **Mocks:** `getConnectionStatus` → `reconnect_required`.
- **Expected:** route returns **409**; no Gmail send attempted; FE can surface connect CTA.

### TC-ET-028: messages.send permission gating — 403 without it (AC-10, FR-OUT-5)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailTimelineSendAuth.test.js`
- **Expected:** `POST /api/email/timeline/contacts/:id/send` → **403** for a user lacking `messages.send`; **401** with no token.

### TC-ET-029: Company scoping — foreign :contactId returns 404 (not 403) (AC-10, FR-SEC-1)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailTimelineSendAuth.test.js`
- **Input:** `:contactId` belongs to another company.
- **Expected:** **404** (no cross-company leak); no send.

### TC-ET-030: toEmail not on the contact → 422
- **Priority:** P1 · **Type:** Integration · **File:** `tests/emailTimelineSend.test.js` · (E-2)
- **Input:** `toEmail` not in `contacts.email`/`contact_emails` for that contact+company.
- **Expected:** **422**; no send.

### TC-ET-031: Initiate never reuses a thread (no accidental cross-thread merge) (E-6)
- **Priority:** P1 · **Type:** Unit · **File:** `tests/emailTimelineSend.test.js`
- **Expected:** reply branch is taken only when a prior contact thread exists; absent → `sendEmail` path (new thread), even if other unrelated threads exist for the company.

---

## F. buildTimeline projection (P0–P1, AC-1/AC-13, §6)

### TC-ET-032: Email present in timeline for a matched contact
- **Priority:** P0 · **Type:** Integration · **File:** `tests/pulseTimelineEmail.test.js`
- **Input:** a linked inbound + outbound email (`on_timeline=true`) for the contact.
- **Expected:** `GET /api/pulse/timeline/:contactId` returns an `email_messages` array with both items, `direction` correct, `body_text` quote-stripped, ordered by `gmail_internal_at`; `calls`/`messages`/`financial_events` arrays unchanged.

### TC-ET-033: Email absent for inbox-only (unmatched) message (AC-3)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/pulseTimelineEmail.test.js`
- **Input:** an `email_messages` row with `contact_id` NULL / `on_timeline=false`.
- **Expected:** it does **not** appear in any contact's `email_messages` array.

### TC-ET-034: Projection query is company- and contact-scoped
- **Priority:** P0 · **Type:** Integration · **File:** `tests/pulseTimelineEmail.test.js` · (FR-SEC-1)
- **Expected:** the email query filters `company_id = $1 AND contact_id = $2 AND on_timeline=true`; company B's email never appears in company A's timeline.

### TC-ET-035: unread-count unchanged — email-unread surfaces via contacts.has_unread
- **Priority:** P1 · **Type:** Integration · **File:** `tests/pulseTimelineEmail.test.js`
- **Expected:** after an inbound email sets `contacts.has_unread`, `GET /api/pulse/unread-count` counts that contact (no change to that endpoint).

### TC-ET-036: SMS timeline payload byte-for-behavior unchanged (regression) (AC-13)
- **Priority:** P1 · **Type:** Integration · **File:** `tests/pulseTimelineEmail.test.js`
- **Expected:** a contact with SMS but no timeline email returns the same `calls/messages/conversations/financial_events` payload as before; the new `email_messages` array is empty.

---

## G. MailProvider / GmailProvider unit seams (P0–P2, AC-12, FR-PROV, §1)

### TC-ET-037: Seam — buildTimeline & emailTimelineService have no Gmail imports (AC-12)
- **Priority:** P0 · **Type:** Unit (static) · **File:** `tests/mailProviderSeam.test.js`
- **Expected:** source of `pulse.js buildTimeline` block and `emailTimelineService.js` contains no `require('googleapis')`, `emailService`, `emailSyncService`, or `emailMailboxService`; they reference only `providerRegistry`/`MailProvider` + `emailQueries`. (Assert via source/dependency check.)

### TC-ET-038: MailProvider base methods throw "not implemented"
- **Priority:** P2 · **Type:** Unit · **File:** `tests/mailProvider.test.js`
- **Expected:** calling each base stub throws; `GmailProvider` overrides all of them.

### TC-ET-039: GmailProvider.sendMessage routes reply vs new on providerThreadId
- **Priority:** P1 · **Type:** Unit · **File:** `tests/gmailProvider.test.js`
- **Mocks:** `emailService.replyToThread`/`sendEmail` spies.
- **Expected:** `providerThreadId` present → `replyToThread(companyId, threadId, …)`; absent → `sendEmail(companyId, …)`; returns `{provider_message_id, provider_thread_id}`.

### TC-ET-040: GmailProvider.handlePushNotification decodes + resolves mailbox
- **Priority:** P1 · **Type:** Unit · **File:** `tests/gmailProvider.test.js`
- **Input:** Pub/Sub envelope with base64 `{emailAddress, historyId}`.
- **Expected:** returns `{companyId, cursor:historyId}` from `getMailboxByEmail`; unknown address → `null` (no throw).

### TC-ET-041: pullChanges normalizes + includes labelIds/is_outbound
- **Priority:** P1 · **Type:** Unit · **File:** `tests/gmailProvider.test.js`
- **Mocks:** Gmail `history.list`/message fetch.
- **Expected:** returns `NormalizedInboundMessage[]` with `labelIds` + `is_outbound` populated + a new cursor; inbox hydration (`importGmailThread`) still invoked.

---

## H. Push endpoint — raw body, verification, fast-ack (P0–P1, AC-10, FR-IN-2, §2)

### TC-ET-042: Mounted with raw body before express.json
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailPushRoute.test.js`
- **Expected:** the route receives the unparsed raw Pub/Sub body (verification operates on raw); other `/api/email/*` routes still parse JSON. (Assert mount order / that a JSON body middleware did not consume it.)

### TC-ET-043: Invalid/missing token rejected, no processing (AC-10, E-11)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailPushRoute.test.js`
- **Input:** request with wrong/absent `?token=` (token mode).
- **Expected:** **401**; `ingestForCompany` never called; no DB write.

### TC-ET-044: OIDC mode rejects bad aud/email
- **Priority:** P1 · **Type:** Unit · **File:** `tests/emailPushVerify.test.js`
- **Input:** JWT with wrong `aud` or `email ≠ GMAIL_PUBSUB_SA_EMAIL`.
- **Expected:** **403**; no processing.

### TC-ET-045: Valid push fast-acks 200 and processes async; async error still 200 (E-12)
- **Priority:** P0 · **Type:** Integration · **File:** `tests/emailPushRoute.test.js`
- **Mocks:** `ingestForCompany` throws.
- **Expected:** HTTP **200** returned immediately (before/independent of ingest); thrown async error is logged, not surfaced to Pub/Sub (no retry storm).

---

## I. Watch lifecycle (P1–P2, AC-11, FR-IN-1/7, §4)

### TC-ET-046: startWatch persists history_id + watch_expires_at; renewWatch re-arms before expiry
- **Priority:** P1 · **Type:** Unit · **File:** `tests/emailWatch.test.js`
- **Mocks:** Gmail `users.watch`.
- **Expected:** `startWatch` writes `watch_history_id`/`watch_expires_at`; `listMailboxesForWatchRenewal` returns mailboxes within 48h of expiry; `renewWatch` calls `users.watch` again and updates expiry. `stopWatch` clears columns + calls `users.stop`.

---

## J. Frontend — composer + timeline (P1–P2, AC-7/8/9, FR-UI)

### TC-ET-047: "To" selector lists phones + emails; phone→SMS, email→email (AC-7)
- **Priority:** P1 · **Type:** Frontend · **File:** `frontend/src/components/pulse/SmsForm.test.tsx`
- **Expected:** dropdown shows phone(s) + email(s); selecting a phone calls `onSend(..,{channel:'sms'})`, selecting an email calls `onSend(..,{channel:'email', value:email})`; no subject field rendered.

### TC-ET-048: Not-connected → email entry shows connect CTA, not selectable, links to settings (AC-9)
- **Priority:** P1 · **Type:** Frontend · **File:** `frontend/src/components/pulse/SmsForm.test.tsx`
- **Mocks:** `mailboxStatus !== 'connected'`.
- **Expected:** CTA copy `Google email not connected — connect to message clients by email`; clicking navigates to `/settings/email`; not selectable as a send target; phone still sends SMS.

### TC-ET-049: Default channel = last inbound channel (AC-8)
- **Priority:** P1 · **Type:** Frontend · **File:** `frontend/src/hooks/usePulsePage.test.tsx`
- **Expected:** when newest inbound activity is an email → selector preselects that email; when SMS → SMS default (existing last-used-phone); no inbound email → unchanged.

### TC-ET-050: handleSendMessage email branch calls emailApi.sendTimelineEmail
- **Priority:** P1 · **Type:** Frontend · **File:** `frontend/src/hooks/usePulsePage.test.tsx`
- **Expected:** `channel:'email'` → `emailApi.sendTimelineEmail(contactId,{body,toEmail})` then `refetchTimeline`; `channel:'sms'` → unchanged SMS path.

### TC-ET-051: EmailListItem renders inbound left / outbound right, plain text + mail glyph
- **Priority:** P2 · **Type:** Frontend · **File:** `frontend/src/components/pulse/EmailListItem.test.tsx`
- **Expected:** inbound left, outbound right; quote-stripped plain text; timestamp; `Email`/mail-glyph affordance; no HTML, no attachment chips.

---

## K. EMAIL-001 regression + manual (P2–P3, AC-13)

### TC-ET-052: EMAIL-001 inbox queries unaffected by new nullable columns (AC-13)
- **Priority:** P1 · **Type:** Integration · **File:** `tests/emailInboxRegression.test.js`
- **Expected:** `getThreads`/`getMessagesByThread`/search/attachment download return identical results with migration 129 applied; new columns never filtered.

### TC-ET-053: Migration 129 is additive + reversible
- **Priority:** P2 · **Type:** Integration · **File:** `tests/migration129.test.js`
- **Expected:** `129_email_timeline_link.sql` adds nullable `contact_id`/`timeline_id`/`on_timeline` + watch columns + index without touching 079 columns; `rollback_129` drops them cleanly.

### TC-ET-054: End-to-end inbound (staged Pub/Sub) lands on timeline live
- **Priority:** P3 · **Type:** Manual
- **Steps:** connect a test mailbox, send an external email from a contact's address, observe the bubble + unread appear in an open Pulse within seconds.

### TC-ET-055: End-to-end reply + initiate from Pulse composer
- **Priority:** P3 · **Type:** Manual
- **Steps:** reply to that thread from the composer (verify `Re:` + same Gmail thread); initiate to a call-only contact (verify new thread + auto subject); both bubbles appear right-aligned.

### TC-ET-056: Watch renewal over a real expiry window
- **Priority:** P3 · **Type:** Manual
- **Steps:** verify a mailbox's `watch_expires_at` is re-armed by the scheduler before lapse; drop a single push and confirm the 5-min poll reconciles the message.

---

## Fixtures (for the quote-stripping suite, TC-ET-012…018)
Place under `tests/fixtures/email-timeline/`:
- `gmail-on-wrote.txt` — new body + `On <date>, <name> <addr> wrote:` + `>`-quote + `-- ` signature.
- `caret-quoted.txt` — new lines + contiguous trailing `>`-quoted block (and one stray mid-body `>` that must NOT cut).
- `outlook-header-block.txt` — new body + `From:/Sent:/To:/Subject:` header block + quoted prior message.
- `original-message.txt` — new body + `----- Original Message -----` delimiter + quote.
- `html-only.html` — HTML body (no plain text) containing a quoted block, to exercise text extraction (E-8).
