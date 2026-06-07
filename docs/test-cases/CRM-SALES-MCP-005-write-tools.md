# Test Cases: CRM-SALES-MCP-005 Write Tools

## TC-CRM-MCP-WR-001: Tool registry exposes typed write tools

- **Input:** list MCP tools.
- **Expected:** allowed deal field tools and `crm.update_task_status` are `kind=write`, require confirmation, and require `sales.crm.write`.

## TC-CRM-MCP-WR-002: Write tool requires tenant context

- **Input:** call any write tool without company context.
- **Expected:** call fails with `access_denied`; no service dispatch occurs.

## TC-CRM-MCP-WR-003: Write tool requires CRM write permission

- **Input:** confirmed write call without `sales.crm.write`.
- **Expected:** call fails with `access_denied`; no service dispatch occurs.

## TC-CRM-MCP-WR-004: Write tool requires explicit confirmation

- **Input:** write call with permission but without `{ confirmed: true, confirmation_id }`.
- **Expected:** call fails with `confirmation_required`; no service dispatch occurs.

## TC-CRM-MCP-WR-005: Deal write returns before/after and writes audit

- **Input:** confirmed `crm.update_deal_next_step` or field-specific deal write.
- **Expected:** CRM service updates one allowlisted field, returns `field`, `before`, `after`, and writes audit with actor, entity, source, request id, and confirmation metadata.

## TC-CRM-MCP-WR-006: Task status write returns before/after and writes audit

- **Input:** confirmed `crm.update_task_status`.
- **Expected:** CRM service validates metadata status, returns before/after, and writes audit for `task.status`.

## TC-CRM-MCP-WR-007: Invalid typed values are rejected before dispatch

- **Input:** `crm.update_deal_amount` with negative or non-number value; `crm.update_deal_close_date` with invalid calendar date.
- **Expected:** call fails with `invalid_request`; deal service is not invoked.

## TC-CRM-MCP-WR-007A: Generic deal write validates selected field value

- **Input:** `crm.update_deal_field` with `field = amount` and string value.
- **Expected:** call fails with `invalid_request`; deal service is not invoked.

## TC-CRM-MCP-WR-008: Service allowlist blocks unsupported fields

- **Input:** direct or generic write attempt for a field outside the deal allowlist.
- **Expected:** call fails with bad request / invalid request; no SQL update or audit write occurs.

## TC-CRM-MCP-WR-009: Bulk and delete tools are unavailable

- **Input:** call `crm.bulk_update_deals` or delete-style tool names.
- **Expected:** call fails with `unsupported_tool`; no CRM service is invoked.

## TC-CRM-MCP-WR-010: Write request id is always present

- **Input:** confirmed write call through MCP route without upstream `requestId`.
- **Expected:** executor generates a `crm-mcp-*` request id, returns it in response meta, and passes it to the CRM service/audit context.

## TC-CRM-MCP-WR-011: Create write tools return before/after envelope

- **Input:** confirmed `crm.create_task` or `crm.create_note`.
- **Expected:** service response includes created entity plus `field`, `before = null`, and `after = created entity`; write audit still records the create action.
