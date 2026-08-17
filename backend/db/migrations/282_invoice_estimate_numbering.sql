-- INVOICE-ESTIMATE-NUMBERING-001: durable codes for financial documents and
-- bounded invoice bearer links. Already-issued document numbers stay frozen.

BEGIN;

ALTER TABLE estimates
    ADD COLUMN IF NOT EXISTS public_code TEXT;

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS public_code TEXT,
    ADD COLUMN IF NOT EXISTS public_token_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_public_code
    ON estimates(public_code);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_public_code
    ON invoices(public_code);

-- These functions deliberately use the same Feistel construction and GUC key
-- as job_public_code and lead_public_code. Entity routes provide independent
-- namespaces even when two ids happen to map to the same five-character code.
CREATE OR REPLACE FUNCTION estimate_public_code(p_id BIGINT)
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
            'estimate id % is outside the 5-character public-code domain [0, %)',
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

COMMENT ON FUNCTION estimate_public_code(BIGINT) IS
    'Feistel/cycle-walk id->5-char base62 estimate code. Reuses GUC app.job_code_feistel_key.';

CREATE OR REPLACE FUNCTION invoice_public_code(p_id BIGINT)
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
            'invoice id % is outside the 5-character public-code domain [0, %)',
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

COMMENT ON FUNCTION invoice_public_code(BIGINT) IS
    'Feistel/cycle-walk id->5-char base62 invoice code. Reuses GUC app.job_code_feistel_key.';

CREATE OR REPLACE FUNCTION estimates_assign_public_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
BEGIN
    IF NEW.public_code IS NULL THEN
        NEW.public_code := estimate_public_code(NEW.id);
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION invoices_assign_public_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
BEGIN
    IF NEW.public_code IS NULL THEN
        NEW.public_code := invoice_public_code(NEW.id);
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_estimates_assign_public_code ON estimates;
CREATE TRIGGER trg_estimates_assign_public_code
    BEFORE INSERT ON estimates
    FOR EACH ROW
    EXECUTE FUNCTION estimates_assign_public_code();

DROP TRIGGER IF EXISTS trg_invoices_assign_public_code ON invoices;
CREATE TRIGGER trg_invoices_assign_public_code
    BEFORE INSERT ON invoices
    FOR EACH ROW
    EXECUTE FUNCTION invoices_assign_public_code();

UPDATE estimates
SET public_code = estimate_public_code(id)
WHERE public_code IS NULL;

UPDATE invoices
SET public_code = invoice_public_code(id)
WHERE public_code IS NULL;

-- Existing invoice links may already be in customer hands. Give every legacy
-- token a fresh 18-month window instead of expiring it at deploy time.
UPDATE invoices
SET public_token_expires_at = NOW() + INTERVAL '18 months'
WHERE public_token IS NOT NULL
  AND public_token_expires_at IS NULL;

COMMENT ON COLUMN invoices.public_token_expires_at IS
    'Expiry of the bearer public_token; refreshed whenever the token rotates.';

COMMIT;
