-- =============================================================================
-- Migration 174: CRM-expert assistant transcripts and provider spend controls.
--
-- Transcripts are deliberately company-agnostic and contain no user identity.
-- The separate usage counter is operational only and never feeds model context.
-- =============================================================================

CREATE TABLE IF NOT EXISTS assistant_transcripts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_key     TEXT NOT NULL,
    turn_index      INTEGER NOT NULL CHECK (turn_index >= 0),
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text            TEXT NOT NULL,
    tools_used      JSONB NOT NULL DEFAULT '[]'::jsonb,
    model           TEXT,
    latency_ms      INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    token_usage     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_key, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_assistant_transcripts_session_turn
    ON assistant_transcripts (session_key, turn_index);

CREATE TABLE IF NOT EXISTS assistant_usage_counters (
    company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    usage_date         DATE NOT NULL,
    tokens_used        BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
    tokens_reserved    BIGINT NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
    window_started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_requests    INTEGER NOT NULL DEFAULT 0 CHECK (window_requests >= 0),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, usage_date)
);
