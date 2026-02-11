-- =============================================================================
-- Migration 010: Create companies table
-- Multi-tenant company entity
-- =============================================================================

CREATE TABLE IF NOT EXISTS companies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    slug        VARCHAR(100) UNIQUE NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'active',
    settings    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

-- Trigger for updated_at
CREATE TRIGGER trg_companies_updated_at BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE companies IS 'Multi-tenant company registry';

-- Seed: Default company (Boston Masters)
INSERT INTO companies (id, name, slug, status)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Boston Masters',
    'boston-masters',
    'active'
)
ON CONFLICT (id) DO NOTHING;
