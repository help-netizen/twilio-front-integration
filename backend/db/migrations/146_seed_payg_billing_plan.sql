-- =============================================================================
-- Migration 146: Seed the "Pay as you go" billing plan (ONBTEL-001 Part B).
-- $0/mo, zero included units — ALL usage is billed at the metered rates by the
-- existing pipeline (recordUsage → computeOverage → billOverage → wallet debit
-- via overageScheduler). No new billing mechanics. max_phone_numbers=1 is the
-- hard cap enforced at buy time (422 NUMBER_LIMIT → package-plan upsell).
-- provider_price_id stays NULL — Stripe checkout is never used for payg
-- (billingService.subscribe activates any plan with monthly_base_usd <= 0
-- directly, before the providerConfigured() check).
-- included_seats 3 / per_seat_usd 0 mirror trial; seats are not billed by the
-- wallet billPlanFee — decorative, not a blocker.
-- Idempotent: ON CONFLICT (id) DO UPDATE (style of migration 107).
-- =============================================================================

INSERT INTO billing_plans
    (id, name, monthly_base_usd, included_seats, per_seat_usd, metered, included_units, max_phone_numbers, provider_price_id, is_active)
VALUES
    ('payg', 'Pay as you go', 0, 3, 0,
     '{"sms":0.03,"call_minutes":0.04,"agent_runs":0}',
     '{"sms":0,"call_minutes":0,"agent_runs":0}',
     1, NULL, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    monthly_base_usd = EXCLUDED.monthly_base_usd,
    included_seats = EXCLUDED.included_seats,
    per_seat_usd = EXCLUDED.per_seat_usd,
    metered = EXCLUDED.metered,
    included_units = EXCLUDED.included_units,
    max_phone_numbers = EXCLUDED.max_phone_numbers,
    provider_price_id = EXCLUDED.provider_price_id,
    is_active = true;
