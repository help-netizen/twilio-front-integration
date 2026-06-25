-- Rollback for Migration 124: NOTES-001 — unified notes edit/delete/audit
-- Drops the note_attachments.note_id column and its index.
-- Note: the stable `id` values backfilled onto note JSONB arrays are left in
-- place (they are harmless metadata and irreversible to remove safely).

DROP INDEX IF EXISTS idx_note_attachments_note_id;
ALTER TABLE note_attachments DROP COLUMN IF EXISTS note_id;
