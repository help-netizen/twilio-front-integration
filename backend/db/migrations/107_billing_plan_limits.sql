-- 107: BILLING — finalize plan pricing/bundles + hard phone-number caps.
-- Plans bundle usage into a flat price (no usage packages). Recording is
-- included on all tiers. max_phone_numbers is a HARD cap enforced at buy time.
-- included_units / metered use the metric keys sms | call_minutes | agent_runs.

ALTER TABLE billing_plans ADD COLUMN IF NOT EXISTS max_phone_numbers INTEGER;

-- Top tier (new)
INSERT INTO billing_plans
    (id, name, monthly_base_usd, included_seats, per_seat_usd, metered, included_units, max_phone_numbers, is_active)
VALUES
    ('huge', 'Huge', 289, 20, 10,
     '{"sms":0.012,"call_minutes":0.02,"agent_runs":0.06}',
     '{"sms":6000,"call_minutes":6000,"agent_runs":20000}', 20, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    monthly_base_usd = EXCLUDED.monthly_base_usd,
    included_seats = EXCLUDED.included_seats,
    per_seat_usd = EXCLUDED.per_seat_usd,
    metered = EXCLUDED.metered,
    included_units = EXCLUDED.included_units,
    max_phone_numbers = EXCLUDED.max_phone_numbers,
    is_active = true;

-- Starter $49 — 3 numbers, 1,000 min, 1,500 SMS (recording included)
UPDATE billing_plans SET
    monthly_base_usd = 49,
    metered = '{"sms":0.02,"call_minutes":0.03,"agent_runs":0.10}',
    included_units = '{"sms":1500,"call_minutes":1000,"agent_runs":2000}',
    max_phone_numbers = 3
WHERE id = 'starter';

-- Pro $149 — 10 numbers, 3,000 min, 3,000 SMS (recording included)
UPDATE billing_plans SET
    monthly_base_usd = 149,
    metered = '{"sms":0.015,"call_minutes":0.025,"agent_runs":0.08}',
    included_units = '{"sms":3000,"call_minutes":3000,"agent_runs":10000}',
    max_phone_numbers = 10
WHERE id = 'pro';

-- Trial — a single number so trials can't hoard inventory
UPDATE billing_plans SET max_phone_numbers = 1 WHERE id = 'trial';
