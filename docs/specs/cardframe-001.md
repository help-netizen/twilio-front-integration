# CARDFRAME-001 — isolate Stripe card entry in a popup window (iOS card-bar fix)

Status: SPEC. Owner-approved approach 2026-07-27. Fixes #53.

## Problem (confirmed empirically on the owner's iPhone)
After the manual card-entry form (Stripe Elements) is opened once in a tab, iOS Safari flags the
whole TAB as payment-collecting and shows the saved-card AutoFill bar on EVERY input for the rest
of the session. Confirmed:
- Our fields already set `autocomplete="off"` — iOS ignores it in this context.
- Removing Stripe's DOM footprint on close (teardownStripe, shipped fc16803b) did NOT clear it →
  the flag is **tab-level memory**, not "is Stripe in the DOM right now".
- Stripe's card field is ALREADY in a cross-origin (js.stripe.com) iframe, yet the tab is flagged →
  an inline iframe (even on our own subdomain) will NOT help: the card field stays in the same tab.

## Fix: separate top-level browsing context (popup window)
Card entry happens in a **popup window** (`window.open`, a separate tab/context), not inline. The
main app tab then never contains a card field → iOS never flags its inputs. Anti-fraud (Radar)
stays fully ON — Stripe loads normally inside the popup; nothing is disabled.

Origin: try SAME-ORIGIN first (the flag is per browsing-context/tab, so a same-origin popup is a
different context and should be clean — no DNS needed). Make the popup URL origin configurable
(`VITE_CARD_ENTRY_ORIGIN`, default same-origin) so that IF device testing shows iOS caches per-
ORIGIN, we point it at a `pay.albusto.com` subdomain (GoDaddy DNS) with a one-value change.

## Architecture
- **Popup page** (`/card-entry`, served same-origin; a focused route that loads ONLY Stripe + the
  card field, not the whole app shell if avoidable): loads Stripe.js on the connected account,
  mounts the card Element, and drives the charge. It is the ONLY context that loads Stripe.js.
- **App (opener)**: never loads Stripe.js. Opens the popup, hands it the session over postMessage,
  listens for the result, refreshes finance on success.
- **postMessage protocol** (STRICT origin checks both directions):
  - opener→popup: `{ kind:'cardframe:init', clientSecret, accountId, amount, displayContext }`
    (sent only after the popup posts `cardframe:ready`).
  - popup→opener: `cardframe:ready`, `cardframe:card_change{complete}`, then the result
    `cardframe:result{status:'succeeded'|'requires_payment_method'|'failed', message?}` (Phase 1),
    or `cardframe:payment_method{pmId, brand, last4}` (Phase 2).
  - Each side validates `event.origin === expected` and ignores everything else. clientSecret is a
    single-use PI secret scoped to the connected account; same-origin postMessage transfer is safe.

## Phasing
- **P1 (prove the iOS fix, keep charging working):** move the existing manual-card charge into the
  popup. `ManualCardDialog` no longer mounts Stripe — it opens the popup, hands over the existing
  `manualCardSession` (clientSecret + account_id + amount), and the POPUP runs
  loadStripe→mountStripeCard→confirmCardPayment (3DS handled naturally there, since the popup has
  Stripe.js) and posts the result back. The dialog reconciles/refreshes exactly as today. Backend
  session creation + reconcile are UNCHANGED. Net: the CRM app tab loads no Stripe → #53 gone.
  DEPLOY → owner device-tests: open manual card entry (now a popup) → complete/cancel → the CRM
  card-bar must be gone.
- **P2 (owner's two-step UX + customer reuse):** the popup collects a PaymentMethod (not an
  immediate charge) and returns `{pmId, brand, last4}`; the payment form shows the masked card and
  a separate "Pay" button that charges SERVER-SIDE with the pmId (app tab still Stripe-free); 3DS
  that arises at Pay time re-opens the popup for the challenge. Same component reused on the public
  pay page (PublicInvoicePayPage — which also loads Stripe today) so the customer link flow matches.

## Security / guards
- App tab MUST NOT import/load Stripe.js after P1 (that is the whole point) — keep loadStripe out of
  the app bundle's card path; only the popup page loads it.
- postMessage origin validation both ways; ignore unexpected origins/message shapes.
- Popup blocked by the browser → show a clear fallback ("allow pop-ups" + the existing Copy/Send
  link options still work).
- No card PAN ever reaches our code (Stripe Elements in the popup); we only ever see pmId/last4.
- Company/tenant scoping on the backend session + charge is unchanged (already company-scoped).

## Verification
- P1: device test on the owner's iPhone (the only way to confirm the iOS bar) — CRM inputs clean
  after using card entry; a real/test card charge still succeeds through the popup; popup-blocked
  fallback works. Build clean; ManualCardDialog tests updated for the popup path.
- If same-origin popup still shows the bar → flip `VITE_CARD_ENTRY_ORIGIN` to `pay.albusto.com`
  (add GoDaddy A record → 108.61.87.117 + Caddy site) and retest.
