-- ============================================================================
-- 107: SCHED-ROUTE-001 — Schedule routes & address geocoding (backend foundation)
-- Binding corrections applied: technician_id = internal crm_users.id (C-2),
-- company-local schedule_date (C-3), GLOBAL route cache (C-4), no google_maps_url
-- column (C-6), idempotency partial unique index (C-7), distance in meters (C-13).
-- Idempotent.
-- ============================================================================

-- ── jobs: persisted geocoding (FR-004) ──────────────────────────────────────
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS normalized_address     TEXT,
    ADD COLUMN IF NOT EXISTS geocoding_status        TEXT NOT NULL DEFAULT 'not_geocoded',
        -- not_geocoded | pending | success | failed | needs_review
    ADD COLUMN IF NOT EXISTS geocoded_at             TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS geocoding_provider      TEXT DEFAULT 'google_maps',
    ADD COLUMN IF NOT EXISTS geocoding_place_id      TEXT,
    ADD COLUMN IF NOT EXISTS geocoding_error_code    TEXT,
    ADD COLUMN IF NOT EXISTS geocoding_error_message TEXT;   -- internal/admin only

CREATE INDEX IF NOT EXISTS idx_jobs_geocoding_status
    ON jobs (company_id, geocoding_status);

-- ── schedule_route_segments — per-tenant, per-technician, per company-local day ─
-- technician_id is the INTERNAL crm_users.id (jobs.assigned_provider_user_ids), C-2.
CREATE TABLE IF NOT EXISTS schedule_route_segments (
    id                BIGSERIAL PRIMARY KEY,
    company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    technician_id     UUID NOT NULL,                       -- crm_users.id
    technician_source TEXT NOT NULL DEFAULT 'company_user',
    schedule_date     DATE NOT NULL,                       -- company-local day (C-3)
    from_job_id       BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    to_job_id         BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    from_latitude     DOUBLE PRECISION,
    from_longitude    DOUBLE PRECISION,
    to_latitude       DOUBLE PRECISION,
    to_longitude      DOUBLE PRECISION,
    travel_mode       TEXT NOT NULL DEFAULT 'driving',
    distance_meters   INTEGER,                             -- meters (C-13)
    duration_minutes  INTEGER,
    source            TEXT NOT NULL DEFAULT 'google_maps',
    status            TEXT NOT NULL DEFAULT 'pending',
        -- pending | success | failed | missing_address | address_needs_review | stale
    cache_key         TEXT,
    error_code        TEXT,
    error_message     TEXT,
    calculated_at     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    stale_at          TIMESTAMPTZ
);

-- Idempotency (C-7 / security req #8): one ACTIVE segment per tenant/tech/day/pair.
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_segment_active
    ON schedule_route_segments (company_id, technician_id, schedule_date, from_job_id, to_job_id)
    WHERE status <> 'stale';

-- Fast schedule read lookup.
CREATE INDEX IF NOT EXISTS idx_route_segment_read
    ON schedule_route_segments (company_id, technician_id, schedule_date)
    WHERE status <> 'stale';

-- Retention helper (C-13): find old stale rows to purge.
CREATE INDEX IF NOT EXISTS idx_route_segment_stale
    ON schedule_route_segments (stale_at)
    WHERE status = 'stale';

-- ── route_calculation_cache — GLOBAL (no company_id), distance between coords (C-4) ─
-- A distance between two points is tenant-independent; a global cache maximises
-- hit rate and Google cost savings. Stores only distance/duration (no PII).
CREATE TABLE IF NOT EXISTS route_calculation_cache (
    id                    BIGSERIAL PRIMARY KEY,
    origin_latitude       NUMERIC(8,5) NOT NULL,           -- rounded to 5 decimals
    origin_longitude      NUMERIC(8,5) NOT NULL,
    destination_latitude  NUMERIC(8,5) NOT NULL,
    destination_longitude NUMERIC(8,5) NOT NULL,
    travel_mode           TEXT NOT NULL DEFAULT 'driving',
    source                TEXT NOT NULL DEFAULT 'google_maps',
    cache_key             TEXT NOT NULL,
    distance_meters       INTEGER,
    duration_minutes      INTEGER,
    status                TEXT NOT NULL DEFAULT 'success',  -- success | failed
    error_code            TEXT,
    error_message         TEXT,
    calculated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deterministic global key: "driving:<olat>,<olng>:<dlat>,<dlng>" (rounded, C-4).
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_cache_key
    ON route_calculation_cache (cache_key);
