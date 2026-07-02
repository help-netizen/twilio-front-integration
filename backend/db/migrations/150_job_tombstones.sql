-- =============================================================================
-- Migration 149: MOBILE-TECH-APP-001 / MTECH-T1 — job_tombstones (hard-delete
-- markers for the provider delta-sync endpoint GET /api/sync/jobs).
--
-- Ground truth (spec §0 G2): the jobs table has NO soft-delete column — every
-- deletion is a hard DELETE of the row. The mobile read-only cache therefore has
-- no way to learn that a previously-cached job was removed: an incremental delta
-- keyed on (updated_at, id) only ever sees rows that STILL exist. This table is
-- the durable "the row is gone" signal the delta endpoint reads
-- (SELECT job_id FROM job_tombstones WHERE company_id=$c AND deleted_at > since).
--
-- A tombstone is written by whatever path physically deletes a job, inside the
-- same transaction as the DELETE (spec §2.3, §4.1, §8.T1). As of this migration
-- the application has no hard-delete-a-job path (no `DELETE FROM jobs` anywhere
-- in backend/src), so this table stays empty in practice — but the endpoint still
-- returns a correct (empty) tombstones[] and is ready the moment such a path is
-- added. Note the common "the job disappeared from my list" case is a re-ASSIGN
-- (job still alive, no longer @> my id) handled via the `unassigned` sub-query,
-- NOT a tombstone.
--
-- Columns mirror the jobs identity: company_id UUID (tenant isolation — every
-- delta read is company-scoped) + job_id BIGINT (jobs.id is BIGINT). deleted_at
-- drives the `> since_ts` cursor comparison. PK (company_id, job_id) makes the
-- insert idempotent (re-deleting the same id is a harmless no-op via
-- ON CONFLICT DO NOTHING at the call site). Index (company_id, deleted_at)
-- supports the delta scan.
--
-- Additive, idempotent (IF NOT EXISTS), touches no existing data. Reversible via
-- rollback_149_job_tombstones.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS job_tombstones (
    company_id  UUID        NOT NULL,
    job_id      BIGINT      NOT NULL,
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_tombstones_company_deleted_at
    ON job_tombstones (company_id, deleted_at);
