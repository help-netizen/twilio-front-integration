-- Rollback 273: restore migration 271's historical hardcoded-key function.
-- Safe only before durable /j/:code links are shared.

BEGIN;

CREATE OR REPLACE FUNCTION job_public_code(p_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_domain_size CONSTANT BIGINT := 916132832;
    v_half_mask CONSTANT INTEGER := 32767;
    v_stable_key CONSTANT BIGINT := 17590483;
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
        RAISE EXCEPTION 'job id % is outside the 5-character public-code domain [0, %)',
            p_id, v_domain_size USING ERRCODE = '22003';
    END IF;
    LOOP
        v_left := ((v_value >> 15) & v_half_mask)::INTEGER;
        v_right := (v_value & v_half_mask)::INTEGER;
        FOR v_round IN 1..4 LOOP
            v_mixed := (v_right::BIGINT * 1103515245 + v_stable_key + v_round_keys[v_round]) & 2147483647;
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

DO $rollback$
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
$rollback$;

DROP TABLE IF EXISTS job_public_code_key_state;

COMMIT;
