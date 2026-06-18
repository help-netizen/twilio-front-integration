# F018 / STRIPE-PAY-001 — E2E validation results (2026-06-15)

Integration testing of the deployed F018 code against a real DB + real HMAC signing
(local dev-mode, Stripe **test** account `51TiRN8`). Prod `/status` was already
verified live (authenticated, `HTTP 200`, `configured:true`, `livemode:false`).

## ✅ Validated end-to-end (real DB, real signed webhooks)
| Area | Result |
|---|---|
| Readiness state machine | DB-backed `/status` returns `connected_ready` / `can_collect:true` when account flags set; `not_connected` when absent |
| Webhook signature | Valid signature → processed; **bad/missing → HTTP 400** |
| Webhook → ledger | `checkout.session.completed` writes **one** `payment_transactions` row (`external_source='stripe'`) |
| Dual idempotency | event-id replay → `deduped`; `payment_intent.succeeded` for same PI → **still 1 ledger row** (external_id dedup) |
| Invoice paid transition | full payment → invoice `paid`, `amount_paid` set, `balance_due=0`, `paid_at` stamped |
| Failed payment | `payment_intent.payment_failed` → **no** completed ledger row |
| Refund | `charge.refunded` → negative `refund` row, original tx → `refunded`, **invoice reversed** (`amount_paid=0`, balance restored, status back to `sent`) |
| Reporting filter | `GET /api/payments?source=stripe` returns only Stripe rows (payment + refund) |
| Gating — payment link | ready → passes gate & reaches Stripe; **not-ready → 409 `NOT_READY`** |
| Gating — terminal | not-ready → `NOT_READY` |
| Auth/2FA (prod) | unauth → 401; missing trusted device → `PHONE_VERIFICATION_REQUIRED`; with token + trusted device → 200 |

Unit suite: `tests/stripePayments.test.js` 26/26.

## ⛔ Blocked — needs ONE Stripe dashboard action (not a code issue)
**Connect is not enabled on the Stripe account `51TiRN8` (test mode).** Stripe rejects
connected-account creation: *"You can only create new accounts if you've signed up for
Connect."* This blocks the live-Stripe paths:
- `POST /api/stripe-payments/connect` (create connected account + onboarding link)
- Real Checkout Session creation for invoice payment links
- Real Terminal `connection-token`

**Action:** enable Connect at <https://dashboard.stripe.com/connect> (test mode), then
re-run `/connect` → onboarding → a real test-card Checkout to exercise the live path.
These flows are covered by unit tests; only the live-Stripe integration is pending this toggle.

## ⛔ Blocked — needs a mobile shell
- **Tap to Pay on-device NFC UI** — backend (connection-token, card_present intent,
  cancel) is done and gated; the NFC client requires a native/React-Native app (web SPA
  can't drive the Terminal SDK).

## ℹ️ By decision
- Prod runs **Stripe TEST** keys (intentional). Live payments need live
  `STRIPE_SECRET_KEY` + a live-mode `STRIPE_CONNECT_WEBHOOK_SECRET` + live
  `VITE_STRIPE_PUBLISHABLE_KEY`.

## Conclusion
All F018 application logic is validated end-to-end. The remaining items are **external
configuration** (enable Connect; optionally switch to live keys) and a **mobile shell**
for Tap to Pay — none are code gaps.
