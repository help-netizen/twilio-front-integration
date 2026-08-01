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

LOCK TABLE transcripts, webhook_inbox IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
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
    ) THEN
        RAISE EXCEPTION 'ROLLBACK_226_BLOCKED: cross-company Twilio key collisions exist';
    END IF;
END $$;

ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS uq_transcripts_company_transcription_sid;
ALTER TABLE webhook_inbox
    DROP CONSTRAINT IF EXISTS uq_webhook_inbox_company_event_key;

DO $$
BEGIN
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
END $$;

COMMIT;
