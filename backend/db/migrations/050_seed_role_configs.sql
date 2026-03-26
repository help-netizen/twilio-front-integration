-- =============================================================================
-- Migration 050: Seed default role configs for existing companies
-- Creates 4 system roles with default permission matrices per PF103
-- =============================================================================

-- Seed role configs for every existing company
INSERT INTO company_role_configs (company_id, role_key, display_name, description, is_locked)
SELECT c.id, r.role_key, r.display_name, r.description, r.is_locked
FROM companies c
CROSS JOIN (VALUES
    ('tenant_admin', 'Tenant Admin', 'Full access to tenant scope', true),
    ('manager',      'Manager',      'Broad access to business modules', false),
    ('dispatcher',   'Dispatcher',   'Dispatch and communication operations', false),
    ('provider',     'Provider',     'Field work and assigned jobs', false)
) AS r(role_key, display_name, description, is_locked)
ON CONFLICT (company_id, role_key) DO NOTHING;

-- ─── Seed default permissions for Tenant Admin (all allowed) ────────────────
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('tenant.company.view'), ('tenant.company.manage'),
    ('tenant.users.view'), ('tenant.users.manage'),
    ('tenant.roles.view'), ('tenant.roles.manage'),
    ('tenant.integrations.manage'), ('tenant.telephony.manage'),
    ('dashboard.view'), ('pulse.view'),
    ('messages.view_internal'), ('messages.view_client'), ('messages.send'),
    ('contacts.view'), ('contacts.edit'),
    ('leads.view'), ('leads.create'), ('leads.edit'), ('leads.convert'),
    ('jobs.view'), ('jobs.create'), ('jobs.edit'), ('jobs.assign'),
    ('jobs.close'), ('jobs.done_pending_approval'),
    ('schedule.view'), ('schedule.dispatch'),
    ('financial_data.view'),
    ('estimates.view'), ('estimates.create'), ('estimates.send'),
    ('invoices.view'), ('invoices.create'), ('invoices.send'),
    ('payments.view'), ('payments.collect_online'), ('payments.collect_offline'), ('payments.refund'),
    ('reports.dashboard.view'), ('reports.jobs.view'), ('reports.leads.view'),
    ('reports.calls.view'), ('reports.payments.view'), ('reports.financial.view'),
    ('client_job_history.view'),
    ('provider.enabled'), ('phone_calls.use'), ('call_masking.use'),
    ('gps_tracking.view'), ('gps_tracking.collect')
) AS p(key)
WHERE rc.role_key = 'tenant_admin'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- ─── Seed default permissions for Manager ────────────────────────────────────
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('tenant.company.view'),
    ('tenant.users.view'),
    ('dashboard.view'), ('pulse.view'),
    ('messages.view_internal'), ('messages.view_client'), ('messages.send'),
    ('contacts.view'), ('contacts.edit'),
    ('leads.view'), ('leads.create'), ('leads.edit'), ('leads.convert'),
    ('jobs.view'), ('jobs.create'), ('jobs.edit'), ('jobs.assign'),
    ('jobs.close'), ('jobs.done_pending_approval'),
    ('schedule.view'), ('schedule.dispatch'),
    ('financial_data.view'),
    ('estimates.view'), ('estimates.create'), ('estimates.send'),
    ('invoices.view'), ('invoices.create'), ('invoices.send'),
    ('payments.view'), ('payments.collect_online'), ('payments.collect_offline'),
    ('reports.dashboard.view'), ('reports.jobs.view'), ('reports.leads.view'),
    ('reports.calls.view'), ('reports.payments.view'), ('reports.financial.view'),
    ('client_job_history.view'),
    ('phone_calls.use')
) AS p(key)
WHERE rc.role_key = 'manager'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- ─── Seed default permissions for Dispatcher ─────────────────────────────────
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('dashboard.view'), ('pulse.view'),
    ('messages.view_internal'), ('messages.view_client'), ('messages.send'),
    ('contacts.view'), ('contacts.edit'),
    ('leads.view'), ('leads.create'), ('leads.edit'), ('leads.convert'),
    ('jobs.view'), ('jobs.create'), ('jobs.edit'), ('jobs.assign'),
    ('jobs.done_pending_approval'),
    ('schedule.view'), ('schedule.dispatch'),
    ('reports.dashboard.view'), ('reports.jobs.view'), ('reports.leads.view'),
    ('reports.calls.view'),
    ('client_job_history.view'),
    ('phone_calls.use')
) AS p(key)
WHERE rc.role_key = 'dispatcher'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- ─── Seed default permissions for Provider ───────────────────────────────────
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('pulse.view'),
    ('messages.view_client'), ('messages.send'),
    ('jobs.view'),
    ('jobs.done_pending_approval'),
    ('schedule.view'),
    ('provider.enabled'),
    ('phone_calls.use')
) AS p(key)
WHERE rc.role_key = 'provider'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- ─── Seed default scopes ─────────────────────────────────────────────────────

-- Tenant Admin: full access on all scopes
INSERT INTO company_role_scopes (role_config_id, scope_key, scope_json)
SELECT rc.id, s.key, s.val::jsonb
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('job_visibility',   '"all"'),
    ('financial_scope',  '"full"'),
    ('dashboard_scope',  '"all_widgets"'),
    ('report_scope',     '"all"'),
    ('job_close_scope',  '"close_allowed"')
) AS s(key, val)
WHERE rc.role_key = 'tenant_admin'
ON CONFLICT (role_config_id, scope_key) DO NOTHING;

-- Manager: full access
INSERT INTO company_role_scopes (role_config_id, scope_key, scope_json)
SELECT rc.id, s.key, s.val::jsonb
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('job_visibility',   '"all"'),
    ('financial_scope',  '"full"'),
    ('dashboard_scope',  '"all_widgets"'),
    ('report_scope',     '"all"'),
    ('job_close_scope',  '"close_allowed"')
) AS s(key, val)
WHERE rc.role_key = 'manager'
ON CONFLICT (role_config_id, scope_key) DO NOTHING;

-- Dispatcher: operational access, no finance
INSERT INTO company_role_scopes (role_config_id, scope_key, scope_json)
SELECT rc.id, s.key, s.val::jsonb
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('job_visibility',   '"all"'),
    ('financial_scope',  '"hidden"'),
    ('dashboard_scope',  '"all_widgets"'),
    ('report_scope',     '"operational_only"'),
    ('job_close_scope',  '"done_pending_approval_only"')
) AS s(key, val)
WHERE rc.role_key = 'dispatcher'
ON CONFLICT (role_config_id, scope_key) DO NOTHING;

-- Provider: assigned only, no finance
INSERT INTO company_role_scopes (role_config_id, scope_key, scope_json)
SELECT rc.id, s.key, s.val::jsonb
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('job_visibility',   '"assigned_only"'),
    ('financial_scope',  '"hidden"'),
    ('dashboard_scope',  '"no_dashboard"'),
    ('report_scope',     '"none"'),
    ('job_close_scope',  '"done_pending_approval_only"')
) AS s(key, val)
WHERE rc.role_key = 'provider'
ON CONFLICT (role_config_id, scope_key) DO NOTHING;
