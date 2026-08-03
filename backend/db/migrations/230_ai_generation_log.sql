-- AI-GEN-LOG-001: append-only log of every AI estimate/invoice draft generation.
-- Owner analyzes accumulated entries to tune Price Book matching (wrong-category
-- selections observed, e.g. range-hood repair drafted as dryer drain pump).
-- DB is the durable store (the app container has no host mounts — a file would
-- die on every rebuild); the Markdown "file" is rendered from these rows.

CREATE TABLE IF NOT EXISTS ai_generation_log (
    id           BIGSERIAL PRIMARY KEY,
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    crm_user_id  UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    job_id       BIGINT,
    report_text  TEXT NOT NULL,
    summary      TEXT,
    line_items   JSONB NOT NULL DEFAULT '[]'::jsonb,
    order_list   JSONB NOT NULL DEFAULT '[]'::jsonb,
    model        TEXT,
    duration_ms  INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_generation_log_company_created
    ON ai_generation_log(company_id, created_at);
