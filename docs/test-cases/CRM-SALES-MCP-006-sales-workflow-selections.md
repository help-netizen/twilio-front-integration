# Test Cases: CRM-SALES-MCP-006 Sales Workflow Selections

## TC-CRM-MCP-SW-001: Workflow discovery returns stable metadata

- **Input:** call `crm.list_sales_workflows`.
- **Expected:** response includes all workflow keys, matching explicit tool names, and default arguments.

## TC-CRM-MCP-SW-002: Tools list exposes all workflow aliases

- **Input:** call `/api/crm/mcp/tools?kind=read` or JSON-RPC `tools/list` with `kind=read`.
- **Expected:** all explicit workflow tools are present and marked read-only.

## TC-CRM-MCP-SW-003: My open deals defaults to current actor

- **Input:** call `crm.list_my_open_deals` without `owner_user_id`.
- **Expected:** CRM list service uses current MCP actor as owner and limit 100.

## TC-CRM-MCP-SW-003A: My open deals cannot leak all deals or another owner

- **Input:** call `my_open_deals` without current actor, or with `owner_user_id` different from current actor.
- **Expected:** call fails with bad request and does not dispatch an unscoped open-deals query.

## TC-CRM-MCP-SW-004: Closing month and quarter use calendar windows

- **Input:** call `deals_closing_this_month` and `deals_closing_this_quarter`.
- **Expected:** deal service receives current month and quarter date ranges in company timezone, including near UTC-midnight boundary cases.

## TC-CRM-MCP-SW-005: Deal hygiene workflows work with defaults

- **Input:** call `crm.find_deals_without_activity` without arguments and `crm.find_deals_without_next_step`.
- **Expected:** inactivity defaults to 14 days only when omitted; invalid explicit days values are not masked by the default; next-step workflow returns open deals with missing next step.

## TC-CRM-MCP-SW-006: Risky deals workflow filters risks and blockers

- **Input:** open deals include risk summaries, blocker summaries, and clean deals.
- **Expected:** response includes only deals with risk or blocker content.

## TC-CRM-MCP-SW-007: Account workflows dispatch to account services

- **Input:** call `crm.top_accounts_by_pipeline` and `crm.accounts_needing_follow_up`.
- **Expected:** top accounts use pipeline ranking; follow-up uses inactivity window and optional owner/limit filters.

## TC-CRM-MCP-SW-008: Contact cleanup workflow dispatches to contact service

- **Input:** call `crm.contacts_missing_role_title_email`.
- **Expected:** response includes tenant-scoped contacts missing email, title, or deal role.

## TC-CRM-MCP-SW-009: Tasks due this week uses calendar week

- **Input:** call `crm.tasks_due_this_week`.
- **Expected:** task service receives open status plus Monday-Sunday due window in company timezone.

## TC-CRM-MCP-SW-010: Unsupported workflow key is rejected

- **Input:** call `crm.get_sales_list` with an unknown key.
- **Expected:** call fails with `invalid_request` and allowed workflow keys in sanitized details.
