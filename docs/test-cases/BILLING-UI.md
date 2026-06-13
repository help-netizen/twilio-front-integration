# BILLING-UI — Test Cases
## P0 backend
- TC-01: GET /api/billing without tenant.company.manage → 403; no token → 401
- TC-02: bootstrapCompany starts a trial (startTrial called, idempotent)
- TC-03: webhook with invalid signature → 400; valid customer.subscription.updated → status updated + event emitted
- TC-04: webhook invoice.payment_failed → billing_invoices upsert + invoice.payment_failed event
- TC-05: checkout with no STRIPE price → 422 PROVIDER_NOT_CONFIGURED
- TC-06: getInvoices company-scoped (foreign company rows not returned)
- TC-07: usage caps resolved from plan.included_units with trial fallback
## P1 frontend (manual)
- TC-20: trial banner shows days-left; usage bars colored by threshold
- TC-21: upgrade button disabled in degraded mode
