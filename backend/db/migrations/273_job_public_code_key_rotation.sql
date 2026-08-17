-- JOB-NUMBERING-001 key rotation: move the Feistel secret OUT of committed SQL.
--
-- Migration 271 embedded the Feistel key as a literal (17590483). That value is
-- now in git history, so it is no longer a secret. This migration:
--   1. Redefines job_public_code to read the key from a session GUC
--      (app.job_code_feistel_key, fed from env JOB_CODE_FEISTEL_KEY at deploy) —
--      NO literal here — and fails loud if the GUC is unset (a mis-configured
--      deploy errors immediately instead of silently minting wrong codes).
--   2. Regenerates every public_code with the new key.
--
-- Safe to rotate right now ONLY because public_code is not yet emitted in any
-- external link (/j/:code routing is unshipped): regenerating codes is a purely
-- internal relabel with zero external breakage. Do NOT rotate again once durable
-- /j/:code links have been shared.
--
-- The GUC must be set (ALTER DATABASE ... SET, from env) BEFORE this runs, and the
-- app must reconnect after, so its BEFORE INSERT trigger sees the same key.

BEGIN;

-- Was IMMUTABLE; now reads a session GUC, so STABLE is the correct volatility.
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
    -- Secret key from env via GUC. current_setting() with no missing_ok RAISES if
    -- unset — the intended fail-loud. The round constants below are the algorithm,
    -- not the secret, so they stay in code.
    v_stable_key CONSTANT BIGINT := current_setting('app.job_code_feistel_key')::BIGINT;
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
    IF p_id < 0 OR p_id >= v_domain_size THEN
        RAISE EXCEPTION
            'job id % is outside the 5-character public-code domain [0, %)',
            p_id,
            v_domain_size
            USING ERRCODE = '22003';
    END IF;

    LOOP
        v_left := ((v_value >> 15) & v_half_mask)::INTEGER;
        v_right := (v_value & v_half_mask)::INTEGER;

        FOR v_round IN 1..4 LOOP
            -- A keyed avalanche-style round function; Feistel remains bijective
            -- for any deterministic round function.
            v_mixed := (
                v_right::BIGINT * 1103515245
                + v_stable_key
                + v_round_keys[v_round]
            ) & 2147483647;
            v_mixed := v_mixed # (v_mixed >> 16);
            v_mixed := (v_mixed * 2246822519) & 2147483647;
            v_mixed := v_mixed # (v_mixed >> 13);

            v_next_left := v_right;
            v_next_right := (
                v_left # ((v_mixed & v_half_mask)::INTEGER)
            ) & v_half_mask;
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
    'Feistel/cycle-walk id->5-char base62 code. Key from GUC app.job_code_feistel_key (env JOB_CODE_FEISTEL_KEY). Rotated out of committed SQL 2026-08-17 (JOB-NUMBERING-001).';

-- Regenerate every code with the new key. Guarded so a re-run (migrations 083+ are
-- replayed every deploy) is a cheap no-op once codes already match the live key.
-- Two-step NULL-then-recompute avoids a transient UNIQUE collision while swapping
-- (a new code could equal another row's not-yet-updated old code). The BEFORE
-- INSERT trigger does not fire on UPDATE, so this only relabels existing rows.
DO $rotate$
BEGIN
    IF EXISTS (
        SELECT 1 FROM jobs
        WHERE public_code IS DISTINCT FROM job_public_code(id)
    ) THEN
        UPDATE jobs SET public_code = NULL;
        UPDATE jobs SET public_code = job_public_code(id);
    END IF;
END
$rotate$;

COMMIT;
