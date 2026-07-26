-- =============================================================================
-- 210: ACTIVITY-LOG-001 P5 — global legacy History read cutover
-- =============================================================================

CREATE TABLE IF NOT EXISTS activity_log_config (
    key TEXT PRIMARY KEY,
    value TIMESTAMPTZ NOT NULL
);

INSERT INTO activity_log_config (key, value)
VALUES ('cutover_at', NOW())
ON CONFLICT (key) DO NOTHING;

