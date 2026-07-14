-- OUTBOUND-LEAD-CALL-001 rollback (order matters — lead rows must go BEFORE SET NOT NULL)
DELETE FROM outbound_call_attempts WHERE scenario = 'lead_call';
DROP INDEX IF EXISTS uq_outbound_call_attempts_active_lead;
DROP INDEX IF EXISTS idx_outbound_call_attempts_lead;
ALTER TABLE outbound_call_attempts DROP CONSTRAINT IF EXISTS chk_outbound_call_attempts_scope;
ALTER TABLE outbound_call_attempts DROP COLUMN IF EXISTS lead_uuid;
ALTER TABLE outbound_call_attempts DROP COLUMN IF EXISTS scenario;
ALTER TABLE outbound_call_attempts ALTER COLUMN job_id SET NOT NULL;
DROP TABLE IF EXISTS outbound_lead_call_settings;
