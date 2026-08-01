-- =============================================================================
-- 226: TWILIO-TENANT-FIX-001 — tenant-pair Twilio callback natural keys
--
-- A Twilio SID/idempotency key is unique only inside its owning AccountSid.
-- This migration is locked, transactional, idempotent, and re-apply-safe.
-- =============================================================================

BEGIN;

LOCK TABLE transcripts, webhook_inbox IN ACCESS EXCLUSIVE MODE;
LOCK TABLE company_telephony IN SHARE MODE;

-- Both historical and migration-226 constraints are removed inside the locked
-- transaction so a re-apply can repair drift before rebuilding the pair keys.
ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS transcripts_transcription_sid_key,
    DROP CONSTRAINT IF EXISTS uq_transcripts_company_transcription_sid;
ALTER TABLE webhook_inbox
    DROP CONSTRAINT IF EXISTS webhook_inbox_event_key_key,
    DROP CONSTRAINT IF EXISTS uq_webhook_inbox_company_event_key;

DO $$
DECLARE
    default_company CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
    default_transcript_duplicates INTEGER := 0;
    default_inbox_duplicates INTEGER := 0;
    rehomed_transcripts INTEGER := 0;
    rehomed_inbox INTEGER := 0;
    remaining_default_transcripts INTEGER := 0;
    remaining_default_inbox INTEGER := 0;
    deleted_transcripts INTEGER := 0;
    deleted_inbox INTEGER := 0;
BEGIN
    IF EXISTS (SELECT 1 FROM transcripts WHERE company_id IS NULL)
       OR EXISTS (SELECT 1 FROM webhook_inbox WHERE company_id IS NULL) THEN
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

    RAISE NOTICE '226 preflight: default transcript duplicates=%, default inbox duplicates=%',
        default_transcript_duplicates, default_inbox_duplicates;
    RAISE NOTICE '226 repair: rehomed transcripts=%, inbox events=%',
        rehomed_transcripts, rehomed_inbox;
    RAISE NOTICE '226 review: remaining default/master-or-unbound transcripts=%, inbox events=%',
        remaining_default_transcripts, remaining_default_inbox;
    RAISE NOTICE '226 dedup: deleted transcripts=%, inbox events=%',
        deleted_transcripts, deleted_inbox;
END $$;

DO $$
BEGIN
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
END $$;

COMMIT;
