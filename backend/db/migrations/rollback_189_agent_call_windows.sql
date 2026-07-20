-- Rollback AGENT-CALL-WINDOW-001 schema additions.
-- The stale full-name user_group_hours rows deleted by migration 189 are not
-- reconstructed: their values conflicted with the live short-name schedule and
-- restoring guessed inbound hours would be unsafe.

ALTER TABLE user_group_hours
    DROP CONSTRAINT IF EXISTS chk_user_group_hours_canonical_weekday;

ALTER TABLE outbound_call_settings
    DROP CONSTRAINT IF EXISTS chk_oc_calling_window_shape,
    DROP CONSTRAINT IF EXISTS chk_oc_calling_window_mode,
    DROP COLUMN IF EXISTS calling_window_work_days,
    DROP COLUMN IF EXISTS custom_end_time,
    DROP COLUMN IF EXISTS custom_start_time,
    DROP COLUMN IF EXISTS calling_window_mode;

ALTER TABLE outbound_lead_call_settings
    DROP CONSTRAINT IF EXISTS chk_olc_calling_window_shape,
    DROP CONSTRAINT IF EXISTS chk_olc_calling_window_mode;

UPDATE outbound_lead_call_settings
SET calling_window_mode = 'office_hours',
    custom_start_time = NULL,
    custom_end_time = NULL
WHERE calling_window_mode IS NULL;

ALTER TABLE outbound_lead_call_settings
    ALTER COLUMN calling_window_mode SET DEFAULT 'office_hours',
    ALTER COLUMN calling_window_mode SET NOT NULL,
    DROP COLUMN IF EXISTS calling_window_work_days;

ALTER TABLE outbound_lead_call_settings
    ADD CONSTRAINT chk_olc_calling_window_mode
    CHECK (calling_window_mode IN ('office_hours', 'always', 'custom'));
