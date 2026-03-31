# Спецификация: PF100 Sprints 3–5 — Оставшиеся задачи

Покрывает S3-T1, S4-T1, S4-T2, S5-T1, S3-T3/S4-T3.

---

## S3-T1: Вкладка Estimates в LeadDetailPanel

### Общее описание
Добавить вкладку "Estimates & Invoices" в правую колонку `LeadDetailPanel` (аналогично уже реализованному `JobFinancialsTab`). При открытии лида пользователь видит связанные сметы и инвойсы и может создавать новые с предзаполненным `lead_id`.

### Сценарии поведения

#### Сценарий 1: Открытие вкладки для лида с документами
- **Предусловия:** Лид выбран, у него есть привязанные estimates/invoices (`lead_id = N`).
- **Входные данные:** `lead.id`
- **Шаги:**
  1. `LeadDetailPanel` рендерит правую колонку с `<Tabs>`. Дефолтная вкладка — "Details & Notes".
  2. Пользователь кликает "Estimates & Invoices".
  3. Монтируется `<LeadFinancialsTab leadId={lead.id} />`.
  4. Хук `useLeadFinancials(leadId)` вызывает `GET /api/estimates?lead_id=N` и `GET /api/invoices?lead_id=N`.
  5. Отображаются summary-карточки: Estimated / Invoiced / Paid.
  6. Списки Estimates и Invoices с компактными строками.
- **Ожидаемый результат:** Документы отображены.
- **Побочные эффекты:** Нет.

#### Сценарий 2: Создание новой сметы из лида
- **Предусловия:** Вкладка "Estimates & Invoices" открыта.
- **Входные данные:** Клик "+ New Estimate".
- **Шаги:**
  1. Открывается `EstimateEditorDialog` с `defaultLeadId={lead.id}`.
  2. Поле Lead ID предзаполнено, Job ID пустое.
  3. Пользователь заполняет форму и нажимает "Create Estimate".
  4. Вызывается `POST /api/estimates` с `lead_id = lead.id`.
  5. Диалог закрывается, список обновляется (`refresh()`).
- **Ожидаемый результат:** Смета создана и отображена в списке.
- **Побочные эффекты:** Запись в `estimates` с `lead_id = N`.

#### Сценарий 3: Смена лида — сброс вкладки
- **Предусловия:** Открыт лид A с вкладкой Estimates.
- **Входные данные:** Пользователь переключается на лид B.
- **Шаги:**
  1. `useEffect([lead.id])` сбрасывает вкладку на "details".
  2. При переходе на Estimates новая загрузка для лида B.
- **Ожидаемый результат:** Данные лида A не отображаются для лида B.

### Граничные случаи
1. Лид без estimates/invoices → пустые секции с кнопками "+ New".
2. Ошибка API → toast.error, секция показывает сообщение об ошибке.
3. `leadId` = null/undefined → хук не делает запросов, возвращает пустые массивы.

### Обработка ошибок
1. `GET /api/estimates?lead_id=N` возвращает 5xx → `toast.error('Failed to load estimates')`.
2. `POST /api/estimates` с невалидными данными (400) → toast с текстом ошибки от backend.

### Взаимодействие компонентов
```
LeadDetailPanel
  → <Tabs> right column
    → <LeadFinancialsTab leadId={lead.id} />
      → useLeadFinancials(leadId)
        → estimatesApi.fetchEstimates({ lead_id: leadId })
          → GET /api/estimates?lead_id=N
        → invoicesApi.fetchInvoices({ lead_id: leadId })
          → GET /api/invoices?lead_id=N
      → <EstimateEditorDialog defaultLeadId={leadId} />
      → <InvoiceEditorDialog defaultLeadId={leadId} />
```

### API-контракты
- `GET /api/estimates?lead_id=N` — Auth: authedFetch, компания изолирована через `req.companyFilter`.
- `GET /api/invoices?lead_id=N` — то же.
- `POST /api/estimates` с `{ lead_id: N, ... }` — создаёт смету с `lead_id`.

### Безопасность и изоляция данных
- Все запросы через `authedFetch` с заголовком компании.
- Backend фильтрует по `company_id` из `req.companyFilter`.

---

## S4-T1: Конвертация Estimate → Invoice

### Общее описание
Принятая смета (status = 'accepted') может быть конвертирована в инвойс одним кликом. Backend копирует line items из estimate в новый invoice с pre-linked `estimate_id`. Frontend показывает кнопку "Create Invoice" в `EstimateDetailPanel`.

### Сценарии поведения

#### Сценарий 1: Конвертация принятой сметы
- **Предусловия:** `estimate.status === 'accepted'`.
- **Входные данные:** Клик "Create Invoice from Estimate" в `EstimateDetailPanel`.
- **Шаги:**
  1. Frontend вызывает `POST /api/estimates/:id/convert`.
  2. Backend (`estimatesService.convertToInvoice(id, companyId)`):
     - Загружает estimate с items.
     - Проверяет `status === 'accepted'`.
     - Создаёт запись в `invoices`: копирует `contact_id`, `job_id`, `lead_id`, `tax_rate`, `discount_amount`, `currency`, устанавливает `estimate_id = id`, `status = 'draft'`.
     - Копирует все items из `estimate_items` в `invoice_items`.
     - Возвращает созданный invoice объект.
  3. Frontend обновляет список инвойсов (`refresh()`).
  4. `EstimateDetailPanel` показывает badge "Invoice Created" или ссылку на инвойс.
  5. Toast: `"Invoice #N created from estimate"`.
- **Ожидаемый результат:** Новый инвойс с теми же items создан и привязан к смете.
- **Побочные эффекты:** Запись в `invoices`, записи в `invoice_items`, `estimate.invoice_id` обновляется (опционально).

#### Сценарий 2: Попытка конвертации не-принятой сметы
- **Предусловия:** `estimate.status !== 'accepted'` (e.g. 'draft', 'sent').
- **Шаги:**
  1. Кнопка "Create Invoice" не отображается (скрыта conditionally).
- **Ожидаемый результат:** Действие недоступно.

#### Сценарий 3: Конвертация уже конвертированной сметы
- **Предусловия:** Смета уже имеет связанный инвойс.
- **Шаги:**
  1. Backend: `POST /api/estimates/:id/convert` возвращает `409 Conflict`.
  2. Frontend: toast.error с текстом "Invoice already exists for this estimate".
- **Ожидаемый результат:** Дубликат не создаётся.

### Граничные случаи
1. Смета не найдена (404) → toast.error.
2. Смета принадлежит другой компании (404 по изоляции) → toast.error.
3. Смета без items → создаётся пустой инвойс (items = []).
4. Одновременные клики — debounce на кнопке (disabled во время запроса).

### Обработка ошибок
1. `POST /api/estimates/:id/convert` → 400: невалидный статус → toast.error с сообщением.
2. 409: уже существует → toast.warning.
3. 500: → toast.error('Failed to create invoice').

### Взаимодействие компонентов
```
EstimateDetailPanel
  → кнопка "Create Invoice" (только при status === 'accepted')
  → estimatesApi.convertEstimateToInvoice(id)
    → POST /api/estimates/:id/convert
      → estimatesService.convertToInvoice(id, companyId)
        → SELECT estimate + items
        → INSERT INTO invoices
        → INSERT INTO invoice_items
        → RETURN invoice
  → onRefresh() — обновить список в родительском компоненте
```

### API-контракты
- `POST /api/estimates/:id/convert`
  - Auth: authedFetch, authenticate + requireCompanyAccess
  - Request: тело пустое (данные берутся из estimate)
  - Response: `{ invoice: InvoiceObject }`
  - Ошибки: `400` (невалидный статус), `404` (не найдена), `409` (уже конвертирована), `500`
  - Изоляция: `WHERE company_id = req.companyFilter.company_id`

### Безопасность и изоляция данных
- Endpoint проверяет принадлежность estimate к компании через `company_id`.
- Новый invoice создаётся с тем же `company_id`.

---

## S4-T2: Ссылка Invoice → Transactions

### Общее описание
`InvoiceDetailPanel` отображает список транзакций (платежей), связанных с инвойсом. Загружается через существующий API `GET /api/transactions?invoice_id=N`. Показывается в панели ниже основных данных инвойса.

### Сценарии поведения

#### Сценарий 1: Просмотр транзакций инвойса
- **Предусловия:** Инвойс открыт, есть транзакции с `invoice_id = N`.
- **Шаги:**
  1. `InvoiceDetailPanel` монтируется с `invoiceId`.
  2. Вызывается `fetchTransactionsForInvoice(invoiceId)` → `GET /api/transactions?invoice_id=N`.
  3. Отображается секция "Payments" со списком транзакций: дата, сумма, метод, статус.
  4. Отображается итог: "Paid: $X.XX of $Y.YY".
- **Ожидаемый результат:** Транзакции видны в панели.

#### Сценарий 2: Инвойс без транзакций
- **Предусловия:** Инвойс без платежей.
- **Шаги:**
  1. API возвращает `[]`.
  2. Секция "Payments" показывает "No payments recorded".
- **Ожидаемый результат:** Пустое состояние без ошибок.

### Граничные случаи
1. Ошибка загрузки транзакций → секция скрыта или показывает error state (не блокирует основные данные инвойса).
2. Сумма транзакций > суммы инвойса → отображается без проверки (edge case данных).

### Обработка ошибок
1. `GET /api/transactions?invoice_id=N` → 5xx → секция показывает "Failed to load payments" без toast.

### Взаимодействие компонентов
```
InvoiceDetailPanel
  → transactionsApi.fetchTransactionsForInvoice(invoiceId)
    → GET /api/transactions?invoice_id=N
  → секция "Payments": список rows
```

### API-контракты
- `GET /api/transactions?invoice_id=N`
  - Auth: authedFetch
  - Response: `{ transactions: TransactionObject[] }`
  - Изоляция: фильтрация по `company_id`

---

## S5-T1: RecordPaymentDialog вместо window.prompt

### Общее описание
В `InvoiceDetailPanel` действие "Record Payment" использует нативный `window.prompt()` — это неприемлемо для production UI. Заменить на уже существующий `RecordPaymentDialog` с пропом `defaultInvoiceId`.

### Сценарии поведения

#### Сценарий 1: Запись платежа через диалог
- **Предусловия:** Инвойс открыт, `status !== 'paid'`.
- **Входные данные:** Клик "Record Payment".
- **Шаги:**
  1. `setShowRecordPayment(true)` — открывает `RecordPaymentDialog`.
  2. `RecordPaymentDialog` предзаполнен: `defaultInvoiceId={invoiceId}`, сумма = остаток долга.
  3. Пользователь выбирает метод, сумму, дату и нажимает "Save".
  4. `RecordPaymentDialog.onSave` вызывает `POST /api/transactions` или `POST /api/invoices/:id/record-payment`.
  5. Диалог закрывается. `InvoiceDetailPanel` обновляет данные (`refresh()`).
  6. Toast: `"Payment of $X recorded"`.
- **Ожидаемый результат:** Транзакция создана, инвойс обновлён.

#### Сценарий 2: Отмена диалога
- **Предусловия:** `RecordPaymentDialog` открыт.
- **Шаги:**
  1. Пользователь нажимает "Cancel".
  2. Диалог закрывается, изменений нет.
- **Ожидаемый результат:** Никаких изменений.

### Граничные случаи
1. Инвойс уже `paid` → кнопка "Record Payment" скрыта или disabled.
2. Отрицательная сумма → `RecordPaymentDialog` валидирует и показывает ошибку.
3. Сумма > остатка → допустимо (переплата), предупреждение в диалоге.

### Обработка ошибок
1. POST ошибка → toast.error внутри `RecordPaymentDialog`.

### Взаимодействие компонентов
```
InvoiceDetailPanel
  → кнопка "Record Payment"
  → <RecordPaymentDialog
       open={showRecordPayment}
       onOpenChange={setShowRecordPayment}
       defaultInvoiceId={invoiceId}
       onSave={...}
     />
```

---

## S3-T3 / S4-T3: Financial Events в Pulse Timeline

### Общее описание
Pulse Timeline (лента событий по контакту) должна включать события создания/отправки/принятия смет и создания/оплаты инвойсов. Backend расширяет `buildTimeline()` JOIN-ом на таблицы `estimates` и `invoices`. Frontend добавляет рендеринг этих типов событий.

### Сценарии поведения

#### Сценарий 1: Смета создана — событие в Pulse
- **Предусловия:** Смета создана с `contact_id = N`.
- **Шаги:**
  1. Backend `GET /api/pulse/timeline?contact_id=N` включает row из `estimates` с `event_type = 'estimate_created'`.
  2. Frontend `PulseTimeline` рендерит `<FinancialEventListItem>` для этого типа.
  3. Отображается: иконка, заголовок "Estimate #E-001 created", сумма, статус, дата.
- **Ожидаемый результат:** Смета видна в хронологической ленте событий.

#### Сценарий 2: Инвойс оплачен — событие в Pulse
- **Предусловия:** Транзакция создана с `invoice_id = N`, инвойс имеет `contact_id`.
- **Шаги:**
  1. Timeline включает row с `event_type = 'invoice_paid'`.
  2. `<FinancialEventListItem>` рендерит: "Invoice #I-001 paid — $X.XX".
- **Ожидаемый результат:** Платёж виден в ленте.

#### Сценарий 3: Фильтрация по company_id
- **Предусловия:** Запрос к timeline.
- **Шаги:**
  1. JOIN на `estimates` и `invoices` включает `WHERE company_id = ?`.
- **Ожидаемый результат:** Данные изолированы по компании.

### Типы событий (event_type)
- `estimate_created` — смета создана
- `estimate_sent` — смета отправлена клиенту
- `estimate_accepted` — смета принята
- `estimate_declined` — смета отклонена
- `invoice_created` — инвойс создан
- `invoice_sent` — инвойс отправлен
- `invoice_paid` — инвойс полностью оплачен
- `invoice_partial_payment` — частичный платёж

### Граничные случаи
1. Смета без `contact_id` → не попадает в timeline (нет связи с контактом).
2. Добавление JOIN не нарушает существующие события (вызовы additive, без изменения существующих типов).
3. Большое количество финансовых событий → не вызывает N+1 проблем (JOIN, не отдельные запросы).

### Обработка ошибок
1. Ошибка в JOIN → весь timeline endpoint возвращает 500 (регрессия). Обязателен smoke-тест существующего поведения.

### Взаимодействие компонентов
```
Frontend:
PulseTimeline
  → useRealtimeEvents / fetchTimeline
    → GET /api/pulse/timeline?contact_id=N
  → рендерит events[]
    → если event.type in FinancialEventTypes → <FinancialEventListItem event={event} />

Backend:
GET /api/pulse/timeline
  → buildTimeline(contact_id, company_id)
    → UNION / JOIN existing events
    → LEFT JOIN estimates WHERE contact_id AND company_id → event_type = 'estimate_*'
    → LEFT JOIN invoices WHERE contact_id AND company_id → event_type = 'invoice_*'
    → ORDER BY occurred_at DESC
```

### API-контракты
- `GET /api/pulse/timeline?contact_id=N` (существующий endpoint, расширяется)
  - Response расширяется новыми `event_type` значениями в массиве `events[]`
  - Новые поля в event: `{ type: 'estimate_created', amount: '1200.00', status: 'accepted', reference: 'E-001', occurred_at: ISO }`
  - Auth: authedFetch, authenticate + requireCompanyAccess
  - Изоляция: все JOIN-ы фильтруют по `company_id`

### Безопасность и изоляция данных
- Каждый новый JOIN содержит `AND e.company_id = :companyId`.
- `occurred_at` берётся из `created_at` / `updated_at` соответствующей таблицы.
- Данные других компаний не утекают через timeline.

### Frontend тип данных
```typescript
// Добавить в frontend/src/types/pulse.ts
interface FinancialEvent {
  id: string;
  type: 'estimate_created' | 'estimate_sent' | 'estimate_accepted' | 'estimate_declined'
       | 'invoice_created' | 'invoice_sent' | 'invoice_paid' | 'invoice_partial_payment';
  amount: string;
  status: string;
  reference: string; // e.g. "E-001", "I-003"
  occurred_at: string;
  contact_id: number;
}
```
