-- LEAD-NUMBERING-001: global durable codes and per-company display numbers.

BEGIN;

ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS public_code TEXT,
    ADD COLUMN IF NOT EXISTS lead_seq INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_public_code
    ON leads(public_code);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_company_lead_seq
    ON leads(company_id, lead_seq);

CREATE TABLE IF NOT EXISTS company_lead_counters (
    company_id UUID PRIMARY KEY,
    next_seq INTEGER NOT NULL
);

-- This is the same four-round Feistel/cycle-walk construction used by
-- job_public_code. Leads deliberately reuse the existing jobs GUC key; the
-- /l/ and /j/ route prefixes provide separate namespaces.
CREATE OR REPLACE FUNCTION lead_public_code(p_id BIGINT)
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
            'lead id % is outside the 5-character public-code domain [0, %)',
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

COMMENT ON FUNCTION lead_public_code(BIGINT) IS
    'Feistel/cycle-walk id->5-char base62 lead code. Reuses GUC app.job_code_feistel_key (env JOB_CODE_FEISTEL_KEY).';

UPDATE leads
SET public_code = lead_public_code(id)
WHERE public_code IS NULL;

WITH ranked_leads AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY company_id
               ORDER BY created_at, id
           )::INTEGER AS assigned_seq
    FROM leads
    WHERE company_id IS NOT NULL
)
UPDATE leads lead
SET lead_seq = ranked_leads.assigned_seq
FROM ranked_leads
WHERE lead.id = ranked_leads.id
  AND lead.lead_seq IS NULL;

INSERT INTO company_lead_counters (company_id, next_seq)
SELECT company_id, MAX(lead_seq) + 1
FROM leads
WHERE company_id IS NOT NULL
  AND lead_seq IS NOT NULL
GROUP BY company_id
ON CONFLICT (company_id) DO UPDATE
SET next_seq = GREATEST(
    company_lead_counters.next_seq,
    EXCLUDED.next_seq
);

CREATE OR REPLACE FUNCTION leads_assign_identifiers()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_next_seq INTEGER;
BEGIN
    IF NEW.public_code IS NULL THEN
        IF NEW.id IS NULL THEN
            RAISE EXCEPTION 'leads.id must be populated before assigning public_code';
        END IF;
        NEW.public_code := lead_public_code(NEW.id);
    END IF;

    IF NEW.lead_seq IS NULL AND NEW.company_id IS NOT NULL THEN
        INSERT INTO company_lead_counters (company_id, next_seq)
        VALUES (NEW.company_id, 2)
        ON CONFLICT (company_id) DO UPDATE
        SET next_seq = company_lead_counters.next_seq + 1
        RETURNING next_seq - 1 INTO v_next_seq;

        NEW.lead_seq := v_next_seq;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_leads_assign_identifiers ON leads;
CREATE TRIGGER trg_leads_assign_identifiers
    BEFORE INSERT ON leads
    FOR EACH ROW
    EXECUTE FUNCTION leads_assign_identifiers();

COMMIT;
