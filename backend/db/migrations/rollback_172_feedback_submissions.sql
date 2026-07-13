-- =============================================================================
-- Rollback migration 170 — CLIENT-FEEDBACK-WIDGET-001 feedback submissions.
-- The company/created index is dropped with the table.
-- =============================================================================

DROP TABLE IF EXISTS feedback_submissions;
