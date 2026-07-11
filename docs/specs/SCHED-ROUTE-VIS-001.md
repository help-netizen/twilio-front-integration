---
id: SCHED-ROUTE-VIS-001
title: Drive-time легсы без drag-действий (recalc-хуки + lazy-on-read досев) + "Customer, City" в Schedule/Jobs
status: final_for_implementation
priority: P1
created_at: "2026-07-11"
language: ru
owner: product_engineering
related_specs:
  - SCHED-ROUTE-001-route-scheduling
requirements: "Docs/requirements.md § SCHED-ROUTE-VIS-001"
architecture: "Docs/architecture.md § SCHED-ROUTE-VIS-001 (binding)"
constraints:
  - NO new migrations (таблицы миграций 119/120 уже существуют)
  - NO permission changes (route-segments остаётся за schedule.view)
  - NO Google-вызовов в HTTP-цикле (только agentWorker, cache-first)
  - Cron/one-shot бэкфилл отвергнут владельцем — не реализовывать
---

# SCHED-ROUTE-VIS-001 — Спецификация поведения

## Общее описание

SCHED-ROUTE-001 считает drive-time легсы только на drag-путях расписания, `updateJobLocation` и геокоде — создание job с датой+техником (человеком и ZB-sync), смена техника/даты из карточки Job пересчёт не запускают, бэкфилла нет → легсов почти не видно. Фича добавляет: (1) best-effort хуки `recalcForJob` на все недостающие мутации; (2) lazy-on-read self-healing досев недостающих tech-day пар при чтении `GET /api/schedule/route-segments`; (3) маппинг `city` в ScheduleItem + формат "Customer, City" в classic-карточке расписания и desktop-таблице Jobs. Единственный механизм пересчёта — существующий `routeSegmentService.recalcForJob`; вычисление — существующий `route_calc`-хендлер agentWorker (cache-first `route_calculation_cache`, Google Distance Matrix только на miss). Хендлеры, `routeDistanceService`, drag-пути и контракт route-segments не меняются.

Все хуки — fire-and-forget по паттерну `jobsService.js:1570`: `recalcForJob(...).catch(e => console.error(..., e.message))`, non-fatal для основного пути. `beforeTechDays` — по паттерну `jobsService.js:1536-1540` (try/catch → `[]`).

---

## Сценарии поведения

### S-1. Человек создаёт job с датой и техником (`createDirectJob`)

- **Предусловия:** диспетчер создаёт job из карточки/формы (НЕ из Schedule-слота); заполнены `start_date` и техник(и); адрес с координатами.
- **Шаги:**
  1. `jobsService.createDirectJob` (`jobsService.js:404`) разрешает `localJob` — через ZB-success (`createJob:524`) ИЛИ локальный fallback (`:540-552`).
  2. В ЕДИНОЙ точке после разрешения `localJob` в обеих ветках (рядом с eventBus-emit, ~`:577`) вызывается `recalcForJob(companyId, localJob.id, { coordsChanged: true }).catch(...)`.
  3. `recalcForJob` реконсилирует tech-day пары нового джоба: создаёт pending-сегменты вокруг него, стейлит разорванные, enqueue'ит `route_calc`.
  4. Воркер вычисляет пары cache-first; сегменты → `success`.
- **Ожидаемый результат:** при следующем открытии Schedule легсы вокруг новой job видны без единого drag'а.
- **Побочные эффекты:** запись в `schedule_route_segments`, задача `route_calc` в `tasks`. `beforeTechDays` НЕ передаётся — job новый, vacated-дней нет.
- **Guard:** путь create-from-slot (`createManualJob`) уже покрыт `scheduleService.triggerJobRouteSideEffects:482` — второй хук туда НЕ ставится.

### S-2. Человек создаёт job без даты ИЛИ без техника

- **Шаги:** те же, хук всё равно вызывается.
- **Ожидаемый результат:** `recalcForJob` — дешёвый идемпотентный no-op (job не участвует в маршрутизации: нет `start_date` или нет техника → нет tech-day пар). Ошибок нет, сегменты не создаются, задачи не ставятся.

### S-3. Человек создаёт job с адресом без координат

- **Шаги:**
  1. Хук S-1 отрабатывает (пары без координат получат статус из `pairInitialStatus` — см. E-1).
  2. Дополнительно, если у `localJob` есть `address`, но нет `lat`/`lng` — `enqueueGeocode(companyId, localJob.id).catch(...)`.
  3. Геокод-хендлер (`agentHandlers.js`, job_geocode) после успеха сам вызывает recalc (`agentHandlers.js:78`, существующее поведение) → сегменты пересчитываются уже с координатами.
- **Ожидаемый результат:** после успешного геокода легсы появляются автоматически; до него — `missing_address`/`address_needs_review`.

### S-4. ZB-sync создаёт новую job (`syncFromZenbooker`, create-ветка)

- **Предусловия:** webhook/`POST /api/jobs/sync`/background re-fetch приносит job, которой нет локально.
- **Шаги:**
  1. `syncFromZenbooker` (`jobsService.js:1124`) идёт по create-ветке (`:1234-1236`), вызывает `createJob`.
  2. После `createJob` — `recalcForJob(companyId || job.company_id, job.id, { coordsChanged: true }).catch(...)`; плюс `enqueueGeocode`, если address без coords (как S-3).
- **Ожидаемый результат:** ZB-джобы с датой+техником получают легсы наравне с человеческими.

### S-5. ZB-sync обновляет существующую job (реальное изменение)

- **Предусловия:** ZB прислал изменение даты/техников/координат существующей job.
- **Шаги:**
  1. Existing-ветка (`:1145`): capture `beforeTechDays` ДО `UPDATE :1181` (try/catch → `[]`).
  2. После UPDATE — `recalcForJob(effectiveCompanyId, existing.id, { beforeTechDays, coordsChanged })`.
  3. `coordsChanged` — ТОЛЬКО при реальной дельте: `cols.lat != null && cols.lng != null && (Number(cols.lat) !== Number(existing.lat) || Number(cols.lng) !== Number(existing.lng))`.
- **Ожидаемый результат:** перенос даты/техника из ZB чинит и старый (vacated из `beforeTechDays`), и новый tech-day.

### S-6. ZB webhook-эхо без изменений (самый частый путь)

- **Предусловия:** webhook приносит те же данные, что уже в БД.
- **Ожидаемый результат:** `coordsChanged=false` (дельты координат нет); `recalcForJob` — идемпотентный no-op (desired == active): выжившие пары НЕ стейлятся и НЕ пересоздаются, DB-churn отсутствует, новых `route_calc`-задач нет, Google не трогается.

### S-7. Delayed auto-assign re-fetch (`setImmediate`-блок `syncFromZenbooker`)

- **Предусловия:** ZB присвоил техников с задержкой; re-fetch-блок (`:1241`) обновляет mirror (`UPDATE :1250`).
- **Шаги:** после UPDATE mirror'а — `recalcForJob(companyId || job.company_id, job.id, {}).catch(...)`.
- **Ожидаемый результат:** легсы появляются, когда ZB доназначил техника. `beforeTechDays` не нужен — чистое добавление техников, vacated-дней нет.

### S-8. Смена даты и/или техника из карточки Job (`POST /api/jobs/:id/reschedule`)

- **Предусловия:** пользователь в карточке Job меняет дату (`start_date`) и/или техника (`tech_id`; JOB-TECH-ASSIGN-001: REPLACES, `tech_id=null` = unassign). Верифицировано: карточный reassign идёт ИМЕННО этим роутом (`JobInfoSections.tsx:96-112`), НЕ через `scheduleService.reassignItem` (тот — drag-путь, уже хукнут) — отдельного хука на `reassignItem`-карточный путь не требуется.
- **Шаги:**
  1. `routes/jobs.js:616`: сразу после чтения текущего джоба (`:637-640`, ДО ZB-assign-блока `:659`, который меняет `assigned_provider_user_ids` на `:677-680`) — capture `beforeTechDays`.
  2. После локального `UPDATE start_date/end_date` (`:694-697`), рядом с `res.json` — `recalcForJob(companyId, jobId, { beforeTechDays }).catch(...)` с гвардом `if (companyId)`.
  3. Фоновый ZB re-sync (`:706`, ~3 сек) дёрнет `syncFromZenbooker` → второй recalc через хук S-5/S-6 — идемпотентен, допустим.
- **Ожидаемый результат:** и старый tech-day (разрыв заделан), и новый (легсы вокруг job) актуальны; HTTP-ответ recalc не ждёт.

### S-9. Диспетчер открывает диапазон без сегментов (lazy-досев)

- **Предусловия:** в диапазоне `[from,to]` есть tech-day пары с ≥2 назначенными работами и без активных сегментов (например, старая неделя, никогда не считавшаяся).
- **Шаги:**
  1. `GET /api/schedule/route-segments?from&to[&technician_id]` → `scheduleService.getRouteSegments` (`scheduleService.js:512`) читает `getSegmentsForRange` и СРАЗУ возвращает то, что есть (пусто или частично).
  2. Перед `return` — `setImmediate(() => seedMissingForRange(companyId, { from, to, technicianId: techFilter }).catch(...))` — fire-and-forget, ответ ничего не ждёт.
  3. В фоне: `getMissingTechDaysInRange` (1 SQL) находит кандидатов (см. Контракты) → для каждого (≤cap=10) `reconcileTechDay(companyId, techId, date, { tz })` создаёт pending-строки и сам enqueue'ит `route_calc`; если `!r.enqueuedCalc` и `getCalculableSegments(...).length > 0` → `enqueueRouteCalcDeduped(...)`.
  4. Воркер считает pending cache-first.
- **Ожидаемый результат:** первый ответ — без легсов (фронт показывает "Calculating route" для pending при следующем refetch); следующее чтение/refetch возвращает `success`-сегменты. Никакого крона; Google — 0 в HTTP-пути, и только на cache-miss в воркере.

### S-10. Техник-provider (assigned_only) читает route-segments

- **Предусловия:** пользователь-provider с `job_visibility=assigned_only`.
- **Шаги:** `techFilter` в `getRouteSegments` уже суживает до собственного `crm_users.id` (PF007) — этот же `techFilter` передаётся в `seedMissingForRange` как `technicianId`.
- **Ожидаемый результат:** provider видит и досевает ТОЛЬКО свои tech-day пары; чужие пары его чтение не реконсилирует и в очередь не ставит.

### S-11. Повторное чтение того же диапазона (дедуп)

- **Предусловия:** диапазон уже читался; часть пар реконсилирована (pending/success/missing_address/…), возможно есть queued-задача.
- **Ожидаемый результат:**
  - Tech-day с активными НЕ-pending сегментами (включая `missing_address`/`address_needs_review`) выпадает из детекции `getMissingTechDaysInRange` — не пере-churn'ится.
  - Tech-day с активным `pending` попадает в детекцию (self-heal зависших), но `enqueueRouteCalcDeduped` НЕ вставляет дубль при существующей задаче `agent_status='queued'` с тем же (company_id, technician_id, schedule_date).
  - Google на закэшированных парах не вызывается (cache hit в воркере).
- Дубль рядом с `running`-задачей ДОПУСТИМ (закрывает гонку «воркер уже прочитал сегменты»); лишняя задача — no-op (`getCalculableSegments` пусто).

### S-12. Tech-day с одной джобой

- **Ожидаемый результат:** не кандидат досева (`COUNT(*) >= 2` в детекции) — легсов между «ничем» не бывает; реконсиляция не вызывается, задач нет. (Если у пары РАНЬШЕ было 2 джоба и одна ушла — разрыв чинят event-хуки через `beforeTechDays`, не lazy-досев.)

### S-13. Переполнение cap (в диапазоне >10 недостающих tech-day пар)

- **Ожидаемый результат:** за одно чтение реконсилируются первые `cap=10` по `ORDER BY schedule_date`; остальные самолечатся на последующих чтениях (реконсилированные выпадают из детекции → каждое чтение продвигает хвост). Время ответа HTTP не зависит от числа кандидатов (всё в `setImmediate`).

### S-14. Самолечение зависшего pending

- **Предусловия:** у tech-day есть активные `pending`-сегменты, но задача потерялась/упала (queued-задачи нет).
- **Шаги:** детекция ловит пару по OR-ветке «есть активный pending»; `reconcileTechDay` не создаёт новых pending (desired == active) → `r.enqueuedCalc=false` → `getCalculableSegments(...).length > 0` → `enqueueRouteCalcDeduped` ставит задачу.
- **Ожидаемый результат:** зависший pending досчитывается без ручного вмешательства.

### S-15. "Customer, City" в UI

- **Шаги:**
  1. Backend: `rowToScheduleItem` (`scheduleService.js:29-63`) добавляет `city: row.city || null` (SQL уже селектит: `scheduleQueries.js:118` `j.city`, `:173` `l.city`, `:236` `NULL` для tasks). `subtitle` НЕ меняется (остаётся `customer_name`) — композиция на фронте.
  2. Classic-layout `ScheduleItemCard.tsx`: в classic-ветке subtitle-абзац (`:283-286`) рендерит `[item.subtitle, item.city].filter(Boolean).join(', ')`.
  3. Agenda-ветка (`:86`, `nameCity`) НЕ трогается — уже строит `[customer_name, city].join(', ')`, заработает от появления поля.
  4. Desktop-таблица Jobs `jobHelpers.tsx`, колонка `customer_name` (`STATIC_COLUMNS`, `:140-144`): `{j.customer_name || '—'}` → `{[j.customer_name, j.city].filter(Boolean).join(', ') || '—'}`; phone-подстрока без изменений. Данные уже в API (`listJobs = SELECT j.*`), тип есть (`LocalJob.city`, `jobsApi.ts:41`).
- **Ожидаемый результат:** диспетчер (classic + таблица) и техник (agenda) видят "Customer, City"; job без города — только имя.

---

## Контракты

### HTTP (существующие, структурно НЕ меняются)

- **`GET /api/schedule/route-segments?from=YYYY-MM-DD&to=YYYY-MM-DD[&technician_id]`** — auth + `requirePermission('schedule.view')` (`routes/schedule.js:136`), company_id из `req.companyFilter`. Формат ответа `{ segments: [...] }` байт-в-байт как в SCHED-ROUTE-001. Единственное изменение поведения — фоновый side-effect досева (невидим в ответе). Время ответа не деградирует.
- **`GET /api/schedule` (items)** — schedule item получает НОВОЕ поле `city: string | null` (jobs/leads — из БД, tasks — всегда `null`). `subtitle` без изменений. Тип `ScheduleItem.city?: string|null` уже объявлен (`scheduleApi.ts:21`) — фронт-контракт обратно совместим.
- **`GET /api/jobs` (list)** — не меняется (`SELECT j.*` уже отдаёт `city`).

### Внутренние (новые)

- **`routeQueries.getMissingTechDaysInRange(companyId, { from, to, technicianId }, tz, cap)`** → `[{ technicianId, scheduleDate }]`. Одна SQL-выборка: distinct (technician_id, company-local day) из `jobs` × `jsonb_array_elements_text(assigned_provider_user_ids)`, правила участия как в `getParticipatingJobsForTechDay` (`start_date IS NOT NULL`, `blanc_status <> ALL(EXCLUDED_STATUSES)`, день в company tz), `COUNT(*) >= 2`, день ∈ `[from,to]`, и: **(нет ни одного активного сегмента) OR (есть активный `status='pending'`)**. Опциональный `technicianId`. `ORDER BY schedule_date LIMIT cap`. Company_id-scoped, параметризовано. `getSeedTechDays`/`getCompaniesWithTimezone` — СОХРАНИТЬ (используются scripts/backfill-route-segments.js; поправка оркестратора Wave 1).
- **`routeSegmentService.enqueueRouteCalcDeduped(companyId, technicianId, scheduleDate)`** — `INSERT INTO tasks ... SELECT ... WHERE NOT EXISTS (... kind='agent' AND agent_type='route_calc' AND agent_status='queued' AND agent_input->>'technician_id'=$2 AND agent_input->>'schedule_date'=$3 AND company_id=$1)`. Гвард ТОЛЬКО по `'queued'` (не `'running'`). Существующий plain `enqueueRouteCalc` НЕ меняется.
- **`routeSegmentService.seedMissingForRange(companyId, { from, to, technicianId }, { cap = 10 })`** — guard `if (!from || !to) return`; `tz = getCompanyTimezone`; для каждого кандидата — `reconcileTechDay(...)`; при `!r.enqueuedCalc && getCalculableSegments(...).length > 0` → `enqueueRouteCalcDeduped`. Весь метод в try/catch, лог non-fatal.

### Файлы к изменению — как в architecture.md (таблица «Файлы к изменению»), без дополнений.

---

## Граничные случаи

- **E-1. Нет координат у job(ов) пары** → `reconcileTechDay`/`recalcForJob` создают сегмент со статусом из `pairInitialStatus`: `missing_address` (адреса/координат нет) или `address_needs_review` (geocoding needs_review без usable coords). Google НЕ вызывается; такие сегменты — активные не-pending → пара выпадает из lazy-детекции (не пере-churn'ится каждым чтением). UI показывает существующие лейблы SCHED-ROUTE-001.
- **E-2. Leads/tasks в расписании** → в маршрутизации участвуют ТОЛЬКО jobs (правила `getParticipatingJobsForTechDay`); лид/task между двумя джобами не рвёт пару A→B. Lazy-детекция считает только jobs.
- **E-3. Пустой `city`** → везде рендер ТОЛЬКО имени: `filter(Boolean)` гарантирует отсутствие хвоста-запятой, никаких "—" вместо города. Пустые `customer_name` И `city` в таблице Jobs → существующий fallback `'—'`.
- **E-4. Лид в classic-карточке** → тоже станет "Name, City" (принято владельцем, консистентно с agenda) — гварда по `entity_type` НЕТ. Task: `city=NULL`, `subtitle=''` → рендер classic-ветки не меняется (пустое → не рендерится как раньше).
- **E-5. `createDirectJob` fallback-ветка (ZB недоступен)** → хук стоит ПОСЛЕ разрешения `localJob` в обеих ветках — локально созданная job получает recalc наравне с ZB-success.
- **E-6. `from`/`to` отсутствуют при вызове `seedMissingForRange`** → guard, немедленный return, ничего не реконсилируется.
- **E-7. Гонка: два параллельных чтения одного диапазона / running-воркер** → максимум одна лишняя `route_calc`-задача (dedup гвардит только `queued`); лишняя задача — no-op (`getCalculableSegments` пусто). Бесконечного размножения нет: реконсилированный tech-day выпадает из детекции.
- **E-8. `companyId` не разрешился в `/reschedule`** → гвард `if (companyId)`: recalc пропускается, основной ответ не страдает.
- **E-9. Job с датой без техника / с техником без даты** → не участвует (нет tech-day пар) → все хуки no-op, детекция не находит.
- **E-10. Мульти-выбор техников на фронте** → легсы допустимо не показывать (текущее поведение `routeByPair`, AC-6) — не регрессия и не чинится этой фичей.
- **E-11. ZB прислал координаты `null`** (частичный payload) → `coordsChanged=false` (условие требует `cols.lat != null && cols.lng != null`) — выжившие пары не стейлятся.

---

## Обработка ошибок

- **recalcForJob/enqueueGeocode упал (любой хук)** → `.catch` + `console.error`, основной путь (создание job, sync, reschedule-ответ) НЕ ломается; HTTP-ответ уже ушёл или уходит без ошибки. Никаких toast'ов — деградация тихая, сегменты появятся при следующем событии/чтении (self-heal).
- **`seedMissingForRange` упал** (SQL/reconcile) → try/catch внутри + `.catch` на `setImmediate`-вызове; лог `[Schedule] lazy route seed failed (non-fatal)`; ответ route-segments не затронут (уже отправлен).
- **`route_calc`-воркер упал / Google error/rate-limit** → существующее поведение SCHED-ROUTE-001: сегмент → `status='failed'`, UI — "Route unavailable"; lazy-детекция failed-пары не пере-реконсилирует (активный не-pending). `NO_KEY` → fail-soft как раньше.
- **Геокод упал** → существующее поведение job_geocode-хендлера; сегменты остаются `missing_address`/`address_needs_review`.

---

## Инварианты

- **INV-1.** Никакой Google-вызов (Distance Matrix / Geocoding) НИКОГДА не происходит в HTTP-цикле — только в agentWorker, и только на cache-miss `route_calculation_cache` (cache-first семантика `routeDistanceService` не меняется).
- **INV-2.** Весь новый SQL — параметризован и company_id-scoped (`req.companyFilter` → сервисы); детекция, dedup-INSERT, реконсиляции — всё с `company_id=$1`.
- **INV-3.** Контракт, пермишен (`schedule.view`) и время ответа `GET /api/schedule/route-segments` не меняются; provider scope (assigned_only → свой `crm_users.id`) распространяется и на досев через `techFilter`.
- **INV-4.** `recalcForJob` — единственный механизм пересчёта; существующие вызовы SCHED-ROUTE-001 (`scheduleService.js:486,501`; `jobsService.js:1570`; `agentHandlers.js:78`) байт-в-байт нетронуты; `agentHandlers` route_calc/job_geocode, `routeDistanceService`, `scheduleQueries.js`, `routes/schedule.js`, agentWorker/task-lifecycle — НЕ изменяются.
- **INV-5.** `JobMobileCard*` — побайтово не изменён; agenda-ветка `ScheduleItemCard` (`nameCity`) — не изменена; `scheduleApi.ts` — не изменён (тип уже есть).
- **INV-6.** НИКАКИХ новых миграций; никаких изменений `server.js`/пермишенов.
- **INV-7.** Все новые хуки — best-effort: их падение не меняет код ответа и не откатывает транзакцию основного пути.
- **INV-8.** Хук НЕ ставится внутрь `createJob`-upsert'а (double-fire с S-1/S-4 и невозможность `beforeTechDays` на conflict-update) и НЕ дублируется для create-from-slot (уже покрыт `triggerJobRouteSideEffects`).
- **INV-9 (переопределён).** `routeQueries.getSeedTechDays` и `getCompaniesWithTimezone` сохранены байт-в-байт — их использует scripts/backfill-route-segments.js (tests/schedRouteBackfill.test.js зелёный).
- **INV-10.** API-`subtitle` schedule items не меняется (разделяемый контракт — читает и слот-логика); `city` — отдельное поле, композиция "Customer, City" только на фронте.
- **INV-11.** Идемпотентность: повторный `recalcForJob` без изменений состояния (webhook-эхо, double-recalc reschedule+ZB-sync) не стейлит/не пересоздаёт выжившие пары и не плодит задачи; повторный досев того же диапазона не создаёт дублей queued-задач.
- **INV-12.** `npm run build` (tsc -b) green; backend jest green.

---

## Тестируемые утверждения (для Test Cases Agent)

Backend (jest, `tests/schedRouteRecalc.test.js` + новый `tests/schedRouteLazySeed.test.js`):

1. `createDirectJob` (ZB-success И fallback-ветки) → ровно один вызов `recalcForJob` с `{coordsChanged:true}`; address-без-coords → дополнительно `enqueueGeocode` (S-1, S-3, E-5).
2. `createDirectJob` без даты/техника → recalc вызван, сегментов и задач нет (S-2).
3. `syncFromZenbooker` existing: `beforeTechDays` захвачен ДО UPDATE; `coordsChanged=true` только при реальной числовой дельте координат, `false` при эхе и при `null`-координатах (S-5, S-6, E-11).
4. `syncFromZenbooker` create + delayed auto-assign → recalc в обеих точках; delayed — без `beforeTechDays` (S-4, S-7).
5. `POST /:id/reschedule`: `beforeTechDays` захвачен до ZB-assign-блока; recalc после UPDATE; падение recalc не меняет ответ; `companyId`-гвард (S-8, E-8, INV-7).
6. `getMissingTechDaysInRange`: находит пару без сегментов при ≥2 участвующих джобах; НЕ находит при 1 джобе / вне диапазона / чужой company / активных не-pending (включая missing_address/failed); НАХОДИТ при активном pending; уважает `technicianId` и `cap`+`ORDER BY schedule_date` (S-9–S-14, E-1).
7. `enqueueRouteCalcDeduped`: не вставляет при существующей queued-задаче той же пары; вставляет при running/completed/отсутствии (S-11, E-7).
8. `seedMissingForRange`: guard от пустых from/to; ≤cap реконсиляций; зависший pending → enqueue через deduped-путь; ошибки non-fatal (S-13, S-14, E-6).
9. `getRouteSegments`: ответ идентичен до/после (структура), seed уходит в `setImmediate` с `techFilter`; provider assigned_only → досев только своего техника (S-9, S-10, INV-3).
10. `rowToScheduleItem`: `city` для job/lead из row, `null` для task; `subtitle` не изменён (S-15, INV-10).
11. Grep-инварианты: `getSeedTechDays`/`getCompaniesWithTimezone` определены в routeQueries.js (потребитель — scripts/backfill-route-segments.js); вызовы `scheduleService.js:486,501`/`jobsService.js:1570`/`agentHandlers.js:78` без диффа (INV-4, INV-9).

Frontend (tsc + точечная проверка):

12. Classic-карточка: job с городом → "Customer, City"; без города → "Customer" без запятой; lead → "Name, City"; task → рендер без изменений (S-15, E-3, E-4).
13. Таблица Jobs: ячейка Customer = "Customer, City" одной строкой; без города — имя; пусто-пусто — "—"; phone-подстрока без изменений (S-15, E-3).
14. `JobMobileCard*` и agenda-ветка `ScheduleItemCard` — git-diff пуст (INV-5).
