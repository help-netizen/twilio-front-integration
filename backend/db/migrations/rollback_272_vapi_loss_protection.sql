-- Rollback 272. Never silently discard sent-delivery evidence or fallback
-- pricing inputs that may already be referenced by a later pricing phase.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM vapi_call_cost_input_events)
       OR EXISTS (SELECT 1 FROM vapi_usage_alert_delivery_runs) THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_272_ROLLBACK_BLOCKED: preserve loss-protection evidence first';
    END IF;
END $$;

ALTER TABLE vapi_usage_alerts
    DROP COLUMN IF EXISTS last_delivery_run_id;

DROP TABLE IF EXISTS vapi_usage_alert_delivery_items;
DROP TABLE IF EXISTS vapi_usage_alert_delivery_runs;
DROP TRIGGER IF EXISTS trg_vapi_cost_input_immutable
    ON vapi_call_cost_input_events;
DROP TABLE IF EXISTS vapi_call_cost_input_events;
DROP FUNCTION IF EXISTS prevent_vapi_cost_input_mutation();
DROP TABLE IF EXISTS vapi_fallback_rate_policies;

DROP INDEX IF EXISTS idx_vapi_usage_alerts_delivery_pending;

ALTER TABLE vapi_usage_alerts
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_alert_kind,
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_alert_cost,
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_alert_cost_basis;

UPDATE vapi_usage_alerts
SET kind = CASE
        WHEN kind IN (
            'assistant_mismatch', 'attempt_mismatch', 'provider_call_collision'
        ) THEN 'usage_ingest_rejected'
        WHEN kind = 'quarantined' THEN 'provider_message_quarantined'
        ELSE kind
    END;

ALTER TABLE vapi_usage_alerts
    DROP COLUMN IF EXISTS last_delivered_fingerprint,
    DROP COLUMN IF EXISTS last_delivered_at,
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS cost_basis,
    DROP COLUMN IF EXISTS supplier_cost_at_risk,
    DROP COLUMN IF EXISTS provider_call_id;

ALTER TABLE vapi_usage_alerts
    ADD CONSTRAINT chk_vapi_usage_alert_kind CHECK (kind IN (
        'stale_pending', 'late_correction_stale', 'provider_orphan',
        'local_missing', 'audit_incomplete', 'audit_failed',
        'provider_message_quarantined', 'usage_ingest_rejected'
    ));
