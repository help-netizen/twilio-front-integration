-- ============================================================================
-- 102: AUTO-001 — system-rule marker for seeded AR-equivalent rules.
-- ============================================================================

ALTER TABLE automation_rules
    ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- Seeded system rules are unique per (company, name) so seed-defaults is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_rules_system_name
    ON automation_rules (company_id, name) WHERE is_system = true;
