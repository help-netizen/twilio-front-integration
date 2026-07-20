-- AGENT-CALL-WINDOW-001
--
-- Per-agent nullable call-window overrides. NULL means "inherit the company
-- dispatch schedule". Existing lead custom windows were daily, so their new
-- work-day list is backfilled to all seven days. Existing office_hours rows are
-- converted to the canonical NULL/inherit representation.
--
-- user_group_hours cleanup is deliberately behaviour-preserving: the inbound
-- matcher and active Telephony UI already use Mon..Sun, so those rows stay
-- byte-for-byte and only the stale Monday..Sunday duplicates are removed.

ALTER TABLE outbound_lead_call_settings
    ADD COLUMN IF NOT EXISTS calling_window_work_days JSONB;

UPDATE outbound_lead_call_settings
SET calling_window_mode = NULL,
    custom_start_time = NULL,
    custom_end_time = NULL,
    calling_window_work_days = NULL
WHERE calling_window_mode = 'office_hours';

UPDATE outbound_lead_call_settings
SET calling_window_work_days = '[0,1,2,3,4,5,6]'::jsonb
WHERE calling_window_mode = 'custom'
  AND calling_window_work_days IS NULL;

ALTER TABLE outbound_lead_call_settings
    ALTER COLUMN calling_window_mode DROP NOT NULL,
    ALTER COLUMN calling_window_mode DROP DEFAULT;

ALTER TABLE outbound_lead_call_settings
    DROP CONSTRAINT IF EXISTS chk_olc_calling_window_mode,
    DROP CONSTRAINT IF EXISTS chk_olc_calling_window_shape;

ALTER TABLE outbound_lead_call_settings
    ADD CONSTRAINT chk_olc_calling_window_mode
        CHECK (calling_window_mode IS NULL OR calling_window_mode IN ('always', 'custom')),
    ADD CONSTRAINT chk_olc_calling_window_shape CHECK (
        (calling_window_mode IS NULL
            AND custom_start_time IS NULL
            AND custom_end_time IS NULL
            AND calling_window_work_days IS NULL)
        OR
        (calling_window_mode = 'always'
            AND custom_start_time IS NULL
            AND custom_end_time IS NULL
            AND calling_window_work_days IS NULL)
        OR
        (calling_window_mode = 'custom'
            AND custom_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND custom_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND custom_start_time < custom_end_time
            AND jsonb_typeof(calling_window_work_days) = 'array'
            AND jsonb_array_length(calling_window_work_days) > 0
            AND calling_window_work_days <@ '[0,1,2,3,4,5,6]'::jsonb)
    );

ALTER TABLE outbound_call_settings
    ADD COLUMN IF NOT EXISTS calling_window_mode TEXT,
    ADD COLUMN IF NOT EXISTS custom_start_time TEXT,
    ADD COLUMN IF NOT EXISTS custom_end_time TEXT,
    ADD COLUMN IF NOT EXISTS calling_window_work_days JSONB;

ALTER TABLE outbound_call_settings
    DROP CONSTRAINT IF EXISTS chk_oc_calling_window_mode,
    DROP CONSTRAINT IF EXISTS chk_oc_calling_window_shape;

ALTER TABLE outbound_call_settings
    ADD CONSTRAINT chk_oc_calling_window_mode
        CHECK (calling_window_mode IS NULL OR calling_window_mode = 'custom'),
    ADD CONSTRAINT chk_oc_calling_window_shape CHECK (
        (calling_window_mode IS NULL
            AND custom_start_time IS NULL
            AND custom_end_time IS NULL
            AND calling_window_work_days IS NULL)
        OR
        (calling_window_mode = 'custom'
            AND custom_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND custom_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND custom_start_time < custom_end_time
            AND jsonb_typeof(calling_window_work_days) = 'array'
            AND jsonb_array_length(calling_window_work_days) > 0
            AND calling_window_work_days <@ '[0,1,2,3,4,5,6]'::jsonb)
    );

DELETE FROM user_group_hours
WHERE day_of_week IN (
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
);

ALTER TABLE user_group_hours
    DROP CONSTRAINT IF EXISTS chk_user_group_hours_canonical_weekday;
ALTER TABLE user_group_hours
    ADD CONSTRAINT chk_user_group_hours_canonical_weekday
    CHECK (day_of_week IN ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'));

COMMENT ON COLUMN outbound_lead_call_settings.calling_window_mode IS
    'AGENT-CALL-WINDOW-001: NULL inherits company dispatch schedule; custom is a per-agent override; always is retained for legacy rows.';
COMMENT ON COLUMN outbound_call_settings.calling_window_mode IS
    'AGENT-CALL-WINDOW-001: NULL inherits company dispatch schedule; custom is a per-agent override.';
COMMENT ON COLUMN user_group_hours.day_of_week IS
    'AGENT-CALL-WINDOW-001: canonical inbound-routing weekday, one of Mon..Sun.';
