DROP TABLE IF EXISTS technician_merge_audits;

DROP INDEX IF EXISTS idx_technicians_merged_into;

ALTER TABLE technicians
    DROP CONSTRAINT IF EXISTS technicians_merge_state_check,
    DROP CONSTRAINT IF EXISTS technicians_merged_into_fk,
    DROP COLUMN IF EXISTS merged_at,
    DROP COLUMN IF EXISTS merged_into;
