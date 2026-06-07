# Test Cases: CRM-SALES-MCP-001 Sales MCP Backend Adapter

## TC-CRM-MCP-001: Tool list returns stable definitions
- **Priority:** P0
- **Type:** Integration
- **Input:** `GET /api/crm/mcp/tools` with authenticated company context.
- **Expected:** response includes read/write tools, JSON schemas, `kind`, and confirmation metadata.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-002: Read tool dispatches to CRM service with company scope
- **Priority:** P0
- **Type:** Integration
- **Input:** `POST /api/crm/mcp/call` for `crm.search_accounts`.
- **Expected:** `crmAccountsService.listAccounts(companyId, args)` is called and response has `content` plus `structuredContent`.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-003: Unsupported tool returns sanitized unsupported error
- **Priority:** P0
- **Type:** Integration
- **Input:** call `crm.bulk_update_deals`.
- **Expected:** `ok=false`, `error.code=unsupported_tool`; no CRM service called.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-004: Write tool requires CRM write permission
- **Priority:** P0
- **Type:** Integration
- **Input:** call `crm.update_deal_field` without `sales.crm.write`.
- **Expected:** `ok=false`, `error.code=access_denied`; no CRM update service called.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-005: Write tool requires confirmation
- **Priority:** P0
- **Type:** Integration
- **Input:** call `crm.update_deal_field` with permission but without confirmation.
- **Expected:** `ok=false`, `error.code=confirmation_required`; no CRM update service called.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-006: Allowed deal write returns before/after
- **Priority:** P0
- **Type:** Integration
- **Input:** confirmed `crm.update_deal_field` for `next_step`.
- **Expected:** `crmDealsService.updateDeal` receives single-field payload and actor context; response includes before/after.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-007: Task status write returns before/after
- **Priority:** P0
- **Type:** Integration
- **Input:** confirmed `crm.update_task_status`.
- **Expected:** task service receives task id/status and actor context; response includes before/after.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-008: Current-user list defaults to actor
- **Priority:** P1
- **Type:** Unit
- **Input:** executor call for `crm.get_sales_list` with `list_key=my_open_deals` and no `owner_user_id`.
- **Expected:** list service receives actor context and uses current user default.
- **Test file:** `tests/services/crmMcpToolExecutor.test.js`

## TC-CRM-MCP-009: CRM bad request maps to invalid_request
- **Priority:** P0
- **Type:** Unit
- **Input:** CRM service throws `CrmServiceError('BAD_REQUEST', ...)`.
- **Expected:** MCP error code `invalid_request`; no stack trace or SQL details.
- **Test file:** `tests/services/crmMcpResponse.test.js`

## TC-CRM-MCP-010: CRM not found maps to not_found
- **Priority:** P0
- **Type:** Unit
- **Input:** CRM service throws `CrmServiceError('NOT_FOUND', ...)`.
- **Expected:** MCP error code `not_found`.
- **Test file:** `tests/services/crmMcpResponse.test.js`

## TC-CRM-MCP-011: Missing tenant context returns access denied
- **Priority:** P0
- **Type:** Integration
- **Input:** MCP call without `req.companyFilter`.
- **Expected:** `ok=false`, `error.code=access_denied`.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-012: Response sanitizer avoids internal error leakage
- **Priority:** P1
- **Type:** Unit
- **Input:** unexpected error with message containing SQL-like text.
- **Expected:** response uses generic `internal_error` message and does not include stack or SQL.
- **Test file:** `tests/services/crmMcpResponse.test.js`

## TC-CRM-MCP-013: Runtime schema validation rejects invalid arguments
- **Priority:** P0
- **Type:** Unit/Integration
- **Input:** call `crm.get_deal` without `deal_id`; call `crm.update_deal_field` with non-allowlisted field.
- **Expected:** `invalid_request` before CRM service dispatch.
- **Test files:** `tests/routes/crmMcp.test.js`, `tests/services/crmMcpSchemaValidator.test.js`

## TC-CRM-MCP-014: Explicit current-user open deals tool
- **Priority:** P1
- **Type:** Integration
- **Input:** call `crm.list_my_open_deals`.
- **Expected:** service receives `list_key = my_open_deals` and actor context.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-015: All write tools pass confirmation context
- **Priority:** P0
- **Type:** Integration
- **Input:** confirmed calls for `crm.create_task`, `crm.update_task_status`, and `crm.create_note`.
- **Expected:** write services receive confirmation id/reason in context.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-016: Write audit stores confirmation metadata
- **Priority:** P0
- **Type:** Unit
- **Input:** field update and create action audit with confirmation id/reason.
- **Expected:** audit details include `confirmation_id` and `confirmation_reason`.
- **Test files:** `tests/services/crmWriteAuditService.test.js`, `tests/services/crmTasksService.test.js`, `tests/services/crmNotesService.test.js`

## TC-CRM-MCP-017: JSON-RPC-compatible methods work
- **Priority:** P1
- **Type:** Integration
- **Input:** `POST /api/crm/mcp/jsonrpc` with `tools/list` and `tools/call`.
- **Expected:** response uses JSON-RPC envelope and preserves structured tool result.
- **Test file:** `tests/routes/crmMcp.test.js`
