# CRM-SALES-MCP-005: Write MCP Tools

## Scope

Stage 4 exposes MCP write tools for the explicitly allowed CRM update surface only:

- `deal.next_step`
- `deal.stage`
- `deal.forecast_category`
- `deal.close_date`
- `deal.amount`
- `deal.risk_summary`
- `deal.competitor`
- `task.status`

Task and note creation tools remain part of the existing write surface from earlier CRM requirements. They also return a before/after envelope with `before = null` and `after = created entity`. Stage 4 does not add bulk update, delete, account update, contact update, or arbitrary deal update tools.

## Tool Definitions

Deal update tools:

- `crm.update_deal_next_step`
- `crm.update_deal_stage`
- `crm.update_deal_forecast_category`
- `crm.update_deal_close_date`
- `crm.update_deal_amount`
- `crm.update_deal_risk_summary`
- `crm.update_deal_competitor`

Task update tool:

- `crm.update_task_status`

The legacy generic `crm.update_deal_field` stays available for compatibility, but its `field` argument is enum-limited to the same deal allowlist and its `value` is validated against the selected field before dispatch.

All write tools are registered with:

- `kind = write`
- `requiresConfirmation = true`
- `requiredPermission = sales.crm.write`

## Execution Rules

Every write call must:

1. Resolve `company_id` from authenticated request context or env-bound MCP transport context. Client payload cannot override tenant scope.
2. Require `sales.crm.write`.
3. Require explicit confirmation with `confirmed = true` and `confirmation_id`.
4. Validate the MCP tool schema before service dispatch.
5. Validate the CRM service allowlist before SQL update.
6. Generate a CRM MCP request id when upstream middleware or transport context did not provide one.
7. Return changed entity data plus `field`, `before`, and `after`.
8. Write audit with actor, entity, old/new value, timestamp, source `Codex/Sales MCP`, request id, and confirmation metadata.

## Validation

- `deal.amount` must be a non-negative number.
- `deal.close_date` must be a valid `YYYY-MM-DD` calendar date or explicit `null`.
- `deal.stage`, `deal.forecast_category`, and `task.status` are validated against CRM metadata in the service layer.
- Empty `deal.forecast_category` is normalized to `null` rather than stored as an invalid empty category.
- Nullable deal fields can be cleared with explicit `null` where the database model supports it.

## Non-goals

- Bulk deal updates without a separate bulk tool and confirmation model.
- Delete tools for accounts, contacts, deals, tasks, or notes.
- Secret, token, or internal password exposure.
- Access to data outside the current user/company scope.
