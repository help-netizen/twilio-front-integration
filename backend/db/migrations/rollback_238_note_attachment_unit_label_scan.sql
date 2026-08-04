DELETE FROM marketplace_installations installation
USING marketplace_apps app
WHERE installation.app_id = app.id
  AND app.app_key = 'unit-label-scanner';

DELETE FROM marketplace_apps
WHERE app_key = 'unit-label-scanner';

ALTER TABLE note_attachments
    DROP COLUMN IF EXISTS unit_label_note_id,
    DROP COLUMN IF EXISTS unit_label_scan_last_error,
    DROP COLUMN IF EXISTS unit_label_scanned_at,
    DROP COLUMN IF EXISTS unit_label_scan_started_at,
    DROP COLUMN IF EXISTS unit_label_scan_attempts,
    DROP COLUMN IF EXISTS unit_label_scan_state;
