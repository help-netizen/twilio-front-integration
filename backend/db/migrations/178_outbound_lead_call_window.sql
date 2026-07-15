-- OLC-WINDOW-001 — configurable calling window for the Outbound Lead Caller.
-- Adds a per-company window MODE to outbound_lead_call_settings:
--   'office_hours' (default — the existing behaviour: dispatch business hours),
--   'always'       (24/7 — no window restriction),
--   'custom'       (a daily HH:MM..HH:MM window in the company timezone).
-- Backfill-safe: every existing row keeps the pre-feature behaviour via the
-- 'office_hours' default. Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE outbound_lead_call_settings
    ADD COLUMN IF NOT EXISTS calling_window_mode TEXT NOT NULL DEFAULT 'office_hours',
    ADD COLUMN IF NOT EXISTS custom_start_time   TEXT,
    ADD COLUMN IF NOT EXISTS custom_end_time     TEXT;

-- Constrain the mode to the three supported values (drop-then-add = idempotent).
ALTER TABLE outbound_lead_call_settings
    DROP CONSTRAINT IF EXISTS chk_olc_calling_window_mode;
ALTER TABLE outbound_lead_call_settings
    ADD  CONSTRAINT chk_olc_calling_window_mode
    CHECK (calling_window_mode IN ('office_hours', 'always', 'custom'));

COMMENT ON COLUMN outbound_lead_call_settings.calling_window_mode IS
    'OLC-WINDOW-001: office_hours (dispatch business hours) | always (24/7) | custom (custom_start_time..custom_end_time daily).';
COMMENT ON COLUMN outbound_lead_call_settings.custom_start_time IS
    'OLC-WINDOW-001: HH:MM local window start; used only when calling_window_mode = custom.';
COMMENT ON COLUMN outbound_lead_call_settings.custom_end_time IS
    'OLC-WINDOW-001: HH:MM local window end (> start, same day); used only when calling_window_mode = custom.';
