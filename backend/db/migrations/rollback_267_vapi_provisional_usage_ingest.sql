-- Rollback 267. Refuse to discard captured T3 evidence or its projection link.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM vapi_call_usage_observations)
       OR EXISTS (SELECT 1 FROM vapi_call_usage) THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_267_ROLLBACK_BLOCKED: preserve/project provisional usage evidence first';
    END IF;
END $$;

ALTER TABLE vapi_call_usage
    DROP CONSTRAINT IF EXISTS fk_vapi_call_usage_provisional_observation,
    DROP COLUMN IF EXISTS provisional_updated_at,
    DROP COLUMN IF EXISTS provisional_observation_id;

-- Later reconciliation migrations reuse the composite observation key. A
-- direct rollback of 267 must release those dependencies explicitly; CASCADE
-- would hide which monetary links were removed.
ALTER TABLE vapi_call_usage
    DROP CONSTRAINT IF EXISTS fk_vapi_usage_authoritative_observation,
    DROP CONSTRAINT IF EXISTS fk_vapi_usage_pending_correction_observation;

ALTER TABLE IF EXISTS vapi_call_usage_final_snapshots
    DROP CONSTRAINT IF EXISTS fk_vapi_final_snapshot_observation_company;

DROP INDEX IF EXISTS uq_vapi_usage_observations_id_company;

ALTER TABLE vapi_call_usage_observations
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_observation_sanitized_payload,
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_observation_provider_status,
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_observation_call_type,
    DROP CONSTRAINT IF EXISTS fk_vapi_usage_observation_status_credential,
    DROP COLUMN IF EXISTS sanitized_payload,
    DROP COLUMN IF EXISTS provider_status,
    DROP COLUMN IF EXISTS call_type,
    DROP COLUMN IF EXISTS assistant_id,
    DROP COLUMN IF EXISTS status_credential_id;
