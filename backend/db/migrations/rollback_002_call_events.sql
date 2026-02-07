-- Rollback for Migration 002: Create call_events table
-- Purpose: Drop call_events table
-- Author: System
-- Date: 2026-02-07

DROP TABLE IF EXISTS call_events CASCADE;
