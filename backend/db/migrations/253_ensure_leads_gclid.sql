-- =============================================================================
-- Migration 253: Ensure leads.gclid exists (self-healing, re-runnable)
--
-- gclid (Google Click ID) is originally added by legacy migration 081. That
-- migration is below the prod/staging migration-floor and therefore NEVER
-- re-runs. Any database restored/copied from a baseline that predates 081 — or
-- rebuilt from v3_schema.sql, which does not define the leads table at all —
-- ends up WITHOUT the column. The lead-channel analytics cohort SQL references
-- l.gclid, so a missing column 500s the whole Analytics section.
--
-- This migration sits ABOVE the floor, so the deploy runner re-applies it on
-- every environment (prod, staging, and any fresh copy), self-healing the gap.
-- Idempotent + additive: a no-op wherever the column already exists.
--
-- See LEAD-CHANNEL-ANALYTICS-001 incident 2026-08-11 (analytics down on prod +
-- staging because leads.gclid was absent on a restored DB).
-- =============================================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS gclid TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_gclid ON leads(gclid) WHERE gclid IS NOT NULL;

COMMENT ON COLUMN leads.gclid IS
    'Google Click ID (gclid) for offline conversion tracking. Ensured re-runnably by migration 253 (self-heal); originally added by 081.';
