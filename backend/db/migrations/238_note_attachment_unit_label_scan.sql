-- UNIT-LABEL-SCAN-001: durable, attachment-level vision scan idempotency.
-- A failed scan may be claimed once more; completed attachments are never
-- sent to the provider again.

ALTER TABLE note_attachments
    ADD COLUMN IF NOT EXISTS unit_label_scan_state TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS unit_label_scan_attempts SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unit_label_scan_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS unit_label_scanned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS unit_label_scan_last_error TEXT,
    ADD COLUMN IF NOT EXISTS unit_label_note_id TEXT;

ALTER TABLE note_attachments
    DROP CONSTRAINT IF EXISTS note_attachments_unit_label_scan_state_check,
    ADD CONSTRAINT note_attachments_unit_label_scan_state_check
        CHECK (unit_label_scan_state IN ('pending', 'processing', 'completed', 'failed')),
    DROP CONSTRAINT IF EXISTS note_attachments_unit_label_scan_attempts_check,
    ADD CONSTRAINT note_attachments_unit_label_scan_attempts_check
        CHECK (unit_label_scan_attempts BETWEEN 0 AND 2);

