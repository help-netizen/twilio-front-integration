-- Migration 092: F017 call flows use one active graph per group.
-- The status column remains for compatibility, but draft/published are no
-- longer public states for telephony call flows.

ALTER TABLE call_flows
  ALTER COLUMN status SET DEFAULT 'active';

UPDATE call_flows
SET status = 'active'
WHERE status IS DISTINCT FROM 'active';
