-- CARD-ON-FILE-001: tenant-scoped Stripe Customers and short-lived saved cards.
-- Stripe remains the PCI vault. These tables store only Stripe object ids and
-- display metadata; a saved card is usable for at most 14 days from saved_at.

CREATE TABLE IF NOT EXISTS stripe_contact_customers (
    id                          BIGSERIAL PRIMARY KEY,
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id                  BIGINT NOT NULL,
    stripe_account_id           TEXT NOT NULL,
    stripe_customer_id          TEXT NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (company_id, contact_id)
        REFERENCES contacts(company_id, id) ON DELETE CASCADE,
    UNIQUE (company_id, contact_id),
    UNIQUE (company_id, stripe_account_id, stripe_customer_id),
    UNIQUE (id, company_id, contact_id)
);

CREATE TABLE IF NOT EXISTS stripe_saved_payment_methods (
    id                          BIGSERIAL PRIMARY KEY,
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id                  BIGINT NOT NULL,
    stripe_contact_customer_id  BIGINT NOT NULL,
    stripe_account_id           TEXT NOT NULL,
    stripe_customer_id          TEXT NOT NULL,
    stripe_payment_method_id    TEXT NOT NULL,
    brand                       TEXT NOT NULL,
    last4                       VARCHAR(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
    exp_month                   SMALLINT NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
    exp_year                    SMALLINT NOT NULL CHECK (exp_year BETWEEN 2000 AND 9999),
    saved_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at                  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
    last_used_at                TIMESTAMPTZ,
    removed_at                  TIMESTAMPTZ,
    removed_by                  UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (company_id, contact_id)
        REFERENCES contacts(company_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (stripe_contact_customer_id, company_id, contact_id)
        REFERENCES stripe_contact_customers(id, company_id, contact_id) ON DELETE CASCADE,
    UNIQUE (company_id, stripe_account_id, stripe_payment_method_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_contact_customers_company_contact
    ON stripe_contact_customers(company_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_stripe_saved_methods_company_contact
    ON stripe_saved_payment_methods(company_id, contact_id, saved_at DESC)
    WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_saved_methods_cleanup
    ON stripe_saved_payment_methods(expires_at, company_id)
    WHERE removed_at IS NULL;

DROP TRIGGER IF EXISTS trg_stripe_contact_customers_updated_at ON stripe_contact_customers;
CREATE TRIGGER trg_stripe_contact_customers_updated_at
    BEFORE UPDATE ON stripe_contact_customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_stripe_saved_payment_methods_updated_at ON stripe_saved_payment_methods;
CREATE TRIGGER trg_stripe_saved_payment_methods_updated_at
    BEFORE UPDATE ON stripe_saved_payment_methods
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE stripe_payment_sessions
    ADD COLUMN IF NOT EXISTS request_key UUID;

ALTER TABLE stripe_payment_sessions
    DROP CONSTRAINT IF EXISTS stripe_payment_sessions_surface_check;
ALTER TABLE stripe_payment_sessions
    ADD CONSTRAINT stripe_payment_sessions_surface_check
    CHECK (surface IN ('checkout_link','manual_card','tap_to_pay','saved_card'));

CREATE UNIQUE INDEX IF NOT EXISTS uniq_stripe_sessions_company_request_key
    ON stripe_payment_sessions(company_id, request_key)
    WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_stripe_saved_card_open_job
    ON stripe_payment_sessions(company_id, job_id)
    WHERE surface = 'saved_card' AND status = 'open' AND job_id IS NOT NULL;

COMMENT ON TABLE stripe_contact_customers IS
    'CARD-ON-FILE-001: one Stripe Customer mapping per tenant contact and connected account generation.';
COMMENT ON TABLE stripe_saved_payment_methods IS
    'CARD-ON-FILE-001: PCI-safe card display cache; server-enforced charge TTL is 14 days from saved_at.';
