-- =============================================================================
-- Migration 015: Add company_id to api_integrations
-- Links each API key to the company whose leads it creates.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_integrations' AND column_name = 'company_id'
    ) THEN
        ALTER TABLE api_integrations
            ADD COLUMN company_id UUID REFERENCES companies(id);

        -- Backfill existing keys with the default company
        UPDATE api_integrations
            SET company_id = '00000000-0000-0000-0000-000000000001'
            WHERE company_id IS NULL;

        ALTER TABLE api_integrations
            ALTER COLUMN company_id SET NOT NULL;

        RAISE NOTICE 'Added company_id to api_integrations';
    ELSE
        RAISE NOTICE 'api_integrations already has company_id, skipping';
    END IF;
END $$;
