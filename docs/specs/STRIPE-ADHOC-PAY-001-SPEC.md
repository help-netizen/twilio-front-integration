# Спецификация: STRIPE-ADHOC-PAY-001 — invoice-independent Stripe collect (arbitrary amount) from the Job Finance tab

**Status:** Spec · **Date:** 2026-07-07 · **Source of truth:** `docs/requirements.md ## STRIPE-ADHOC-PAY-001` (FR-BTN/CTA/DLG/CARD/LINK/LEDGER, AC-1..7, §8 OPEN ITEM) + `docs/architecture.md ## STRIPE-ADHOC-PAY-001` (§0..§8). **Where code contradicts the docs, code wins and the discrepancy is recorded in §0.6.**

## General description

From **Job → Finance tab**, a permitted user on a Stripe-ready company collects an **arbitrary** card amount (prefilled to the job's outstanding balance) — keyed card, a hosted Stripe Checkout link, or a copied link — **with no invoice created**. The charge lands as **one `payment_transactions` row with `job_id` set and `invoice_id NULL`** via the unchanged webhook. No migration (max stays 155). The invoice collect flow stays byte-unchanged.

---

## §0 Ground truth (code-verified 2026-07-07 — line-accurate quotes)

### §0.1 `resolveSurfaceContext` — CURRENT (`backend/src/services/stripePaymentsService.js:282-302`)
```js
async function resolveSurfaceContext(companyId, { invoiceId, jobId, amount }) {
    let ctx = { invoiceId: invoiceId || null, jobId: jobId || null, contactId: null, amount: amount != null ? Number(amount) : null, invoiceNumber: null };
    if (invoiceId) {
        const invoice = await invoicesService.getInvoice(companyId, invoiceId);
        if (!invoice) throw new StripePaymentsError('NOT_FOUND', ...404);
        if (['void','refunded','paid'].includes(invoice.status)) throw ... INVALID_STATUS 400;
        const balance = invoiceBalance(invoice);
        ctx.amount = amount != null ? Number(amount) : balance;
        ctx.contactId = invoice.contact_id || null;
        ctx.jobId = ctx.jobId || invoice.job_id || null;
        ctx.invoiceNumber = invoice.invoice_number;
        if (!(ctx.amount > 0) || ctx.amount > balance) throw ... INVALID_AMOUNT 400;
    } else {
        if (!(ctx.amount > 0)) throw new StripePaymentsError('INVALID_AMOUNT', 'amount is required', 400);
    }
    return ctx;
}
```
**Key fact:** there is **no `else if (jobId)` branch today.** A job-only call falls into the bare `else`, which only asserts `amount > 0` — it does NOT load the job, so `ctx.contactId` stays `null` and no recipient email/phone is available. The architecture's job branch (loads job → `contactId` + `email`/`phone`/`customerName`, calls `assertAdhocAmount`) is **net-new** and must be added.

### §0.2 `sendPaymentLink` (invoice) — CURRENT (`stripePaymentsService.js:264-273`)
```js
async function sendPaymentLink(companyId, actor, invoiceId, { channel = 'email', message } = {}) {
    const link = await ensurePaymentLink(companyId, actor, invoiceId);
    // Delivery follows the existing invoice send pattern (event-logged). Actual
    // email/SMS dispatch is handled by the shared messaging path / invoice send.
    await invoicesQueries.createEvent(invoiceId, 'payment_link_sent', 'user', actor?.id || null, { channel, message: message || null, url: link.url });
    await auditService.log({ ... action: 'stripe_payments.payment_link_sent', target_type: 'invoice', ... });
    return { sent: true, url: link.url, channel };
}
```
**Confirmed:** `sendPaymentLink` performs **NO email/SMS dispatch** — only `invoicesQueries.createEvent(...'payment_link_sent'...)` + `auditService.log`, returns `{ sent:true, url }`. Its own comment defers dispatch to "the shared messaging path / invoice send." **This is the OPEN ITEM; resolution in §0.5.**

### §0.3 `ensurePaymentLink` (invoice) — CURRENT (`stripePaymentsService.js:202-253`)
Loads invoice (404 foreign), rejects `void/refunded/paid` (INVALID_STATUS 400), computes `balance`, `payAmount = amount ?? balance`, rejects `!(payAmount>0) || payAmount>balance` (INVALID_AMOUNT 400). Reuses via `findOpenSession(companyId, invoiceId, payAmount)` → same `{url,expires_at,reused:true}`. Else `provider.createCheckoutSession(account.stripe_account_id, { amount, currency, invoiceNumber, successUrl:`${baseUrl()}/i/${public_token}?paid=1`, cancelUrl:`${baseUrl()}/i/${public_token}`, expiresAt, metadata:{company_id, invoice_id, job_id, contact_id} }, { idempotencyKey:`inv-${companyId}-${invoiceId}-${payAmount}` })`, inserts a `stripe_payment_sessions` row (`surface:'checkout_link'`), audit-logs `payment_link_created` (`target_type:'invoice'`). 24h expiry. **Byte-unchanged by this feature.**

### §0.4 Manual-card **job** route — CURRENT (`backend/src/routes/jobs.js:877-883`)
```js
const stripePaymentsService = require('../services/stripePaymentsService');            // :867
function jobStripeError(err, res) {                                                    // :869
    if (err instanceof stripePaymentsService.StripePaymentsError)
        return res.status(err.httpStatus || 400).json({ ok:false, error:{ code:err.code, message:err.message } });
    return res.status(err.httpStatus || 500).json({ ok:false, error:{ code:err.code||'INTERNAL', message:err.message } });
}
router.post('/:id/stripe-manual-card-session', requirePermission('payments.collect_keyed'), async (req, res) => {
    const companyId = req.companyFilter?.company_id;
    const data = await stripePaymentsService.createManualCardSession(companyId, { id: req.user?.sub }, { jobId: req.params.id, amount: req.body?.amount });
    res.json({ ok: true, data });
});
```
Route already live. `companyId = req.companyFilter?.company_id`; `actor = { id: req.user?.sub }`; router mounted under `authenticate` + `requireCompanyAccess`. Error envelope: `{ ok:false, error:{ code, message } }` via `jobStripeError`. New routes attach here.

### §0.5 SEND-DOC-001 real dispatcher — CURRENT (`backend/src/services/invoicesService.js:360-449`) — **THE OPEN-ITEM RESOLUTION**
`sendInvoice(companyId, userId, id, { channel, recipient, message, includePaymentLink, userEmail })` is a **REAL, working dispatcher** (mirror in `estimatesService.sendEstimate`):
- **Email path** (`:383-432`): pre-checks `emailMailboxService.getMailboxStatus(companyId)` → `409 MAILBOX_NOT_CONNECTED` if not `connected`; builds subject + PDF; calls **`emailService.sendEmail(companyId, { to, subject, body, files:[{mimetype,originalname,buffer}], userId, userEmail })`** (`backend/src/services/emailService.js:68`, signature `sendEmail(companyId, { to, cc, subject, body, files, userId, userEmail })`). Maps "mailbox not connected/requires reconnection" → 409.
- **SMS path** (`:433-449`): `resolveCompanyProxyE164(companyId)` (`messagingHelper.js:18`) → **`422 NO_PROXY`** if none; `toE164(recipient)` → **`422 NO_PHONE`** if invalid; `conversationsService.getOrCreateConversation(customerE164, proxy, companyId)`; **`conversationsService.sendMessage(conv.id, { body })`** (`conversationsService.js:104`, signature `sendMessage(conversationId, { body, author='agent', mediaSid, fileInfo })`) — wallet gate inside propagates `{ httpStatus:402, code:'WALLET_BLOCKED' }`.

**⇒ A reusable, live email+SMS dispatcher EXISTS.** The Stripe `sendPaymentLink` (§0.2) chose not to use it (event-log only); `sendInvoice`/`sendEstimate` DO use it. **RESOLUTION = option (a): wire `sendJobPaymentLink` to the SEND-DOC-001 dispatcher (email via `emailService.sendEmail`, SMS via `resolveCompanyProxyE164` + `conversationsService`), so "Send payment link" actually delivers.** Exact behavior/copy in §3.4 and §4.3.

### §0.6 Discrepancies vs requirements/architecture (code wins)
1. **Architecture §5 said "mirror `sendPaymentLink` → event-log only, no real dispatcher."** Code proves a real dispatcher exists (`sendInvoice`, §0.5). **Spec overrides:** `sendJobPaymentLink` **must** wire to it (§3.4). The architecture's `sendJobPaymentLink` skeleton (`resolveSurfaceContext` → 422 NO_CONTACT → `ensureJobPaymentLink` → audit) is kept as the **envelope**, with a real `emailService.sendEmail` / `conversationsService.sendMessage` dispatch inserted before the audit-log. Recipient validation + channel fallbacks (§3.4) stay as architected.
2. **Table name.** Requirements §Verified-ground-truth call it "the `checkout_link` surface" / "`checkout_link` has a `job_id` column." Real table = **`stripe_payment_sessions`** (`job_id`, `invoice_id`, `surface` columns; `surface='checkout_link'` is a value). Architecture §0 is correct. Spec uses `stripe_payment_sessions` + `surface='checkout_link'`.
3. **`/pay/thanks` route collides with `/pay/:token`.** `App.tsx:108` = `<Route path="/pay/:token" element={<PublicInvoicePayPage/>}>`; a literal `/pay/thanks` would match `:token="thanks"` and render the invoice pay page (which then 404s internally on token lookup). **Spec requires** the `/pay/thanks` route be declared **BEFORE** `/pay/:token` in `App.tsx` (React Router first-match) OR use a distinct path; see §3.5 / NFR.
4. **`getStatus` response shape.** Backend `getStatus` returns the status object directly (`stripePaymentsService.js:98-104`); the frontend `stripePaymentsApi.getStatus()` returns `{ status: StripePaymentsStatus }` (route wraps it). `can_collect === true` **iff** `readiness ∈ {connected_ready, payouts_disabled}` (`canCollect`, `:61-63`) — **note `payouts_disabled` still collects.** Requirements FR-BTN-1 says gate on `connected_ready`; architecture §FR-CTA gates on `can_collect`. **Spec uses `can_collect`** (code's real gate) — this **includes** `payouts_disabled` as collectable, matching the invoice path. Recorded here so Test-Cases assert `can_collect`, not literal `connected_ready`.
5. **Readiness enum.** `computeReadiness` (`:48-58`) yields `not_connected | disconnected | onboarding_incomplete | action_required | payments_disabled | payouts_disabled | connected_ready`. All seven are handled in §3.1 CTA states.

### §0.7 Other current facts
- `JobFinancialsTab.tsx:101-103`: `totalInvoiced = Σ total`, `totalPaid = Σ amount_paid`, `totalDue = Math.max(totalInvoiced - totalPaid, 0)`. Prefill = `totalDue > 0 ? totalDue : blank`.
- `ManualCardDialog.tsx:9-14` props today: `{ open, onOpenChange, invoiceId: number, onSuccess? }`; `:36` calls `invoiceStripeApi.manualCardSession(invoiceId)`. Must generalize to `{ invoiceId?, jobId?, amount? }`.
- `findOpenSession` (`stripePaymentsQueries.js:97-108`): `WHERE company_id=$1 AND invoice_id=$2 AND surface='checkout_link' AND status='open' AND amount=$3 AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC LIMIT 1`. Job analogues add `AND job_id=$2 AND invoice_id IS NULL`.
- `assertAdhocAmount` **does not exist yet** — new helper (§4.4).
- `frontend/src/services/stripePaymentsApi.ts`: `stripePaymentsApi.getStatus()`; `invoiceStripeApi.{createLink,getLink,sendLink,manualCardSession,refund}`. New `jobStripeApi` mirrors these.

---

## §1 Scenarios — FR-BTN button gating + FR-CTA readiness

### §1.1 Button shown (happy path)
- **Given** user holds ≥1 of `payments.collect_online` / `payments.collect_keyed` (**AND** `payments.collect_offline` per requirements FR-BTN-1) **and** `getStatus().status.can_collect === true`
- **When** the Finance tab renders
- **Then** a primary **"Collect payment"** button appears on the metrics row (right of **Due**); click opens `CollectPaymentDialog`.

### §1.2 No collect perm → render nothing (FR-BTN-2)
- **Given** user holds **none** of the collect perms
- **Then** the collect area renders **nothing** — no button, no CTA, no placeholder — regardless of Stripe readiness.

### §1.3 CTA states (permitted-to-collect user, `can_collect === false`) — FR-CTA
Muted card on `var(--blanc-surface-muted)` (FORM-CANON, tokens only, English). Behavior splits on `tenant.integrations.manage`:

| `readiness` | Manage user: title / body / action → route | Non-manage user (FR-CTA-3) |
|---|---|---|
| `not_connected` | **"Accept payments right from the job"** / **"Connect Stripe to charge your customer's card or send a payment link in seconds — no invoice required."** / **[Connect Stripe]** → `/settings/integrations/stripe-payments` | plain text **"Ask an account admin to connect Stripe in Settings → Integrations."** (no button) |
| `onboarding_incomplete` | body **"Finish your Stripe setup to start collecting payments"** / **[Finish setup]** → same route | same "Ask an account admin…" text |
| `action_required` | same as onboarding_incomplete (**"Finish your Stripe setup…"** / **[Finish setup]**) | same |
| `payments_disabled` | **[Finish setup]** → same route (card capability inactive) | same |
| `disconnected` | treat as `not_connected` (**[Connect Stripe]**) | same |
| `payouts_disabled` | **does NOT reach CTA** — `can_collect===true` → button shows (§1.1) | n/a |
| loading / `configured === false` | **nothing** (button hidden; matches invoice silent-absence) | nothing |

- **AC-2** satisfied: each state → its copy/action; manage vs non-manage differ; all buttons route to Settings → Integrations → Stripe Payments.

---

## §2 Scenarios — FR-DLG CollectPaymentDialog

### §2.1 Amount prefill
- **Given** dialog opens with `outstanding = totalDue` (§0.7)
- **Then** the amount field is prefilled to `outstanding` **iff `outstanding > 0`**, else **blank**; always editable.

### §2.2 Amount validation (client mirror of `assertAdhocAmount`, §4.4)
| Input | Result |
|---|---|
| `< 0.50` (incl `0`, blank) | inline error **"Amount must be at least $0.50"**; submit disabled |
| `> 100000` | inline error **"Amount exceeds the $100,000 limit"**; submit disabled |
| non-numeric / negative | treated as invalid (< 0.50 path); submit disabled |
| >2 decimals | rounded to 2dp on blur before submit |
| `0.50 ≤ x ≤ 100000`, 2dp | valid; proceed |
Client validation is UX-only; **server `assertAdhocAmount` is the source of truth** (§4.4) — the same rules run on both link and keyed-card server paths.

### §2.3 Method chooser
Three methods (FR-DLG-3): **Enter card manually** → delegates to generalized `ManualCardDialog` with `{ jobId, amount }`; **Send payment link** → `jobStripeApi.sendLink`; **Copy payment link** → `jobStripeApi.createLink` then copy `url` to clipboard. All within one FORM-CANON surface (right panel desktop / bottom-sheet mobile; `DialogPanelHeader`/`DialogBody`/`DialogPanelFooter`).

---

## §3 Scenarios — flows

### §3.1 Manual card on job (FR-CARD)
- **Given** valid amount, **Enter card manually**
- **When** dialog mounts → `jobStripeApi.manualCardSession(jobId, amount)` → **existing** `POST /api/jobs/:id/stripe-manual-card-session` (perm `payments.collect_keyed`) → `createManualCardSession` → `createCardSession('manual_card', { jobId, amount })` → `resolveSurfaceContext` **(now with the job branch)** validates via `assertAdhocAmount`, sets `contactId` from job → `provider.createPaymentIntent`
- **Then** Stripe Payment Element renders (card fields never touch Albusto); on `confirmPayment` success, toast **"Payment submitted"**; the **webhook** later writes **one `payment_transactions` row: `job_id` set, `invoice_id NULL`, `contact_id` attributed** (AC-3, FR-LEDGER).
- **Errors:** `NOT_READY` (409, Stripe not collectable) → "Connect Stripe in Integrations first."; card decline → Stripe `payError.message`; network → generic "Could not start card entry" / retry.
- **New guard:** amount now runs through `assertAdhocAmount` server-side (previously the bare `else` only checked `>0`) → `< $0.50` or `> $100k` returns `INVALID_AMOUNT` 400 (AC-7).

### §3.2 Create / copy link (FR-LINK)
- **Copy:** **Copy payment link** → `jobStripeApi.createLink(jobId, amount)` → `POST /api/jobs/:id/stripe-payment-link` (perm `payments.collect_online`) → `ensureJobPaymentLink` → reuse open session for `{companyId,jobId,amount}` if present (idempotent, `reused:true`) else create Stripe hosted Checkout session (idempotencyKey `job-${companyId}-${jobId}-${amount}`) + insert `stripe_payment_sessions` row (`job_id` set, `invoice_id NULL`, `surface='checkout_link'`) + audit `payment_link_created` (`target_type:'job'`). Returns `{ url, expires_at, reused }`. UI copies `url` to clipboard, toast **"Payment link copied"**.
- **Reuse:** a second create for the same `{companyId,jobId,amount}` returns the **same** `url` (`findOpenJobSession`, AC-4). Different amount → new session.
- **Read:** `GET /api/jobs/:id/stripe-payment-link` (perm `payments.view`) → `getJobPaymentLink` → `{ active, history }` (active = open, non-expired `checkout_link` with `invoice_id IS NULL`).

### §3.3 Public pay (hosted) + `/pay/thanks`
- The link `url` is a **Stripe-HOSTED** Checkout Session URL. Customer pays on Stripe's page — `PublicInvoicePayPage` is **not** used/touched.
- `successUrl` and `cancelUrl` both = `${baseUrl()}/pay/thanks` (job has no invoice public token).
- **`/pay/thanks` MUST exist** as a minimal public "Thanks — your payment was received" route, declared **before** `/pay/:token` in `App.tsx` (else `:token="thanks"` collision, §0.6.3). If missing/miscollided, the customer sees a broken page though the payment still settles via webhook.
- **Ledger:** webhook (`payment_intent.succeeded` / `checkout.session.completed`) reads `session.job_id` + metadata `job_id`, calls `applyStripePayment` → one `payment_transactions` row, `job_id` set, `invoice_id NULL`. **No double charge:** Stripe idempotency key + `findOpenJobSession` reuse (one session) + webhook dedup on `findByExternalSourceId` (one ledger row). **No auto-invoice** (FR-LEDGER-3; the `if(invoiceId)` balance block is skipped).

### §3.4 Send link (FR-LINK-4) — **RESOLUTION (a): real dispatch wired to SEND-DOC-001**
- **Given** **Send payment link**, optional `channel` (`email`|`sms`), optional `message`
- **When** `jobStripeApi.sendLink(jobId, { channel?, message? })` → `POST /api/jobs/:id/send-payment-link` (perm `payments.collect_online`) → `sendJobPaymentLink`:
  1. `resolveSurfaceContext(companyId, { jobId, amount })` → job's `email`/`phone`/`customerName` (from `jobsService.getJobById(jobId, companyId)`; foreign job → 404).
  2. If **no email AND no phone** → **`422 NO_CONTACT`** ("Job has no email or phone to send to").
  3. Channel select: forced `channel` honored (422 `NO_CONTACT` if that channel's contact missing); no forced channel → **default email if present, else SMS**.
  4. `ensureJobPaymentLink(...)` → the hosted link `url`.
  5. **DISPATCH (new — wired to the real dispatcher, §0.5):**
     - **Email:** pre-check `emailMailboxService.getMailboxStatus(companyId)` → **`409 MAILBOX_NOT_CONNECTED`** ("Connect Google Email to send.") if not `connected`; then `emailService.sendEmail(companyId, { to: email, subject: "Payment request from {companyName}", body: <message + link>, userId: actor.id, userEmail })`. (No PDF — a bare pay link, unlike invoice send.)
     - **SMS:** `resolveCompanyProxyE164(companyId)` → **`422 NO_PROXY`** if none; `toE164(phone)` → **`422 NO_PHONE`** if invalid; `getOrCreateConversation` + `conversationsService.sendMessage(conv.id, { body: <message + link> })`. Wallet gate propagates **`402 WALLET_BLOCKED`**.
  6. `auditService.log('stripe_payments.payment_link_sent', target_type:'job', details:{ channel })`. **No `invoicesQueries.createEvent`** (jobs have no invoice-event stream) — audit row is the record.
  7. Return `{ sent:true, url, channel }`.
- **UI copy (honest — send truly dispatches):** success toast **"Payment link sent"** (or **"Payment link texted"** / **"Payment link emailed to {recipient}"**). On `NO_CONTACT`/`NO_PROXY`/`NO_PHONE`/`MAILBOX_NOT_CONNECTED`/`WALLET_BLOCKED` → error toast with the server message **and** offer **"Copy link instead"** (Copy is always the guaranteed hand-off). "Copy link" remains the primary reliable action.
- **Job w/o contact:** email+phone both absent → 422 `NO_CONTACT` → UI shows "This job has no email or phone — copy the link instead" + copy affordance.

### §3.5 Backward-compat (AC-5)
- Invoice collect path byte-unchanged: `ensurePaymentLink`/`getPaymentLink`/`sendPaymentLink` (invoice signatures), `invoiceStripeApi`, `InvoiceDetailPanel`, `PublicInvoicePayPage`, webhook, `applyStripePayment`, tap-to-pay — **no signature change**. `resolveSurfaceContext` invoice branch edited only by (i) adding a sibling `else if (jobId)` and (ii) swapping the bare-`else` `amount>0` check for `assertAdhocAmount` (same `INVALID_AMOUNT` code; the invoice branch never reaches it). `ManualCardDialog` gains **optional** `jobId?`/`amount?`; sole existing call-site (`InvoiceDetailPanel` passing `invoiceId`) compiles + behaves identically.

---

## §4 Contracts

### §4.1 `POST /api/jobs/:id/stripe-payment-link` — create/reuse
- Middleware: `authenticate` → `requireCompanyAccess` → `requirePermission('payments.collect_online')`. `companyId = req.companyFilter?.company_id`; `actor = { id: req.user?.sub }`.
- Request: `{ amount: number }`.
- Response `200`: `{ ok:true, data:{ url:string, expires_at:string|null, reused:boolean, session_id:number } }`.
- Errors: `409 NOT_READY` (Stripe not collectable); `400 INVALID_AMOUNT` (`assertAdhocAmount`); `404 NOT_FOUND` (foreign/absent job); envelope `{ ok:false, error:{ code, message } }`.

### §4.2 `GET /api/jobs/:id/stripe-payment-link` — read
- Middleware: … `requirePermission('payments.view')`.
- Response `200`: `{ ok:true, data:{ active:{ url, expires_at, amount }|null, history:[{ id, status, amount, surface, failure_reason, created_at }] } }`.
- Errors: `404 NOT_FOUND` (foreign job returns empty via company-scoped query; a genuinely absent scope 404s).

### §4.3 `POST /api/jobs/:id/send-payment-link` — send (real dispatch)
- Middleware: … `requirePermission('payments.collect_online')`.
- Request: `{ channel?: 'email'|'sms', message?: string }` (amount taken from the job's outstanding / open session; if the UI passes an amount it flows through `resolveSurfaceContext`).
- Response `200`: `{ ok:true, data:{ sent:true, url:string, channel:'email'|'sms' } }`.
- Errors: `422 NO_CONTACT` (neither email nor phone, or forced channel's contact missing); `409 NOT_READY`; `409 MAILBOX_NOT_CONNECTED` (email path, Gmail not connected); `422 NO_PROXY` / `422 NO_PHONE` (SMS path); `402 WALLET_BLOCKED` (SMS wallet gate); `400 INVALID_AMOUNT`; `404 NOT_FOUND`.

### §4.4 `assertAdhocAmount(amount)` (new, `stripePaymentsService.js`)
- `< 0.50` → `INVALID_AMOUNT` 400 "Amount must be at least $0.50".
- `> 100000` → `INVALID_AMOUNT` 400 "Amount exceeds the $100,000 limit".
- else → `Number(amount.toFixed(2))`.
- Applied on **every** job/adhoc entry: `ensureJobPaymentLink`, `sendJobPaymentLink` (via `resolveSurfaceContext`), **and** the keyed-card job path (via the new `resolveSurfaceContext` job branch) → AC-7 on link **and** card.

### §4.5 New service fns (`stripePaymentsService.js`)
- `ensureJobPaymentLink(companyId, actor, jobId, { amount })` → assertCollectable(409) → resolveSurfaceContext(job) → `findOpenJobSession` reuse → else `createCheckoutSession(successUrl=cancelUrl=`${baseUrl()}/pay/thanks`, metadata:{company_id, invoice_id:'', job_id, contact_id}, idempotencyKey:`job-${companyId}-${jobId}-${amount}`)` → `insertSession({ invoice_id:null, job_id, contact_id, surface:'checkout_link', status:'open', … })` → audit → `{ url, expires_at, reused, session_id }`.
- `getJobPaymentLink(companyId, jobId)` → `listSessionsForJob` → `{ active, history }`.
- `sendJobPaymentLink(companyId, actor, jobId, { channel, amount, message })` → §3.4.
- `module.exports` gains the three; `createManualCardSession` reused unchanged.

### §4.6 New queries (`stripePaymentsQueries.js`, both company-scoped, `ensureMarketplaceSchema()` first)
- `findOpenJobSession(companyId, jobId, amount)`: `WHERE company_id=$1 AND job_id=$2 AND invoice_id IS NULL AND surface='checkout_link' AND status='open' AND amount=$3 AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC LIMIT 1`.
- `listSessionsForJob(companyId, jobId)`: `WHERE company_id=$1 AND job_id=$2 AND invoice_id IS NULL ORDER BY created_at DESC`.
- `invoice_id IS NULL` is load-bearing: keeps job-link sessions distinct from an invoice's sessions that merely carry a `job_id`.

### §4.7 Records written
- **Session:** one `stripe_payment_sessions` row per new link — `invoice_id NULL`, `job_id`, `contact_id`, `surface='checkout_link'`, `status='open'`, `amount`, `currency='USD'`, `stripe_checkout_session_id`, `url`, `expires_at` (+24h).
- **Ledger (on webhook settle):** one `payment_transactions` row — `job_id` set, `invoice_id NULL`, `contact_id`, via existing `applyStripePayment`. No auto-invoice.
- **Audit:** `payment_link_created` / `payment_link_sent` (`target_type:'job'`). No invoice event stream for jobs.

### §4.8 Frontend `jobStripeApi` (`services/stripePaymentsApi.ts`, mirrors `invoiceStripeApi`)
```ts
jobStripeApi = {
  createLink(jobId, amount?): Promise<{ url; expires_at; reused }>            // POST /api/jobs/:id/stripe-payment-link
  getLink(jobId): Promise<{ active; history }>                                // GET  /api/jobs/:id/stripe-payment-link
  sendLink(jobId, { channel?, message? }): Promise<{ sent; url; channel }>   // POST /api/jobs/:id/send-payment-link
  manualCardSession(jobId, amount?): Promise<ManualCardSession>              // POST /api/jobs/:id/stripe-manual-card-session (existing)
}
```
Error unwrap identical to `invoiceStripeApi` (`json.error?.message`).

### §4.9 Component prop contracts
- **`ManualCardDialog`** (generalized): `{ open, onOpenChange, invoiceId?: number, jobId?: number|string, amount?: number, onSuccess? }`. Exactly one of `invoiceId`/`jobId` present. `invoiceId` → `invoiceStripeApi.manualCardSession(invoiceId, amount)`; `jobId` → `jobStripeApi.manualCardSession(jobId, amount)`. Existing invoice call-site (`invoiceId` only) unchanged.
- **`CollectPaymentDialog`** (new): `{ open, onOpenChange, jobId: number|string, outstanding: number, onSuccess? }`. FORM-CANON; amount step (prefill `outstanding>0`) → method chooser (keyed → `ManualCardDialog`; send → `jobStripeApi.sendLink`; copy → `jobStripeApi.createLink`).
- **`JobFinancialsTab`**: fetches `stripePaymentsApi.getStatus()` (React Query); renders button/CTA per §1; passes `jobId` + `totalDue` to `CollectPaymentDialog`.

---

## §5 Non-functional

- **Company-scope every route:** `companyId = req.companyFilter?.company_id`; all queries `company_id`-filtered; `getJobById(id, companyId)` → foreign job `null` → 404 (no cross-tenant leak).
- **Idempotency:** `job-${companyId}-${jobId}-${amount}` Stripe key + `findOpenJobSession` reuse + webhook dedup (`findByExternalSourceId`) ⇒ at most one charge / one ledger row under double-click / concurrent create / webhook retry.
- **No migration** (max stays **155**); `stripe_payment_sessions.job_id`, `payment_transactions.job_id`, perms `payments.collect_online`/`collect_keyed`/`view` all pre-exist.
- **`/pay/thanks` route required**, declared before `/pay/:token` (§0.6.3).
- **Build/test gate:** `npm run build` (`tsc -b`, prod-strict `noUnusedLocals`) green; backend **jest** green.
- **FORM-CANON + tokens-only (`--blanc-*`) + English copy + product name "Albusto"** in all UI.

---

## §6 Out of scope / protected (must not break)
- Invoice Stripe collect flow: `ensurePaymentLink`/`getPaymentLink`/`sendPaymentLink` (invoice), `invoiceStripeApi`, `InvoiceDetailPanel`, invoice ledger — byte-unchanged.
- Webhook (`handleWebhook`) + ledger (`applyStripePayment`) core — untouched.
- `PublicInvoicePayPage` + `/api/public/invoices/*` — untouched (job link never routes there).
- Tap-to-Pay UI (that's mobile v1.5) — untouched.
- No new perms, no new migration, no new messaging infra (reuses SEND-DOC-001 dispatcher).
