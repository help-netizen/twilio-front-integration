# CRM-SALES-MCP-006: Sales Workflow Selections

## Scope

Stage 5 exposes ready-made Sales workflow selections as read-only MCP tools and stable list keys. These selections are intended for seller workflows where the client should not compose filters manually.

## Tools

Discovery:

- `crm.list_sales_workflows`

Generic list endpoint:

- `crm.get_sales_list`

Explicit workflow tools:

- `crm.list_my_open_deals`
- `crm.find_deals_closing_this_month`
- `crm.find_deals_closing_this_quarter`
- `crm.find_deals_without_activity`
- `crm.find_deals_without_next_step`
- `crm.find_risky_deals`
- `crm.top_accounts_by_pipeline`
- `crm.accounts_needing_follow_up`
- `crm.contacts_missing_role_title_email`
- `crm.tasks_due_this_week`

All Stage 5 tools are read-only. They require tenant context and do not require confirmation or `sales.crm.write`.

## Workflow Keys

`crm.get_sales_list` supports:

- `my_open_deals`
- `deals_closing_this_month`
- `deals_closing_this_quarter`
- `deals_without_activity`
- `deals_without_next_step`
- `risky_deals`
- `top_accounts_by_pipeline`
- `accounts_needing_follow_up`
- `contacts_missing_role_title_email`
- `tasks_due_this_week`

Unsupported keys fail with a sanitized bad request response that includes allowed values.

## Defaults

- `my_open_deals`: owner is the current actor; limit defaults to 100. Calls without a current actor, or calls trying to scope to another owner, are rejected.
- `deals_without_activity`: days defaults to 14.
- `accounts_needing_follow_up`: days defaults to 14.
- `top_accounts_by_pipeline`: limit defaults to 10.
- `tasks_due_this_week`: current company-timezone calendar week, Monday through Sunday.
- Closing-month and closing-quarter windows are computed from the company timezone, not UTC/server-local date.
- Invalid explicit `days` values such as `0` are not replaced by defaults; defaults apply only when `days` is omitted.

## Data Sources

- Deals workflows use `crm_deals`, `crm_pipeline_stages`, and `crm_activities`.
- Account workflows use `crm_accounts`, `crm_deals`, and `crm_activities`.
- Contact cleanup workflow uses `contacts` and `crm_deal_contacts`.
- Task workflow uses `tasks` through CRM task links.

Every query remains tenant-scoped by `company_id`.
