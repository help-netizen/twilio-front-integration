-- =============================================================================
-- Migration 112: F018 Phases 3–4 — keyed (manual card) + terminal (Tap to Pay)
-- collection permissions. reports.payments.view already exists. Seeded per role;
-- idempotent. Existing roles do not auto-inherit new permission keys.
-- =============================================================================

-- Tenant Admin + Manager: both collection surfaces.
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('payments.collect_keyed'),
    ('payments.collect_terminal')
) AS p(key)
WHERE rc.role_key IN ('tenant_admin', 'manager')
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- Dispatcher: keyed entry from the office (no terminal).
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, 'payments.collect_keyed', true
FROM company_role_configs rc
WHERE rc.role_key = 'dispatcher'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- Provider (field technician): terminal/Tap to Pay only.
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, 'payments.collect_terminal', true
FROM company_role_configs rc
WHERE rc.role_key = 'provider'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;
