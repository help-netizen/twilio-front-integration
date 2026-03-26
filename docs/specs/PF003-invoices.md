# Спецификация: PF003 — Invoices

**Дата:** 2026-03-24
**Статус:** Proposed
**Приоритет:** P0
**Зависит от:** текущие `Jobs`, `Contacts`, `Payments`; shared item model from `PF002`; portal/payment flows from `PF004/PF005`

---

## Цель

Добавить полноценный invoice layer для выставления счёта, отслеживания задолженности и закрытия финансового цикла от estimate/work context до оплаты.

Invoice должен быть встроен в существующие `Jobs`, `Estimates` и `Contacts`, использовать текущий `Payments` экран как ledger/reconciliation surface и не требовать, чтобы `Estimate` был этапом внутри `Lead -> Job` цепочки.

---

## Что уже есть

- `Jobs` уже содержат service, address, provider и contact context.
- `Payments` page уже показывает synced transaction ledger и detail.
- `Contacts` уже содержат email/phone для отправки документов.
- `Pulse` уже умеет показывать важные communication events.

---

## Встраивание в текущий продукт

### Новый route

- Добавить top-level route `/invoices`.

### Entry points

Invoice должен создаваться из:

- `Job` detail
- approved `Estimate`
- `Contact`
- standalone create flow

### Главный принцип

Invoice — это отдельный financial document flow, связанный с estimate и/или job context.

Правила:

- `job-connected invoice` остаётся основным операторским путём;
- `estimate-derived invoice` является first-class path, а не обходным сценарием;
- invoice может сохранять одновременно `estimate_id`, `job_id` и sales trace на `lead_id`, если документ начался до создания job;
- standalone invoices допустимы, но должны быть явно помечены как исключение и иметь более ограниченный reporting/automation value.

---

## Пользовательские сценарии

1. Диспетчер или оператор создаёт invoice из approved estimate или из job.
2. Клиент получает invoice link по SMS/email и просматривает документ через portal.
3. Оператор использует `Add Payment` в invoice detail и записывает полную или частичную оплату.
4. Команда видит due / overdue / partially paid / paid и отправляет follow-up.
5. `Payments` ledger автоматически показывает все оплаты, связанные с invoice.

---

## Функциональные требования

### 1. Типы invoice

Поддержать:

- `job-connected invoice`
- `standalone invoice`
- `estimate-derived invoice`

### 2. Статусы

Обязательные статусы:

- `draft`
- `sent`
- `due`
- `overdue`
- `partially_paid`
- `paid`
- `voided`

Статус должен рассчитываться из:

- отправленности документа
- due date
- balance due
- void state

### 3. Структура invoice

Invoice включает:

- client/contact данные
- billing/service address
- optional `lead_id` / `job_id` / `estimate_id` links с возможностью хранения sales и work context одновременно
- line items
- subtotal / tax / discount / total
- paid amount / balance due
- due date / payment terms
- notes for client
- internal notes
- attachments
- generated PDF document snapshot
- event history

### 4. Источник line items

В initial P0 line items могут приходить:

- из job finance context
- из approved estimate
- через ручной ввод

Чтобы избежать неочевидного поведения:

- invoice при создании получает snapshot line items;
- последующие изменения в job/estimate не должны silently мутировать invoice;
- если нужен перенос обновлений, это делается явным действием `Sync items from source`.

### 5. Due dates и payment terms

Система должна поддерживать:

- default company payment terms
- optional client-level override
- per-invoice override
- custom due date

### 6. Send flow

Invoice отправляется:

- по SMS
- по email

Send flow обязан:

- генерировать portal link;
- показывать preview;
- генерировать PDF invoice из текущей revision;
- при отправке по email прикладывать PDF invoice к письму;
- при отправке по SMS не прикладывать файлы и отправлять только ссылку на invoice в системе;
- сохранять send timestamp и канал;
- писать timeline item в текущий `Pulse` timeline, где уже отображаются сообщения и звонки.

### 7. Preview

При просмотре invoice в системе пользователь должен иметь доступ к preview.

Правила:

- preview доступен из invoice detail view в любой момент, а не только внутри send-flow;
- preview mode доступен только внутреннему пользователю;
- send-flow использует тот же preview, а не отдельную реализацию;
- клиент видит только отправленные invoices;
- unsent draft в portal доступен только в preview mode.

### 8. PDF document

Invoice должен существовать не только как portal page, но и как полноценный PDF document.

Требования:

- PDF строится из той же канонической document model, что и portal preview;
- PDF должен быть пригоден для email attachment, внутреннего preview и скачивания;
- PDF должен быть printable и client-facing, а не сырой browser dump;
- PDF должен содержать как минимум company block, client block, invoice number/date, due date/payment terms, line items, totals, paid/balance due block, notes, payment instructions if enabled;
- PDF является snapshot-артефактом конкретной revision;
- система должна сохранять, какой PDF был приложен к конкретной email delivery;
- для SMS PDF не используется и не дублируется.

Минимальный checklist PDF invoice:

- header: company logo/name, document title `Invoice`, invoice number, created date, due date;
- company block: company name, phone, email, address, optional license/business identifiers;
- customer block: customer name, phone, email, billing address, service address;
- context block: optional lead/job/estimate reference, prepared by, status label, document revision if это internal preview;
- pricing table: item name, description, quantity, unit, unit price, line total;
- totals block: subtotal, discount, tax, grand total;
- payments block: amount paid, balance due, optional payment terms summary;
- notes block: client-facing notes / terms / service notes if they заполнены;
- payment instruction block: payment terms, check/remittance note, optional internal payment instructions if enabled;
- footer: page numbers, company contact reminder, optional support/payment note.

Layout constraints:

- PDF должен хорошо печататься на стандартном листе без обрезания ключевых блоков;
- pricing table, totals и balance due должны быть читаемы без horizontal overflow;
- длинные descriptions/notes не должны ломать totals/footer layout;
- visual hierarchy должна быть ближе к formal invoice document, а не к raw app screenshot.

### 9. Payment linkage

Invoice должен быть плотно связан с `Payment Collection`:

- из invoice detail должен существовать явный action `Add Payment`, если есть `balance_due > 0`;
- `Add Payment` создаёт canonical payment record, связанный с конкретным invoice;
- должны поддерживаться полный платёж и частичный платёж;
- current P0 payment recording выполняется внутренним пользователем, а не клиентом через portal/card flow;
- стартовый payment type для P0: `check`;
- payment record должен поддерживать как минимум `amount`, `payment_date`, `memo`, optional `reference/check number`;
- после записи платежа invoice автоматически пересчитывает `amount_paid` и `balance_due`;
- если `balance_due = 0`, invoice автоматически переходит в `paid`;
- если `0 < amount_paid < total_amount`, invoice переходит в `partially_paid`;
- recorded payment отображается в invoice payments section и в общем `/payments` ledger;
- receipt может быть отправлен после успешной записи платежа.

### 10. Edit и audit rules

- `draft` invoice редактируем;
- после `sent` редактирование создаёт revision trail;
- `paid` invoice нельзя silently менять без audit;
- удаление invoice в P0 не допускается; вместо этого нужен `void`.

### 11. Связь с jobs

Требования:

- если invoice создан из job, он сохраняет link на job;
- job detail показывает current invoice summary;
- из job видно invoice status, total, amount paid, amount due;
- invoice status должен быть доступен для future job reports / automations.

### 12. Связь с estimates и leads

Требования:

- invoice, созданный из estimate, сохраняет `estimate_id`;
- если estimate до этого был связан с lead, invoice должен иметь возможность сохранить `lead_id` для sales traceability;
- если после создания invoice появляется связанный job, invoice может получить `job_id` без потери `estimate_id` и `lead_id`;
- invoice lifecycle остаётся отдельным от lead/job lifecycle и не должен зависеть от факта conversion.

### 13. Связь с payments ledger

Текущая `/payments` страница остаётся canonical finance ledger view.

При этом user-significant invoice события (`sent`, `overdue`, `paid`, `partially_paid`) должны отображаться не в отдельном event-list, а в текущем `Pulse` timeline.

После запуска invoices:

- detail payment должен ссылаться на invoice;
- detail invoice должен ссылаться на payments;
- recorded/manual payments должны появляться в том же ledger, а не в отдельной странице.

---

## Data / API требования

### Backend contracts

Нужны как минимум:

- `GET /api/invoices`
- `POST /api/invoices`
- `GET /api/invoices/:id`
- `PATCH /api/invoices/:id`
- `POST /api/invoices/:id/send`
- `GET /api/invoices/:id/pdf`
- `POST /api/invoices/:id/void`
- `POST /api/invoices/:id/sync-items`
- `GET /api/invoices/:id/payments`

### Data model

Новые сущности:

- `invoices`
- `invoice_items`
- `invoice_revisions`
- `invoice_events`

Интеграционный слой:

- invoice должен ссылаться на `contact_id` и optional `lead_id` / `job_id` / `estimate_id`;
- payment rows должны уметь ссылаться на `invoice_id`.

---

## Ограничения

- progressive billing не входит в initial P0;
- credit notes / refunds / write-offs не входят в initial P0;
- bulk send и custom invoice templates можно оставить на следующий этап;
- multiple active invoices per job не требуются для initial P0.

---

## Acceptance criteria

- Invoice можно создать из `Job`, approved `Estimate` и standalone.
- Invoice может одновременно сохранять estimate/work context и sales trace (`lead_id`), если это требуется business flow.
- Invoice можно отправить по email с portal link и PDF attachment.
- Invoice можно отправить по SMS только со ссылкой на invoice в системе, без attachment.
- Preview invoice доступен при просмотре invoice в системе, а не только перед отправкой.
- Для sent invoice существует сохранённый PDF snapshot.
- Из invoice detail можно записать полный или частичный платёж через `Add Payment`.
- Recorded payment сразу появляется в invoice payments section и в `/payments` ledger.
- Invoice имеет корректные `due / overdue / partially paid / paid / voided` статусы.
- Invoice detail и `/payments` ledger ссылаются друг на друга.
- Любая записанная оплата обновляет invoice balance и payment ledger.
- Нет скрытого двустороннего sync, который непредсказуемо меняет invoice после отправки.
