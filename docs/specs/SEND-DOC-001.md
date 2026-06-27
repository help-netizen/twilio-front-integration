# SEND-DOC-001 — Send Estimate/Invoice by Email/SMS + Gmail→Marketplace App

> Spec Writer (03). Precise behavior + contracts. Source: `docs/requirements.md` (SEND-DOC-001, Product 01) + `docs/architecture.md` (SEND-DOC-001, Architect 02). **Reuse over rebuild** — the delivery infra (`emailService.sendEmail`, `conversationsService` SMS, `generatePdf`, `ensurePublicLink`, the invoice pay page) already exists and is only being wired into the two "send" stubs; estimates gain the tokenized public page invoices already have; Gmail connect moves into a marketplace app and `/settings/email` is retired.

Two coupled parts:
- **PART A** — actually deliver Estimates & Invoices (today both "send" actions are record-only stubs; nothing leaves the system).
- **PART B** — relocate Gmail connect/disconnect/status from `/settings/email` into a first-class **"Google Email"** marketplace app whose CONNECTED state derives from the **real mailbox**, not an install row.

Migration numbers: **131** (estimate token), **132** (marketplace seed).

---

## 0. Glossary of reused symbols (grounded in code)

| Symbol | Location | Shape / behavior |
|---|---|---|
| `emailService.sendEmail(companyId, {to,cc,subject,body,files,userId,userEmail})` | `backend/src/services/emailService.js:68` | Returns `{ provider_message_id, provider_thread_id }`. **Throws plain `Error('Mailbox is not connected')`** (no `statusCode`) when mailbox missing/`disconnected`; **throws `Error('Mailbox requires reconnection')` with `error.statusCode=409`** when `reconnect_required`. Neither carries `code` nor `httpStatus`. |
| `emailMailboxService.getMailboxStatus(companyId)` | `backend/src/services/emailMailboxService.js:158` | `{ id, provider:'gmail', email_address, display_name, status, last_synced_at, … }`. `status ∈ {'connected','reconnect_required','disconnected'}` (FE also models `'sync_error'`). |
| `emailQueries.linkMessageToContact(providerMessageId, companyId, {contact_id, timeline_id, on_timeline=true})` | `backend/src/db/emailQueries.js:447` | Outbound-stamp onto contact timeline (EMAIL-TIMELINE-001). Returns updated row or null. |
| `conversationsService.getOrCreateConversation(customerE164, proxyE164, companyId)` | `backend/src/services/conversationsService.js:23` | Resolves/creates the SMS conversation. |
| `conversationsService.sendMessage(conversationId, {body, author='agent', mediaSid, fileInfo})` | `…conversationsService.js:104` | Wallet gate **inside** (`walletService.assertServiceActive` at :109). Records the message + projects SMS to the contact timeline. |
| `walletService.assertServiceActive(companyId)` | `backend/src/services/walletService.js:125` | Throws `err` with `err.httpStatus=402`, `err.code='WALLET_BLOCKED'`. |
| `resolveCompanyProxyE164(companyId)` | `backend/src/routes/jobs.js:716` (→ extract to `services/messagingHelper.js`) | MRU `sms_conversations.proxy_e164`, else `process.env.SOFTPHONE_CALLER_ID`, else **null**. |
| `toE164(phone)` | `backend/src/utils/phoneUtils.js:14` | `+1XXXXXXXXXX` for US, `+<digits>` intl, `null` if empty/invalid. |
| invoice `ensurePublicLink` / `generatePdfByPublicToken` | `backend/src/services/invoicesService.js:497/518` | The mirror template for estimates. |
| `marketplaceService.listApps(companyId)` / `isAppConnected(companyId, appKey)` | `backend/src/services/marketplaceService.js:156/23` | App row maps to `{ app_key, name, metadata, provisioning_mode, installation:{status,…}|null, … }`. `isAppConnected` = published AND `installation.status==='connected'`. |

---

## 1. Estimate public link + page (PART A)

### 1.1 Schema — `estimates.public_token`
- Migration **131** (`131_estimates_public_token.sql` + `rollback_131_*.sql`), mirroring migration 087 on `estimates`:
  - `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS public_token TEXT;`
  - `CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_public_token ON estimates (public_token) WHERE public_token IS NOT NULL;`
  - Additive, idempotent (re-runnable). Rollback drops index then column.

### 1.2 `estimatesService.ensurePublicLink(companyId, id)` — contract
- **Behavior** (copy of invoice impl): load estimate (`404 NOT_FOUND` if missing/cross-tenant); reuse existing `public_token` else mint `crypto.randomBytes(8).toString('base64url')` and persist via `estimatesQueries.setPublicToken(id, companyId, token)`.
- **Returns** `{ token, url }` where `url = (PUBLIC_APP_URL || APP_URL || '').replace(/\/+$/,'') + '/e/' + token`. If no base env var: returns the relative `/e/<token>` path (mirror invoice).
- **Idempotent**: subsequent calls return the same token+url. Re-send never re-mints.
- New queries (`estimatesQueries.js`, mirror invoicesQueries 563–599):
  - `getEstimateByPublicToken(publicToken)` — `WHERE e.public_token = $1`, **no company scope** (token is the credential), joins `contact_name/contact_email/contact_phone` + `company_name`.
  - `setPublicToken(estimateId, companyId, token)` — `UPDATE estimates SET public_token=$3, updated_at=NOW() WHERE id=$1 AND company_id=$2`.

### 1.3 `estimatesService.getPublicEstimate(token)` — safe view shape
- `getEstimateByPublicToken(token)` + `getEstimateItems(id)`; `404 NOT_FOUND` if not found.
- **Exposed** (customer-safe, on the doc only): `estimate_number`, `status`, `currency`, line items (`title`, `qty`, `unit_price`, `line_total`), subtotal/discount/tax/total, `company_name`, and a **contact display name** (`contact_name`). Optionally a thank-you/notes field if present on the estimate.
- **Hidden / never in this payload**: internal IDs (`company_id`, `contact_id`, `lead_id`, `job_id`, `id` may be included only as an opaque echo if a renderer needs it — prefer omitting), `contact_email`, `contact_phone`, audit/event history, costs/margins, any other tenant data. The page is **view-only** — no payment, no accept/decline in v1.

### 1.4 `estimatesService.generatePdfByPublicToken(token)`
- Mirror invoice (`invoicesService.js:518`): resolve estimate by token (`404` if none), load items, `documentTemplatesService.resolveTemplate(company_id,'estimate')` + `rendererRegistry.get('estimate')` → `{ estimate, buffer }`.

### 1.5 Public routes — `backend/src/routes/public-estimates.js` (mirror `public-invoices.js`)
Mounted **before auth** at `/api/public` in `src/server.js`, next to `public-invoices` (so the `/api/public/*` auth-skip already covers it). Token guard `TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/` → `404 {ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}` before any DB hit.

| Route | Auth | Returns | Errors |
|---|---|---|---|
| `GET /api/public/estimates/:token` | none (token=cred) | `{ ok:true, data:<safe view §1.3> }` | malformed token → 404 NOT_FOUND; unknown token → 404 NOT_FOUND |
| `GET /api/public/estimates/:token/pdf` | none | `application/pdf` streamed **inline** (`Content-Disposition: inline; filename="<number>.pdf"`, `Content-Length`, `Cache-Control: private, max-age=0, must-revalidate`) | malformed/unknown token → 404; renderer missing → 500 INTERNAL |
| (optional) `shortRouter GET /ep/:token` | none | `302 → /api/public/estimates/:token/pdf` | malformed → 404 |

- **`/e/:token` is NOT a server route** — it is a **client (SPA) route** (App.tsx), exactly like `/pay/:token`. The customer link embedded in messages is the **page** `/e/<token>` (served by the SPA catch-all); the page's "Download PDF" hits `/api/public/estimates/:token/pdf`. The optional `/ep/:token` short PDF link exists only for SMS-friendly direct-PDF; the message link is the page.
- Mount snippet (architecture A.4): `app.use('/api/public', publicEstimatesRouter); app.use('/', publicEstimatesRouter.shortRouter);` — additive; does **not** touch invoice/Stripe public mounts (AC-16).

### 1.6 Page — `frontend/src/pages/PublicEstimateViewPage.tsx`
- Default export mirroring `PublicInvoicePayPage` (token from `useParams`, fetch `GET /api/public/estimates/:token` on mount, loading + error states). **View-only**: company header (company_name), estimate number, line-items table, totals, status badge, **"Download PDF"** → `/api/public/estimates/:token/pdf`. **No** tip / Stripe / Accept / Decline. Albusto tokens (`--blanc-*`); product name "Albusto" (never "Blanc") in user-facing text.
- `App.tsx`: `<Route path="/e/:token" element={<PublicEstimateViewPage />} />` adjacent to the `/pay/:token` route, **outside** the authed shell.
- **Error state**: a 404 from the API (malformed/unknown/void/deleted token) renders a neutral "This link is no longer available" page, **not** a stack trace and **not** any tenant data.

### 1.7 Token security
- 64-bit opaque token is the only credential; the unique partial index guarantees the unscoped lookup resolves exactly one row. `TOKEN_RE` rejects malformed input before DB. Random (non-sequential) → no enumeration. PDF `Cache-Control: private`. Same posture as invoices (AC-16/17).

---

## 2. Dispatch contracts (the core of PART A)

### 2.1 `POST /api/estimates/:id/send` — contract
- **Auth/middleware**: `authenticate`, company access, `requirePermission('estimates.send')` (route at `routes/estimates.js:164`, perms unchanged).
- **Request body**: `{ channel: 'email'|'sms', recipient: string, message: string }`. (`channel:'text'` is normalized → `'sms'` for back-compat.)
- Handler reads `{ channel, recipient, message }`, calls `estimatesService.sendEstimate(companyId, userId, id, { channel, recipient, message })`.
- **Success** `200 { ok:true, data:<estimate, status:'sent', sent_at> }`.
- **Error mapping** — the route's existing pattern is `status = err.httpStatus || 500; {ok:false,error:{code:err.code||'INTERNAL',message}}`. The service MUST set `err.code` + `err.httpStatus` to produce the matrix in §2.5 (see translation rule §2.4).

### 2.2 `POST /api/invoices/:id/send` — contract
- **Auth/middleware**: `requirePermission('invoices.send')` (route at `routes/invoices.js:133`).
- **Request body**: `{ channel:'email'|'sms', recipient:string, message:string, includePaymentLink?:boolean }`.
- Calls `invoicesService.sendInvoice(companyId, userId, id, { channel, recipient, message, includePaymentLink })`. Same success/error mapping as §2.1.

### 2.3 Service behavior — `sendEstimate` / `sendInvoice` (shared shape)
Replace the stub bodies. Ordered steps (estimate shown; invoice identical except the link target and `includePaymentLink`):

1. **Load** estimate/invoice (`404 NOT_FOUND` if missing/cross-tenant). For estimate: `assertNotArchived`, `assertHasItems`.
2. **Normalize channel** (`'text'`→`'sms'`); reject anything not `email|sms` → `400 VALIDATION`.
3. **Validate recipient present** (trimmed non-empty) → else `400 VALIDATION` ("Recipient is required.").
4. **Mint link** `link = (await ensurePublicLink(companyId, id)).url` — estimate → `/e/<token>` page; invoice → the **pay page** `/pay/<token>` URL the dialog already mints (NOT the `/i/<token>` PDF short link). For invoice, if `includePaymentLink === false`, omit the link from the body.
5. **EMAIL branch**:
   - `{ buffer } = await generatePdf(companyId, id)`.
   - Build `subject` (synthesized, §2.6) + `body` (HTML wrap of the operator `message`, newlines→`<br>`, with `link` rendered as an anchor "View your estimate/invoice online"; §2.6).
   - `result = await emailService.sendEmail(companyId, { to: recipient, subject, body, files:[{ originalname: \`\${number||'estimate'}.pdf\`, mimetype:'application/pdf', buffer }], userId, userEmail })`.
   - **Timeline stamp (best-effort)**: if the doc has `contact_id`, resolve its `timeline_id` and call `emailQueries.linkMessageToContact(result.provider_message_id, companyId, { contact_id, timeline_id, on_timeline:true })`. Wrap in try/catch — a stamp failure MUST NOT undo a real send nor block the status flip. (`userEmail` is the actor's email so EMAIL-TIMELINE-001 tags the sender.)
6. **SMS branch**:
   - `customerE164 = toE164(recipient)` → `422 NO_PHONE` if falsy.
   - `proxyE164 = await resolveCompanyProxyE164(companyId)` → `422 NO_PROXY` if null. **No side effects** before this check.
   - `conv = await getOrCreateConversation(customerE164, proxyE164, companyId)`; `await sendMessage(conv.id, { body: smsBody(message, link), author:'agent' })`. Wallet gate is **inside** `sendMessage` → propagates as `402 WALLET_BLOCKED`. `conversationsService` records the message + projects SMS to the timeline (no extra stamp).
7. **On success ONLY**: flip status → `'sent'` + set `sent_at` (estimate: via `updateEstimate(id, companyId, {status:'sent', sent_at:now})` — add `sent_at` handling; invoice: `updateInvoiceStatus(id, companyId, 'sent', 'sent_at')`) **and** record the send **event** `createEvent(id, 'sent', 'user', userId, { channel, recipient })`. (Estimate today logs `send_stub_requested` and changes nothing — replace it.)

### 2.4 ⚠ Translation rule for the "not connected" error (load-bearing)
`emailService.sendEmail` does **not** emit a `MAILBOX_NOT_CONNECTED` code or `httpStatus`. The send service MUST produce the `409 MAILBOX_NOT_CONNECTED` contract itself, two ways (do both):
- **Pre-check** before the email branch: `const mb = await emailMailboxService.getMailboxStatus(companyId)`; if `!mb || mb.status !== 'connected'` → throw `ServiceError('MAILBOX_NOT_CONNECTED', 'Connect Google Email to send.', 409)`. Covers `disconnected` and `reconnect_required` up front.
- **Defensive catch** around `sendEmail`: if it throws (`Error('Mailbox is not connected')` plain, or `Error('Mailbox requires reconnection')` with `statusCode===409`), re-throw as `ServiceError('MAILBOX_NOT_CONNECTED', <message>, 409)` so a mailbox that flips mid-send still maps to 409 (not 500).
- **Status untouched** on this path (step 7 not reached).

### 2.5 Error matrix (both endpoints)
| HTTP | code | When | Side effects |
|---|---|---|---|
| **400** | `VALIDATION` | Missing/blank recipient; invalid channel; (estimate) no items / archived | none |
| **404** | `NOT_FOUND` | Doc id not found or belongs to another company (tenant-safe — 404 not 403) | none |
| **403** | (auth layer) | Caller lacks `estimates.send`/`invoices.send` | none |
| **409** | `MAILBOX_NOT_CONNECTED` | Email channel, mailbox missing / `disconnected` / `reconnect_required` (§2.4) | **status unchanged** |
| **402** | `WALLET_BLOCKED` | SMS channel, wallet at/below grace floor (from `assertServiceActive` inside `sendMessage`) | **status unchanged** |
| **422** | `NO_PROXY` | SMS channel, no company sending number (`resolveCompanyProxyE164`→null) | **none** (checked before conv) |
| **422** | `NO_PHONE` | SMS channel, `toE164(recipient)` null/invalid | none |
| **500** | `INTERNAL` | Renderer missing, unexpected Gmail/Twilio failure | status unchanged |

### 2.6 Default templates (subject synthesized; body = operator message)
The **dialog** prefills the editable `message`; the **service** uses `message` as the body and only synthesizes the email **subject** and wraps the link.
- **Email subject**: estimate → `Estimate {number} from {company}`; invoice → `Invoice {number} from {company}`.
- **Email body**: HTML wrap of `message` (newlines→`<br>`) + an anchor to `link` ("View your estimate online" / "View & pay your invoice online"). The PDF is the attachment.
- **SMS body** (`smsBody(message, link)`): the operator `message`; if it does not already contain `link`, append ` {link}`. (Dialog default already embeds the link → usually a no-op.)

### 2.7 Status-flip-after-success rule (fix the invoice flip-first)
- **Today** `sendInvoice` flips to `sent`/`sent_at` **first**, then "records" (no real send). **Fix**: dispatch first; flip status + write the `sent` event **only after** `sendEmail`/`sendMessage` resolves. Any dispatch throw propagates **before** the flip → the doc is **never** falsely marked Sent (AC-6).
- Estimate gains the same ordering (it never flipped before).
- This rule is the single most important behavioral guarantee of PART A.

### 2.8 Shared `resolveCompanyProxyE164`
Extract from `routes/jobs.js:716` into `backend/src/services/messagingHelper.js` (no logic change); import in `jobs.js` and both send services. Returns null ⇒ `422 NO_PROXY`.

---

## 3. Send dialog behavior (frontend)

### 3.1 `EstimateSendDialog` → invoice parity (`frontend/src/components/estimates/EstimateSendDialog.tsx`)
- **Props** gain `contactPhone`, `estimateNumber`, `contactName` (today: `open, onOpenChange, estimateId, contactEmail, onSend`).
- **State**: `channel:'email'|'sms'`, `emailRecipient` (prefill `contactEmail`), `phoneRecipient` (prefill `contactPhone`), `message`, `publicUrl`, `userEditedMessage`, `sending`.
- **On open**: `ensureEstimatePublicLink(estimateId)` (new `estimatesApi` fn → `POST /api/estimates/:id/public-link`) → `{ url }` → `publicUrl`; build default `message` via `buildDefaultMessage(channel, { estimateNumber, name, url })` (estimate copy: "Here's your estimate {n}. View it online: {url}"). Re-running the default on channel switch unless `userEditedMessage`.
- **Controls**: channel toggle (email | SMS); recipient field bound to the channel (email vs phone), **editable**; message **required**, editable. **Send disabled** when the channel's recipient is blank.
- **Submit**: `onSend({ channel, recipient, message })` → `sendEstimate(id, data)` → success toast + close + parent refetch (status now `sent`); error toasts per §2.5.
- `EstimateSendData` (estimatesApi.ts:140) becomes `{ channel:'email'|'sms'; recipient:string; message:string }` (drop the optional/`'text'` ambiguity for the send payload).

### 3.2 `InvoiceSendDialog` — reused as-is (`…/invoices/InvoiceSendDialog.tsx`)
Already complete: `channel`, `emailRecipient`/`phoneRecipient`, `message`, `includePaymentLink` (default `balanceDue>0`), `publicUrl` via `ensureInvoicePublicLink(invoiceId)`, `buildDefaultMessage`. Emits `{ channel, recipient, message }`; pass `includePaymentLink` through to `sendInvoice`. No structural change beyond §3.3 connect-CTA.

### 3.3 Connection status + connect CTA (email channel)
- On the **email** channel the dialog checks `emailApi.getTimelineMailboxStatus()` → `{ connected, email_address }`. If `!connected`: render an inline notice **"Connect Google Email to send"** + a CTA link to the **Google Email marketplace app** setup path (`/settings/integrations/google-email`, §4), and **disable email Send**. Never link to `/settings/email` (removed).
- Defensive: a `409 MAILBOX_NOT_CONNECTED` from the API surfaces the same CTA (toast). Reuses the existing `IntegrationsPage` pattern (`gmailConnected = mailbox.provider==='gmail' && status==='connected'`).
- **FR-B7 unchanged source**: the dialog's connection check stays `getTimelineMailboxStatus`; only the CTA destination changes.

### 3.4 Financials-tab fix (FR-A7) — replace the direct-send bypass
- **Today**: `JobFinancialsTab.tsx:343` and `LeadFinancialsTab.tsx:277` call `sendInvoice(selectedInvoice.id, { channel:'email', recipient:'' })` directly from `InvoiceDetailPanel.onSend` (a no-arg `()=>void`). With §2 the empty recipient now **400s**.
- **Fix**: route through `InvoiceSendDialog` (and `EstimateSendDialog` for estimates). The tab owns the dialog (or `InvoiceDetailPanel` is upgraded to render it), passing `contactEmail`/`contactPhone`/`invoiceNumber`/`contactName`/`balanceDue`/`total`/`dueDate` so the dialog **prefills**; the tab's send becomes the real `sendInvoice(id, { channel, recipient, message, includePaymentLink })` with the dialog's payload. Estimates analogous via `EstimateSendDialog` with `contactEmail`/`contactPhone`/`estimateNumber`/`contactName`.
- Result: the operator always confirms recipient/message; send from a job/lead works end-to-end (AC-8).

---

## 4. Marketplace app `google-email` (PART B)

### 4.1 Seed row — migration **132** (`132_seed_google_email_marketplace_app.sql`)
Mirror the Stripe seed (116). `INSERT INTO marketplace_apps (...) VALUES (...) ON CONFLICT (app_key) DO UPDATE SET … updated_at=NOW()`:
- `app_key='google-email'`, `name='Google Email'`, `provider_name='Albusto'`, `category='communication'`, `app_type='internal'`, `provisioning_mode='none'`, `status='published'`.
- `short_description='Send estimates & invoices and sync mail from your Gmail.'`; long description per architecture D.1.
- `requested_scopes='["email:send","email:read"]'::jsonb`.
- `metadata = '{"setup_path":"/settings/integrations/google-email","manages_gmail_connection":true}'::jsonb`.
- **Same migration** also repoints mail-secretary's CTA (FR-B6): `UPDATE marketplace_apps SET metadata = jsonb_set(metadata,'{dependency_cta,path}','"/settings/integrations/google-email"') WHERE app_key='mail-secretary';`
- `google-email` does **not** go through `installApp` provisioning (mode `none`); its lifecycle IS the OAuth connect/disconnect.

### 4.2 CONNECT → existing OAuth (unchanged backend)
- The app's setup surface (new `GoogleEmailSettingsPage` at `/settings/integrations/google-email`, mirroring `StripePaymentsSettingsPage`/`VapiSettingsPage`; or the `IntegrationsPage` "Connect Gmail" inline action) calls the **unchanged** `POST /api/settings/email/google/start` → `{ auth_url }` → browser navigates to Google consent → `GET /api/email/oauth/google/callback`. **No OAuth rewrite.**
- **Callback redirect change (FR-B6)** — `routes/email-oauth.js`: replace `const SETTINGS_URL = '/settings/email'` with `'/settings/integrations/google-email'`. All branches preserve their query flags onto the new path: success → `?connected=1`; provider/state/param errors → `?error=<msg>`; tenant conflict → `?email_error=already_connected`; connect failure → `?email_error=connect_failed`. The new setup page reads these flags and toasts. OAuth logic otherwise untouched (AC-13/15).

### 4.3 CONNECTED state = real mailbox (the resolved decision — overlay, NOT an install row)
The `google-email` app's connected state and displayed address derive from the **actual Gmail mailbox** (`emailMailboxService` / `getTimelineMailboxStatus` → `{ connected, email_address }` / `getMailboxStatus` → `{ provider:'gmail', status, email_address }`), **not** from a `marketplace_installations` row.

- **Backend overlay (primary, the resolved design)**: in `marketplaceService.listApps` (and `isAppConnected`), **special-case `app_key === 'google-email'`** — read `emailMailboxService` mailbox status and overlay a **synthetic** `installation`:
  - connected ⇔ `mailbox && mailbox.provider==='gmail' && mailbox.status==='connected'`.
  - overlay `installation = { status: connected ? 'connected' : 'disconnected', external_installation_id: mailbox?.email_address || null, … }` (synthetic — no real row inserted).
  - `isAppConnected(companyId,'google-email')` consults the **mailbox**, not an install row, so dependency gates (e.g. mail-secretary's "Connect Gmail before enabling…") resolve from the truth.
  - This mirrors the existing per-app-key special-casing convention (`SMART_SLOT_ENGINE_APP_KEY`); the generic `installation.status==='connected'` rule is **overridden** for this one key.
- **Frontend mirror**: the app's card/detail (`IntegrationsPage` / `GoogleEmailSettingsPage`) treats `mailbox.provider==='gmail' && status==='connected'` as connected and shows `email_address` ("Connected ✓ name@domain"). For `google-email` specifically, override the generic install-row check with this mailbox-derived boolean.
- **Truthfulness invariants** (US-8, AC-10):
  - `status==='reconnect_required'` (or `'sync_error'`/`'disconnected'`) ⇒ app shows **Not connected** (overlay `disconnected`), even if a stale install row exists.
  - Disconnecting the mailbox flips the app to Not connected **without** mutating an install row.
  - No mailbox at all ⇒ Not connected + Connect action.

### 4.4 DISCONNECT → existing endpoint
The app's Disconnect calls the **unchanged** `POST /api/settings/email/disconnect` (tears down the Gmail watch, nulls tokens, **preserves** synced history). After it returns, the mailbox-derived state (§4.3) flips to Not connected — no separate install-row mutation (AC-11).

### 4.5 Remove `/settings/email` (FR-B5) + repoint all references
- `App.tsx:142`: **delete** the `/settings/email` route rendering `EmailSettingsPage`; **add a redirect** `<Route path="/settings/email" element={<Navigate to="/settings/integrations/google-email" replace />} />` so old bookmarks and the in-flight OAuth callback (until caches clear) don't 404 (AC-12).
- `appLayoutNavigation.tsx:96`: **remove** the `{ label:'Email', icon:Mail, path:'/settings/email', permission:'tenant.integrations.manage' }` nav item.
- Repurpose `EmailSettingsPage.tsx`'s connect/disconnect/status JSX into `GoogleEmailSettingsPage.tsx` (preferred over rebuild).
- Repoint every other `/settings/email` string to `/settings/integrations/google-email`:
  - `SmsForm.tsx:116` (`navigate('/settings/email')` → new path).
  - `EmailThreadPane.tsx:63,104` (ReconnectBanner `navigate`).
  - `EmailPage.tsx:100` (connect CTA `navigate`).
  - `IntegrationsPage.tsx:58` (`settingsPath = … || '/settings/email'` fallback → new path).
  - `emailApi.ts` (any `/settings/email` ref — note this is distinct from the **API** path `/api/settings/email/...` which stays).
  - mail-secretary `dependency_cta.path` (data, via migration 132 §4.1).
- **Do not touch** the OAuth **API** paths (`/api/settings/email/google/start`, `/api/settings/email/disconnect`, `/api/email/oauth/google/callback`) — only the **frontend route** `/settings/email` is removed.

---

## 5. Edge cases

1. **No contact email** (email channel) → recipient blank ⇒ dialog disables Send; if forced, backend `400 VALIDATION`. Operator may type any address (recipient editable); timeline stamp runs only when `contact_id` present.
2. **No contact phone** (SMS) → blank recipient ⇒ Send disabled; forced ⇒ `400 VALIDATION` (or `422 NO_PHONE` if a non-empty but unparseable string is sent).
3. **No company Twilio number** (SMS) → `resolveCompanyProxyE164`→null ⇒ `422 NO_PROXY`, **no side effects**, no false Sent.
4. **Wallet blocked mid-send** (SMS) → `assertServiceActive` throws inside `sendMessage` ⇒ `402 WALLET_BLOCKED`; status untouched; toast "Messaging is paused — top up your balance."
5. **Email disconnected/reconnect mid-send** → pre-check or the defensive catch yields `409 MAILBOX_NOT_CONNECTED` (§2.4); status untouched; UI surfaces the connect CTA → Google Email app.
6. **Partial success** (email sent, timeline stamp fails) → send is authoritative; stamp is best-effort/try-catch so it never rolls back the send nor blocks the status flip; a missed stamp self-heals via the EMAIL-TIMELINE-001 sent-mail projection.
7. **Idempotent re-send** → `ensurePublicLink` reuses the token (URL stable). A doc already `sent` may be re-sent (status re-flips `sent`/`sent_at`, a new `sent` event is appended — an audit trail of each send). Allowed by design.
8. **Public token of a deleted/void/archived doc** → `getEstimateByPublicToken` returns null (deleted) or a void/archived row. The public view shows the doc's current `status` (e.g. "void"); a hard-deleted row ⇒ `404` neutral "no longer available". No tenant data leaks either way.
9. **Removing `/settings/email` must not break the OAuth backend** → only the **frontend route** is removed; API paths and `emailMailboxService` are untouched; the callback redirect points at the new page; the `/settings/email`→Navigate redirect catches in-flight callbacks until caches clear.
10. **Marketplace connected-state when `reconnect_required`** → app shows **Not connected** (overlay maps non-`connected` statuses to `disconnected`); `isAppConnected('google-email')` returns false; mail-secretary's Gmail gate blocks accordingly (AC-14).
11. **Tenant isolation** → public token lookups are unscoped-by-design (token=cred, unique index ⇒ one row); all authenticated send/link/status paths keep the `company_id` filter; cross-tenant doc id ⇒ `404` (not 403).

---

## 6. Component interaction (summary)

- **Estimate email**: `EstimateSendDialog` → `POST /api/estimates/:id/send` → `estimatesService.sendEstimate` → `ensurePublicLink` + `generatePdf` + `emailService.sendEmail` → (best-effort) `emailQueries.linkMessageToContact` → status flip + `sent` event → FE refetch.
- **Estimate SMS**: dialog → same route → service → `resolveCompanyProxyE164` → `conversationsService.getOrCreateConversation` + `sendMessage` (wallet gate inside, projects to timeline) → status flip + event.
- **Public view**: customer browser → SPA `/e/:token` (`PublicEstimateViewPage`) → `GET /api/public/estimates/:token` (view JSON) + "Download PDF" → `GET /api/public/estimates/:token/pdf`.
- **Marketplace**: `IntegrationsPage`/`GoogleEmailSettingsPage` → `marketplaceService.listApps` (overlays mailbox status for `google-email`) + `getTimelineMailboxStatus`; Connect → `POST /api/settings/email/google/start` → Google → `GET /api/email/oauth/google/callback` → `302 /settings/integrations/google-email?connected=1`; Disconnect → `POST /api/settings/email/disconnect`.

---

## 7. Protected / do-not-break (from requirements §6, architecture E)
- EMAIL-TIMELINE-001 send/receive + `linkMessageToContact` semantics; EMAIL-001 inbox/search/attachments/5-min scheduler.
- Google OAuth backend (`email-settings.js`, `email-oauth.js` **except** the `SETTINGS_URL` string, `emailMailboxService` incl. token refresh + Gmail watch).
- Invoice pay page `/pay/:token`, `ensureInvoicePublicLink`, `/i/:token`, Stripe public-pay routes — the estimate public routes are **additive**, not a refactor.
- `crypto.randomBytes` token scheme + unique partial index pattern (mirror, don't alter).
- Wallet gating (`assertServiceActive`) + `resolveCompanyProxyE164` contract (422 on missing proxy).
- `src/server.js` public-router mount order (auth-skipping `/api/public/*` + `/i/:token`).
