# CRM-SALES-MCP-007: Testing and Rollout

## Scope

Stage 6 defines the minimum regression and rollout gate for the Sales CRM MCP implementation.

## Test Gate

The minimum test suite must cover:

- Auth and tenant gates: 401/403 behavior for CRM REST, authenticated MCP, and public MCP transports.
- Tenant isolation: entity reads return 404/null and list queries return empty when the current `company_id` does not own the row.
- Write allowlist: only explicitly allowed deal fields and `task.status` can be updated.
- Before/after audit: write services return before/after values and write audit details with actor, request id, source, and confirmation metadata.
- No delete tools: tool registry must not expose delete, remove, archive, destroy, or bulk mutation tools.
- No secret/token leakage: MCP error mapping must sanitize token, secret, password, OAuth, SQL, and stack details.
- Pipeline history/slippage: close date pushes, amount decreases, and stage regressions are detected from deal history.
- Stale activity queries: stale account/deal workflows use activity history and tenant-scoped company filters.
- Predefined Sales workflow lists: discovery, generic list keys, explicit aliases, defaults, timezone windows, and invalid-key behavior.

## Rollout Gate

The CRM/MCP routes must be mounted before rollout:

- `/api/crm` with `authenticate, requireCompanyAccess`
- `/api/crm/mcp` with `authenticate, requireCompanyAccess`
- `/mcp/crm` as public token-gated transport

Public/stdio write behavior must remain fail-closed:

- Public writes require `SALES_MCP_PUBLIC_WRITE_ENABLED=true`.
- stdio writes require `SALES_MCP_STDIO_WRITE_ENABLED=true`.
- Both transports require env-bound company/user context.

## Rollback

Rollback can disable external MCP access without removing CRM data:

- Set `SALES_MCP_PUBLIC_ENABLED=false` or remove `SALES_MCP_PUBLIC_TOKEN`.
- Do not enable public/stdio write flags.
- Keep authenticated `/api/crm` available only to tenant-scoped users while investigating.
