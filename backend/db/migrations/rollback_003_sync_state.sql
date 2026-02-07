-- Rollback for Migration 003: Create sync_state table
-- Purpose: Drop sync_state table
-- Author: System
-- Date: 2026-02-07

DROP TABLE IF EXISTS sync_state CASCADE;
