-- Migration 004: Alter messages table for event-driven updates
-- Purpose: Add fields to support realtime updates, reconciliation, and state tracking
-- Author: System
-- Date: 2026-02-07

-- Add new columns
ALTER TABLE messages 
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  ADD COLUMN IF NOT EXISTS last_event_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_final BOOLEAN DEFAULT FALSE NOT NULL,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_state TEXT DEFAULT 'active' NOT NULL;

-- Partial index for active calls (hot reconcile optimization)
CREATE INDEX IF NOT EXISTS idx_messages_active_status 
  ON messages(status, start_time DESC) 
  WHERE status IN ('queued', 'initiated', 'ringing', 'in-progress');

-- Delta query support (for incremental sync)
CREATE INDEX IF NOT EXISTS idx_messages_updated_at 
  ON messages(updated_at DESC);

-- Parent-child lookups (for call merging)
CREATE INDEX IF NOT EXISTS idx_messages_parent_call_sid 
  ON messages(parent_call_sid) 
  WHERE parent_call_sid IS NOT NULL;

-- Trigger to auto-update updated_at column
-- (Reuse existing function from schema.sql)
DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;
CREATE TRIGGER update_messages_updated_at 
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON COLUMN messages.updated_at IS 'Auto-updated timestamp for delta queries and change tracking';
COMMENT ON COLUMN messages.last_event_time IS 'Timestamp of last event that updated this record (guards against out-of-order)';
COMMENT ON COLUMN messages.is_final IS 'True if call reached terminal status (completed/busy/no-answer/failed/canceled)';
COMMENT ON COLUMN messages.finalized_at IS 'When call reached final status (for warm reconcile window)';
COMMENT ON COLUMN messages.sync_state IS 'Lifecycle: active (being synced) → frozen (no longer polled)';
