-- Migration 078: Copy non-empty job comments into structured notes
-- This is a one-time migration. After running, the JobComments UI component is removed.
-- Comments text is prepended to the notes JSONB array as a migrated note.

UPDATE jobs
SET notes = jsonb_build_array(
    jsonb_build_object(
        'text', comments,
        'created', COALESCE(to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        'migrated', true
    )
) || COALESCE(notes, '[]'::jsonb)
WHERE comments IS NOT NULL
  AND comments != ''
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(notes, '[]'::jsonb)) AS n
    WHERE (n->>'migrated')::boolean = true
      AND n->>'text' = comments
  );
