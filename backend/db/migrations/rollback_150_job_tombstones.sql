-- =============================================================================
-- Rollback 149: drop the job_tombstones table (and its index, dropped implicitly
-- with the table) created by migration 149.
--
-- Tombstone rows are hard-delete markers only; dropping the table discards them.
-- That is safe: they carry no source-of-truth data (the jobs themselves are
-- already gone), and the delta endpoint degrades to returning an empty
-- tombstones[] once the table is absent — clients simply stop receiving
-- hard-delete signals (the far more common re-assign case via `unassigned` is
-- unaffected). Idempotent (IF EXISTS).
-- =============================================================================

DROP TABLE IF EXISTS job_tombstones;
