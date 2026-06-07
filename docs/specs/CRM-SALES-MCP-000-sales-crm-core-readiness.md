# CRM-SALES-MCP-000: Sales CRM Core Readiness for MCP

## Общее описание

Stage 0 prepares the existing Blanc Contact Center CRM for a future Sales MCP. It adds a normalized sales CRM core and internal CRM API/service contracts for accounts, contacts, deals, activities, tasks, notes, metadata, pipeline, forecast, and audited writes. MCP tools are out of scope for this stage.

## Current Architecture Fit

- Existing Contacts, Leads, Jobs, Pulse, tasks, and structured notes remain operational CRM/service-dispatch modules.
- Sales Deals are new first-class records and must not be mapped onto `jobs`.
- Accounts are new first-class records and can link to existing contacts.
- Activities are a normalized read model over calls, SMS/email, meetings, notes, tasks, and stage changes.
- New APIs use the existing Express route/service/db layering and are mounted with `authenticate, requireCompanyAccess`.
- `company_id` is read from `req.companyFilter?.company_id`; direct entity access must include `AND company_id = $N`.

## Сценарии поведения

### Сценарий 1: Search accounts

- **Предусловия:** user is authenticated and has company access.
- **Входные данные:** `q`, optional `domain`, `icp_segment`, `owner_user_id`, `limit`, `offset`.
- **Шаги:**
  1. Frontend or future MCP client calls the internal CRM accounts search API.
  2. Route derives `companyId` from `req.companyFilter?.company_id`.
  3. Service validates pagination and filter values.
  4. Query filters by `company_id` and user-supplied criteria.
- **Ожидаемый результат:** only accounts for the current company are returned.
- **Побочные эффекты:** none.

### Сценарий 2: Fetch account card

- **Предусловия:** account exists in current company.
- **Входные данные:** `accountId`.
- **Шаги:**
  1. Client requests account detail.
  2. Service loads account by `id + company_id`.
  3. Service loads linked contacts, open deals, recent activities, and open tasks.
  4. Service computes last customer-facing contact if missing or stale in cached field.
- **Ожидаемый результат:** account card includes status, owner, segment, health, last contact, contacts, deals, activities, tasks.
- **Побочные эффекты:** none.

### Сценарий 3: Fetch contact card for sales context

- **Предусловия:** contact exists in current company.
- **Входные данные:** `contactId`, optional `accountId` or `dealId`.
- **Шаги:**
  1. Client requests contact detail.
  2. Contact query validates `company_id`.
  3. Service returns contact fields, title, account links, deal roles, and communication history.
- **Ожидаемый результат:** contact card exposes role in deal context and omits unrelated company data.
- **Побочные эффекты:** none.

### Сценарий 4: Fetch deal card

- **Предусловия:** deal exists in current company.
- **Входные данные:** `dealId`.
- **Шаги:**
  1. Client requests deal detail.
  2. Service loads deal by `id + company_id`.
  3. Service loads account, owner, linked contacts and roles, activities, tasks, notes, and deal history.
- **Ожидаемый результат:** deal card exposes amount, currency, stage, probability, close date, next step, forecast category, risks, blockers, competitors, procurement status, and history.
- **Побочные эффекты:** none.

### Сценарий 5: Pipeline and forecast report

- **Предусловия:** user has access to current company.
- **Входные данные:** `owner_user_id`, `team_id`, `period_start`, `period_end`.
- **Шаги:**
  1. Client requests pipeline summary.
  2. Service validates period and owner/team filters.
  3. Query returns open deals in period, grouped by stage and forecast category.
  4. Service computes total pipeline, weighted pipeline, commit, best case, pipeline, risks, prior-week deltas, and slippage from deal history.
- **Ожидаемый результат:** summary is deterministic and company-scoped.
- **Побочные эффекты:** none.

### Сценарий 6: List stale records and ready-made Sales workflow lists

- **Предусловия:** CRM activity model exists.
- **Входные данные:** list key and optional date window.
- **Шаги:**
  1. Client requests a predefined list such as `deals_without_next_step`.
  2. Service maps the list key to an approved query.
  3. Query uses indexed fields and `company_id` filter.
- **Ожидаемый результат:** predefined list returns only supported data shapes.
- **Побочные эффекты:** none.

### Сценарий 7: Create task linked to sales entity

- **Предусловия:** target account/deal/contact exists in current company.
- **Входные данные:** `title`, `description`, `due_at`, `owner_user_id`, one of `account_id`, `deal_id`, `contact_id`.
- **Шаги:**
  1. Service validates target entity ownership by company.
  2. Service creates task with company id and target link.
  3. Existing Pulse timeline task behavior is preserved for `thread_id` tasks.
- **Ожидаемый результат:** task is created and can be listed by owner or linked entity.
- **Побочные эффекты:** task row created.

### Сценарий 8: Create note linked to sales entity

- **Предусловия:** target account/deal/contact exists in current company.
- **Входные данные:** `text`, `source`, entity link.
- **Шаги:**
  1. Service validates note source enum.
  2. Service validates target entity ownership by company.
  3. Service creates normalized note and activity row if note is customer-facing or should appear in activity history.
- **Ожидаемый результат:** note is visible through entity notes and activity history when applicable.
- **Побочные эффекты:** note row created; optional activity row created.

### Сценарий 9: Future allowed write service

- **Предусловия:** target deal/task exists in current company; caller supplies request id and source.
- **Входные данные:** one allowed field update.
- **Шаги:**
  1. Service rejects fields outside the allowlist.
  2. Service reads current value by `id + company_id`.
  3. Service applies update in a transaction.
  4. Service writes audit with actor, entity, old/new value, request id, source.
  5. Service returns before/after values.
- **Ожидаемый результат:** update is applied only for allowed fields.
- **Побочные эффекты:** deal/task update, history/audit event.

## Граничные случаи

1. `N days` is missing or less than 1 for stale queries -> default is rejected with `400` unless the endpoint declares a default.
2. Unknown predefined list key -> `400`.
3. Cross-company account/deal/contact/task id -> `404`.
4. Contact belongs to company but requested deal role belongs to a different company -> role is omitted and query remains scoped.
5. Deal close date is null -> excluded from overdue close-date list and included only where explicitly requested.
6. Deal amount is null -> counted as zero for totals, but response preserves null amount.
7. Currency differs across deals -> summary groups by currency or rejects mixed-currency aggregation unless grouped.
8. Activity body contains raw provider payload -> API returns sanitized summary/body fields only.
9. Existing Pulse task with `thread_id` still enforces one open task per thread.
10. Normalized sales task without `thread_id` is not constrained by the Pulse open-task unique index.

## Обработка ошибок

- `401`: unauthenticated request.
- `403`: authenticated user lacks company access or required CRM permission.
- `404`: direct entity id is not found in current company.
- `400`: invalid filters, invalid enum value, unsupported list key, invalid write field.
- `409`: write violates stage transition rule or stale revision condition if optimistic locking is added.
- `500`: unexpected service failure; response must not include secrets or raw SQL details.

## API-контракты Stage 0

Planned internal API surface, not MCP tools:

- `GET /api/crm/accounts`
- `GET /api/crm/accounts/:id`
- `GET /api/crm/accounts/stale?days=N`
- `GET /api/crm/contacts`
- `GET /api/crm/contacts/:id`
- `GET /api/crm/accounts/:id/key-contacts`
- `GET /api/crm/deals`
- `GET /api/crm/deals/:id`
- `GET /api/crm/deals/attention`
- `GET /api/crm/pipeline`
- `GET /api/crm/activities`
- `GET /api/crm/tasks`
- `POST /api/crm/tasks`
- `PATCH /api/crm/tasks/:id`
- `GET /api/crm/notes`
- `POST /api/crm/notes`
- `GET /api/crm/metadata`
- `GET /api/crm/lists/:listKey`
- `PATCH /api/crm/deals/:id`

All routes:

- **Middleware:** `authenticate, requireCompanyAccess`; write routes require a CRM write permission once permission naming is finalized.
- **Company source:** `req.companyFilter?.company_id`.
- **Isolation:** every query filters by `company_id`; direct foreign IDs return `404`.
- **Response shape:** `{ ok, data, meta: { request_id, timestamp } }` following existing route style where practical.

## Security and Isolation

- No Sales CRM route may read from `req.companyId`.
- Query/service functions must require `companyId`; no fallback to unscoped reads.
- Responses must not include tokens, integration credentials, raw OAuth payloads, or internal passwords.
- Existing Twilio/Front/Zenbooker routes remain unchanged.
- Audit records must be company-scoped and queryable by company.

## Out of Scope

- MCP tool implementation.
- Frontend sales workspace.
- Bulk deal update tools.
- Delete account/contact/deal operations.
- New external integration behavior.
- Replacing Leads/Jobs with sales entities.
