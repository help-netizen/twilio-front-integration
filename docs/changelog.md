# Changelog — Blanc Contact Center

> История изменений проекта. Обновляется оркестратором после завершения каждой итерации.

---

## 2026-03-27

### Backlog reprioritization: automations and tasks moved to P2
- По продуктовой правке раздел `Automations & Tasks` переведён из раннего приоритета в `P2`.
- Обновлены артефакты:
  - `docs/feature-backlog.md`
  - `docs/specs/PF000-p0-core-business-suite.md`
  - `docs/specs/PF100-p0-sprint-plan.md`
  - `docs/specs/PF006-automation-engine.md`
  - `docs/specs/PF006-technical-design.md`
  - `docs/specs/PF101-p0-db-api-contracts.md`
- Что зафиксировано:
  - `Automation engine`, `automation templates` и `task center` больше не входят в первую волну roadmap;
  - текущий P0 rollout исключает `PF006` и фокусируется на foundation, schedule, finance docs, payment collection, client portal и AI communication;
  - `PF006` сохранён как deferred package со статусом `P2`, а не удалён из документации.
- Код не менялся; итерация только про требования и handoff-артефакты.

### Pulse ownership clarified for messaging and phone ops
- По продуктовой правке `Messaging / Phone / Communication Ops` явно зафиксированы как часть `Pulse` и client timelines внутри `Pulse`.
- Обновлены артефакты:
  - `docs/feature-backlog.md`
  - `docs/requirements.md`
  - `docs/specs/PF008-pulse-client-timeline-core.md`
  - `docs/specs/PF000-p0-core-business-suite.md`
- Что именно закреплено:
  - communication backlog теперь описан как `Pulse: Messaging, Phone, Communication Ops`;
  - email, voicemail workflow, phone ops, call tracking и AI communication должны развиваться внутри `Pulse`, а не отдельными рабочими пространствами;
  - любые новые communication/phone flows обязаны описывать, как они живут в `Pulse` timeline, queue-state и realtime semantics.
- Код не менялся; итерация только про требования и handoff-артефакты.

### Backlog reprioritization: AI up to P0, phone ops down to P2
- По продуктовой правке `AI communication layer` переведён в `P0`, а `Phone ops for field workflows` перенесён в `P2`.
- Обновлён `docs/feature-backlog.md`:
  - `AI communication layer` теперь входит в раннюю P0-реализацию;
  - `Phone ops for field workflows` вынесен из `P1` в более позднюю волну;
  - синхронизированы wave ordering и итоговый summary roadmap;
  - уточнена формулировка, что messaging mostly не `P0`, кроме AI-слоя как отдельного product multiplier.
- Код не менялся; итерация только про требования и handoff-артефакты.

### Messaging backlog cleanup: Pulse-first communication scope
- По продуктовой правке messaging/backlog синхронизирован с текущей реализацией `Pulse`.
- Обновлён `docs/feature-backlog.md`:
  - распилен размытый `Message Center 2.0` на отдельные инициативы;
  - удалены уже существующие или ненужные backlog-пункты: `job/lead creation from thread`, `quick job editing from thread`, `right-pane messaging from other pages`;
  - главным communication gap зафиксирован `email in Pulse / omnichannel expansion`;
  - `group/team messages` вынесены в отдельную low-priority задачу;
  - `voicemail` переведён в формат partial-gap: не greenfield inbox, а workflow completion поверх уже существующего timeline support.
- Обновлены supporting docs:
  - `docs/requirements.md`
  - `docs/current_functionality.md`
  - `docs/specs/PF008-pulse-client-timeline-core.md`
  - `docs/specs/PF104-pulse-sprint-plan.md`
- В project docs дополнительно зафиксировано, что:
  - `Pulse` уже содержит `CreateLeadJobWizard` для создания лида/работы из thread context;
  - voicemail уже отображается в текущем timeline и использует recording/transcript pipeline;
  - следующий communication gap — email внутри текущего `Pulse` thread model, а не новый parallel message center.
- Код не менялся; итерация только про требования и handoff-артефакты.

### Backlog cleanup: lead intake automation excluded from current roadmap
- По продуктовой правке `Lead intake automation` убран из актуального backlog.
- Основание: intake уже обрабатывается внешним сервисом, который создаёт `Lead / Job` через API, поэтому перенос этого контура внутрь FSM сейчас не нужен.
- Обновлён `docs/feature-backlog.md`: удалена отдельная backlog-секция и добавлена пометка в список направлений, которые сознательно не нужно догонять прямо сейчас.
- Код не менялся; итерация только про требования и handoff-артефакты.

### Backlog reprioritization: online booking moved to lowest priority
- По продуктовой правке `Online Booking portal` переведён в самый низкий приоритет roadmap.
- Обновлён `docs/feature-backlog.md`:
  - секция `Online Booking portal` переведена из `P1` в `P3`;
  - добавлено обоснование низкого приоритета;
  - `Online Booking` убран из `Wave 2` и перенесён в отдельную последнюю волну;
  - итоговый summary переписан так, чтобы booking шёл после foundation, finance, payments, reporting и service-plan/AI/mobile направлений.
- Код не менялся; итерация только про требования и handoff-артефакты.

### Backlog cleanup: recurring jobs removed
- По продуктовой правке `Recurring jobs` удалены из актуального backlog как ненужная инициатива.
- Обновлены артефакты:
  - `docs/feature-backlog.md`
  - `docs/specs/PF001-unified-schedule-dispatcher.md`
  - `docs/specs/PF000-p0-core-business-suite.md`
- В `PF001` recurring jobs больше не описываются как отдельный следующий пакет; зафиксировано только, что они вне scope текущего schedule package.
- Код не менялся; итерация только про требования и handoff-артефакты.

### Backlog / PF001 / PF100 / PF000: Pulse-first operator model alignment
- Актуализирован `docs/feature-backlog.md` с учётом продуктовой позиции:
  - `Pulse` зафиксирован как центральный event-centric operator workspace;
  - `Schedule / Dispatcher` уточнён как сильный dispatch/planning surface, но не как новый главный activity center;
  - backlog синхронизирован с текущей `Pulse-first` моделью продукта.
- Обновлены спецификации:
  - `docs/specs/PF001-unified-schedule-dispatcher.md`
  - `docs/specs/PF001-technical-design.md`
  - `docs/specs/PF000-p0-core-business-suite.md`
  - `docs/specs/PF100-p0-sprint-plan.md`
- В `PF001` и `PF001-technical-design` добавлены требования, что client-significant dispatch events публикуются в `Pulse` timeline по правилам `PF008`.
- В `PF000` зафиксировано, что `Pulse` остаётся главным operator workspace, а `Schedule` не должен становиться конкурирующим activity center.
- В `PF100` синхронизированы sprint assumptions:
  - `Schedule` описан как planning/dispatch layer поверх `Pulse-first` foundation;
  - удалены устаревшие допущения про `standalone invoice`, `portal pay`, `online checkout links` и webhook-based collection из текущего P0;
  - `Client Portal` и `Payment Collection` приведены к текущему P0 scope.
- Код не менялся; итерация только про требования и handoff-артефакты.

## 2026-03-24

### PF008: Pulse client timeline core package
- Добавлен отдельный пакет спецификаций по `Pulse` как ядру коммуникации и клиентского event history.
- Добавлены артефакты:
  - `docs/specs/PF008-pulse-client-timeline-core.md`
  - `docs/specs/PF008-technical-design.md`
  - `docs/specs/PF104-pulse-sprint-plan.md`
  - `docs/specs/PF105-pulse-db-api-contracts.md`
- В `docs/requirements.md` уточнено, что `Pulse` является canonical client timeline и основным operator workspace по клиенту.
- PF008 уточнён по продуктовой позиции:
  - `Action Required / Snooze / Tasks` остаются отдельными controls вне timeline;
  - активные controls дублируются в left queue и middle-card/navigation area при просмотре клиента;
  - их lifecycle может дополнительно отображаться в timeline как события;
  - SSE machine документируется вместе с Pulse как cross-cutting delivery layer;
  - пакет `PF008` объявлен evergreen foundation: новые клиентские фичи обязаны описывать Pulse/SSE integration.
- Код не менялся; итерация только про требования и handoff-артефакты.

### PF002/PF003: Estimate-job-invoice relationship model clarification
- Скорректирована product logic для финансовых документов:
  - неверная линейная цепочка `Lead -> Estimate -> Approval/Deposit -> Convert/Sync to Job -> Invoice` удалена;
  - зафиксированы два связанных, но независимых флоу: `Lead -> Convert/Sync to Job -> Job` и `Estimate -> Approval/Deposit -> Invoice`;
  - финансовые документы теперь описаны как сущности, которые могут одновременно хранить `lead_id` и `job_id`, сохраняя sales и work context.
- Дополнительно уточнено:
  - `standalone estimate` исключён из требований;
  - у estimate теперь обязателен `lead_id` или `job_id` на момент создания.
- Обновлены артефакты:
  - `docs/specs/PF002-estimates.md`
  - `docs/specs/PF002-technical-design.md`
  - `docs/specs/PF003-invoices.md`
  - `docs/specs/PF003-technical-design.md`
  - `docs/specs/PF101-p0-db-api-contracts.md`
- Добавлены explicit semantics для `link-job` и `sync-to-job` вокруг estimates.
- В `PF002` дополнительно зафиксирован document-delivery rule:
  - estimate обязан иметь сохраняемый PDF snapshot;
  - email отправляется с PDF attachment;
  - SMS отправляется только со ссылкой на estimate в системе.
- Preview estimate дополнительно закреплён как постоянная часть internal estimate view, а не только send-flow.
- В `PF002` добавлен explicit checklist состава и printable-quality требований для estimate PDF, с reference на пример `estimate+Kenny+Ducoste.pdf`.
- В `PF003` синхронизирована аналогичная document logic для invoices:
  - invoice обязан иметь сохраняемый PDF snapshot;
  - email отправляется с PDF attachment;
  - SMS отправляется только со ссылкой на invoice в системе;
  - preview доступен как постоянная часть internal invoice view;
  - добавлен checklist состава и printable-quality требований для invoice PDF.
- Payment model дополнительно упрощена и связана с текущим ledger:
  - риск `invoice and payments becoming two disconnected finance models` снят на уровне требований;
  - `/payments` остаётся canonical ledger и получает linked payments по estimate/invoice;
  - для текущего P0 зафиксирован recorded-payment flow через `Add Payment`;
  - стартовый payment type: `check`;
  - card processing, saved cards, portal self-serve payments и provider webhooks вынесены за пределы текущего P0.
- Код не менялся; итерация только про требования и handoff-артефакты.

### PF007: Tenancy / RBAC foundation package
- Зафиксирован новый наивысший продуктовый приоритет: `multi-tenant company model + platform super admin + RBAC`.
- Добавлены артефакты:
  - `docs/specs/PF007-multitenant-company-model-rbac.md`
  - `docs/specs/PF007-technical-design.md`
  - `docs/specs/PF102-tenancy-rbac-sprint-plan.md`
  - `docs/specs/PF103-tenancy-rbac-db-api-contracts.md`
- PF007 уточнён по новой продуктовой позиции:
  - без `custom roles`
  - с фиксированными системными ролями
  - с tenant-admin editable permission matrix для каждой роли
  - с granular permission toggles в профиле сотрудника по модели, близкой к Zenbooker
  - роль `Field Tech` переименована в `Provider` для согласования с текущим продуктовым словарём
- Обновлены `docs/requirements.md` и `docs/feature-backlog.md` под новую foundation-инициативу.
- Код не менялся; итерация только про требования и handoff-артефакты.

### RF004: Shared lead-form settings
- Создан `useLeadFormSettings` React Query hook (`hooks/useLeadFormSettings.ts`) — единый source для `/api/settings/lead-form` с 5-мин кэшированием.
- Мигрированы 11 consumers (JobMetadataSection, LeadsFilters, LeadDetailSections, EditLeadDialog, CreateLeadDialog, useConvertToJob, CreateLeadJobWizard, useJobsData, useQuickMessages, LeadsPage, JobsFilters).
- Устранены 4 дубликата `CustomFieldDef` и 11 fetch+parse patterns.
- Lint: 414 problems (−5 от baseline 419).
- Артефакт: `Docs/specs/RF004-shared-lead-form-settings.md`.

### RF005: Backend communication slices
- Определены 8 communication slices: Pulse, Calls, Messaging, Contacts, Leads, Jobs/Zenbooker, Settings/Admin, Auth/Users.
- Задокументированы boundary violations: ~18 route файлов обращаются к `db.query()` напрямую.
- Описана целевая архитектура Route→Service→{feature}Queries→db/connection.
- `queries.js` (1107 LOC) определён как monolith для decomposition в RF006.
- Артефакт: `Docs/specs/RF005-backend-communication-slices.md`.

### RF006: Query layer decomposition
- Декомпозирован `queries.js` (1108 LOC) → 4 feature модуля + thin facade:
  - `callsQueries.js` — calls, recordings, transcripts, call events, media
  - `contactsQueries.js` — contact CRUD, phone lookup, unread state
  - `timelinesQueries.js` — timelines, action required, tasks, thread management
  - `webhookSyncQueries.js` — webhook inbox, sync state, health
- `queries.js` становится re-export facade (82 LOC) — все 12 consumers работают без изменений.
- Верифицировано: `node -e require()` → 40 functions exported, export surface полностью совпадает.

### RF007: Phone helper consolidation
- Canonical source: `utils/phoneUtils.ts::formatPhoneDisplay()` — расширена сигнатура для `null|undefined`.
- Мигрированы 8 consumers с `lib/formatPhone` (4) и `formatters::formatPhoneNumber` (4).
- `lib/formatPhone.ts` — dead code (0 consumers).
- Audio players (2 компонента) — оставлены раздельно, разный UX контекст.
- Артефакт: `Docs/specs/RF007-phone-helper-consolidation.md`.

### RF008: Telephony admin isolation audit
- Проверены 17 telephony admin pages — все используют canonical `authedFetch`.
- No raw `fetch()` обнаружено. Изменения не требуются.
- Артефакт: `Docs/specs/RF008-telephony-admin-isolation.md`.

### RF009: Worker lifecycle design plan
- Mapped 3 workers: `inboxWorker` (polling), `snoozeScheduler` (setInterval), `reconcileStale` (manual).
- Design plan: separate `worker.js` entrypoint + graceful shutdown + Fly.io `[processes]` split.
- Код не изменён — design plan only для будущей phase.
- Артефакт: `Docs/specs/RF009-worker-lifecycle-design.md`.

### RF003: Frontend transport consolidation
- Зафиксирован `authedFetch` (`services/apiClient.ts`) как canonical frontend transport layer.
- Мигрирован `SuperAdminPage.tsx` с raw `fetch()` на `authedFetch()` — устранены 5 вызовов raw fetch с ручным `Authorization` header.
- Документирована transport policy: новый код → `authedFetch`, запрещены новые `axios.create()` и raw `fetch`.
- Артефакт: `Docs/specs/RF003-frontend-transport.md`.

### RF002: Quality baseline
- Зафиксирован воспроизводимый quality baseline: Jest (5/8 suites failed, 18/102 tests), build (passes, 2 warnings), lint (419 problems: 392 errors, 27 warnings).
- Классифицированы все падающие Jest suites по root cause (keycloakAuth: устаревший контракт, twilioWebhooks: отсутствие signature, inboxWorker: изменённые exports, stateMachine: не экспортирован shouldFreeze, paymentsRoute: расхождение моков).
- Классифицированы lint errors по 10 правилам: `no-explicit-any` (177), `react-hooks/refs` (155), `react-refresh/only-export-components` (32) — top 3.
- Артефакт: `Docs/specs/RF002-quality-baseline.md`.

### Refactor-readiness audit
- Проведён аудит проекта для подготовки к поэтапному рефакторингу.
- Зафиксирована фактическая структура runtime: `src/` как runtime shell/legacy layer, `backend/src/` как основной backend, `frontend/src/` как основной frontend.
- Обновлены `docs/requirements.md`, `docs/architecture.md`, `docs/project-spec.md`, `docs/tasks.md`.
- Добавлена спецификация `docs/specs/refactor-readiness-audit.md`.
- Добавлены тест-кейсы `docs/test-cases/refactor-readiness-audit.md`.
- Добавлен аудит `docs/refactor-readiness-audit.md` с baseline по тестам, сборке и lint.

## 2026-03-23

### Настройка системы агентов
- Создана система из 9 агентов + оркестратор в `Docs/agents/`
- Инициализированы базовые документы: requirements.md, architecture.md, tasks.md, changelog.md, project-spec.md
- Адаптированы инструкции агентов под стек проекта (Express, React/TS, PostgreSQL, Twilio/Front/Zenbooker)
