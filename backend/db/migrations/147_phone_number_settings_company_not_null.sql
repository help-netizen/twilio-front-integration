-- =============================================================================
-- Migration 147: ONBTEL-001 C2 — phone_number_settings.company_id NOT NULL
--                (backfill + constraint). An "ownerless" number becomes
--                impossible at the schema level.
--
-- *** ONE-WAY DATA MIGRATION ***
-- rollback_147 only drops the NOT NULL constraint; the backfilled company_id
-- values are NOT reverted (the prior value was NULL — nothing to restore).
--
-- Strict step order (each step logs its row count via RAISE NOTICE):
--   1. Count rows with company_id IS NULL.
--   2. Backfill using the mig-091 rule: user_group_numbers →
--      user_groups.company_id (insurance for drifted environments).
--   3. Remaining NULL rows → DEFAULT seed company
--      00000000-0000-0000-0000-000000000001 (Boston Masters). NOT DELETE —
--      anti-leak: NULL rows were historically produced only by master-account
--      paths (pre-091 legacy and the phoneSettings.js master sync); the
--      subaccount buyNumber always writes company_id, so a subaccount-owned
--      number can never be a NULL orphan → assigning to DEFAULT cannot hand a
--      foreign tenant's number to Boston Masters. A DELETE would be dangerous:
--      the master number stays live on Twilio and the next GET
--      /api/phone-settings sync would re-claim its row under a FOREIGN
--      company_id (cross-tenant claim + routing of calls to the wrong tenant).
--   4. Guarded ALTER COLUMN company_id SET NOT NULL (skipped when already set).
--      If a NULL somehow survives to this step, the ALTER fails and the whole
--      DO block rolls back (fail-closed).
--
-- Rows whose company_id is already set — including historically mis-claimed
-- ones (spec E-C15) — are NOT touched.
-- Idempotent: re-run → all counters 0 and step 4 skips → no-op.
-- =============================================================================

DO $$
DECLARE
    null_count       INTEGER;
    group_backfilled INTEGER;
    defaulted        INTEGER;
    col_not_null     BOOLEAN;
BEGIN
    -- Step 1: count the NULL rows we are about to resolve.
    SELECT count(*) INTO null_count
    FROM phone_number_settings
    WHERE company_id IS NULL;
    RAISE NOTICE 'ONBTEL-001 mig 147 step 1: % row(s) with company_id IS NULL', null_count;

    -- Step 2: mig-091 rule — derive the owner from the number's group mapping.
    UPDATE phone_number_settings pns
    SET company_id = ug.company_id::uuid
    FROM user_group_numbers ugn
    JOIN user_groups ug ON ug.id = ugn.group_id
    WHERE pns.phone_number = ugn.phone_number
      AND pns.company_id IS NULL;
    GET DIAGNOSTICS group_backfilled = ROW_COUNT;
    RAISE NOTICE 'ONBTEL-001 mig 147 step 2: backfilled % row(s) from user_group_numbers -> user_groups.company_id', group_backfilled;

    -- Step 3: remaining NULLs → DEFAULT seed company (see header for why not DELETE).
    UPDATE phone_number_settings
    SET company_id = '00000000-0000-0000-0000-000000000001'::uuid
    WHERE company_id IS NULL;
    GET DIAGNOSTICS defaulted = ROW_COUNT;
    RAISE NOTICE 'ONBTEL-001 mig 147 step 3: assigned % remaining NULL row(s) to the DEFAULT company 00000000-0000-0000-0000-000000000001', defaulted;

    -- Step 4: guarded NOT NULL (re-run safe).
    SELECT a.attnotnull INTO col_not_null
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'phone_number_settings'
      AND a.attname = 'company_id';

    IF COALESCE(col_not_null, false) THEN
        RAISE NOTICE 'ONBTEL-001 mig 147 step 4: company_id is already NOT NULL — skipping (0 rows changed)';
    ELSE
        ALTER TABLE phone_number_settings ALTER COLUMN company_id SET NOT NULL;
        RAISE NOTICE 'ONBTEL-001 mig 147 step 4: company_id SET NOT NULL applied';
    END IF;
END $$;
