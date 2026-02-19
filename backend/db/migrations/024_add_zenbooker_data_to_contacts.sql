-- Migration: Add zenbooker_data JSONB column to contacts
-- Stores the full Zenbooker customer payload for displaying all fields

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contacts' AND column_name = 'zenbooker_data'
    ) THEN
        ALTER TABLE contacts ADD COLUMN zenbooker_data JSONB DEFAULT '{}'::jsonb;
    END IF;
END $$;

-- Also add secondary_phone if not exists
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contacts' AND column_name = 'secondary_phone'
    ) THEN
        ALTER TABLE contacts ADD COLUMN secondary_phone TEXT;
    END IF;
END $$;
