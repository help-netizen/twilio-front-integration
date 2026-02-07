-- Migration 001: Create twilio_webhook_inbox table
-- Purpose: Reliable webhook ingestion with deduplication and retry support
-- Author: System
-- Date: 2026-02-07

CREATE TABLE IF NOT EXISTS twilio_webhook_inbox (
  id BIGSERIAL PRIMARY KEY,
  
  -- Event identification
  source TEXT NOT NULL,                    -- 'twilio_voice', 'twilio_recording'
  event_type TEXT NOT NULL,                -- 'call-status', 'recording-complete'
  call_sid VARCHAR(100),                   -- Twilio Call SID (CAxxxxx)
  recording_sid VARCHAR(100),              -- Twilio Recording SID (RExxxxx)
  
  -- Idempotency
  dedupe_key VARCHAR(255) UNIQUE NOT NULL, -- e.g., 'call:CA123:completed:1234567890'
  
  -- Payload and metadata
  payload JSONB NOT NULL,                  -- Full Twilio webhook payload
  received_at TIMESTAMPTZ DEFAULT NOW(),   -- When webhook was received
  
  -- Processing state
  processed_at TIMESTAMPTZ,                -- When processing completed
  processing_status TEXT DEFAULT 'pending' NOT NULL, -- 'pending', 'processing', 'completed', 'failed', 'dead_letter'
  error TEXT,                              -- Error message if failed
  retry_count INTEGER DEFAULT 0 NOT NULL   -- Number of retry attempts
);

-- Indexes for performance
CREATE INDEX idx_inbox_pending ON twilio_webhook_inbox(received_at) 
  WHERE processing_status = 'pending';

CREATE INDEX idx_inbox_processing ON twilio_webhook_inbox(received_at) 
  WHERE processing_status = 'processing';

CREATE INDEX idx_inbox_call_sid ON twilio_webhook_inbox(call_sid) 
  WHERE call_sid IS NOT NULL;

CREATE INDEX idx_inbox_status ON twilio_webhook_inbox(processing_status, received_at DESC);

-- Comments
COMMENT ON TABLE twilio_webhook_inbox IS 'Reliable webhook ingestion queue with idempotency and retry support';
COMMENT ON COLUMN twilio_webhook_inbox.dedupe_key IS 'Unique key for deduplication: format call:SID:status:timestamp';
COMMENT ON COLUMN twilio_webhook_inbox.processing_status IS 'Workflow: pending → processing → completed/failed → dead_letter after max retries';
