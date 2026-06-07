# CRM-SALES-MCP-003: Read-only MCP Tools

## Overview

This stage adds explicit read-only Sales MCP tools for common seller workflows. The tools are available through existing MCP transports and call existing CRM services/lists.

## Tools

- `crm.get_last_customer_facing_activity`
- `crm.find_deals_without_next_step`
- `crm.find_overdue_close_date_deals`
- `crm.find_deals_without_activity`
- `crm.find_deals_closing_between`
- `crm.find_deals_closing_this_month`
- `crm.find_deals_closing_this_quarter`
- `crm.find_risky_deals`
- `crm.top_accounts_by_pipeline`
- `crm.accounts_needing_follow_up`
- `crm.contacts_missing_role_title_email`
- `crm.tasks_due_this_week`
- `crm.find_overdue_tasks`
- `crm.get_deal_history`

## Behavior

All tools are read-only. They do not require confirmation or `sales.crm.write`. Runtime schema validation applies before dispatch.

Date-window inputs use `YYYY-MM-DD` calendar dates and invalid dates are rejected before CRM service execution.

`tools/list` supports `kind=read` so MCP clients can discover the read-only surface without write tools. The same filter works on authenticated backend MCP, public HTTP MCP, legacy SSE message handling, and stdio transports.

List-style tools must honor schema-declared bounds. For example, `crm.find_risky_deals.limit` is passed to the underlying open-deal lookup before risk filtering.

## Out of Scope

- Writes.
- Bulk updates.
- Delete operations.
- New SQL layer.
