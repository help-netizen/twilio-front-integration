-- Migration 272: make Vapi monetary-risk alerts deliverable and add an
-- append-only fallback cost basis for calls whose supplier price never settles.

ALTER TABLE vapi_usage_alerts
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_alert_kind,
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_alert_cost,
    DROP CONSTRAINT IF EXISTS chk_vapi_usage_alert_cost_basis;

UPDATE vapi_usage_alerts
SET details = details || jsonb_build_object('legacyKind', kind),
    kind = CASE
        WHEN kind = 'usage_ingest_rejected'
             AND details->>'validationError' = 'correlation:assistant_mismatch'
            THEN 'assistant_mismatch'
        WHEN kind = 'usage_ingest_rejected'
             AND details->>'validationError' = 'correlation:attempt_mismatch'
            THEN 'attempt_mismatch'
        WHEN kind = 'usage_ingest_rejected'
             AND details->>'validationError' = 'correlation:provider_call_collision'
            THEN 'provider_call_collision'
        WHEN kind IN (
            'provider_message_quarantined', 'usage_ingest_rejected',
            'audit_incomplete', 'audit_failed'
        ) THEN 'quarantined'
        ELSE kind
    END
WHERE kind IN (
    'provider_message_quarantined', 'usage_ingest_rejected',
    'audit_incomplete', 'audit_failed'
);

ALTER TABLE vapi_usage_alerts
    ADD COLUMN IF NOT EXISTS provider_call_id TEXT,
    ADD COLUMN IF NOT EXISTS supplier_cost_at_risk NUMERIC(24,12),
    ADD COLUMN IF NOT EXISTS cost_basis TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS last_delivered_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_delivered_fingerprint TEXT;

UPDATE vapi_usage_alerts
SET provider_call_id = NULLIF(details->>'providerCallId', '')
WHERE provider_call_id IS NULL;

ALTER TABLE vapi_usage_alerts
    ADD CONSTRAINT chk_vapi_usage_alert_kind CHECK (kind IN (
        'provider_orphan', 'stale_pending', 'local_missing', 'quarantined',
        'late_correction_stale', 'assistant_mismatch', 'attempt_mismatch',
        'provider_call_collision'
    )),
    ADD CONSTRAINT chk_vapi_usage_alert_cost CHECK (
        supplier_cost_at_risk IS NULL OR supplier_cost_at_risk >= 0
    ),
    ADD CONSTRAINT chk_vapi_usage_alert_cost_basis CHECK (
        cost_basis IN ('supplier', 'fallback_estimate', 'unknown')
        AND (
            (supplier_cost_at_risk IS NULL AND cost_basis = 'unknown')
            OR (supplier_cost_at_risk IS NOT NULL AND cost_basis <> 'unknown')
        )
    );

CREATE INDEX IF NOT EXISTS idx_vapi_usage_alerts_delivery_pending
    ON vapi_usage_alerts(created_at, id)
    WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS vapi_fallback_rate_policies (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version                         BIGSERIAL NOT NULL UNIQUE,
    rate_per_started_minute         NUMERIC(24,12) NOT NULL,
    effective_from                  TIMESTAMPTZ NOT NULL,
    effective_to                    TIMESTAMPTZ,
    source                          TEXT NOT NULL DEFAULT 'runtime_config',
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vapi_fallback_rate_positive
        CHECK (rate_per_started_minute > 0),
    CONSTRAINT chk_vapi_fallback_rate_window
        CHECK (effective_to IS NULL OR effective_from < effective_to),
    CONSTRAINT chk_vapi_fallback_rate_source
        CHECK (source IN ('migration_default', 'runtime_config'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_fallback_rate_open
    ON vapi_fallback_rate_policies((true))
    WHERE effective_to IS NULL;

INSERT INTO vapi_fallback_rate_policies (
    rate_per_started_minute, effective_from, source
) VALUES (0.25, '-infinity', 'migration_default')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS vapi_call_cost_input_events (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      UUID NOT NULL,
    vapi_call_session_id            UUID NOT NULL,
    input_version                   INTEGER NOT NULL,
    event_kind                      TEXT NOT NULL,
    fallback_rate_policy_id         UUID NOT NULL
        REFERENCES vapi_fallback_rate_policies(id),
    supplier_snapshot_version       INTEGER,
    duration_seconds                NUMERIC(18,6) NOT NULL,
    billed_started_minutes          BIGINT NOT NULL,
    rate_per_started_minute         NUMERIC(24,12) NOT NULL,
    amount_delta                    NUMERIC(24,12) NOT NULL,
    effective_supplier_cost         NUMERIC(24,12) NOT NULL,
    is_estimate                     BOOLEAN NOT NULL,
    state                           TEXT NOT NULL DEFAULT 'pending_pricing',
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_vapi_cost_input_session_version
        UNIQUE (vapi_call_session_id, input_version),
    CONSTRAINT uq_vapi_cost_input_session_kind_snapshot
        UNIQUE (vapi_call_session_id, event_kind, supplier_snapshot_version),
    CONSTRAINT fk_vapi_cost_input_session_company
        FOREIGN KEY (vapi_call_session_id, company_id)
        REFERENCES vapi_call_sessions(id, company_id),
    CONSTRAINT fk_vapi_cost_input_supplier_snapshot
        FOREIGN KEY (vapi_call_session_id, supplier_snapshot_version, company_id)
        REFERENCES vapi_call_usage_final_snapshots(
            vapi_call_session_id, snapshot_version, company_id
        ),
    CONSTRAINT chk_vapi_cost_input_version CHECK (input_version > 0),
    CONSTRAINT chk_vapi_cost_input_kind
        CHECK (event_kind IN ('fallback_estimate', 'supplier_actual_correction')),
    CONSTRAINT chk_vapi_cost_input_values CHECK (
        duration_seconds >= 0
        AND billed_started_minutes >= 1
        AND rate_per_started_minute > 0
        AND effective_supplier_cost >= 0
        AND state = 'pending_pricing'
    ),
    CONSTRAINT chk_vapi_cost_input_shape CHECK (
        (event_kind = 'fallback_estimate'
         AND input_version = 1
         AND supplier_snapshot_version IS NULL
         AND is_estimate = true
         AND amount_delta = effective_supplier_cost)
        OR
        (event_kind = 'supplier_actual_correction'
         AND input_version = supplier_snapshot_version + 1
         AND supplier_snapshot_version IS NOT NULL
         AND is_estimate = false)
    )
);

CREATE INDEX IF NOT EXISTS idx_vapi_cost_input_company_pending
    ON vapi_call_cost_input_events(company_id, state, created_at);

CREATE OR REPLACE FUNCTION prevent_vapi_cost_input_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'VAPI_COST_INPUT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vapi_cost_input_immutable
    ON vapi_call_cost_input_events;
CREATE TRIGGER trg_vapi_cost_input_immutable
    BEFORE UPDATE OR DELETE ON vapi_call_cost_input_events
    FOR EACH ROW EXECUTE FUNCTION prevent_vapi_cost_input_mutation();

CREATE TABLE IF NOT EXISTS vapi_usage_alert_delivery_runs (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_fingerprint             TEXT NOT NULL UNIQUE,
    reason                          TEXT NOT NULL,
    window_start                    TIMESTAMPTZ NOT NULL,
    window_end                      TIMESTAMPTZ NOT NULL,
    supplier_cost_at_risk           NUMERIC(24,12) NOT NULL,
    estimated_cost_at_risk          NUMERIC(24,12) NOT NULL,
    alert_count                     INTEGER NOT NULL,
    unknown_cost_count              INTEGER NOT NULL,
    threshold_amount                NUMERIC(24,12) NOT NULL,
    recipient                       TEXT NOT NULL,
    status                          TEXT NOT NULL DEFAULT 'sending',
    claim_token                     UUID,
    lease_expires_at                TIMESTAMPTZ,
    attempt_count                   INTEGER NOT NULL DEFAULT 1,
    last_error                      TEXT,
    started_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at                         TIMESTAMPTZ,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vapi_alert_delivery_reason
        CHECK (reason IN ('digest', 'threshold')),
    CONSTRAINT chk_vapi_alert_delivery_status
        CHECK (status IN ('sending', 'sent', 'failed')),
    CONSTRAINT chk_vapi_alert_delivery_money CHECK (
        supplier_cost_at_risk >= 0
        AND estimated_cost_at_risk >= 0
        AND estimated_cost_at_risk <= supplier_cost_at_risk
        AND threshold_amount > 0
    ),
    CONSTRAINT chk_vapi_alert_delivery_counts CHECK (
        alert_count > 0 AND unknown_cost_count >= 0
    ),
    CONSTRAINT chk_vapi_alert_delivery_window CHECK (window_start <= window_end)
);

CREATE TABLE IF NOT EXISTS vapi_usage_alert_delivery_items (
    delivery_run_id                 UUID NOT NULL
        REFERENCES vapi_usage_alert_delivery_runs(id),
    alert_id                        UUID NOT NULL REFERENCES vapi_usage_alerts(id),
    alert_fingerprint               TEXT NOT NULL,
    supplier_cost_at_risk           NUMERIC(24,12),
    cost_basis                      TEXT NOT NULL,
    PRIMARY KEY (delivery_run_id, alert_id),
    CONSTRAINT chk_vapi_alert_delivery_item_cost CHECK (
        supplier_cost_at_risk IS NULL OR supplier_cost_at_risk >= 0
    ),
    CONSTRAINT chk_vapi_alert_delivery_item_basis CHECK (
        cost_basis IN ('supplier', 'fallback_estimate', 'unknown')
        AND (
            (supplier_cost_at_risk IS NULL AND cost_basis = 'unknown')
            OR (supplier_cost_at_risk IS NOT NULL AND cost_basis <> 'unknown')
        )
    )
);

ALTER TABLE vapi_usage_alerts
    ADD COLUMN IF NOT EXISTS last_delivery_run_id UUID
        REFERENCES vapi_usage_alert_delivery_runs(id);

COMMENT ON TABLE vapi_call_cost_input_events IS
    'Append-only pricing inputs used only when supplier cost was unavailable: one fallback estimate followed by signed supplier corrections. Never a wallet write.';
COMMENT ON TABLE vapi_usage_alert_delivery_runs IS
    'Platform-only monetary-risk digest attempts. A stable content fingerprint suppresses repeated email for unchanged unresolved alerts.';
COMMENT ON COLUMN vapi_usage_alerts.supplier_cost_at_risk IS
    'Exact known exposure for this alert when the writer has it; NULL means unknown, never zero-by-assumption.';
