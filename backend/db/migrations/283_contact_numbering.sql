-- CONTACT-NUMBERING-001: global durable codes for contacts.

BEGIN;

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS public_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_public_code
    ON contacts(public_code);

-- This is the same four-round Feistel/cycle-walk construction used by
-- job_public_code and lead_public_code. Contacts deliberately reuse the
-- existing jobs GUC key; the route prefix provides a separate namespace.
CREATE OR REPLACE FUNCTION contact_public_code(p_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
STRICT
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_domain_size CONSTANT BIGINT := 916132832; -- 62^5
    v_half_mask CONSTANT INTEGER := 32767;      -- 2^15 - 1
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
            'contact id % is outside the 5-character public-code domain [0, %)',
            p_id,
            v_domain_size
            USING ERRCODE = '22003';
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

COMMENT ON FUNCTION contact_public_code(BIGINT) IS
    'Feistel/cycle-walk id->5-char base62 contact code. Reuses GUC app.job_code_feistel_key.';

CREATE OR REPLACE FUNCTION contacts_assign_public_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
BEGIN
    IF NEW.public_code IS NULL THEN
        NEW.public_code := contact_public_code(NEW.id);
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_contacts_assign_public_code ON contacts;
CREATE TRIGGER trg_contacts_assign_public_code
    BEFORE INSERT ON contacts
    FOR EACH ROW
    EXECUTE FUNCTION contacts_assign_public_code();

UPDATE contacts
SET public_code = contact_public_code(id)
WHERE public_code IS NULL;

COMMIT;
