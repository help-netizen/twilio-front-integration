# BILLING-UI — Spec

## API (tenant.company.manage unless noted)
- GET /api/billing → { subscription:{plan_name,status,trial_ends_at,current_period_end,seats}, usage:{sms,call_minutes,agent_runs}, plans:[{id,name,monthly_base_usd,included_units}], invoices:[{date,amount,status,hosted_url}] }
- POST /api/billing/checkout {plan_id} → { url } (Stripe Checkout) or 422 if no price configured
- GET /api/billing/invoices → { invoices:[…] } (company-scoped, last 24)
- POST /api/billing/webhook (NO AUTH, raw body): Stripe-Signature verified → updates billing_subscriptions/billing_invoices + emits domain events. 400 on bad signature.

## Trial start
- bootstrapCompany → after company row created, call billingService.startTrial(companyId, 'trial') (ON CONFLICT DO NOTHING). Non-blocking; failure logged, not fatal.

## Usage bars
- For each metric: quantity from billing_usage_records (current period), cap from plan.included_units[metric] (fallback trial caps: sms 500, call_minutes 1000, agent_runs 100). Percent = min(100, qty/cap*100). Color: <80 green, 80-100 amber, >100 red (over-limit shows qty>cap).

## Degraded mode (no STRIPE_SECRET_KEY)
- Checkout returns 422 PROVIDER_NOT_CONFIGURED; UI disables Upgrade buttons with tooltip "Billing not enabled yet". Status/usage/invoices still render.

## Error contracts
- 401/403 RBAC; 422 invalid plan / provider not configured; 400 bad webhook signature.

## Edge cases
- Company with no subscription row → treat as no trial (UI shows "Start" CTA, calls startTrial via GET side-effect? NO — startTrial only at bootstrap; show plans).
- Webhook for unknown customer → ignored (200, logged).
- Invoice list empty → "No invoices yet".
