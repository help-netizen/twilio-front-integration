-- =============================================================================
-- Rollback 253: intentionally a NO-OP.
--
-- Migration 253 only ENSURES leads.gclid exists; it does not own the column
-- (migration 081 / the canonical 004 leads table do). Dropping gclid here would
-- break the lead-channel analytics that depend on it and destroy data. So this
-- rollback deliberately does nothing.
-- =============================================================================

SELECT 1;
