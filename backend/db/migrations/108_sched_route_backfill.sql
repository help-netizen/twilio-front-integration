-- ============================================================================
-- 108: SCHED-ROUTE-001 — geocoding_status backfill (SR-10)
-- Existing jobs that already carry coordinates (e.g. from AddressAutocomplete,
-- migration 041) are treated as successfully geocoded WITHOUT any paid Google
-- call. Jobs without coordinates keep the migration-107 default 'not_geocoded'
-- and will be geocoded lazily on next edit / by the seed script.
-- Idempotent — only rows still at the default are touched.
-- ============================================================================

UPDATE jobs
   SET geocoding_status   = 'success',
       geocoding_provider = COALESCE(geocoding_provider, 'backfill'),
       geocoded_at        = COALESCE(geocoded_at, now())
 WHERE lat IS NOT NULL
   AND lng IS NOT NULL
   AND geocoding_status = 'not_geocoded';
