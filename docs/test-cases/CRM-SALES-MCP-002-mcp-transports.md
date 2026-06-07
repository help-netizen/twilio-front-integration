# Test Cases: CRM-SALES-MCP-002 MCP Transports

## TC-CRM-MCP-TX-001: Public endpoint rejects missing token
- **Priority:** P0
- **Type:** Integration
- **Expected:** `POST /mcp/crm` without bearer token returns unauthorized JSON-RPC error.
- **Test file:** `tests/routes/crmMcpPublic.test.js`

## TC-CRM-MCP-TX-002: Public endpoint supports initialize and tools/list
- **Priority:** P0
- **Type:** Integration
- **Expected:** JSON-RPC `initialize` and `tools/list` return MCP server info and tools.
- **Test file:** `tests/routes/crmMcpPublic.test.js`

## TC-CRM-MCP-TX-003: Public read tool uses env-bound context
- **Priority:** P0
- **Type:** Integration
- **Expected:** `tools/call crm.search_accounts` calls CRM service with `SALES_MCP_PUBLIC_COMPANY_ID`.
- **Test file:** `tests/routes/crmMcpPublic.test.js`

## TC-CRM-MCP-TX-004: Public write tool is disabled by default
- **Priority:** P0
- **Type:** Integration
- **Expected:** confirmed write call returns access denied unless `SALES_MCP_PUBLIC_WRITE_ENABLED=true`.
- **Test file:** `tests/routes/crmMcpPublic.test.js`

## TC-CRM-MCP-TX-005: Public write tool works when enabled
- **Priority:** P0
- **Type:** Integration
- **Expected:** confirmed write call reaches CRM service with public actor and confirmation context.
- **Test file:** `tests/routes/crmMcpPublic.test.js`

## TC-CRM-MCP-TX-006: Legacy SSE delivers message responses
- **Priority:** P1
- **Type:** Integration
- **Expected:** SSE stream publishes endpoint session and receives JSON-RPC response after POST to messages endpoint.
- **Test file:** `tests/routes/crmMcpPublic.test.js`

## TC-CRM-MCP-TX-007: stdio CLI responds to tools/list
- **Priority:** P1
- **Type:** Integration
- **Expected:** CLI reads JSON-RPC from stdin and writes JSON-RPC response to stdout.
- **Test file:** `tests/cli/crmMcpStdio.test.js`
