-- Migration 003: Create sync_state table
-- Purpose: Track reconciliation job cursors for restart-safe processing
-- Author: System
-- Date: 2026-02-07

CREATE TABLE IF NOT EXISTS sync_state (
  job_name TEXT PRIMARY KEY,               -- 'reconcile_hot', 'reconcile_warm', 'reconcile_cold'
  
  -- Cursor for resume
  cursor JSONB NOT NULL DEFAULT '{}',      -- { "last_call_sid": "CA123", "last_updated_at": "2026-02-07T00:00:00Z" }
  
  -- Job health tracking
  last_success_at TIMESTAMPTZ,             -- Last successful completion
  last_error_at TIMESTAMPTZ,               -- Last error occurrence
  last_error TEXT,                         -- Error message
  
  -- Metadata
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comments
COMMENT ON TABLE sync_state IS 'Reconciliation job state for restart-safe processing';
COMMENT ON COLUMN sync_state.cursor IS 'Job-specific cursor data for resuming from last position';
COMMENT ON COLUMN sync_state.job_name IS 'Unique job identifier: reconcile_hot, reconcile_warm, reconcile_cold';
