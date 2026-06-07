-- =============================================================================
-- 088: Sales CRM core readiness for future Sales MCP (CRM-SALES-MCP-000)
-- Adds first-class accounts, deals, activities, notes, metadata, and deal audit
-- without changing existing Leads/Jobs/Pulse behavior.
-- =============================================================================

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS title TEXT;

CREATE TABLE IF NOT EXISTS crm_accounts (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    domain          TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    owner_user_id   UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    icp_segment     TEXT,
    health          TEXT,
    last_contact_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_accounts_company_name
    ON crm_accounts(company_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_crm_accounts_company_domain
    ON crm_accounts(company_id, lower(domain)) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_accounts_company_owner
    ON crm_accounts(company_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_accounts_company_last_contact
    ON crm_accounts(company_id, last_contact_at DESC NULLS LAST);

CREATE TRIGGER trg_crm_accounts_updated_at BEFORE UPDATE ON crm_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS crm_account_contacts (
    id                BIGSERIAL PRIMARY KEY,
    company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    account_id        BIGINT NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
    contact_id        BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    relationship_type TEXT,
    is_primary        BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_account_contacts_account
    ON crm_account_contacts(company_id, account_id);
CREATE INDEX IF NOT EXISTS idx_crm_account_contacts_contact
    ON crm_account_contacts(company_id, contact_id);

CREATE TRIGGER trg_crm_account_contacts_updated_at BEFORE UPDATE ON crm_account_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS crm_deals (
    id                 BIGSERIAL PRIMARY KEY,
    company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    account_id         BIGINT REFERENCES crm_accounts(id) ON DELETE SET NULL,
    owner_user_id      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    name               TEXT NOT NULL,
    amount             NUMERIC(14,2),
    currency           VARCHAR(3) NOT NULL DEFAULT 'USD',
    stage              TEXT NOT NULL,
    probability        INTEGER CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100)),
    close_date         DATE,
    next_step          TEXT,
    forecast_category  TEXT,
    risk_summary       TEXT,
    blocker_summary    TEXT,
    competitor         TEXT,
    procurement_status TEXT,
    last_activity_at   TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_deals_company_account
    ON crm_deals(company_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_company_owner
    ON crm_deals(company_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_company_stage
    ON crm_deals(company_id, stage);
CREATE INDEX IF NOT EXISTS idx_crm_deals_company_forecast
    ON crm_deals(company_id, forecast_category) WHERE forecast_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_company_close_date
    ON crm_deals(company_id, close_date) WHERE close_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_company_last_activity
    ON crm_deals(company_id, last_activity_at DESC NULLS LAST);

CREATE TRIGGER trg_crm_deals_updated_at BEFORE UPDATE ON crm_deals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS crm_deal_contacts (
    id         BIGSERIAL PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    deal_id    BIGINT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('decision_maker', 'champion', 'evaluator', 'procurement', 'blocker')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, deal_id, contact_id, role)
);

CREATE INDEX IF NOT EXISTS idx_crm_deal_contacts_deal
    ON crm_deal_contacts(company_id, deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_deal_contacts_contact
    ON crm_deal_contacts(company_id, contact_id);

CREATE TRIGGER trg_crm_deal_contacts_updated_at BEFORE UPDATE ON crm_deal_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS crm_deal_history (
    id          BIGSERIAL PRIMARY KEY,
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    deal_id     BIGINT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    field_name  TEXT NOT NULL,
    old_value   JSONB,
    new_value   JSONB,
    changed_by  UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    source      TEXT NOT NULL DEFAULT 'crm',
    request_id  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_deal_history_deal_created
    ON crm_deal_history(company_id, deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_deal_history_field_created
    ON crm_deal_history(company_id, field_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_deal_history_request
    ON crm_deal_history(company_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_activities (
    id                 BIGSERIAL PRIMARY KEY,
    company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    account_id         BIGINT REFERENCES crm_accounts(id) ON DELETE SET NULL,
    deal_id            BIGINT REFERENCES crm_deals(id) ON DELETE SET NULL,
    contact_id         BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    owner_user_id      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    type               TEXT NOT NULL CHECK (type IN ('email', 'call', 'meeting', 'note', 'task', 'stage_change')),
    occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    summary            TEXT,
    body               TEXT,
    customer_facing    BOOLEAN NOT NULL DEFAULT false,
    source_entity_type TEXT,
    source_entity_id   TEXT,
    search_vector      TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(body, ''))
    ) STORED,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_account
    ON crm_activities(company_id, account_id, occurred_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_activities_deal
    ON crm_activities(company_id, deal_id, occurred_at DESC) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_activities_contact
    ON crm_activities(company_id, contact_id, occurred_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_activities_type
    ON crm_activities(company_id, type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_customer_facing
    ON crm_activities(company_id, customer_facing, occurred_at DESC) WHERE customer_facing = true;
CREATE INDEX IF NOT EXISTS idx_crm_activities_search
    ON crm_activities USING GIN(search_vector);

CREATE TABLE IF NOT EXISTS crm_notes (
    id          BIGSERIAL PRIMARY KEY,
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('account', 'deal', 'contact')),
    entity_id   BIGINT NOT NULL,
    text        TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('manual', 'meeting_follow_up', 'forecast_review', 'deal_strategy')),
    created_by  UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_notes_entity
    ON crm_notes(company_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_notes_source
    ON crm_notes(company_id, source, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
    id                  BIGSERIAL PRIMARY KEY,
    company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    stage_key            TEXT NOT NULL,
    name                 TEXT NOT NULL,
    display_order        INTEGER NOT NULL DEFAULT 0,
    default_probability  INTEGER CHECK (default_probability IS NULL OR (default_probability >= 0 AND default_probability <= 100)),
    is_open              BOOLEAN NOT NULL DEFAULT true,
    is_won               BOOLEAN NOT NULL DEFAULT false,
    is_lost              BOOLEAN NOT NULL DEFAULT false,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, stage_key)
);

CREATE TABLE IF NOT EXISTS crm_forecast_categories (
    id            BIGSERIAL PRIMARY KEY,
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    category_key  TEXT NOT NULL,
    name          TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, category_key)
);

CREATE TABLE IF NOT EXISTS crm_stage_transition_rules (
    id          BIGSERIAL PRIMARY KEY,
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    from_stage  TEXT NOT NULL,
    to_stage    TEXT NOT NULL,
    allowed     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, from_stage, to_stage)
);

CREATE TABLE IF NOT EXISTS crm_task_statuses (
    id            BIGSERIAL PRIMARY KEY,
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    status_key    TEXT NOT NULL,
    name          TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_closed     BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, status_key)
);

INSERT INTO crm_pipeline_stages (company_id, stage_key, name, display_order, default_probability, is_open, is_won, is_lost)
SELECT c.id, v.stage_key, v.name, v.display_order, v.default_probability, v.is_open, v.is_won, v.is_lost
FROM companies c
CROSS JOIN (VALUES
    ('qualification', 'Qualification', 10, 10, true, false, false),
    ('discovery', 'Discovery', 20, 25, true, false, false),
    ('proposal', 'Proposal', 30, 50, true, false, false),
    ('negotiation', 'Negotiation', 40, 75, true, false, false),
    ('closed_won', 'Closed Won', 90, 100, false, true, false),
    ('closed_lost', 'Closed Lost', 100, 0, false, false, true)
) AS v(stage_key, name, display_order, default_probability, is_open, is_won, is_lost)
ON CONFLICT (company_id, stage_key) DO NOTHING;

INSERT INTO crm_forecast_categories (company_id, category_key, name, display_order)
SELECT c.id, v.category_key, v.name, v.display_order
FROM companies c
CROSS JOIN (VALUES
    ('commit', 'Commit', 10),
    ('best_case', 'Best Case', 20),
    ('pipeline', 'Pipeline', 30),
    ('omitted', 'Omitted', 40)
) AS v(category_key, name, display_order)
ON CONFLICT (company_id, category_key) DO NOTHING;

INSERT INTO crm_task_statuses (company_id, status_key, name, display_order, is_closed)
SELECT c.id, v.status_key, v.name, v.display_order, v.is_closed
FROM companies c
CROSS JOIN (VALUES
    ('open', 'Open', 10, false),
    ('done', 'Done', 20, true)
) AS v(status_key, name, display_order, is_closed)
ON CONFLICT (company_id, status_key) DO NOTHING;

INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.permission_key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('sales.crm.read'),
    ('sales.crm.write')
) AS p(permission_key)
WHERE rc.role_key IN ('tenant_admin', 'manager')
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, 'sales.crm.read', true
FROM company_role_configs rc
WHERE rc.role_key = 'dispatcher'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

COMMENT ON TABLE crm_accounts IS 'Sales CRM accounts for future Sales MCP workflows';
COMMENT ON TABLE crm_deals IS 'Sales CRM deals/opportunities; intentionally separate from service jobs';
COMMENT ON TABLE crm_activities IS 'Normalized sales activity read model for future Sales MCP workflows';
COMMENT ON TABLE crm_deal_history IS 'Deal field history used for before/after audit, pipeline deltas, and slippage';
