# Тест-кейсы: TECH-DAYOFF-001

Day-off периоды техников: CRUD `/api/schedule/time-off` (миграция 167, company-wide материализация в K записей), A′ post-filter в seam `slotEngineService.getRecommendations` (pre-shaping + headroom +5 + post-filter + slice/re-rank), серые блоки в расписании, warning-only модалки.

**Sources:** spec `Docs/specs/TECH-DAYOFF-001.md` (PRIMARY; S-1..S-13, E-1..E-15, INV-1..INV-13, «Тестируемые утверждения» T-1..T-15), requirements `Docs/requirements.md` § TECH-DAYOFF-001 (:5814), architecture `Docs/architecture.md` § TECH-DAYOFF-001 (:6247, binding).

**Harness reality (pinned):**

- Backend jest ЕСТЬ. **Worktree-trap:** из worktree запускать ТОЛЬКО:
  ```
  npx jest --testPathIgnorePatterns "/node_modules/" --roots "$(pwd)/tests" --testPathPatterns "timeOff|slotEngineDayOff"
  ```
- **Новые файлы:**
  - `tests/timeOffRoutes.test.js` — секция A (CRUD + RBAC + provider scope). CRUD-сервис и роут тестируются В ОДНОМ файле через supertest mini-app — это фактический стиль фичи (прецедент `tests/slotEngineProxy.test.js`: сервис + роут в одном сьюте; отдельный `timeOffService.test.js` НЕ создаём, чтобы не плодить второй мок-каркас на тот же слой).
  - `tests/slotEngineDayOffFilter.test.js` — секция B (seam A′ post-filter).
  - `tests/timeOffMigration.test.js` — секция C (psql-less shape-тест миграции 167: grep/regex-ассерты по содержимому SQL-файлов через `fs.readFileSync`).
- **Стиль моков — как `tests/slotEngineProxy.test.js`:** `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))`; `zenbookerClient.getTeamMembers` мокается; `slotEngineSettingsService.resolve` мокается (DEFAULTS), `buildConfigOverride` — реальный; движок = `global.fetch = jest.fn()`; роуты = supertest над mini-app с fake-auth middleware (`req.user = { sub:'kc', crmUser:{ id:'user-1' } }`, `req.companyFilter = { company_id: COMPANY }`, `req.authz = { permissions:[...] }`) + `app.use('/api/schedule', scheduleRouter)`. Новый `timeOffQueries` в seam-тестах мокается напрямую (`jest.mock('../backend/src/db/timeOffQueries')`); в CRUD-тестах — реальный поверх мокнутого `db.query`.
- **Существующие `tests/scheduleRoute.test.js`, `scheduleProviderScope.test.js`, `slotEngineProxy.test.js`, `slotEngineSettings.test.js`, `slotEngineHeldLeads.test.js`, `recommendSlots.test.js`, `scheduleTimezone.test.js`, `scheduleReassign.test.js` — НЕ редактировать** (drift-guard TC-DO-37).
- Slot-engine контейнер: собственные тесты `slot-engine/test` — НЕ трогать и НЕ запускать как критерий (INV-1: git diff по `slot-engine/` пуст — TC-DO-30).
- Фронт-раннера НЕТ: фронт = STATIC (grep) + BUILD (`npm run build` = tsc -b) + git-diff-пустота защищённых файлов + короткий MANUAL-смоук (T-15).

### Покрытие

- Всего тест-кейсов: 38
- P0: 23 | P1: 12 | P2: 2 | P3: 1
- UNIT (backend jest): 29 | STATIC (grep/git-diff): 6 | BUILD (tsc): 1 | UNIT-RUN (drift-guard): 1 | MANUAL: 1

Existing docs checked: `Docs/test-cases/` не содержит TECH-DAYOFF/TIME-OFF документов; seam-соседи (`VAPI-SLOT-ENGINE-001.md`, `SLOT-ENGINE-001-UX-POLISH.md`, `SLOT-ENGINE-NEAREST-FALLBACK-001.md`) покрывают ДО-фичевое поведение — их не дублируем, а охраняем drift-guard'ом.

**Общие фикстуры (все секции):**
- `COMPANY = '00000000-0000-0000-0000-00000000000a'`, чужой tenant `COMPANY_B = '...00b'`.
- Техники (ZB TEXT id — INV-7): `T1 = '1234567'` («John Smith»), `T2 = '7654321'` («Jane Doe»).
- tz компании: `America/New_York` (мок `scheduleService.getDispatchSettings` / `settingsService.resolve` как в slotEngineProxy).
- Day-off запись: `{ id: uuid, company_id, technician_id, technician_name, starts_at, ends_at, note, source, batch_id, created_at }` — timestamptz UTC ISO.

---

## A. UNIT — `tests/timeOffRoutes.test.js` (НОВЫЙ) — CRUD + RBAC + provider scope

Общие предусловия: реальные `routes/schedule.js` + `timeOffService` + `timeOffQueries`; мок `db.query`; мок `zenbookerClient.getTeamMembers`; fake-auth mini-app (permissions по кейсу). `db.query` для INSERT возвращает `{ rows: [<вставленная строка>] }`.

### TC-DO-01: POST individual → 201, одна строка, снапшот имени, `source='individual'`, `batch_id=null`, `created_by=crmUser.id`
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-1; T-13 (часть); INV-7
- **Предусловия:** permissions `['schedule.dispatch']`; `req.user.crmUser.id='user-1'`.
- **Входные данные:** `POST /api/schedule/time-off` body `{target:'technician', technician_id:'1234567', technician_name:'John Smith', starts_at:'2026-07-18T13:00:00.000Z', ends_at:'2026-07-20T01:00:00.000Z', note:'vacation'}`.
- **Ожидание:** 201; `body.ok===true`; `body.data.created` — массив из 1 записи с `source:'individual'`, `batch_id:null`; INSERT-параметры содержат `COMPANY` (из `req.companyFilter.company_id`), `technician_id='1234567'` (TEXT как есть), `technician_name='John Smith'` (с клиента, ZB НЕ дёргается — `getTeamMembers` `not.toHaveBeenCalled()`), `created_by='user-1'` (crmUser.id, НЕ `sub:'kc'`).

### TC-DO-02: POST без `crmUser` → `created_by = null`, всё равно 201
- **Приоритет:** P1 | **Тип:** UNIT — негативный
- **Маппинг:** T-13
- **Фикстура:** fake-auth без `crmUser` (`req.user = { sub:'kc' }`).
- **Ожидание:** 201; INSERT-параметр `created_by` строго `null` (не `'kc'`, не undefined-падение). created_by-FK gotcha закрыта.

### TC-DO-03: POST company → ровно K строк ОДНИМ INSERT-statement, общий `batch_id`, `source='company'` (AC-1)
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-2; T-1; INV-12
- **Фикстура:** `getTeamMembers.mockResolvedValue([{id:1234567,name:'John Smith'},{id:7654321,name:'Jane Doe'},{id:111,name:'Bob'}])` (K=3; id — number, как отдаёт ZB).
- **Входные данные:** `{target:'company', starts_at:'2026-07-19T04:00:00.000Z', ends_at:'2026-07-20T04:00:00.000Z', note:'storm day'}` (`technician_id` НЕ передан).
- **Ожидание:** `getTeamMembers` вызван ровно 1 раз с `({service_provider:true, deactivated:false}, COMPANY)` — тот же контракт, что buildTechnicians; **ровно ОДИН** `db.query`-INSERT в `technician_time_off` (multi-row VALUES — атомарность), из его параметров восстанавливаются 3 строки: `technician_id` = `'1234567'|'7654321'|'111'` (String(m.id)), имена из ростера, ОДИН общий `batch_id` (uuid), `source='company'`, одинаковые starts/ends/note/created_by; 201, `body.data.created.length===3`.

### TC-DO-04: POST company при пустом ростере → 400 `NO_ACTIVE_TECHNICIANS`, ноль вставок
- **Приоритет:** P0 | **Тип:** UNIT — негативный
- **Маппинг:** S-2; E-3; T-8
- **Фикстура:** `getTeamMembers.mockResolvedValue([])`.
- **Ожидание:** 400, `body.error.code==='NO_ACTIVE_TECHNICIANS'`; ни один `db.query` не содержит `INSERT INTO technician_time_off`.

### TC-DO-05: POST company при ZB-ошибке → 502 `ZENBOOKER_UNAVAILABLE`, ноль вставок (атомарность)
- **Приоритет:** P0 | **Тип:** UNIT — негативный
- **Маппинг:** S-2; E-3; T-8
- **Фикстура:** `getTeamMembers.mockRejectedValue(new Error('ZB timeout'))`.
- **Ожидание:** 502, `body.error.code==='ZENBOOKER_UNAVAILABLE'`; ноль INSERT'ов (никакой частичной материализации).

### TC-DO-06: POST валидационная матрица → 400 `VALIDATION|MISSING_FIELD`
- **Приоритет:** P1 | **Тип:** UNIT — негативный (`it.each`)
- **Маппинг:** E-1; E-7; T-7; «Обработка ошибок»
- **Кейсы (каждый → 400, ноль INSERT'ов, `body.ok===false`):**
  1. `ends_at <= starts_at` (равные и инверсия);
  2. `ends_at` целиком в прошлом (fake-время: `jest.useFakeTimers` / фиксированный `Date.now`);
  3. отсутствует `starts_at` или `ends_at`; невалидный ISO (`'garbage'`);
  4. `target:'weekend'` (вне `{'technician','company'}`);
  5. `target:'technician'` без `technician_id` (пустая строка / отсутствует);
  6. `note` из 501 символа.

### TC-DO-07: `starts_at` в прошлом + `ends_at` в будущем → 201 (уже идущий отпуск)
- **Приоритет:** P1 | **Тип:** UNIT — позитивная граница
- **Маппинг:** E-1; T-7
- **Фикстура:** `starts_at = now − 2d`, `ends_at = now + 2d`.
- **Ожидание:** 201, запись создана.

### TC-DO-08: individual с произвольным `technician_id` → 201, ZB не дёргается
- **Приоритет:** P2 | **Тип:** UNIT — граница
- **Маппинг:** E-5
- **Фикстура:** `technician_id:'no-such-tech-999'`.
- **Ожидание:** 201 (сервер валидирует только непустой TEXT, против ростера не проверяет); `getTeamMembers` `not.toHaveBeenCalled()`.

### TC-DO-09: DELETE своей записи → 200 `{deleted:true}`; SQL строго `WHERE id AND company_id`; batch-соседи нетронуты
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-3; T-1; T-9; INV-6
- **Фикстура:** `db.query` на DELETE → `{ rowCount: 1 }`.
- **Шаги:** `DELETE /api/schedule/time-off/<uuid>` под `schedule.dispatch`.
- **Ожидание:** 200, `body.data.deleted===true`; DELETE-SQL матчит `WHERE id = $1 AND company_id = $2` (параметры `[id, COMPANY]`) и **НЕ содержит** `batch_id` (INV-6: каскадного удаления батча не существует ни в одном код-пути — дополнительно `expect(sql).not.toMatch(/batch_id/)`); вызван ровно один DELETE (K−1 записей батча физически не затрагиваются).

### TC-DO-10: DELETE несуществующего id / записи чужого tenant'а → одинаковый 404
- **Приоритет:** P0 | **Тип:** UNIT — негативный / изоляция
- **Маппинг:** S-3; E-13; T-9
- **Фикстура:** `db.query` на DELETE → `{ rowCount: 0 }` (что и происходит при чужом `company_id` — SQL сам отфильтровывает).
- **Ожидание:** 404 `{code:'NOT_FOUND'}`; чужой tenant неотличим от несуществующего id (один и тот же ответ, никаких утечек существования).

### TC-DO-11: GET валидация диапазона → 400
- **Приоритет:** P1 | **Тип:** UNIT — негативный (`it.each`)
- **Маппинг:** E-6; T-7
- **Кейсы:** `from` отсутствует; `to` отсутствует; `from > to`; невалидный ISO. Все → 400 `{code:'VALIDATION'}` под `schedule.view`.

### TC-DO-12: GET overlap-семантика + опциональный `technician_id`-фильтр (диспетчер)
- **Приоритет:** P1 | **Тип:** UNIT
- **Маппинг:** API-контракт GET; S-9 (данные для сетки); S-13 (точечный fetch)
- **Шаги:** (а) `GET /time-off?from=A&to=B` под `schedule.view` (без provider-scope) → SELECT-SQL реализует **пересечение** `starts_at < $to AND ends_at > $from` (НЕ «целиком внутри»), фильтр `company_id`, прошедшее не режется; (б) `GET ...&technician_id=1234567` → SQL дополнительно фильтрует `technician_id = $n` с параметром `'1234567'`.
- **Ожидание:** 200, `body.data.time_off` — массив записей из мока; форма записи = контрактному JSON спеки.

### TC-DO-13: GET под provider (assigned_only, bridge есть) → выборка форсится на СВОЙ ZB id, параметр игнорируется
- **Приоритет:** P0 | **Тип:** UNIT — изоляция
- **Маппинг:** S-8; T-6; AC-5/AC-6
- **Фикстура:** fake-auth провайдера: `req.authz = { permissions:['schedule.view'] }` + provider-scope (как `getProviderScope(req)` → `{assignedOnly:true, userId:PROVIDER_USER}` — воспроизвести структурой req, которой пользуется реальный middleware); мок `membershipQueries.getZenbookerTeamMemberIdForUser` (или `db.query`-ответ bridge-SELECT'а) → `'1234567'`.
- **Шаги:** `GET /time-off?from=A&to=B&technician_id=7654321` (нагло просит ЧУЖОЙ id).
- **Ожидание:** bridge-резолв вызван с `(COMPANY, PROVIDER_USER)`; итоговый SELECT фильтрует `technician_id='1234567'` (свой), параметр `7654321` НИГДЕ в SQL-параметрах не фигурирует; 200 только со своими записями.

### TC-DO-14: GET под provider БЕЗ bridge-связки → `[]` (deny-by-default)
- **Приоритет:** P0 | **Тип:** UNIT — изоляция, негативный
- **Маппинг:** S-8; E-14; T-6
- **Фикстура:** bridge-резолв → `null`.
- **Ожидание:** 200, `body.data.time_off` — пустой массив; выборочный SELECT по таблице либо не выполняется, либо гарантированно возвращает 0 строк (ассертить: ни одна запись не отдана); НЕ 500.

### TC-DO-15: RBAC-матрица: 401 без auth / 403 без пермишена
- **Приоритет:** P0 | **Тип:** UNIT — безопасность
- **Маппинг:** S-8; T-6; INV-11
- **Кейсы:**
  1. `POST /time-off` с `permissions:['schedule.view']` (провайдер) → 403;
  2. `DELETE /time-off/:id` с `permissions:['schedule.view']` → 403;
  3. `GET /time-off` с `permissions:[]` → 403;
  4. mini-app без fake-auth (реальная цепочка не проставила `req.user`) → 401 (существующий authenticate-контракт — воспроизводится вариантом mini-app, где auth-middleware отвечает 401).
- **Ожидание:** ни один запрос не доходит до `db.query` INSERT/DELETE/SELECT по `technician_time_off`.

### TC-DO-16: GET/список НИКОГДА не ходит в ZB (снапшот-имена)
- **Приоритет:** P3 | **Тип:** UNIT — граница
- **Маппинг:** решение «technician_name — снапшот»; E-4
- **Шаги:** любой успешный `GET /time-off` (в т.ч. запись деактивированного техника в моке).
- **Ожидание:** `zenbookerClient.getTeamMembers` `not.toHaveBeenCalled()`; запись деактивированного техника отдаётся как есть (никакой чистки), `technician_name` — из строки БД.

---

## B. UNIT — `tests/slotEngineDayOffFilter.test.js` (НОВЫЙ) — seam A′ post-filter

Общие предусловия (каркас = `tests/slotEngineProxy.test.js`): моки `db/connection`, `marketplaceQueries`, `zenbookerClient`, `jobsService.listJobs`, `googlePlacesService`, `scheduleService.getDispatchSettings` (tz `America/New_York`), `slotEngineSettingsService.resolve` → `{...DEFAULTS}` (реальный `buildConfigOverride`); **`jest.mock('../backend/src/db/timeOffQueries', () => ({ listOverlappingRange: jest.fn() }))`**; `process.env.SLOT_ENGINE_URL='http://engine.test'`; `global.fetch = jest.fn()` — отвечает телом `{recommendations:[...], summary:{...}}`. Roster-фикстура: `getTeamMembers` → `[T1, T2]` с base-локациями (как в snapshot-тестах slotEngineProxy). Хелпер ожиданий времени — реальный `slotEngineService.tzCombine` (экспортирован), чтобы ожидания строились той же функцией, что и код (E-8-канон).

Rec-фикстура движка (NY-даты): `recs(...)` строит `{rank, date:'2026-07-18', time_frame:{start:'08:00', end:'10:00'}, technicians:[{id:'1234567',name:'John Smith'}], score, confidence}`.

### TC-DO-17: 0 day-off на горизонте → тело запроса к движку и ответ БАЙТ-В-БАЙТ прежние; единственная дельта — один SELECT
- **Приоритет:** P0 | **Тип:** UNIT (protected-pin)
- **Маппинг:** S-4; T-2; INV-2; AC-2
- **Фикстура:** `listOverlappingRange.mockResolvedValue([])`; полный сетап proxy-success из slotEngineProxy (движок → 200 с 2 rec'ами).
- **Шаги:** `slotEngineService.getRecommendations(COMPANY, {new_job:{lat,lng,duration_minutes:120}})`.
- **Ожидание:**
  1. `JSON.parse(global.fetch.mock.calls[0][1].body)` **toEqual** пину — литералу, воспроизводящему ДО-фичевое тело (`technicians` = полный buildTechnicians-выход, `config_override` = чистый `buildConfigOverride(DEFAULTS)` — `ranking.top_n` БЕЗ +5, `earliest/latest_allowed_date` как раньше);
  2. результат **toEqual** `{recommendations:<как отдал движок, rank нетронут>, summary, engine_status:'ok', coverage:{technicians_total:2, technicians_with_base:2}}`;
  3. `listOverlappingRange` вызван ровно 1 раз с `(COMPANY, horizonStartUtc, horizonEndUtc)`, где границы = `tzCombine(earliest,'00:00',tz)` / `tzCombine(addDaysLocal(latest,1),'00:00',tz)` (ожидание построено реальными хелперами).

### TC-DO-18: точечный day-off — частичное пересечение глушит окно; граничный стык НЕ глушит; чужие окна живут
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-5; T-3; INV-8; AC-2
- **Фикстура:** day-off T1 `сб 09:00→13:00 NY` (в UTC-инстантах через tzCombine). Движок возвращает rec'и: T1 `08:00–10:00`, T1 `12:00–14:00`, T1 `13:00–15:00`, T1 `14:00–16:00`, T2 `09:00–11:00` (все сб).
- **Ожидание:** выброшены ровно T1 `08:00–10:00` и T1 `12:00–14:00` (строгое `aStart < bEnd && bStart < aEnd`); **T1 `13:00–15:00` ОСТАЁТСЯ** (полуоткрытые интервалы: `ends_at == начало окна` — не пересечение); T1 `14:00–16:00` и T2 `09:00–11:00` остаются; `rank` перенумерован 1..3 подряд; форма каждой rec не изменена (те же ключи).

### TC-DO-19: company-wide day-off на весь день → rec'и за этот день пусты, остальные дни живут
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-6; T-3; сценарий 1 требований
- **Фикстура:** записи day-off у ОБОИХ техников `завтра 00:00 → послезавтра 00:00 NY` (2 строки — материализованный батч); движок отдаёт rec'и обоих техников на завтра и на послезавтра.
- **Ожидание:** все rec'и завтра выброшены; rec'и послезавтра (начиная с 00:00) — живы; rank 1..n.

### TC-DO-20: day-off через полночь / многодневный — единый интервал, никакой per-date нарезки
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-6; T-3
- **Фикстура:** ОДНА запись T1 `сб 09:00 → вс 21:00 NY`; rec'и T1: сб `08:00–10:00`, сб `10:00–12:00`, вс `08:00–10:00`, вс `19:00–21:30`, вс `21:00–23:00`; T2 вс `10:00–12:00`.
- **Ожидание:** выброшены сб `08:00–10:00` (частичное), сб `10:00–12:00`, вс `08:00–10:00`, вс `19:00–21:30` (хвост до 21:00 пересекается); **вс `21:00–23:00` остаётся** (стык); T2 живёт.

### TC-DO-21: pre-shaping — одна запись на весь горизонт выкидывает техника из `technicians[]`; `coverage` по pre-shaped roster
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-5 шаг 1; S-6; T-4; INV-4
- **Фикстура:** day-off T1 накрывает весь `[horizonStart, horizonEnd)`; day-off T2 — частичный (2 часа в сб).
- **Ожидание:** в теле запроса к движку `technicians` НЕ содержит `'1234567'` и содержит `'7654321'` (T2 с частичным — остаётся); `coverage.technicians_total` отражает roster ПОСЛЕ pre-shaping (1, не 2); сами объекты технarray T2 — байт-в-байт из buildTechnicians (никакого пере-маппинга — INV-4 as input-shaping only).

### TC-DO-22: headroom +5 и slice/re-rank — `ranking.top_n` в запросе = исходный+5, итог ≤ исходного, rank 1..n
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** S-5 шаги 2–4; T-4; E-11
- **Фикстура:** исходный `top_n` из DEFAULTS (пусть N); непустой day-off T1 на часть сб; движок возвращает N+5 rec'ов, из которых 2 пересекают day-off.
- **Ожидание:** `JSON.parse(fetch.body).config_override.ranking.top_n === N + 5` (TIMEOFF_TOPN_HEADROOM=5, компонуется ПОСЛЕ singleTech-виджининга); `max_recommendations_per_technician`/`max_recommendations_per_same_timeframe` в теле НЕ изменены против DEFAULTS; результат: `recommendations.length ≤ N` (slice по исходному pre-headroom top_n), `rank` строго 1..length.

### TC-DO-23: две СТЫКУЮЩИЕСЯ записи, вместе накрывающие горизонт → техник НЕ pre-shaped (v1 без склейки), но добит post-filter'ом
- **Приоритет:** P1 | **Тип:** UNIT — граница
- **Маппинг:** E-2; S-5 шаг 1 (консервативность)
- **Фикстура:** T1: запись №1 `[horizonStart, середина)`, запись №2 `[середина, horizonEnd)`; движок отдаёт rec'и T1 в обеих половинах + rec T2.
- **Ожидание:** `technicians` в запросе к движку СОДЕРЖИТ `'1234567'` (мульти-записи не склеиваются); все rec'и T1 выброшены post-filter'ом; rec T2 жив; ошибок нет.

### TC-DO-24: два ПЕРЕСЕКАЮЩИХСЯ day-off одного техника → union-семантика, окно выброшено ровно один раз, дублей нет
- **Приоритет:** P1 | **Тип:** UNIT — граница
- **Маппинг:** E-2; T-10
- **Фикстура:** T1: `сб 09:00→13:00` и `сб 11:00→15:00`; rec'и T1: `12:00–14:00` (в зоне обоих), `16:00–18:00` (вне обоих).
- **Ожидание:** `12:00–14:00` отсутствует в результате (и не задвоен отрицательно — итоговый массив без дырок/дублей rank'ов), `16:00–18:00` жив; никакой дедупликации записей не требуется.

### TC-DO-25: TECHSLOT one-tech + day-off на targetDay → `recommendations=[]`, существующий safe-fail
- **Приоритет:** P0 | **Тип:** UNIT
- **Маппинг:** E-9; T-12; S-6 (отпуск на весь горизонт one-tech); INV-2 (TECHSLOT-путь)
- **Фикстура:** `input.new_job.technician_id='1234567'` (сужение ростера — существующая TECHSLOT-логика); day-off T1 накрывает целевой день/горизонт.
- **Шаги:** два подварианта: (а) day-off на весь горизонт → pre-shaping даёт `technicians=[]`; (б) day-off только на targetDay → post-filter выбрасывает все rec'и.
- **Ожидание:** в обоих — `{recommendations:[], engine_status:...}` той же формы, БЕЗ throw; в (а) допустимо, что движок вызван с `technicians:[]` ИЛИ не вызван — но результат обязан быть существующей safe-fail формы (0 rec'ов).

### TC-DO-26: DST-день (America/New_York) — глушатся ровно tzCombine-инстанты
- **Приоритет:** P1 | **Тип:** UNIT — граница
- **Маппинг:** E-8; T-11; INV-8
- **Фикстура:** день перевода часов (напр. `2026-11-01`, fall-back NY); day-off T1 задан company-local `08:00→12:00` того дня, СКОНВЕРТИРОВАН в UTC той же `tzCombine`; движок отдаёт окна `07:00–09:00`, `12:00–14:00` того дня.
- **Ожидание:** ожидания теста построены ВЫЗОВОМ реального `tzCombine` (не рукописными UTC-литералами): окно `07:00–09:00` выброшено (пересечение по инстантам), `12:00–14:00` живо; никаких ±1h расхождений.

### TC-DO-27: ошибка SELECT day-off → пропагируется (reject), НЕ глотается в «0 строк»
- **Приоритет:** P0 | **Тип:** UNIT — негативный
- **Маппинг:** E-15
- **Фикстура:** `listOverlappingRange.mockRejectedValue(new Error('db down'))`; движок-мок настроен отвечать (не должен быть достигнут — или достигнут, но результат обязан быть reject).
- **Ожидание:** `await expect(getRecommendations(...)).rejects.toThrow('db down')`; НИКАКОГО фолбэка в отфильтрованный/нефильтрованный успешный ответ (иначе БД-икота тихо разблокирует мёртвые слоты).

### TC-DO-28: `SLOT_ENGINE_URL` не задан / движок недоступен + непустой day-off → существующий safe-fail, форма не меняется
- **Приоритет:** P1 | **Тип:** UNIT — негативный
- **Маппинг:** E-10; INV-2/INV-3
- **Фикстура:** (а) `delete process.env.SLOT_ENGINE_URL`; (б) URL есть, `fetch.mockRejectedValue` — оба при `listOverlappingRange` → [1 запись].
- **Ожидание:** результат `{recommendations:[], summary:null, engine_status:'unavailable', coverage}` — байт-в-байт существующая форма; никакой новой ошибки из-за наличия day-off-строк.

---

## C. UNIT (psql-less) — `tests/timeOffMigration.test.js` (НОВЫЙ) — shape миграции 167

### TC-DO-29: 167 up/rollback — shape-ассерты по SQL-файлам + свободность номера
- **Приоритет:** P0 | **Тип:** UNIT (fs + regex по файлам; БД не нужна)
- **Маппинг:** «Хранение»; T-14; AC-7
- **Шаги:** `fs.readFileSync('backend/db/migrations/167_technician_time_off.sql')` и `rollback_167_technician_time_off.sql`; `fs.readdirSync` каталога.
- **Ожидание (grep/regex):**
  1. `CREATE TABLE IF NOT EXISTS technician_time_off` (идемпотентность up);
  2. `company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE`;
  3. `technician_id\s+TEXT NOT NULL` (ZB TEXT id — INV-7) и `technician_name TEXT`;
  4. `starts_at`/`ends_at` — `TIMESTAMPTZ NOT NULL`; `CHECK (ends_at > starts_at)`;
  5. `source ... DEFAULT 'individual' CHECK (source IN ('individual','company'))`; `batch_id UUID`; `created_by UUID REFERENCES crm_users(id)`;
  6. `CREATE INDEX IF NOT EXISTS idx_tech_time_off_lookup ON technician_time_off (company_id, technician_id, starts_at)`;
  7. rollback содержит `DROP TABLE IF EXISTS technician_time_off` (и не содержит DROP чужих таблиц);
  8. в каталоге НЕТ второго файла `^167_` кроме нашего и есть `166_...` (RECHECK номера — прецедент 161, параллельные worktree).
- **Примечание:** живой CHECK-тест (`INSERT ends_at<=starts_at` падает) на реальной PG — вне jest-контура; enforcement CHECK'а на уровне API покрыт TC-DO-06.

---

## D. STATIC — git-diff / grep инварианты (шаги Tester'а, не jest)

### TC-DO-30: `slot-engine/` — git diff пуст
- **Приоритет:** P0 | **Тип:** STATIC
- **Маппинг:** INV-1; T-5
- **Шаги:** `git diff --stat master -- slot-engine/` (и `git status --porcelain slot-engine/`).
- **Ожидание:** пустой вывод. Контейнер не пересобирается, его тесты `slot-engine/test` не тронуты.

### TC-DO-31: потребители seam — git diff пуст по каждому
- **Приоритет:** P0 | **Тип:** STATIC
- **Маппинг:** S-7; T-5; INV-3
- **Шаги:** `git diff --stat master -- backend/src/routes/vapi-tools.js backend/src/services/outboundCallService.js backend/src/services/partsCallService.js backend/src/services/yelpConvoAgentService.js backend/src/agentSkills/ frontend/src/api/slotRecommendationsApi.ts frontend/src/components/schedule/CustomTimeModal.tsx`.
- **Ожидание:** пустой вывод — все шесть seam-путей получают фильтрацию бесплатно, ни один не отредактирован.

### TC-DO-32: защищённое ядро — permissionCatalog / server.js / scheduleQueries UNION / authedFetch / useRealtimeEvents без диффа
- **Приоритет:** P0 | **Тип:** STATIC
- **Маппинг:** INV-9; INV-11; INV-13
- **Шаги:** `git diff --stat master -- backend/src/services/permissionCatalog.js backend/src/server.js backend/src/db/scheduleQueries.js frontend/src/api/authedFetch.ts frontend/src/hooks/useRealtimeEvents.ts` + `grep -n "time_off\|timeOff" backend/src/db/scheduleQueries.js` (ноль хитов — day-off НЕ 4-й UNION).
- **Ожидание:** diff пуст; grep пуст; никаких новых permission-ключей (каталог байт-в-байт), mount `/api/schedule` в server.js:221 как был.

### TC-DO-33: `buildTechnicians`/`buildScheduledJobs` — тела функций нетронуты
- **Приоритет:** P1 | **Тип:** STATIC
- **Маппинг:** INV-4
- **Шаги:** `git diff master -- backend/src/services/slotEngineService.js` → визуально/awk: ни один изменённый hunk не попадает в диапазоны строк `function buildTechnicians`…конец и `function buildScheduledJobs`…конец; дополнительно `awk '/function buildTechnicians/,/^}/' backend/src/services/slotEngineService.js | grep -ci "timeoff\|time_off\|dayoff"` → 0 (и то же для buildScheduledJobs).
- **Ожидание:** pre-shaping — чистое input-shaping ПОСЛЕ них; в их телах нет упоминаний day-off.

### TC-DO-34: warning-only — сервер НЕ блокирует ручные действия (нет новых 4xx-веток)
- **Приоритет:** P1 | **Тип:** STATIC
- **Маппинг:** INV-5; S-11..S-13
- **Шаги:** `git diff master -- backend/src/routes/schedule.js` → проверить, что дифф ограничен новыми `/time-off` роутами: `grep -n "timeOff\|time_off"` по diff-hunk'ам reschedule/reassign/from-slot handler'ов → 0 хитов; в новых hunk'ах вне `/time-off` нет `res.status(4`.
- **Ожидание:** reschedule/reassign/создание job не приобрели ни одной day-off-проверки на сервере.

### TC-DO-35: фронт-канон серых блоков и warning'ов — grep-ассерты
- **Приоритет:** P1 | **Тип:** STATIC
- **Маппинг:** S-9; S-10; S-11; S-12; INV-10; T-15 (grep-часть)
- **Шаги/ожидание (все grep по frontend/src):**
  1. слой блоков в `TimelineView.tsx`/`TimelineWeekView.tsx` содержит `pointer-events-none` (или `pointerEvents: 'none'`) и НЕ содержит `onClick`/`draggable` на time-off элементах;
  2. `overlapsTimeOff` определён один раз (shared util) и вызывается в `handleDrop` `TimelineView`/`TimelineWeekView`/`DayView` и в `NewJobModal`/`JobInfoSections`;
  3. `TimeOffDialog.tsx` содержит `variant="panel"` + `DialogPanelHeader` + `DialogPanelFooter` (FORM-CANON) и `FloatingSelect`/`FloatingField`; delete-подтверждение — `variant="dialog"`;
  4. кнопка «Time off» на Schedule гейтится `schedule.dispatch` (grep `useAuthz`-проверки рядом с кнопкой);
  5. в `NewJobModal` warning НЕ дизейблит Save: рядом с инлайн-warning'ом нет `disabled` на primary-кнопке, завязанного на overlap-флаг;
  6. `useScheduleData`: fetchTimeOff — best-effort (`.catch` → console.warn, не throw);
  7. `grep -rn "time_off\|timeOff" frontend/src/hooks/useRealtimeEvents.ts` → 0 (SSE не добавлен, v1).

---

## E. BUILD + drift-guard

### TC-DO-36: фронт-сборка green
- **Приоритет:** P0 | **Тип:** BUILD
- **Маппинг:** T-15
- **Шаги:** `npm run build` (tsc -b + vite; помнить: прод-Docker строже — noUnusedLocals).
- **Ожидание:** exit 0, ноль TS-ошибок (новые `TimeOffBlock`-тип с `technician_id: string` — INV-7, `TimeOffDialog`, слой блоков, `overlapsTimeOff`).

### TC-DO-37: drift-guard — существующие slot/schedule сьюты зелёные БЕЗ правок
- **Приоритет:** P0 | **Тип:** UNIT-RUN (существующие)
- **Маппинг:** INV-2; INV-9; T-2 (охрана до-фичевого поведения)
- **Шаги:**
  1. `git diff --stat master -- tests/slotEngineProxy.test.js tests/slotEngineSettings.test.js tests/slotEngineHeldLeads.test.js tests/recommendSlots.test.js tests/scheduleRoute.test.js tests/scheduleProviderScope.test.js tests/scheduleReassign.test.js tests/scheduleTimezone.test.js tests/scheduleLayout.test.js tests/scheduleServiceRescheduleZb.test.js` → пусто;
  2. `npx jest --testPathIgnorePatterns "/node_modules/" --roots "$(pwd)/tests" --testPathPatterns "slotEngine|schedule|recommendSlots"` → все green.
- **Ожидание:** ДО-фичевые сьюты проходят на изменённом `slotEngineService`/`routes/schedule.js` без единой правки тестов — прямое доказательство INV-2 (в этих сьютах day-off-таблицы нет → `listOverlappingRange` вернёт 0 строк / замокан пустым → байт-в-байт старое поведение). Если новый SELECT ломает их мок-каркас (`db.query`-последовательности) — это сигнал НЕ чинить тесты, а мокать `timeOffQueries` отдельным модулем (правка существующих файлов запрещена).

---

## F. MANUAL — смоук T-15 (после BUILD, live preview)

### TC-DO-38: ручной смоук фронта
- **Приоритет:** P2 | **Тип:** MANUAL
- **Маппинг:** T-15; S-9..S-13; AC-4/AC-5
- **Чек-лист:**
  1. Desktop timeline: серый блок «Time off» в лейне техника, клик/DnD сквозь него НЕ перехватываются (job под блоком таскается);
  2. Мобильная agenda (DayView): серая карточка «Time off · {имя} · HH:MM–HH:MM» хронологически / «All day»; не кликается;
  3. TimeOffDialog: на desktop — правая панель FORM-CANON, на мобиле — bottom-sheet автоматически; create/delete без перезагрузки, ошибки — sonner toast;
  4. DnD на конфликт → центр-модалка с именем и периодом; «Перенести» доводит существующий reschedule, «Отмена» — ничего не мутирует;
  5. NewJobModal: инлайн-warning при пересечении, Save активен;
  6. Reschedule из карточки Job (JobInfoSections → CustomTimeModal): после выбора времени на day-off-день — confirm-модалка; при отвале точечного fetch — reschedule идёт без warning'а;
  7. Provider-логин: кнопки «Time off» нет; в сетке видит только СВОИ блоки.

---

## Сводный маппинг покрытия

| Spec-утверждение | TC |
|---|---|
| T-1 (K записей / K−1 после delete) | TC-DO-03, TC-DO-09 |
| T-2 (0 day-off байт-в-байт) | TC-DO-17, TC-DO-37 |
| T-3 (частичное/полное/полночь/многодневное, стык) | TC-DO-18, TC-DO-19, TC-DO-20 |
| T-4 (pre-shaping, headroom, slice, re-rank) | TC-DO-21, TC-DO-22 |
| T-5 (diff потребителей + slot-engine пуст) | TC-DO-30, TC-DO-31 |
| T-6 (provider scope, 401/403) | TC-DO-13, TC-DO-14, TC-DO-15 |
| T-7 (валидации E-1/E-6/E-7) | TC-DO-06, TC-DO-07, TC-DO-11 |
| T-8 (ZB-fail 502 / пустой roster 400, 0 вставок) | TC-DO-04, TC-DO-05 |
| T-9 (чужой tenant 404, нет batch-каскада) | TC-DO-09, TC-DO-10 |
| T-10 (пересекающиеся записи, union) | TC-DO-23, TC-DO-24 |
| T-11 (DST) | TC-DO-26 |
| T-12 (TECHSLOT one-tech → []) | TC-DO-25 |
| T-13 (created_by = crmUser.id / null) | TC-DO-01, TC-DO-02 |
| T-14 (миграция 167 shape) | TC-DO-29 |
| T-15 (фронт: build + grep + manual) | TC-DO-35, TC-DO-36, TC-DO-38 |
| E-4/E-5 (деактивированный/произвольный tech) | TC-DO-08, TC-DO-16 |
| E-10/E-15 (движок недоступен / SELECT-ошибка) | TC-DO-28, TC-DO-27 |
| INV-1..13 | TC-DO-09 (INV-6), TC-DO-17 (INV-2), TC-DO-21/33 (INV-4), TC-DO-30 (INV-1), TC-DO-31 (INV-3), TC-DO-32 (INV-9/11/13), TC-DO-34 (INV-5), TC-DO-35 (INV-10), TC-DO-01/29 (INV-7), TC-DO-18 (INV-8), TC-DO-32-grep (INV-12 — ZB только на company-create: TC-DO-01/08/16) |
