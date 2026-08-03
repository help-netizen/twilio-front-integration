-- Migration 232 — APP-DATA-001 Phase F: durable, coalesced app event delivery.

CREATE TABLE IF NOT EXISTS app_event_deliveries (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL,
    installation_id     BIGINT NOT NULL,
    event_type          TEXT NOT NULL,
    payload             JSONB NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                                'pending', 'running', 'delivered', 'failed', 'coalesced'
                            )),
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    coalesced_count     INTEGER NOT NULL DEFAULT 0 CHECK (coalesced_count >= 0),
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_app_event_deliveries_installation
        FOREIGN KEY (company_id, installation_id)
        REFERENCES marketplace_installations(company_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_app_event_deliveries_event_type
        CHECK (char_length(event_type) BETWEEN 1 AND 100),
    CONSTRAINT chk_app_event_deliveries_payload_object
        CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_app_event_deliveries_due
    ON app_event_deliveries(status, next_attempt_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_event_deliveries_active
    ON app_event_deliveries(company_id, installation_id, event_type)
    WHERE status IN ('pending', 'running');

COMMENT ON TABLE app_event_deliveries IS
    'APP-DATA-001 Phase F outbox populated after domain-event commit and dispatched through the app execution core.';
COMMENT ON COLUMN app_event_deliveries.coalesced_count IS
    'Number of newer same-type events folded into this active delivery; payload always holds the newest projection.';
