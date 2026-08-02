DROP INDEX IF EXISTS uniq_stripe_saved_card_open_job;
DROP INDEX IF EXISTS uniq_stripe_sessions_company_request_key;

DELETE FROM stripe_payment_sessions WHERE surface = 'saved_card';
ALTER TABLE stripe_payment_sessions
    DROP CONSTRAINT IF EXISTS stripe_payment_sessions_surface_check;
ALTER TABLE stripe_payment_sessions
    ADD CONSTRAINT stripe_payment_sessions_surface_check
    CHECK (surface IN ('checkout_link','manual_card','tap_to_pay'));
ALTER TABLE stripe_payment_sessions DROP COLUMN IF EXISTS request_key;

DROP TABLE IF EXISTS stripe_saved_payment_methods;
DROP TABLE IF EXISTS stripe_contact_customers;

