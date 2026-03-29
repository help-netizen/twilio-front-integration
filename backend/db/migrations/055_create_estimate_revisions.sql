-- =============================================================================
-- Migration 055: Create estimate_revisions table (PF002)
-- Snapshot history for estimate changes
-- =============================================================================

CREATE TABLE IF NOT EXISTS estimate_revisions (
    id              BIGSERIAL PRIMARY KEY,
    estimate_id     BIGINT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL,
    snapshot        JSONB NOT NULL,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_estimate_revision UNIQUE (estimate_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_estimate_revisions_estimate ON estimate_revisions(estimate_id);

COMMENT ON TABLE estimate_revisions IS 'PF002: Immutable revision snapshots for estimates';
