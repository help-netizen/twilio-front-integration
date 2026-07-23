-- CHATGPT-CRM-MCP-001 S1.1: expose tenant-scoped Pulse call history.

INSERT INTO mcp_agent_permission_grants (
    company_id,
    agent_user_id,
    permission_key,
    bundle_version
)
SELECT
    b.company_id,
    b.ai_user_id,
    permission.permission_key,
    2
FROM chatgpt_mcp_bindings b
JOIN marketplace_installations mi
  ON mi.id = b.installation_id
 AND mi.company_id = b.company_id
JOIN marketplace_apps ma
  ON ma.id = mi.app_id
 AND ma.app_key = 'chatgpt-crm-mcp'
CROSS JOIN (
    VALUES ('pulse.view'), ('mcp.tool.svc.list_calls')
) AS permission(permission_key)
WHERE b.status = 'active'
ON CONFLICT (company_id, agent_user_id, permission_key) DO UPDATE
SET bundle_version = EXCLUDED.bundle_version,
    updated_at = NOW();

UPDATE mcp_agent_permission_grants g
SET bundle_version = 2,
    updated_at = NOW()
FROM chatgpt_mcp_bindings b
JOIN marketplace_installations mi
  ON mi.id = b.installation_id
 AND mi.company_id = b.company_id
JOIN marketplace_apps ma
  ON ma.id = mi.app_id
 AND ma.app_key = 'chatgpt-crm-mcp'
WHERE b.status = 'active'
  AND g.company_id = b.company_id
  AND g.agent_user_id = b.ai_user_id;

UPDATE chatgpt_mcp_bindings b
SET grant_version = 2,
    updated_at = NOW()
FROM marketplace_installations mi
JOIN marketplace_apps ma
  ON ma.id = mi.app_id
 AND ma.app_key = 'chatgpt-crm-mcp'
WHERE mi.id = b.installation_id
  AND mi.company_id = b.company_id
  AND b.status = 'active';

UPDATE marketplace_apps
SET requested_scopes = CASE
        WHEN COALESCE(requested_scopes, '[]'::jsonb) @> '["calls:read"]'::jsonb
            THEN COALESCE(requested_scopes, '[]'::jsonb)
        ELSE COALESCE(requested_scopes, '[]'::jsonb) || '["calls:read"]'::jsonb
    END,
    metadata = jsonb_set(
        jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{access_summary}',
            CASE
                WHEN COALESCE(metadata->'access_summary', '[]'::jsonb)
                     @> '["Read recent Calls from Pulse without recordings or provider identifiers"]'::jsonb
                    THEN COALESCE(metadata->'access_summary', '[]'::jsonb)
                ELSE COALESCE(metadata->'access_summary', '[]'::jsonb)
                     || '["Read recent Calls from Pulse without recordings or provider identifiers"]'::jsonb
            END,
            true
        ),
        '{assistant}',
        jsonb_set(
            COALESCE(metadata->'assistant', '{}'::jsonb),
            '{recommend_when}',
            CASE
                WHEN COALESCE(metadata->'assistant'->'recommend_when', '[]'::jsonb)
                     @> '["User wants ChatGPT to review recent inbound or outbound calls and whether AI answered"]'::jsonb
                    THEN COALESCE(metadata->'assistant'->'recommend_when', '[]'::jsonb)
                ELSE COALESCE(metadata->'assistant'->'recommend_when', '[]'::jsonb)
                     || '["User wants ChatGPT to review recent inbound or outbound calls and whether AI answered"]'::jsonb
            END,
            true
        ),
        true
    ),
    updated_at = NOW()
WHERE app_key = 'chatgpt-crm-mcp';
