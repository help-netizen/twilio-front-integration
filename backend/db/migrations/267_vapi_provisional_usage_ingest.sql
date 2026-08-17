-- Migration 267: T3 sanitized provider evidence and provisional observation link.
--
-- Migration 266 created the identity/usage tables before T3. This additive
-- migration records which company-bound status credential admitted an EoC,
-- preserves only an allowlisted sanitized payload, and links the current
-- provisional projection back to its append-only observation.

ALTER TABLE vapi_call_usage_observations
    ADD COLUMN IF NOT EXISTS status_credential_id BIGINT,
    ADD COLUMN IF NOT EXISTS assistant_id TEXT,
    ADD COLUMN IF NOT EXISTS call_type TEXT,
    ADD COLUMN IF NOT EXISTS provider_status TEXT,
    ADD COLUMN IF NOT EXISTS sanitized_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_usage_observation_status_credential'
          AND conrelid = 'vapi_call_usage_observations'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage_observations
            ADD CONSTRAINT fk_vapi_usage_observation_status_credential
            FOREIGN KEY (status_credential_id, company_id)
            REFERENCES api_integrations(id, company_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_usage_observation_call_type'
          AND conrelid = 'vapi_call_usage_observations'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage_observations
            ADD CONSTRAINT chk_vapi_usage_observation_call_type
            CHECK (call_type IS NULL OR call_type IN (
                'inboundPhoneCall', 'outboundPhoneCall', 'webCall'
            ));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_usage_observation_provider_status'
          AND conrelid = 'vapi_call_usage_observations'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage_observations
            ADD CONSTRAINT chk_vapi_usage_observation_provider_status
            CHECK (provider_status IS NULL OR provider_status IN (
                'scheduled', 'queued', 'ringing', 'in-progress', 'forwarding', 'ended'
            ));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_usage_observation_sanitized_payload'
          AND conrelid = 'vapi_call_usage_observations'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage_observations
            ADD CONSTRAINT chk_vapi_usage_observation_sanitized_payload
            CHECK (jsonb_typeof(sanitized_payload) = 'object');
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_usage_observations_id_company
    ON vapi_call_usage_observations(id, company_id);

ALTER TABLE vapi_call_usage
    ADD COLUMN IF NOT EXISTS provisional_observation_id UUID,
    ADD COLUMN IF NOT EXISTS provisional_updated_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_call_usage_provisional_observation'
          AND conrelid = 'vapi_call_usage'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage
            ADD CONSTRAINT fk_vapi_call_usage_provisional_observation
            FOREIGN KEY (provisional_observation_id, company_id)
            REFERENCES vapi_call_usage_observations(id, company_id);
    END IF;
END $$;

-- If this migration is replayed after a direct rollback on a database where
-- T4 schema still exists, restore every later FK that depends on 267's
-- composite observation identity as well as the provisional link above.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'vapi_call_usage'
          AND column_name = 'authoritative_observation_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_usage_authoritative_observation'
          AND conrelid = 'vapi_call_usage'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage
            ADD CONSTRAINT fk_vapi_usage_authoritative_observation
            FOREIGN KEY (authoritative_observation_id, company_id)
            REFERENCES vapi_call_usage_observations(id, company_id);
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'vapi_call_usage'
          AND column_name = 'pending_correction_observation_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_usage_pending_correction_observation'
          AND conrelid = 'vapi_call_usage'::regclass
    ) THEN
        ALTER TABLE vapi_call_usage
            ADD CONSTRAINT fk_vapi_usage_pending_correction_observation
            FOREIGN KEY (pending_correction_observation_id, company_id)
            REFERENCES vapi_call_usage_observations(id, company_id);
    END IF;

    IF to_regclass('vapi_call_usage_final_snapshots') IS NOT NULL
       AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'fk_vapi_final_snapshot_observation_company'
              AND conrelid = 'vapi_call_usage_final_snapshots'::regclass
       ) THEN
        ALTER TABLE vapi_call_usage_final_snapshots
            ADD CONSTRAINT fk_vapi_final_snapshot_observation_company
            FOREIGN KEY (observation_id, company_id)
            REFERENCES vapi_call_usage_observations(id, company_id);
    END IF;
END $$;

COMMENT ON COLUMN vapi_call_usage_observations.sanitized_payload IS
    'Allowlisted provider identity/lifecycle/cost evidence only; exact JSON numbers are stored as decimal strings. Never contains transcripts, recordings, phone/customer data, names or assistant/server snapshots.';
COMMENT ON COLUMN vapi_call_usage.provisional_observation_id IS
    'Append-only EoC observation currently projected as provisional; never a charge or final supplier snapshot.';
