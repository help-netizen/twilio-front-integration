-- Migration 027: Add secondary_phone_name to contacts and second_phone_name to leads
-- These fields store the name/label of the secondary phone owner (e.g. "Tenant — John")

DO $$
BEGIN
    -- contacts.secondary_phone_name
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contacts' AND column_name = 'secondary_phone_name'
    ) THEN
        ALTER TABLE contacts ADD COLUMN secondary_phone_name TEXT;
    END IF;

    -- leads.second_phone_name
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'leads' AND column_name = 'second_phone_name'
    ) THEN
        ALTER TABLE leads ADD COLUMN second_phone_name TEXT;
    END IF;
END
$$;
