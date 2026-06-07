# CRM-SALES-MCP-004: Pipeline and Forecast Analytics

## Overview

This stage adds explicit read-only MCP tools for pipeline and forecast review. Tools use the existing CRM pipeline service and do not introduce write behavior.

## Data Sources

- Current pipeline: `crm_deals`.
- Change history and slippage: `crm_deal_history`.
- Optional baseline comparison: `crm_pipeline_weekly_snapshots`.

Weekly snapshots are supplementary. Current totals are always computed from live CRM deal rows.

## Tools

- `crm.get_pipeline_by_owner`
- `crm.get_pipeline_by_team`
- `crm.get_pipeline_by_period`
- `crm.group_pipeline_by_stage`
- `crm.group_pipeline_by_forecast_category`
- `crm.get_forecast_totals`
- `crm.get_pipeline_changes`
- `crm.get_pipeline_risky_deals`
- `crm.get_pipeline_slippage`

## Behavior

All tools are read-only and support the existing MCP transports. Owner, team, period, and since filters are validated through the MCP registry schema before service dispatch. `period_start` and `period_end` use `YYYY-MM-DD`; `since` uses an ISO 8601 timestamp with timezone.

Forecast totals include:

- `pipeline`: total open pipeline amount.
- `weighted_pipeline`: amount weighted by deal probability.
- `commit`
- `best_case`
- `forecast_pipeline`: deals whose forecast category is `pipeline`.
- `omitted`

Slippage is derived from deal history:

- close date pushed when `new_value > old_value`.
- amount decreased when `new_value < old_value`.
- stage regressed when the new stage order is lower than the old stage order.

Stage grouping follows CRM pipeline stage display order. Forecast category grouping follows CRM forecast category display order.

Weekly snapshot uniqueness is null-safe across owner/team/period dimensions so general-scope snapshots cannot duplicate when nullable dimensions are omitted.

## Out of Scope

- Pipeline write tools.
- Bulk updates.
- Delete operations.
- A snapshot scheduler.
