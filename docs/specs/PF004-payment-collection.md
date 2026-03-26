# Спецификация: PF004 — Payment Collection

**Дата:** 2026-03-24
**Статус:** Proposed
**Приоритет:** P0
**Зависит от:** текущие `Payments` ledger flows; `PF002`, `PF003`, `PF005`

---

## Цель

Превратить текущий `Payments` модуль из read-only sync/reporting слоя в operational recorded-payment layer:

- записывать оплату по estimate/invoice;
- принимать partial payments и deposits как recorded transactions;
- хранить canonical linked payments и receipts;
- давать команде единый ledger и reconciliation view.

---

## Что уже есть

- `/payments` уже существует как split-view ledger.
- backend уже умеет sync и detail по платежам из Zenbooker.
- UI уже умеет фильтровать, экспортировать и открывать payment detail.

Это надо не выбрасывать, а расширить.

---

## Встраивание в текущий продукт

### Основной принцип

`/payments` остаётся единым финансовым ledger-экраном для команды.

Новые collection flows должны:

- писать данные в этот же ledger;
- быть видны из `Estimate`, `Invoice`, `Job`;
- не создавать отдельный "payment center" с другой моделью.

---

## Пользовательские сценарии

1. Оператор отправляет estimate с deposit request.
2. Оператор записывает deposit payment по estimate.
3. Команда видит payment в `/payments`, estimate получает updated finance state.
4. После выполнения job клиент получает invoice.
5. Оператор через `Add Payment` записывает частичную или полную оплату по invoice.
6. При необходимости команда отправляет receipt.

---

## Функциональные требования

### 1. Поддерживаемые payment flows

В P0 поддержать:

- estimate deposit payment record
- invoice full payment record
- invoice partial payment record
- manual payment entry
- check registration

### 2. Где можно инициировать оплату

Payment collection должен запускаться из:

- `Estimate` detail
- `Invoice` detail
- `Job` finance section
- `/payments` ledger detail для manual reconciliation

### 3. Payment methods

Система должна поддерживать для текущего P0:

- recorded/manual method:
  - check

Payment record должен хранить:

- amount
- payment date
- payment type
- memo
- optional check/reference number
- recorded_by

### 4. Deposits

Estimate должен поддерживать:

- `deposit_required` flag
- fixed amount или percent
- deposit due state
- deposit paid event

После записи deposit payment:

- estimate получает finance update;
- событие уходит в automations и отображается как timeline item внутри текущего `Pulse` chronology;
- ledger показывает платеж как связанный с estimate.

### 5. Partial payments

Invoice должен поддерживать:

- полную оплату;
- частичную оплату;
- ручной ввод суммы ниже balance;
- автоматический пересчёт `amount_paid` и `balance_due`.

Дополнительное правило:

- invoice detail должен показывать linked payments section;
- `Add Payment` пишет payment record прямо в canonical payment layer, а не во второй invoice-local submodel.

### 6. Receipts

После записи платежа система должна уметь:

- отправить receipt по email;
- при наличии phone предложить отправить receipt link по SMS;
- показать receipt в internal payment detail.

### 8. Ledger / reconciliation

Текущая `/payments` страница должна быть расширена, но сохранена:

- показывать source (`estimate`, `invoice`, `manual`, `external sync`);
- показывать linked document;
- показывать payment status и method;
- различать legacy synced и locally recorded payments;
- сохранять текущие export/reporting возможности.

### 9. Failure / correction handling

Для текущего P0:

- processor/card failures не входят в scope;
- ошибочно записанный платёж не должен менять estimate/invoice silently без audit;
- correction/void flow может быть ограничен admin/manual process, но ledger и document aggregates должны оставаться согласованными.

---

## Data / API требования

### Backend contracts

Нужны как минимум:

- `POST /api/payments/manual`
- `GET /api/payments/:id`
- `GET /api/payments?filters`
- `POST /api/estimates/:id/payments`
- `GET /api/estimates/:id/payments`
- `POST /api/invoices/:id/payments`
- `GET /api/invoices/:id/payments`
- `POST /api/payments/:id/send-receipt`

### Data model

Нужны сущности:

- `payment_transactions`
- `payment_receipts`

Связи:

- payment может ссылаться на `estimate_id` или `invoice_id`;
- при необходимости payment также может ссылаться на `job_id`, но первичный link идёт через document.

### Migration path

Существующий `paymentsService` и `/api/zenbooker/payments` не удаляются.

Новый collection layer должен:

- либо писать в совместимый ledger table;
- либо маппиться в unified payment read model, который читает и новые local payments, и legacy synced payments.

---

## Ограничения

- `Tap to pay`, card readers и hardware POS не входят в P0;
- card processing, saved cards, portal self-serve payments и provider webhooks не входят в текущий P0;
- financing, disputes, payouts и refunds не входят в P0;
- accounting/export integrations не входят в P0;
- advanced recurring billing не входит в P0.

---

## Acceptance criteria

- Команда может записать deposit payment по estimate и полную/частичную оплату по invoice.
- Из invoice detail доступен `Add Payment`, который создаёт linked payment record.
- Все платежи видны в существующем `/payments` ledger.
- Estimate/invoice автоматически пересчитывают paid/balance state.
- Receipt доступен для recorded payments.
- Card processing и portal self-serve payment не требуются для текущего P0.
