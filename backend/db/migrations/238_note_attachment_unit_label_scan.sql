-- UNIT-LABEL-SCAN-001: durable, attachment-level vision scan idempotency.
-- A failed scan may be claimed once more; completed attachments are never
-- sent to the provider again.

ALTER TABLE note_attachments
    ADD COLUMN IF NOT EXISTS unit_label_scan_state TEXT,
    ADD COLUMN IF NOT EXISTS unit_label_scan_attempts SMALLINT,
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

-- Standalone, opt-in Marketplace app. Connecting/disconnecting this pure-gate
-- app controls whether newly committed job/lead note images are scanned.
INSERT INTO marketplace_apps (
    app_key,
    name,
    provider_name,
    category,
    app_type,
    short_description,
    long_description,
    requested_scopes,
    provisioning_mode,
    status,
    support_email,
    metadata
) VALUES (
    'unit-label-scanner',
    'Unit Label Scanner',
    'Albusto',
    'ai',
    'internal',
    'Read appliance nameplates from note photos and add the unit details to the job or lead.',
    'When connected, Unit Label Scanner checks image attachments added to job and lead notes for a manufacturer nameplate or rating label. When a label is legible, it adds one AI-authored note with the brand, model, serial number, manufacturing date and approximate age, plus refrigerant type for refrigeration and HVAC equipment. Scanning runs automatically in the background; there are no credentials or settings to manage.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "access_summary": [
            "Read image attachments added to job and lead notes",
            "Add an AI-authored unit label note to the same job or lead"
        ],
        "requires_credential_input": false,
        "pricing": {
            "paid": false,
            "label": "Free",
            "text": "Free — included with your Albusto plan."
        },
        "assistant": {
            "what_it_does": "Reads appliance and HVAC nameplates in job or lead note photos and adds a structured note with visible brand, model, serial number, manufacturing date or age, and refrigerant details.",
            "prerequisites": ["Technicians or dispatchers attach a clear photo of the unit nameplate to a job or lead note"],
            "setup_steps": ["Open Settings → Integrations", "Find Unit Label Scanner and select Connect", "Attach a unit nameplate photo to a new job or lead note"],
            "outcome": "Visible unit identifiers are captured in the CRM timeline without manual transcription.",
            "recommend_when": ["The team frequently photographs appliance or HVAC nameplates", "The team wants model and serial details captured consistently", "Refrigeration work requires refrigerant details from the unit label"],
            "gotchas": ["Only newly committed image attachments are scanned while the app is connected", "Blurry, obstructed, or incomplete labels may produce no note", "Disconnecting the app stops future scans and does not remove existing AI notes"]
        }
    }'::jsonb
)
ON CONFLICT (app_key) DO UPDATE SET
    name = EXCLUDED.name,
    provider_name = EXCLUDED.provider_name,
    category = EXCLUDED.category,
    app_type = EXCLUDED.app_type,
    short_description = EXCLUDED.short_description,
    long_description = EXCLUDED.long_description,
    requested_scopes = EXCLUDED.requested_scopes,
    provisioning_mode = EXCLUDED.provisioning_mode,
    status = EXCLUDED.status,
    support_email = EXCLUDED.support_email,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

-- Opt-in for every company except the established default tenant, where the
-- owner-approved feature is already live. Any installation history prevents a
-- replay from resurrecting a deliberate disconnect.
INSERT INTO marketplace_installations (
    company_id,
    app_id,
    status,
    installed_at,
    metadata
)
SELECT
    company.id,
    app.id,
    'connected',
    NOW(),
    '{"seeded_by":"UNIT-LABEL-SCAN-001"}'::jsonb
FROM companies company
JOIN marketplace_apps app
  ON app.app_key = 'unit-label-scanner'
WHERE company.id = '00000000-0000-0000-0000-000000000001'::uuid
  AND NOT EXISTS (
      SELECT 1
      FROM marketplace_installations existing
      WHERE existing.company_id = company.id
        AND existing.app_id = app.id
  )
ON CONFLICT (company_id, app_id)
    WHERE status IN ('connected', 'provisioning_failed')
DO NOTHING;
