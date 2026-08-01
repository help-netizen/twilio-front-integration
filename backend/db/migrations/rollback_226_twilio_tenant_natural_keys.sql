-- =============================================================================
-- Rollback 226: restore global Twilio callback natural keys.
--
-- Fail closed if two companies have since used the same key: choosing one row
-- would delete another tenant's data. Resolve those collisions explicitly
-- before retrying this rollback.
-- Exact AccountSid ownership repairs from migration 226 are intentionally not
-- reversed; moving verified subaccount data back to ABC Homes would recreate
-- the tenant leak.
-- =============================================================================

BEGIN;

LOCK TABLE calls, recordings, transcripts, webhook_inbox, call_flow_executions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT call_sid
        FROM calls
        GROUP BY call_sid
        HAVING COUNT(DISTINCT company_id) > 1
    ) OR EXISTS (
        SELECT recording_sid
        FROM recordings
        GROUP BY recording_sid
        HAVING COUNT(DISTINCT company_id) > 1
    ) OR EXISTS (
        SELECT transcription_sid
        FROM transcripts
        WHERE transcription_sid IS NOT NULL
        GROUP BY transcription_sid
        HAVING COUNT(DISTINCT company_id) > 1
    ) OR EXISTS (
        SELECT event_key
        FROM webhook_inbox
        GROUP BY event_key
        HAVING COUNT(DISTINCT company_id) > 1
    ) OR EXISTS (
        SELECT call_sid
        FROM call_flow_executions
        GROUP BY call_sid
        HAVING COUNT(DISTINCT company_id) > 1
    ) THEN
        RAISE EXCEPTION 'ROLLBACK_226_BLOCKED: cross-company Twilio key collisions exist';
    END IF;
END $$;

ALTER TABLE recordings
    DROP CONSTRAINT IF EXISTS recordings_company_call_sid_fkey;
ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS transcripts_company_call_sid_fkey,
    DROP CONSTRAINT IF EXISTS transcripts_company_recording_sid_fkey;

ALTER TABLE calls
    DROP CONSTRAINT IF EXISTS uq_calls_company_call_sid;
ALTER TABLE recordings
    DROP CONSTRAINT IF EXISTS uq_recordings_company_recording_sid;
ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS uq_transcripts_company_transcription_sid;
ALTER TABLE webhook_inbox
    DROP CONSTRAINT IF EXISTS uq_webhook_inbox_company_event_key;
DROP INDEX IF EXISTS uq_call_flow_executions_company_call_sid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'calls'::regclass
          AND conname = 'calls_call_sid_key'
    ) THEN
        ALTER TABLE calls
            ADD CONSTRAINT calls_call_sid_key UNIQUE (call_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'recordings'::regclass
          AND conname = 'recordings_recording_sid_key'
    ) THEN
        ALTER TABLE recordings
            ADD CONSTRAINT recordings_recording_sid_key UNIQUE (recording_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transcripts'::regclass
          AND conname = 'transcripts_transcription_sid_key'
    ) THEN
        ALTER TABLE transcripts
            ADD CONSTRAINT transcripts_transcription_sid_key UNIQUE (transcription_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'webhook_inbox'::regclass
          AND conname = 'webhook_inbox_event_key_key'
    ) THEN
        ALTER TABLE webhook_inbox
            ADD CONSTRAINT webhook_inbox_event_key_key UNIQUE (event_key);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'recordings'::regclass
          AND conname = 'recordings_call_sid_fkey'
    ) THEN
        ALTER TABLE recordings
            ADD CONSTRAINT recordings_call_sid_fkey
            FOREIGN KEY (call_sid) REFERENCES calls (call_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transcripts'::regclass
          AND conname = 'transcripts_call_sid_fkey'
    ) THEN
        ALTER TABLE transcripts
            ADD CONSTRAINT transcripts_call_sid_fkey
            FOREIGN KEY (call_sid) REFERENCES calls (call_sid);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transcripts'::regclass
          AND conname = 'transcripts_recording_sid_fkey'
    ) THEN
        ALTER TABLE transcripts
            ADD CONSTRAINT transcripts_recording_sid_fkey
            FOREIGN KEY (recording_sid) REFERENCES recordings (recording_sid);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_flow_executions_call_sid
    ON call_flow_executions (call_sid);

DROP TABLE IF EXISTS twilio_media_stream_token_claims;

COMMIT;
