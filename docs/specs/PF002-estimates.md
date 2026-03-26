# Спецификация: PF002 — Estimates

**Дата:** 2026-03-24
**Статус:** Proposed
**Приоритет:** P0
**Зависит от:** текущие `Leads`, `Jobs`, `Contacts`, `Quick Messages`, `Pulse`, будущие `PF004`, `PF005`, `PF006`

---

## Цель

Добавить полноценный sales-document layer для подготовки, отправки, согласования и частичного предоплатного подтверждения работ.

`Estimate` должен быть отдельным финансовым документом, связанным с текущими `Lead` и `Job`, но не быть обязательной ступенью внутри operational flow `Lead -> Job`.

---

## Что уже есть

- `Leads` и `Jobs` содержат service context, contact info, address, source, job type.
- `Pulse` уже поддерживает action-required причины вроде `Estimate approved`.
- Есть `Quick Messages` и SMS delivery infrastructure.
- Есть `Payments` как текущий ledger/reporting слой.
- Есть `Contacts` и dedupe для reuse клиента.

---

## Встраивание в текущий продукт

### Новый route

- Добавить top-level route `/estimates`.

### Entry points

Estimate должен создаваться из:

- `Leads` page
- `Jobs` page
- `Contacts` page только через выбор существующего `Lead` или `Job`
- `Pulse` middle card / timeline context только через выбор существующего `Lead` или `Job`
- глобального `Create new` только через выбор существующего `Lead` или `Job`

### Основная продуктовая модель

В системе должны существовать два связанных, но не слитых в один, флоу:

- `Lead -> Convert/Sync to Job -> Job`
- `Estimate -> Approval/Deposit -> Invoice`

Связующее правило:

- estimate всегда связан минимум с `contact`;
- estimate может иметь `lead_id`, `job_id` или оба link одновременно;
- конвертация lead в job не является стадией estimate lifecycle, а только создаёт/обновляет relationship между estimate и job.

### Связь с текущими экранами

- текущий `Convert to Job` flow остаётся самостоятельным operational flow;
- если у lead уже есть estimate, созданный job должен уметь быть привязан к этому estimate без потери `lead` context;
- estimate на job должен быть виден в job detail как finance subsection;
- estimate события должны отображаться как отдельные items внутри текущего `Pulse` timeline, где уже находятся звонки и сообщения.

---

## Пользовательские сценарии

1. Оператор создаёт estimate из lead или job и отправляет клиенту по SMS или email.
2. Клиент открывает link в portal, просматривает estimate и подписывает/approve document.
3. Команда получает signal, что estimate viewed / approved / declined / deposit paid.
4. Оператор отдельно конвертирует lead в job; существующий estimate сохраняет link на lead и при необходимости получает link на созданный job.
5. При необходимости оператор записывает deposit payment по estimate и затем использует estimate как источник для invoice.

---

## Функциональные требования

### 1. Типы estimate

Поддержать только связанные estimates и гибкую relationship model.

Relationship model:

- `contact_id` обязателен всегда;
- `lead_id` опционален;
- `job_id` опционален;
- хотя бы один из `lead_id` или `job_id` обязателен;
- `lead_id` и `job_id` могут быть заполнены одновременно.

Правила:

- estimate может быть создан из lead, из job или позже получить второй link;
- отсутствие `job_id` допустимо, если estimate связан с lead;
- отсутствие `lead_id` допустимо, если estimate создан из job;
- появление `job_id` не должно обнулять `lead_id`, если sales context должен сохраниться.

### 2. Статусы

Обязательные статусы:

- `draft`
- `sent`
- `viewed`
- `approved`
- `declined`
- `expired`
- `cancelled`

Дополнительные finance flags:

- `signature_required`
- `signed_at`
- `deposit_required`
- `deposit_amount`
- `deposit_paid_amount`

### 3. Структура estimate

Estimate должен включать:

- client/contact данные
- billing/service address
- optional `lead_id` / `job_id` links с возможностью одновременного хранения обоих
- line items
- subtotal / discount / tax / total
- deposit request
- notes for client
- internal notes
- attachments
- generated PDF document snapshot
- audit trail

### 4. Line items

В P0 line items вводятся вручную или через существующие job/service данные.

Для initial release не требуется полноценный `Price Book`, но estimate item model должна уже поддерживать:

- `name`
- `description`
- `quantity`
- `unit_price`
- `unit`
- `taxable`
- `sort_order`

Эта модель должна затем без переделки стать основой для future `Price Book`.

### 5. Send flow

Estimate должен отправляться:

- по SMS
- по email

Send flow обязан:

- использовать editable message body;
- уметь подставлять Quick Message / placeholder values;
- генерировать portal link;
- генерировать PDF estimate из текущей revision;
- при отправке по email прикладывать PDF estimate к письму;
- при отправке по SMS не прикладывать файлы и отправлять только ссылку на estimate в системе;
- логировать факт отправки, канал и timestamp;
- создавать timeline item в текущем `Pulse` chronology, а не в отдельном finance feed.

### 6. Preview

При просмотре estimate в системе пользователь должен иметь доступ к preview.

Правила:

- preview доступен из estimate detail view в любой момент, а не только внутри send-flow;
- preview mode доступен только внутреннему пользователю;
- send-flow использует тот же preview, а не отдельную реализацию;
- клиент видит только отправленные estimates;
- unsent draft в portal доступен только в preview mode.

### 7. PDF document

Estimate должен существовать не только как portal page, но и как полноценный PDF document.

Требования:

- PDF строится из той же канонической document model, что и portal preview;
- PDF должен быть пригоден для email attachment, внутреннего preview и скачивания;
- PDF должен быть printable и client-facing, а не сырой browser dump;
- PDF должен содержать как минимум company block, client block, estimate number/date, line items, totals, notes, deposit/signature section, если они включены;
- PDF является snapshot-артефактом конкретной revision;
- система должна сохранять, какой PDF был приложен к конкретной email delivery;
- для SMS PDF не используется и не дублируется.

Минимальный checklist PDF estimate:

- header: company logo/name, document title `Estimate`, estimate number, created date, optional valid-through / expiry date;
- company block: company name, phone, email, address, optional license/business identifiers;
- customer block: customer name, phone, email, billing address, service address;
- context block: optional lead/job reference, prepared by, status label, document revision if это internal preview;
- pricing table: item name, description, quantity, unit, unit price, line total;
- totals block: subtotal, discount, tax, grand total;
- deposit block: deposit requested, deposit amount/type, amount already paid, remaining amount if deposit exists;
- notes block: client-facing notes / scope notes / exclusions if they заполнены;
- signature / approval block: signature-required marker, signature area/status, approval confirmation area if enabled;
- footer: page numbers, company contact reminder, optional portal/payment instruction note.

Layout constraints:

- PDF должен хорошо печататься на стандартном листе без обрезания ключевых блоков;
- pricing table и totals должны быть читаемы без horizontal overflow;
- длинные notes/description не должны ломать totals/footer layout;
- visual hierarchy должна быть ближе к formal estimate/invoice document, а не к raw app screenshot;
- attached sample `estimate+Kenny+Ducoste.pdf` считается ориентиром по уровню оформления и printable quality.

### 8. Approval / signature / deposit

Клиент в portal должен уметь:

- просмотреть estimate;
- approve / decline;
- подписать estimate, если signature required;
- видеть, что по estimate requested deposit exists.

Deposit payment в текущем P0 записывается внутренним пользователем через payment layer, а не клиентом через portal checkout.

### 9. События и сигналы

Estimate lifecycle должен публиковать события:

- `estimate.sent`
- `estimate.viewed`
- `estimate.approved`
- `estimate.declined`
- `estimate.deposit_paid`

Дополнительно поддержать relationship events:

- `estimate.job_linked`
- `estimate.job_synced`

Интеграция:

- `estimate.approved` должен активировать реальную, а не декоративную причину `Action Required`;
- события должны быть доступны для `Automation Engine`;
- `Pulse` должен показывать их в текущем timeline рядом с сообщениями и звонками.

### 10. Связь с leads и jobs

Требования:

- estimate хранит `contact_id` и может хранить `lead_id`, `job_id` или оба link одновременно;
- current `Convert to Job` flow остаётся canonical способом создания job из lead;
- при conversion lead в job существующий estimate может быть привязан к созданному job без смены собственного lifecycle;
- если estimate уже связан с job, line items и deposit context могут быть явно синхронизированы в job finance context;
- approved estimate может быть использован как source document для invoice независимо от того, был ли уже создан job;
- approval/deposit не должны автоматически создавать job по умолчанию.

### 11. Правила редактирования

- `draft` всегда редактируем;
- после `sent` редактирование создаёт новую revision того же estimate;
- approved estimate нельзя silently переписывать;
- для P0 не требуется multi-option proposal system.

---

## Data / API требования

### Backend contracts

Нужны как минимум:

- `GET /api/estimates`
- `POST /api/estimates`
- `GET /api/estimates/:id`
- `PATCH /api/estimates/:id`
- `POST /api/estimates/:id/send`
- `GET /api/estimates/:id/pdf`
- `POST /api/estimates/:id/approve`
- `POST /api/estimates/:id/decline`
- `POST /api/estimates/:id/link-job`
- `POST /api/estimates/:id/sync-to-job`
- `POST /api/estimates/:id/request-deposit`
- `POST /api/estimates/:id/copy-to-job`
- `POST /api/estimates/:id/copy-to-invoice`

### Data model

Новые доменные сущности:

- `estimates`
- `estimate_items`
- `estimate_revisions`
- `estimate_events`

`estimate_items` не должны быть временным форматом. Они должны стать совместимыми с будущими invoice/job items.

---

## Ограничения

- multi-estimate sales proposals не входят в initial P0;
- advanced document templates не входят в P0;
- price-book categories и flat-rate catalogs не входят в P0;
- financing flows не входят в P0.

---

## Acceptance criteria

- Estimate можно создать из `Lead`, `Job`, а также из `Contact`/`Pulse`/`Create new` только после выбора существующего `Lead` или `Job`.
- Estimate можно отправить по email с portal link и PDF attachment.
- Estimate можно отправить по SMS только со ссылкой на estimate в системе, без attachment.
- Для sent estimate существует сохранённый PDF snapshot.
- Preview estimate доступен при просмотре estimate в системе, а не только перед отправкой.
- Клиент может approve/decline/sign estimate через portal.
- Deposit payment может быть записан внутренним пользователем и обновляет estimate finance state.
- `estimate.viewed` и `estimate.approved` попадают в `Pulse` и доступны automation rules.
- Estimate lifecycle не подменяет собой `Lead -> Job` flow, а живёт параллельно и может быть связан с lead и job одновременно.
- Approved estimate можно использовать как source для invoice независимо от наличия job.
- Standalone estimate без `lead_id` и без `job_id` запрещён.
- Нет дублирующего client model: estimate работает поверх текущих `Contacts/Leads/Jobs`.
