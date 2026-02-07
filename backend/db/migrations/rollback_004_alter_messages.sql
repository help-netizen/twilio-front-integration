-- Rollback for Migration 004: Alter messages table
-- Purpose: Remove event-driven update fields from messages table
-- Author: System
-- Date: 2026-02-07

-- Drop trigger
DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;

-- Drop indexes
DROP INDEX IF EXISTS idx_messages_parent_call_sid;
DROP INDEX IF EXISTS idx_messages_updated_at;
DROP INDEX IF EXISTS idx_messages_active_status;

-- Drop columns
ALTER TABLE messages 
  DROP COLUMN IF EXISTS sync_state,
  DROP COLUMN IF EXISTS finalized_at,
  DROP COLUMN IF EXISTS is_final,
  DROP COLUMN IF EXISTS last_event_time,
  DROP COLUMN IF EXISTS updated_at;
