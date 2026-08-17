-- Rollback for 273: restore the pre-rotation state — the hardcoded-key function
-- from migration 271 (key 17590483, IMMUTABLE) and regenerate codes back to it.
-- Safe only while no external /j/:code links have been shared. After running this
-- the GUC app.job_code_feistel_key is no longer read and may be unset.

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
BEGIN
    IF EXISTS (SELECT 1 FROM jobs WHERE public_code IS DISTINCT FROM job_public_code(id)) THEN
        UPDATE jobs SET public_code = NULL;
        UPDATE jobs SET public_code = job_public_code(id);
    END IF;
END
$rollback$;

COMMIT;
