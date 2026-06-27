# SEND-DOC-001 — Test Cases

Derived from `docs/specs/SEND-DOC-001.md` + the FR/AC in `docs/requirements.md › SEND-DOC-001` and `docs/architecture.md › SEND-DOC-001`. Covers: estimate public token + public routes (view/pdf/404/tenant-safety), the email & SMS dispatch paths (PDF + link + sendEmail/sendMessage + status + timeline), the full error matrix, the **status-flip-after-success** guarantee, the send dialog (channel toggle, prefill, connect CTA, financials-tab fix), the `google-email` marketplace app (seed, connect→OAuth, connected-from-mailbox overlay, disconnect, `/settings/email` redirect, dependency_cta), and edge cases.

**Run (backend Jest):** `npx jest --runTestsByPath <file> --testPathIgnorePatterns "/node_modules/"`. Backend tests live in `tests/*.test.js`. External APIs are **mocked**: Gmail send (`emailService.sendEmail`), Twilio SMS (`conversationsService.getOrCreateConversation`/`sendMessage`), the PDF renderer (`generatePdf`), `walletService.assertServiceActive`, `emailMailboxService.getMailboxStatus`, and `resolveCompanyProxyE164` are stubbed so the dispatch orchestration is tested against their contracts. **Frontend** = React Testing Library / component + `npm run build` (tsc -b) for type-shape changes. **Manual** = staged Gmail/Twilio account + browser checks.

## Coverage
- **Total: 52** — **P0: 24** | **P1: 20** | **P2: 7** | **P3: 1**
- **Unit: 14** | **Integration: 26** | **Frontend: 12**
- Mapped to AC-1…AC-17 + FR-A1…A7 / FR-B1…B7.

| Area | TCs |
|---|---|
| Estimate public token + routes (§1) | TC-SD-001…009 |
| Email dispatch (§2 email) | TC-SD-010…016 |
| SMS dispatch (§2 sms) | TC-SD-017…022 |
| Error matrix + status-flip-after-success (§2.5/2.7) | TC-SD-023…031 |
| Send dialog (§3) | TC-SD-032…040 |
| Marketplace app `google-email` (§4) | TC-SD-041…049 |
| Edge cases (§5) | TC-SD-050…052 |

Suggested files: `tests/publicEstimates.test.js`, `tests/sendEstimate.test.js`, `tests/sendInvoice.test.js`, `tests/googleEmailMarketplace.test.js`; FE: `EstimateSendDialog.test.tsx`, `PublicEstimateViewPage.test.tsx`, `IntegrationsPage.test.tsx`.

---

## A. Estimate public link + page (§1) — AC-3, AC-16, AC-17

### TC-SD-001: `ensurePublicLink` mints + persists a token, returns `/e/<token>` URL
- **Priority:** P0 — **Type:** Unit
- **Scenario:** §1.2.
- **Preconditions:** estimate with `public_token` NULL; `PUBLIC_APP_URL=https://app.albusto.com`.
- **Mocks:** `estimatesQueries.getEstimateById`→row; `setPublicToken`→ok.
- **Steps:** call `estimatesService.ensurePublicLink(companyId, id)`.
- **Expected:** returns `{ token, url }` with `url === 'https://app.albusto.com/e/<token>'`; token is base64url (8 bytes → 11 chars); `setPublicToken(id, companyId, token)` called once.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-002: `ensurePublicLink` is idempotent (reuses existing token, no re-mint)
- **Priority:** P0 — **Type:** Unit
- **Scenario:** §1.2 idempotency / §5.7 resend.
- **Preconditions:** estimate already has `public_token='abc123XYZ_-'`.
- **Steps:** call `ensurePublicLink` twice.
- **Expected:** both return the same token+url; `setPublicToken` **never** called; `crypto.randomBytes` not invoked.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-003: `ensurePublicLink` 404 on missing / cross-tenant estimate
- **Priority:** P1 — **Type:** Unit
- **Scenario:** §1.2.
- **Mocks:** `getEstimateById`→null.
- **Expected:** throws `EstimatesServiceError` code `NOT_FOUND`, `httpStatus 404`.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-004: `getPublicEstimate` returns the customer-safe view; hides PII/internal fields
- **Priority:** P0 — **Type:** Unit
- **Scenario:** §1.3 (exposed vs hidden).
- **Mocks:** `getEstimateByPublicToken`→row incl. `contact_email/contact_phone/company_id/contact_id`; `getEstimateItems`→items.
- **Expected:** returned object **includes** `estimate_number, status, currency, items[], subtotal/discount/tax/total, company_name, contact_name`; **excludes** `contact_email`, `contact_phone`, `company_id`, `contact_id`, `lead_id`, `job_id`, event history, cost/margin fields.
- **File:** `tests/publicEstimates.test.js`

### TC-SD-005: `GET /api/public/estimates/:token` (no auth) returns 200 view JSON
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §1.5.
- **Preconditions:** route mounted before auth; seeded estimate + token.
- **Steps:** GET without any auth header.
- **Expected:** `200 { ok:true, data:{…safe view…} }`; **no** 401 (auth-skipped); payload matches TC-SD-004 field set.
- **File:** `tests/publicEstimates.test.js`

### TC-SD-006: `GET /api/public/estimates/:token/pdf` streams inline PDF with private cache headers
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §1.4/1.5.
- **Mocks:** renderer `adapter.render`→Buffer.
- **Expected:** `200`, `Content-Type: application/pdf`, `Content-Disposition: inline; filename="<number>.pdf"`, `Cache-Control: private, max-age=0, must-revalidate`; body = the buffer.
- **File:** `tests/publicEstimates.test.js`

### TC-SD-007: Malformed token → 404 NOT_FOUND **before** any DB hit
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §1.5 (`TOKEN_RE`), §1.7. AC-3 (`/e/:badtoken`).
- **Steps:** GET `/api/public/estimates/!!short` and `/api/public/estimates/<70-chars>`.
- **Expected:** `404 {ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}`; `getEstimateByPublicToken` **not** called (guard short-circuits).
- **File:** `tests/publicEstimates.test.js`

### TC-SD-008: Unknown (well-formed) token → 404; no tenant data leak
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §1.5 / §5.8.
- **Mocks:** `getEstimateByPublicToken`→null.
- **Expected:** both view + pdf routes return `404`; response body contains no estimate/company fields.
- **File:** `tests/publicEstimates.test.js`

### TC-SD-009: `PublicEstimateViewPage` renders view-only (number, items, totals, status, Download PDF) — no payment/accept
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §1.6. AC-3.
- **Mocks:** fetch `GET /api/public/estimates/:token`→safe view.
- **Expected:** renders company_name, estimate number, line items, totals, status badge, a "Download PDF" link → `/api/public/estimates/:token/pdf`; **no** tip/Stripe/Accept/Decline controls; product name shows "Albusto" (not "Blanc"); a 404 fetch shows neutral "no longer available", not a crash.
- **File:** `PublicEstimateViewPage.test.tsx`

---

## B. Email dispatch (§2 email) — AC-1, AC-4, FR-A4

### TC-SD-010: Estimate email — full happy path (PDF + link + sendEmail + status + event)
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.3 email branch + §2.7. AC-1.
- **Preconditions:** connected mailbox; estimate with items + `contact_id`.
- **Mocks:** `getMailboxStatus`→`{status:'connected'}`; `generatePdf`→`{buffer}`; `emailService.sendEmail`→`{provider_message_id:'gmail-1'}`; `linkMessageToContact`→ok.
- **Steps:** `POST /api/estimates/:id/send` body `{channel:'email',recipient:'c@x.com',message:'Hi'}`.
- **Expected:** `sendEmail` called with `to:'c@x.com'`, a synthesized subject `Estimate <number> from <company>`, HTML body containing the `/e/<token>` anchor, `files:[{mimetype:'application/pdf', originalname:'<number>.pdf', buffer}]`, `userId`+`userEmail`; **then** status→`sent` + `sent_at` set; a `sent` event with `{channel:'email',recipient}` recorded; `200` returns the updated estimate.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-011: Estimate email — outbound timeline stamp via `linkMessageToContact`
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.3 step 5 stamp. AC-1 (appears on contact timeline).
- **Mocks:** as TC-SD-010; capture `linkMessageToContact` args.
- **Expected:** called with `('gmail-1', companyId, { contact_id, timeline_id, on_timeline:true })` after a successful send.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-012: Timeline stamp failure does NOT roll back the send or block the status flip
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.3 (best-effort), §5.6. AC-1/regression.
- **Mocks:** `sendEmail`→success; `linkMessageToContact`→throws.
- **Expected:** request still `200`; status flips to `sent`; the stamp error is swallowed (logged), not propagated.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-013: Estimate email — no `contact_id` → send succeeds, stamp skipped
- **Priority:** P2 — **Type:** Integration
- **Scenario:** §2.3 step 5 (conditional), §5.1.
- **Mocks:** estimate with `contact_id` NULL.
- **Expected:** `sendEmail` runs; `linkMessageToContact` **not** called; status flips to `sent`.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-014: Invoice email — happy path uses the **pay page** link + invoice PDF
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.3 invoice variant (link = `/pay/<token>`). AC-4.
- **Mocks:** `getMailboxStatus`→connected; `invoicesService.generatePdf`→`{buffer}`; `sendEmail`→`{provider_message_id}`.
- **Steps:** `POST /api/invoices/:id/send` `{channel:'email',recipient:'c@x.com',message:'Hi',includePaymentLink:true}`.
- **Expected:** body link is the `/pay/<token>` URL (not `/i/<token>`); invoice PDF attached; status→`sent`+`sent_at`; `sent` event.
- **File:** `tests/sendInvoice.test.js`

### TC-SD-015: Invoice email — `includePaymentLink:false` omits the link from the body
- **Priority:** P1 — **Type:** Integration
- **Scenario:** §2.3 step 4. AC-4 (toggle).
- **Steps:** `POST /api/invoices/:id/send` with `includePaymentLink:false`.
- **Expected:** `sendEmail` body contains **no** pay-link anchor; send + status flip otherwise normal.
- **File:** `tests/sendInvoice.test.js`

### TC-SD-016: Email subject/body templates (subject synthesized, body wraps operator message)
- **Priority:** P2 — **Type:** Unit
- **Scenario:** §2.6.
- **Expected:** estimate subject = `Estimate {number} from {company}`, invoice = `Invoice {number} from {company}`; body = HTML of `message` (newlines→`<br>`) + anchor to `link`.
- **File:** `tests/sendEstimate.test.js`

---

## C. SMS dispatch (§2 sms) — AC-2, AC-4, FR-A4

### TC-SD-017: Estimate SMS — happy path (proxy resolve + conv + link, no attachment)
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.3 SMS branch + §2.7. AC-2.
- **Preconditions:** company has a sending number; valid recipient phone.
- **Mocks:** `resolveCompanyProxyE164`→`+1555…`; `getOrCreateConversation`→`{id:7}`; `sendMessage`→ok.
- **Steps:** `POST /api/estimates/:id/send` `{channel:'sms',recipient:'+15551234567',message:"Here's your estimate"}`.
- **Expected:** `getOrCreateConversation('+15551234567','+1555…',companyId)`; `sendMessage(7,{body:<message + ' ' + /e/<token>>, author:'agent'})`; **no** PDF/`files`; status→`sent`+`sent_at`; `sent` event `{channel:'sms',recipient}`.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-018: SMS body appends the link only if absent (no double link)
- **Priority:** P1 — **Type:** Unit
- **Scenario:** §2.6 `smsBody`.
- **Expected:** if `message` already contains `link`, body unchanged; if not, ` {link}` appended exactly once.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-019: Invoice SMS — happy path with `/pay/<token>` link
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.3. AC-4 (SMS text + link).
- **Mocks:** as TC-SD-017 for invoice.
- **Expected:** `sendMessage` body contains the `/pay/<token>` link; status→`sent`; SMS recorded by `conversationsService` (timeline projection is its responsibility — no extra stamp call).
- **File:** `tests/sendInvoice.test.js`

### TC-SD-020: SMS records to the conversation/timeline without an extra stamp
- **Priority:** P1 — **Type:** Integration
- **Scenario:** §2.3 step 6.
- **Expected:** the send service does **not** call `linkMessageToContact` on the SMS path (projection is inside `conversationsService.sendMessage`).
- **File:** `tests/sendEstimate.test.js`

### TC-SD-021: SMS — wallet gate is reached inside `sendMessage` (not pre-flighted by the service)
- **Priority:** P1 — **Type:** Integration
- **Scenario:** §2.3 (wallet gate inside `sendMessage`).
- **Mocks:** `sendMessage` invokes the real `assertServiceActive` path (or assert the service does not separately call wallet).
- **Expected:** the service relies on `sendMessage` for the wallet gate; no duplicate wallet check before conversation creation.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-022: `resolveCompanyProxyE164` extracted to `messagingHelper`, behavior preserved
- **Priority:** P2 — **Type:** Unit
- **Scenario:** §2.8 / architecture B.5.
- **Mocks:** DB MRU query → row / empty; `SOFTPHONE_CALLER_ID` env.
- **Expected:** returns MRU `proxy_e164` when present; else `SOFTPHONE_CALLER_ID`; else `null`; `routes/jobs.js` imports the same helper (no logic drift) — assert identical output for the same inputs.
- **File:** `tests/sendEstimate.test.js`

---

## D. Error matrix + status-flip-after-success (§2.5, §2.7) — AC-5, AC-6, AC-7

### TC-SD-023: Missing/blank recipient → 400 VALIDATION, status unchanged
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.3 step 3, §2.5. AC-7.
- **Steps:** `POST …/send` `{channel:'email',recipient:'',message:'x'}` and `recipient:'   '`.
- **Expected:** `400 {error:{code:'VALIDATION'}}`; `sendEmail` **not** called; status NOT flipped.
- **File:** `tests/sendEstimate.test.js`, `tests/sendInvoice.test.js`

### TC-SD-024: Email, mailbox NOT connected → 409 MAILBOX_NOT_CONNECTED (pre-check), status unchanged
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.4 pre-check, §2.5. AC-5.
- **Mocks:** `getMailboxStatus`→`{status:'disconnected'}` (and a second case `null`).
- **Expected:** `409 {error:{code:'MAILBOX_NOT_CONNECTED'}}`; `sendEmail` **not** called; status untouched; no `sent` event.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-025: Email, mailbox `reconnect_required` (mid-send) → translated to 409 (defensive catch)
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.4 defensive catch, §5.5.
- **Mocks:** `getMailboxStatus`→`connected` (passes pre-check) but `sendEmail`→throws `Error('Mailbox requires reconnection')` with `statusCode=409` (and a variant throwing the plain `'Mailbox is not connected'`).
- **Expected:** both map to `409 MAILBOX_NOT_CONNECTED` (**not** 500); status unchanged.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-026: SMS, wallet blocked → 402 WALLET_BLOCKED, status unchanged
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.5, §5.4. AC-6.
- **Mocks:** `resolveCompanyProxyE164`→`+1…`; `sendMessage`→throws `err{code:'WALLET_BLOCKED',httpStatus:402}`.
- **Expected:** `402 {error:{code:'WALLET_BLOCKED'}}`; status NOT flipped; no `sent` event.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-027: SMS, no company sending number → 422 NO_PROXY, NO side effects
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.3 step 6, §2.5, §5.3. AC-6.
- **Mocks:** `resolveCompanyProxyE164`→null.
- **Expected:** `422 {code:'NO_PROXY'}`; `getOrCreateConversation`/`sendMessage` **not** called; status untouched.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-028: SMS, no/invalid recipient phone → 422 NO_PHONE
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.5, §5.2. AC-6.
- **Mocks:** `toE164(recipient)`→null (e.g. `recipient:'abc'`).
- **Expected:** `422 {code:'NO_PHONE'}`; proxy lookup / conv not reached; status untouched.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-029: Cross-tenant / missing doc → 404 NOT_FOUND (not 403)
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.5, §5.11. AC-17 (isolation).
- **Mocks:** `getEstimateById`/`getInvoiceById`→null for the other company's id.
- **Expected:** `404 {code:'NOT_FOUND'}`; no leakage of the other tenant's data.
- **File:** `tests/sendEstimate.test.js`, `tests/sendInvoice.test.js`

### TC-SD-030: Missing `estimates.send` / `invoices.send` permission → 403
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.1/2.2 perms.
- **Steps:** authed user lacking the send permission POSTs `/send`.
- **Expected:** `403`; service never invoked.
- **File:** `tests/sendEstimate.test.js`, `tests/sendInvoice.test.js`

### TC-SD-031: STATUS-FLIP-AFTER-SUCCESS — any dispatch throw leaves the doc NOT marked Sent (the core guarantee)
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §2.7. AC-6 + the invoice flip-first fix.
- **Mocks:** invoice starts in `draft`; `sendEmail`→throws (mailbox 409); separately `sendMessage`→throws (wallet 402).
- **Expected:** in **every** failure branch (400/402/409/422/500) `updateInvoiceStatus(...,'sent',...)` and `createEvent('sent')` are **never** called; the invoice remains `draft`. Explicitly assert the **invoice** no longer flips first (regression of the old "record after flip" bug).
- **File:** `tests/sendInvoice.test.js`

---

## E. Send dialog (§3) — AC-1, AC-4, AC-5, AC-8, FR-A3, FR-A7

### TC-SD-032: `EstimateSendData` type tightened to `{channel:'email'|'sms';recipient:string;message:string}`
- **Priority:** P1 — **Type:** Frontend (build)
- **Scenario:** §3.1 (estimatesApi.ts:140).
- **Expected:** `npm run build` (tsc -b) passes; `sendEstimate(id, data)` posts the full body to `POST /api/estimates/:id/send`.
- **File:** type-check via `npm run build`

### TC-SD-033: `EstimateSendDialog` channel toggle + recipient prefill (email→contactEmail, sms→contactPhone)
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §3.1. AC-1/AC-2.
- **Mocks:** `ensureEstimatePublicLink`→`{url}`.
- **Expected:** opens defaulting email; email field prefilled with `contactEmail`; switching to SMS shows phone field prefilled with `contactPhone`; both editable.
- **File:** `EstimateSendDialog.test.tsx`

### TC-SD-034: `EstimateSendDialog` mints the public link on open + builds default message
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §3.1.
- **Expected:** on open calls `ensureEstimatePublicLink(estimateId)` (→ `POST /api/estimates/:id/public-link`); default `message` contains the estimate number + the `/e/<token>` URL; editing sets `userEditedMessage` so a channel switch doesn't clobber edits.
- **File:** `EstimateSendDialog.test.tsx`

### TC-SD-035: `EstimateSendDialog` disables Send when the channel's recipient is empty
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §3.1. AC-7.
- **Expected:** empty email (or empty phone on SMS) ⇒ Send button disabled; filling it enables Send.
- **File:** `EstimateSendDialog.test.tsx`

### TC-SD-036: `EstimateSendDialog` submit → onSend payload + success toast/close/refetch
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §3.1.
- **Mocks:** `onSend`→resolves.
- **Expected:** emits `{channel,recipient,message}`; on success shows success toast, closes, triggers parent refetch.
- **File:** `EstimateSendDialog.test.tsx`

### TC-SD-037: Email channel, mailbox not connected → inline notice + CTA to `/settings/integrations/google-email`, Send disabled
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §3.3. AC-5, FR-A6.
- **Mocks:** `getTimelineMailboxStatus`→`{connected:false}`.
- **Expected:** renders "Connect Google Email" notice with a link to `/settings/integrations/google-email` (**never** `/settings/email`); email Send disabled.
- **File:** `EstimateSendDialog.test.tsx`

### TC-SD-038: Dialog handles a 409 MAILBOX_NOT_CONNECTED from submit defensively (same CTA toast)
- **Priority:** P2 — **Type:** Frontend
- **Scenario:** §3.3.
- **Mocks:** `onSend`→rejects with 409 code.
- **Expected:** shows the connect-CTA toast; dialog stays open; no false success.
- **File:** `EstimateSendDialog.test.tsx`

### TC-SD-039: JobFinancialsTab — send routes through the dialog (no empty-recipient bypass)
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §3.4. AC-8, FR-A7.
- **Expected:** clicking Send opens `InvoiceSendDialog` prefilled from `contactEmail`/`contactPhone`/`invoiceNumber`/`contactName`; it no longer calls `sendInvoice(id,{channel:'email',recipient:''})` directly; on dialog submit, `sendInvoice(id,{channel,recipient,message,includePaymentLink})` is called with the dialog payload.
- **File:** `JobFinancialsTab.test.tsx` (or covered via `npm run build` + manual)

### TC-SD-040: LeadFinancialsTab — same dialog routing for invoice + estimate
- **Priority:** P2 — **Type:** Frontend
- **Scenario:** §3.4. AC-8.
- **Expected:** Lead tab opens the proper send dialog (estimate via `EstimateSendDialog`, invoice via `InvoiceSendDialog`) with prefilled recipient; direct empty-recipient call removed.
- **File:** `LeadFinancialsTab.test.tsx` (or `npm run build` + manual)

---

## F. Marketplace app `google-email` (§4) — AC-9…AC-14, FR-B1…B7

### TC-SD-041: Seed migration 132 inserts the `google-email` app row with correct shape
- **Priority:** P1 — **Type:** Integration
- **Scenario:** §4.1. AC-9, FR-B1.
- **Steps:** apply migration 132 against a test DB; query `marketplace_apps WHERE app_key='google-email'`.
- **Expected:** row has `name='Google Email'`, `category='communication'`, `app_type='internal'`, `provisioning_mode='none'`, `status='published'`, `metadata.setup_path='/settings/integrations/google-email'`, `metadata.manages_gmail_connection=true`; re-applying is idempotent (`ON CONFLICT … DO UPDATE`).
- **File:** `tests/googleEmailMarketplace.test.js`

### TC-SD-042: Same migration repoints mail-secretary `dependency_cta.path`
- **Priority:** P1 — **Type:** Integration
- **Scenario:** §4.1. AC-13, FR-B6.
- **Expected:** after migration, `marketplace_apps WHERE app_key='mail-secretary'` has `metadata.dependency_cta.path = '/settings/integrations/google-email'`.
- **File:** `tests/googleEmailMarketplace.test.js`

### TC-SD-043: `listApps` overlays CONNECTED from the real mailbox when status='connected'
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §4.3 (the resolved decision). AC-10.
- **Mocks:** `emailMailboxService.getMailboxStatus`→`{provider:'gmail',status:'connected',email_address:'ops@x.com'}`; **no** `marketplace_installations` row.
- **Expected:** the `google-email` entry has a synthetic `installation.status==='connected'` and `external_installation_id==='ops@x.com'` (or equivalent connected flag + address) — derived from the mailbox, **not** an install row.
- **File:** `tests/googleEmailMarketplace.test.js`

### TC-SD-044: `listApps` shows NOT connected when mailbox is `reconnect_required`/`disconnected`/absent (even with a stale install row)
- **Priority:** P0 — **Type:** Integration
- **Scenario:** §4.3 invariants, §5.10. AC-10.
- **Mocks:** three cases: mailbox `reconnect_required`; mailbox null; **and** a stale `marketplace_installations` row with `status='connected'` present alongside a `disconnected` mailbox.
- **Expected:** in all three the `google-email` overlay resolves to **not connected** (`installation.status` ⇒ `disconnected`); the stale install row does NOT make it appear connected.
- **File:** `tests/googleEmailMarketplace.test.js`

### TC-SD-045: `isAppConnected('google-email')` consults the mailbox, not an install row
- **Priority:** P1 — **Type:** Integration
- **Scenario:** §4.3. AC-14 (mail-secretary gate).
- **Mocks:** mailbox connected/disconnected; vary install row presence.
- **Expected:** returns true iff mailbox connected; independent of `marketplace_installations`. Mail-secretary's Gmail dependency gate resolves from this.
- **File:** `tests/googleEmailMarketplace.test.js`

### TC-SD-046: Connect action triggers existing OAuth start (`/google/start`) and navigates to Google
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §4.2. AC-9, FR-B2.
- **Mocks:** `startGoogleConnect`/`POST /api/settings/email/google/start`→`{auth_url}`.
- **Expected:** clicking Connect calls the existing start endpoint and redirects to `auth_url`; no new OAuth endpoint introduced.
- **File:** `IntegrationsPage.test.tsx` / `GoogleEmailSettingsPage.test.tsx`

### TC-SD-047: OAuth callback redirect now lands on `/settings/integrations/google-email` with preserved flags
- **Priority:** P1 — **Type:** Integration
- **Scenario:** §4.2 (FR-B6). AC-13.
- **Steps:** drive `GET /api/email/oauth/google/callback` success + each error branch.
- **Expected:** redirects to `/settings/integrations/google-email?connected=1` on success; `?error=…` for provider/state/param failures; `?email_error=already_connected` / `?email_error=connect_failed` for the conflict/failure branches. The string `/settings/email` no longer appears in the redirect.
- **File:** `tests/googleEmailMarketplace.test.js` (or existing email-oauth test)

### TC-SD-048: Disconnect calls the existing `/disconnect`; app flips to Not connected via mailbox overlay
- **Priority:** P1 — **Type:** Integration
- **Scenario:** §4.4. AC-11.
- **Mocks:** `POST /api/settings/email/disconnect`→ok; subsequent `getMailboxStatus`→`disconnected`.
- **Expected:** disconnect endpoint reused (watch torn down, tokens nulled, history preserved); afterward `listApps`/the card shows Not connected without any install-row mutation.
- **File:** `tests/googleEmailMarketplace.test.js`

### TC-SD-049: `/settings/email` route removed → redirects to the marketplace app; nav item gone
- **Priority:** P1 — **Type:** Frontend
- **Scenario:** §4.5. AC-12, FR-B5.
- **Expected:** navigating to `/settings/email` renders `<Navigate to="/settings/integrations/google-email" replace />` (old bookmark redirects, no 404); the `Email` nav item is absent from `appLayoutNavigation`; `SmsForm`/`EmailThreadPane`/`EmailPage` connect CTAs navigate to the new path; the **API** paths `/api/settings/email/*` are untouched.
- **File:** `App.test.tsx` / `npm run build` + manual; grep assertion that no FE route/nav references bare `/settings/email`

---

## G. Edge cases (§5)

### TC-SD-050: Idempotent re-send — token stable, status re-flips, second `sent` event appended
- **Priority:** P2 — **Type:** Integration
- **Scenario:** §5.7. AC (audit trail).
- **Preconditions:** estimate already `sent` with a token.
- **Steps:** send again (email).
- **Expected:** `ensurePublicLink` returns the same token/url; status re-set to `sent`/`sent_at`; a **second** `sent` event is recorded (audit of each send); no error.
- **File:** `tests/sendEstimate.test.js`

### TC-SD-051: Public token of a void/archived doc → view shows current status; hard-deleted → 404 neutral
- **Priority:** P2 — **Type:** Integration
- **Scenario:** §5.8.
- **Mocks:** case A `getEstimateByPublicToken`→row with `status:'void'`; case B → null (deleted).
- **Expected:** A: view JSON returns with `status:'void'`, still no PII; B: `404` neutral "no longer available"; neither leaks tenant data.
- **File:** `tests/publicEstimates.test.js`

### TC-SD-052: Public token of company A is never resolvable via company B's session, and unscoped lookup returns exactly one row
- **Priority:** P3 — **Type:** Integration
- **Scenario:** §1.7, §5.11. AC-17.
- **Mocks:** two tenants each with a tokened estimate.
- **Expected:** each token resolves only its own single row (unique index); the public route exposes no `company_id`; authenticated send/link paths still filter by `company_id` (company B cannot send/relink company A's estimate → 404).
- **File:** `tests/publicEstimates.test.js`

---

## Fixtures / notes
- **Connected mailbox** fixture: `getMailboxStatus → { provider:'gmail', status:'connected', email_address:'ops@x.com' }`.
- **PDF**: stub `generatePdf → { buffer: Buffer.from('%PDF-1.4 …') }` — content not asserted, only that it's attached with `mimetype:'application/pdf'`.
- **Gmail send**: `emailService.sendEmail → { provider_message_id:'gmail-1', provider_thread_id:'thr-1' }`; failure variants throw `Error('Mailbox is not connected')` (no statusCode) and `Error('Mailbox requires reconnection')` with `statusCode=409` (per `emailService.js:72-79`).
- **SMS**: `getOrCreateConversation → { id:7 }`; `sendMessage` resolves (happy) or throws `Object.assign(new Error('blocked'),{code:'WALLET_BLOCKED',httpStatus:402})`.
- **Proxy**: `resolveCompanyProxyE164 → '+15550001111' | null`.
- The status-flip-after-success guarantee (TC-SD-031) is the highest-value regression test — assert the `sent` status/event are written **strictly after** a resolved dispatch, in every channel and every failure branch.
