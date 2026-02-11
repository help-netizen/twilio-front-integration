-- =============================================================================
-- Migration 012: Add company_id to all domain tables
-- Multi-tenant data isolation
-- =============================================================================

-- Default company UUID for backfill
-- Must match the seed in 010_create_companies.sql
DO $$
DECLARE
    default_company_id UUID := '00000000-0000-0000-0000-000000000001';
    tbl TEXT;
BEGIN

    -- All domain tables that need tenant isolation
    FOREACH tbl IN ARRAY ARRAY[
        'leads',
        'lead_team_assignments',
        'lead_custom_fields',
        'lead_job_types',
        'call_events',
        'calls',
        'contacts',
        'recordings',
        'transcripts',
        'transcription_jobs',
        'webhook_inbox',
        'api_integrations'
    ] LOOP
        -- Skip if column already exists
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = tbl AND column_name = 'company_id' AND table_schema = 'public'
        ) THEN
            -- Skip if table doesn't exist (some may not be in this environment)
            IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_name = tbl AND table_schema = 'public'
            ) THEN
                EXECUTE format('ALTER TABLE %I ADD COLUMN company_id UUID REFERENCES companies(id)', tbl);
                EXECUTE format('UPDATE %I SET company_id = %L WHERE company_id IS NULL', tbl, default_company_id);
                EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL', tbl);
                EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_company_id ON %I(company_id)', tbl, tbl);
                RAISE NOTICE 'Added company_id to %', tbl;
            ELSE
                RAISE NOTICE 'Table % does not exist, skipping', tbl;
            END IF;
        ELSE
            RAISE NOTICE 'Table % already has company_id, skipping', tbl;
        END IF;
    END LOOP;

    -- Backfill crm_users
    UPDATE crm_users SET company_id = default_company_id WHERE company_id IS NULL;

END $$;
