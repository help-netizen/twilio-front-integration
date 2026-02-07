-- Migration 002: Create call_events table
-- Purpose: Immutable event log for call lifecycle audit and debugging
-- Author: System
-- Date: 2026-02-07

CREATE TABLE IF NOT EXISTS call_events (
  id BIGSERIAL PRIMARY KEY,
  
  -- Event identification
  call_sid VARCHAR(100) NOT NULL,          -- Twilio Call SID
  event_type TEXT NOT NULL,                -- 'call.created', 'call.status_changed', 'recording.ready'
  event_status TEXT,                       -- 'queued', 'ringing', 'completed', etc.
  
  -- Timing
  event_time TIMESTAMPTZ NOT NULL,         -- When event occurred (from Twilio timestamp)
  created_at TIMESTAMPTZ DEFAULT NOW(),    -- When we recorded it in our system
  
  -- Source tracking
  source TEXT NOT NULL,                    -- 'webhook', 'reconcile_hot', 'reconcile_warm', 'reconcile_cold'
  
  -- Full payload for debugging
  payload JSONB NOT NULL
);

-- Indexes for performance
CREATE INDEX idx_events_call_time ON call_events(call_sid, event_time DESC);
CREATE INDEX idx_events_type_time ON call_events(event_type, event_time DESC);
CREATE INDEX idx_events_created ON call_events(created_at DESC);
CREATE INDEX idx_events_source ON call_events(source, created_at DESC);

-- Comments
COMMENT ON TABLE call_events IS 'Immutable event log for call lifecycle - never modified, only appended';
COMMENT ON COLUMN call_events.event_time IS 'Event time from Twilio (used for ordering and deduplication)';
COMMENT ON COLUMN call_events.created_at IS 'When event was recorded in our system (for drift analysis)';
COMMENT ON COLUMN call_events.source IS 'How event was discovered: webhook (realtime) or reconcile job (backfill)';
