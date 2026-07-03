-- =============================================================================
-- Migration 152: MAIL-AGENT-001 — Mail Secretary AI triage of inbound email.
--
-- Per-company agent settings + a per-email decision log (dedup + transparency).
-- The marketplace app row already exists (mig 087, app_key='mail-secretary');
-- here we only point its card at the new setup page.
-- =============================================================================

CREATE TABLE IF NOT EXISTS mail_agent_settings (
    company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    confidence_threshold REAL NOT NULL DEFAULT 0.6
        CHECK (confidence_threshold >= 0 AND confidence_threshold <= 1),
    create_contact_for_unknown BOOLEAN NOT NULL DEFAULT TRUE,
    assign_owner_user_id UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    -- Raw exclusion rules, one mini-query per line; parsed on read (mailAgentRules).
    exclusion_rules TEXT NOT NULL DEFAULT '',
    updated_by UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mail_agent_reviews (
    id BIGSERIAL PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email_message_id BIGINT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL CHECK (verdict IN
        ('task_created', 'skipped_excluded', 'skipped_no_attention',
         'skipped_low_confidence', 'skipped_unknown_sender', 'error')),
    category TEXT,
    confidence REAL,
    reason TEXT,
    -- 1-based line number of the exclusion rule that matched (verdict=skipped_excluded).
    rule_line INT,
    task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
    model TEXT,
    latency_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Dedup: one decision per email (re-pushed Gmail notifications are no-ops).
    CONSTRAINT mail_agent_reviews_company_message_uniq UNIQUE (company_id, email_message_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_agent_reviews_company_created
    ON mail_agent_reviews (company_id, created_at DESC);

-- Point the existing marketplace card at the setup page (jsonb || merges keys,
-- safe when metadata already has other keys; mig-087 seed has a non-null metadata).
UPDATE marketplace_apps
SET metadata = metadata || '{"setup_path": "/settings/integrations/mail-secretary"}'::jsonb,
    updated_at = NOW()
WHERE app_key = 'mail-secretary';
