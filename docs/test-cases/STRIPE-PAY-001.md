# Test Cases: STRIPE-PAY-001 (F018) — Phases 1–2

**Spec:** docs/specs/STRIPE-PAY-001-IMPL-phases-1-2.md
**Framework:** Jest (backend). Priorities P0 (must) → P3 (nice).
**Mandatory per project security rules:** every new API route has 401 (no auth) /
403 (missing permission) tests and cross-company isolation (foreign id → 404).

## Unit / integration — onboarding & status (Phase 1)

| ID | P | Type | Case | Expected |
|----|---|------|------|----------|
| TC-01 | P0 | unit | readiness mapping: no row | state `not_connected`, collection blocked |
| TC-02 | P0 | unit | account exists, !details_submitted | `onboarding_incomplete` |
| TC-03 | P0 | unit | requirements_past_due non-empty | `action_required` |
| TC-04 | P0 | unit | details submitted, !charges_enabled | `payments_disabled`, collection blocked |
| TC-05 | P0 | unit | charges_enabled, !payouts_enabled | `payouts_disabled`, collection ALLOWED + warn |
| TC-06 | P0 | unit | charges_enabled + card cap active | `connected_ready`, collection allowed |
| TC-07 | P0 | int | `POST /connect` no existing account | creates account+row+installation, returns onboarding url |
| TC-08 | P1 | int | `POST /connect` idempotent (existing account) | reuses account, no duplicate row |
| TC-09 | P0 | int | `POST /refresh-status` | pulls Stripe, updates flags, recomputes readiness |
| TC-10 | P0 | int | `POST /disconnect` | status `disconnected`, installation disconnected, history rows untouched |
| TC-11 | P0 | int | `GET /status` STRIPE_SECRET_KEY unset | `{configured:false}`, no crash (degraded) |
| TC-12 | P0 | int | all `/api/stripe-payments/*` without auth | 401 |
| TC-13 | P0 | int | `/api/stripe-payments/*` missing `tenant.integrations.manage` | 403 |
| TC-14 | P0 | int | company A reads company B account | scoped to A only / 404 (no leak) |

## Invoice payment links (Phase 2)

| ID | P | Type | Case | Expected |
|----|---|------|------|----------|
| TC-20 | P0 | int | create link, invoice balance>0, Stripe ready | Checkout session created, session row persisted, url returned |
| TC-21 | P0 | int | create link when Stripe not ready | 409/422 actionable error, no session |
| TC-22 | P0 | int | create link, balance=0 / void / refunded | rejected (business rule) |
| TC-23 | P0 | int | re-request link, valid open session same amount exists | reuses session, NO duplicate (FR-004) |
| TC-24 | P1 | int | link reflects current balance at creation | amount == current balance_due |
| TC-25 | P0 | int | `POST /send-payment-link` email/SMS | sends, writes `payment_link_sent` invoice_event |
| TC-26 | P1 | int | send when Stripe not ready | clear error, no send |
| TC-27 | P0 | int | invoice link routes without `payments.collect_online` | 403 (write); read needs `payments.view` |
| TC-28 | P0 | int | create link for company B invoice as company A | 404 |

## Webhook & ledger sync (Phase 2)

| ID | P | Type | Case | Expected |
|----|---|------|------|----------|
| TC-30 | P0 | int | webhook bad/missing signature | 400, no DB mutation |
| TC-31 | P0 | int | valid `checkout.session.completed` | one `payment_transactions` row, external_source='stripe', invoice paid/partial |
| TC-32 | P0 | int | same event delivered twice (same stripe_event_id) | deduped, still ONE ledger row, 200 |
| TC-33 | P0 | int | `payment_intent.succeeded` + `checkout.session.completed` same payment | idempotent on (company_id, external_id) → ONE row |
| TC-34 | P0 | int | `payment_intent.payment_failed` | session marked failed, NO completed ledger row, failure visible |
| TC-35 | P0 | int | webhook account id not mapped to any company | rejected, event `failed`, NO ledger mutation (tenant-scope) |
| TC-36 | P1 | int | full payment | invoice → `paid`, paid_at set |
| TC-37 | P1 | int | partial payment | invoice → `partial`, balance recalculated |
| TC-38 | P1 | int | `account.updated` capability change | connected account flags refreshed |
| TC-39 | P2 | int | unknown event type | marked `ignored`, 200 |
| TC-40 | P1 | int | ledger write goes through paymentsService (not duplicate INSERT) | invoice balance updated via canonical path |

## Public Pay now (Phase 2)

| ID | P | Type | Case | Expected |
|----|---|------|------|----------|
| TC-50 | P0 | int | `GET /pay-info` valid token, balance>0 | summary+balance, NO internal ids exposed |
| TC-51 | P0 | int | `POST /pay` valid token | create/reuse session, returns Stripe url |
| TC-52 | P1 | int | `pay-info` paid invoice | paid state, no Pay CTA |
| TC-53 | P1 | int | `pay` when Stripe disconnected / void | unavailable state |
| TC-54 | P1 | int | invalid/garbage token | 404 (regex guard) |

## Audit events

| ID | P | Type | Case | Expected |
|----|---|------|------|----------|
| TC-60 | P2 | int | connect / disconnect / requirements changed | audit/domain events written |
| TC-61 | P2 | int | link created / link sent / payment succeeded / failed | events written |

## Regression / non-functional

| ID | P | Type | Case | Expected |
|----|---|------|------|----------|
| TC-70 | P0 | int | platform billing webhook `/api/billing/webhook` unaffected | existing billing tests green |
| TC-71 | P0 | int | existing payments/invoices suites | green, no regressions |
| TC-72 | P1 | static | no PAN/CVC/bank data logged or stored | code review + grep assertion |
| TC-73 | P1 | int | payment initiation uses idempotency key | retry safe (no double charge intent) |

**Coverage target:** all P0 cases automated in Jest before Reviewer APPROVED. P1 where
feasible; P2/P3 may be manual/deferred but listed.
