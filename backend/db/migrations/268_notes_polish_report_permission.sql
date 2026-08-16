-- =============================================================================
-- Migration 268: NOTES-REPORT-PERM-001
--
-- New permission key `notes.polish_report` — governs the "Report generator" note
-- action (turn a rough technician note into a full professional report via the
-- Report → Estimate LLM). Previously hardcoded to the Provider role; now a
-- configurable permission surfaced in Settings → Roles & Access.
--
-- Backfill for EXISTING companies (050 seeds it for NEW companies via the
-- onboarding bootstrap that re-reads 050 wholesale). Idempotent / re-runnable —
-- existing roles never auto-inherit new permission keys, so each grant is
-- explicit and ON CONFLICT makes a re-run a no-op (and never clobbers an admin's
-- later manual toggle).
--
-- Default grants preserve today's behavior (Provider had it) and add Tenant Admin
-- (owners configure the feature and should see it). Manager / Dispatcher are left
-- OFF by default — an admin can enable them from the new toggle.
-- =============================================================================

INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, 'notes.polish_report', true
FROM company_role_configs rc
WHERE rc.role_key IN ('provider', 'tenant_admin')
ON CONFLICT (role_config_id, permission_key) DO NOTHING;
