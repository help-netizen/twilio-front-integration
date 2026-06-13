-- ============================================================================
-- 103: BILLING-UI — per-plan included usage allowances for the cabinet UI.
-- The usage bars need a human-meaningful cap per metric (sms / call_minutes /
-- agent_runs). `metered` holds per-unit overage prices; `included_units` holds
-- the allowance that the bar fills against. Idempotent.
-- ============================================================================

ALTER TABLE billing_plans
    ADD COLUMN IF NOT EXISTS included_units JSONB NOT NULL DEFAULT '{}';

-- Backfill allowances for the seeded plans (only when still empty).
UPDATE billing_plans SET included_units = '{"sms":500,"call_minutes":1000,"agent_runs":100}'
    WHERE id = 'trial'   AND included_units = '{}';
UPDATE billing_plans SET included_units = '{"sms":2000,"call_minutes":3000,"agent_runs":500}'
    WHERE id = 'starter' AND included_units = '{}';
UPDATE billing_plans SET included_units = '{"sms":8000,"call_minutes":12000,"agent_runs":2500}'
    WHERE id = 'pro'     AND included_units = '{}';
