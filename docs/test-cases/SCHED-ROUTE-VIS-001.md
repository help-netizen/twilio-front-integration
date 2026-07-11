# Тест-кейсы: SCHED-ROUTE-VIS-001

Drive-time легсы без drag-действий: recalc-хуки (`createDirectJob`, `syncFromZenbooker` existing/create/delayed, `POST /:id/reschedule`) + lazy-on-read досев в `GET /api/schedule/route-segments` + "Customer, City" в classic-карточке Schedule и desktop-таблице Jobs.

**Sources:** spec `Docs/specs/SCHED-ROUTE-VIS-001.md` (PRIMARY; S-1..S-15, E-1..E-11, INV-1..INV-12, «Тестируемые утверждения» 1–14), requirements `Docs/requirements.md` § SCHED-ROUTE-VIS-001 (:4979), architecture `Docs/architecture.md` § SCHED-ROUTE-VIS-001 (:5717, binding — таблица «Файлы к изменению» + список «НЕ изменяются (защищено)»).

**Harness reality (pinned):**

- Backend jest ЕСТЬ. **Worktree-trap:** root `package.json` игнорит worktrees — из worktree запускать ТОЛЬКО:
  ```
  npx jest --testPathIgnorePatterns "/node_modules/" --roots "$(pwd)/tests" --testPathPatterns "schedRoute"
  ```
- **Новые файлы: `tests/schedRouteRecalcHooks.test.js` (секция A) и `tests/schedRouteLazySeed.test.js` (секция B).** Существующие `tests/schedRoute*.test.js` (Recalc/Backfill/Gaps/Integration), `scheduleRoute.test.js`, `scheduleProviderScope.test.js`, `scheduleReassign.test.js` — **НЕ редактировать** (drift-guard TC-RV-39).
- Стиль моков — как в `tests/schedRouteRecalc.test.js`: `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))` + `jest.mock` слоёв (`routeQueries`, `routeSegmentService`, `zenbookerService` по месту); сервис под тестом — реальный. Route-кейсы (`/reschedule`) — supertest над mini-app с мокнутым auth-middleware (стиль `tests/routes/tasks.test.js`). Google/fetch — всегда `global.fetch = jest.fn()`; ни один кейс не должен его коснуться.
- Фронт-раннера НЕТ: фронт = STATIC (grep) + BUILD (`npm run build` = tsc -b) + git-diff-пустота защищённых файлов.

### Покрытие

- Всего тест-кейсов: 40
- P0: 24 | P1: 12 | P2: 3 | P3: 1
- UNIT (backend jest): 33 | STATIC (grep/git-diff): 6 | BUILD (tsc): 1

Existing docs checked: тест-кейсов SCHED-ROUTE-001 в `Docs/test-cases/` нет (покрытие живёт прямо в `tests/schedRoute*.test.js`) — дублей нет; этот документ покрывает только дельту VIS-001 + drift-guards на защищённое.

---

## A. UNIT — `tests/schedRouteRecalcHooks.test.js` (НОВЫЙ) — хуки FR-1

Общие предусловия: мок `db.query`; `routeSegmentService` замокан (шпионим `recalcForJob`, `enqueueGeocode`); `jobsService` — реальный; `zenbookerService`/ZB-клиент мокается по веткам. Фикстура job: `{ id: 42, company_id: 'co-1', start_date: '2026-07-15T10:00:00Z', assigned_provider_user_ids: ['tech-A'], address: '1 Main St', lat: 42.1, lng: -71.2 }`.

### TC-RV-01: `createDirectJob` ZB-success → ровно один `recalcForJob({coordsChanged:true})`
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-1; утв. 1; INV-8
- **Фикстура:** ZB-мок успешен, `createJob` возвращает `localJob` (id 42) с датой+техником+coords.
- **Шаги:** вызвать `jobsService.createDirectJob(companyId, payload)`; дождаться resolve.
- **Ожидание:** `recalcForJob` вызван **toHaveBeenCalledTimes(1)** с `('co-1', 42, { coordsChanged: true })`; `beforeTechDays` НЕ передан (job новый); НЕТ второго вызова из недр `createJob`-upsert'а (INV-8 anti-double-fire).

### TC-RV-02: `createDirectJob` fallback-ветка (ZB недоступен) → тот же единственный recalc
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** E-5; утв. 1
- **Фикстура:** ZB-мок кидает/отключён → `createDirectJob` идёт локальным fallback (`jobsService.js:540-552`).
- **Ожидание:** job создан локально, `recalcForJob` вызван ровно 1 раз с id локально созданной job и `{coordsChanged:true}`; ответ вызывающему — успех.

### TC-RV-03: `createDirectJob` адрес без координат → дополнительно `enqueueGeocode`
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** S-3; утв. 1
- **Фикстура:** `localJob.address = '1 Main St'`, `lat/lng = null`.
- **Ожидание:** вызваны И `recalcForJob(…, {coordsChanged:true})`, И `enqueueGeocode('co-1', 42)`; оба fire-and-forget (`.catch` навешан — падение geocode не роняет create).

### TC-RV-04: `createDirectJob` с координатами → `enqueueGeocode` НЕ вызывается (негативный)
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** S-1/S-3 (граница)
- **Фикстура:** `lat/lng` заполнены.
- **Ожидание:** `enqueueGeocode` — `not.toHaveBeenCalled()`; recalc — 1 раз.

### TC-RV-05: `createDirectJob` без даты ИЛИ без техника → recalc вызван, но no-op на уровне сервиса
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** S-2, E-9; утв. 2
- **Фикстура/шаги:** (а) hook-уровень: `localJob.start_date = null` → `recalcForJob` всё равно вызван 1 раз; (б) service-уровень (реальный `routeSegmentService`, мок `routeQueries`): `getTechDaysForJob.mockResolvedValue([])` → `recalcForJob('co-1', 42, {coordsChanged:true})`.
- **Ожидание:** (б) `reconcileTechDay`-путь не исполняется: `insertSegment`/`markSegmentsStale` не вызваны, `route_calc`-задача не ставится (нет INSERT в tasks), ошибок нет, результат `{ techDays: 0 }`-подобный.

### TC-RV-06: падение `recalcForJob` НЕ ломает `createDirectJob` (негативный)
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** INV-7; «Обработка ошибок» п.1
- **Фикстура:** `recalcForJob.mockRejectedValue(new Error('boom'))`; шпион `console.error`.
- **Ожидание:** `createDirectJob` резолвится успешно (job возвращён), unhandled rejection нет, `console.error` вызван с сообщением ошибки.

### TC-RV-07: `syncFromZenbooker` existing — `beforeTechDays` захвачен ДО UPDATE
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-5; утв. 3
- **Фикстура:** existing job в БД (мок SELECT возвращает existing), ZB-payload меняет дату; `routeQueries.getTechDaysForJob.mockResolvedValue([{technicianId:'tech-A', scheduleDate:'2026-07-14'}])`.
- **Шаги:** вызвать `syncFromZenbooker`; проверить ПОРЯДОК вызовов (invocationCallOrder): capture (`getTechDaysForJob`) — раньше, чем `db.query` с `UPDATE jobs`.
- **Ожидание:** `recalcForJob` получает `{ beforeTechDays: [{technicianId:'tech-A', scheduleDate:'2026-07-14'}], coordsChanged: <по TC-RV-08..10> }` — т.е. vacated-день старого расписания попадает в реконсиляцию.

### TC-RV-08: `coordsChanged=true` ТОЛЬКО при реальной числовой дельте координат
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-5; утв. 3
- **Фикстура:** `existing.lat=42.1, lng=-71.2`; ZB присылает `lat=42.2, lng=-71.2`.
- **Ожидание:** `recalcForJob` вызван с `coordsChanged: true`. Контроль типов: existing из pg может быть строкой `'42.1'` — сравнение через `Number(...)` (дельта `'42.1'` vs `42.1` → false, см. TC-RV-09).

### TC-RV-09: ZB webhook-эхо без изменений → `coordsChanged=false` + идемпотентный no-op
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-6; утв. 3; INV-11
- **Фикстура:** payload байт-в-байт равен existing (включая `lat/lng` теми же числами, хоть строкой, хоть числом).
- **Ожидание:** (а) hook-уровень: `recalcForJob` вызван с `coordsChanged: false`; (б) service-уровень (реальный сервис, мок queries, desired == active как в `tests/schedRouteRecalc.test.js` «reconcile idempotency»): `markSegmentsStale` → 0, `insertSegment` не вызван, `route_calc` не enqueue'ится, Google (`global.fetch`) — 0 вызовов. Никакого DB-churn на самом частом пути.

### TC-RV-10: ZB прислал `lat=null`/`lng=null` (частичный payload) → `coordsChanged=false`
- **Приоритет:** P2 | **Тип:** UNIT — негативный
- **Маппинг:** E-11; утв. 3
- **Фикстура:** `cols.lat = null`, existing с валидными coords.
- **Ожидание:** условие `cols.lat != null && cols.lng != null` не выполнено → `coordsChanged: false`; выжившие пары не стейлятся.

### TC-RV-11: `syncFromZenbooker` create-ветка → recalc + geocode-условие
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-4; утв. 4
- **Фикстура:** job'а нет локально → create-ветка (`jobsService.js:1234-1236`).
- **Ожидание:** после `createJob` — `recalcForJob(companyId || job.company_id, job.id, { coordsChanged: true })`; при address-без-coords дополнительно `enqueueGeocode`; при наличии coords — geocode не вызван.

### TC-RV-12: delayed auto-assign re-fetch → recalc с `{}` (без `beforeTechDays`)
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** S-7; утв. 4
- **Фикстура:** `setImmediate`-блок re-fetch (`:1241`) получает от ZB доназначенных техников, UPDATE mirror (`:1250`); флашнуть setImmediate (`await new Promise(setImmediate)`).
- **Ожидание:** `recalcForJob(companyId || job.company_id, job.id, {})` вызван ПОСЛЕ UPDATE mirror'а; в opts НЕТ ключей `beforeTechDays`/`coordsChanged` (чистое добавление техников).

### TC-RV-13: capture `beforeTechDays` упал → `[]`, sync продолжается (негативный)
- **Приоритет:** P2 | **Тип:** UNIT
- **Маппинг:** паттерн `jobsService.js:1536-1540`; «Обработка ошибок»
- **Фикстура:** `getTechDaysForJob.mockRejectedValue(new Error('db'))` в existing-ветке.
- **Ожидание:** UPDATE проходит, `recalcForJob` вызван с `beforeTechDays: []`, sync резолвится без ошибки.

### TC-RV-14: `POST /api/jobs/:id/reschedule` — capture до ZB-assign-блока, recalc после UPDATE
- **Приоритет:** P0 | **Тип:** UNIT (supertest над mini-app, мок auth → companyId='co-1')
- **Маппинг:** S-8; утв. 5
- **Фикстура:** existing job (SELECT-мок `:637-640`); тело `{ start_date, tech_id: 'tech-B' }` (JOB-TECH-ASSIGN-001 REPLACES).
- **Шаги:** POST; проверить invocationCallOrder: `getTechDaysForJob` (capture) — ДО db-вызова, обновляющего `assigned_provider_user_ids` (ZB-assign-блок `:677-680`), и ДО `UPDATE start_date/end_date` (`:694-697`); recalc — после UPDATE.
- **Ожидание:** 200; `recalcForJob('co-1', jobId, { beforeTechDays: [старый tech-day] })` вызван 1 раз; `beforeTechDays` отражает СТАРОГО техника (иначе разрыв на vacated-дне не заделается — суть бага).

### TC-RV-15: reschedule — падение recalc не меняет HTTP-ответ (негативный)
- **Приоритет:** P0 | **Тип:** UNIT (supertest)
- **Маппинг:** E-8 (частично), INV-7; утв. 5
- **Фикстура:** `recalcForJob.mockRejectedValue(...)`.
- **Ожидание:** статус и body ответа байт-эквивалентны успешному кейсу TC-RV-14 (тот же `res.json`); `console.error` залогировал; процесс не падает.

### TC-RV-16: reschedule — `companyId` не разрешился → recalc пропущен (гвард)
- **Приоритет:** P1 | **Тип:** UNIT (supertest) — негативный
- **Маппинг:** E-8; утв. 5
- **Фикстура:** auth-мок отдаёт identity без `companyFilter`/companyId (как разрешается в этом роуте сегодня).
- **Ожидание:** `recalcForJob` — `not.toHaveBeenCalled()`; основной ответ роута не деградирует (тот же код, что до фичи).

### TC-RV-17: reschedule чужой job → 404 и НИКАКОГО recalc (изоляция данных)
- **Приоритет:** P1 | **Тип:** UNIT (supertest) — security
- **Маппинг:** INV-2 (scope); чек-лист agent-04 (прямой доступ по чужому ID)
- **Фикстура:** SELECT job по id внутри company-scoped запроса → rows: [] (job принадлежит company B, вызывает company A).
- **Ожидание:** существующий 404-путь роута срабатывает (не 200), `getTechDaysForJob` и `recalcForJob` НЕ вызваны — хук стоит после company-scoped чтения job.

---

## B. UNIT — `tests/schedRouteLazySeed.test.js` (НОВЫЙ) — FR-2 lazy-досев + city-маппер

Общие предусловия: мок `db.query` для SQL-shape кейсов (`routeQueries` реальный); для `seedMissingForRange`/`getRouteSegments` — реальный `routeSegmentService`/`scheduleService` с мокнутыми `routeQueries`. `global.fetch = jest.fn()` — assert 0 вызовов во ВСЕХ кейсах секции (INV-1 в каждом тесте бесплатно).

### TC-RV-18: `getMissingTechDaysInRange` — SQL-shape: company-scoped, правила участия, OR-pending, cap
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-9, S-12, S-14, E-1; утв. 6; INV-2
- **Шаги:** вызвать `routeQueries.getMissingTechDaysInRange('co-1', { from:'2026-07-01', to:'2026-07-07' }, 'America/New_York', 10)` с мокнутым `db.query`; захватить SQL+params.
- **Ожидание:** SQL параметризован (все значения через `$n`, ни одной интерполяции from/to/tz/companyId); содержит: `company_id = $1`-скоуп; `jsonb_array_elements_text(assigned_provider_user_ids)`; правила участия как в `getParticipatingJobsForTechDay` (`start_date IS NOT NULL`, `blanc_status <> ALL` с EXCLUDED_STATUSES, company-tz день); `COUNT(*) >= 2`; предикат «(нет активного сегмента) OR (есть активный `status='pending'`)»; `ORDER BY schedule_date`; `LIMIT` с cap-параметром. Params включают `'co-1'`, from, to, cap.

### TC-RV-19: `getMissingTechDaysInRange` — опциональный `technicianId`
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** S-10; утв. 6; INV-3
- **Шаги:** два вызова — с `technicianId:'tech-A'` и без.
- **Ожидание:** с фильтром — SQL содержит предикат по technician_id и `'tech-A'` в params; без — предиката и параметра нет; остальной SQL идентичен (сравнить строки за вычетом предиката).

### TC-RV-20: `enqueueRouteCalcDeduped` — дедуп-INSERT только по `queued`
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-11, E-7; утв. 7
- **Шаги:** вызвать `('co-1','tech-A','2026-07-03')`; захватить SQL+params.
- **Ожидание:** SQL = `INSERT INTO tasks ... SELECT ... WHERE NOT EXISTS (...)`; NOT EXISTS-подзапрос содержит `company_id = $1`, `kind='agent'`, `agent_type='route_calc'`, `agent_status = 'queued'` (и НЕ содержит `'running'` в гварде), `agent_input->>'technician_id' = $2`, `agent_input->>'schedule_date' = $3`; params = `['co-1','tech-A','2026-07-03']` (+ поля insert'а). Существующий plain `enqueueRouteCalc` не тронут (см. TC-RV-33).

### TC-RV-21: deduped — поведение при существующей queued / running / отсутствии задачи
- **Приоритет:** P2 | **Тип:** UNIT
- **Маппинг:** S-11, E-7; утв. 7
- **Фикстура:** мок `db.query` → `rowCount: 0` (queued существует, NOT EXISTS отсёк) и `rowCount: 1` (нет queued — running/completed/пусто).
- **Ожидание:** оба варианта резолвятся без throw; при `rowCount:0` дубль не создан — вызов no-op; лишняя задача рядом с running допустима by-design (гвард только queued) — зафиксировать комментарием в тесте, НЕ проверять обратное.

### TC-RV-22: `seedMissingForRange` — guard пустых from/to
- **Приоритет:** P0 | **Тип:** UNIT — негативный
- **Маппинг:** E-6; утв. 8
- **Шаги:** вызвать с `{ from: null, to: '2026-07-07' }`, `{ from: '2026-07-01', to: undefined }`, `{}`.
- **Ожидание:** немедленный return; `db.query`, `getCompanyTimezone`, `getMissingTechDaysInRange`, `reconcileTechDay` — 0 вызовов.

### TC-RV-23: `seedMissingForRange` — ≤cap реконсиляций, cap прокинут в детекцию
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-13; утв. 8
- **Фикстура:** `getMissingTechDaysInRange` мок → ровно 10 кандидатов (cap по умолчанию), отсортированных по schedule_date; `reconcileTechDay` мок → `{ enqueuedCalc: true }`.
- **Ожидание:** `getMissingTechDaysInRange` вызвана с cap=10; `reconcileTechDay` вызван ровно 10 раз — по одному на кандидата, с `('co-1', td.technicianId, td.scheduleDate, { tz })`; кастомный `{ cap: 3 }` → детекция с 3. (Продвижение хвоста — свойство детекции: реконсилированные выпадают, следующий вызов возьмёт следующие — покрыто предикатом TC-RV-18, отдельного стейтфул-теста не нужно.)

### TC-RV-24: `seedMissingForRange` — самолечение зависшего pending через deduped-путь
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-14; утв. 8
- **Фикстура:** один кандидат; `reconcileTechDay` → `{ enqueuedCalc: false }` (desired == active, новых pending не создано); `getCalculableSegments` → `[{ id: 7 }]`.
- **Ожидание:** `enqueueRouteCalcDeduped('co-1','tech-A','2026-07-03')` вызван ровно 1 раз — зависший pending уходит в очередь без ручного вмешательства.

### TC-RV-25: seed — deduped НЕ вызывается, когда не нужен (негативные ветки)
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** S-11, S-12; утв. 8
- **Фикстура:** (а) `reconcileTechDay` → `{ enqueuedCalc: true }` (сам поставил задачу); (б) `enqueuedCalc:false` И `getCalculableSegments` → `[]` (считать нечего — например, пара без координат, E-1).
- **Ожидание:** в обоих случаях `enqueueRouteCalcDeduped` — `not.toHaveBeenCalled()`; двойной постановки задач нет.

### TC-RV-26: seed — ошибки non-fatal (негативный)
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** «Обработка ошибок» п.2; утв. 8
- **Фикстура:** (а) `getMissingTechDaysInRange` кидает; (б) `reconcileTechDay` кидает на первом из 3 кандидатов.
- **Ожидание:** `seedMissingForRange` НЕ пробрасывает throw (try/catch внутри), лог `[Schedule] lazy route seed failed (non-fatal)` (или эквивалент по коду); unhandled rejection нет.

### TC-RV-27: `getRouteSegments` — ответ не ждёт seed; seed уходит в `setImmediate` с параметрами диапазона
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-9; утв. 9; INV-3 (время ответа)
- **Фикстура:** реальный `scheduleService.getRouteSegments`; мок `getSegmentsForRange` → фикстура сегментов; шпион `seedMissingForRange` (никогда не резолвящийся promise — доказательство, что ответ его не ждёт).
- **Шаги:** `const res = await getRouteSegments(...)` — резолвится СРАЗУ; на этот момент `seedMissingForRange` ещё `not.toHaveBeenCalled()` (синхронной части нет); затем `await new Promise(setImmediate)`.
- **Ожидание:** после флаша — `seedMissingForRange('co-1', { from, to, technicianId: <techFilter> })` вызван ровно 1 раз; `res` уже был возвращён с тем, что лежало в БД (пусто или частично).

### TC-RV-28: provider assigned_only → досев ТОЛЬКО своего техника (изоляция)
- **Приоритет:** P0 | **Тип:** UNIT — security
- **Маппинг:** S-10; утв. 9; INV-3; чек-лист agent-04 (изоляция данных)
- **Фикстура:** identity provider с `job_visibility=assigned_only`, `crm_users.id='tech-P'` — так, как `getRouteSegments` строит `techFilter` сегодня (PF007).
- **Ожидание:** `seedMissingForRange` получает `technicianId: 'tech-P'` (не null, не запрошенный query-параметром чужой id); соответственно детекция (TC-RV-19) не вернёт и не реконсилирует чужие tech-day пары, и чтение провайдера не ставит задачи на чужих техников.

### TC-RV-29: падение seed не затрагивает уже отправленный ответ (негативный)
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** «Обработка ошибок» п.2; утв. 9
- **Фикстура:** `seedMissingForRange.mockRejectedValue(...)`; шпион `console.error`.
- **Ожидание:** `getRouteSegments` резолвится нормально ДО ошибки; после флаша setImmediate — `.catch` сработал, `console.error` вызван, unhandled rejection нет.

### TC-RV-30: контракт ответа `getRouteSegments` — до/после идентичен (drift-guard)
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** утв. 9; INV-3; HTTP-контракт спеки
- **Фикстура:** та же фикстура сегментов, что в существующем покрытии SCHED-ROUTE-001.
- **Ожидание:** возвращаемая структура `{ segments: [...] }` глубоко равна (`toEqual`) пину формата SCHED-ROUTE-001 — те же поля сегмента, никаких новых полей/обёрток; side-effect досева в ответе невидим.

### TC-RV-31: `rowToScheduleItem` — `city` для job/lead из row, `null` для task; `subtitle` не изменён
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** S-15; утв. 10; INV-10
- **Фикстура:** три row-фикстуры: job (`city:'Boston'`, `customer_name:'Ann'`), lead (`city:'Newton'`), task (`city:null` — SQL для tasks селектит NULL).
- **Ожидание:** item job → `city:'Boston'`, lead → `'Newton'`, task → `null`; row без city (`undefined`/`''`) → `city: null` (норм-форма `row.city || null`); во ВСЕХ случаях `subtitle` остаётся ровно прежним значением (`customer_name` / как было) — API-композиции "Customer, City" на бэке НЕТ.

### TC-RV-40: детекция считает только jobs (leads/tasks не участвуют)
- **Приоритет:** P3 | **Тип:** UNIT
- **Маппинг:** E-2; утв. 6
- **Шаги:** в захваченном SQL TC-RV-18 assert: `FROM jobs` (единственный источник строк кандидатов), НЕТ упоминаний `leads`/`tasks` в FROM/JOIN детекции (кроме NOT EXISTS по tasks в deduped — это ДРУГАЯ функция).
- **Ожидание:** лид/задача между двумя джобами не влияет на `COUNT(*) >= 2` и не рвёт пару A→B.

---

## C. STATIC / BUILD — инварианты и фронт

Выполняются из корня worktree; «пусто» = exit code grep 1 / пустой diff.

### TC-RV-32 (ПЕРЕОПРЕДЕЛЁН оркестратором Wave 1): `getSeedTechDays`/`getCompaniesWithTimezone` СОХРАНЕНЫ — их использует scripts/backfill-route-segments.js
- **Приоритет:** P0 | **Тип:** STATIC
- **Маппинг:** INV-9; утв. 11
- **Шаги:** `grep -rn "getSeedTechDays\|getCompaniesWithTimezone" backend/src scripts/ tests/` — функции определены+экспортированы в routeQueries.js; вызывающие только scripts/backfill-route-segments.js и tests/schedRouteBackfill.test.js; плюс jest schedRouteBackfill зелёный
- **Ожидание:** 0 совпадений во всей кодовой базе (ни определения, ни ссылок, ни полуживых импортов).

### TC-RV-33: защищённые recalc-вызовы и файлы — байт-в-байт
- **Приоритет:** P0 | **Тип:** STATIC
- **Маппинг:** INV-4; утв. 11
- **Шаги:**
  1. `git diff master -- backend/src/services/agentHandlers.js backend/src/services/routeDistanceService.js backend/src/db/scheduleQueries.js backend/src/routes/schedule.js backend/src/server.js` → **пусто** (список «НЕ изменяются» architecture.md).
  2. Существующие call-sites живы и не переписаны: grep-подтверждение вызовов recalc в `scheduleService.js` (drag-пути, бывшие `:486,501` — `recalcAfterJobChange`/`triggerJobRouteSideEffects`), `jobsService.js` `updateJobLocation`-хук (бывший `:1570`), `agentHandlers.js` recalc после геокода (`:78`).
  3. `git diff master -- backend/src/db/migrations/` → пусто (INV-6, NO new migrations); grep пермишен-каталога на новые permissions → пусто.
- **Ожидание:** всё перечисленное без диффа; plain `enqueueRouteCalc` в `routeSegmentService.js` присутствует в прежнем виде (deduped — ДОБАВЛЕН рядом, не заменил).

### TC-RV-34: Google отсутствует в HTTP-цикле
- **Приоритет:** P0 | **Тип:** STATIC
- **Маппинг:** INV-1
- **Шаги:** `grep -n "routeDistanceService\|googleapis\|distancematrix\|computePair" backend/src/services/scheduleService.js backend/src/routes/schedule.js backend/src/db/routeQueries.js backend/src/routes/jobs.js`
- **Ожидание:** 0 совпадений — новый seed-путь и хуки DB-only + enqueue; `computePair`/Distance Matrix упоминаются только в `agentHandlers.js`/`routeDistanceService.js` (воркер). Дополняется рантайм-гвардом `global.fetch` в каждом кейсе секций A/B.

### TC-RV-35: фронт-защищённые файлы — git-diff пуст
- **Приоритет:** P0 | **Тип:** STATIC
- **Маппинг:** INV-5; утв. 14
- **Шаги:** `git diff master --stat -- "frontend/src/components/jobs/JobMobileCard*" frontend/src/services/scheduleApi.ts` → пусто; в `ScheduleItemCard.tsx` diff НЕ касается agenda-ветки: `grep -n "nameCity" frontend/src/components/schedule/ScheduleItemCard.tsx` — строка построения `[customer_name, city]` в agenda без изменений (сверить с master: `git diff master -- .../ScheduleItemCard.tsx` содержит хунки только в classic-ветке).
- **Ожидание:** мобильная карточка и тип-файл побайтово нетронуты; agenda-ветка заработает от появления `city` сама.

### TC-RV-36: classic-ветка `ScheduleItemCard` — композиция "Customer, City" через `filter(Boolean)`
- **Приоритет:** P1 | **Тип:** STATIC
- **Маппинг:** S-15, E-3, E-4; утв. 12
- **Шаги:** grep classic-subtitle-абзаца (бывший `:283-286`) на паттерн `[item.subtitle, item.city].filter(Boolean).join(', ')`.
- **Ожидание:** композиция ровно такая: job с городом → "Customer, City"; без города → "Customer" без хвоста-запятой (гарантия `filter(Boolean)` — ревью паттерна, отдельного рантайма нет); lead → "Name, City" (гварда по `entity_type` НЕТ — grep-подтвердить отсутствие условия); task (`subtitle:''`, `city:null`) → рендер пустого как раньше.

### TC-RV-37: таблица Jobs — ячейка Customer = "Customer, City", fallback и phone нетронуты
- **Приоритет:** P1 | **Тип:** STATIC
- **Маппинг:** S-15, E-3; утв. 13
- **Шаги:** grep `frontend/src/components/jobs/jobHelpers.tsx` (STATIC_COLUMNS, колонка `customer_name`) на `[j.customer_name, j.city].filter(Boolean).join(', ') || '—'`; diff колонки не задевает phone-подстроку.
- **Ожидание:** одна строка "Ann, Boston"; без города — "Ann"; пусто-пусто — `'—'`; phone-рендер байт-в-байт прежний.

### TC-RV-38: `npm run build` (tsc -b) green
- **Приоритет:** P0 | **Тип:** BUILD
- **Маппинг:** INV-12
- **Шаги:** `cd frontend && npm run build` (помнить: прод-Docker строже — noUnusedLocals).
- **Ожидание:** exit 0, ноль TS-ошибок (тип `ScheduleItem.city` уже объявлен — новых типов не требуется).

### TC-RV-39: регрессия — существующие сьюты зелёные БЕЗ правок
- **Приоритет:** P0 | **Тип:** UNIT (regression run)
- **Маппинг:** INV-4, INV-12; harness-контракт этого документа
- **Шаги:** `npx jest --testPathIgnorePatterns "/node_modules/" --roots "$(pwd)/tests" --testPathPatterns "schedRoute|scheduleRoute|scheduleProviderScope|scheduleReassign|scheduleServiceReschedule"`; плюс `git diff master -- tests/schedRouteRecalc.test.js tests/schedRouteBackfill.test.js tests/schedRouteGaps.test.js tests/schedRouteIntegration.test.js` → пусто.
- **Ожидание:** все существующие тесты SCHED-ROUTE-001 и schedule-сьюты проходят без единой правки их файлов; новые файлы (`schedRouteRecalcHooks`, `schedRouteLazySeed`) добавляются рядом и не мутируют общие моки/фикстуры чужих файлов.

---

## Матрица покрытия (спека → TC)

| Спека | TC |
|---|---|
| S-1 | 01, 04 |
| S-2 / E-9 | 05 |
| S-3 | 03 |
| S-4 | 11 |
| S-5 | 07, 08 |
| S-6 / INV-11 | 09 |
| S-7 | 12 |
| S-8 | 14, 15, 16 |
| S-9 | 18, 27, 30 |
| S-10 / INV-3 | 19, 28 |
| S-11 / E-7 | 20, 21, 25 |
| S-12 | 18 (COUNT>=2), 25 |
| S-13 | 23 |
| S-14 | 18 (OR-pending), 24 |
| S-15 / E-3 / E-4 | 31, 36, 37 |
| E-1 | 18, 25(б) |
| E-2 | 40 |
| E-5 | 02 |
| E-6 | 22 |
| E-8 | 15, 16 |
| E-11 | 10 |
| INV-1 | 34 + fetch-guard A/B |
| INV-2 | 17, 18, 20 |
| INV-4 / INV-9 | 32, 33, 39 |
| INV-5 | 35 |
| INV-6 | 33(3) |
| INV-7 | 06, 15, 26, 29 |
| INV-8 | 01 |
| INV-10 | 31 |
| INV-12 | 38, 39 |
| Утверждения 1–14 | все замаплены выше (1→01-06, 2→05, 3→07-10, 4→11-12, 5→14-17, 6→18-19+40, 7→20-21, 8→22-26, 9→27-30, 10→31, 11→32-34, 12→36, 13→37, 14→35) |
