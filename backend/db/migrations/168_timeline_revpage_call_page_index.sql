-- TIMELINE-REVPAGE-001: reverse-cursor page over a thread's parent calls.
-- COALESCE(started_at, created_at) is the canonical feed timestamp (matches the FE).
CREATE INDEX IF NOT EXISTS idx_calls_timeline_page
    ON calls (timeline_id, (COALESCE(started_at, created_at)) DESC, id DESC)
    WHERE parent_call_sid IS NULL;
