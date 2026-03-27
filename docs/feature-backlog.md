# Бэклог фич для догоняния функционала Workiz

## Контекст

Этот backlog составлен на основе:

- текущего продуктового scope в `docs/project-spec.md`
- фактически реализованных модулей и последних изменений в `docs/changelog.md`
- текущего пользовательского функционала в `docs/current_functionality.md`
- актуальных разделов справки Workiz (`help.workiz.com`) по состоянию на 2026-03-24

Это не попытка 1:1 скопировать Workiz. Приоритеты выставлены так, чтобы:

1. максимально быстро закрыть самые большие продуктовые дыры относительно рынка;
2. опереться на уже существующие модули Blanc;
3. не тратить ранний roadmap на слабые или периферийные части Workiz.

## Что уже есть как база

В проекте уже реализовано сильное ядро operator workspace:

- Pulse / SMS / call timeline / AI summary
- Softphone
- Contacts / Leads / Jobs
- Payments page как sync/reporting слой
- Messages page
- Users / settings / telephony admin
- базовая multi-tenant схема `companies + company_memberships`, но пока только с ролями `admin/member`

Из-за этого главный gap сейчас не в "ещё одном CRM-экране", а в отсутствии полноценных слоёв:

- tenant-safe RBAC foundation
- Pulse as canonical event timeline foundation
- dispatch/schedule
- finance docs (estimates/invoices)
- self-service client flows
- automation/reporting
- recurring revenue / service plans

## Легенда приоритетов

- `P0` — критично для быстрого догоняния рынка и открывает сразу несколько сценариев
- `P1` — высокий приоритет, резко повышает completeness продукта
- `P2` — важное расширение после закрытия ядра
- `P3` — низкий приоритет / точечные add-ons

## 0. Identity, Tenancy, Permissions

### P0. Полноценная мультитенантная модель компании + platform super admin + RBAC
- `Keycloak` остаётся auth-provider, но tenant authorization переносится в приложение
- `super_admin` становится platform-only и больше не имеет доступа в tenant-компании
- создание tenant-компании всегда включает bootstrap первого пользователя-админа
- в каждой активной компании всегда минимум один активный admin
- вместо `admin/member` появляется полноценный `Team Management + Roles & Permissions`
- фиксированные системные роли по смыслу как в Workiz: `Tenant Admin`, `Manager`, `Dispatcher`, `Provider`, но без `Subcontractors` и `Franchises`
- tenant-admin настраивает permission matrix для каждой установленной роли внутри компании и при необходимости включает granular permission toggles в профиле конкретного сотрудника по модели, близкой к Zenbooker
- advanced restrictions: `assigned jobs only`, `financial data`, `dashboard/widgets`, `close jobs`, `collect payments`, `client history`, `phone access`, `service areas`, `skills/job types`, `provider`, `call masking`, `GPS`
- роли и ограничения применяются ко всем текущим и будущим модулям, а не только к странице users

Почему это стало самым высоким приоритетом:
- текущая модель `company_admin/company_member` слишком грубая и уже не соответствует фактической сложности продукта
- upcoming `Schedule / Estimates / Invoices / Client Portal / Automation Engine` без tenant-safe RBAC быстро превратятся в набор hardcoded исключений
- сейчас `super_admin` архитектурно может обходить tenant-boundaries, что противоречит целевой SaaS-модели
- это foundation, без которого дальнейшее догоняние Workiz будет дорогим и нестабильным

### P0. Pulse client timeline core + realtime governance
- `Pulse` становится canonical client timeline, а не только `calls + sms` page
- все high-value client events обязаны попадать в текущий Pulse timeline
- `Action Required / Snooze / Tasks` остаются control layer вне timeline, но их lifecycle зеркалируется в историю
- shared `SSE` taxonomy и event delivery semantics документируются как часть Pulse package
- любые новые продуктовые фичи обязаны описывать `Pulse / Realtime integration`

Почему это тоже foundation:
- без общего Pulse/event слоя `Schedule / Estimates / Invoices / Portal / Automations` быстро создадут дублирующиеся activity surfaces
- realtime поведение уже является cross-cutting частью продукта и должно развиваться централизованно

## 1. Dispatch & Schedule

### P0. Единый Schedule / Dispatcher workspace
- Календарные представления `day / week / month / timeline / timeline week`
- Отображение в одном месте jobs, leads и tasks
- Drag-and-drop reschedule / reassignment
- Quick view sidebar с ключевыми данными клиента, адреса, статуса и быстрыми действиями
- Фильтры по статусам, provider/tech, tags, source, job type

Почему высокий приоритет:
- у вас уже есть leads/jobs и telephony, но нет главного dispatch-экрана, который у Workiz является центральным рабочим местом для операционного контура
- это сразу связывает CRM, телефонию, задачи и будущие автоматизации

### P1. Диспетчерские действия из schedule
- Создание job/lead из пустого time slot
- Inline assign/reassign technician/provider
- Быстрый перенос на другой слот
- Business hours / capacity / slot duration
- ETA / route-aware hints как минимум на базовом уровне

### P1. Recurring jobs
- Повторяющиеся job series
- Редактирование одного экземпляра или всей серии
- Массовое обновление будущих визитов

## 2. Finance: Estimates, Invoices, Collection

### P0. Полноценный модуль Estimates
- Отдельный список estimates со статусами и фильтрами
- Только lead/job-connected estimates
- Line items / totals / taxes / discounts / attachments
- Постоянный preview при просмотре estimate в системе
- PDF snapshot estimate
- Email = portal link + PDF attachment
- SMS = только ссылка на estimate
- Approval + signature
- Deposit request + recorded deposit payment
- Link/sync to job + copy to invoice

Почему высокий приоритет:
- сейчас у вас есть payments как downstream-отчётность, но нет документов, из которых в Workiz рождаются продажи, approvals и значительная часть автоматизаций

### P0. Полноценный модуль Invoices
- Invoice list/dashboard
- Standalone invoice и invoice-from-job
- Due / overdue / paid статусы
- PDF snapshot invoice
- Постоянный preview при просмотре invoice в системе
- `Add Payment` в invoice detail
- Частичные оплаты через linked payment records
- Bulk send
- Receipts
- Связь с jobs / clients / payments

### P0. Payment collection, а не только payment reporting
- Текущий `/payments` остаётся canonical ledger
- Recorded payments, связанные с estimate/invoice
- `Add Payment` из `Invoice` и запись deposit payment по `Estimate`
- Partial/full payment через linked payment records
- Стартовый payment type: `check`
- Receipts

Текущий scope intentionally ограничен:
- без card processing
- без saved cards
- без portal self-serve payments
- без provider webhooks

### P1. Price Book / items catalog
- Каталог items/services
- Категории
- Flat-rate и itemized pricing
- Использование items в estimates / invoices / jobs

### P1. Estimate/Invoice dashboard layer
- KPI widgets по статусам и суммам
- Просмотр кто создал документ
- Preview client-facing версии перед отправкой
- Bulk actions

### P1. Online/self-serve payment expansion
- Online payment links
- Portal self-serve invoice/deposit payments
- Saved payment methods
- Failed/succeeded payment attempts

### P2. POS-расширения
- Tap to pay / card reader support
- Financing integrations
- Disputes / payout reconciliation

Это не P0, потому что сначала нужен базовый finance-doc stack.

## 3. Client Self-Service & Intake

### P0. Client Portal
- Просмотр estimate/invoice
- Approve / sign
- История документов и платежей
- Outstanding balances / payment history
- Просмотр upcoming/past jobs
- Обновление contact details

Почему высокий приоритет:
- это один из самых больших gap'ов между текущим Blanc и зрелым field-service продуктом
- portal резко повышает value estimates, invoices, payments и automations одновременно

Текущий P0 scope intentionally ограничен:
- без self-serve оплаты из portal
- без cards on file management

### P1. Online Booking portal
- Публичная booking page
- Настройка внешнего вида
- Правила availability
- Required fields
- Booking preferences: auto-create vs approval queue
- Deposits / full prepayment
- Notifications о новых бронированиях

### P1. Lead intake automation
- Intake из website forms / booking / inbound email
- Email-to-lead parsing
- Source attribution
- Автосоздание lead/job по заданным правилам

## 4. Messaging, Phone, Communication Ops

### P1. Message Center 2.0
- Omnichannel inbox: SMS + email
- Job/lead creation прямо из thread
- Быстрое редактирование job из thread
- Right-pane messaging из других страниц
- Group/team messages
- Voicemail inbox с transcript + action buttons

Почему не P0:
- коммуникационное ядро у вас уже есть; главные дыры сейчас не в самом факте messaging, а в отсутствии schedule/finance/self-service

### P1. Phone ops for field workflows
- Call masking между tech и client
- История masked calls в job/client context
- Fallback forwarding / backup numbers
- Более зрелый queue/agent workflow для live operations

### P2. Call tracking & attribution
- Выделенные номера под ad sources
- Tracking jobs booked / conversion / revenue by source
- Связка с reporting

### P2. AI communication layer
- Smart suggested replies
- Context-aware compose/rewrite
- Structured extraction из calls/messages в lead/job fields
- AI answering / message taking / reschedule intents

## 5. Automations & Tasks

### P0. Общий automation engine
- Триггеры по jobs / leads / estimates / invoices / payments / schedule events
- Условия по статусу, source, tags, service area, timing
- Действия: send SMS/email, create task, notify team, update status, webhooks
- Очередь исполнения + журнал срабатываний

Почему высокий приоритет:
- без automation engine много ценности schedule, finance и client portal остаётся ручной
- у вас уже есть Action Required, quick messages и worker groundwork, поэтому архитектурно это достижимый следующий шаг

### P1. Готовые automation templates
- Appointment reminders
- Estimate follow-up
- Overdue invoice reminders
- Review requests
- Re-engagement/coupon campaigns
- Missed call follow-up

### P1. Task center
- Отдельный список задач вне Pulse thread-level task
- Assignee / due date / related entity
- Отображение задач в schedule
- SLA / overdue views

## 6. Reporting & Dashboards

### P1. Home dashboard
- Настраиваемые widgets
- Revenue / overdue / pipeline / calls / bookings / conversion
- Role-based visibility по dashboard и по отдельным widgets

### P1. Операционные отчёты
- Jobs report
- Leads report
- Calls report
- Payments report
- Estimates report
- Invoices report
- Activity / team performance report

### P2. Маркетинговая и конверсионная аналитика
- Ad source ROI
- Call tracking conversion
- Estimate-to-job conversion
- Job-to-payment conversion

## 7. Admin, Permissions, Integrations, Compliance

### Перенесено в P0 foundation
- `Roles & permissions` больше не планируются как отдельная `P1`-фича
- они входят в `P0`-инициативу по мультитенантной модели компании, суперадмину и RBAC-платформе

### P1. QuickBooks integration
- Initial sync
- Configurable sync directions
- Sync invoices / payments / clients / items
- Integration logs и error resolution UI

### P1. Security & compliance
- 2FA
- Audit trail по критичным действиям
- A2P 10DLC registration/status
- SMS compliance guardrails

### P2. Feature center / integration marketplace
- Управление add-ons
- Feature flags per company
- Каталог интеграций

## 8. Service Plans & Recurring Revenue

### P2. Service Plans
- Plan templates
- Client subscriptions
- Visits lifecycle
- Auto-generated future visits
- Плановое выставление invoice / auto-charge
- Статусы `pending / active / expires soon / expired`

Почему не выше:
- это сильный revenue layer, но он становится по-настоящему полезным только после запуска estimates/invoices/payments/client portal/schedule

## 9. Mobile / Field Experience

### P2. Mobile-first operator/field flows
- Управление jobs/schedule/messages/payments с телефона
- Лёгкие mobile views для tech workflow
- Быстрые действия: call, ETA, collect payment, update status

### P3. Native mobile parity
- Глубокая мобильная функциональность уровня отдельного полноценного приложения

Это не стоит делать раньше, чем стабилизирован web-product core.

## 10. Что сознательно НЕ стоит копировать в первую очередь

- Expense card / финансовые add-ons вокруг корпоративных расходов
- Сложные financing сценарии до запуска базовых estimates/invoices/payments
- Marketplace ради marketplace
- Multi-location / franchise toolkit, если это не текущий ICP
- Ограничения и странности шаблонов Workiz как есть

## Рекомендуемый порядок реализации

### Волна 0
- `P0` Multi-tenant company model + platform super admin + RBAC
- `P0` Pulse client timeline core + realtime governance

### Волна 1
- `P0` Schedule
- `P0` Estimates
- `P0` Invoices
- `P0` Payment collection (recorded payments only)
- `P0` Client Portal (lite)
- `P0` Automation engine

### Волна 2
- `P1` Online/self-serve payments
- `P1` Online booking
- `P1` Price Book
- `P1` Dashboard & reports
- `P1` Message Center 2.0
- `P1` QuickBooks

### Волна 3
- `P1`/`P2` recurring jobs
- `P2` Service Plans
- `P2` call tracking
- `P2` advanced AI answering/scheduling
- `P2` mobile field expansion

## Короткий вывод

Если цель — как можно быстрее догнать Workiz по воспринимаемой полноте продукта, то главный порядок такой:

1. сначала исправить foundation: `multi-tenant company model + platform super admin + RBAC`;
2. параллельно закрепить `Pulse` как canonical event timeline foundation;
3. потом закрыть `dispatch + finance docs + recorded payments + client portal + automations`;
4. затем добрать `online booking + self-serve payments + reporting + price book + integrations`;
5. только после этого идти в `service plans`, `call tracking`, `advanced AI`, `native mobile parity`.
