-- OB-70 / INVOICE-REMOVE-001: durable invoice removal and payment provenance.
-- This migration is intentionally structural; legacy discovery/repair lives in
-- scripts/audit-invoice-removal-data.js and is company-scoped.

ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS origin_invoice_id BIGINT
        REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_tx_company_origin_invoice
    ON payment_transactions(company_id, origin_invoice_id)
    WHERE origin_invoice_id IS NOT NULL;

COMMENT ON COLUMN payment_transactions.origin_invoice_id IS
    'Invoice that originally received the payment; invoice_id is the current application marker.';

CREATE TABLE IF NOT EXISTS invoice_removals (
    id                          BIGSERIAL PRIMARY KEY,
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_invoice_id           BIGINT NOT NULL,
    source_invoice_number       VARCHAR(50) NOT NULL,
    source_job_id               BIGINT,
    disposition                 TEXT NOT NULL CHECK (disposition IN ('delete', 'void')),
    payment_action              TEXT NOT NULL CHECK (payment_action IN ('leave_unapplied', 'apply')),
    target_invoice_id           BIGINT,
    target_invoice_number       VARCHAR(50),
    detached_amount             NUMERIC(12,2) NOT NULL DEFAULT 0,
    detached_payment_count      INTEGER NOT NULL DEFAULT 0,
    detached_transaction_count  INTEGER NOT NULL DEFAULT 0,
    currency                    VARCHAR(3) NOT NULL DEFAULT 'USD',
    preview_version             CHAR(64) NOT NULL,
    request_id                  VARCHAR(100) NOT NULL,
    actor_id                    UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    invoice_snapshot            JSONB NOT NULL,
    payment_snapshot            JSONB NOT NULL DEFAULT '[]'::jsonb,
    response                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_invoice_removals_company_source
        UNIQUE (company_id, source_invoice_id),
    CONSTRAINT uq_invoice_removals_company_request
        UNIQUE (company_id, request_id),
    CONSTRAINT ck_invoice_removals_target
        CHECK (
            (payment_action = 'leave_unapplied' AND target_invoice_id IS NULL)
            OR (payment_action = 'apply' AND target_invoice_id IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_invoice_removals_company_created
    ON invoice_removals(company_id, created_at DESC);

COMMENT ON TABLE invoice_removals IS
    'OB-70 durable audit/idempotency record for unified invoice removal.';
