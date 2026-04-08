-- =============================================================================
-- Migration 074: Add FSM permissions for admin and manager roles
-- Grants fsm.viewer/editor/publisher/override to tenant_admin,
-- and fsm.viewer to manager
-- =============================================================================

-- ─── FSM permissions for Tenant Admin (all 4) ────────────────────────────────
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('fsm.viewer'), ('fsm.editor'), ('fsm.publisher'), ('fsm.override')
) AS p(key)
WHERE rc.role_key = 'tenant_admin'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- ─── FSM permissions for Manager (viewer only) ───────────────────────────────
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('fsm.viewer')
) AS p(key)
WHERE rc.role_key = 'manager'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;
