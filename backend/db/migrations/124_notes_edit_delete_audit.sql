-- ============================================================================
-- 124: NOTES-001 — unified notes (edit, soft-delete, attachment edit, audit)
--
-- (a) note_attachments.note_id — links an attachment to a specific note by its
--     stable id (replaces the brittle positional note_index join).
-- (b) Backfill a stable `id` onto every note lacking one across all three note
--     arrays (jobs.notes, leads.structured_notes, contacts.structured_notes).
-- (c) Backfill note_attachments.note_id from (entity_type, entity_id, note_index)
--     by reading the now-stamped id at that array index.
--
-- Idempotent and additive.
-- ============================================================================

-- (a) note_id column + lookup index ------------------------------------------
ALTER TABLE note_attachments ADD COLUMN IF NOT EXISTS note_id TEXT;

CREATE INDEX IF NOT EXISTS idx_note_attachments_note_id
    ON note_attachments (entity_type, entity_id, note_id);

-- (b) Backfill stable ids onto notes -----------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- jobs.notes
UPDATE jobs j
SET notes = (
    SELECT jsonb_agg(
        CASE
            WHEN elem ? 'id' AND elem->>'id' IS NOT NULL AND elem->>'id' <> ''
                THEN elem
            ELSE elem || jsonb_build_object('id', gen_random_uuid()::text)
        END
        ORDER BY ord
    )
    FROM jsonb_array_elements(j.notes) WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_typeof(j.notes) = 'array'
  AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(j.notes) AS e(elem)
      WHERE NOT (e.elem ? 'id') OR e.elem->>'id' IS NULL OR e.elem->>'id' = ''
  );

-- leads.structured_notes
UPDATE leads l
SET structured_notes = (
    SELECT jsonb_agg(
        CASE
            WHEN elem ? 'id' AND elem->>'id' IS NOT NULL AND elem->>'id' <> ''
                THEN elem
            ELSE elem || jsonb_build_object('id', gen_random_uuid()::text)
        END
        ORDER BY ord
    )
    FROM jsonb_array_elements(l.structured_notes) WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_typeof(l.structured_notes) = 'array'
  AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(l.structured_notes) AS e(elem)
      WHERE NOT (e.elem ? 'id') OR e.elem->>'id' IS NULL OR e.elem->>'id' = ''
  );

-- contacts.structured_notes
UPDATE contacts c
SET structured_notes = (
    SELECT jsonb_agg(
        CASE
            WHEN elem ? 'id' AND elem->>'id' IS NOT NULL AND elem->>'id' <> ''
                THEN elem
            ELSE elem || jsonb_build_object('id', gen_random_uuid()::text)
        END
        ORDER BY ord
    )
    FROM jsonb_array_elements(c.structured_notes) WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_typeof(c.structured_notes) = 'array'
  AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(c.structured_notes) AS e(elem)
      WHERE NOT (e.elem ? 'id') OR e.elem->>'id' IS NULL OR e.elem->>'id' = ''
  );

-- (c) Backfill note_attachments.note_id from the array index -----------------
-- jobs: entity_id = jobs.id
UPDATE note_attachments na
SET note_id = sub.note_id
FROM (
    SELECT j.id AS entity_id, (t.ord - 1) AS note_index, t.elem->>'id' AS note_id
    FROM jobs j,
         jsonb_array_elements(j.notes) WITH ORDINALITY AS t(elem, ord)
    WHERE jsonb_typeof(j.notes) = 'array'
) sub
WHERE na.entity_type = 'job'
  AND na.note_id IS NULL
  AND na.note_index IS NOT NULL
  AND na.entity_id = sub.entity_id
  AND na.note_index = sub.note_index
  AND sub.note_id IS NOT NULL;

-- leads: entity_id = leads.serial_id
UPDATE note_attachments na
SET note_id = sub.note_id
FROM (
    SELECT l.serial_id AS entity_id, (t.ord - 1) AS note_index, t.elem->>'id' AS note_id
    FROM leads l,
         jsonb_array_elements(l.structured_notes) WITH ORDINALITY AS t(elem, ord)
    WHERE jsonb_typeof(l.structured_notes) = 'array'
) sub
WHERE na.entity_type = 'lead'
  AND na.note_id IS NULL
  AND na.note_index IS NOT NULL
  AND na.entity_id = sub.entity_id
  AND na.note_index = sub.note_index
  AND sub.note_id IS NOT NULL;

-- contacts: entity_id = contacts.id
UPDATE note_attachments na
SET note_id = sub.note_id
FROM (
    SELECT c.id AS entity_id, (t.ord - 1) AS note_index, t.elem->>'id' AS note_id
    FROM contacts c,
         jsonb_array_elements(c.structured_notes) WITH ORDINALITY AS t(elem, ord)
    WHERE jsonb_typeof(c.structured_notes) = 'array'
) sub
WHERE na.entity_type = 'contact'
  AND na.note_id IS NULL
  AND na.note_index IS NOT NULL
  AND na.entity_id = sub.entity_id
  AND na.note_index = sub.note_index
  AND sub.note_id IS NOT NULL;
