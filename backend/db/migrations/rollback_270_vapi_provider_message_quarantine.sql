-- Rollback migration 270. Refuse to erase operational evidence.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM vapi_provider_message_quarantine LIMIT 1)
       OR EXISTS (
           SELECT 1
           FROM vapi_usage_alerts
           WHERE kind IN ('provider_message_quarantined', 'usage_ingest_rejected')
           LIMIT 1
       ) THEN
        RAISE EXCEPTION
            'rollback 270 refused: Vapi provider quarantine evidence exists';
    END IF;
END $$;

DROP TABLE IF EXISTS vapi_provider_message_quarantine;

ALTER TABLE vapi_usage_alerts
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_alert_kind;
ALTER TABLE vapi_usage_alerts
    ADD CONSTRAINT chk_vapi_usage_alert_kind CHECK (kind IN (
        'stale_pending', 'late_correction_stale', 'provider_orphan',
        'local_missing', 'audit_incomplete', 'audit_failed'
    ));
