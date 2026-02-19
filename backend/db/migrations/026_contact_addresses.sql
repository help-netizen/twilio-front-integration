-- Migration 026: Contact addresses table and lead linkage
-- Supports multiple addresses per contact with deduplication

-- 1. Create contact_addresses table
CREATE TABLE IF NOT EXISTS contact_addresses (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    label TEXT,                    -- Home, Work, Rental, etc.
    is_primary BOOLEAN DEFAULT false,
    street_line1 TEXT NOT NULL DEFAULT '',
    street_line2 TEXT,            -- apt/unit
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'US',
    google_place_id TEXT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    address_normalized_hash TEXT,  -- for fast dedupe
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_contact_addresses_contact_id
    ON contact_addresses (contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_addresses_place_id
    ON contact_addresses (google_place_id)
    WHERE google_place_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contact_addresses_hash
    ON contact_addresses (contact_id, address_normalized_hash);

-- Unique constraints for deduplication
-- By google_place_id (when present)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_contact_addr_place_id'
    ) THEN
        CREATE UNIQUE INDEX uq_contact_addr_place_id
            ON contact_addresses (contact_id, google_place_id)
            WHERE google_place_id IS NOT NULL;
    END IF;
END $$;

-- By normalized hash
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_contact_addr_hash'
    ) THEN
        CREATE UNIQUE INDEX uq_contact_addr_hash
            ON contact_addresses (contact_id, address_normalized_hash)
            WHERE address_normalized_hash IS NOT NULL;
    END IF;
END $$;

-- 2. Add contact_address_id to leads
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'leads' AND column_name = 'contact_address_id'
    ) THEN
        ALTER TABLE leads ADD COLUMN contact_address_id BIGINT
            REFERENCES contact_addresses(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_leads_contact_address_id
    ON leads (contact_address_id)
    WHERE contact_address_id IS NOT NULL;

-- 3. Backfill: create contact_addresses from existing leads that have addresses and contact_ids
-- Use a hash of normalized address fields for deduplication
INSERT INTO contact_addresses (contact_id, street_line1, street_line2, city, state, postal_code, lat, lng, is_primary, address_normalized_hash)
SELECT DISTINCT ON (l.contact_id, hash)
    l.contact_id,
    COALESCE(l.address, ''),
    l.unit,
    COALESCE(l.city, ''),
    COALESCE(l.state, ''),
    COALESCE(l.postal_code, ''),
    l.latitude,
    l.longitude,
    true,
    MD5(LOWER(TRIM(COALESCE(l.address, ''))) || '|' || LOWER(TRIM(COALESCE(l.city, ''))) || '|' || LOWER(TRIM(COALESCE(l.state, ''))) || '|' || TRIM(COALESCE(l.postal_code, ''))) AS hash
FROM leads l
WHERE l.contact_id IS NOT NULL
  AND l.address IS NOT NULL
  AND TRIM(l.address) != ''
ON CONFLICT DO NOTHING;

-- 4. Link leads to their contact_addresses
UPDATE leads l
SET contact_address_id = ca.id
FROM contact_addresses ca
WHERE l.contact_id = ca.contact_id
  AND l.contact_address_id IS NULL
  AND l.address IS NOT NULL
  AND TRIM(l.address) != ''
  AND ca.address_normalized_hash = MD5(LOWER(TRIM(COALESCE(l.address, ''))) || '|' || LOWER(TRIM(COALESCE(l.city, ''))) || '|' || LOWER(TRIM(COALESCE(l.state, ''))) || '|' || TRIM(COALESCE(l.postal_code, '')));
