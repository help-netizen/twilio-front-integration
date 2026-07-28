-- =============================================================================
-- Migration 213: LEAD-CHANNEL-ANALYTICS-001 Chunk 1b, Phase A
--
-- Tenant-owned Google Ads connection state and connector-neutral daily
-- performance facts. The google_ads lead-source channel is deliberately NOT
-- blanket-seeded: googleAdsConnectionService creates it only when a company
-- connects.
-- =============================================================================

CREATE TABLE IF NOT EXISTS google_ads_connections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL UNIQUE
                                REFERENCES companies(id) ON DELETE CASCADE,
    channel_id              UUID NOT NULL,
    customer_id             TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    status                  TEXT NOT NULL DEFAULT 'disconnected'
                                CHECK (status IN (
                                    'connected',
                                    'reconnect_required',
                                    'disconnected'
                                )),
    last_sync_status        TEXT DEFAULT 'pending',
    synced_from_date        DATE,
    synced_through_date     DATE,
    last_sync_started_at    TIMESTAMPTZ,
    last_sync_finished_at   TIMESTAMPTZ,
    last_synced_at          TIMESTAMPTZ,
    sync_lease_expires_at   TIMESTAMPTZ,
    last_error_code         TEXT,
    last_error              TEXT,
    account_timezone        TEXT,
    currency_code           TEXT,
    created_by              UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by              UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT google_ads_connections_company_id_id_unique
        UNIQUE (company_id, id),
    CONSTRAINT google_ads_connections_company_channel_fk
        FOREIGN KEY (company_id, channel_id)
        REFERENCES lead_source_channels(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT google_ads_connections_customer_digits
        CHECK (customer_id ~ '^[0-9]+$')
);

CREATE INDEX IF NOT EXISTS idx_google_ads_connections_due
    ON google_ads_connections(status, last_sync_status, last_synced_at);

CREATE TABLE IF NOT EXISTS lead_source_performance_daily (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    provider_key            TEXT NOT NULL DEFAULT 'google_ads',
    external_account_id     TEXT NOT NULL,
    external_campaign_id    TEXT NOT NULL,
    external_campaign_name  TEXT,
    channel_id              UUID NOT NULL,
    performance_date        DATE NOT NULL,
    cost_micros             BIGINT NOT NULL DEFAULT 0,
    impressions             BIGINT,
    clicks                  BIGINT,
    conversions             NUMERIC,
    conversions_value       NUMERIC,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT lead_source_performance_daily_natural_unique
        UNIQUE (
            company_id,
            provider_key,
            external_account_id,
            external_campaign_id,
            performance_date
        ),
    CONSTRAINT lead_source_performance_daily_company_channel_fk
        FOREIGN KEY (company_id, channel_id)
        REFERENCES lead_source_channels(company_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_lead_source_performance_company_date_channel
    ON lead_source_performance_daily(company_id, performance_date, channel_id);

DROP TRIGGER IF EXISTS trg_google_ads_connections_updated_at
    ON google_ads_connections;
CREATE TRIGGER trg_google_ads_connections_updated_at
    BEFORE UPDATE ON google_ads_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_lead_source_performance_daily_updated_at
    ON lead_source_performance_daily;
CREATE TRIGGER trg_lead_source_performance_daily_updated_at
    BEFORE UPDATE ON lead_source_performance_daily
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE google_ads_connections IS
    'One tenant-owned Google Ads connection. OAuth refresh tokens are AES-256-GCM encrypted by the application.';
COMMENT ON COLUMN google_ads_connections.customer_id IS
    'Digits-normalized Google Ads customer id; uniqueness is tenant-local, never global.';
COMMENT ON TABLE lead_source_performance_daily IS
    'Connector-neutral tenant-owned daily campaign performance facts.';
COMMENT ON COLUMN lead_source_channels.channel_key IS
    'Tenant-local stable key; the Google Ads connector uses google_ads when connected.';

INSERT INTO marketplace_apps (
    app_key,
    name,
    provider_name,
    category,
    app_type,
    short_description,
    long_description,
    requested_scopes,
    provisioning_mode,
    status,
    support_email,
    metadata
) VALUES (
    'google-ads',
    'Google Ads',
    'Google',
    'analytics',
    'internal',
    'Connect Google Ads to import daily campaign spend into Albusto analytics.',
    'Connects one company Google Ads account and imports daily campaign cost, impressions, clicks, and conversions. Albusto automatically backfills historical spend and refreshes recent days so Google restatements are reflected.',
    '["analytics:read"]'::JSONB,
    'none',
    'published',
    'support@albusto.com',
    '{
      "access_summary": ["Read Google Ads account currency and timezone", "Read daily campaign performance and spend"],
      "requires_credential_input": false,
      "setup_path": "/settings/integrations/google-ads",
      "derived_connection": true,
      "assistant": {
        "what_it_does": "Imports daily Google Ads campaign spend and performance into Albusto so acquisition analytics can show channel cost and return.",
        "prerequisites": ["A Google Ads account billed in USD", "Google Ads API access enabled for the Albusto deployment", "A Google account authorized to read the Ads customer"],
        "setup_steps": ["Settings → Integrations → Google Ads", "Ask an Albusto administrator to complete the secure account authorization", "After connection, wait for the historical backfill to finish; recent spend then refreshes automatically"],
        "outcome": "Google Ads campaign spend, impressions, clicks, and conversions are synchronized daily for the company.",
        "recommend_when": ["User buys leads or traffic through Google Ads", "User wants campaign spend in acquisition analytics", "User wants Google Ads costs refreshed automatically"],
        "gotchas": ["The first version supports USD accounts only", "A different Google Ads customer cannot replace an existing connection without an explicit migration", "Recent 30 days are re-read because Google may restate campaign results"]
      }
    }'::JSONB
)
ON CONFLICT (app_key) DO UPDATE SET
    name = EXCLUDED.name,
    provider_name = EXCLUDED.provider_name,
    category = EXCLUDED.category,
    app_type = EXCLUDED.app_type,
    short_description = EXCLUDED.short_description,
    long_description = EXCLUDED.long_description,
    requested_scopes = EXCLUDED.requested_scopes,
    provisioning_mode = EXCLUDED.provisioning_mode,
    status = EXCLUDED.status,
    support_email = EXCLUDED.support_email,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();
