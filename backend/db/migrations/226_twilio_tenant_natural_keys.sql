-- =============================================================================
-- 226: TWILIO-TENANT-FIX-001 — tenant-pair Twilio natural keys and stream claims
--
-- A Twilio SID/idempotency key is unique only inside its owning AccountSid.
-- This migration is locked, transactional, idempotent, and re-apply-safe.
-- =============================================================================

BEGIN;

LOCK TABLE calls, recordings, transcripts, webhook_inbox, call_flow_executions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE company_telephony IN SHARE MODE;

CREATE TABLE IF NOT EXISTS twilio_media_stream_token_claims (
    jti TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_twilio_media_stream_token_claims_expires
    ON twilio_media_stream_token_claims (expires_at);

-- Replace legacy SID-only foreign keys together with the unique keys they use.
ALTER TABLE recordings
    DROP CONSTRAINT IF EXISTS recordings_call_sid_fkey,
    DROP CONSTRAINT IF EXISTS recordings_company_call_sid_fkey;
ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS transcripts_call_sid_fkey,
    DROP CONSTRAINT IF EXISTS transcripts_recording_sid_fkey,
    DROP CONSTRAINT IF EXISTS transcripts_company_call_sid_fkey,
    DROP CONSTRAINT IF EXISTS transcripts_company_recording_sid_fkey;

-- Both historical and migration-226 constraints are removed inside the locked
-- transaction so a re-apply can repair drift before rebuilding the pair keys.
ALTER TABLE calls
    DROP CONSTRAINT IF EXISTS calls_call_sid_key,
    DROP CONSTRAINT IF EXISTS uq_calls_company_call_sid;
ALTER TABLE recordings
    DROP CONSTRAINT IF EXISTS recordings_recording_sid_key,
    DROP CONSTRAINT IF EXISTS uq_recordings_company_recording_sid;
ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS transcripts_transcription_sid_key,
    DROP CONSTRAINT IF EXISTS uq_transcripts_company_transcription_sid;
ALTER TABLE webhook_inbox
    DROP CONSTRAINT IF EXISTS webhook_inbox_event_key_key,
    DROP CONSTRAINT IF EXISTS uq_webhook_inbox_company_event_key;
DROP INDEX IF EXISTS uq_call_flow_executions_call_sid;
DROP INDEX IF EXISTS uq_call_flow_executions_company_call_sid;

DO $$
DECLARE
    default_company CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
    deleted_calls INTEGER := 0;
    deleted_recordings INTEGER := 0;
    default_transcript_duplicates INTEGER := 0;
    default_inbox_duplicates INTEGER := 0;
    rehomed_transcripts INTEGER := 0;
    rehomed_inbox INTEGER := 0;
    rehomed_calls INTEGER := 0;
    rehomed_recordings INTEGER := 0;
    remaining_default_transcripts INTEGER := 0;
    remaining_default_inbox INTEGER := 0;
    deleted_transcripts INTEGER := 0;
    deleted_inbox INTEGER := 0;
BEGIN
    IF EXISTS (SELECT 1 FROM calls WHERE company_id IS NULL)
       OR EXISTS (SELECT 1 FROM recordings WHERE company_id IS NULL)
       OR EXISTS (SELECT 1 FROM transcripts WHERE company_id IS NULL)
       OR EXISTS (SELECT 1 FROM webhook_inbox WHERE company_id IS NULL)
       OR EXISTS (SELECT 1 FROM call_flow_executions WHERE company_id IS NULL) THEN
        RAISE EXCEPTION 'TWILIO_TENANT_226_PREFLIGHT: company_id must be non-null';
    END IF;

    IF EXISTS (
        SELECT twilio_subaccount_sid
        FROM company_telephony
        WHERE twilio_subaccount_sid IS NOT NULL
        GROUP BY twilio_subaccount_sid
        HAVING COUNT(DISTINCT company_id) > 1
    ) THEN
        RAISE EXCEPTION 'TWILIO_TENANT_226_PREFLIGHT: ambiguous subaccount binding';
    END IF;

    -- Repair only exact, persisted subaccount bindings. Master-account rows and
    -- unknown AccountSids remain untouched because SQL cannot safely infer them.
    UPDATE calls target
       SET company_id = binding.company_id
      FROM company_telephony binding
     WHERE target.company_id = default_company
       AND binding.company_id <> default_company
       AND binding.twilio_subaccount_sid IS NOT NULL
       AND target.raw_last_payload ->> 'AccountSid' = binding.twilio_subaccount_sid;
    GET DIAGNOSTICS rehomed_calls = ROW_COUNT;

    UPDATE recordings target
       SET company_id = binding.company_id
      FROM company_telephony binding
     WHERE target.company_id = default_company
       AND binding.company_id <> default_company
       AND binding.twilio_subaccount_sid IS NOT NULL
       AND target.raw_payload ->> 'AccountSid' = binding.twilio_subaccount_sid;
    GET DIAGNOSTICS rehomed_recordings = ROW_COUNT;

    UPDATE transcripts target
       SET company_id = binding.company_id
      FROM company_telephony binding
     WHERE target.company_id = default_company
       AND binding.company_id <> default_company
       AND binding.twilio_subaccount_sid IS NOT NULL
       AND target.raw_payload ->> 'AccountSid' = binding.twilio_subaccount_sid;
    GET DIAGNOSTICS rehomed_transcripts = ROW_COUNT;

    UPDATE webhook_inbox target
       SET company_id = binding.company_id
      FROM company_telephony binding
     WHERE target.company_id = default_company
       AND binding.company_id <> default_company
       AND binding.twilio_subaccount_sid IS NOT NULL
       AND target.payload ->> 'AccountSid' = binding.twilio_subaccount_sid;
    GET DIAGNOSTICS rehomed_inbox = ROW_COUNT;

    SELECT COUNT(*)::INTEGER INTO remaining_default_transcripts
      FROM transcripts
     WHERE company_id = default_company
       AND NULLIF(raw_payload ->> 'AccountSid', '') IS NOT NULL;
    SELECT COUNT(*)::INTEGER INTO remaining_default_inbox
      FROM webhook_inbox
     WHERE company_id = default_company
       AND NULLIF(payload ->> 'AccountSid', '') IS NOT NULL;

    SELECT COALESCE(SUM(n - 1), 0)::INTEGER
      INTO default_transcript_duplicates
      FROM (
          SELECT COUNT(*) AS n
          FROM transcripts
          WHERE company_id = default_company
            AND transcription_sid IS NOT NULL
          GROUP BY company_id, transcription_sid
          HAVING COUNT(*) > 1
      ) duplicates;

    WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY company_id, call_sid
                   ORDER BY is_final DESC,
                            last_event_time DESC NULLS LAST,
                            updated_at DESC NULLS LAST,
                            created_at DESC NULLS LAST,
                            id DESC
               ) AS position
        FROM calls
    ), removed AS (
        DELETE FROM calls target
        USING ranked
        WHERE target.id = ranked.id
          AND ranked.position > 1
        RETURNING target.id
    )
    SELECT COUNT(*)::INTEGER INTO deleted_calls FROM removed;

    WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY company_id, recording_sid
                   ORDER BY (status = 'completed') DESC,
                            completed_at DESC NULLS LAST,
                            updated_at DESC NULLS LAST,
                            created_at DESC NULLS LAST,
                            id DESC
               ) AS position
        FROM recordings
    ), removed AS (
        DELETE FROM recordings target
        USING ranked
        WHERE target.id = ranked.id
          AND ranked.position > 1
        RETURNING target.id
    )
    SELECT COUNT(*)::INTEGER INTO deleted_recordings FROM removed;

    SELECT COALESCE(SUM(n - 1), 0)::INTEGER
      INTO default_inbox_duplicates
      FROM (
          SELECT COUNT(*) AS n
          FROM webhook_inbox
          WHERE company_id = default_company
          GROUP BY company_id, event_key
          HAVING COUNT(*) > 1
      ) duplicates;

    WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY company_id, transcription_sid
                   ORDER BY is_final DESC,
                            (status = 'completed') DESC,
                            LENGTH(COALESCE(text, '')) DESC,
                            updated_at DESC NULLS LAST,
                            created_at DESC NULLS LAST,
                            id DESC
               ) AS position
        FROM transcripts
        WHERE transcription_sid IS NOT NULL
    ), removed AS (
        DELETE FROM transcripts target
        USING ranked
        WHERE target.id = ranked.id
          AND ranked.position > 1
        RETURNING target.id
    )
    SELECT COUNT(*)::INTEGER INTO deleted_transcripts FROM removed;

    WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY company_id, event_key
                   ORDER BY CASE status
                                WHEN 'processed' THEN 4
                                WHEN 'processing' THEN 3
                                WHEN 'received' THEN 2
                                WHEN 'dead' THEN 1
                                ELSE 0
                            END DESC,
                            attempts DESC,
                            processed_at DESC NULLS LAST,
                            received_at ASC,
                            id ASC
               ) AS position
        FROM webhook_inbox
    ), removed AS (
        DELETE FROM webhook_inbox target
        USING ranked
        WHERE target.id = ranked.id
          AND ranked.position > 1
        RETURNING target.id
    )
    SELECT COUNT(*)::INTEGER INTO deleted_inbox FROM removed;

    WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY company_id, call_sid
                   ORDER BY (status = 'active') DESC,
                            updated_at DESC NULLS LAST,
                            created_at DESC NULLS LAST,
                            id DESC
               ) AS position
        FROM call_flow_executions
    )
    DELETE FROM call_flow_executions target
    USING ranked
    WHERE target.id = ranked.id
      AND ranked.position > 1;

    IF EXISTS (
        SELECT 1
        FROM recordings r
        LEFT JOIN calls c
          ON c.company_id = r.company_id
         AND c.call_sid = r.call_sid
        WHERE c.id IS NULL
    ) OR EXISTS (
        SELECT 1
        FROM transcripts t
        LEFT JOIN calls c
          ON c.company_id = t.company_id
         AND c.call_sid = t.call_sid
        WHERE t.call_sid IS NOT NULL
          AND c.id IS NULL
    ) OR EXISTS (
        SELECT 1
        FROM transcripts t
        LEFT JOIN recordings r
          ON r.company_id = t.company_id
         AND r.recording_sid = t.recording_sid
        WHERE t.recording_sid IS NOT NULL
          AND r.id IS NULL
    ) THEN
        RAISE EXCEPTION 'TWILIO_TENANT_226_PREFLIGHT: cross-tenant or orphan call media relation';
    END IF;

    RAISE NOTICE '226 preflight: default transcript duplicates=%, default inbox duplicates=%',
        default_transcript_duplicates, default_inbox_duplicates;
    RAISE NOTICE '226 repair: rehomed transcripts=%, inbox events=%',
        rehomed_transcripts, rehomed_inbox;
    RAISE NOTICE '226 repair: rehomed calls=%, recordings=%',
        rehomed_calls, rehomed_recordings;
    RAISE NOTICE '226 review: remaining default/master-or-unbound transcripts=%, inbox events=%',
        remaining_default_transcripts, remaining_default_inbox;
    RAISE NOTICE '226 dedup: deleted transcripts=%, inbox events=%',
        deleted_transcripts, deleted_inbox;
    RAISE NOTICE '226 dedup: deleted calls=%, recordings=%',
        deleted_calls, deleted_recordings;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'calls'::regclass
          AND conname = 'uq_calls_company_call_sid'
    ) THEN
        ALTER TABLE calls
            ADD CONSTRAINT uq_calls_company_call_sid
            UNIQUE (company_id, call_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'recordings'::regclass
          AND conname = 'uq_recordings_company_recording_sid'
    ) THEN
        ALTER TABLE recordings
            ADD CONSTRAINT uq_recordings_company_recording_sid
            UNIQUE (company_id, recording_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transcripts'::regclass
          AND conname = 'uq_transcripts_company_transcription_sid'
    ) THEN
        ALTER TABLE transcripts
            ADD CONSTRAINT uq_transcripts_company_transcription_sid
            UNIQUE (company_id, transcription_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'webhook_inbox'::regclass
          AND conname = 'uq_webhook_inbox_company_event_key'
    ) THEN
        ALTER TABLE webhook_inbox
            ADD CONSTRAINT uq_webhook_inbox_company_event_key
            UNIQUE (company_id, event_key);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'recordings'::regclass
          AND conname = 'recordings_company_call_sid_fkey'
    ) THEN
        ALTER TABLE recordings
            ADD CONSTRAINT recordings_company_call_sid_fkey
            FOREIGN KEY (company_id, call_sid)
            REFERENCES calls (company_id, call_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transcripts'::regclass
          AND conname = 'transcripts_company_call_sid_fkey'
    ) THEN
        ALTER TABLE transcripts
            ADD CONSTRAINT transcripts_company_call_sid_fkey
            FOREIGN KEY (company_id, call_sid)
            REFERENCES calls (company_id, call_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transcripts'::regclass
          AND conname = 'transcripts_company_recording_sid_fkey'
    ) THEN
        ALTER TABLE transcripts
            ADD CONSTRAINT transcripts_company_recording_sid_fkey
            FOREIGN KEY (company_id, recording_sid)
            REFERENCES recordings (company_id, recording_sid);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_flow_executions_company_call_sid
    ON call_flow_executions (company_id, call_sid);

COMMIT;
