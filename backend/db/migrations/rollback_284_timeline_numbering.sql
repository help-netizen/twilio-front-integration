-- Roll back TIMELINE-NUMBERING.

BEGIN;

DROP TRIGGER IF EXISTS trg_timelines_assign_public_code ON timelines;
DROP FUNCTION IF EXISTS timelines_assign_public_code();
DROP FUNCTION IF EXISTS timeline_public_code(BIGINT);

DROP INDEX IF EXISTS uq_timelines_public_code;

ALTER TABLE timelines
    DROP COLUMN IF EXISTS public_code;

COMMIT;
