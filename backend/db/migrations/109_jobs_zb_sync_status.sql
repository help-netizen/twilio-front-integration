-- ============================================================================
-- 109: SCHED-ROUTE-001 — ZenBooker best-effort sync marker (C-12)
-- Tracks the one-shot external-sync outcome for locally-created Albusto jobs so
-- the sync is dedupe-guarded (ZB create is NOT idempotent, zenbookerClient:187):
--   NULL      — local-only / not attempted
--   pending   — sync task enqueued / in flight
--   synced    — created in ZenBooker (zenbooker_job_id populated)
--   failed    — attempted once, ZenBooker errored (local job kept, never rolled back)
-- Idempotent.
-- ============================================================================

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS zb_sync_status TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_zb_sync_status
    ON jobs (company_id, zb_sync_status)
    WHERE zb_sync_status IS NOT NULL;
