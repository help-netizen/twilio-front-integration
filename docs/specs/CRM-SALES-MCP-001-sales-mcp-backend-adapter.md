# CRM-SALES-MCP-001: Sales MCP Backend Adapter

## Overview

Stage 1 implements a backend MCP-style adapter for the Stage 0 Sales CRM core. The adapter exposes tool definitions and tool execution endpoints over the existing authenticated backend. It does not add a new sales database model, does not duplicate SQL, and does not bypass `/api/crm` service contracts.

## Architecture Compliance Check

- Existing `/api/crm` is the CRM core contract.
- Existing `crm*Service.js` modules remain the business logic source.
- MCP adapter modules call CRM services directly inside the backend process to avoid HTTP self-calls, while preserving the same `companyId`, actor context, write allowlist, RBAC, and audit behavior.
- Route middleware remains `authenticate, requireCompanyAccess`.
- `src/server.js` change is mount-only.
- Stage 1 does not add bulk write tools or delete tools.

## Route Contracts

### `GET /api/crm/mcp/tools`

Returns all enabled tool definitions.

Response:

```json
{
  "ok": true,
  "data": {
    "tools": [
      {
        "name": "crm.search_accounts",
        "description": "Search CRM accounts by text, domain, segment, or owner.",
        "inputSchema": { "type": "object", "properties": {} },
        "kind": "read",
        "requiresConfirmation": false
      }
    ]
  },
  "meta": { "request_id": "..." }
}
```

### `POST /api/crm/mcp/call`

Executes one tool.

Request:

```json
{
  "tool": "crm.get_deal",
  "arguments": { "deal_id": 123 },
  "confirmation": {
    "confirmed": true,
    "confirmation_id": "ui-confirm-123",
    "reason": "Update forecast review action"
  }
}
```

### `POST /api/crm/mcp/jsonrpc`

Executes JSON-RPC-compatible internal MCP methods.

Supported methods:

- `tools/list`
- `tools/call`

`tools/call` accepts `params.name`, `params.arguments`, and optional `params.confirmation`.

Successful response:

```json
{
  "ok": true,
  "tool": "crm.get_deal",
  "content": [{ "type": "json", "json": { "deal": {} } }],
  "structuredContent": { "deal": {} },
  "meta": { "request_id": "..." }
}
```

Error response:

```json
{
  "ok": false,
  "tool": "crm.get_deal",
  "error": {
    "code": "not_found",
    "message": "Deal not found",
    "details": { "crm_code": "NOT_FOUND" }
  },
  "meta": { "request_id": "..." }
}
```

## Tool Definitions

### Read tools

- `crm.search_accounts`
  - Arguments: `q`, `domain`, `icp_segment`, `owner_user_id`, `limit`, `offset`.
  - Service: `crmAccountsService.listAccounts`.

- `crm.get_account`
  - Arguments: `account_id`.
  - Service: `crmAccountsService.getAccountCard`.

- `crm.find_stale_accounts`
  - Arguments: `days`, `owner_user_id`, `limit`, `offset`.
  - Service: `crmAccountsService.getStaleAccounts`.

- `crm.search_contacts`
  - Arguments: `q`, `email`, `company`, `title`, `account_id`, `limit`, `offset`.
  - Service: `crmContactsService.listContacts`.

- `crm.get_contact`
  - Arguments: `contact_id`, optional `deal_id`, `account_id`.
  - Service: `crmContactsService.getContactCard`.

- `crm.get_key_contacts`
  - Arguments: `account_id`.
  - Service: `crmContactsService.getKeyContactsByAccount`.

- `crm.search_deals`
  - Arguments: `q`, `account_id`, `owner_user_id`, `stage`, `forecast_category`, `close_from`, `close_to`, `limit`, `offset`.
  - Service: `crmDealsService.listDeals`.

- `crm.get_deal`
  - Arguments: `deal_id`.
  - Service: `crmDealsService.getDealCard`.

- `crm.get_attention_deals`
  - Arguments: none.
  - Service: `crmDealsService.getAttentionDeals`.

- `crm.get_pipeline`
  - Arguments: `owner_user_id`, `team_id`, `period_start`, `period_end`, `since`.
  - Service: `crmPipelineService.getPipeline`.

- `crm.list_activities`
  - Arguments: `account_id`, `deal_id`, `contact_id`, `type`, `q`, `customer_facing`, `limit`, `offset`.
  - Service: `crmActivitiesService.listActivities`.

- `crm.list_tasks`
  - Arguments: `owner_user_id`, `account_id`, `deal_id`, `contact_id`, `status`, `due_from`, `due_to`, `limit`, `offset`.
  - Service: `crmTasksService.listTasks`.

- `crm.list_notes`
  - Arguments: `entity_type`, `entity_id`, `source`, `limit`, `offset`.
  - Service: `crmNotesService.listNotes`.

- `crm.get_metadata`
  - Arguments: none.
  - Service: `crmMetadataService.getMetadata`.

- `crm.get_sales_list`
  - Arguments: `list_key`, plus optional filters. `my_open_deals` defaults to current user.
  - Service: `crmListsService.getList`.

- `crm.list_my_open_deals`
  - Arguments: optional `owner_user_id`, `limit`.
  - Service: `crmListsService.getList(companyId, 'my_open_deals', filters, context)`.

### Write tools

- `crm.update_deal_field`
  - Arguments: `deal_id`, `field`, `value`.
  - Allowed fields: `next_step`, `stage`, `forecast_category`, `close_date`, `amount`, `risk_summary`, `competitor`.
  - Requires `sales.crm.write`.
  - Requires confirmation.
  - Service: `crmDealsService.updateDeal`.

- `crm.create_task`
  - Arguments: CRM task payload supported by Stage 0.
  - Requires `sales.crm.write`.
  - Requires confirmation.
  - Service: `crmTasksService.createTask`.

- `crm.update_task_status`
  - Arguments: `task_id`, `status`.
  - Requires `sales.crm.write`.
  - Requires confirmation.
  - Service: `crmTasksService.updateTaskStatus`.

- `crm.create_note`
  - Arguments: CRM note payload supported by Stage 0.
  - Requires `sales.crm.write`.
  - Requires confirmation.
  - Service: `crmNotesService.createNote`.

## Behavior

### Tool listing

1. Route derives company context from `req.companyFilter?.company_id`.
2. Registry returns enabled tool definitions.
3. The list includes write metadata, but does not hide write tools from users without write permission; execution still enforces permission.

### Read execution

1. Validate body contains `tool`.
2. Find tool definition.
3. Validate `arguments` against the registered `inputSchema`.
4. Reject write-only confirmation requirements only for write tools.
5. Dispatch to mapped CRM service with company id and arguments.
6. Return MCP-style content blocks and `structuredContent`.

### Write execution

1. Find tool definition.
2. Verify it is `kind = write`.
3. Verify `req.authz.permissions` includes `sales.crm.write`.
4. Verify `confirmation.confirmed === true` and `confirmation.confirmation_id` is non-empty.
5. Add `confirmation_id` and optional `reason` to actor context for CRM audit.
6. Dispatch to CRM service with actor context.
7. Return before/after values where the CRM service returns them.

### Current-user defaults

`crm.get_sales_list` with `list_key = my_open_deals` must use `context.actorId` as default owner. It may accept explicit `owner_user_id` only as a regular filter supported by the existing service contract.

`crm.list_my_open_deals` is the explicit current-user tool alias and maps to the same service contract.

## Error Handling

The adapter must convert internal errors into sanitized MCP errors:

- `BAD_REQUEST`, invalid arguments -> `invalid_request`
- `TENANT_CONTEXT_REQUIRED`, missing write permission -> `access_denied`
- `NOT_FOUND` -> `not_found`
- unsupported tool name -> `unsupported_tool`
- missing write confirmation -> `confirmation_required`
- unexpected exceptions -> `internal_error`

Responses must not include stack traces, SQL text, tokens, OAuth payloads, or raw third-party payloads.

## Out of Scope

- Public unauthenticated MCP endpoint.
- SSE/streaming MCP transport.
- Bulk write tools.
- Delete tools.
- New frontend workspace.
- External integration changes.
