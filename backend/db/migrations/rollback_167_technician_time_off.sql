-- =============================================================================
-- Rollback migration 167 — TECH-DAYOFF-001 technician_time_off.
-- Drops the day-off table (the idx_tech_time_off_lookup index and the CHECK
-- constraints are dropped with it). Idempotent (DROP … IF EXISTS); leaves no
-- orphaned index/constraint. Re-applying the forward migration afterwards
-- succeeds (its guards are IF NOT EXISTS).
-- =============================================================================

DROP TABLE IF EXISTS technician_time_off;
