-- MARKETPLACE-RATINGS-001: cross-company app ratings with moderated comments.
--
-- Ratings aggregate globally by app_key. company_id remains on each row for
-- tenant audit/context; uniqueness is intentionally one review per CRM user and
-- app across all of that user's memberships.

CREATE TABLE IF NOT EXISTS app_ratings (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    app_key             TEXT NOT NULL,
    user_id             UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
    stars               SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment             TEXT,
    status              TEXT NOT NULL CHECK (status IN ('posted', 'pending', 'rejected')),
    moderation_reason   TEXT,
    moderation_source   TEXT CHECK (moderation_source IN ('security', 'llm', 'manual')),
    moderated_by        UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_app_ratings_app_user UNIQUE (app_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_app_ratings_app_status
    ON app_ratings(app_key, status);

CREATE INDEX IF NOT EXISTS idx_app_ratings_status_created
    ON app_ratings(status, created_at);

DROP TRIGGER IF EXISTS trg_app_ratings_updated_at ON app_ratings;
CREATE TRIGGER trg_app_ratings_updated_at
    BEFORE UPDATE ON app_ratings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE app_ratings IS
    'Cross-company Marketplace ratings; comments are security/LLM/manual moderated.';
COMMENT ON COLUMN app_ratings.company_id IS
    'Tenant context at submission time; aggregates intentionally span companies by app_key.';
