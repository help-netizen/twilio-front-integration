# Test Cases: CRM-SALES-MCP-004 Pipeline and Forecast Analytics

## TC-CRM-MCP-PF-001: Forecast totals separate total pipeline and forecast pipeline
- **Priority:** P0
- **Type:** Unit
- **Expected:** total pipeline, weighted pipeline, commit, best case, forecast pipeline, and omitted totals are calculated from open deals.
- **Test file:** `tests/services/crmPipelineService.test.js`

## TC-CRM-MCP-PF-002: Slippage detects all required event types
- **Priority:** P0
- **Type:** Unit
- **Expected:** close-date pushes, amount decreases, and stage regressions are detected from deal history.
- **Test file:** `tests/services/crmPipelineService.test.js`

## TC-CRM-MCP-PF-003: Pipeline history uses same owner/team/period scope
- **Priority:** P0
- **Type:** Unit
- **Expected:** `getDealHistorySince` joins `crm_deals` and applies owner, team, and period filters.
- **Test file:** `tests/db/crmQueries.test.js`

## TC-CRM-MCP-PF-004: Snapshot lookup matches the same forecast dimensions
- **Priority:** P1
- **Type:** Unit
- **Expected:** weekly snapshot lookup matches company, owner, team, period, and timestamp.
- **Test file:** `tests/db/crmQueries.test.js`

## TC-CRM-MCP-PF-005: MCP registry exposes analytics tools as read-only
- **Priority:** P0
- **Type:** Unit
- **Expected:** all pipeline analytics tools are `kind=read`, require no confirmation, and require no write permission.
- **Test file:** `tests/services/crmMcpToolRegistry.test.js`

## TC-CRM-MCP-PF-006: MCP analytics tools dispatch to pipeline service
- **Priority:** P0
- **Type:** Integration
- **Expected:** each analytics tool calls the matching `crmPipelineService` function with current company scope and arguments.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-PF-007: Period tools validate dates before dispatch
- **Priority:** P0
- **Type:** Integration
- **Expected:** invalid period dates are rejected before pipeline service calls.
- **Test file:** `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-PF-008: Since validates as timestamp before dispatch
- **Priority:** P0
- **Type:** Unit/Integration
- **Expected:** date-only or malformed `since` values are rejected before pipeline service calls.
- **Test files:** `tests/services/crmMcpSchemaValidator.test.js`, `tests/routes/crmMcp.test.js`

## TC-CRM-MCP-PF-009: Forecast grouping follows metadata order
- **Priority:** P1
- **Type:** Unit
- **Expected:** forecast groups are ordered by `crm_forecast_categories.display_order`.
- **Test file:** `tests/services/crmPipelineService.test.js`

## TC-CRM-MCP-PF-010: Forecast category metadata is company-scoped
- **Priority:** P1
- **Type:** Unit
- **Expected:** forecast category ordering metadata is queried by `company_id`.
- **Test file:** `tests/db/crmQueries.test.js`
