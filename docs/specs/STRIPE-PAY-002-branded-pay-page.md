# STRIPE-PAY-002 — Branded public payment page (technician + tips)

**Date:** 2026-06-16 · **Status:** Implemented (branch `feature/pay-page-custom`) · **Builds on:** F018

Customizes the public `/pay/:token` page so a customer sees a branded, trust-building
checkout: company thank-you, the technician who did the work (photo + name), the amount,
an optional tip, and an embedded Stripe Payment Element (card / Apple Pay / Google Pay)
— no redirect off-site.

## UX
1. Company name + thank-you ("Thank you for choosing {company}! {tech} took care of your service.").
2. Technician card — photo (uploaded) or initials avatar + name.
3. Invoice amount.
4. Tip selector — 15% / 18% / 20% presets, custom amount, or no tip; live total.
5. **Continue to payment** → embedded Stripe **Payment Element** → **Pay $total** → thank-you state.

## Data
- Technician name comes from `jobs.assigned_techs[0].name` via `invoice.job_id`.
- **`technician_profiles`** (migration 119): `(company_id, tech_id)` → uploadable `photo_storage_key`
  (S3/Tigris via `storageService`) + optional name override.

## Backend
- `technicianProfilesService` — list distinct techs from jobs, upload/replace photo,
  resolve `getTechnicianForInvoice` (name + presigned photo URL).
- `routes/technicians.js` — `GET /api/settings/technicians`, `POST /:techId/photo`
  (multipart, `tenant.company.manage`).
- `getPublicPayInfo` enriched with `company_name`, `thank_you`, `technician {name, photo_url}`.
- `POST /api/public/invoices/:token/pay-intent` — creates a PaymentIntent on the connected
  account for **balance + tip**, returns `client_secret` for the Payment Element.
- **Tip handling:** the charge = balance + tip. On webhook success, `applyStripePayment`
  records the **full** amount on the ledger row (with `metadata.tip`) but applies only the
  **balance** portion to the invoice — no overpayment; tips are reportable via metadata.

## Frontend
- `pages/PublicInvoicePayPage.tsx` — rebuilt branded page (tech card, thanks, tip selector,
  embedded Payment Element).
- `pages/TechnicianPhotosPage.tsx` + `services/techniciansApi.ts` — settings UI at
  `/settings/technicians` to upload per-technician photos.

## Tests / status
- `tests/stripePayments.test.js` 27/27 (added tip-split test: full charge to ledger,
  balance-only to invoice). Frontend `tsc -b` clean. Local: migration 119 auto-applies,
  `GET /api/settings/technicians` lists techs.
- **Live charge still requires Connect enabled** on the Stripe account (same F018 blocker).
- **Photo storage** uses the existing S3/Tigris `storageService`; presigned URLs on the
  public page (session-lived).
