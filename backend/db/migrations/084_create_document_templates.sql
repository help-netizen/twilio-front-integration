-- =============================================================================
-- Migration 084: Document Templates Customization (F015)
--
-- Per-company, versioned, JSON-encoded descriptors that drive PDF and HTML
-- preview rendering for client-facing documents (estimates first; designed to
-- accept invoice/work_order later as data-only changes).
--
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS document_templates (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    document_type   TEXT NOT NULL CHECK (document_type IN ('estimate')),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    is_default      BOOLEAN NOT NULL DEFAULT false,
    schema_version  INTEGER NOT NULL DEFAULT 1,
    content         JSONB NOT NULL,
    archived_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_document_templates_company_type_slug UNIQUE (company_id, document_type, slug),
    CONSTRAINT chk_document_templates_content_object CHECK (jsonb_typeof(content) = 'object')
);

-- Exactly one active default per (company, document_type).
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_templates_one_default
    ON document_templates(company_id, document_type)
    WHERE is_default = true AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_document_templates_lookup
    ON document_templates(company_id, document_type, archived_at);

DROP TRIGGER IF EXISTS trg_document_templates_updated_at ON document_templates;
CREATE TRIGGER trg_document_templates_updated_at BEFORE UPDATE ON document_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- Seed: one factory descriptor per existing company for document_type='estimate'.
-- Mirrors backend/src/services/documentTemplates/factory.js (estimate factory).
-- Generated via:
--   node -e "console.log(JSON.stringify(require('./backend/src/services/documentTemplates/factory').getFactory('estimate')))"
-- Single-quotes inside the JSON literal are escaped per SQL string rules.
-- =============================================================================

INSERT INTO document_templates
    (company_id, document_type, name, slug, is_default, schema_version, content)
SELECT
    c.id,
    'estimate',
    'Default',
    'default',
    true,
    1,
    '{"schema_version":1,"brand":{"name":"ABC Homes","address":"2502 Village Rd W, Norwood, MA 02062, USA","email":"help@bostonmasters.com","phone":"(508) 290-4442","logo_url":null,"ach":{"bank":"Bank Of America","routing_number":"011000138","account_number":"466020155621"}},"theme":{"ink":"#172033","muted":"#5f7085","faint":"#eef3f8","surface":"#fbfcfe","border":"#d8e0ea","accent":"#2563eb","danger":"#be123c"},"sections":[{"key":"logo","visible":true,"width":"third","glue_with_next":true},{"key":"header","visible":true,"width":"third"},{"key":"document_meta","visible":true,"width":"third"},{"key":"ach","visible":true,"width":"full"},{"key":"client_addresses","visible":true,"width":"full"},{"key":"summary","visible":true,"width":"full"},{"key":"items","visible":true,"width":"full"},{"key":"totals","visible":true,"width":"full"},{"key":"terms","visible":true,"body_md":"TERMS: Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.\n\nWARRANTY:\n- 90-day labor warranty covering workmanship and the completed repair, starting from the date the repair is finished.\n- OEM parts warranty is extended to a minimum of 90 days, even if the manufacturer''s standard warranty is shorter.\n- A service visit during the warranty period is provided at no additional charge if the issue is related to the repaired component or workmanship.\n- Warranty does not cover misuse, physical damage, power issues, water damage, improper installation, or failures unrelated to the replaced component.","width":"full"}],"footer":{"show_page_number":true,"text_md":null}}'::jsonb
FROM companies c
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates dt
    WHERE dt.company_id = c.id
      AND dt.document_type = 'estimate'
);
