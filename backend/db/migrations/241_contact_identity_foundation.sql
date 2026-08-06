-- 241_contact_identity_foundation.sql
-- ZB-DECOUPLE-001 Phase B / B1: tenant-scoped contact identities and phones.

CREATE TABLE IF NOT EXISTS contact_external_identities (
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source      TEXT NOT NULL CHECK (
        BTRIM(source) <> '' AND source = LOWER(source)
    ),
    external_id TEXT NOT NULL CHECK (BTRIM(external_id) <> ''),
    contact_id  BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (company_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_external_identities_contact
    ON contact_external_identities (company_id, contact_id);

CREATE TABLE IF NOT EXISTS contact_phones (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id       BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    phone_e164       TEXT NOT NULL CHECK (BTRIM(phone_e164) <> ''),
    normalized_phone TEXT NOT NULL CHECK (normalized_phone ~ '^[0-9]{10}$'),
    label            TEXT,
    is_primary       BOOLEAN NOT NULL DEFAULT FALSE,
    is_shared        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_phones_contact
    ON contact_phones (company_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_phones_normalized_lookup
    ON contact_phones (company_id, normalized_phone);

-- Deliberately non-unique until the existing duplicate sets are bulk-merged after B2.

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

WITH scalar_phones AS (
    SELECT
        c.company_id,
        c.id AS contact_id,
        BTRIM(c.phone_e164) AS phone_e164,
        RIGHT(REGEXP_REPLACE(c.phone_e164, '[^0-9]', '', 'g'), 10) AS normalized_phone,
        NULL::TEXT AS label,
        TRUE AS is_primary,
        1 AS slot_order
    FROM contacts c
    WHERE c.deleted_at IS NULL
      AND c.phone_e164 IS NOT NULL
      AND BTRIM(c.phone_e164) <> ''
      AND LENGTH(REGEXP_REPLACE(c.phone_e164, '[^0-9]', '', 'g')) >= 10

    UNION ALL

    SELECT
        c.company_id,
        c.id AS contact_id,
        BTRIM(c.secondary_phone) AS phone_e164,
        RIGHT(REGEXP_REPLACE(c.secondary_phone, '[^0-9]', '', 'g'), 10) AS normalized_phone,
        NULLIF(BTRIM(c.secondary_phone_name), '') AS label,
        FALSE AS is_primary,
        2 AS slot_order
    FROM contacts c
    WHERE c.deleted_at IS NULL
      AND c.secondary_phone IS NOT NULL
      AND BTRIM(c.secondary_phone) <> ''
      AND LENGTH(REGEXP_REPLACE(c.secondary_phone, '[^0-9]', '', 'g')) >= 10
), distinct_phones AS (
    SELECT DISTINCT ON (company_id, contact_id, normalized_phone)
        company_id,
        contact_id,
        phone_e164,
        normalized_phone,
        label,
        is_primary
    FROM scalar_phones
    ORDER BY company_id, contact_id, normalized_phone, slot_order
)
INSERT INTO contact_phones (
    company_id,
    contact_id,
    phone_e164,
    normalized_phone,
    label,
    is_primary
)
SELECT
    source.company_id,
    source.contact_id,
    source.phone_e164,
    source.normalized_phone,
    source.label,
    source.is_primary
FROM distinct_phones source
WHERE NOT EXISTS (
    SELECT 1
    FROM contact_phones existing
    WHERE existing.company_id = source.company_id
      AND existing.contact_id = source.contact_id
      AND existing.normalized_phone = source.normalized_phone
);

COMMENT ON TABLE contact_external_identities IS
    'Tenant-scoped external identities mapped to Albusto contacts.';

COMMENT ON TABLE contact_phones IS
    'Lossless tenant-scoped inventory of contact phone identities; normalized ownership may be shared.';
