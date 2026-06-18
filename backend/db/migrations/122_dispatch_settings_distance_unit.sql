-- ============================================================================
-- 122: SCHED-ROUTE-001 (C-13) — per-company distance unit for route display.
-- 'mi' (default, US) or 'km'. Read by the schedule UI to format route legs;
-- no behavioural change for existing US tenants. Idempotent.
-- ============================================================================

ALTER TABLE dispatch_settings
    ADD COLUMN IF NOT EXISTS distance_unit TEXT NOT NULL DEFAULT 'mi';
