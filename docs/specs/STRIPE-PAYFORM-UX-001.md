# STRIPE-PAYFORM-UX-001 — Merchant manual-card UX and signed job credit

**Status:** Approved for implementation planning; no production implementation is included in this spec.

**Owner-context note:** The “heavy/public-looking” form under discussion is the authenticated merchant `ManualCardDialog` using Stripe’s default Payment Element; it is not the customer-facing `PublicInvoicePayPage`.

## Goal

Replace the merchant keyed-card Payment Element with one Stripe-hosted composite Card Element that renders exactly four inputs—**Card number / MM/YY / CVC / ZIP**—then make a confirmed charge unmistakable, safely reconcile ambiguous network outcomes, and surface standalone job payments as **Paid** with a signed negative **Due** credit (for example, `−$95.00`).

The public invoice payment page and its automatic-payment-method PaymentIntent path remain unchanged.

## Settled decisions

1. Use the composite Stripe Card Element with `hidePostalCode: false` and US English locale. It is the only input surface in the merchant panel: no name, email, phone, country, Link, save-card, or payment-method selector fields.
2. Style the iframe as closely as practical to Albusto tokens and the floating-field shell; exact pixel canon inside the Stripe iframe is waived. **Technical correction:** Stripe’s [Appearance API does not support the Card Element](https://docs.stripe.com/elements/appearance-api?platform=web#limitations). Use the Card Element `style` option with token values resolved by the host, plus token-styled container/focus/error states.
3. The job Finance summary is ordered **Estimated · Invoiced · Paid · Due**.
4. Add a tenant-scoped, read-only merchant-session result endpoint. Its successful response has exactly four top-level keys: `{ status, amount, brand, last4 }`.
5. `ZIP` is literal. This product flow is US-only.
6. Split PaymentIntent creation at the provider method. Merchant keyed entry uses card-only `payment_method_types`; public pay continues using `automatic_payment_methods` and must contain no `payment_method_types`.
7. Success means only `PaymentIntent.status === 'succeeded'`. The success panel cannot close through Escape, overlay, or its normal close control; it stays open until the operator chooses **Done**.
8. A network/transport error after confirmation triggers result reconciliation. The UI cannot create or confirm another charge until that same PaymentIntent is known to be `requires_payment_method`.
9. Due is signed on every existing job UI that displays it. A negative value uses a true Unicode minus (`U+2212`) before the currency symbol and success/credit tone.

## Architecture and API contract

### Merchant PaymentIntent

Keep `stripeConnectProvider.createPaymentIntent` as the automatic-method provider used by public pay. Add a separate `createCardPaymentIntent` for merchant keyed entry:

```text
amount=<integer cents>
currency=usd
payment_method_types[0]=card
metadata[...]=...
```

The card-only body must have no `automatic_payment_methods` key. The existing public body remains:

```text
amount=<integer cents>
currency=<invoice currency>
automatic_payment_methods[enabled]=true
metadata[...]=...
```

The public body must have no `payment_method_types` key. `createCardSession(..., surface='manual_card')` changes to the new provider method; Terminal and public-pay calls do not.

### Stripe.js and PCI boundary

- Create `elements` with `clientSecret` and `locale: 'en'`, then `elements.create('card', { hidePostalCode: false, style: ... })`.
- Confirm through `stripe.confirmCardPayment(clientSecret, { payment_method: { card: cardElement } })`; default action handling performs any required 3DS/SCA challenge.
- The ZIP collected by Card Element becomes the PaymentMethod billing postal code. Do not copy job/contact name, email, or phone into `billing_details` for this flow.
- PAN, expiry, CVC, and ZIP stay in Stripe-controlled iframes. React state, Albusto DOM nodes, logs, API requests, and the backend must never receive card data.
- Destroy/unmount the Card Element on close, context change, and effect cleanup so reopening cannot retain or duplicate an iframe.
- This keeps the card fields Stripe-hosted and minimizes PCI exposure; the merchant’s formal PCI/SAQ classification remains a compliance determination, not a product claim.

### Result endpoint

```http
GET /api/payments/manual-card-sessions/:sessionId/result
Permission: payments.collect_keyed
Success 200: {"status":"succeeded","amount":95,"brand":"visa","last4":"4242"}
```

- Authentication and company access remain on the `/api/payments` mount. The route reads company only from `req.companyFilter?.company_id`.
- The route is declared before `/api/payments/:id`.
- Success is intentionally not wrapped in `{ ok, data }`; “only four keys” is an exact response-shape contract. Error responses keep the project’s normal error envelope.
- `amount` is the PaymentIntent amount in USD dollars (Stripe cents divided by 100). `status` is Stripe’s raw PaymentIntent status. `brand` and `last4` are strings or `null`, but both keys are always present.
- Resolve the session through the existing company-scoped `getSessionById(companyId, sessionId)`. Missing, foreign-company, non-merchant, or public-created sessions return 404 before any Stripe request.
- A merchant session is `surface='manual_card'` without `metadata.public === true`. The public path currently records its session with `surface='manual_card'`, so the metadata exclusion is required without changing public behavior.
- Retrieve the PaymentIntent on its stored connected account. If `payment_method` is an id, retrieve that PaymentMethod to obtain only `card.brand` and `card.last4`.
- Treat card-brand lookup as enrichment: once the PaymentIntent was retrieved, a missing/unavailable PaymentMethod yields `brand:null, last4:null` and must not hide an authoritative PI status.
- Never return or log client secrets, PaymentIntent ids, PaymentMethod ids, connected-account ids, billing data, or session metadata.

## UX contract

The form remains one canonical right-side panel (`DialogContent variant="panel"`, panel header/body/footer), becoming the existing bottom-sheet behavior on mobile. Host UI uses Albusto tokens, `--blanc-accent` (`#7F42E1`), the design-canon spacing rhythm, and no user-visible “Blanc” text.

The Card Element is the sole form control and visibly contains the four labels **Card number / MM/YY / CVC / ZIP**. The amount is display text, not an editable fifth field.

| State | Visual/copy | Controls and transition |
|---|---|---|
| Idle | Title **Enter card manually**. Security copy: “Card details are secured by Stripe. Albusto never sees the card number.” Four-field Card Element. | **Cancel** and violet **Charge $95.00**. Charge is disabled until Card Element reports `complete` and no Element error. |
| Submitting | Spinner and **Charging $95.00…**. Form is visibly disabled. | Disable submit, Cancel, Escape, overlay close, and duplicate confirmation. Await the same `confirmCardPayment` call. |
| 3DS challenge | Stripe-hosted challenge overlay, a Stripe-owned substate while the confirmation promise is pending. Stripe.js exposes no separate challenge-start callback, so the Albusto panel remains in its locked submitting state beneath it. | Stripe.js handles SCA for the same PaymentIntent. No Albusto charge/retry control is enabled during the challenge. |
| Declined / retryable | Heading **Card declined**. Safe Stripe message, then “No payment was made. Check the card details or use another card.” | Show **Try again** only when the returned/reconciled PI status is `requires_payment_method`; it reuses the current session/PI. Keep **Cancel** available. |
| Network / unknown | First: **Checking payment status…** and “The connection dropped after submission. We’re checking Stripe before another charge can be attempted.” If still unresolved: “We couldn’t confirm whether the charge completed. Check status before trying again.” | Immediately call the result endpoint, then retry with bounded backoff for up to 15 seconds. `succeeded` → Success; `requires_payment_method` → retryable; every other status or endpoint failure keeps charge disabled and offers only **Check status**. Never create a new session/PI in this branch. |
| Success | Large success icon, eyebrow **PAYMENT COMPLETE**, heading **Payment successful**, amount **$95.00 charged**, and `Visa •••• 4242` when available. Secondary status is **Updating Finance…**, then **Finance updated.** when parent revalidation observes the ledger; after timeout: “Payment is confirmed. Finance may take a moment to update.” | Only **Done** closes the panel. No automatic close or “Payment submitted” toast substitutes for this state. Success is entered only from a PI whose status is exactly `succeeded`. |

If Stripe returns a validation error before a confirmation attempt, keep the idle form and show the error beneath the Card Element; this is not the ambiguous network branch.

### Finance refresh and component reuse

- Keep one `ManualCardDialog` shared by job and invoice merchant entry points; do not fork the card form.
- Replace the overloaded `onSuccess` close behavior with separate concepts: a payment-confirmed callback (includes `{ status, amount, brand, last4 }` and starts parent-owned finance revalidation) and a **Done** callback (closes any owning method chooser after the success panel closes).
- Job Finance owns bounded refresh/polling of its invoices and completed canonical job payments. Invoice detail polls `fetchInvoice(invoice.id)` and refreshes its payment list. Ledger observation may change only the secondary sync copy; it never decides whether the charge succeeded.
- Timers/requests must be cancelled on owning-surface unmount. A timeout preserves the Stripe-confirmed success and leaves subsequent normal query refreshes to converge.

## Signed Finance math and affected surfaces

### Job Finance tab

Preserve current input sets and remove only the zero clamp:

```text
Estimated = sum(estimates.total)
Invoiced  = sum(invoices.total)
Paid      = sum(invoices.amount_paid)
          + sum(completed job payment transactions whose invoice_id is null)
Due       = Invoiced - Paid                     // signed; no Math.max
```

For a job with no invoice and one completed standalone `$95.00` payment: **Estimated $0.00 · Invoiced $0.00 · Paid $95.00 · Due −$95.00**. The Due metric uses credit/success tone when negative, warning tone when positive, and default tone at zero. Collection dialogs may still receive signed `outstanding`; their existing `> 0` prefill rule keeps a credit from becoming a negative charge amount.

### Jobs mobile tile/list

Extend the existing company-scoped batch rollup without double-counting invoice-linked ledger rows:

```text
amount_paid = non-void invoice amount_paid
            + completed standalone payment_transactions.amount
balance_due = non-void invoice balance_due
            - completed standalone payment_transactions.amount

standalone means:
  payment_transactions.company_id = requested company
  AND invoice_id IS NULL
  AND transaction_type = 'payment'
  AND status = 'completed'
```

- A job with neither a local invoice nor a standalone payment keeps both fields `null`, preserving the Zenbooker fallback.
- A job with no invoice and a `$95.00` standalone payment returns `amount_paid=95`, `balance_due=-95` and renders **Credit · −$95.00** in the existing success/credit tone.
- Existing non-void invoice inclusion rules stay unchanged. Refund semantics are a non-goal.

### Surface audit boundary

- **Changes:** Job Finance tab (`JobFinancialsTab`) and Jobs mobile tile/list (`JobMobileCard`, fed by `jobsService.listJobs`).
- **No current Due display:** desktop `JobsTable` and `ContactJobsList`; do not invent columns or rows.
- **No change:** `jobsService.getJobBalanceDue` is an invoice-only value for the outbound voice flow, not a job Due display. Changing voice-agent accounting is outside this task.

## Exact touch list (pre-implementation line anchors)

### Production files

| File and current lines | Planned change |
|---|---|
| `frontend/src/components/invoices/ManualCardDialog.tsx:18-71,74-104` | Payment Element → composite Card Element; cleanup; explicit state machine; `confirmCardPayment`; result reconciliation; persistent success panel and split callbacks. |
| `frontend/src/services/stripePaymentsApi.ts:71-83,86-142` | Add the exact four-key result type and GET client without changing invoice/job session creation. |
| `frontend/src/components/jobs/CollectPaymentDialog.tsx:199-206` | Continue reusing `ManualCardDialog`; propagate payment-confirmed separately from Done so success does not auto-close either panel. |
| `frontend/src/components/invoices/InvoiceDetailPanel.tsx:175-180,188,814-819` | Revalidate invoice/payment data after confirmed success; do not close the success panel before Done. |
| `frontend/src/hooks/useJobFinancials.ts:13-24,39-65,77-89` | Add parent-owned bounded post-payment revalidation and cancellation; keep canonical completed-payment filters. |
| `frontend/src/components/jobs/jobFinanceMath.ts:new` | Pure signed summary math and signed two-decimal currency formatting. |
| `frontend/src/components/jobs/JobFinancialsTab.tsx:39-42,61-68,138-165,538-552` | Four metrics, Paid value, signed Due/credit tone, and post-payment revalidation wiring. |
| `frontend/src/components/jobs/JobMobileCard.tsx:33-83,116-129` | Preserve signed values; render `Credit · −$X.XX` with success/credit tone. |
| `backend/src/services/stripeConnectProvider.js:147-159,228-244` | Add card-only PI creator and read-only PI/PaymentMethod retrieval; preserve automatic creator byte-for-behavior. |
| `backend/src/services/stripePaymentsService.js:450-521,874-900` | Switch only merchant `manual_card` creation; add/export company-scoped merchant result mapping. |
| `backend/src/routes/payments.js:76-123` | Add literal result GET before `/:id`, with `payments.collect_keyed` and `req.companyFilter?.company_id`. |
| `backend/src/services/jobsService.js:863-890` | Add completed standalone ledger payments to list rollup and return signed balance. |

No new dependency is required. Follow-up migration `181_payment_tx_job_standalone_index.sql` adds a partial index on `payment_transactions(job_id)` matching the standalone-rollup predicate (`invoice_id IS NULL AND transaction_type='payment' AND status='completed'`) so the jobs-list rollup stays index-driven as the ledger grows.

### Explicit no-touch boundary

- `frontend/src/pages/PublicInvoicePayPage.tsx:70-100`
- `backend/src/routes/public-invoices.js:59-65`
- `backend/src/services/stripePaymentsService.js:663-695`; its provider call remains `createPaymentIntent`
- `src/server.js:256-258` (protected mount already supplies authentication and company access)

### Test files

- `tests/stripeConnectProvider.test.js:new`
- `tests/stripeManualCardResult.routes.test.js:new`
- `tests/stripePaymentsQueries.test.js:new` (company-scoped `getSessionById` query contract)
- `tests/stripePayments.test.js:existing manual/public suites`
- `tests/stripeAdhocPay.test.js:existing merchant job-card suite`
- `tests/jobsService.test.js:new listJobs signed-rollup cases`
- `frontend/src/components/invoices/ManualCardDialog.test.tsx:new`
- `frontend/src/components/jobs/CollectPaymentDialog.test.tsx:new`
- `frontend/src/hooks/useJobFinancials.test.ts:new`
- `frontend/src/components/jobs/jobFinanceMath.test.ts:new`
- `frontend/src/components/jobs/JobMobileCard.test.tsx:new`

## Test plan

### Backend

1. Inspect form-encoded provider calls: merchant has only `payment_method_types[0]=card`; public automatic creator has `automatic_payment_methods[enabled]=true` and no payment-method-types field.
2. Assert `createManualCardSession` selects the card-only provider while `createPublicPayIntent` still selects the automatic provider.
3. Result service: company-scoped session lookup, merchant/public distinction, connected-account PI lookup, PaymentMethod card projection, exact four keys, dollars conversion, and 404 before Stripe for missing/foreign sessions.
4. Real payments router plus real `requirePermission`: 401 unauthenticated, 403 without `payments.collect_keyed`, foreign-company 404, company from `req.companyFilter`, endpoint ordered before `/:id`, and exact success JSON.
5. Jobs list rollup: no invoice/no payment remains null; no invoice + completed standalone `$95` becomes paid `95`/due `-95`; invoice-linked ledger rows are not double-counted; pending/refund/foreign-company rows are excluded.

### Frontend

1. Stripe mock asserts only `elements.create('card')`, `hidePostalCode:false`, US locale, supported Card Element style configuration, and cleanup. No React email/phone/name/country fields.
2. State tests cover idle completeness, one-submit lock, 3DS pending lock, declined retry gate, network reconciliation for every PI status, and success only for exact `succeeded`.
3. Success cannot close except through Done; confirmed and Done callbacks fire at their distinct times; job and invoice entry points use the same component.
4. Finance polling is bounded/cancellable and never downgrades a Stripe-confirmed success when the webhook-backed ledger is late.
5. Pure math and rendering tests assert the exact no-invoice example and Unicode-minus `−$95.00` credit copy on both Finance and mobile-list paths.

Manual staging acceptance uses Stripe test cards for success, decline, and `3DS Required`, plus an intercepted result request for the ambiguous-network state. Inspect the merchant panel for exactly four iframe inputs and confirm the public page still shows its unchanged Payment Element.

## Implementation tasks and estimates

Size guide: **S** = localized/low coupling, **M** = cross-file or stateful, **L** = broad/cross-layer. The full feature is **L**, delivered as the following small tasks.

### T1 — Provider split and public invariant (**S**)

**Acceptance criteria**

- Add card-only provider creation and its form-body tests.
- Switch only merchant manual-card session creation.
- Public pay and Terminal behavior are unchanged and protected by direct tests.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/stripeConnectProvider.test.js tests/stripePayments.test.js tests/stripeAdhocPay.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

### T2 — Tenant-scoped session result (**M**)

**Acceptance criteria**

- Add provider retrieval, service projection, and the literal GET route before `/:id`.
- Success body has exactly the four settled keys; no secrets/ids/metadata leak.
- 401, 403, foreign-company 404, merchant/public exclusion, company-scoped SQL, and no-Stripe-on-404 are covered.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/stripeManualCardResult.routes.test.js tests/stripePaymentsQueries.test.js tests/stripePayments.test.js tests/stripeConnectProvider.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

### T3 — Four-field Card Element and UX state machine (**M**)

**Acceptance criteria**

- The merchant form creates exactly one composite Card Element with postal code visible and no additional input components.
- Card data stays inside Stripe; `confirmCardPayment` handles SCA.
- All UX table states and copy are implemented, including cleanup and duplicate-submit locks.
- Network ambiguity cannot expose Charge/Try again until result status is `requires_payment_method`.

**Verify**

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/components/invoices/ManualCardDialog.test.tsx
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T4 — Persistent success, shared entry points, and Finance revalidation (**M**)

**Acceptance criteria**

- Success is exact-`succeeded`, unmistakable, and remains until Done.
- Payment-confirmed starts bounded parent revalidation; Done alone closes the card panel/owning job chooser.
- Invoice and job paths continue to reuse one `ManualCardDialog`; polling is cancellable and webhook lag has honest copy.

**Verify**

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/components/invoices/ManualCardDialog.test.tsx src/components/jobs/CollectPaymentDialog.test.tsx src/hooks/useJobFinancials.test.ts
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T5 — Four-metric Finance summary and signed Due (**S**)

**Acceptance criteria**

- Summary order is Estimated/Invoiced/Paid/Due.
- Due has no zero clamp and negative values render with `U+2212`, two decimals, and credit tone.
- No invoice + completed standalone `$95` produces Paid `$95.00`, Due `−$95.00`.

**Verify**

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/components/jobs/jobFinanceMath.test.ts
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T6 — Signed Jobs-list rollup and mobile credit pill (**M**)

**Acceptance criteria**

- The batch SQL is tenant-scoped, filters canonical standalone payments exactly as specified, and avoids invoice double-counting.
- Null fallback semantics stay intact for jobs with no local finance data.
- The mobile tile renders `Credit · −$95.00`; desktop list receives no invented Due column.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/jobsService.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/components/jobs/JobMobileCard.test.tsx
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T7 — Cross-layer regression and manual Stripe QA (**S**)

**Acceptance criteria**

- All affected backend and complete frontend suites pass from this worktree.
- Staging success/decline/3DS/network checks match the state table.
- Public Payment Element and public automatic-method PI body remain unchanged.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/stripeConnectProvider.test.js tests/stripeManualCardResult.routes.test.js tests/stripePaymentsQueries.test.js tests/stripePayments.test.js tests/stripeAdhocPay.test.js tests/jobsService.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
cd frontend && env -u NODE_USE_SYSTEM_CA npm test
```

## Sabotage-minimum controls

| Named control | Invariant | Deliberate break | Test that must go red |
|---|---|---|---|
| `CTRL-PUBLIC-AUTOMATIC` | Public provider body has `automatic_payment_methods[enabled]=true` and no `payment_method_types`; `createPublicPayIntent` calls that provider. | Route public pay through `createCardPaymentIntent`, remove automatic methods, or add card-only types to the public body. | `stripeConnectProvider.test.js` — **public createPaymentIntent remains automatic-only**; `stripePayments.test.js` — **public pay uses automatic provider**. |
| `CTRL-DUE-SIGNED` | No invoice + completed standalone `$95` means Paid `95`, Due `-95`, rendered `−$95.00`; no clamp exists. | Restore `Math.max(..., 0)`, omit standalone payments from list SQL, or format as `$-95.00`. | `jobFinanceMath.test.ts` — **standalone payment creates signed credit**; `jobsService.test.js` — **listJobs returns -95 without invoice**; `JobMobileCard.test.tsx` — **renders Credit · −$95.00**. |
| `CTRL-RESULT-TENANT-SHAPE` | Result lookup uses `req.companyFilter.company_id`; foreign sessions 404 before Stripe; success exposes exactly four keys. | Read legacy/body company id, remove the SQL company predicate, call Stripe before ownership resolution, or return ids/secrets/envelopes. | `stripeManualCardResult.routes.test.js` — **401/403/foreign-company-404 and exact top-level body**; `stripePaymentsQueries.test.js` — **getSessionById is company-scoped**. |
| `CTRL-NETWORK-NO-RECHARGE` | Ambiguous confirmation enables no new charge unless the same PI is `requires_payment_method`. | Re-enable Charge in `catch`, create a fresh session, or treat `processing`/`requires_action` as retryable. | `ManualCardDialog.test.tsx` — **network ambiguity reconciles without recharge**. |

## Non-goals

- Any visual, component, API, or PaymentIntent-method change to the public invoice pay page.
- Refund behavior or refund-aware Paid/Due accounting.
- Receipt generation, emailing, printing, or receipt settings.
- Saved cards, card-on-file, setup intents, Link, wallets, ACH, tips, or multi-currency merchant entry.
- Changes to Terminal/Tap to Pay, payment links, offline payment entry, the outbound voice balance calculation, or desktop Jobs-table columns.
- A database migration, new Stripe/npm dependency, or a claim that this feature alone determines PCI compliance.

## Risks and mitigations

- **Card Element longevity:** Stripe recommends newer Elements for broad payment-method UX; exact four-field control requires the legacy composite Card Element. Isolate it behind the existing shared dialog and provider split.
- **Iframe styling ceiling:** Card Element supports `style`, not Appearance API. Use resolved Albusto tokens and accept the approved iframe pixel waiver.
- **Webhook lag:** Stripe success can precede the canonical ledger. Keep success truthful, revalidate Finance in the parent, and never convert delayed ledger observation into payment failure.
- **Ambiguous transport failure:** A second charge is the highest-risk outcome. Reconcile the existing session/PI and gate retry strictly on `requires_payment_method`.
- **Credit semantics:** Negative Due here means overpayment/standalone job credit, not a refund or stored-wallet balance. Use clear “Credit” copy and keep refund accounting out of scope.

---

## Addendum — STRIPE-RECEIPT-001

### Goal and settled decisions

After an exact-`succeeded` merchant keyed-card charge, the persistent success panel optionally sends Stripe's native receipt from the connected account. The original receipt non-goal above is superseded only for this merchant success block.

- Use Stripe's documented post-success path: update the successful Charge's `receipt_email` with the connected account in `Stripe-Account`. No Albusto template or mailer. ([Charge update](https://docs.stripe.com/api/charges/update?lang=node), [receipts](https://docs.stripe.com/receipts), [connected-account requests](https://docs.stripe.com/api/connected-accounts))
- Live mode sends the native email. Test mode does not deliver it; QA asserts the updated Charge has the submitted `receipt_email` and a non-empty `receipt_url`.
- Add `POST /api/payments/manual-card-sessions/:sessionId/receipt` with body `{ "email": string }`, real `payments.collect_keyed`, tenant from `req.companyFilter.company_id`, and the same merchant-session ownership/public exclusion as result reconciliation. Missing, foreign, public, and non-manual sessions 404 before Stripe.
- Validate and normalize email server-side. Never echo an invalid address in an error or write a receipt address to application/event logs.
- Resolve the current contact server-side from the company-scoped session, with current invoice/job contact linkage as fallback. If its scalar email is empty, reuse `JOB-CONTACT-SYNC-001` propagation in PII-redacted mode. The final SQL write includes an atomic empty predicate. An existing value is never overwritten; an unbound contact means send only.
- Response is `{ sent, receipt_url, contact_email_saved }`. It contains no email, Stripe ids, client secret, metadata, or account id.
- Job and invoice entry points pass their known contact email and contact-existence flag to the one shared `ManualCardDialog`; the backend never trusts these values for persistence.
- Public invoice pay, its Payment Element, and its automatic-method PaymentIntent path remain untouched.

### Success-panel contract

The optional block sits below brand/last4 and above Done.

| State | Field/button | Copy and behavior |
|---|---|---|
| Prefilled | Editable floating field `Customer email`; secondary violet `Send receipt` | Use the known contact email when present. |
| Empty contact | Editable empty field | Show only when a contact is actually bound and its known email is empty: `This email will be saved to the customer's contact.` |
| Sending | Field and button locked; spinner | `Sending receipt…`; Done remains enabled and closes immediately if chosen. |
| Sent | Field/button locked; check state | `Receipt sent to <email>`; no second send in this panel instance. |
| Failure | Field editable; retry enabled | Inline `We couldn’t send the receipt. Try again.` Done remains enabled. |

Sending is optional. Payment success and Finance revalidation do not depend on receipt delivery or contact persistence.

### Exact touch list

| File:line | Change |
|---|---|
| `backend/src/services/stripeConnectProvider.js:187-191` | Connected-account Charge update with `receipt_email`. |
| `backend/src/db/stripePaymentsQueries.js:241-260` | Company-scoped session/invoice/job contact resolution. |
| `backend/src/services/stripePaymentsService.js:528-634` | Shared merchant guard reuse, email validation, exact-succeeded/Charge resolution, native receipt send, and fill-empty decision. |
| `backend/src/routes/payments.js:125-143` | Literal receipt POST before `/:id`, keyed permission, and `req.companyFilter` tenant. |
| `backend/src/services/contactPropagationService.js:52-164` | Opt-in PII redaction and atomic fill-empty email write in the existing propagation path. |
| `frontend/src/services/stripePaymentsApi.ts:48-110` | Receipt result type and authenticated POST client. |
| `frontend/src/components/invoices/ManualCardDialog.tsx:28-91,304-572,679-718` | Receipt state, prefill/edit/send/retry/sent behavior, caption predicate, and Done independence. |
| `frontend/src/components/invoices/InvoiceDetailPanel.tsx:868-876` | Invoice contact prefill/context wiring. |
| `frontend/src/components/jobs/CollectPaymentDialog.tsx:13-25,241-256` | Shared job receipt context passthrough. |
| `frontend/src/components/jobs/JobFinancialsTab.tsx:77-84,553-565` | Job Finance contact context passthrough. |
| `frontend/src/components/jobs/JobDetailPanel.tsx:120-127,156-163` | Known contact email/existence supplied from hydrated job detail. |
| `tests/stripeManualCardReceipt.routes.test.js:new` | 401/403, real permission, company source, foreign 404, validation mapping, route ordering. |
| `tests/stripeConnectProvider.test.js:80-106` | Charge body, `Stripe-Account`, returned `receipt_email` and `receipt_url`. |
| `tests/stripePayments.test.js:384-493` | Succeeded-only send, merchant/public exclusion before Stripe, validation, fill-empty, never-overwrite, and no-contact semantics. |
| `tests/stripePaymentsQueries.test.js:39-59` | Tenant predicates on every receipt-contact join. |
| `tests/contactPropagationService.test.js:135-193` | Atomic race guard and receipt-mode PII redaction. |
| `frontend/src/components/invoices/ManualCardDialog.test.tsx:183-294` | Prefill/edit, caption-only-when-empty, sending/sent lock, API projection, and Done independence. |

### Test and QA plan

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/stripeConnectProvider.test.js tests/stripeManualCardResult.routes.test.js tests/stripeManualCardReceipt.routes.test.js tests/stripePaymentsQueries.test.js tests/stripePayments.test.js tests/stripeAdhocPay.test.js tests/contactPropagationService.test.js --testPathIgnorePatterns /node_modules/ --runInBand --forceExit
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
cd frontend && env -u NODE_USE_SYSTEM_CA npm test
```

Manual connected-account QA:

1. In test mode, complete a merchant keyed-card payment, send a receipt, and verify the connected-account Charge now has the submitted `receipt_email` and a `receipt_url`; no inbox delivery is expected.
2. In live mode, send to an owned address and verify Stripe's branded native receipt arrives.
3. Repeat with contact email present, contact email empty, and no contact; verify respectively no contact write, one fill-empty write, and send-only.
4. Edit a prefilled address and verify Stripe receives the edit while the existing contact remains unchanged.
5. Verify Done works before sending, during sending, after failure, and after sent.

### Addendum non-goals and risks

- No public-pay receipt UI/API behavior, custom email, receipt template, receipt PDF generation, print/download action, automatic send, or delivery-status webhook.
- No overwrite/merge resolution for an existing contact email, refunds, resend history, or receipt settings UI.
- A transport failure after Stripe accepts the Charge update can make a retry send another native receipt; this endpoint never risks a second charge, but Stripe provides no local atomic transaction spanning email delivery and contact persistence.

---

## Addendum — DOC-SEND-NOTE-001

### Goal and settled decisions

Every successful receipt, invoice, or estimate delivery leaves a greppable note showing exactly what was sent and where, so one-off destinations remain discoverable on the owning job.

- Covered server-side seams are Stripe receipt completion in `sendManualCardReceipt`, authenticated invoice `POST /api/invoices/:id/send`, and authenticated estimate `POST /api/estimates/:id/send`. The invoice and estimate seams support both email and SMS; `/e/:token` is view-only and needs no frontend workaround.
- Target the owning job: use the receipt session's `job_id`, fall back through its company-scoped invoice when necessary, and use the invoice/estimate's `job_id` directly. Invoice/estimate `notes` are document copy and their event streams are lifecycle records, not canonical free-form notes; a document with no job therefore sends normally and emits a recipient-free warning.
- Exact note copy is `Receipt for $95.00 sent to x@y.z`, `Invoice #<number> sent to x@y.z`, or `Estimate #<number> sent to x@y.z`. SMS uses `… sent by SMS to +1…` with the normalized E.164 destination.
- Author is the acting `req.user.crmUser.id`, never the Keycloak `sub`; the visible author uses the same first-name/email fallback as normal job notes.
- Reuse `jobsService.addNote`. New document-send calls provide `companyId`, making both the job lookup and note update tenant-scoped. Existing callers retain their current signature.
- Note creation runs only after external delivery succeeds. Missing binding, actor, foreign job, or any note error is non-fatal and warns without including the recipient. No receipt/invoice/estimate response contract changes.
- No new endpoint and no frontend change.

### Exact touch list

| File | Change |
|---|---|
| `backend/src/services/documentSendNoteService.js` | Shared exact-copy builder, strict request actor, and non-fatal normal-job-note writer. |
| `backend/src/routes/payments.js` | Pass the strict acting CRM user into the existing receipt service call. |
| `backend/src/routes/invoices.js` | Pass the strict acting CRM user into invoice delivery. |
| `backend/src/routes/estimates.js` | Pass the strict acting CRM user into estimate delivery. |
| `backend/src/services/stripePaymentsService.js` | Write the receipt note after Charge update; resolve session job then company-scoped invoice fallback. |
| `backend/src/services/invoicesService.js` | Write exact email/SMS job note after successful dispatch. |
| `backend/src/services/estimatesService.js` | Write exact email/SMS job note after successful dispatch. |
| `backend/src/services/jobsService.js` | Optional company scope for the normal `addNote` read and writes. |
| `tests/stripePayments.test.js` | Receipt copy, job fallback, author/company scope, unbound, and non-fatal behavior. |
| `tests/stripeManualCardReceipt.routes.test.js` | Strict CRM actor forwarding through the existing guarded route. |
| `tests/sendDocInvoice.test.js` | Exact email/SMS copy, acting author, company scope, unbound, and non-fatal behavior. |
| `tests/sendDocEstimate.test.js` | Exact email/SMS copy, acting author, company scope, and non-fatal behavior. |
| `tests/jobsService.test.js` | Company-qualified job read and note update. |

### Verification

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/stripeConnectProvider.test.js tests/stripeManualCardResult.routes.test.js tests/stripeManualCardReceipt.routes.test.js tests/stripePaymentsQueries.test.js tests/stripePayments.test.js tests/stripeAdhocPay.test.js tests/contactPropagationService.test.js tests/jobsService.test.js tests/sendDocInvoice.test.js tests/sendDocEstimate.test.js --testPathIgnorePatterns /node_modules/ --runInBand --forceExit
```

### Non-goals and risks

- No client-side note, public estimate-page behavior, new note endpoint, document-content mutation, receipt template, or delivery-history model.
- A successful external send followed by a failed note is intentionally reported as a successful send; the PII-free warning is the operational signal for best-effort note repair.
