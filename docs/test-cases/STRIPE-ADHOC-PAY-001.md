# Test Cases: STRIPE-ADHOC-PAY-001 — invoice-independent Stripe collect from the Job Finance tab

**Source of truth:** `docs/specs/STRIPE-ADHOC-PAY-001-SPEC.md` (§0..§6) + `Docs/requirements.md ## STRIPE-ADHOC-PAY-001` (AC-1..7) + `Docs/architecture.md ## STRIPE-ADHOC-PAY-001`.
**Date:** 2026-07-07 · **Status:** Test Cases

## Coverage

- **Total:** 46 cases
- **By priority:** P0 = 27 · P1 = 14 · P2 = 4 · P3 = 1
- **By type:** UNIT (backend jest) = 11 · INTEGRATION (backend jest, mocked provider/queries) = 17 · STATIC = 8 · BUILD = 2 · MANUAL = 7 · DEPLOY = 1

### Harness notes

- **Backend jest EXISTS** at `tests/stripePayments.test.js` (repo-root `tests/`, NOT `backend/tests/`). It has **28 `it()` blocks** (the prompt said 26 — recount: 28 today; all must stay green). Run from the worktree with:
  `npx jest --testPathIgnorePatterns "/node_modules/" tests/stripePayments.test.js`
- **Extension approach:** ADD the new job cases to a **new sibling file** `tests/stripeAdhocPay.test.js` that reuses the exact mock harness of `stripePayments.test.js` (`jest.mock` of `stripePaymentsQueries`, `paymentsQueries`, `paymentsService`, `invoicesService`, `invoicesQueries`, `marketplaceService`, `marketplaceQueries`, `auditService`; `provider = require('stripeConnectProvider')` with `provider.createCheckoutSession`/`createPaymentIntent` assigned as `jest.fn()` per-describe). NEW mocks the sibling needs: `jest.mock('../backend/src/services/jobsService')`, `jest.mock('../backend/src/services/emailService')`, `jest.mock('../backend/src/services/conversationsService')`, `jest.mock('../backend/src/services/emailMailboxService')`, and the messaging helper (`resolveCompanyProxyE164`/`toE164`). Keeping job cases in a sibling file avoids touching the 28 protected invoice cases (AC-5 backward-compat guard is cleaner when the invoice file is diff-free). Either file is acceptable; sibling preferred.
- **Frontend has NO jest/vitest.** Frontend cases are STATIC (grep/props/route-order), BUILD (`npm run build`, `tsc -b`, prod-strict `noUnusedLocals`), or MANUAL. Do NOT add a frontend test runner.
- **Mock conventions (match existing file):** `readyAccount = { company_id, stripe_account_id, details_submitted:true, charges_enabled:true, payouts_enabled:true, capabilities:{card_payments:'active'}, status:'connected_ready' }`; `q.getAccountByCompany.mockResolvedValue(readyAccount)` to pass `assertCollectable`; `StripePaymentsError` asserted via `.rejects.toMatchObject({ code, httpStatus })`.

---

## A. `assertAdhocAmount` (§4.4) — pure UNIT

Applies to link AND keyed-card server paths (via the `resolveSurfaceContext` job branch).

### TC-ADHOC-1: min $0.50 boundary — pass
- **Priority:** P0 · **Type:** UNIT · **§ref:** §4.4, AC-7
- **Input:** `assertAdhocAmount(0.50)`
- **Expected:** returns `0.5` (no throw).
- **File:** `tests/stripeAdhocPay.test.js`

### TC-ADHOC-2: below min — reject
- **Priority:** P0 · **Type:** UNIT · **§ref:** §4.4
- **Input:** `assertAdhocAmount(0.49)`
- **Expected:** throws `StripePaymentsError` `{ code:'INVALID_AMOUNT', httpStatus:400, message:'Amount must be at least $0.50' }`.

### TC-ADHOC-3: zero and blank — reject
- **Priority:** P0 · **Type:** UNIT · **§ref:** §4.4, §2.2
- **Input:** `assertAdhocAmount(0)`, `assertAdhocAmount('')`, `assertAdhocAmount(undefined)`
- **Expected:** each throws `INVALID_AMOUNT` 400 (min-$0.50 message). `Number('')===0`, `Number(undefined)===NaN` → both fail `Number.isFinite || <0.5`.

### TC-ADHOC-4: max $100,000 boundary — pass
- **Priority:** P0 · **Type:** UNIT · **§ref:** §4.4
- **Input:** `assertAdhocAmount(100000)`
- **Expected:** returns `100000` (no throw; boundary inclusive).

### TC-ADHOC-5: above max — reject
- **Priority:** P0 · **Type:** UNIT · **§ref:** §4.4
- **Input:** `assertAdhocAmount(100000.01)`
- **Expected:** throws `{ code:'INVALID_AMOUNT', httpStatus:400, message:'Amount exceeds the $100,000 limit' }`.

### TC-ADHOC-6: non-numeric / NaN — reject
- **Priority:** P0 · **Type:** UNIT · **§ref:** §4.4, §2.2
- **Input:** `assertAdhocAmount('abc')`, `assertAdhocAmount(NaN)`, `assertAdhocAmount(null)`
- **Expected:** each throws `INVALID_AMOUNT` 400 (fails `Number.isFinite`).

### TC-ADHOC-7: negative — reject
- **Priority:** P0 · **Type:** UNIT · **§ref:** §4.4
- **Input:** `assertAdhocAmount(-10)`
- **Expected:** throws `INVALID_AMOUNT` 400 (min-$0.50 path).

### TC-ADHOC-8: 2dp enforcement / rounding
- **Priority:** P1 · **Type:** UNIT · **§ref:** §4.4, §2.2
- **Input:** `assertAdhocAmount(10.999)`, `assertAdhocAmount(10.005)`, `assertAdhocAmount(99.9)`
- **Expected:** returns `Number(a.toFixed(2))` → `11`, `10.01`, `99.9` respectively; result always ≤2 decimals.

### TC-ADHOC-9: string coercion of a valid amount
- **Priority:** P1 · **Type:** UNIT · **§ref:** §4.4
- **Input:** `assertAdhocAmount('180')`, `assertAdhocAmount('180.50')`
- **Expected:** coerced via `Number(...)` → returns `180` / `180.5` (no throw). Confirms string body amounts from the route survive.

---

## B. `resolveSurfaceContext` job branch (§0.1, §2 arch) — UNIT

### TC-RSC-1: jobId branch loads job → contactId + email/phone/name
- **Priority:** P0 · **Type:** UNIT · **§ref:** §0.1, arch §2, Q2
- **Mocks:** `jobsService.getJobById.mockResolvedValue({ id:'job-1', contact_id:5, customer_email:'c@x.com', customer_phone:'+16175551212', customer_name:'Ann' })`
- **Steps:** call `resolveSurfaceContext(COMPANY, { jobId:'job-1', amount:180 })`.
- **Expected:** `getJobById` called with `('job-1', COMPANY)`; returns `ctx` with `jobId:'job-1'`, `contactId:5`, `email:'c@x.com'`, `phone:'+16175551212'`, `customerName:'Ann'`, `amount:180` (post `assertAdhocAmount`).

### TC-RSC-2: foreign/absent job → 404
- **Priority:** P0 · **Type:** UNIT · **§ref:** §5 NFR, Q2, AC company-scope
- **Mocks:** `jobsService.getJobById.mockResolvedValue(null)`
- **Steps:** `resolveSurfaceContext(COMPANY, { jobId:'foreign', amount:50 })`
- **Expected:** throws `{ code:'NOT_FOUND', httpStatus:404 }`. (Company-scoped `getJobById` returns null for a cross-tenant id → 404, no leak.)

### TC-RSC-3: job with no contact → contactId null
- **Priority:** P0 · **Type:** UNIT · **§ref:** §3.4.2, FR-LINK-4
- **Mocks:** `getJobById.mockResolvedValue({ id:'job-2', contact_id:null, customer_email:null, customer_phone:null })`
- **Steps:** `resolveSurfaceContext(COMPANY, { jobId:'job-2', amount:50 })`
- **Expected:** returns `ctx.contactId=null`, `email=null`, `phone=null` (no throw here — the 422 NO_CONTACT happens only on the send path, TC-SEND-4). Link create is still allowed.

### TC-RSC-4: job branch runs assertAdhocAmount
- **Priority:** P0 · **Type:** UNIT · **§ref:** §3.1 new-guard, AC-7
- **Mocks:** `getJobById.mockResolvedValue({ id:'job-1', contact_id:5 })`
- **Steps:** `resolveSurfaceContext(COMPANY, { jobId:'job-1', amount:0.10 })`
- **Expected:** throws `INVALID_AMOUNT` 400 — proves the job branch (and thus the keyed-card path) inherits the $0.50 floor that the old bare `else` (`>0`) did not enforce.

### TC-RSC-5: invoice branch untouched (regression)
- **Priority:** P0 · **Type:** UNIT · **§ref:** §3.5, AC-5
- **Mocks:** `invoicesService.getInvoice.mockResolvedValue({ id:42, status:'sent', total:100, balance_due:100, contact_id:5 })`
- **Steps:** `resolveSurfaceContext(COMPANY, { invoiceId:42 })` with no amount.
- **Expected:** `ctx.amount = balance (100)`, `contactId=5`, `jobId` from invoice.job_id, `invoiceNumber` set — identical to pre-feature behavior; `getJobById` NOT called. Guards INVALID_STATUS on void/paid, INVALID_AMOUNT on `amount>balance` still fire.

---

## C. `ensureJobPaymentLink` (§4.5) — INTEGRATION (mocked provider + queries)

### TC-LINK-1: creates checkout session, job_id set + invoice_id NULL + surface checkout_link
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.2, §4.5, §4.7, FR-LINK-1
- **Mocks:** `q.getAccountByCompany→readyAccount`; `getJobById→{id:'job-1',contact_id:5}`; `q.findOpenJobSession→null`; `provider.createCheckoutSession=jest.fn().mockResolvedValue({ id:'cs_1', url:'https://checkout/stripe/1', payment_intent:'pi_1' })`; `q.insertSession→{ id:11, url:'https://checkout/stripe/1', expires_at:<date> }`.
- **Steps:** `svc.ensureJobPaymentLink(COMPANY, { id:'u1' }, 'job-1', { amount:180 })`.
- **Expected:** `insertSession` arg (`.mock.calls[0][1]`) `toMatchObject({ invoice_id:null, job_id:'job-1', contact_id:5, surface:'checkout_link', status:'open', amount:180 })`; `createCheckoutSession` metadata `{ company_id:COMPANY, invoice_id:'', job_id:'job-1', contact_id:'5' }`; returns `{ url, expires_at, reused:false, session_id:11 }`.

### TC-LINK-2: idempotency key `job-${companyId}-${jobId}-${amount}`
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §4.5, FR-LINK-3, §5 NFR
- **Mocks:** as TC-LINK-1.
- **Steps:** create link for amount 180.
- **Expected:** `createCheckoutSession` 2nd arg (options) `toMatchObject({ idempotencyKey: 'job-'+COMPANY+'-job-1-180' })`. Distinct namespace from `inv-…` (no cross-collision).

### TC-LINK-3: successUrl == cancelUrl == baseUrl()/pay/thanks
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.3, §4.5, arch §4
- **Mocks:** as TC-LINK-1.
- **Expected:** `createCheckoutSession` payload `successUrl` and `cancelUrl` both end with `/pay/thanks` (job has no invoice public token → no `/i/:token`).

### TC-LINK-4: reuses valid open job session (idempotent, reused:true)
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.2 reuse, FR-LINK-3, AC-4
- **Mocks:** `q.getAccountByCompany→readyAccount`; `getJobById→{id:'job-1',contact_id:5}`; `q.findOpenJobSession.mockResolvedValue({ id:5, url:'https://checkout/existing', expires_at:null })`.
- **Steps:** `ensureJobPaymentLink(COMPANY,{id:'u1'},'job-1',{amount:180})`.
- **Expected:** returns `{ reused:true, url:'https://checkout/existing', session_id:5 }`; `provider.createCheckoutSession` NOT called; `q.insertSession` NOT called. `findOpenJobSession` called with `(COMPANY,'job-1',180)`.

### TC-LINK-5: different amount → new session (no reuse)
- **Priority:** P1 · **Type:** INTEGRATION · **§ref:** §3.2, AC-4
- **Mocks:** `findOpenJobSession.mockResolvedValue(null)` (no open session at 200); provider + insert as TC-LINK-1.
- **Steps:** create at amount 200 after one existed at 180.
- **Expected:** new `createCheckoutSession` + `insertSession` called; `reused:false`. Confirms amount is part of the reuse key.

### TC-LINK-6: NOT_READY when Stripe not collectable (409)
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §4.1 errors, §3.1
- **Mocks:** `q.getAccountByCompany.mockResolvedValue(null)`.
- **Steps:** `ensureJobPaymentLink(COMPANY,{id:'u1'},'job-1',{amount:180})`.
- **Expected:** throws `{ code:'NOT_READY', httpStatus:409 }` (via `assertCollectable`); job never loaded, no session created.

### TC-LINK-7: amount validated (INVALID_AMOUNT 400)
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §4.4, AC-7
- **Mocks:** `getAccountByCompany→readyAccount`; `getJobById→{id:'job-1'}`.
- **Steps:** `ensureJobPaymentLink(...,{ amount:0.10 })` and `{ amount:200000 }`.
- **Expected:** both throw `INVALID_AMOUNT` 400 with the correct min/max message; no session created.

### TC-LINK-8: foreign job → 404 (company-scoped)
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §5 NFR, AC company-isolation
- **Mocks:** `getAccountByCompany→readyAccount`; `getJobById.mockResolvedValue(null)`.
- **Expected:** throws `{ code:'NOT_FOUND', httpStatus:404 }`; no cross-tenant session.

### TC-LINK-9: audit-logs payment_link_created target_type job
- **Priority:** P1 · **Type:** INTEGRATION · **§ref:** §4.7, arch §2
- **Mocks:** full create path (TC-LINK-1).
- **Expected:** `auditService.log` called with `{ action:'stripe_payments.payment_link_created', target_type:'job', target_id:'job-1', company_id:COMPANY }`.

---

## D. `getJobPaymentLink` (§4.5/§4.6) — INTEGRATION

### TC-GET-1: returns active + history, filters invoice_id IS NULL
- **Priority:** P1 · **Type:** INTEGRATION · **§ref:** §3.2 read, §4.2, §4.6
- **Mocks:** `q.listSessionsForJob.mockResolvedValue([{ id:2, surface:'checkout_link', status:'open', expires_at:<future>, url:'u2', amount:180 }, { id:1, surface:'checkout_link', status:'expired', amount:90 }])`.
- **Steps:** `svc.getJobPaymentLink(COMPANY,'job-1')`.
- **Expected:** `active = { url:'u2', expires_at, amount:180 }`; `history` length 2 with `{id,status,amount,surface,failure_reason,created_at}` shape. `listSessionsForJob` called `(COMPANY,'job-1')`.

### TC-GET-2: no open session → active null
- **Priority:** P2 · **Type:** INTEGRATION · **§ref:** §4.2
- **Mocks:** `listSessionsForJob→[{ id:1, surface:'checkout_link', status:'expired' }]`.
- **Expected:** `{ active:null, history:[…] }`.

### TC-GET-3: expired open session excluded from active
- **Priority:** P2 · **Type:** INTEGRATION · **§ref:** §4.2 (active = open AND non-expired)
- **Mocks:** `listSessionsForJob→[{ id:3, surface:'checkout_link', status:'open', expires_at:<past> }]`.
- **Expected:** `active:null` (past `expires_at` excluded).

### TC-QUERY-1: findOpenJobSession/listSessionsForJob assert invoice_id IS NULL
- **Priority:** P1 · **Type:** STATIC · **§ref:** §4.6, arch §2 (load-bearing)
- **Steps:** grep `backend/src/db/stripePaymentsQueries.js` for the two new fns.
- **Expected:** both SQL bodies contain `invoice_id IS NULL` AND `surface='checkout_link'` (findOpen) / `job_id=$2` + `company_id=$1`; `findOpenJobSession` also has `status='open'`, `amount=$3`, `(expires_at IS NULL OR expires_at>NOW())`. Both call `ensureMarketplaceSchema()` first.

---

## E. `sendJobPaymentLink` — REAL dispatch (§3.4, §0.5) — INTEGRATION

### TC-SEND-1: email path dispatches via emailService.sendEmail
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.4, §4.3, §0.5, FR-LINK-4
- **Mocks:** `getJobById→{id:'job-1',contact_id:5,customer_email:'c@x.com',customer_phone:null,customer_name:'Ann'}`; `emailMailboxService.getMailboxStatus.mockResolvedValue({ status:'connected' })`; ensureJobPaymentLink path → `{ url:'https://checkout/1' }`; `emailService.sendEmail.mockResolvedValue({})`.
- **Steps:** `svc.sendJobPaymentLink(COMPANY,{id:'u1'},'job-1',{ channel:'email', message:'hi' })`.
- **Expected:** `emailService.sendEmail` called `(COMPANY, { to:'c@x.com', subject:/Payment request/, body:contains url, userId:'u1', userEmail })`; NO `files` (bare link, no PDF); returns `{ sent:true, url, channel:'email' }`; audit `payment_link_sent target_type:'job'`.

### TC-SEND-2: SMS path dispatches via conversationsService.sendMessage
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.4, §0.5, FR-LINK-4
- **Mocks:** `getJobById→{id:'job-1',contact_id:5,customer_email:null,customer_phone:'+16175551212'}`; `resolveCompanyProxyE164→'+16175550000'`; `toE164→'+16175551212'`; `conversationsService.getOrCreateConversation→{ id:99 }`; `conversationsService.sendMessage.mockResolvedValue({})`.
- **Steps:** `sendJobPaymentLink(COMPANY,{id:'u1'},'job-1',{ channel:'sms' })`.
- **Expected:** `conversationsService.sendMessage` called `(99, { body: contains url })`; returns `{ sent:true, channel:'sms' }`; `emailService.sendEmail` NOT called.

### TC-SEND-3: channel fallback — default email when present, else SMS
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.4.3, arch §2
- **Mocks (a):** email present, phone present, NO forced channel → expect email dispatched. **Mocks (b):** email null, phone present, no forced channel → expect SMS dispatched.
- **Expected:** (a) `emailService.sendEmail` called, sms not; (b) `conversationsService.sendMessage` called, email not. `channel` in return reflects chosen.

### TC-SEND-4: NO_CONTACT 422 when neither email nor phone
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.4.2, FR-LINK-4, AC-4
- **Mocks:** `getJobById→{id:'job-1',customer_email:null,customer_phone:null}`.
- **Steps:** `sendJobPaymentLink(COMPANY,{id:'u1'},'job-1',{})`.
- **Expected:** throws `{ code:'NO_CONTACT', httpStatus:422 }`; no dispatch, no `ensureJobPaymentLink` call after the check.

### TC-SEND-5: forced channel missing its contact → NO_CONTACT 422
- **Priority:** P1 · **Type:** INTEGRATION · **§ref:** §3.4.3
- **Mocks:** email null, phone present; `channel:'email'` forced.
- **Expected:** throws `NO_CONTACT` 422 ("No email on file"); SMS NOT used as fallback when channel forced.

### TC-SEND-6: email path propagates MAILBOX_NOT_CONNECTED 409
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.4.5, §4.3, §0.5
- **Mocks:** email present; `emailMailboxService.getMailboxStatus.mockResolvedValue({ status:'disconnected' })`.
- **Expected:** throws `{ code:'MAILBOX_NOT_CONNECTED', httpStatus:409 }`; `emailService.sendEmail` NOT called.

### TC-SEND-7: SMS path propagates NO_PROXY 422
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.4.5, §4.3
- **Mocks:** phone present, email null; `resolveCompanyProxyE164.mockResolvedValue(null)`.
- **Expected:** throws `{ code:'NO_PROXY', httpStatus:422 }`; no `sendMessage`.

### TC-SEND-8: SMS path propagates NO_PHONE 422 on invalid E164
- **Priority:** P1 · **Type:** INTEGRATION · **§ref:** §3.4.5
- **Mocks:** phone `'123'`; `resolveCompanyProxyE164→proxy`; `toE164.mockReturnValue(null)`.
- **Expected:** throws `{ code:'NO_PHONE', httpStatus:422 }`.

### TC-SEND-9: SMS wallet gate propagates WALLET_BLOCKED 402
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.4.5, §4.3
- **Mocks:** SMS path ready; `conversationsService.sendMessage.mockRejectedValue({ httpStatus:402, code:'WALLET_BLOCKED' })`.
- **Expected:** error propagates as `{ code:'WALLET_BLOCKED', httpStatus:402 }` to caller.

### TC-SEND-10: audit-logged, NO invoicesQueries.createEvent
- **Priority:** P1 · **Type:** INTEGRATION · **§ref:** §3.4.6, arch Q3
- **Mocks:** successful email send.
- **Expected:** `auditService.log` called `{ action:'stripe_payments.payment_link_sent', target_type:'job', details:{ channel:'email' } }`; `invoicesQueries.createEvent` NOT called (jobs have no invoice-event stream).

---

## F. Routes (§4.1–4.3) — INTEGRATION / STATIC

Routes attach in `backend/src/routes/jobs.js` next to the live `POST /:id/stripe-manual-card-session` (:877), under `authenticate` + `requireCompanyAccess`; `companyId=req.companyFilter?.company_id`; `actor={id:req.user?.sub}`; error envelope `{ ok:false, error:{ code, message } }` via `jobStripeError`.

### TC-ROUTE-1: POST /stripe-payment-link permission gate = collect_online
- **Priority:** P0 · **Type:** STATIC · **§ref:** §4.1, FR-LINK-2
- **Steps:** grep jobs.js.
- **Expected:** `router.post('/:id/stripe-payment-link', requirePermission('payments.collect_online'), …)` present; handler calls `ensureJobPaymentLink(companyId, actor, req.params.id, { amount:req.body?.amount })`; response `{ ok:true, data }`.

### TC-ROUTE-2: GET /stripe-payment-link permission gate = payments.view
- **Priority:** P0 · **Type:** STATIC · **§ref:** §4.2, FR-LINK-2
- **Expected:** `router.get('/:id/stripe-payment-link', requirePermission('payments.view'), …)` → `getJobPaymentLink(companyId, req.params.id)`.

### TC-ROUTE-3: POST /send-payment-link permission gate = collect_online
- **Priority:** P0 · **Type:** STATIC · **§ref:** §4.3, FR-LINK-2
- **Expected:** `router.post('/:id/send-payment-link', requirePermission('payments.collect_online'), …)` → `sendJobPaymentLink(companyId, actor, req.params.id, { channel, amount, message })`.

### TC-ROUTE-4: error envelope maps StripePaymentsError via jobStripeError
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §0.4, §4.1
- **Note:** if a supertest harness for jobs.js routes is added, assert 409 NOT_READY / 400 INVALID_AMOUNT / 404 NOT_FOUND / 422 NO_CONTACT each return `{ ok:false, error:{ code, message } }` with the matching HTTP status. If no route-level harness exists, this is covered at the service level (§C/§E) + STATIC confirmation that handlers wrap in `jobStripeError`. **Flag: service-level tests are the enforced gate; route-level is STATIC unless a jobs.js supertest harness lands.**

### TC-ROUTE-5: company-scope — companyId from req.companyFilter
- **Priority:** P0 · **Type:** STATIC · **§ref:** §5 NFR
- **Expected:** all three handlers read `req.companyFilter?.company_id` (never `crm_users.company_id` fallback); pass it to the service so `getJobById(id, companyId)` scopes; foreign job → 404 (asserted in TC-LINK-8 / TC-RSC-2).

### TC-ROUTE-6: NOT_READY 409 surfaces on create when Stripe not collectable
- **Priority:** P1 · **Type:** INTEGRATION · **§ref:** §4.1
- **Covered by TC-LINK-6** at service level; route returns 409 via jobStripeError.

---

## G. Ledger idempotency (§3.3, §4.7, FR-LEDGER) — INTEGRATION

Reuses the existing webhook path (no webhook change). These extend the existing webhook cases with a **job-only** session (invoice_id NULL).

### TC-LEDGER-1: webhook writes one job row (job_id set, invoice_id NULL, no auto-invoice)
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.3, §4.7, FR-LEDGER-1/3, AC-3
- **Mocks:** `getAccountByStripeId→{ company_id:COMPANY, stripe_account_id:ACCT }`; `insertWebhookEvent→{inserted:true}`; `getSessionByCheckoutId.mockResolvedValue({ id:12, invoice_id:null, job_id:'job-1', contact_id:5 })`; `findByExternalSourceId→null`; `paymentsQueries.createTransaction→{ id:300, external_id:'pi_job' }`.
- **Event:** `checkout.session.completed` with `metadata:{ job_id:'job-1' }`, `amount_total:18000`.
- **Expected:** `paymentsQueries.createTransaction` called ONCE; tx arg `toMatchObject({ external_source:'stripe', external_id:'pi_job', invoice_id:null, job_id:'job-1', amount:180 })`; `invoicesQueries.recordPayment` NOT called; `updateInvoiceStatus` NOT called (the `if(invoiceId)` balance block skipped → no auto-invoice).

### TC-LEDGER-2: webhook retry deduped — no double charge
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.3 no-double-charge, FR-LEDGER-2, §5 NFR
- **Mocks:** `findByExternalSourceId.mockResolvedValue({ id:300, external_id:'pi_job' })` (already in ledger).
- **Expected:** `paymentsQueries.createTransaction` NOT called; `res={ ok:true }`. Confirms dedup on external id for the job path.

### TC-LEDGER-3: contact attributed on job payment
- **Priority:** P1 · **Type:** INTEGRATION · **§ref:** §4.7, Q2
- **Mocks:** as TC-LEDGER-1 with `contact_id:5`.
- **Expected:** tx arg carries `contact_id:5` (payment attributed to customer in Pulse/job timeline even with no invoice).

---

## H. Backward-compat (§3.5, AC-5) — INTEGRATION / STATIC

### TC-COMPAT-1: existing 28 invoice jest cases stay green
- **Priority:** P0 · **Type:** INTEGRATION · **§ref:** §3.5, AC-5, AC-6
- **Steps:** run `npx jest --testPathIgnorePatterns "/node_modules/" tests/stripePayments.test.js`.
- **Expected:** all 28 `it()` pass unchanged (invoice ensurePaymentLink/reuse, createManualCardSession, webhook, refunds). No edits to that file.

### TC-COMPAT-2: invoice ensurePaymentLink / sendPaymentLink signatures unchanged
- **Priority:** P0 · **Type:** STATIC · **§ref:** §3.5, §6
- **Expected:** grep confirms `ensurePaymentLink(companyId, actor, invoiceId, …)`, `sendPaymentLink(companyId, actor, invoiceId, …)`, `getPaymentLink` signatures identical; `invoiceStripeApi.{createLink,getLink,sendLink,manualCardSession,refund}` unchanged.

### TC-COMPAT-3: resolveSurfaceContext invoice branch diff = additive only
- **Priority:** P0 · **Type:** STATIC · **§ref:** §3.5, §6
- **Expected:** git diff of `resolveSurfaceContext` shows only (i) a new `else if (jobId)` branch and (ii) the bare-`else` `amount>0` check swapped for `assertAdhocAmount` (same INVALID_AMOUNT code). Invoice `if (invoiceId)` block byte-unchanged.

### TC-COMPAT-4: ManualCardDialog invoice call-site still passes invoiceId
- **Priority:** P0 · **Type:** STATIC · **§ref:** §3.5, §4.9, FR-CARD-1
- **Expected:** grep `InvoiceDetailPanel` (sole existing call-site) still renders `<ManualCardDialog invoiceId={…} />`; new props `jobId?`/`amount?` are optional (`invoiceId?: number, jobId?: number|string, amount?: number`) so the invoice call-site compiles and behaves identically.

### TC-COMPAT-5: PublicInvoicePayPage + webhook + applyStripePayment untouched
- **Priority:** P0 · **Type:** STATIC · **§ref:** §6, arch §4
- **Expected:** git diff shows NO changes to `PublicInvoicePayPage.tsx`, `handleWebhook`, `applyStripePayment`, `stripeConnectProvider.js`, `stripePaymentsWebhook.js`. Job link never routes to `/pay/:token`.

---

## I. Frontend gating / CTA (§1) — STATIC / MANUAL

### TC-BTN-1: gating discrepancy — button shows on can_collect (incl payouts_disabled)
- **Priority:** P1 · **Type:** STATIC · **§ref:** §0.6.4, §1.1, §1.3, AC-1
- **Note (flagged by spec §0.6.4):** requirements FR-BTN-1 said gate on `connected_ready`; code's real gate `canCollect` returns true for `{connected_ready, payouts_disabled}`. **Spec uses `can_collect`** → button shows in BOTH states.
- **Steps:** grep `JobFinancialsTab.tsx`.
- **Expected:** button render condition keys off `status.can_collect === true` (NOT literal `readiness==='connected_ready'`); AND user holds ≥1 of `payments.collect_online`/`collect_offline`/`collect_keyed`.

### TC-BTN-2: no collect perm → renders nothing
- **Priority:** P0 · **Type:** STATIC · **§ref:** §1.2, FR-BTN-2, AC-1
- **Expected:** when user holds none of the three collect perms, the collect area returns null — no button, no CTA, no placeholder — regardless of readiness (grep the guard order: perm gate precedes CTA).

### TC-CTA-1: readiness→copy mapping (manage users) — exact English strings
- **Priority:** P1 · **Type:** STATIC · **§ref:** §1.3, FR-CTA-2, AC-2
- **Expected:** grep the CTA component for the spec's exact strings:
  - `not_connected` / `disconnected` → title "Accept payments right from the job", body "Connect Stripe to charge your customer's card or send a payment link in seconds — no invoice required.", action "Connect Stripe".
  - `onboarding_incomplete` / `action_required` / `payments_disabled` → body "Finish your Stripe setup to start collecting payments", action "Finish setup".
  - all actions route to `/settings/integrations/stripe-payments`.

### TC-CTA-2: non-manage variant — plain text, no button
- **Priority:** P1 · **Type:** STATIC · **§ref:** §1.3 FR-CTA-3, AC-2
- **Expected:** when user lacks `tenant.integrations.manage`, CTA renders plain text "Ask an account admin to connect Stripe in Settings → Integrations." with NO button, across all not-ready readiness states.

### TC-CTA-3: loading / configured===false → nothing
- **Priority:** P2 · **Type:** STATIC · **§ref:** §1.3 last row
- **Expected:** while status loading or `configured===false`, nothing renders (silent absence, matches invoice path).

### TC-CTA-4: tokens-only + surface-muted + "Albusto" (no "Blanc")
- **Priority:** P2 · **Type:** STATIC · **§ref:** §5, FR-CTA-1
- **Expected:** CTA card uses `var(--blanc-surface-muted)`, tokens only (no raw hex), FORM-CANON; no literal "Blanc" in any UI string.

### TC-CTA-5: CTA states render correctly (visual)
- **Priority:** P1 · **Type:** MANUAL · **§ref:** §1.3, AC-2
- **Steps:** in browser/simulator, force each readiness state (not_connected, onboarding_incomplete, action_required, payments_disabled, connected_ready, payouts_disabled) as manage + non-manage user; verify copy/button/route per the table; verify button appears for connected_ready AND payouts_disabled.

---

## J. `/pay/thanks` route (§3.3, §0.6.3) — STATIC / BUILD

### TC-THANKS-1: /pay/thanks declared BEFORE /pay/:token in App.tsx
- **Priority:** P0 · **Type:** STATIC · **§ref:** §0.6.3, §3.3, §5 NFR
- **Ground truth:** today `App.tsx:108` = `<Route path="/pay/:token" …>` and NO `/pay/thanks` exists yet → a literal `/pay/thanks` would match `:token="thanks"` and 404 internally.
- **Steps:** grep `frontend/src/App.tsx` for both routes; assert the line number of `path="/pay/thanks"` is LESS than `path="/pay/:token"` (React Router first-match).
- **Expected:** `/pay/thanks` route exists and precedes `/pay/:token`; renders a minimal public "Thanks — your payment was received" component (no auth).

### TC-THANKS-2: /pay/thanks renders without auth (public)
- **Priority:** P1 · **Type:** MANUAL · **§ref:** §3.3
- **Steps:** open `/pay/thanks` in an incognito/logged-out browser.
- **Expected:** a minimal thanks page renders (no login redirect, no 404). Simulates Stripe's post-payment redirect landing.

---

## K. Dialog + component props (§2, §4.9) — STATIC / MANUAL

### TC-DLG-1: ManualCardDialog generalized props {invoiceId?, jobId?, amount?}
- **Priority:** P1 · **Type:** STATIC · **§ref:** §4.9, FR-CARD-1
- **Expected:** `interface Props` = `{ open, onOpenChange, invoiceId?: number, jobId?: number|string, amount?: number, onSuccess? }`; when `jobId` present calls `jobStripeApi.manualCardSession(jobId, amount)`, else `invoiceStripeApi.manualCardSession(invoiceId, amount)`. Exactly one id present.

### TC-DLG-2: jobStripeApi mirrors invoiceStripeApi
- **Priority:** P1 · **Type:** STATIC · **§ref:** §4.8
- **Expected:** `jobStripeApi = { createLink(jobId,amount?), getLink(jobId), sendLink(jobId,{channel?,message?}), manualCardSession(jobId,amount?) }` hitting `/api/jobs/:id/...`; error unwrap = `json.error?.message` (identical to invoice).

### TC-DLG-3: CollectPaymentDialog props + prefill
- **Priority:** P1 · **Type:** STATIC · **§ref:** §2.1, §4.9, FR-DLG
- **Expected:** `{ open, onOpenChange, jobId, outstanding, onSuccess? }`; amount prefilled to `outstanding` iff `outstanding>0` else blank; FORM-CANON (`DialogPanelHeader`/`DialogBody`/`DialogPanelFooter`, `variant="panel"`).

### TC-DLG-4: amount validation UI (client mirror of assertAdhocAmount)
- **Priority:** P1 · **Type:** MANUAL · **§ref:** §2.2, FR-DLG-2
- **Steps:** in dialog, type `0`, `0.49`, blank, `abc`, `-5`, `100000.01`, `10.999`, `180`.
- **Expected:** `<0.50`/blank/non-numeric/negative → inline "Amount must be at least $0.50", submit disabled; `>100000` → "Amount exceeds the $100,000 limit", submit disabled; `10.999` → rounds to `11` on blur; `180` → valid, proceed. (UX-only; server is source of truth.)

### TC-DLG-5: method chooser — three methods wired
- **Priority:** P1 · **Type:** MANUAL · **§ref:** §2.3, FR-DLG-3
- **Steps:** open dialog with valid amount.
- **Expected:** "Enter card manually" → generalized ManualCardDialog {jobId,amount}; "Send payment link" → `jobStripeApi.sendLink`; "Copy payment link" → `jobStripeApi.createLink` + clipboard copy + toast "Payment link copied". One FORM-CANON surface (panel desktop / bottom-sheet mobile).

### TC-DLG-6: prefill outstanding vs blank
- **Priority:** P2 · **Type:** MANUAL · **§ref:** §2.1, §0.7
- **Steps:** open on a job with `totalDue>0` then on a job with `totalDue=0`.
- **Expected:** first prefills the due amount (editable); second is blank.

### TC-DLG-7: send-link error UX offers "Copy link instead"
- **Priority:** P1 · **Type:** MANUAL · **§ref:** §3.4 UI copy
- **Steps:** trigger NO_CONTACT (job w/o email+phone), and MAILBOX_NOT_CONNECTED.
- **Expected:** error toast with server message + "Copy link instead" affordance; success toast "Payment link sent"/"emailed to {recipient}"/"texted". Copy remains the always-available hand-off.

---

## L. Flows — MANUAL (owner/simulator)

### TC-FLOW-1: manual card on job records one invoice-less ledger row
- **Priority:** P0 · **Type:** MANUAL · **§ref:** §3.1, AC-3
- **Steps:** Finance → Collect payment → Enter card manually → Stripe test card → confirm.
- **Expected:** toast "Payment submitted"; webhook writes one `payment_transactions` (job_id set, invoice_id NULL, contact attributed); NO invoice created; appears in job/contact timeline.

### TC-FLOW-2: create + copy link, then pay on Stripe hosted page
- **Priority:** P1 · **Type:** MANUAL · **§ref:** §3.2, §3.3
- **Steps:** Copy payment link → paste URL → pay with test card on Stripe's hosted page → redirected to `/pay/thanks`.
- **Expected:** clipboard has Stripe-hosted URL; thanks page renders; ledger row lands via webhook.

---

## M. Build + Deploy

### TC-BUILD-1: npm run build exits 0 (prod-strict)
- **Priority:** P0 · **Type:** BUILD · **§ref:** §5, AC-6
- **Steps:** `npm run build` in frontend (`tsc -b` + vite, `noUnusedLocals`).
- **Expected:** exit 0; no unused-locals errors from the generalized ManualCardDialog / new CollectPaymentDialog / jobStripeApi / `/pay/thanks`.

### TC-BUILD-2: backend jest green (full suite)
- **Priority:** P0 · **Type:** BUILD · **§ref:** §5, AC-6
- **Steps:** `npx jest --testPathIgnorePatterns "/node_modules/"`.
- **Expected:** exit 0; the 28 existing + all new job cases pass.

### TC-DEPLOY-1: owner-gated live charge + /pay/thanks live
- **Priority:** P1 · **Type:** DEPLOY (owner) · **§ref:** §5, AC-3
- **Steps:** on a `connected_ready` Stripe test-mode company, run one real keyed charge + one hosted-link pay; confirm `/pay/thanks` is reachable in prod.
- **Expected:** charge settles, ledger row present; thanks page live (not 404). Owner-gated manual step.

---

## FR / AC → TC matrix

| Requirement | Test cases |
|---|---|
| FR-BTN-1 (gated button, can_collect) | TC-BTN-1, TC-CTA-5, TC-FLOW-1 |
| FR-BTN-2 (no perm → nothing) | TC-BTN-2 |
| FR-CTA-1/2 (readiness copy, manage) | TC-CTA-1, TC-CTA-4, TC-CTA-5 |
| FR-CTA-3 (non-manage text) | TC-CTA-2, TC-CTA-5 |
| FR-DLG-1 (FORM-CANON) | TC-DLG-3, TC-DLG-5 |
| FR-DLG-2 (amount prefill/validate) | TC-DLG-3, TC-DLG-4, TC-DLG-6 |
| FR-DLG-3 (method chooser) | TC-DLG-5 |
| FR-CARD-1 (generalize ManualCardDialog) | TC-DLG-1, TC-COMPAT-4, TC-FLOW-1 |
| FR-CARD-2 (assertAdhocAmount on card) | TC-RSC-4, TC-ADHOC-*, TC-DLG-4 |
| FR-LINK-1 (job link, invoice_id NULL) | TC-LINK-1, TC-QUERY-1 |
| FR-LINK-2 (3 routes + perms) | TC-ROUTE-1/2/3/5 |
| FR-LINK-3 (idempotent reuse) | TC-LINK-2, TC-LINK-4, TC-LINK-5 |
| FR-LINK-4 (recipient/channels/NO_CONTACT) | TC-SEND-1..5, TC-RSC-3 |
| FR-LEDGER-1 (one job row, no invoice) | TC-LEDGER-1 |
| FR-LEDGER-2 (idempotent settle) | TC-LEDGER-2 |
| FR-LEDGER-3 (no auto-invoice) | TC-LEDGER-1 |
| AC-1 (button gating) | TC-BTN-1, TC-BTN-2 |
| AC-2 (CTA per state/perm) | TC-CTA-1, TC-CTA-2, TC-CTA-5 |
| AC-3 (arbitrary manual card) | TC-FLOW-1, TC-LEDGER-1 |
| AC-4 (link create/send/copy + reuse) | TC-LINK-4, TC-SEND-4, TC-FLOW-2 |
| AC-5 (invoice byte-unchanged) | TC-COMPAT-1..5 |
| AC-6 (build+jest green) | TC-BUILD-1, TC-BUILD-2, TC-COMPAT-1 |
| AC-7 (amount validation link+card) | TC-ADHOC-1..9, TC-LINK-7, TC-RSC-4, TC-DLG-4 |
| §0.6.3 (/pay/thanks route order) | TC-THANKS-1, TC-THANKS-2 |
| §0.6.4 (can_collect gating discrepancy) | TC-BTN-1, TC-CTA-5 |
| §5 (company-scope every route) | TC-ROUTE-5, TC-LINK-8, TC-RSC-2, TC-LEDGER-1 |
| §0.5 (real dispatch wiring) | TC-SEND-1/2/6/7/9/10 |

### Manual-only ACs (no automated gate — flag for Tester/owner)

- **AC-3 live charge** — keyed card records a real ledger row: **MANUAL** (TC-FLOW-1) + **DEPLOY** (TC-DEPLOY-1). Automated coverage stops at the service/webhook level (TC-LEDGER-1); the actual Stripe Payment Element confirm + settle is owner-gated test-mode.
- **AC-2 CTA visuals** — copy strings are STATIC-greppable (TC-CTA-1/2) but the rendered states + button-appears-on-payouts_disabled are **MANUAL** (TC-CTA-5).
- **AC-4 send delivery** — service dispatch is INTEGRATION-tested (TC-SEND-*), but end-to-end email/SMS receipt is **MANUAL** (TC-DLG-7, TC-FLOW-2).
- **§0.6.3 /pay/thanks** — route order is STATIC (TC-THANKS-1) but public render is **MANUAL** (TC-THANKS-2); **DEPLOY**-gated in prod (TC-DEPLOY-1).
- **Frontend has no runner:** all FR-BTN/FR-CTA/FR-DLG behavior is STATIC (grep/props) + BUILD + MANUAL only — no jest/vitest assertion.

### Coverage gaps / risks flagged

1. **Route-level HTTP-status assertions (TC-ROUTE-4)** are STATIC unless a `jobs.js` supertest harness is added — the existing `tests/` file mocks at the service layer, not the route layer. Service-level error codes (§C/§E) are the enforced gate; middleware 401/403 gating is inherited from `authenticate`/`requireCompanyAccess`/`requirePermission` (not re-tested here — pre-existing infra).
2. **`/pay/thanks` is net-new and does NOT exist today** (only `/pay/:token`) — highest-risk STATIC gate (TC-THANKS-1). A miss ships a customer-visible 404 on the Stripe redirect (payment still settles).
3. **can_collect gating discrepancy (§0.6.4):** if the implementer follows the literal requirements text (`connected_ready`) instead of the spec's `can_collect`, `payouts_disabled` companies wrongly hide the button. TC-BTN-1/TC-CTA-5 must confirm `can_collect`.
4. **Existing test count is 28, not 26** (prompt said 26) — TC-COMPAT-1 asserts all 28 stay green.
