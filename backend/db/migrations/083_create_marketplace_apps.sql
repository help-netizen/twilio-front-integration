-- =============================================================================
-- Migration 083: Marketplace Apps Platform
-- Controlled app catalog + tenant installations for external API apps.
-- =============================================================================

CREATE TABLE IF NOT EXISTS marketplace_apps (
    id                  BIGSERIAL PRIMARY KEY,
    app_key             TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    provider_name       TEXT NOT NULL,
    category            TEXT NOT NULL,
    app_type            TEXT NOT NULL DEFAULT 'external'
        CHECK (app_type IN ('external', 'internal', 'private')),
    short_description   TEXT NOT NULL,
    long_description    TEXT,
    logo_url            TEXT,
    docs_url            TEXT,
    support_email       TEXT,
    privacy_url         TEXT,
    requested_scopes    JSONB NOT NULL DEFAULT '[]'::jsonb,
    provisioning_mode   TEXT NOT NULL DEFAULT 'manual'
        CHECK (provisioning_mode IN ('manual', 'push_credentials', 'none')),
    provisioning_url    TEXT,
    status              TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'review', 'published', 'disabled')),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_marketplace_apps_scopes_array CHECK (jsonb_typeof(requested_scopes) = 'array'),
    CONSTRAINT chk_marketplace_apps_https_provisioning
        CHECK (provisioning_mode <> 'push_credentials' OR provisioning_url ~ '^https://')
);

CREATE INDEX IF NOT EXISTS idx_marketplace_apps_status_category
    ON marketplace_apps(status, category);

CREATE INDEX IF NOT EXISTS idx_marketplace_apps_requested_scopes
    ON marketplace_apps USING GIN (requested_scopes);

DROP TRIGGER IF EXISTS trg_marketplace_apps_updated_at ON marketplace_apps;
CREATE TRIGGER trg_marketplace_apps_updated_at BEFORE UPDATE ON marketplace_apps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS marketplace_installations (
    id                              BIGSERIAL PRIMARY KEY,
    company_id                      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    app_id                          BIGINT NOT NULL REFERENCES marketplace_apps(id) ON DELETE RESTRICT,
    api_integration_id              BIGINT REFERENCES api_integrations(id) ON DELETE SET NULL,
    status                          TEXT NOT NULL DEFAULT 'provisioning_failed'
        CHECK (status IN ('connected', 'provisioning_failed', 'disconnected', 'revoked')),
    installed_by                    UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    installed_at                    TIMESTAMPTZ,
    disconnected_by                 UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    disconnected_at                 TIMESTAMPTZ,
    last_provisioning_attempt_at    TIMESTAMPTZ,
    provisioning_error              TEXT,
    external_installation_id        TEXT,
    metadata                        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_installations_one_active
    ON marketplace_installations(company_id, app_id)
    WHERE status IN ('connected', 'provisioning_failed');

CREATE INDEX IF NOT EXISTS idx_marketplace_installations_company_status
    ON marketplace_installations(company_id, status);

CREATE INDEX IF NOT EXISTS idx_marketplace_installations_api_integration
    ON marketplace_installations(api_integration_id);

DROP TRIGGER IF EXISTS trg_marketplace_installations_updated_at ON marketplace_installations;
CREATE TRIGGER trg_marketplace_installations_updated_at BEFORE UPDATE ON marketplace_installations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS marketplace_installation_events (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    installation_id     BIGINT REFERENCES marketplace_installations(id) ON DELETE SET NULL,
    app_id              BIGINT REFERENCES marketplace_apps(id) ON DELETE SET NULL,
    api_integration_id  BIGINT REFERENCES api_integrations(id) ON DELETE SET NULL,
    actor_id            UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    event_type          TEXT NOT NULL,
    request_id          TEXT,
    payload_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_events_company_created
    ON marketplace_installation_events(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_events_installation
    ON marketplace_installation_events(installation_id);

ALTER TABLE api_integrations
    ADD COLUMN IF NOT EXISTS marketplace_app_id BIGINT REFERENCES marketplace_apps(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS marketplace_installation_id BIGINT REFERENCES marketplace_installations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_integrations_marketplace_app
    ON api_integrations(marketplace_app_id);

CREATE INDEX IF NOT EXISTS idx_api_integrations_marketplace_installation
    ON api_integrations(marketplace_installation_id);

COMMENT ON TABLE api_integrations IS 'API integration credentials for external API clients and marketplace apps';
COMMENT ON COLUMN api_integrations.scopes IS
    'JSON array of integration permissions, e.g. ["leads:create"], ["analytics:read"], or ["full_access"] for trusted marketplace apps';
COMMENT ON COLUMN api_integrations.marketplace_app_id IS
    'Optional marketplace app catalog id when this credential was issued by the marketplace install flow';
COMMENT ON COLUMN api_integrations.marketplace_installation_id IS
    'Optional tenant installation id when this credential was issued by the marketplace install flow';

COMMENT ON TABLE marketplace_apps IS 'Vetted app catalog for Blanc marketplace integrations';
COMMENT ON TABLE marketplace_installations IS 'Tenant-specific marketplace app installation state';
COMMENT ON TABLE marketplace_installation_events IS 'Audit log for marketplace app installation lifecycle events; never stores plaintext secrets';

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
    privacy_url,
    docs_url,
    metadata
) VALUES
(
    'call-qa-agent',
    'Call QA Agent',
    'Blanc Labs',
    'ai',
    'internal',
    'Scores dispatcher calls from transcripts.',
    'Analyzes completed call transcripts and prepares dispatcher quality-control notes.',
    '["calls:read", "calls.transcripts:read", "notes:create"]'::jsonb,
    'manual',
    'published',
    'support@blanc.local',
    'https://blanc.local/privacy',
    '/settings/api-docs',
    '{"access_summary":["Call metadata","Call transcripts","Create notes"]}'::jsonb
),
(
    'lead-generator',
    'Lead Generator',
    'Blanc Labs',
    'lead_generation',
    'internal',
    'Creates inbound leads from external campaigns.',
    'Posts validated campaign leads into Blanc with source attribution.',
    '["leads:create"]'::jsonb,
    'manual',
    'published',
    'support@blanc.local',
    'https://blanc.local/privacy',
    '/settings/api-docs',
    '{"access_summary":["Create leads"]}'::jsonb
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
    privacy_url = EXCLUDED.privacy_url,
    docs_url = EXCLUDED.docs_url,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();
