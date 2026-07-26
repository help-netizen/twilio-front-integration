-- LEAD-INSTALL-GATE-001: make the live ABC Homes Yelp installation durable
-- before Yelp runtime behavior is gated by Marketplace connection state.
--
-- The credential is intentionally shared with the existing lead-ingestion
-- integration. A disconnected/revoked historical row does not prevent a new
-- connected installation; an already-active row is preserved byte-for-byte.

INSERT INTO marketplace_installations (
    company_id,
    app_id,
    api_integration_id,
    status,
    installed_at,
    metadata
)
SELECT
    '00000000-0000-0000-0000-000000000001'::uuid,
    app.id,
    integration.id,
    'connected',
    NOW(),
    '{"seeded_by":"YELP-INSTALL-001","shared_credential":true}'::jsonb
FROM marketplace_apps app
JOIN api_integrations integration
  ON integration.id = 1
 AND integration.company_id = '00000000-0000-0000-0000-000000000001'::uuid
 AND integration.revoked_at IS NULL
WHERE app.app_key = 'yelp-leads'
  AND NOT EXISTS (
      SELECT 1
      FROM marketplace_installations existing
      WHERE existing.company_id = '00000000-0000-0000-0000-000000000001'::uuid
        AND existing.app_id = app.id
        AND existing.status IN ('connected', 'provisioning_failed')
  );
