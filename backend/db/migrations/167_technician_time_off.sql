-- =============================================================================
-- Migration 167: technician_time_off — TECH-DAYOFF-001 (DO-01).
--
-- Day-off periods for technicians. One row per technician per period:
--   • technician_id is the Zenbooker team-member TEXT id (same identity plane as
--     jobs.assigned_techs[].id and technician_base_locations.tech_id) — NOT
--     crm_users.id.
--   • technician_name is a display snapshot taken at creation time (individual:
--     from the client's already-loaded roster; company-wide: from the same ZB
--     roster response used to materialize). Rendering NEVER calls ZB for names.
--   • [starts_at, ends_at) is a single UTC timestamptz interval — may cross
--     midnight / span multiple days; it is never sliced per-date anywhere.
--   • Company-wide creation MATERIALIZES into K individual rows (one per active
--     ZB technician) sharing a fresh batch_id (source='company'). batch_id is
--     audit-only: deletion is ALWAYS per-row, no cascade by batch (INV-6).
--   • created_by references crm_users.id (req.user.crmUser.id, NOT the Keycloak
--     sub — created_by-FK gotcha); nullable for tokenless/system contexts.
--
-- Consumed by timeOffQueries (CRUD + the A′ post-filter overlap SELECT inside
-- slotEngineService.getRecommendations, DO-02). Every query is company-scoped.
--
-- Additive, idempotent (IF NOT EXISTS), touches no existing rows. Reversible via
-- rollback_167_technician_time_off.sql.
--
-- Migration number: max on disk = 166 (166_yelp_conversations_lead_uuid_text.sql)
-- at build time → next free = 167.
-- =============================================================================

CREATE TABLE IF NOT EXISTS technician_time_off (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    technician_id   TEXT NOT NULL,            -- ZB team-member id (= jobs.assigned_techs[].id, technician_base_locations.tech_id)
    technician_name TEXT,                     -- display snapshot at creation time (list rendering never calls ZB)
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
    note            TEXT,
    source          TEXT NOT NULL DEFAULT 'individual' CHECK (source IN ('individual','company')),
    batch_id        UUID,                     -- groups a company-wide materialization (audit only; deletion is ALWAYS per-row)
    created_by      UUID REFERENCES crm_users(id),   -- req.user.crmUser.id, NOT sub (created_by-FK gotcha)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tech_time_off_lookup
    ON technician_time_off (company_id, technician_id, starts_at);

COMMENT ON TABLE technician_time_off IS 'TECH-DAYOFF-001: day-off periods [starts_at, ends_at) per technician (ZB team-member TEXT id). Company-wide creation materializes into K rows sharing batch_id; deletion is always per-row.';
COMMENT ON COLUMN technician_time_off.technician_id IS 'Zenbooker team-member TEXT id — same identity plane as jobs.assigned_techs[].id / technician_base_locations.tech_id (NOT crm_users.id).';
COMMENT ON COLUMN technician_time_off.technician_name IS 'Display-name snapshot at creation time; not refreshed on later ZB renames (v1).';
COMMENT ON COLUMN technician_time_off.batch_id IS 'Shared uuid across the K rows of one company-wide materialization. Audit only — no code path deletes by batch_id.';
COMMENT ON COLUMN technician_time_off.created_by IS 'crm_users.id of the creator (req.user.crmUser.id, never the Keycloak sub); NULL when unknown.';
