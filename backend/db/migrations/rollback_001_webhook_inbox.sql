-- Rollback for Migration 001: Create twilio_webhook_inbox table
-- Purpose: Drop webhook inbox table
-- Author: System
-- Date: 2026-02-07

DROP TABLE IF EXISTS twilio_webhook_inbox CASCADE;
