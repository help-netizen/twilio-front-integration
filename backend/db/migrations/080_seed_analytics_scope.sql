-- =============================================================================
-- Migration 080: Document analytics:read scope
--
-- No DDL change — api_integrations.scopes is already JSONB and accepts any
-- string. This file is a marker so onboarding scripts and audits can find the
-- canonical scope list.
--
-- Canonical scopes (2026-04-22):
--   leads:create       — POST /api/v1/integrations/leads
--   analytics:read     — GET  /api/v1/integrations/analytics/*   (F014)
-- =============================================================================

COMMENT ON COLUMN api_integrations.scopes IS
    'JSON array of permissions. Known values: leads:create, analytics:read';
