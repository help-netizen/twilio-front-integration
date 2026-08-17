-- JOB-NUMBERING-001: Albusto-native global and per-company job identifiers.
-- The transaction keeps live inserts out of the backfill/counter/trigger gap.

BEGIN;

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS public_code TEXT,
    ADD COLUMN IF NOT EXISTS job_seq INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_public_code
    ON jobs(public_code);

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_company_job_seq
    ON jobs(company_id, job_seq);

CREATE TABLE IF NOT EXISTS company_job_counters (
    company_id UUID PRIMARY KEY,
    next_seq INTEGER NOT NULL
);

-- Four-round Feistel permutation over 2^30 (two 15-bit halves), restricted to
-- [0, 62^5) by cycle-walking. The embedded key and round constants MUST NEVER
-- rotate: public_code values are stored, and a different permutation could map a
-- future id onto a code generated with the old key. The constants hide ordering;
-- they are not intended to provide cryptographic secrecy.
CREATE OR REPLACE FUNCTION job_public_code(p_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_domain_size CONSTANT BIGINT := 916132832; -- 62^5
    v_half_mask CONSTANT INTEGER := 32767;      -- 2^15 - 1
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
    'Stable four-round keyed Feistel/cycle-walk mapping from job id to a five-character base62 public code. Constants must never rotate.';

-- Clean owner-approved backfill: canonical 1..N within each company, ordered by
-- original creation time and id. Ranking all rows but updating only NULL rows
-- keeps a replay idempotent without changing already-issued identifiers.
UPDATE jobs
SET public_code = job_public_code(id)
WHERE public_code IS NULL;

WITH ranked_jobs AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY company_id
               ORDER BY created_at, id
           )::INTEGER AS assigned_seq
    FROM jobs
)
UPDATE jobs job
SET job_seq = ranked_jobs.assigned_seq
FROM ranked_jobs
WHERE job.id = ranked_jobs.id
  AND job.job_seq IS NULL;

-- next_seq is the next unallocated number. GREATEST prevents a migration replay
-- from moving a counter backwards if jobs have since been deleted.
INSERT INTO company_job_counters (company_id, next_seq)
SELECT company_id, MAX(job_seq) + 1
FROM jobs
WHERE company_id IS NOT NULL
  AND job_seq IS NOT NULL
GROUP BY company_id
ON CONFLICT (company_id) DO UPDATE
SET next_seq = GREATEST(
    company_job_counters.next_seq,
    EXCLUDED.next_seq
);

CREATE OR REPLACE FUNCTION jobs_assign_identifiers()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_next_seq INTEGER;
BEGIN
    -- BIGSERIAL defaults are evaluated before BEFORE INSERT triggers, so NEW.id
    -- is populated here unless a caller explicitly overrides it with NULL.
    IF NEW.public_code IS NULL THEN
        IF NEW.id IS NULL THEN
            RAISE EXCEPTION 'jobs.id must be populated before assigning public_code';
        END IF;
        NEW.public_code := job_public_code(NEW.id);
    END IF;

    IF NEW.job_seq IS NULL THEN
        IF NEW.company_id IS NULL THEN
            RAISE EXCEPTION 'jobs.company_id is required to assign job_seq';
        END IF;

        -- Stored next_seq always remains one ahead of the value returned. A new
        -- company inserts 2 and receives 1; an existing company atomically bumps
        -- its row under ON CONFLICT's row lock and receives the prior next_seq.
        INSERT INTO company_job_counters (company_id, next_seq)
        VALUES (NEW.company_id, 2)
        ON CONFLICT (company_id) DO UPDATE
        SET next_seq = company_job_counters.next_seq + 1
        RETURNING next_seq - 1 INTO v_next_seq;

        NEW.job_seq := v_next_seq;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_jobs_assign_identifiers ON jobs;
CREATE TRIGGER trg_jobs_assign_identifiers
    BEFORE INSERT ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION jobs_assign_identifiers();

COMMIT;
