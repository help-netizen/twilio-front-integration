# Test Cases: CRM-SALES-MCP-003 Read-only MCP Tools

## TC-CRM-MCP-RO-001: Registry exposes explicit read-only tools
- **Priority:** P0
- **Type:** Unit
- **Expected:** registry includes deal hygiene, account/contact/task workflow, last activity, and deal history tools with `kind=read`.
- **Test file:** `tests/services/crmMcpToolRegistry.test.js`

## TC-CRM-MCP-RO-002: Deal hygiene tools execute without write permission
- **Priority:** P0
- **Type:** Integration
- **Expected:** `crm.find_deals_without_next_step` and `crm.find_deals_without_activity` dispatch to deal services without `sales.crm.write`.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-RO-003: Last customer-facing activity maps entity filters
- **Priority:** P0
- **Type:** Integration
- **Expected:** `entity_type=deal` maps to `{ deal_id }`.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-RO-004: Workflow aliases dispatch to list services
- **Priority:** P1
- **Type:** Integration
- **Expected:** top accounts, accounts needing follow-up, and similar aliases use predefined CRM list service.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-RO-005: Deal history validates tenant-scoped deal exists
- **Priority:** P0
- **Type:** Unit/Integration
- **Expected:** service validates deal exists in company before returning history.
- **Test files:** `tests/services/crmDealsService.test.js`, `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-RO-006: Read-only tool discovery can be filtered
- **Priority:** P0
- **Type:** Unit/Integration
- **Expected:** registry, backend MCP, and public JSON-RPC `tools/list` support `kind=read` and omit write tools.
- **Test files:** `tests/services/crmMcpToolRegistry.test.js`, `tests/routes/crmMcp.test.js`, `tests/routes/crmMcpPublic.test.js`

## TC-CRM-MCP-RO-007: Date-window arguments are validated before dispatch
- **Priority:** P0
- **Type:** Unit/Integration
- **Expected:** invalid dates such as `2026-02-30` or date-time strings are rejected before deal service calls.
- **Test files:** `tests/services/crmMcpSchemaValidator.test.js`, `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-RO-008: Schema-declared list limits are honored
- **Priority:** P1
- **Type:** Unit
- **Expected:** `crm.find_risky_deals.limit` reaches the underlying open-deal lookup before filtering risky deals.
- **Test file:** `tests/services/crmListsService.test.js`
