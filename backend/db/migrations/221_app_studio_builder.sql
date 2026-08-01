-- Migration 221 — APP-BUILD-001: App Studio Phase 3 builder backend.

CREATE TABLE IF NOT EXISTS app_studio_apps (
    app_id          BIGINT PRIMARY KEY REFERENCES marketplace_apps(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_app_studio_apps_company_app UNIQUE (company_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_app_studio_apps_company_created
    ON app_studio_apps(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_build_chats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    app_id          BIGINT,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    title           TEXT NOT NULL DEFAULT 'New app' CHECK (char_length(title) BETWEEN 1 AND 160),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_app_build_chats_company_id UNIQUE (company_id, id),
    CONSTRAINT fk_app_build_chats_owned_app
        FOREIGN KEY (company_id, app_id)
        REFERENCES app_studio_apps(company_id, app_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_app_build_chats_company_updated
    ON app_build_chats(company_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS app_build_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    chat_id         UUID NOT NULL,
    app_id          BIGINT,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text            TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 16000),
    model           TEXT,
    token_usage     JSONB NOT NULL DEFAULT '{}'::jsonb,
    version_id      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_app_build_messages_token_usage_object
        CHECK (jsonb_typeof(token_usage) = 'object'),
    CONSTRAINT chk_app_build_messages_version_linkage
        CHECK ((app_id IS NULL AND version_id IS NULL)
            OR (app_id IS NOT NULL AND version_id IS NOT NULL)),
    CONSTRAINT fk_app_build_messages_chat
        FOREIGN KEY (company_id, chat_id)
        REFERENCES app_build_chats(company_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_app_build_messages_owned_app
        FOREIGN KEY (company_id, app_id)
        REFERENCES app_studio_apps(company_id, app_id) ON DELETE RESTRICT,
    CONSTRAINT fk_app_build_messages_version
        FOREIGN KEY (app_id, version_id)
        REFERENCES app_versions(app_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_app_build_messages_chat_created
    ON app_build_messages(company_id, chat_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_app_build_messages_version
    ON app_build_messages(company_id, app_id, version_id)
    WHERE version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_builder_usage_counters (
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    usage_date          DATE NOT NULL,
    generations_used    INTEGER NOT NULL DEFAULT 0 CHECK (generations_used >= 0),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, usage_date)
);

COMMENT ON TABLE app_studio_apps IS
    'Tenant ownership boundary for private apps created by App Studio.';
COMMENT ON TABLE app_build_chats IS
    'Company-scoped App Studio builder conversations; app_id is null until the first valid artifact.';
COMMENT ON TABLE app_build_messages IS
    'Scrubbed App Studio conversation log with model usage and optional created-version linkage.';
COMMENT ON TABLE app_builder_usage_counters IS
    'UTC daily company generation quota counters for platform-paid App Studio code generation.';
