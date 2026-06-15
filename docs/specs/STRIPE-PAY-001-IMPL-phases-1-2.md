# Implementation Spec: STRIPE-PAY-001 (F018) — Phases 1–2

**Date:** 2026-06-14 · **Status:** Approved for implementation · **Priority:** P0
**Parent:** `docs/specs/STRIPE-PAY-001-stripe-payments-marketplace.md`
**Requirements:** requirements.md F018 · **Architecture:** architecture.md F018
**Scope:** Phase 1 (marketplace + Connect onboarding + settings page + gating) and
Phase 2 (invoice payment links + public Pay now + webhook ledger sync). Manual card,
Tap to Pay, refunds, reporting filters are OUT.

**Fixed decisions:** direct charges, tenant = merchant of record, no application fee;
Stripe Connect Accounts v2; Tap to Pay deferred.

---

## 1. Environment / config

- `STRIPE_SECRET_KEY` — platform secret key (already used by platform billing). Reused
  for Connect API calls (platform acts as Connect platform). Do not add a second key.
- `STRIPE_CONNECT_WEBHOOK_SECRET` — NEW. Signing secret for the tenant-payments webhook
  endpoint (distinct from `STRIPE_WEBHOOK_SECRET` used by platform billing).
- `APP_PUBLIC_URL` / existing base-URL helper — for building onboarding return/refresh
  URLs and Checkout success/cancel URLs.
- **Degraded mode:** if `STRIPE_SECRET_KEY` is unset, `/status` returns
  `{ configured: false }`; the settings page shows an inactive state and Connect is
  disabled (mirrors billing degraded-mode pattern). No crash.

## 2. Data model (migrations 107–110)

### 2.1 stripe_connected_accounts (107)
One row per company. `company_id UNIQUE NOT NULL` (FK companies). Columns:
`marketplace_installation_id` (FK, nullable), `stripe_account_id TEXT NOT NULL`,
`livemode BOOL`, `charges_enabled BOOL DEFAULT false`, `payouts_enabled BOOL DEFAULT false`,
`details_submitted BOOL DEFAULT false`, `requirements_currently_due JSONB DEFAULT '[]'`,
`requirements_past_due JSONB DEFAULT '[]'`, `capabilities JSONB DEFAULT '{}'`,
`status TEXT` (see state machine §5), `created_at`, `updated_at` (trigger).
Index on `stripe_account_id` (webhook lookup). Migration idempotent (`IF NOT EXISTS`).

### 2.2 stripe_payment_sessions (108)
`id BIGSERIAL`, `company_id UUID NOT NULL`, `invoice_id BIGINT`, `job_id BIGINT`,
`contact_id BIGINT`, `created_by UUID`, `surface TEXT CHECK (surface IN
('checkout_link','manual_card','tap_to_pay'))`, `amount NUMERIC(12,2)`,
`currency VARCHAR(3) DEFAULT 'USD'`, `status TEXT` (`open|complete|expired|canceled`),
`stripe_checkout_session_id TEXT`, `stripe_payment_intent_id TEXT`,
`stripe_charge_id TEXT`, `stripe_account_id TEXT`, `url TEXT`, `expires_at TIMESTAMPTZ`,
`metadata JSONB DEFAULT '{}'`, timestamps. Index `(company_id, invoice_id)` and
`(stripe_checkout_session_id)`, `(stripe_payment_intent_id)`.

### 2.3 stripe_webhook_events (109)
`stripe_event_id TEXT UNIQUE NOT NULL`, `livemode BOOL`, `event_type TEXT`,
`stripe_account_id TEXT`, `company_id UUID`, `processing_status TEXT`
(`received|processed|failed|ignored`), `payload JSONB`, `error TEXT`, `processed_at`,
`created_at`. Insert-on-receive with `ON CONFLICT (stripe_event_id) DO NOTHING` → if 0
rows inserted, event already seen → ack 200 without reprocessing.

### 2.4 Ledger idempotency
Add partial unique index `uniq_payment_tx_stripe_external ON payment_transactions
(company_id, external_id) WHERE external_source='stripe'` (mirrors 104 for zenbooker).
`paymentsService.createTransaction` is extended (or a thin idempotent wrapper added) to
`ON CONFLICT DO NOTHING`-return the existing row when `external_source='stripe'`.

### 2.5 Marketplace seed (110)
`marketplace_apps` upsert: app_key `stripe-payments`, name `Stripe Payments`,
provider_name `Stripe`, category `payments`, app_type `external`, provisioning_mode
`none`, status `published`, short_description "Accept invoice payments, keyed card
payments, and Tap to Pay in the field.", metadata `{"setup_path":
"/settings/integrations/stripe-payments"}`. Idempotent `ON CONFLICT (app_key)`.
Register in `marketplaceQueries.ensureMarketplaceSchema` after the 088 seed.

## 3. Backend behavior

### 3.1 stripeConnectProvider.js (REST, zero-SDK)
- `createAccount()` → POST /v2/accounts (or v1 with controller config for direct
  charges); returns `{ id }`. Account is `controller.losses.payments=stripe` style per
  direct-charge merchant-of-record; **no** application fee config.
- `createAccountLink(accountId, {refreshUrl, returnUrl})` → POST /v1/account_links
  (type `account_onboarding`).
- `getAccount(accountId)` → GET /v1/accounts/:id → map `charges_enabled`,
  `payouts_enabled`, `details_submitted`, `requirements.currently_due/past_due`,
  `capabilities`.
- `createCheckoutSession(accountId, params)` → POST /v1/checkout/sessions with
  `Stripe-Account: <accountId>` header (direct charge on connected account), mode
  `payment`, single line_item from invoice balance, `payment_intent_data`,
  `metadata`, `success_url`, `cancel_url`, `expires_at`. Idempotency-Key header.
- `retrieveCheckoutSession(accountId, id)`.
- `parseConnectWebhook(rawBody, sig)` → verify with `STRIPE_CONNECT_WEBHOOK_SECRET`,
  return event (incl. `account` field = connected account id). Reuse the hardened HMAC
  logic from platform `stripeProvider.parseWebhook` (length-mismatch safe).

### 3.2 stripePaymentsService.js
- `getStatus(companyId)` → `{ configured, connected, account: {…flags}, readiness:
  <state>, checklist: [...], livemode }`.
- `connect(companyId, userId)` → if no row: create Stripe account, persist row, create
  marketplace installation (via marketplaceService, app_key stripe-payments), return
  onboarding link. Idempotent: reuse existing account.
- `getOnboardingLink(companyId)` → account link for resume.
- `refreshStatus(companyId)` → getAccount → update row → recompute readiness; emit
  `requirements changed` audit if changed.
- `disconnect(companyId, userId)` → set status `disconnected`, disconnect marketplace
  installation, stop new collection. History untouched. (Stripe account NOT deleted.)
- `ensurePaymentLink(companyId, userId, invoiceId, {amount?})` → readiness gate; load
  invoice (company-scoped, else 404); reject if void/refunded or balance<=0; if a valid
  `open` non-expired session for same invoice+amount exists → return it (FR-004); else
  create Checkout Session, persist `stripe_payment_sessions` row (surface checkout_link),
  audit `payment link created`, return `{url, expires_at}`.
- `getPaymentLink(companyId, invoiceId)` → active session + attempt history.
- `sendPaymentLink(companyId, userId, invoiceId, {channel, message})` → ensure link →
  send via existing email/SMS path → `invoicesQueries.createEvent('payment_link_sent')`
  → audit. Error if Stripe not ready.
- `handleWebhook(rawBody, sig)` → parse+verify; insert stripe_webhook_events (dedup);
  resolve company by `stripe_account_id` (NOT by trusting metadata alone — verify the
  account→company mapping); dispatch:
  - `checkout.session.completed` / `payment_intent.succeeded` → mark session complete,
    write ledger via `paymentsService.createTransaction({external_source:'stripe',
    external_id:<charge/pi id>, payment_method:'credit_card', invoice_id, contact_id,
    job_id, amount, currency, metadata, transaction_type:'payment'})` (idempotent);
    invoice paid/balance via existing path. Audit `payment succeeded`.
  - `payment_intent.payment_failed` → mark session, store failure reason on session;
    NO completed ledger row. Audit `payment failed`.
  - `charge.refunded` (Phase 5 — log+ignore in this run, store event).
  - `account.updated` / capability events → refreshStatus mapping for that account.
  - Unknown → mark `ignored`, ack 200.
  - Mark event `processed`/`failed` accordingly. Always 200 on signature-valid handled
    or ignored events; 400 only on bad/missing signature.

### 3.3 Routes & middleware
- `app.use('/api/stripe-payments/webhook', express.raw({type:'*/*', limit:'1mb'}),
  stripePaymentsWebhookRouter)` — mounted BEFORE express.json, separate from billing.
- `app.use('/api/stripe-payments', authenticate, requirePermission(
  'tenant.integrations.manage'), requireCompanyAccess, stripePaymentsRouter)`.
- Invoice endpoints added to existing `routes/invoices.js` (already authed) with
  `requirePermission('payments.collect_online')` (write) / `'payments.view'` (read).
- Public endpoints added to `public-invoices.js` (no auth, token credential, opaque,
  never expose internal ids; rate-limit/regex-guard token like existing short router).
- `company_id` always from `req.companyFilter?.company_id`; cross-company entity → 404.

## 4. Frontend behavior

- **IntegrationsPage:** add `stripe-payments` branch mirroring `vapi-ai` (~L259):
  Configure/Manage → `navigate('/settings/integrations/stripe-payments')`; extend
  `marketplaceStatusBadge` mapping for the F018 readiness badges.
- **StripePaymentsSettingsPage** (model VapiSettingsPage): header + status badge; setup
  checklist (Connect → Onboarding → Payment methods → [Field payments: shown disabled,
  "Coming soon"] → Test payment); readiness panels; actions Connect / Resume onboarding
  / Open Dashboard / Refresh / Disconnect (Tap-to-Pay / payment-method-enable actions
  rendered disabled with "deferred" note). React Query for `/status`. Blanc design.
- **InvoiceDetailPanel:** split `Record payment` → menu `Collect payment`
  (Send payment link / Copy payment link — Phase 2 subset; Enter card / Tap to Pay shown
  disabled "coming soon") and `Record offline payment` (Cash / Check / Other → existing
  recordPayment). Stripe-not-ready banner. Show active link, latest attempt + failure
  reason, linked successful payments.
- **Invoice send dialog:** `Include payment link` toggle (default ON when balance>0 &&
  ready; OFF + disabled when not ready / paid / void), copy+preview, not-ready warning.
- **Public Pay now:** public pay page (or token redirect) → `pay-info` for summary +
  `pay` to create/reuse session → redirect to Stripe; paid/unavailable states.

## 5. Readiness state machine
`not_connected` (no row) → `onboarding_incomplete` (account exists, !details_submitted)
→ `action_required` (requirements_past_due non-empty OR currently_due blocking) →
`payments_disabled` (details submitted but !charges_enabled/no card cap) →
`payouts_disabled` (charges_enabled && !payouts_enabled — collection allowed, warn) →
`connected_ready` (charges_enabled && card cap active). `disconnected` (manual).
Online collection allowed only in `payouts_disabled` or `connected_ready`.

## 6. Edge cases & error handling
- Invoice balance changes between link creation and payment → next session uses current
  balance; completed payment caps recorded amount at balance (no silent overpay).
- Duplicate webhook (same event id) → deduped, single ledger row.
- Out-of-order webhooks (pi.succeeded before checkout.completed) → both map to same
  external_id → idempotent single row.
- Cross-tenant Stripe object (account id not mapped to a company) → reject, mark event
  `failed`, do NOT mutate ledger.
- Void/refunded/zero-balance invoice → link creation + Pay now blocked.
- Stripe API/network error → surfaced as actionable error; no partial DB state.
- Disconnect while sessions open → new collection blocked; existing rows preserved.
- Missing permission → 403; missing/invalid signature → 400; unknown event → 200 ignored.

## 7. Out of scope (this run)
Manual card / Payment Element session endpoints; Tap to Pay / Terminal
connection-token + payment-intent; refunds + dispute handling; reporting filter
expansion; application-fee funds flow.

---

# Addendum: Phases 3–5 (implemented 2026-06-14)

## Phase 3 — Manual card entry (Payment Element)
- `POST /api/invoices/:id/stripe-manual-card-session` and
  `POST /api/jobs/:id/stripe-manual-card-session` (perm `payments.collect_keyed`).
  Backend creates a direct-charge PaymentIntent (automatic payment methods) on the
  connected account and persists a `manual_card` session; returns `{ client_secret,
  payment_intent_id, account_id, amount }`. Invoice context defaults to balance; job
  context requires explicit amount.
- Frontend `ManualCardDialog` loads Stripe.js (`utils/loadStripe.ts`, no dep) with the
  platform publishable key + `{ stripeAccount }` (direct charge), mounts a Payment
  Element, confirms with `redirect: 'if_required'`. Ledger updates via the existing
  `payment_intent.succeeded` webhook (idempotent). Card data never touches Albusto.

## Phase 4 — Terminal / Tap to Pay (backend only)
- `POST /api/stripe-terminal/connection-token` (perm `payments.collect_terminal`),
  `POST /api/stripe-terminal/payment-intents/:id/cancel`,
  `POST /api/invoices|jobs/:id/tap-to-pay/payment-intent` (card_present PI).
- `stripe_terminal_locations` (migration 111). **NFC client is blocked**: a browser
  SPA cannot drive the Terminal SDK; a native/RN mobile shell must call these endpoints.

## Phase 5 — Refunds, disputes, reporting
- `POST /api/payments/:id/stripe-refund` (perm `payments.refund`): validates a
  completed Stripe tx, calls Stripe refund on the connected account, records via the
  canonical ledger (negative `refund` row, original → `refunded`, invoice reversed).
- Idempotent `applyStripeRefund` keyed on the Stripe refund id; webhook
  `charge.refunded` records refunds initiated from the Stripe dashboard; idempotent so
  manual + webhook never double-record. `charge.dispute.created` marks the tx + audit.
- Reporting: ledger `source` filter (`stripe` | `zenbooker` | `manual`) on
  `GET /api/payments` and the Transactions page; `useTransactions` routes refunds of
  Stripe payments through the Stripe endpoint (the generic refund only writes a row).

## Permissions
- Migration 112 seeds `payments.collect_keyed` (admin/manager/dispatcher) and
  `payments.collect_terminal` (admin/manager/provider). `reports.payments.view` already
  existed. Dev-mode list updated.
