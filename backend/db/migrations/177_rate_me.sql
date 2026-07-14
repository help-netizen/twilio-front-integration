-- =============================================================================
-- Migration 177: Rate Me tokens, technician ratings, custom domains, and app.
-- =============================================================================

CREATE TABLE IF NOT EXISTS rate_tokens (
    id           BIGSERIAL PRIMARY KEY,
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    token        TEXT NOT NULL UNIQUE,
    job_id       BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
    tech_id      TEXT NOT NULL,
    tech_name    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NULL,
    used_at      TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_tokens_company
    ON rate_tokens(company_id);

CREATE TABLE IF NOT EXISTS technician_ratings (
    id             BIGSERIAL PRIMARY KEY,
    company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    rate_token_id  BIGINT NOT NULL UNIQUE REFERENCES rate_tokens(id) ON DELETE CASCADE,
    job_id         BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
    tech_id        TEXT NOT NULL,
    stars          SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
    feedback       TEXT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_technician_ratings_company_tech
    ON technician_ratings(company_id, tech_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_me_domains (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
    domain          TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'active', 'failed')),
    verified_at     TIMESTAMPTZ NULL,
    activated_at    TIMESTAMPTZ NULL,
    last_checked_at TIMESTAMPTZ NULL,
    last_error      TEXT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_rate_me_domains_updated_at ON rate_me_domains;
CREATE TRIGGER trg_rate_me_domains_updated_at BEFORE UPDATE ON rate_me_domains
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

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
    'rate-me',
    'Rate Me',
    'Albusto',
    'customer_experience',
    'internal',
    'Collect technician ratings on a branded page — 5-star customers go straight to your Google reviews.',
    'Rate Me gives every completed job a private rating link. Customers rate the technician on a mobile page with your logo and name — hosted on rate.albusto.com or on your own domain via a single CNAME record. A 5-star rating sends the customer straight to your Google review page; anything less opens a private feedback box so problems reach you, not the internet. Ratings are stored per company.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "access_summary": ["Store customer ratings and private feedback per technician", "Read technician display names and your company branding for the public page"],
        "requires_credential_input": false
    }'::jsonb
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
