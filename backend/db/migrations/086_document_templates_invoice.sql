-- =============================================================================
-- Migration 086: Extend document_templates to support document_type='invoice'.
--
-- Recreates the CHECK constraint with the new value and seeds one default
-- invoice template per existing company (similar to migration 084).
-- =============================================================================

ALTER TABLE document_templates
    DROP CONSTRAINT IF EXISTS document_templates_document_type_check;

ALTER TABLE document_templates
    ADD CONSTRAINT document_templates_document_type_check
    CHECK (document_type IN ('estimate', 'invoice'));

-- Seed: one factory descriptor per company for document_type='invoice'.
-- Mirrors backend/src/services/documentTemplates/factory.js (invoice factory).
INSERT INTO document_templates
    (company_id, document_type, name, slug, is_default, schema_version, content)
SELECT
    c.id,
    'invoice',
    'Default',
    'default',
    true,
    1,
    '{"schema_version":1,"brand":{"name":"ABC Homes","address":"2502 Village Rd W, Norwood, MA 02062, USA","email":"help@bostonmasters.com","phone":"(508) 290-4442","logo_url":null,"ach":{"bank":"Bank Of America","routing_number":"011000138","account_number":"466020155621"}},"theme":{"ink":"#172033","muted":"#5f7085","faint":"#eef3f8","surface":"#fbfcfe","border":"#d8e0ea","accent":"#0f766e","danger":"#be123c"},"sections":[{"key":"logo","visible":true,"width":"third","glue_with_next":true},{"key":"header","visible":true,"width":"third"},{"key":"document_meta","visible":true,"width":"third"},{"key":"ach","visible":true,"width":"full"},{"key":"client_addresses","visible":true,"width":"full"},{"key":"summary","visible":true,"width":"full"},{"key":"items","visible":true,"width":"full"},{"key":"totals","visible":true,"width":"full"},{"key":"terms","visible":true,"body_md":"TERMS: Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.\n\nWARRANTY:\n- 90-day labor warranty covering workmanship and the completed repair, starting from the date the repair is finished.\n- OEM parts warranty is extended to a minimum of 90 days, even if the manufacturer''s standard warranty is shorter.\n- A service visit during the warranty period is provided at no additional charge if the issue is related to the repaired component or workmanship.\n- Warranty does not cover misuse, physical damage, power issues, water damage, improper installation, or failures unrelated to the replaced component.","width":"full"}],"footer":{"show_page_number":true,"text_md":null},"invoice_settings":{"default_due_days":14}}'::jsonb
FROM companies c
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates dt
    WHERE dt.company_id = c.id
      AND dt.document_type = 'invoice'
);
