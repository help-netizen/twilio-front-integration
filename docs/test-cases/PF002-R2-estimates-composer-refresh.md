# Тест-кейсы: PF002-R2 — Estimates Composer Refresh

## Покрытие

- Всего тест-кейсов: 20
- P0: 8 | P1: 8 | P2: 4
- Unit: 10 | Integration: 7 | Frontend/component: 3

---

### TC-PF002R2-001: Create estimate from job resolves context
- **Приоритет:** P0
- **Тип:** Unit/Service
- **Сценарий:** Создание estimate из Job
- **Вход:** `companyId=A`, `job_id=10`, one item
- **Ожидаемый результат:** service loads job by `id + company_id`, fills `contact_id/lead_id`, creates `ESTIMATE L-{leadNumber}-1`, inserts items, recalculates totals.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-002: Create estimate from lead resolves contact
- **Приоритет:** P0
- **Тип:** Unit/Service
- **Вход:** `companyId=A`, `lead_id=42`, one item
- **Ожидаемый результат:** service creates lead-only number `ESTIMATE L-{serial_id}-1`; no standalone estimate without lead/job.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-003: Item insert matches schema
- **Приоритет:** P0
- **Тип:** Unit/Query
- **Ожидаемый результат:** `addEstimateItem` writes `name`, `description`, `quantity`, `unit_price`, `amount`, `taxable`, `metadata`; it does not write missing `tax_rate`.
- **Файл:** `tests/estimatesR2Queries.test.js`

### TC-PF002R2-004: Totals taxable discount calculation
- **Приоритет:** P0
- **Тип:** Unit
- **Вход:** taxable subtotal 200, non-taxable 100, discount 50, tax 10%
- **Ожидаемый результат:** subtotal 300, discount 50, tax 15, total 265.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-005: Discount cannot exceed subtotal
- **Приоритет:** P1
- **Тип:** Unit
- **Ожидаемый результат:** create/update returns validation error.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-006: Approve requires items
- **Приоритет:** P0
- **Тип:** Unit
- **Ожидаемый результат:** Summary-only estimate approve fails with `В эстимейте нет items`.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-007: Approve saves snapshot
- **Приоритет:** P0
- **Тип:** Unit
- **Ожидаемый результат:** approved estimate stores status `approved`, writes `approved` event and approved snapshot/revision.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-008: Edit approved resets to draft
- **Приоритет:** P0
- **Тип:** Unit
- **Ожидаемый результат:** update on approved estimate returns status `draft`; existing approved snapshot remains.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-009: Decline requires reason
- **Приоритет:** P1
- **Тип:** Unit/API
- **Ожидаемый результат:** empty reason -> 400; non-empty reason -> status `declined`, event metadata includes reason.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-010: Archive preserves status
- **Приоритет:** P1
- **Тип:** Unit
- **Ожидаемый результат:** archived approved estimate keeps `status=approved`, sets `archived_at/archived_by`.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-011: Restore sets draft
- **Приоритет:** P1
- **Тип:** Unit
- **Ожидаемый результат:** restore clears archive fields and returns `status=draft`.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-012: List Only Open excludes archived
- **Приоритет:** P1
- **Тип:** Unit/Query
- **Ожидаемый результат:** default list includes `archived_at IS NULL`; `include_archived=true` includes archived.
- **Файл:** `tests/estimatesR2Queries.test.js`

### TC-PF002R2-013: Route uses companyFilter
- **Приоритет:** P0
- **Тип:** Integration/API
- **Ожидаемый результат:** route passes `req.companyFilter.company_id` to service and never relies on undefined `req.companyId`.
- **Файл:** `tests/routes/estimatesR2.test.js`

### TC-PF002R2-014: Tenant isolation by id
- **Приоритет:** P0
- **Тип:** Integration/API
- **Ожидаемый результат:** company A cannot read/update/archive estimate owned by company B; returns 404.
- **Файл:** `tests/routes/estimatesR2.test.js`

### TC-PF002R2-015: Send stub does not mutate status
- **Приоритет:** P1
- **Тип:** Unit/API
- **Ожидаемый результат:** POST send with channel returns estimate with same `draft` status and does not call external providers.
- **Файл:** `tests/estimatesR2Service.test.js`

### TC-PF002R2-016: Convert requires approved
- **Приоритет:** P1
- **Тип:** Unit
- **Ожидаемый результат:** `draft/declined` convert fails; `approved` creates invoice and keeps estimate approved.
- **Файл:** `tests/estimatesConvert.test.js`

### TC-PF002R2-017: Editor item defaults
- **Приоритет:** P1
- **Тип:** Frontend/component
- **Ожидаемый результат:** Add item dialog defaults `Qty=1`, `Service is taxable=false`; title required.
- **Файл:** future frontend test

### TC-PF002R2-018: Estimates page removes global create
- **Приоритет:** P2
- **Тип:** Frontend/component
- **Ожидаемый результат:** `/estimates` has no `New Estimate` control; still supports search/list/detail.
- **Файл:** future frontend test

### TC-PF002R2-019: Preview client-facing content
- **Приоритет:** P2
- **Тип:** Frontend/component
- **Ожидаемый результат:** Preview shows Summary, items, totals, Terms & Warranty; no taxable badges on item rows.
- **Файл:** future frontend test

### TC-PF002R2-020: Archived UI is read-only
- **Приоритет:** P2
- **Тип:** Frontend/component
- **Ожидаемый результат:** archived estimate row is grey with `Archived` badge; detail actions disabled except restore.
- **Файл:** future frontend test
