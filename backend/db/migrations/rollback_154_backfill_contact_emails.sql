-- Rollback 154: EMAIL-UNREAD-001 backfill.
-- No-op by design: the backfill only materializes rows that SHOULD exist per
-- the dual-write canon (contactDedupeService), and distinguishing backfilled
-- rows from organically created ones is not possible. Leave them in place.
SELECT 1;
