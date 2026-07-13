-- =============================================================================
-- Migration 169: Twilio Port-In requests — TELEPHONY-WIZARD-UX-001 (T2).
--
-- The active-phone partial unique index is the concurrency guard for the
-- DB-first create flow: only terminal requests release a number for retry.
-- Utility-bill bytes are never stored here; documents contains Twilio SIDs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS port_in_requests (
    id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    phone_number                 TEXT NOT NULL,
    status                       TEXT NOT NULL DEFAULT 'submitted'
                                 CHECK (status IN (
                                     'submitted', 'pending', 'in_review',
                                     'action_required', 'completed',
                                     'canceled', 'failed'
                                 )),
    twilio_port_in_sid           TEXT,
    twilio_status                TEXT,
    losing_carrier_info          JSONB NOT NULL DEFAULT '{}'::jsonb,
    documents                    JSONB NOT NULL DEFAULT '[]'::jsonb,
    account_number               TEXT,
    pin                          TEXT,
    account_telephone_number     TEXT,
    signature_request_url        TEXT,
    target_port_in_date          DATE,
    notes                        TEXT,
    created_by                   UUID REFERENCES crm_users(id),
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_port_in_requests_company
    ON port_in_requests (company_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_port_in_requests_active_phone
    ON port_in_requests (company_id, phone_number)
    WHERE status NOT IN ('canceled', 'failed', 'completed');

