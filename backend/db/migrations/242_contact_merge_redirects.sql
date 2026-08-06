-- 242_contact_merge_redirects.sql
-- ZB-DECOUPLE-001 Phase B / B3: durable contact merge redirects/review queue.

CREATE TABLE IF NOT EXISTS contact_merge_redirects (
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    old_contact_id      BIGINT NOT NULL,
    survivor_contact_id BIGINT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('merged', 'needs_review')),
    review_reasons      JSONB NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(review_reasons) = 'array'),
    details             JSONB NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(details) = 'object'),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    merged_at           TIMESTAMPTZ,

    PRIMARY KEY (company_id, old_contact_id),
    CHECK (old_contact_id <> survivor_contact_id),
    CHECK (
        (status = 'merged' AND merged_at IS NOT NULL AND review_reasons = '[]'::jsonb)
        OR
        (status = 'needs_review' AND merged_at IS NULL AND jsonb_array_length(review_reasons) > 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_contact_merge_redirects_survivor
    ON contact_merge_redirects (company_id, survivor_contact_id);

-- The audit ids deliberately are not FKs to contacts. old_contact_id must remain
-- a durable redirect even if archived contacts are physically purged years later,
-- and making it an FK would also make the redirect itself a permanent donor
-- reference that the B3 zero-reference assertion could never clear.
COMMENT ON TABLE contact_merge_redirects IS
    'Tenant-scoped durable old-contact redirect and contact-merge review audit.';

-- Moving a Stripe customer mapping must move its saved-card rows in the same
-- statement. Cascade the composite key update so both contact FKs stay valid and
-- donor-only Stripe customers/cards can be rehomed without detaching a card.
ALTER TABLE stripe_saved_payment_methods
    DROP CONSTRAINT IF EXISTS stripe_saved_payment_methods_stripe_contact_customer_id_co_fkey;

ALTER TABLE stripe_saved_payment_methods
    ADD CONSTRAINT stripe_saved_payment_methods_stripe_contact_customer_id_co_fkey
    FOREIGN KEY (stripe_contact_customer_id, company_id, contact_id)
    REFERENCES stripe_contact_customers(id, company_id, contact_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE;
