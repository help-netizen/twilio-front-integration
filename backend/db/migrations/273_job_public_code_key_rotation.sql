-- JOB-NUMBERING-001: rotate the Feistel secret out of committed SQL.
-- Deploy order: database default -> this migration -> application restart.

BEGIN;

CREATE TABLE IF NOT EXISTS job_public_code_key_state (
    singleton           BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    key_fingerprint     TEXT NOT NULL,
    first_pinned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_verified_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    diagnostic_code     TEXT,
    diagnostic_at       TIMESTAMPTZ
);

DO $pin$
DECLARE
    v_key TEXT := current_setting('app.job_code_feistel_key', true);
    v_database_key TEXT;
    v_fingerprint TEXT;
    v_pinned TEXT;
BEGIN
    -- Existing sessions do not inherit a later ALTER DATABASE setting. Reading
    -- its catalog value bridges the migration-to-restart window for old workers.
    IF v_key IS NULL THEN
        SELECT split_part(item.setting, '=', 2)
        INTO v_database_key
        FROM pg_db_role_setting settings
        CROSS JOIN LATERAL unnest(settings.setconfig) AS item(setting)
        JOIN pg_database database ON database.oid = settings.setdatabase
        WHERE database.datname = current_database()
          AND settings.setrole = 0
          AND item.setting LIKE 'app.job_code_feistel_key=%'
        ORDER BY item.setting
        LIMIT 1;
        v_key := v_database_key;
    END IF;

    IF v_key IS NULL OR v_key = '' THEN
        RAISE EXCEPTION 'JOB_CODE_FEISTEL_KEY_REQUIRED: set the database default before migration 273';
    END IF;
    IF v_key !~ '^[1-9][0-9]{0,9}$'
       OR v_key::NUMERIC > 4294967295 THEN
        RAISE EXCEPTION 'JOB_CODE_FEISTEL_KEY_INVALID: expected unsigned 32-bit decimal';
    END IF;

    -- One-way deployment latch. The secret itself is never persisted.
    v_fingerprint := md5('albusto-job-code-v1:' || v_key);
    INSERT INTO job_public_code_key_state (singleton, key_fingerprint)
    VALUES (true, v_fingerprint)
    ON CONFLICT (singleton) DO NOTHING;

    SELECT key_fingerprint INTO v_pinned
    FROM job_public_code_key_state
    WHERE singleton = true
    FOR UPDATE;

    IF v_pinned IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'JOB_CODE_FEISTEL_KEY_MISMATCH: refusing implicit public-code rotation';
    END IF;

    UPDATE job_public_code_key_state
    SET last_verified_at = now(),
        diagnostic_code = NULL,
        diagnostic_at = NULL
    WHERE singleton = true;
END
$pin$;

CREATE OR REPLACE FUNCTION job_public_code(p_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
STRICT
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_domain_size CONSTANT BIGINT := 916132832; -- 62^5
    v_half_mask CONSTANT INTEGER := 32767;      -- 2^15 - 1
    v_key_text TEXT := current_setting('app.job_code_feistel_key', true);
    v_database_key TEXT;
    v_stable_key BIGINT;
    v_expected_fingerprint TEXT;
    v_round_keys CONSTANT BIGINT[] :=
        '{2654435761,2246822519,3266489917,668265263}'::BIGINT[];
    v_alphabet CONSTANT TEXT := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    v_value BIGINT := p_id;
    v_left INTEGER;
    v_right INTEGER;
    v_next_left INTEGER;
    v_next_right INTEGER;
    v_mixed BIGINT;
    v_round INTEGER;
    v_position INTEGER;
    v_code TEXT := '';
BEGIN
    -- NULL means a pre-restart session with no app option. Explicit empty stays
    -- an error and must not be hidden by the database fallback.
    IF v_key_text IS NULL THEN
        SELECT split_part(item.setting, '=', 2)
        INTO v_database_key
        FROM pg_db_role_setting settings
        CROSS JOIN LATERAL unnest(settings.setconfig) AS item(setting)
        JOIN pg_database database ON database.oid = settings.setdatabase
        WHERE database.datname = current_database()
          AND settings.setrole = 0
          AND item.setting LIKE 'app.job_code_feistel_key=%'
        ORDER BY item.setting
        LIMIT 1;
        v_key_text := v_database_key;
    END IF;

    IF v_key_text IS NULL OR v_key_text = '' THEN
        RAISE EXCEPTION 'JOB_CODE_FEISTEL_KEY_REQUIRED: job creation disabled; configure deployment secret';
    END IF;
    IF v_key_text !~ '^[1-9][0-9]{0,9}$'
       OR v_key_text::NUMERIC > 4294967295 THEN
        RAISE EXCEPTION 'JOB_CODE_FEISTEL_KEY_INVALID: job creation disabled';
    END IF;

    SELECT key_fingerprint INTO v_expected_fingerprint
    FROM job_public_code_key_state
    WHERE singleton = true;
    IF v_expected_fingerprint IS NULL
       OR v_expected_fingerprint <> md5('albusto-job-code-v1:' || v_key_text) THEN
        RAISE EXCEPTION 'JOB_CODE_FEISTEL_KEY_MISMATCH: refusing a different public-code namespace';
    END IF;
    v_stable_key := v_key_text::BIGINT;

    IF p_id < 0 OR p_id >= v_domain_size THEN
        RAISE EXCEPTION
            'job id % is outside the 5-character public-code domain [0, %)',
            p_id, v_domain_size USING ERRCODE = '22003';
    END IF;

    LOOP
        v_left := ((v_value >> 15) & v_half_mask)::INTEGER;
        v_right := (v_value & v_half_mask)::INTEGER;
        FOR v_round IN 1..4 LOOP
            v_mixed := (
                v_right::BIGINT * 1103515245
                + v_stable_key
                + v_round_keys[v_round]
            ) & 2147483647;
            v_mixed := v_mixed # (v_mixed >> 16);
            v_mixed := (v_mixed * 2246822519) & 2147483647;
            v_mixed := v_mixed # (v_mixed >> 13);
            v_next_left := v_right;
            v_next_right := (v_left # ((v_mixed & v_half_mask)::INTEGER)) & v_half_mask;
            v_left := v_next_left;
            v_right := v_next_right;
        END LOOP;
        v_value := (v_left::BIGINT << 15) | v_right::BIGINT;
        EXIT WHEN v_value < v_domain_size;
    END LOOP;

    FOR v_position IN 1..5 LOOP
        v_code := substr(v_alphabet, (v_value % 62)::INTEGER + 1, 1) || v_code;
        v_value := v_value / 62;
    END LOOP;
    RETURN v_code;
END;
$function$;

COMMENT ON FUNCTION job_public_code(BIGINT) IS
    'Feistel id->5-char base62 code. Session GUC preferred; pinned DB default bridges deploy restart.';

DO $rotate$
DECLARE
    v_updated_at_trigger BOOLEAN;
BEGIN
    IF EXISTS (SELECT 1 FROM jobs WHERE public_code IS DISTINCT FROM job_public_code(id)) THEN
        SELECT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'jobs'::regclass
              AND tgname = 'trg_jobs_updated_at'
              AND NOT tgisinternal
        ) INTO v_updated_at_trigger;
        IF v_updated_at_trigger THEN
            ALTER TABLE jobs DISABLE TRIGGER trg_jobs_updated_at;
        END IF;
        UPDATE jobs SET public_code = NULL;
        UPDATE jobs SET public_code = job_public_code(id);
        IF v_updated_at_trigger THEN
            ALTER TABLE jobs ENABLE TRIGGER trg_jobs_updated_at;
        END IF;
    END IF;
EXCEPTION WHEN OTHERS THEN
    IF v_updated_at_trigger THEN
        ALTER TABLE jobs ENABLE TRIGGER trg_jobs_updated_at;
    END IF;
    RAISE;
END
$rotate$;

COMMIT;
