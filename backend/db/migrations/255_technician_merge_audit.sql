-- TECH-MERGE-001: durable technician merge tombstones and audit records.

ALTER TABLE technicians
    ADD COLUMN IF NOT EXISTS merged_into UUID,
    ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'technicians_merged_into_fk'
          AND conrelid = 'technicians'::regclass
    ) THEN
        ALTER TABLE technicians
            ADD CONSTRAINT technicians_merged_into_fk
            FOREIGN KEY (company_id, merged_into)
            REFERENCES technicians(company_id, id)
            ON DELETE RESTRICT
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'technicians_merge_state_check'
          AND conrelid = 'technicians'::regclass
    ) THEN
        ALTER TABLE technicians
            ADD CONSTRAINT technicians_merge_state_check
            CHECK (
                (merged_into IS NULL AND merged_at IS NULL)
                OR
                (merged_into IS NOT NULL AND merged_at IS NOT NULL
                    AND merged_into <> id AND active = FALSE)
            )
            NOT VALID;
    END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS idx_technicians_merged_into
    ON technicians (company_id, merged_into)
    WHERE merged_into IS NOT NULL;

CREATE TABLE IF NOT EXISTS technician_merge_audits (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    loser_id       UUID NOT NULL,
    survivor_id    UUID NOT NULL,
    data_wins      TEXT NOT NULL CHECK (data_wins IN ('fail-closed', 'survivor', 'loser')),
    display_name   TEXT NOT NULL,
    plan           JSONB NOT NULL,
    discarded_data JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT technician_merge_audits_loser_fk
        FOREIGN KEY (company_id, loser_id)
        REFERENCES technicians(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT technician_merge_audits_survivor_fk
        FOREIGN KEY (company_id, survivor_id)
        REFERENCES technicians(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT technician_merge_audits_pair_check
        CHECK (loser_id <> survivor_id),
    CONSTRAINT technician_merge_audits_company_loser_key
        UNIQUE (company_id, loser_id)
);

COMMENT ON COLUMN technicians.merged_into IS
    'TECH-MERGE-001 tombstone redirect. A merged technician remains addressable for audit/idempotency; operational identities and references move to this survivor.';
COMMENT ON TABLE technician_merge_audits IS
    'TECH-MERGE-001 durable audit. plan records moved rows; discarded_data records configuration overwritten only by an explicit data_wins policy.';
