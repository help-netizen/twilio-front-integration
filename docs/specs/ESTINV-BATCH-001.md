# ESTINV-BATCH-001 — estimate/invoice editor batch (OB-23…OB-31)

**Status:** Implemented (master, not deployed). ⚠️ Deploy order: apply **migration 197**
BEFORE the app image (the void endpoint reads the new columns).
**Division (owner directive):** all frontend/UX/markup — Claude; backend + tests — Codex.
**Mirror rule (owner, standing):** every estimate-editor fix applies to the invoice
editor and both detail panels.

## What shipped (per OB)

- **OB-23** — price-book combobox: outside-click listener moved to CAPTURE phase +
  `isConnected` guard (a category click re-renders the list, detaching the clicked row —
  bubble-phase `contains()` misread it as an outside click and closed the dropdown);
  input reopens on plain click (it never blurs, so `onFocus` alone couldn't reopen).
  `ItemPresetSearchCombobox.tsx` (shared by estimates + invoices).
- **OB-24** — totals block: discount row wraps (`flex-wrap`) so the red amount can't
  overflow the panel; **native number spinners banned app-wide**
  (`design-system.css`); tax-rate fields are manual decimal with a `%` suffix; new
  line items default `taxable: true` (price-book picks keep their catalog default —
  labor may legitimately be non-taxable). **MoneyInput canon** (`ui/MoneyInput.tsx`):
  calculator-style cents-first mask (1→0.01→0.15→1.52), applied to unit price,
  fixed-discount, offline-payment amount (invoice panel popover), Record payment and
  Collect payment dialogs (`maskMoneyDigits` call-site variant keeps FloatingField).
- **OB-25** — `ui/AutoGrowTextarea.tsx`: item descriptions grow with content
  (min `rows`, cap `maxRows=10`, then scroll). Both editors.
- **OB-26** — estimate editor is single-column (form-canon width `max-w-[740px]`);
  the 320px aside and the "Document settings" card are gone; Require signature +
  Deposit required are flat rows between Totals and Terms & Warranty.
- **OB-27** — `EstimateDetailPanel` hydrates the full estimate when the caller passes
  a list row without `items` (port of INVOICE-ITEMS-HYDRATE-001); "Loading items…"
  while hydrating; Send/Approve no longer falsely blocked. Prod probe confirmed the
  data was always intact (estimates #54–58 all had item rows).
- **OB-28** — detail panels' Summary matches the editor: dashed invite block when
  empty, collapsible card when filled (estimate + invoice).
- **OB-29** — Preview PDF: prod logs showed requests arriving with no backend error
  (Codex also characterized the endpoint healthy: 200 + valid PDF incl. null-field
  edge cases); root = blocked popup (the old post-await `window.open` fallback is
  always gesture-less). `openAuthedPdf` now degrades to an anchor **download** with a
  real filename (`ESTIMATE L-1516-2.pdf`) — the button always produces a visible result.
- **OB-30** — backend `recalculateInvoiceTotals` (`invoicesQueries.js:508`): tax =
  `ROUND(GREATEST(taxable_subtotal − discount_amount, 0) × tax_rate/100, 2)` — was
  `item_total × rate` (ignored both the discount and the per-item taxable flag), so
  saved totals diverged from the editors' correct preview. Estimates were already
  correct; the conversion path is consistent. Historical invoices are NOT backfilled
  (paid/sent docs must not silently change); they self-heal on the next recalc.
- **OB-31** — void for manually recorded payments. Canonical table
  `payment_transactions` + **migration 197** (`voided_at`, `voided_by` FK,
  partial-unique backfill of legacy `invoice_events` offline payments into the
  ledger — totals unchanged). `POST /api/invoices/:invoiceId/payments/:paymentId/void`
  — company-scoped, `payments.collect_offline`, manual-origin only (Stripe/ZB → 409,
  `external_source` authoritative), idempotent (repeat → 200 `idempotent:true`),
  audited (`actor_id = crmUser.id`). Voided rows are excluded from
  amount_paid/balance_due/job-finance/analytics sums; a fully-paid invoice reopens
  (`sent`/`partial`). UI: voided rows stay in the list — grayed, `· Voided`,
  struck-through amount, sorted last; manual rows get a Ban action with a center
  confirm modal.

## Tenancy & Roles

- New void endpoint: `authenticate` + company scope from `req.companyFilter`;
  permission `payments.collect_offline` (tenant_admin/manager/provider; dispatcher
  denied). Foreign-company payment → 404, row byte-unchanged (T-blast tested).
- All other changes are presentation-layer or column-additive; no scope changes.

## Verification (executed; team lead re-ran every command independently)

```bash
# backend — batch suites (my final run: 20/20)
node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/estinvBatchTotals.db.test.js tests/invoicePaymentVoid.db.test.js tests/invoicePaymentVoid.routes.test.js tests/estimatePdfRoute.test.js --testPathIgnorePatterns "/node_modules/" --runInBand --forceExit
# backend — Codex's regression sweeps: 6 suites/24 tests (totals+pdf), 12 suites/200 tests (payments/RBAC/analytics)
# frontend
cd frontend && npm run build   # clean, noUnusedLocals
cd frontend && npm test        # 51 files / 281 tests
```

- OB-30 red-before/green-after: pre-fix db run 3 failed / 1 passed → post-fix 4/4.
- Sabotage (each break → red → exact restore → green):
  - `SAB-ESTINV-PREDISCOUNT` (drop discount from tax base) → 3 failed.
  - `SAB-ESTINV-ALLITEMS` (sum all items, not taxable-only) → 3 failed.
  - `CTRL-VOID-ORIGIN` (drop manual-origin guard) → 2 failed (Stripe+ZB voided).
  - `CTRL-VOID-TENANT` (drop company predicates) → T-blast red (foreign row crossed).

## Debt / follow-ups

- OB-29: if a blocked-popup environment still misbehaves, capture the browser
  Network entry — backend is characterized healthy.
- Component-level Vitest for MoneyInput mask is not added (mask logic is pure and
  exercised via build + manual runs); candidate for a quick unit if it ever regresses.
