-- Migration 270: durable quarantine for authenticated Vapi messages that fail
-- identity/correlation contracts before a call-usage observation can exist.

CREATE TABLE IF NOT EXISTS vapi_provider_message_quarantine (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      UUID NOT NULL REFERENCES companies(id),
    status_credential_id            BIGINT NOT NULL,
    payload_hash                    TEXT NOT NULL,
    provider_call_id                TEXT,
    claimed_message_type            TEXT,
    validation_error                TEXT NOT NULL,
    sanitized_payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
    delivery_count                  INTEGER NOT NULL DEFAULT 1,
    first_seen_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_vapi_provider_quarantine_credential
        FOREIGN KEY (status_credential_id, company_id)
        REFERENCES api_integrations(id, company_id),
    CONSTRAINT chk_vapi_provider_quarantine_payload
        CHECK (jsonb_typeof(sanitized_payload) = 'object'),
    CONSTRAINT chk_vapi_provider_quarantine_delivery_count
        CHECK (delivery_count > 0),
    CONSTRAINT uq_vapi_provider_quarantine_delivery
        UNIQUE (company_id, status_credential_id, payload_hash)
);

ALTER TABLE vapi_usage_alerts
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_alert_kind;
ALTER TABLE vapi_usage_alerts
    ADD CONSTRAINT chk_vapi_usage_alert_kind CHECK (kind IN (
        'stale_pending', 'late_correction_stale', 'provider_orphan',
        'local_missing', 'audit_incomplete', 'audit_failed',
        'provider_message_quarantined', 'usage_ingest_rejected'
    ));

COMMENT ON TABLE vapi_provider_message_quarantine IS
    'Platform-only, company-scoped evidence for authenticated Vapi messages rejected before durable call correlation. Payload is allowlisted and PII-free.';
