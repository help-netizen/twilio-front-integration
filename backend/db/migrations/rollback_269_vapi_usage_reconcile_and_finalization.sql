-- Rollback 269. Never silently discard authoritative supplier evidence.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM vapi_call_usage_final_snapshots)
       OR EXISTS (SELECT 1 FROM vapi_call_usage_adjustments)
       OR EXISTS (SELECT 1 FROM vapi_usage_audit_runs)
       OR EXISTS (SELECT 1 FROM vapi_usage_alerts)
       OR EXISTS (
           SELECT 1 FROM vapi_call_usage
           WHERE authoritative_observation_id IS NOT NULL
              OR reconcile_claim_token IS NOT NULL
              OR pending_correction_hash IS NOT NULL
       ) THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_269_ROLLBACK_BLOCKED: preserve T4 reconciliation evidence first';
    END IF;
END $$;

DROP TABLE IF EXISTS vapi_usage_alerts;
DROP TABLE IF EXISTS vapi_usage_audit_runs;
DROP TABLE IF EXISTS vapi_call_usage_adjustments;
DROP TABLE IF EXISTS vapi_call_usage_final_snapshots;
DROP FUNCTION IF EXISTS prevent_vapi_final_snapshot_mutation();

DROP INDEX IF EXISTS idx_vapi_call_usage_reconcile_due;

ALTER TABLE vapi_call_usage
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_reconcile_source,
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_pending_correction_tuple,
    DROP CONSTRAINT IF EXISTS fk_vapi_usage_pending_correction_observation,
    DROP CONSTRAINT IF EXISTS fk_vapi_usage_authoritative_observation,
    DROP COLUMN IF EXISTS pending_correction_first_seen_at,
    DROP COLUMN IF EXISTS pending_correction_observation_id,
    DROP COLUMN IF EXISTS pending_correction_hash,
    DROP COLUMN IF EXISTS reconcile_lease_expires_at,
    DROP COLUMN IF EXISTS reconcile_claim_token,
    DROP COLUMN IF EXISTS authoritative_observation_id,
    DROP COLUMN IF EXISTS reconcile_source,
    DROP COLUMN IF EXISTS last_provider_updated_at;
