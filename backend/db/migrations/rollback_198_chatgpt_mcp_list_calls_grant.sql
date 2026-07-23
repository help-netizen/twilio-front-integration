-- Rollback CHATGPT-CRM-MCP-001 S1.1 call-history grant and Marketplace metadata.

DELETE FROM mcp_agent_permission_grants g
USING chatgpt_mcp_bindings b, marketplace_installations mi, marketplace_apps ma
WHERE g.company_id = b.company_id
  AND g.agent_user_id = b.ai_user_id
  AND g.permission_key IN ('pulse.view', 'mcp.tool.svc.list_calls')
  AND mi.id = b.installation_id
  AND mi.company_id = b.company_id
  AND ma.id = mi.app_id
  AND ma.app_key = 'chatgpt-crm-mcp';

UPDATE mcp_agent_permission_grants g
SET bundle_version = 1,
    updated_at = NOW()
FROM chatgpt_mcp_bindings b
JOIN marketplace_installations mi
  ON mi.id = b.installation_id
 AND mi.company_id = b.company_id
JOIN marketplace_apps ma
  ON ma.id = mi.app_id
 AND ma.app_key = 'chatgpt-crm-mcp'
WHERE g.company_id = b.company_id
  AND g.agent_user_id = b.ai_user_id
  AND g.bundle_version = 2;

UPDATE chatgpt_mcp_bindings b
SET grant_version = 1,
    updated_at = NOW()
FROM marketplace_installations mi
JOIN marketplace_apps ma
  ON ma.id = mi.app_id
 AND ma.app_key = 'chatgpt-crm-mcp'
WHERE mi.id = b.installation_id
  AND mi.company_id = b.company_id
  AND b.grant_version = 2;

UPDATE marketplace_apps
SET requested_scopes = COALESCE(requested_scopes, '[]'::jsonb) - 'calls:read',
    metadata = jsonb_set(
        jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{access_summary}',
            (
                SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
                FROM jsonb_array_elements(
                    COALESCE(metadata->'access_summary', '[]'::jsonb)
                ) AS item
                WHERE item <> to_jsonb(
                    'Read recent Calls from Pulse without recordings or provider identifiers'::text
                )
            ),
            true
        ),
        '{assistant}',
        jsonb_set(
            COALESCE(metadata->'assistant', '{}'::jsonb),
            '{recommend_when}',
            (
                SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
                FROM jsonb_array_elements(
                    COALESCE(metadata->'assistant'->'recommend_when', '[]'::jsonb)
                ) AS item
                WHERE item <> to_jsonb(
                    'User wants ChatGPT to review recent inbound or outbound calls and whether AI answered'::text
                )
            ),
            true
        ),
        true
    ),
    updated_at = NOW()
WHERE app_key = 'chatgpt-crm-mcp';
