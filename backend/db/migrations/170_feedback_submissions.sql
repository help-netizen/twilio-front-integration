-- =============================================================================
-- Migration 170: In-app product feedback — CLIENT-FEEDBACK-WIDGET-001.
--
-- The tenant-scoped row is the source of truth. Attachments are delivered only
-- by best-effort email; their metadata and delivery status live in meta.
-- =============================================================================

CREATE TABLE IF NOT EXISTS feedback_submissions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES crm_users(id),
    user_email      TEXT NOT NULL,
    message         TEXT NOT NULL,
    meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_company_created
    ON feedback_submissions (company_id, created_at DESC);
