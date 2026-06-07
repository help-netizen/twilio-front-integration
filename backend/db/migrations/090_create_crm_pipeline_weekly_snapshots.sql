-- =============================================================================
-- 090: Sales CRM pipeline weekly snapshots (CRM-SALES-MCP-004)
-- Optional baseline records for pipeline/forecast comparison. Current pipeline
-- truth remains crm_deals + crm_deal_history.
-- =============================================================================

CREATE TABLE IF NOT EXISTS crm_pipeline_weekly_snapshots (
    id                    BIGSERIAL PRIMARY KEY,
    company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    owner_user_id         UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    team_id               TEXT,
    period_start          DATE,
    period_end            DATE,
    snapshot_week_start   DATE NOT NULL,
    totals                JSONB NOT NULL DEFAULT '{}'::jsonb,
    by_stage              JSONB NOT NULL DEFAULT '[]'::jsonb,
    by_forecast_category  JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_pipeline_weekly_snapshots_lookup
    ON crm_pipeline_weekly_snapshots(
        company_id,
        created_at DESC,
        snapshot_week_start DESC,
        owner_user_id,
        team_id,
        period_start,
        period_end
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_pipeline_weekly_snapshots_scope
    ON crm_pipeline_weekly_snapshots(
        company_id,
        snapshot_week_start,
        COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(team_id, ''),
        COALESCE(period_start, '0001-01-01'::date),
        COALESCE(period_end, '0001-01-01'::date)
    );

COMMENT ON TABLE crm_pipeline_weekly_snapshots IS
    'Optional Sales CRM pipeline baseline snapshots for forecast analytics; current truth remains crm_deals and crm_deal_history.';
