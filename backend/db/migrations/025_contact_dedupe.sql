-- Migration 025: Contact deduplication support
-- Adds first_name/last_name to contacts, creates contact_emails child table

-- 1. Add first_name and last_name columns
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contacts' AND column_name = 'first_name'
    ) THEN
        ALTER TABLE contacts ADD COLUMN first_name TEXT;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contacts' AND column_name = 'last_name'
    ) THEN
        ALTER TABLE contacts ADD COLUMN last_name TEXT;
    END IF;
END $$;

-- 2. Backfill first_name/last_name from full_name (split on first space)
UPDATE contacts
SET first_name = CASE
        WHEN full_name IS NULL THEN NULL
        WHEN POSITION(' ' IN TRIM(full_name)) > 0 THEN LEFT(TRIM(full_name), POSITION(' ' IN TRIM(full_name)) - 1)
        ELSE TRIM(full_name)
    END,
    last_name = CASE
        WHEN full_name IS NULL THEN NULL
        WHEN POSITION(' ' IN TRIM(full_name)) > 0 THEN SUBSTRING(TRIM(full_name) FROM POSITION(' ' IN TRIM(full_name)) + 1)
        ELSE NULL
    END
WHERE first_name IS NULL;

-- 3. Indexes on normalized first_name + last_name for fast candidate search
CREATE INDEX IF NOT EXISTS idx_contacts_name_lower
    ON contacts (LOWER(TRIM(first_name)), LOWER(TRIM(last_name)));

-- 4. Index on phone for fast phone matching
CREATE INDEX IF NOT EXISTS idx_contacts_phone
    ON contacts (phone_e164)
    WHERE phone_e164 IS NOT NULL;

-- 5. Create contact_emails table
CREATE TABLE IF NOT EXISTS contact_emails (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint: no duplicate emails per contact
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_contact_emails_contact_email'
    ) THEN
        ALTER TABLE contact_emails
            ADD CONSTRAINT uq_contact_emails_contact_email UNIQUE (contact_id, email_normalized);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contact_emails_contact_id ON contact_emails (contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_emails_normalized ON contact_emails (email_normalized);

-- 6. Backfill contact_emails from existing contacts.email
INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
SELECT id, email, LOWER(TRIM(email)), true
FROM contacts
WHERE email IS NOT NULL AND TRIM(email) != ''
ON CONFLICT (contact_id, email_normalized) DO NOTHING;
