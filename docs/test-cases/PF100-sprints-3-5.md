# Тест-кейсы: PF100 Sprints 3–5

Покрывает: S3-T1 (LeadFinancialsTab), S4-T1 (Estimate→Invoice convert), S4-T2 (Invoice→Transactions), S5-T1 (RecordPaymentDialog), S3-T3/S4-T3 (Pulse financial events).

### Покрытие
- Всего тест-кейсов: 28
- P0: 9 | P1: 10 | P2: 6 | P3: 3
- Unit: 12 | Integration: 14 | E2E: 2

---

## S3-T1: LeadFinancialsTab

### TC-S3T1-001: Загрузка смет и инвойсов для лида
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S3-T1 Сценарий 1
- **Предусловия:** Лид N существует, у него 2 estimate с `lead_id=N` и 1 invoice с `lead_id=N`.
- **Входные данные:**
  - `leadId`: 42
- **Моки:** `GET /api/estimates?lead_id=42` → `[{id:1,...}, {id:2,...}]`; `GET /api/invoices?lead_id=42` → `[{id:10,...}]`
- **Шаги:**
  1. Монтировать `<LeadFinancialsTab leadId={42} />`.
  2. Дождаться завершения fetch.
  3. Проверить наличие 2 строк estimates и 1 строки invoices.
- **Ожидаемый результат:** Компонент отображает 2 estimate-строки и 1 invoice-строку.
- **Файл для теста:** `frontend/src/components/leads/__tests__/LeadFinancialsTab.test.tsx`

### TC-S3T1-002: Пустое состояние — лид без документов
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S3-T1 Граничный случай 1
- **Предусловия:** Лид без смет и инвойсов.
- **Входные данные:** `leadId`: 99
- **Моки:** Оба API → `[]`
- **Шаги:**
  1. Монтировать `<LeadFinancialsTab leadId={99} />`.
  2. Дождаться fetch.
- **Ожидаемый результат:** Отображаются секции "No estimates" и "No invoices" с кнопками "+ New".
- **Файл для теста:** `frontend/src/components/leads/__tests__/LeadFinancialsTab.test.tsx`

### TC-S3T1-003: Создание сметы из лида — предзаполнение lead_id
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S3-T1 Сценарий 2
- **Предусловия:** LeadFinancialsTab открыт.
- **Входные данные:** Клик "+ New Estimate", `leadId=42`.
- **Моки:** `POST /api/estimates` → `{id: 5, lead_id: 42, ...}`
- **Шаги:**
  1. Кликнуть "+ New Estimate".
  2. Убедиться, что `EstimateEditorDialog` открыт с `defaultLeadId=42`.
  3. Поле Lead ID в форме = "42".
  4. Отправить форму.
  5. Проверить вызов `POST /api/estimates` с `lead_id=42`.
- **Ожидаемый результат:** Смета создана с `lead_id=42`, список обновлён.
- **Файл для теста:** `frontend/src/components/leads/__tests__/LeadFinancialsTab.test.tsx`

### TC-S3T1-004: Смена лида — сброс данных
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S3-T1 Сценарий 3
- **Предусловия:** `useLeadFinancials(42)` загружены.
- **Шаги:**
  1. Переключить на `useLeadFinancials(55)`.
  2. Проверить, что `estimates` и `invoices` сброшены и новый fetch выполнен для `leadId=55`.
- **Ожидаемый результат:** Данные лида 42 не смешиваются с данными лида 55.
- **Файл для теста:** `frontend/src/hooks/__tests__/useLeadFinancials.test.ts`

### TC-S3T1-005: Ошибка загрузки — toast
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** S3-T1 Обработка ошибок
- **Моки:** `GET /api/estimates?lead_id=42` → 500
- **Шаги:**
  1. Монтировать `<LeadFinancialsTab leadId={42} />`.
- **Ожидаемый результат:** `toast.error('Failed to load estimates')` вызван.
- **Файл для теста:** `frontend/src/components/leads/__tests__/LeadFinancialsTab.test.tsx`

---

## S4-T1: Estimate → Invoice Conversion

### TC-S4T1-001: Успешная конвертация принятой сметы
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S4-T1 Сценарий 1
- **Предусловия:** `estimate.id=7`, `status='accepted'`, 2 items.
- **Входные данные:** `POST /api/estimates/7/convert`
- **Моки:** DB: estimate существует, принадлежит company_id=1. INSERT invoice возвращает `{id:20}`.
- **Шаги:**
  1. Вызвать `POST /api/estimates/7/convert` с корректным auth.
  2. Проверить, что создан invoice с `estimate_id=7`.
  3. Проверить, что invoice_items скопированы (2 items).
  4. Ответ: `{ invoice: { id: 20, estimate_id: 7, status: 'draft', ... } }`.
- **Ожидаемый результат:** HTTP 201, invoice создан с правильными данными.
- **Файл для теста:** `tests/routes/estimates.convert.test.js`

### TC-S4T1-002: Конвертация не-принятой сметы — 400
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S4-T1 Сценарий 2
- **Предусловия:** `estimate.id=8`, `status='draft'`.
- **Входные данные:** `POST /api/estimates/8/convert`
- **Ожидаемый результат:** HTTP 400, `{ error: 'Estimate must be accepted before converting' }`.
- **Файл для теста:** `tests/routes/estimates.convert.test.js`

### TC-S4T1-003: Конвертация уже конвертированной сметы — 409
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S4-T1 Сценарий 3
- **Предусловия:** Estimate 9 уже имеет связанный invoice (`invoice_id != null`).
- **Входные данные:** `POST /api/estimates/9/convert`
- **Ожидаемый результат:** HTTP 409, `{ error: 'Invoice already exists for this estimate' }`.
- **Файл для теста:** `tests/routes/estimates.convert.test.js`

### TC-S4T1-004: Конвертация чужой сметы — 404
- **Приоритет:** P0 (изоляция данных)
- **Тип:** Integration
- **Связанный сценарий:** S4-T1 Безопасность
- **Предусловия:** Estimate 10 принадлежит company_id=2. Запрос от company_id=1.
- **Входные данные:** `POST /api/estimates/10/convert` от company_id=1
- **Ожидаемый результат:** HTTP 404 (не раскрывает факт существования).
- **Файл для теста:** `tests/routes/estimates.convert.test.js`

### TC-S4T1-005: Endpoint без авторизации — 401
- **Приоритет:** P0 (безопасность)
- **Тип:** Integration
- **Входные данные:** `POST /api/estimates/7/convert` без Authorization header
- **Ожидаемый результат:** HTTP 401.
- **Файл для теста:** `tests/routes/estimates.convert.test.js`

### TC-S4T1-006: Frontend — кнопка "Create Invoice" видна только при accepted
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S4-T1 Сценарий 2
- **Входные данные:** `estimate.status='draft'`
- **Шаги:** Рендеринг `EstimateDetailPanel` с draft estimate.
- **Ожидаемый результат:** Кнопка "Create Invoice" отсутствует в DOM.
- **Файл для теста:** `frontend/src/components/estimates/__tests__/EstimateDetailPanel.test.tsx`

### TC-S4T1-007: Frontend — кнопка "Create Invoice" видна при accepted
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** `estimate.status='accepted'`
- **Ожидаемый результат:** Кнопка "Create Invoice" присутствует в DOM.
- **Файл для теста:** `frontend/src/components/estimates/__tests__/EstimateDetailPanel.test.tsx`

### TC-S4T1-008: estimatesService.convertToInvoice — копирование items
- **Приоритет:** P1
- **Тип:** Unit
- **Предусловия:** Мок DB с estimate + 3 items.
- **Шаги:** Вызвать `convertToInvoice(estimateId, companyId)`.
- **Ожидаемый результат:** Возвращает invoice с `items.length === 3`, каждый item имеет те же `name`, `quantity`, `unit_price`.
- **Файл для теста:** `tests/services/estimatesService.test.js`

---

## S4-T2: Invoice → Transactions Link

### TC-S4T2-001: Отображение транзакций для инвойса
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S4-T2 Сценарий 1
- **Предусловия:** Invoice 20, 2 транзакции с `invoice_id=20`.
- **Моки:** `GET /api/transactions?invoice_id=20` → `[{id:1, amount:'500.00',...}, {id:2, amount:'300.00',...}]`
- **Шаги:**
  1. Монтировать `InvoiceDetailPanel` с `invoiceId=20`.
  2. Дождаться fetch.
- **Ожидаемый результат:** Секция "Payments" отображает 2 строки, итог "Paid: $800.00".
- **Файл для теста:** `frontend/src/components/invoices/__tests__/InvoiceDetailPanel.test.tsx`

### TC-S4T2-002: Инвойс без транзакций — пустое состояние
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** `GET /api/transactions?invoice_id=20` → `[]`
- **Ожидаемый результат:** "No payments recorded" без ошибок.
- **Файл для теста:** `frontend/src/components/invoices/__tests__/InvoiceDetailPanel.test.tsx`

### TC-S4T2-003: Ошибка загрузки транзакций — не блокирует панель
- **Приоритет:** P2
- **Тип:** Integration
- **Моки:** `GET /api/transactions?invoice_id=20` → 500
- **Ожидаемый результат:** Основные данные инвойса отображаются, секция Payments показывает "Failed to load payments".
- **Файл для теста:** `frontend/src/components/invoices/__tests__/InvoiceDetailPanel.test.tsx`

---

## S5-T1: RecordPaymentDialog вместо window.prompt

### TC-S5T1-001: Диалог открывается при клике "Record Payment"
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S5-T1 Сценарий 1
- **Предусловия:** `InvoiceDetailPanel` с `status='sent'`.
- **Шаги:** Кликнуть "Record Payment".
- **Ожидаемый результат:** `RecordPaymentDialog` открыт, `defaultInvoiceId` = invoiceId.
- **Файл для теста:** `frontend/src/components/invoices/__tests__/InvoiceDetailPanel.test.tsx`

### TC-S5T1-002: window.prompt не вызывается
- **Приоритет:** P0
- **Тип:** Unit
- **Предусловия:** `window.prompt` замоканo.
- **Шаги:** Кликнуть "Record Payment".
- **Ожидаемый результат:** `window.prompt` никогда не вызывается.
- **Файл для теста:** `frontend/src/components/invoices/__tests__/InvoiceDetailPanel.test.tsx`

### TC-S5T1-003: Кнопка "Record Payment" скрыта для paid инвойса
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** `invoice.status='paid'`
- **Ожидаемый результат:** Кнопка "Record Payment" отсутствует или disabled.
- **Файл для теста:** `frontend/src/components/invoices/__tests__/InvoiceDetailPanel.test.tsx`

### TC-S5T1-004: Успешная запись платежа — обновление данных
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** POST payment → `{id:5, amount:'100.00'}`
- **Шаги:**
  1. Открыть диалог, заполнить сумму=100, метод='cash'.
  2. Нажать "Save".
- **Ожидаемый результат:** Диалог закрылся, `refresh()` вызван, toast "Payment of $100 recorded".
- **Файл для теста:** `frontend/src/components/invoices/__tests__/InvoiceDetailPanel.test.tsx`

---

## S3-T3/S4-T3: Financial Events в Pulse Timeline

### TC-PULSE-001: Timeline включает estimate_created событие
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** Estimate создан с `contact_id=5`.
- **Входные данные:** `GET /api/pulse/timeline?contact_id=5`
- **Ожидаемый результат:** Ответ содержит event с `type='estimate_created'`, `reference='E-001'`, `amount` и `occurred_at`.
- **Файл для теста:** `tests/routes/pulse.timeline.test.js`

### TC-PULSE-002: Timeline включает invoice_paid событие
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** Invoice создан с `contact_id=5`, транзакция создана.
- **Ожидаемый результат:** Event с `type='invoice_paid'` присутствует.
- **Файл для теста:** `tests/routes/pulse.timeline.test.js`

### TC-PULSE-003: Существующие события не нарушены (regression)
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** Контакт с существующими call/SMS событиями.
- **Шаги:** `GET /api/pulse/timeline?contact_id=N`.
- **Ожидаемый результат:** Все ранее существовавшие типы событий присутствуют с теми же полями. Новые financial events добавлены, но ничего не удалено.
- **Файл для теста:** `tests/routes/pulse.timeline.test.js`

### TC-PULSE-004: Financial events другой компании не попадают
- **Приоритет:** P0 (изоляция)
- **Тип:** Integration
- **Предусловия:** Estimate company_id=2 имеет `contact_id=5`. Запрос от company_id=1.
- **Ожидаемый результат:** `estimate_created` event компании 2 не присутствует в ответе компании 1.
- **Файл для теста:** `tests/routes/pulse.timeline.test.js`

### TC-PULSE-005: Смета без contact_id не попадает в timeline
- **Приоритет:** P2
- **Тип:** Integration
- **Предусловия:** Estimate с `contact_id=null`, `job_id=N`.
- **Шаги:** Timeline для любого contact_id.
- **Ожидаемый результат:** Этот estimate не появляется ни в одном timeline.
- **Файл для теста:** `tests/routes/pulse.timeline.test.js`

### TC-PULSE-006: Frontend рендеринг FinancialEventListItem
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** `event = { type: 'estimate_created', reference: 'E-001', amount: '1200.00', status: 'draft', occurred_at: '...' }`
- **Ожидаемый результат:** Компонент рендерит "Estimate E-001 created", сумму "$1,200.00", статус badge.
- **Файл для теста:** `frontend/src/components/pulse/__tests__/FinancialEventListItem.test.tsx`

### TC-PULSE-007: E2E — полный flow создания сметы и её события в timeline
- **Приоритет:** P3
- **Тип:** E2E
- **Шаги:**
  1. Создать estimate через API с `contact_id=5`.
  2. Запросить `GET /api/pulse/timeline?contact_id=5`.
  3. Проверить наличие `estimate_created` в ответе.
- **Ожидаемый результат:** Событие появляется в timeline сразу после создания.
- **Файл для теста:** `tests/e2e/pulse-financials.test.js`

### TC-PULSE-008: E2E — оплата инвойса в timeline
- **Приоритет:** P3
- **Тип:** E2E
- **Шаги:**
  1. Создать invoice с `contact_id=5`.
  2. Записать транзакцию.
  3. Запросить timeline.
- **Ожидаемый результат:** `invoice_paid` или `invoice_partial_payment` присутствует.
- **Файл для теста:** `tests/e2e/pulse-financials.test.js`
