-- Migration 269: authoritative Vapi usage reconciliation and immutable finals.
--
-- T4 polls the single platform Vapi account, but every monetary candidate remains
-- bound to one company/session tuple. These tables still contain supplier-side
-- evidence only: pricing, settlement and wallet writes are deliberately absent.

ALTER TABLE vapi_call_usage
    ADD COLUMN IF NOT EXISTS last_provider_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS authoritative_observation_id UUID,
    ADD COLUMN IF NOT EXISTS reconcile_source TEXT NOT NULL DEFAULT 'get_call',
    ADD COLUMN IF NOT EXISTS reconcile_claim_token UUID,
    ADD COLUMN IF NOT EXISTS reconcile_lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pending_correction_hash TEXT,
    ADD COLUMN IF NOT EXISTS pending_correction_observation_id UUID,
    ADD COLUMN IF NOT EXISTS pending_correction_first_seen_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_usage_reconcile_source'
          AND conrelid = 'vapi_call_usage'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage
            ADD CONSTRAINT chk_vapi_usage_reconcile_source
            CHECK (reconcile_source IN ('get_call', 'audit_repair'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_usage_authoritative_observation'
          AND conrelid = 'vapi_call_usage'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage
            ADD CONSTRAINT fk_vapi_usage_authoritative_observation
            FOREIGN KEY (authoritative_observation_id, company_id)
            REFERENCES vapi_call_usage_observations(id, company_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_usage_pending_correction_observation'
          AND conrelid = 'vapi_call_usage'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage
            ADD CONSTRAINT fk_vapi_usage_pending_correction_observation
            FOREIGN KEY (pending_correction_observation_id, company_id)
            REFERENCES vapi_call_usage_observations(id, company_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_usage_pending_correction_tuple'
          AND conrelid = 'vapi_call_usage'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage
            ADD CONSTRAINT chk_vapi_usage_pending_correction_tuple CHECK (
                (pending_correction_hash IS NULL
                 AND pending_correction_observation_id IS NULL
                 AND pending_correction_first_seen_at IS NULL)
                OR
                (pending_correction_hash IS NOT NULL
                 AND pending_correction_observation_id IS NOT NULL
                 AND pending_correction_first_seen_at IS NOT NULL)
            );
    END IF;
END $$;

UPDATE vapi_call_usage
SET next_reconcile_at = COALESCE(next_reconcile_at, first_pending_at + interval '1 minute')
WHERE state IN (
    'provisional', 'reconciling', 'stable_once', 'stale_pending', 'quarantined'
);

CREATE INDEX IF NOT EXISTS idx_vapi_call_usage_reconcile_due
    ON vapi_call_usage(company_id, next_reconcile_at, vapi_call_session_id)
    WHERE state IN (
        'provisional', 'reconciling', 'stable_once',
        'stale_pending', 'quarantined', 'final'
    );

CREATE TABLE IF NOT EXISTS vapi_call_usage_final_snapshots (
    company_id                      UUID NOT NULL,
    vapi_call_session_id            UUID NOT NULL,
    snapshot_version                INTEGER NOT NULL,
    observation_id                  UUID NOT NULL,
    snapshot_hash                   TEXT NOT NULL,
    supplier_cost                   NUMERIC(24,12) NOT NULL,
    normalized_breakdown            JSONB NOT NULL,
    ended_reason                    TEXT NOT NULL,
    duration_seconds                NUMERIC(18,6) NOT NULL,
    provider_updated_at             TIMESTAMPTZ NOT NULL,
    snapshot_kind                   TEXT NOT NULL,
    previous_snapshot_version       INTEGER,
    supplier_cost_delta             NUMERIC(24,12) NOT NULL,
    finalized_at                    TIMESTAMPTZ NOT NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vapi_call_session_id, snapshot_version),
    CONSTRAINT uq_vapi_final_snapshot_session_version_company
        UNIQUE (vapi_call_session_id, snapshot_version, company_id),
    CONSTRAINT fk_vapi_final_snapshot_session_company
        FOREIGN KEY (vapi_call_session_id, company_id)
        REFERENCES vapi_call_sessions(id, company_id),
    CONSTRAINT fk_vapi_final_snapshot_observation_company
        FOREIGN KEY (observation_id, company_id)
        REFERENCES vapi_call_usage_observations(id, company_id),
    CONSTRAINT chk_vapi_final_snapshot_version
        CHECK (snapshot_version > 0),
    CONSTRAINT chk_vapi_final_snapshot_kind
        CHECK (snapshot_kind IN ('initial', 'correction')),
    CONSTRAINT chk_vapi_final_snapshot_shape CHECK (
        (snapshot_kind = 'initial'
         AND snapshot_version = 1
         AND previous_snapshot_version IS NULL
         AND supplier_cost_delta = supplier_cost)
        OR
        (snapshot_kind = 'correction'
         AND snapshot_version > 1
         AND previous_snapshot_version = snapshot_version - 1)
    ),
    CONSTRAINT chk_vapi_final_snapshot_values CHECK (
        supplier_cost >= 0
        AND duration_seconds >= 0
        AND jsonb_typeof(normalized_breakdown) = 'object'
    )
);

CREATE TABLE IF NOT EXISTS vapi_call_usage_adjustments (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      UUID NOT NULL,
    vapi_call_session_id            UUID NOT NULL,
    from_snapshot_version           INTEGER NOT NULL,
    to_snapshot_version             INTEGER NOT NULL,
    supplier_cost_delta             NUMERIC(24,12) NOT NULL,
    state                           TEXT NOT NULL DEFAULT 'pending_pricing',
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_vapi_usage_adjustment_version
        UNIQUE (vapi_call_session_id, to_snapshot_version),
    CONSTRAINT fk_vapi_usage_adjustment_from_snapshot
        FOREIGN KEY (vapi_call_session_id, from_snapshot_version, company_id)
        REFERENCES vapi_call_usage_final_snapshots(
            vapi_call_session_id, snapshot_version, company_id
        ),
    CONSTRAINT fk_vapi_usage_adjustment_to_snapshot
        FOREIGN KEY (vapi_call_session_id, to_snapshot_version, company_id)
        REFERENCES vapi_call_usage_final_snapshots(
            vapi_call_session_id, snapshot_version, company_id
        ),
    CONSTRAINT chk_vapi_usage_adjustment_versions
        CHECK (from_snapshot_version > 0 AND to_snapshot_version = from_snapshot_version + 1),
    CONSTRAINT chk_vapi_usage_adjustment_state
        CHECK (state = 'pending_pricing')
);

CREATE OR REPLACE FUNCTION prevent_vapi_final_snapshot_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'VAPI_FINAL_SNAPSHOT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vapi_final_snapshot_immutable
    ON vapi_call_usage_final_snapshots;
CREATE TRIGGER trg_vapi_final_snapshot_immutable
    BEFORE UPDATE OR DELETE ON vapi_call_usage_final_snapshots
    FOR EACH ROW EXECUTE FUNCTION prevent_vapi_final_snapshot_mutation();

CREATE TABLE IF NOT EXISTS vapi_usage_audit_runs (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_date                      DATE NOT NULL UNIQUE,
    window_start                    TIMESTAMPTZ NOT NULL,
    window_end                      TIMESTAMPTZ NOT NULL,
    status                          TEXT NOT NULL DEFAULT 'running',
    claim_token                     UUID,
    lease_expires_at                TIMESTAMPTZ,
    pages_scanned                   INTEGER NOT NULL DEFAULT 0,
    provider_calls_scanned          INTEGER NOT NULL DEFAULT 0,
    orphan_count                    INTEGER NOT NULL DEFAULT 0,
    missing_count                   INTEGER NOT NULL DEFAULT 0,
    stuck_count                     INTEGER NOT NULL DEFAULT 0,
    repair_enqueued_count           INTEGER NOT NULL DEFAULT 0,
    sample_evidence                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error                      TEXT,
    started_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at                     TIMESTAMPTZ,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vapi_usage_audit_window CHECK (window_start < window_end),
    CONSTRAINT chk_vapi_usage_audit_status
        CHECK (status IN ('running', 'succeeded', 'failed')),
    CONSTRAINT chk_vapi_usage_audit_counts CHECK (
        pages_scanned >= 0 AND provider_calls_scanned >= 0
        AND orphan_count >= 0 AND missing_count >= 0
        AND stuck_count >= 0 AND repair_enqueued_count >= 0
    ),
    CONSTRAINT chk_vapi_usage_audit_samples
        CHECK (jsonb_typeof(sample_evidence) = 'object')
);

DROP TRIGGER IF EXISTS trg_vapi_usage_audit_runs_updated_at ON vapi_usage_audit_runs;
CREATE TRIGGER trg_vapi_usage_audit_runs_updated_at
    BEFORE UPDATE ON vapi_usage_audit_runs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS vapi_usage_alerts (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      UUID,
    vapi_call_session_id            UUID,
    audit_run_id                    UUID REFERENCES vapi_usage_audit_runs(id),
    kind                            TEXT NOT NULL,
    dedupe_key                      TEXT NOT NULL UNIQUE,
    details                         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at                     TIMESTAMPTZ,
    CONSTRAINT fk_vapi_usage_alert_session_company
        FOREIGN KEY (vapi_call_session_id, company_id)
        REFERENCES vapi_call_sessions(id, company_id),
    CONSTRAINT chk_vapi_usage_alert_scope CHECK (
        (vapi_call_session_id IS NULL)
        OR (company_id IS NOT NULL)
    ),
    CONSTRAINT chk_vapi_usage_alert_kind CHECK (kind IN (
        'stale_pending', 'late_correction_stale', 'provider_orphan',
        'local_missing', 'audit_incomplete', 'audit_failed'
    )),
    CONSTRAINT chk_vapi_usage_alert_details
        CHECK (jsonb_typeof(details) = 'object')
);

COMMENT ON TABLE vapi_call_usage_final_snapshots IS
    'Immutable authoritative supplier snapshots. One initial version plus append-only late corrections; no tenant price or wallet mutation.';
COMMENT ON TABLE vapi_call_usage_adjustments IS
    'Signed supplier-cost delta input for future T9 pricing; not a charge, settlement or wallet entry.';
COMMENT ON TABLE vapi_usage_audit_runs IS
    'Platform-only nightly reconciliation evidence and counters; never tenant-facing.';
COMMENT ON TABLE vapi_usage_alerts IS
    'Platform-only idempotent operational alerts; details must contain no provider payload or PII.';
