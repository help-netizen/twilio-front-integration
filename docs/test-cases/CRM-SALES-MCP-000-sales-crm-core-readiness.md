# Test Cases: CRM-SALES-MCP-000 Sales CRM Core Readiness

## Coverage

- Всего тест-кейсов: 30
- P0: 12 | P1: 12 | P2: 6 | P3: 0
- Unit: 12 | Integration: 18 | E2E: 0

## TC-CRM-SALES-000-001: Accounts search is company-scoped
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Search accounts
- **Предусловия:** company A and company B each have accounts with similar names/domains.
- **Входные данные:** authenticated company A request to `GET /api/crm/accounts?q=acme`.
- **Ожидаемый результат:** response contains only company A accounts; no company B ids.
- **Файл для теста:** `tests/routes/crm-accounts.test.js`

## TC-CRM-SALES-000-002: Account direct foreign id returns 404
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Fetch account card
- **Входные данные:** company A requests company B `accountId`.
- **Ожидаемый результат:** `404`, no account data.
- **Файл для теста:** `tests/routes/crm-accounts.test.js`

## TC-CRM-SALES-000-003: Account card includes linked entities
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Fetch account card
- **Входные данные:** account with contacts, deals, activities, tasks.
- **Ожидаемый результат:** account card contains status, owner, segment, health, last contact, linked contacts, deals, activities, tasks.
- **Файл для теста:** `tests/routes/crm-accounts.test.js`

## TC-CRM-SALES-000-004: Stale account query validates days
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Ready-made Sales workflow lists
- **Входные данные:** `GET /api/crm/accounts/stale?days=0`.
- **Ожидаемый результат:** `400`.
- **Файл для теста:** `tests/routes/crm-accounts.test.js`

## TC-CRM-SALES-000-005: Existing contacts list requires companyId
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Contact readiness
- **Входные данные:** call CRM contact query/service without `companyId`.
- **Ожидаемый результат:** service rejects unscoped call or test proves no unscoped SQL path exists.
- **Файл для теста:** `tests/services/crmContactScope.test.js`

## TC-CRM-SALES-000-006: Contact search by title and account is scoped
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Fetch contact card for sales context
- **Входные данные:** `GET /api/crm/contacts?title=VP&account_id=...`.
- **Ожидаемый результат:** only matching current-company contacts are returned.
- **Файл для теста:** `tests/routes/crm-contacts.test.js`

## TC-CRM-SALES-000-007: Contact deal role is deal-specific
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Fetch contact card for sales context
- **Входные данные:** same contact linked to two deals with different roles.
- **Ожидаемый результат:** each deal context returns its own role.
- **Файл для теста:** `tests/services/crmContactsService.test.js`

## TC-CRM-SALES-000-008: Deals are separate from jobs
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Fetch deal card
- **Входные данные:** deal fixture and job fixture with same company.
- **Ожидаемый результат:** deal service reads `crm_deals`, not `jobs`; job fields are not required to build a deal.
- **Файл для теста:** `tests/services/crmDealsService.test.js`

## TC-CRM-SALES-000-009: Deal search filters stage and forecast category
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Fetch deal card
- **Входные данные:** `GET /api/crm/deals?stage=Proposal&forecast_category=Commit`.
- **Ожидаемый результат:** only current-company matching deals returned.
- **Файл для теста:** `tests/routes/crm-deals.test.js`

## TC-CRM-SALES-000-010: Deal direct foreign id returns 404
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Fetch deal card
- **Входные данные:** company A requests company B deal id.
- **Ожидаемый результат:** `404`.
- **Файл для теста:** `tests/routes/crm-deals.test.js`

## TC-CRM-SALES-000-011: Deal card includes history and linked records
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Fetch deal card
- **Входные данные:** deal with account, contacts, activities, tasks, notes, history.
- **Ожидаемый результат:** response includes all linked record groups without cross-company leakage.
- **Файл для теста:** `tests/routes/crm-deals.test.js`

## TC-CRM-SALES-000-012: Deals without next step list
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Ready-made Sales workflow lists
- **Входные данные:** open deals with null/blank next step and closed deals.
- **Ожидаемый результат:** only open current-company deals without next step are returned.
- **Файл для теста:** `tests/routes/crm-lists.test.js`

## TC-CRM-SALES-000-013: Overdue close date list excludes null close date
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** Ready-made Sales workflow lists
- **Входные данные:** overdue, future, and null close-date deals.
- **Ожидаемый результат:** only overdue current-company open deals included.
- **Файл для теста:** `tests/services/crmListsService.test.js`

## TC-CRM-SALES-000-014: Pipeline totals calculate weighted amount
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Pipeline and forecast report
- **Входные данные:** deals with amount and probability.
- **Ожидаемый результат:** weighted pipeline equals sum of `amount * probability / 100`.
- **Файл для теста:** `tests/services/crmPipelineService.test.js`

## TC-CRM-SALES-000-015: Pipeline mixed currency behavior
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Pipeline and forecast report
- **Входные данные:** USD and CAD deals in same query.
- **Ожидаемый результат:** response groups by currency or rejects mixed aggregation according to implemented contract.
- **Файл для теста:** `tests/services/crmPipelineService.test.js`

## TC-CRM-SALES-000-016: Prior-week pipeline delta uses history/snapshot
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Pipeline and forecast report
- **Входные данные:** current deals and prior-week history/snapshot.
- **Ожидаемый результат:** delta fields match prior-week comparison.
- **Файл для теста:** `tests/services/crmPipelineService.test.js`

## TC-CRM-SALES-000-017: Slippage detects close-date push
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Pipeline and forecast report
- **Входные данные:** deal history where close date moved later.
- **Ожидаемый результат:** slippage includes `close_date_pushed`.
- **Файл для теста:** `tests/services/crmPipelineService.test.js`

## TC-CRM-SALES-000-018: Slippage detects amount decrease and stage regression
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Pipeline and forecast report
- **Входные данные:** deal history with lower amount and lower stage order.
- **Ожидаемый результат:** slippage includes `amount_decreased` and `stage_regressed`; forward stage movement is not marked as regression.
- **Файл для теста:** `tests/services/crmPipelineService.test.js`

## TC-CRM-SALES-000-019: Activities filter by entity and type
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Fetch deal card / account card
- **Входные данные:** activities linked to account, deal, contact with types `email`, `call`, `note`.
- **Ожидаемый результат:** `GET /api/crm/activities?deal_id=...&type=call` returns only matching current-company rows.
- **Файл для теста:** `tests/routes/crm-activities.test.js`

## TC-CRM-SALES-000-020: Last customer-facing activity
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Fetch account card
- **Входные данные:** internal and customer-facing activities.
- **Ожидаемый результат:** last customer-facing activity ignores internal-only activity.
- **Файл для теста:** `tests/services/crmActivitiesService.test.js`

## TC-CRM-SALES-000-021: Activity response sanitizes raw provider payloads
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Activities
- **Входные данные:** source activity with raw provider payload and secret-like fields.
- **Ожидаемый результат:** response contains sanitized summary/body only.
- **Файл для теста:** `tests/routes/crm-activities.test.js`

## TC-CRM-SALES-000-022: Sales task can link to deal without thread
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Create task linked to sales entity
- **Входные данные:** `POST /api/crm/tasks` with `deal_id` and no `thread_id`.
- **Ожидаемый результат:** task created; Pulse thread unique-open constraint does not apply.
- **Файл для теста:** `tests/routes/crm-tasks.test.js`

## TC-CRM-SALES-000-023: Pulse thread task behavior remains intact
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Create task linked to sales entity
- **Входные данные:** two open tasks for same Pulse `thread_id`.
- **Ожидаемый результат:** existing one-open-task-per-thread behavior is preserved.
- **Файл для теста:** `tests/routes/pulse-tasks-regression.test.js`

## TC-CRM-SALES-000-024: Task status update allowlist
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Future allowed write service
- **Входные данные:** `PATCH /api/crm/tasks/:id` with `status`.
- **Ожидаемый результат:** status updates; before/after returned; audit written.
- **Файл для теста:** `tests/routes/crm-tasks.test.js`

## TC-CRM-SALES-000-025: Normalized note source validation
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Create note linked to sales entity
- **Входные данные:** invalid note source.
- **Ожидаемый результат:** `400`.
- **Файл для теста:** `tests/routes/crm-notes.test.js`

## TC-CRM-SALES-000-026: Deal allowed write returns before/after
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Future allowed write service
- **Входные данные:** `PATCH /api/crm/deals/:id` with `next_step`.
- **Ожидаемый результат:** response includes old and new `next_step`; deal history and audit records created.
- **Файл для теста:** `tests/routes/crm-deal-writes.test.js`

## TC-CRM-SALES-000-027: Deal write rejects disallowed field
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Future allowed write service
- **Входные данные:** `PATCH /api/crm/deals/:id` with `owner_user_id`.
- **Ожидаемый результат:** `400`, no update, no misleading audit success.
- **Файл для теста:** `tests/routes/crm-deal-writes.test.js`

## TC-CRM-SALES-000-028: Write audit includes required MCP fields
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Future allowed write service
- **Входные данные:** allowed deal write with route request id and attempted body source spoof.
- **Ожидаемый результат:** audit contains actor, company, entity, field, old/new value, timestamp, request id, and server-controlled source `Codex/Sales MCP`.
- **Файл для теста:** `tests/services/crmWriteAuditService.test.js`

## TC-CRM-SALES-000-028A: CRM write route requires permission
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Future allowed write service
- **Входные данные:** `PATCH /api/crm/deals/:id` without `sales.crm.write`.
- **Ожидаемый результат:** `403 ACCESS_DENIED`; service update is not called.
- **Файл для теста:** `tests/routes/crm.test.js`

## TC-CRM-SALES-000-029: Metadata endpoint returns stage and forecast config
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** Metadata
- **Входные данные:** `GET /api/crm/metadata`.
- **Ожидаемый результат:** pipeline stages, forecast categories, owners, activity types, task statuses, transition rules are returned for current company.
- **Файл для теста:** `tests/routes/crm-metadata.test.js`

## TC-CRM-SALES-000-030: Route middleware rejects unauthenticated and no-company requests
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** All API scenarios
- **Входные данные:** unauthenticated request and authenticated request without company access.
- **Ожидаемый результат:** `401` and `403` respectively.
- **Файл для теста:** `tests/routes/crm-security.test.js`
