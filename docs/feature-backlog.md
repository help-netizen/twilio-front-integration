# Бэклог фич для догоняния функционала Workiz

## Контекст

Этот backlog составлен на основе:

- текущего продуктового scope в `docs/project-spec.md`
- фактически реализованных модулей и последних изменений в `docs/changelog.md`
- текущего пользовательского функционала в `docs/current_functionality.md`
- актуальных разделов справки Workiz (`help.workiz.com`) по состоянию на 2026-04-16

Это не попытка 1:1 скопировать Workiz. Приоритеты выставлены так, чтобы:

1. максимально быстро закрыть самые большие продуктовые дыры относительно рынка;
2. опереться на уже существующие модули Blanc;
3. не тратить ранний roadmap на слабые или периферийные части Workiz.

## Что уже есть как база

В проекте уже реализовано сильное ядро operator workspace:

- Pulse / SMS / call timeline / AI summary
- Softphone
- Contacts / Leads / Jobs
- Schedule route и календарный dispatch surface (`/schedule`) — уже в активной разработке
- Estimates / Invoices pages — уже в активной разработке
- Payments + Transactions pages с canonical payment transactions / receipts
- Portal backend/API foundation
- Messages page
- Company users / super admin / service territories / telephony admin
- Workflow editor / FSM builder для lead/job statuses
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

## Легенда статусов

- `✅` — реализовано как отдельный product slice
- `🔧` — частично реализовано / активно в разработке
- `📋` — ещё не начато или только на уровне требований

## Актуальный статус на 2026-04-16

| Эпик | Приоритет | Статус | Что есть сейчас |
|---|---|---:|---|
| Multi-tenant company model + super admin + RBAC | P0 | `🔧` | Базовый `companies + company_memberships`, `CompanyUsersPage`, `SuperAdminPage`; полноценный tenant-safe RBAC ещё не завершён |
| Pulse client timeline core + realtime governance | P0 | `🔧` | `Pulse` уже основной workspace: calls, SMS, voicemail, Action Required, snooze, tasks, AI summary/transcript; generalized event timeline ещё не доведён полностью |
| Schedule / Dispatcher workspace | P0 | `🔧` | Route `/schedule`, multiple views, active implementation and UX hardening |
| Schedule dispatch actions | P1 | `🔧` | Schedule активно дорабатывается; часть dispatch UX уже есть, часть ещё в rollout |
| Estimates | P0 | `🔧` | Route `/estimates`, lead/job financial tabs, ongoing MVP completion |
| Invoices | P0 | `🔧` | Route `/invoices`, invoice detail flow, ongoing MVP completion |
| Payment collection | P0 | `🔧` | `/payments`, `/transactions`, record payment dialog, receipts; полный MVP ещё не закрыт |
| Client Portal | P0 | `🔧` | Backend/API foundation реализованы, но full product surface ещё не доведён |
| AI communication layer | P0 | `🔧` | Уже есть AI summary, transcript, AI polish; richer AI-in-Pulse слой ещё не завершён |
| Price Book / items catalog | P1 | `📋` | Явного product slice пока нет |
| Estimate / Invoice dashboard layer | P1 | `📋` | Явного dashboard layer пока нет |
| Online / self-serve payment expansion | P1 | `🔧` | Есть backend/payment traces и portal payment foundation, но product-ready self-serve flow ещё не готов |
| Email in Pulse | P1 | `📋` | SMS есть, email thread model внутри `Pulse` пока не реализован |
| Dashboard & reports | P1 | `🔧` | Есть telephony operations dashboard, но общего business dashboard/reporting stack пока нет |
| QuickBooks integration | P1 | `📋` | В коде отдельный integration slice пока не найден |
| Automation engine | P2 | `🔧` | Есть `Action Required`, thread-level tasks, settings page и workers; общего rules engine пока нет |
| Automation templates | P2 | `🔧` | Есть special-case automations/settings, но не как unified template layer |
| Task center | P2 | `🔧` | Thread-level tasks уже есть, отдельного task center ещё нет |
| Phone ops for field workflows | P2 | `🔧` | Softphone и telephony stack уже есть, но field-specific phone ops backlog не закрыт |
| Call tracking & attribution | P2 | `📋` | Явного attribution slice пока нет |
| Voicemail workflow completion | P2 | `🔧` | Voicemail уже в `Pulse` timeline с transcript/audio; workflow hardening ещё впереди |
| Service Plans | P2 | `📋` | Отдельного product slice пока нет |
| Mobile-first field flows | P2 | `📋` | Специального mobile workflow слоя пока нет |
| Group/team messages | P3 | `📋` | Отдельной реализации пока нет |
| Online Booking portal | P3 | `📋` | Отдельной реализации пока нет |

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
- у вас уже есть leads/jobs и telephony, но нет сильного planning/dispatch surface для назначения, переноса и балансировки работы
- в отличие от Workiz, этот экран не должен становиться главным operator workspace: центральным event-centric пространством остаётся `Pulse`
- это связывает CRM, телефонию, задачи и будущие автоматизации, не создавая конкурирующий activity center

### P1. Диспетчерские действия из schedule
- Создание job/lead из пустого time slot
- Inline assign/reassign technician/provider
- Быстрый перенос на другой слот
- Business hours / capacity / slot duration
- ETA / route-aware hints как минимум на базовом уровне

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
- Job-connected и estimate-derived invoices
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

### P3. Online Booking portal
- Публичная booking page
- Настройка внешнего вида
- Правила availability
- Required fields
- Booking preferences: auto-create vs approval queue
- Deposits / full prepayment
- Notifications о новых бронированиях

Почему низкий приоритет:
- текущая продуктовая стратегия сейчас упирается не в публичный self-serve booking, а в foundation, dispatch, finance documents, payments и internal operations
- базовый `Client Portal` уже закрывает более срочный client-facing слой для документов и коммуникаций
- booking сильно зависит от зрелых `Schedule`, availability rules, role model, automations и payment expansion, поэтому его лучше двигать последней волной

## 4. Pulse: Messaging, Phone, Communication Ops

Принцип раздела:
- phone / SMS / voicemail продолжают жить в `Pulse`
- email v1 допускается как отдельный workspace, если нужен shared-mailbox UX в стиле Front с list/thread/composer поверх одного company mailbox
- новые communication surfaces должны переиспользовать общие tenant/auth/settings/search patterns и по возможности давать deep-link обратно в `Pulse`, Contacts, Leads, Jobs

### P1. Gmail shared mailbox + `/email` workspace
- Отдельный route `/email` с Front-like UX: mailbox rail, thread list, thread pane, composer
- Отдельная settings page для подключения и управления одним shared Gmail mailbox на компанию
- Базовый scope первой итерации: send / receive / thread / search / attachments
- Без personal mailbox, delegated access, comments, shared drafts, assignment, snooze/later/done
- `Pulse` и `/email` остаются отдельными operator surfaces, но могут связываться deep-links на contact / lead / job / pulse timeline

Почему это P1:
- у продукта уже есть phone/SMS-centric `Pulse`, но желаемый email UX здесь другой: shared mailbox, inbox/list/thread flow, ближе к Front
- в текущем коде уже есть полезные кирпичи (`company_settings`, authz, settings pages, messaging patterns, deep-link routes), поэтому отдельный `/email` можно строить без greenfield CRM-shell
- это позволяет закрыть email-коммуникацию быстро, не дожидаясь полной унификации всех communication channels внутри `Pulse`

### P2. Voicemail workflow completion
- Voicemail остаётся частью текущего `Pulse` timeline, а не отдельным inbox
- Доработка queue/filter/workflow поверх уже существующих voicemail items, transcript и action context
- Улучшение operator actions для voicemail follow-up без создания отдельного communication center

### P3. Group/team messages
- Group/team threads как отдельная низкоприоритетная инициатива
- Не смешивать с базовым client-thread model в `Pulse`

Почему messaging mostly не P0:
- коммуникационное ядро у вас уже есть; главные дыры сейчас не в самом факте messaging, а в отсутствии schedule/finance/self-service
- исключение: `AI communication layer`, если нужен как один из базовых product multipliers поверх уже существующего `Pulse`

### P2. Phone ops for field workflows
- Call masking между tech и client
- История masked calls в `Pulse` timeline и связанном job/client context
- Fallback forwarding / backup numbers
- Более зрелый queue/agent workflow для live operations внутри `Pulse`/realtime модели, а не в отдельном phone dashboard

### P2. Call tracking & attribution
- Выделенные номера под ad sources
- Tracking jobs booked / conversion / revenue by source
- Связка с reporting
- client-level call history и source context должны быть доступны из `Pulse`

### P0. AI communication layer
- Smart suggested replies внутри `Pulse`
- Context-aware compose/rewrite внутри `Pulse`
- Structured extraction из calls/messages в lead/job fields
- AI answering / message taking / reschedule intents с публикацией в `Pulse` timeline и queue state

## 5. Automations & Tasks

### P2. Общий automation engine
- Триггеры по jobs / leads / estimates / invoices / payments / schedule events
- Условия по статусу, source, tags, service area, timing
- Действия: send SMS/email, create task, notify team, update status, webhooks
- Очередь исполнения + журнал срабатываний

Почему пока не приоритет:
- текущий rollout должен сначала закрыть foundation, dispatch, finance-documents, payments и client-facing core flows
- у вас уже есть `Action Required`, thread-level tasks, quick messages и worker groundwork, поэтому базовый operational контур может жить без общего automation engine на первом этапе

### P2. Готовые automation templates
- Appointment reminders
- Estimate follow-up
- Overdue invoice reminders
- Review requests
- Re-engagement/coupon campaigns
- Missed call follow-up

### P2. Task center
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
- `Lead intake automation`, если intake уже обрабатывается внешним сервисом через API и не требует переноса внутрь FSM прямо сейчас
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
- `P0` AI communication layer

### Волна 2
- `P1` Online/self-serve payments
- `P1` Price Book
- `P1` Dashboard & reports
- `P1` Email in Pulse / omnichannel expansion
- `P1` QuickBooks

### Волна 3
- `P2` Service Plans
- `P2` Automation engine
- `P2` Automation templates
- `P2` Task center
- `P2` Phone ops for field workflows
- `P2` call tracking
- `P2` Voicemail workflow completion
- `P2` mobile field expansion

### Волна 4
- `P3` Group/team messages
- `P3` Online Booking portal

## Короткий вывод

Если цель — как можно быстрее догнать Workiz по воспринимаемой полноте продукта, то главный порядок такой:

1. сначала исправить foundation: `multi-tenant company model + platform super admin + RBAC`;
2. параллельно закрепить `Pulse` как canonical event timeline foundation;
3. потом закрыть `dispatch + finance docs + recorded payments + client portal + AI communication`;
4. затем добрать `self-serve payments + reporting + price book + email in Pulse + integrations`;
5. после этого идти в `service plans`, `automations + task center`, `phone ops`, `call tracking`, `voicemail hardening`, `mobile expansion`;
6. `group/team messages` и `online booking portal` оставить последней волной после стабилизации всех зависимых контуров.
