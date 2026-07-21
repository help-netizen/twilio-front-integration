-- ============================================================================
-- 194: NOTES-DEDUP-001 — de-duplicate note arrays and restore created times
--
-- Data-shape cleanup across jobs.notes, leads.structured_notes, and
-- contacts.structured_notes. No company predicate is needed: every tenant is
-- repaired identically and only the three JSONB note columns are updated.
-- ============================================================================

CREATE OR REPLACE FUNCTION pg_temp.notes_dedup_backfill(
    note_array JSONB,
    entity_created_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE SQL
AS $migration$
    WITH expanded AS (
        SELECT elem, ord
        FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(note_array) = 'array' THEN note_array ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS note(elem, ord)
    ), identified AS (
        SELECT
            elem,
            ord,
            COALESCE(
                NULLIF(BTRIM(elem->>'zb_note_id'), ''),
                NULLIF(BTRIM(elem->>'id'), '')
            ) AS note_id
        FROM expanded
    ), scored AS (
        SELECT
            elem,
            ord,
            note_id,
            CASE
                WHEN note_id ~ '^[0-9]{13,}x[A-Za-z0-9_-]+$'
                    THEN split_part(note_id, 'x', 1)::numeric
                ELSE NULL
            END AS bubble_ms,
            (CASE WHEN NULLIF(BTRIM(elem->>'deleted_at'), '') IS NOT NULL THEN 32 ELSE 0 END) +
            (CASE WHEN NULLIF(BTRIM(elem->>'edited_at'), '') IS NOT NULL THEN 16 ELSE 0 END) +
            (CASE WHEN NULLIF(BTRIM(elem->>'created_by'), '') IS NOT NULL THEN 8 ELSE 0 END) +
            (CASE WHEN NULLIF(BTRIM(elem->>'deleted_by'), '') IS NOT NULL THEN 4 ELSE 0 END) +
            (CASE WHEN NULLIF(BTRIM(elem->>'edited_by'), '') IS NOT NULL THEN 4 ELSE 0 END) +
            (CASE
                WHEN jsonb_typeof(elem->'attachments') = 'array'
                     AND jsonb_array_length(elem->'attachments') > 0 THEN 2
                ELSE 0
            END) +
            (CASE WHEN NULLIF(BTRIM(elem->>'created'), '') IS NOT NULL THEN 1 ELSE 0 END)
                AS richness
        FROM identified
    ), ranked AS (
        SELECT
            elem,
            ord,
            note_id,
            bubble_ms,
            MIN(ord) OVER (PARTITION BY
                CASE WHEN note_id IS NULL THEN 'ordinal:' || ord::text ELSE 'id:' || note_id END
            ) AS first_ord,
            ROW_NUMBER() OVER (
                PARTITION BY
                    CASE WHEN note_id IS NULL THEN 'ordinal:' || ord::text ELSE 'id:' || note_id END
                ORDER BY richness DESC, ord ASC
            ) AS survivor_rank
        FROM scored
    )
    SELECT COALESCE(
        jsonb_agg(
            CASE
                WHEN jsonb_typeof(elem) = 'object'
                     AND NULLIF(BTRIM(elem->>'created'), '') IS NULL
                THEN elem || CASE
                    WHEN bubble_ms > 1000000000000
                         AND bubble_ms <= 8640000000000000
                    THEN jsonb_build_object(
                        'created',
                        to_char(
                            to_timestamp((bubble_ms / 1000)::double precision) AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        )
                    )
                    WHEN entity_created_at IS NOT NULL
                    THEN jsonb_build_object(
                        'created',
                        to_char(
                            entity_created_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        )
                    )
                    ELSE '{}'::jsonb
                END
                ELSE elem
            END
            ORDER BY first_ord
        ),
        '[]'::jsonb
    )
    FROM ranked
    WHERE survivor_rank = 1
$migration$;

WITH rebuilt AS (
    SELECT id, pg_temp.notes_dedup_backfill(notes, created_at) AS notes
    FROM jobs
    WHERE jsonb_typeof(notes) = 'array'
)
UPDATE jobs AS target
SET notes = rebuilt.notes
FROM rebuilt
WHERE target.id = rebuilt.id
  AND target.notes IS DISTINCT FROM rebuilt.notes;

WITH rebuilt AS (
    SELECT id, pg_temp.notes_dedup_backfill(structured_notes, created_at) AS notes
    FROM leads
    WHERE jsonb_typeof(structured_notes) = 'array'
)
UPDATE leads AS target
SET structured_notes = rebuilt.notes
FROM rebuilt
WHERE target.id = rebuilt.id
  AND target.structured_notes IS DISTINCT FROM rebuilt.notes;

WITH rebuilt AS (
    SELECT id, pg_temp.notes_dedup_backfill(structured_notes, created_at) AS notes
    FROM contacts
    WHERE jsonb_typeof(structured_notes) = 'array'
)
UPDATE contacts AS target
SET structured_notes = rebuilt.notes
FROM rebuilt
WHERE target.id = rebuilt.id
  AND target.structured_notes IS DISTINCT FROM rebuilt.notes;
