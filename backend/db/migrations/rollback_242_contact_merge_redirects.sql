-- rollback_242_contact_merge_redirects.sql

ALTER TABLE stripe_saved_payment_methods
    DROP CONSTRAINT IF EXISTS stripe_saved_payment_methods_stripe_contact_customer_id_co_fkey;

ALTER TABLE stripe_saved_payment_methods
    ADD CONSTRAINT stripe_saved_payment_methods_stripe_contact_customer_id_co_fkey
    FOREIGN KEY (stripe_contact_customer_id, company_id, contact_id)
    REFERENCES stripe_contact_customers(id, company_id, contact_id)
    ON DELETE CASCADE;

DROP TABLE IF EXISTS contact_merge_redirects;
