# Test Cases: CRM-SALES-MCP-007 Testing and Rollout

## TC-CRM-MCP-TR-001: Authenticated CRM routes are mounted behind auth

- **Input:** inspect server route mounts for `/api/crm` and `/api/crm/mcp`.
- **Expected:** both are mounted with `authenticate` and `requireCompanyAccess`.

## TC-CRM-MCP-TR-002: Public MCP transport is token gated

- **Input:** call `/mcp/crm` without bearer token and with public transport disabled.
- **Expected:** missing token returns 401; disabled transport returns 403.

## TC-CRM-MCP-TR-003: CRM REST endpoints require tenant context

- **Input:** call representative account, contact, deal, pipeline, activity, task, note, metadata, and list endpoints without `company_id`.
- **Expected:** every read/list endpoint returns 403.

## TC-CRM-MCP-TR-004: CRM writes require permission

- **Input:** call deal update, task update, task create, and note create without `sales.crm.write`.
- **Expected:** every write endpoint returns 403 and no write service is invoked.

## TC-CRM-MCP-TR-005: Authenticated MCP endpoints require tenant context

- **Input:** call `/api/crm/mcp/tools`, `/api/crm/mcp/call`, and `/api/crm/mcp/jsonrpc` without company context.
- **Expected:** every endpoint returns access denied.

## TC-CRM-MCP-TR-006: Tenant isolation is enforced in query layer

- **Input:** entity lookups and updates for a row id under the wrong `company_id`.
- **Expected:** lookup returns null/404; update SQL includes `WHERE company_id = $1 AND id = $2`; list queries include company filters and return empty for foreign data.

## TC-CRM-MCP-TR-007: Write allowlist and before/after audit

- **Input:** allowed and disallowed deal updates.
- **Expected:** disallowed fields fail before transaction; allowed fields return before/after and write audit.

## TC-CRM-MCP-TR-008: No delete or bulk mutation tools

- **Input:** list MCP tools and call unsupported bulk/delete names.
- **Expected:** registry contains no delete/remove/archive/destroy/bulk mutation tools; unsupported calls fail before service dispatch.

## TC-CRM-MCP-TR-009: MCP errors do not leak secrets

- **Input:** errors containing secret-like keys, nested objects, SQL, tokens, passwords, or stacks.
- **Expected:** response details are sanitized and do not contain secret values.

## TC-CRM-MCP-TR-010: Pipeline history and slippage calculations

- **Input:** deal history events for close date push, amount decrease, and stage regression.
- **Expected:** slippage summary identifies the expected deals and excludes non-regressions.

## TC-CRM-MCP-TR-011: Stale activity queries

- **Input:** stale account/deal workflows.
- **Expected:** stale account query uses `crm_activities`; stale deal query uses deal activity window and company scope.

## TC-CRM-MCP-TR-012: Predefined Sales workflow lists

- **Input:** call workflow discovery, generic list keys, and explicit workflow aliases.
- **Expected:** all required workflow lists are available, read-only, tenant-scoped, and use expected defaults/timezone windows.
