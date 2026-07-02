-- =============================================================================
-- Migration 148: ONBTEL-001 C3 — guarded UNIQUE ×2 (defensive formalization).
--
-- Recon (architecture §0): on prod BOTH uniques already exist —
--   * phone_number_settings.phone_number: constraint
--     phone_number_settings_phone_number_key (also ensured inline by
--     phoneSettings.js ensureTable, and relied on by buyNumber's
--     ON CONFLICT (phone_number));
--   * company_telephony.twilio_subaccount_sid: inline TEXT UNIQUE from mig 098
--     (company_telephony_twilio_subaccount_sid_key).
-- Therefore an unconditional ADD CONSTRAINT is FORBIDDEN (would fail with
-- "already exists" / duplicate on prod — spec E-C11). Each block first checks
-- the catalogs (pg_index covers both pg_constraint-backed unique constraints
-- and standalone unique indexes) for an existing NON-PARTIAL unique on exactly
-- that single column; if found → no-op. Only drifted environments fall through
-- to dedup + ADD CONSTRAINT.
--
-- Dedup rules (spec §3.5, normative):
--   (a) phone_number_settings.phone_number duplicates: KEEP the row with
--       twilio_number_sid IS NOT NULL; tie → newest updated_at. Deleted rows
--       are counted in a RAISE NOTICE. (No FK references this table —
--       DELETE is safe.)
--   (b) company_telephony.twilio_subaccount_sid duplicates (= cross-tenant
--       subaccount sharing): KEEP the SID on the row with the earliest
--       connected_at; later row(s) get twilio_subaccount_sid = NULL (the row
--       itself is preserved) + RAISE WARNING naming BOTH company_ids.
--       Fail-closed: the orphaned company sees TELEPHONY_NOT_CONNECTED until
--       manual review — never another tenant's numbers. Multiple NULL SIDs
--       remain legal (Postgres UNIQUE default; autonomous-mode rows).
--
-- Constraint names (ours, dropped by rollback_148):
--   uq_phone_number_settings_phone_number,
--   uq_company_telephony_twilio_subaccount_sid.
-- Historical constraints are never touched.
-- Idempotent: re-run → guard sees the constraint we created → no-op.
-- =============================================================================

-- ── (a) phone_number_settings.phone_number ──────────────────────────────────
DO $$
DECLARE
    has_unique  BOOLEAN;
    dup_deleted INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ix.indkey[0]
        WHERE n.nspname = 'public'
          AND t.relname = 'phone_number_settings'
          AND ix.indisunique
          AND ix.indnatts = 1
          AND ix.indpred IS NULL
          AND a.attname = 'phone_number'
    ) INTO has_unique;

    IF has_unique THEN
        RAISE NOTICE 'ONBTEL-001 mig 148 (a): unique on phone_number_settings.phone_number already exists — no-op';
        RETURN;
    END IF;

    -- Pre-dedup: keep the row with twilio_number_sid IS NOT NULL,
    -- tie → newest updated_at (id DESC as a final deterministic tiebreaker).
    WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY phone_number
                   ORDER BY (twilio_number_sid IS NOT NULL) DESC,
                            updated_at DESC NULLS LAST,
                            id DESC
               ) AS rn
        FROM phone_number_settings
        WHERE phone_number IS NOT NULL
    ),
    deleted AS (
        DELETE FROM phone_number_settings p
        USING ranked r
        WHERE p.id = r.id
          AND r.rn > 1
        RETURNING p.id
    )
    SELECT count(*) INTO dup_deleted FROM deleted;
    RAISE NOTICE 'ONBTEL-001 mig 148 (a): deleted % duplicate phone_number row(s) before adding the unique constraint', dup_deleted;

    ALTER TABLE phone_number_settings
        ADD CONSTRAINT uq_phone_number_settings_phone_number UNIQUE (phone_number);
    RAISE NOTICE 'ONBTEL-001 mig 148 (a): created uq_phone_number_settings_phone_number';
END $$;

-- ── (b) company_telephony.twilio_subaccount_sid ─────────────────────────────
DO $$
DECLARE
    has_unique BOOLEAN;
    rec        RECORD;
    sid_nulled INTEGER := 0;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ix.indkey[0]
        WHERE n.nspname = 'public'
          AND t.relname = 'company_telephony'
          AND ix.indisunique
          AND ix.indnatts = 1
          AND ix.indpred IS NULL
          AND a.attname = 'twilio_subaccount_sid'
    ) INTO has_unique;

    IF has_unique THEN
        RAISE NOTICE 'ONBTEL-001 mig 148 (b): unique on company_telephony.twilio_subaccount_sid already exists — no-op';
        RETURN;
    END IF;

    -- Pre-dedup: a duplicated non-NULL SID means cross-tenant subaccount
    -- sharing. Keep the SID on the earliest connected_at row; NULL it on every
    -- later row (rows are preserved) and WARN with both company_ids.
    FOR rec IN
        WITH ranked AS (
            SELECT company_id,
                   twilio_subaccount_sid,
                   ROW_NUMBER() OVER (
                       PARTITION BY twilio_subaccount_sid
                       ORDER BY connected_at ASC NULLS LAST, company_id ASC
                   ) AS rn,
                   FIRST_VALUE(company_id) OVER (
                       PARTITION BY twilio_subaccount_sid
                       ORDER BY connected_at ASC NULLS LAST, company_id ASC
                   ) AS keeper_company_id
            FROM company_telephony
            WHERE twilio_subaccount_sid IS NOT NULL
        )
        SELECT company_id, twilio_subaccount_sid AS sid, keeper_company_id
        FROM ranked
        WHERE rn > 1
    LOOP
        UPDATE company_telephony
        SET twilio_subaccount_sid = NULL,
            updated_at = now()
        WHERE company_id = rec.company_id;
        sid_nulled := sid_nulled + 1;
        RAISE WARNING 'ONBTEL-001 mig 148 (b): twilio_subaccount_sid % was shared by company % (kept — earliest connected_at) and company % (SID set to NULL, telephony disconnected pending manual review)',
            rec.sid, rec.keeper_company_id, rec.company_id;
    END LOOP;
    RAISE NOTICE 'ONBTEL-001 mig 148 (b): cleared twilio_subaccount_sid on % duplicate row(s)', sid_nulled;

    ALTER TABLE company_telephony
        ADD CONSTRAINT uq_company_telephony_twilio_subaccount_sid UNIQUE (twilio_subaccount_sid);
    RAISE NOTICE 'ONBTEL-001 mig 148 (b): created uq_company_telephony_twilio_subaccount_sid (multiple NULLs remain allowed)';
END $$;
