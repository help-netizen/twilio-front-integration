# Спецификация: PF002-R2 — Estimates Composer Refresh

**Дата:** 2026-04-27
**Статус:** Ready for implementation
**Связанные документы:** `docs/requirements.md#PF002-R2`, `docs/architecture.md#PF002-R2`

## Общее описание

PF002-R2 обновляет существующий модуль estimates под быстрый workflow подготовки сметы из Lead/Job. Основной упор: удобное добавление custom items, client-facing Summary/Preview, корректный taxable/discount/tax расчет, lifecycle `draft -> approved/declined`, архивирование вместо удаления и совместимость с будущим Price Book.

## Сценарии поведения

### Сценарий 1: Создание estimate из Lead/Job

- **Предусловия:** пользователь находится во вкладке Financials у Lead или Job.
- **Входные данные:** `lead_id` или `job_id`, optional `summary`, items.
- **Шаги:**
  1. Frontend открывает `EstimateEditorDialog` без создания draft в БД.
  2. Пользователь добавляет item или Summary.
  3. На Save frontend вызывает `POST /api/estimates`.
  4. Backend получает `company_id` из `req.companyFilter?.company_id`, валидирует Lead/Job принадлежность компании, резолвит `contact_id`.
  5. Backend создает estimate, items, пересчитывает totals и пишет `created` event.
- **Ожидаемый результат:** estimate создан и отображается в Lead/Job financial list.
- **Побочные эффекты:** запись в `estimates`, `estimate_items`, `estimate_events`.

### Сценарий 2: Добавление/редактирование item

- **Предусловия:** открыт editor.
- **Входные данные:** `name`, `description`, `quantity`, `unit_price`, `taxable`.
- **Шаги:**
  1. User clicks `Add item`.
  2. Frontend opens item dialog.
  3. Defaults: `quantity=1`, `taxable=false`.
  4. User saves item locally.
  5. Estimate save sends full items array to backend.
- **Ожидаемый результат:** row shows title, full description, `Qty x Unit price`, taxable status, line total, edit/delete icons.
- **Ошибки:** missing title, `quantity <= 0`, `unit_price < 0` block save with inline/toast error.

### Сценарий 3: Summary and Terms

- **Summary:** absent by default; `+ Add Summary` opens input. Non-empty Summary appears as collapsed editor section and above items in Preview/PDF.
- **Terms & Warranty:** always present from Blanc default template, read-only in editor, always shown in Preview/PDF.

### Сценарий 4: Totals

- **Входные данные:** item amounts, `discount_type`, `discount_value`, `tax_rate`.
- **Правила:**
  - fixed discount amount must be `<= subtotal`.
  - percentage discount must be `0..100`.
  - tax applies to `max(taxableItemSubtotal - discountAmount, 0)`.
- **Ожидаемый результат:** frontend and backend show consistent subtotal, discount, tax, total.

### Сценарий 5: Preview

- **Шаги:**
  1. User clicks `Preview`.
  2. Frontend opens `EstimatePreviewDialog`.
  3. Dialog renders client-facing document: Summary, Items, Totals, Terms & Warranty.
- **Ожидаемый результат:** no internal controls, no per-item taxable badge, quantity hidden only in client-facing rows when qty is 1.

### Сценарий 6: Approve/Decline

- **Approve:**
  1. User clicks `Approved`.
  2. Backend rejects if estimate has no items.
  3. Backend saves approved snapshot, sets status `approved`, writes event.
- **Decline:**
  1. User clicks `Decline`.
  2. Frontend requires reason/comment.
  3. Backend sets status `declined`, writes event with reason.

### Сценарий 7: Edit status reset

- **Предусловия:** estimate status is `sent`, `viewed`, `approved`, or `declined`.
- **Шаги:** user edits and saves.
- **Ожидаемый результат:** status becomes `draft`. If status was `approved`, prior approved snapshot remains in history.

### Сценарий 8: Archive/Restore

- **Archive:** sets `archived_at`, `archived_by`, preserves current status, disables editing/actions and public access.
- **Restore:** clears archive fields and sets status `draft`.
- **List:** `Only Open` hides archived; `All` includes archived as grey rows with `Archived` badge.

### Сценарий 9: Send stub

- **Шаги:** user opens send dialog, selects `Email` or `Text`.
- **Ожидаемый результат:** no delivery occurs and status remains `draft`.

## API-контракты

### `GET /api/estimates`

- Query: `status`, `lead_id`, `job_id`, `contact_id`, `search`, `include_archived`, `limit`, `offset`
- Response: `{ ok: true, data: { rows, total } }`
- Auth: mounted with `authenticate, requireCompanyAccess`
- Isolation: list query filters `e.company_id = $1`

### `POST /api/estimates`

- Request:
```json
{
  "lead_id": 42,
  "job_id": null,
  "summary": "Diagnosis...",
  "tax_rate": "6.25",
  "discount_type": "fixed",
  "discount_value": "25",
  "signature_required": false,
  "items": [{ "name": "Labor", "description": "...", "quantity": "1", "unit_price": "280", "taxable": false }]
}
```
- Response: full estimate with items.
- Errors: `400 VALIDATION`, `404 NOT_FOUND`.

### `PUT /api/estimates/:id`

- Replaces editable document fields and items.
- Resets status to `draft` when current status is not `draft`.
- Errors: same as create plus archived estimate cannot be edited.

### `POST /api/estimates/:id/approve`

- Request optional: `{ "actor_type": "user", "actor_id": "..." }`
- Requires at least one item.
- Response: updated estimate.
- Errors: `400 EMPTY_ESTIMATE`.

### `POST /api/estimates/:id/decline`

- Request: `{ "reason": "Customer declined due to price" }`
- Reason required.
- Response: updated estimate.

### `POST /api/estimates/:id/archive`

- Sets archive fields. Does not change status.

### `POST /api/estimates/:id/restore`

- Clears archive fields and sets status `draft`.

### `POST /api/estimates/:id/send`

- Request: `{ "channel": "email" | "sms" }`
- P0 response: estimate unchanged.

## Граничные случаи

1. Estimate without Lead/Job context -> 400.
2. Lead/Job belongs to another company -> 404.
3. Summary-only estimate can be saved but cannot be approved/sent.
4. Discount greater than subtotal -> 400.
5. Archived estimate edit/approve/decline/archive -> 400.
6. Restore archived approved estimate -> status becomes `draft`.
7. Convert to invoice requires `approved`; resulting estimate remains `approved`.

## Безопасность и изоляция

- Route handlers use `req.companyFilter?.company_id || req.user?.company_id`.
- All query-layer access to estimate by id checks `company_id`.
- Item update/delete must validate parent estimate company ownership.
- Public portal access must reject archived estimates.
- P0 send does not call Twilio/email providers.
