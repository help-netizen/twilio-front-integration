# Тест-кейсы: OUTBOUND-LEAD-CALL-001 — Sara auto-calls every NEW lead from configured sources (launch: Pro Referral), books a schedule-hold on the lead; 3-attempt ladder; marketplace app + settings page

**Спецификация:** `docs/specs/OUTBOUND-LEAD-CALL-001.md` (§2–§17 — контракты; **§18 задаёт verification-якоря — здесь они формализованы и расширены, файловые анкеры сохранены**) · **Требования:** `docs/requirements.md § OUTBOUND-LEAD-CALL-001` (:6383 — FR-1..FR-15, N-1..N-7, D1–D5, SC-01..SC-09) · **Edge-набор:** spec §13 E-1..E-18 · **Дата:** 2026-07-13

**Dedup:** `docs/test-cases/OUTBOUND-PARTS-CALL-001.md` покрывает **parts**-цепочку (S1–S14) — здесь она НЕ дублируется: parts фигурирует только как **regression-инвариант** (byte-identical под смешанной нагрузкой, TC-OLC-029/030/062). `TIMELINE-REVPAGE-001.md` покрывает ленту — здесь лента только как seam-вызов (`recordPlacement`/finalize), без повторных кейсов рендера.

**House-lesson (OUTBOUND-PARTS-CALL-001 / LIST-PAGINATION-001, binding):** мокнутый jest доказывает **dispatch, SQL-shape и порядок вызовов**, но НЕ то, что partial-unique индекс реально заблокировал строку, CHECK реально отверг INSERT, или rollback реально прошёл на живой таблице — все такие claim'ы продублированы real-DB кейсом на стенде (TC-OLC-057).

### Покрытие
- Всего: **63**
- **P0: 36 | P1: 23 | P2: 3 | P3: 1**
- **unit jest: 29** (секции A, B, E, G-файловые, 031) | **worker jest: 13** (секция C) | **API-integration jest: 14** (секции D, F) | **manual-stand: 6** (057, 058–062) | **owner-smoke-prod: 1** (063)
- **Sabotage / negative controls** (домашнее правило — минимум один на слой, обязанный краснеть при заглушенной фиче): TC-OLC-010 (window-unit), TC-OLC-019 (eligibility), **TC-OLC-029 (worker / PARTS-REGRESSION — критический)**, TC-OLC-040 (webhook), TC-OLC-047 (skill), TC-OLC-054 (routes), TC-OLC-058 шаг S (stand)
- **Must-pass P0 gates (красный = блок релиза):** 029 (parts byte-identical под смешанной нагрузкой) · 016+057 (lifetime-once / partial-unique) · 022 (никогда не звонить вне окна) · 035 (CC-07 идемпотентность webhook) · 041/043/044 (injection-hardening + fail-closed booking + tenant isolation) · 051 (tenant isolation routes)

### Файлы тестов (якоря spec §18.1/§20 сохранены)
- `backend/tests/outboundLeadCallSettingsService.test.js` — A: 001–002
- `backend/tests/outboundLeadCallWindow.test.js` — A: 003–010
- `backend/tests/outboundLeadCallEnqueue.test.js` — B: 011–019
- `backend/tests/outboundLeadCallWorker.test.js` — C: 020–030, 032–033
- `tests/outboundCallService.test.js` — **аддитивный** describe (031); существующие describes НЕ трогать
- `backend/tests/outboundLeadCallWebhook.test.js` — D: 034–040 (supertest)
- `backend/tests/confirmLeadBooking.test.js` — E: 041–047
- `backend/tests/outboundLeadCallRoutes.test.js` — F: 048–054 (supertest)
- `backend/tests/outboundLeadCallMigration.test.js` — G: 055–056 (файловый, precedent `tests/timeOffMigration.test.js`; **добавка к списку spec §20** — там migration-сюиты нет)
- Секции H (стенд dev) / I (prod) — чек-листы, скрипты не обязательны
- ⚠️ NB для Implementer: spec кладёт новые сюиты в `backend/tests/`, при этом родственные parts-сюиты живут в корневом `tests/` — оба каталога прогоняются jest'ом; якоря spec сохранены, но допустима колокация в `tests/` (решить единообразно). **JEST GOTCHA (JOBS-UX-RBAC-001):** прогон из worktree — `--testPathIgnorePatterns "/node_modules/"`.

### Стратегия моков
jest-mock `../db/connection` (`db.query` диспетчеризуется по SQL-substring: `INSERT INTO outbound_call_attempts` / `UPDATE outbound_call_attempts` / `UPDATE leads` / `SELECT 1 FROM outbound_call_attempts` / `FROM tasks` / `FROM outbound_lead_call_settings`, НЕ по порядку). Module-mocks: `marketplaceService.isAppConnected`, `leadsService` (`getLeadById`/`getLeadByUUID`/`updateLead`), `scheduleService.getDispatchSettings`, `recommendSlots.run`, `outboundCallService.placeCall`, `vapiCallTimelineService.recordPlacement`, `eventService.logEvent`, `timelinesQueries` (`findOrCreateTimeline`/`createTask`), `companyProfileService.getProfile`, `slotEngineService` (`resolveTimezone`/`tzCombine`). REAL: модуль под тестом (`outboundLeadCallService` / `outboundLeadCallSettingsService` / `confirmLeadBooking` / роуты / worker-dispatch). Webhook/routes — supertest: REAL `authenticate` только в 401-кейсах, остальное auth-stub (`companyFilter.company_id=COMPANY_A`, конфигурируемые permissions); webhook — REAL secret-middleware c env `VAPI_WEBHOOK_SECRET=test`. Часы — injectable `now` (fake timers) для всей window-математики, tz `America/New_York`. **Внешние API (VAPI / Twilio / slot-engine container / ZB) — НИКОГДА не по сети**; VAPI = мок `placeCall`/fetch-seam, канонический ответ `{ ok:true, vapiCallId:'vapi_call_test' }`.

**Golden-фикстуры parts (для 029/031):** захватываются с `origin/master` ДО изменений фичи (одноразовая процедура: прогнать текущие `tests/outboundCallWorker.test.js`-фикстуры через реальный `placeCall`-мок и закоммитить `tests/fixtures/parts-placecall-golden.json`). Снимок, снятый ПОСЛЕ изменений, детекторной силы не имеет.

---

## Секция A — unit jest: чистые функции (settings + window math + phone)

### TC-OLC-001: normalizeSource / isSourceEnabled — матрица нормализации
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §3, §18.1-settings · **FR/E:** FR-2, D5
- **Входные:** `normalizeSource`: `'Pro Referral'`, `'ProReferral'`, `'pro referral'`, `'  pro   referral '`, `'PRO REFERRAL'`, `''`, `null`, `undefined`, `42`. `isSourceEnabled`: settings `{enabled_sources:['ProReferral']}` × rawSource из вариантов выше; `{enabled_sources:['Pro Referral']}` × `'ProReferral'`; `{enabled_sources:[]}`; rawSource `''`/`null`.
- **Ожидаемо:** все 5 display-вариантов → один ключ `'proreferral'`; `''`/`null`/`undefined` → `''`; функция чистая (не бросает на не-строке). `isSourceEnabled`: true на любой паре display-вариантов в ОБЕ стороны (нормализация обеих сторон); false при пустом rawSource; false при пустом списке.

### TC-OLC-002: coerceStored / get / resolve — per-key overlay + safe-fail
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** §3, §18.1-settings · **FR/E:** FR-5, N-2
- **Входные:** `coerceStored`: `{enabled_sources:'oops'}`; `{enabled_sources:[1,'',' Google ',null]}`; `{max_attempts:0}` / `-1` / `2.5` / `'3'`; `{backoff_schedule:[]}` / `null`; полностью валидная строка. `get`: db → нет строки; db → строка. `resolve`: db бросает.
- **Ожидаемо:** невалидный ключ падает на DEFAULT этого ключа, валидные соседние сохраняются; junk-элементы sources коэрцятся `String(x)`, пустые выбрасываются; результат ВСЕГДА полный типизированный объект. `get` без строки → `{...DEFAULTS}` (копия, не ссылка); hard-DB-ошибка из `get` пробрасывается. `resolve` при ЛЮБОЙ ошибке → лог `[OutboundLeadCallSettings] resolve failed` + `{...DEFAULTS}`, никогда не бросает.

### TC-OLC-003: normalizeDialablePhone — матрица isDialable
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.1, §18.1-window · **FR/E:** FR-3, E-2
- **Входные:** `'6175551234'` (10 цифр); `'16175551234'` (1+10); `'+1 (617) 555-1234'`; `'+447911123456'` (foreign E.164); `'+123456789'` (+, 9 цифр); `'5551234'` (7 цифр); `'26175551234'` (11 цифр не с 1, без +); `'garbage'`; `''`; `null`.
- **Ожидаемо:** → `'+16175551234'`, `'+16175551234'`, `'+16175551234'`, `'+447911123456'`, `null`, `null`, `null`, `null`, `null`, `null`. Foreign `+` 10–15 цифр — DIALABLE (E-2: ошибка размещения уйдёт в ladder, не в скип).

### TC-OLC-004: isWithinWorkWindow — границы дня и недели
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.1, §18.1-window · **FR/E:** FR-4, D2
- **Входные:** ds `{tz:'America/New_York', 08:00–18:00, work_days:[1..5]}`; now = среда 12:00 local; среда 07:59; среда 08:00 ровно; среда 17:59; среда 18:00 ровно; суббота 12:00.
- **Ожидаемо:** true / false / true / true / **false** (dial стартует СТРОГО до `work_end_time`; ровно end = вне окна) / false. Wall-clock берётся через `Intl.formatToParts`-пробу в tz компании, не в TZ процесса (прогнать при `TZ=UTC` и `TZ=America/Los_Angeles` — результат идентичен).

### TC-OLC-005: nextWindowStart — same-day start / next-day / weekend skip / strictly-after
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.1, §18.1-window, SC-03 · **FR/E:** FR-4, D2
- **Входные:** (a) будний 06:12 local; (b) будний 19:30; (c) **SC-03**: суббота 22:40 при `work_days=[1..6]` (Пн–Сб) 08:00–18:00; (d) from = будний 12:00 (ВНУТРИ окна); (e) пятница 18:00 ровно при Пн–Пт.
- **Ожидаемо:** (a) СЕГОДНЯ 08:00 (before-hours → same-day start); (b) завтра 08:00; (c) **понедельник 08:00** (суббота — рабочий день, но 22:40 ≥ end; воскресенье ∉ work_days); (d) СЛЕДУЮЩИЙ старт окна строго ПОСЛЕ from (завтра 08:00), не сегодняшний прошедший; (e) понедельник 08:00. Все результаты — UTC-инстанты, соответствующие 08:00 wall-clock company-tz.

### TC-OLC-006: clampIntoWorkWindow — identity внутри окна
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** §5.1 · **FR/E:** FR-4
- **Ожидаемо:** дата внутри окна возвращается БЕЗ изменения (тот же instant); вне окна → ровно `nextWindowStart(date, ds)` (deep-equal с прямым вызовом).

### TC-OLC-007: computeLeadNextDueAt — арифметика ladder + clamp
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.1, §18.1-window · **FR/E:** FR-5, D1
- **Входные:** schedule `['immediate','+30m','+2h']`, now = будний 10:00. (a) justFailedNo=1; (b) justFailedNo=2; (c) token `'immediate'` (justFailedNo=0); (d) generic `'+45m'`; (e) неизвестный token `'tomorrow'`; (f) отсутствующий индекс (justFailedNo=7); (g) **clamp**: fail в 17:45, token `'+30m'`; (h) fail в пятницу 17:00, token `'+2h'`, Пн–Пт.
- **Ожидаемо:** (a) now+30m (соглашение parts `:144`: `backoff_schedule[justFailedNo]` — token СЛЕДУЮЩЕЙ попытки, 0-based: после attempt 1 → индекс 1); (b) now+2h; (c) now; (d) now+45m; (e)/(f) now (консервативно); (g) 18:15 вне окна → **след. рабочий день 08:00**; (h) 19:00 пятницы → понедельник 08:00. Каждый результат прогнан через инвариант-чекер `assertClamped` (внутри окна ds) — см. 010.

### TC-OLC-008: DST — spring-forward и fall-back
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** §5.1, §18.1-window · **FR/E:** FR-4, E-12
- **Входные:** tz `America/New_York`. (a) 2026-03-08 (spring-forward, 02:00→03:00): fail 2026-03-08T01:30 local, token `'+2h'`; `nextWindowStart` с from=та ночь; (b) 2026-11-01 (fall-back): `nextWindowStart` через границу; token `'+2h'` через повторённый час.
- **Ожидаемо:** (a) результат — корректный UTC-инстант (wall-clock 04:30, т.к. 02:30–03:30 не существует — offset пробится per-target-day через `getTimezoneOffsetMs`); окно стартует ровно в 08:00 wall-clock EDT (UTC-4, не UTC-5); (b) 08:00 wall-clock EST (UTC-5) — без сдвига на час; +2h монотонно вперёд, без дублей/зацикливания.

### TC-OLC-009: санитизация dispatch-settings + гарантия завершения
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** §5.1-sanitization · **FR/E:** FR-4, E-7, E-15
- **Входные:** `work_days:[]` / `null` / `['mon']` / `[9]`; `work_start_time:'8'` (валидно по regex `/^\d{1,2}:\d{2}$/`) / `'25:99'`-типа мусор / `end ≤ start` (`'18:00'/'08:00'` наоборот); `timezone:''`; фузз-матрица случайных конфигов.
- **Ожидаемо:** невалидные `work_days` → `[1,2,3,4,5]`; невалидные/перевёрнутые часы → `'08:00'/'18:00'`; falsy tz → `'America/New_York'`; ни один вход не бросает и не зацикливает. Термination-инвариант: для ЛЮБОГО конфига `nextWindowStart` возвращает Date строго `> from` и `≤ from+14d` (либо ровно `from+24h` hard-fallback с `console.warn`).

### TC-OLC-010: sabotage-unit — детектор clamp'а умеет краснеть
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** house-rule sabotage · **FR/E:** FR-4/FR-5 (контроль)
- **Шаги:** инвариант-чекер `assertClamped(result, ds)` (бросает, если result вне окна ds) прогнать: (a) на честных результатах `computeLeadNextDueAt` фикстуры 007(g/h) — зелёный; (b) на ЗАВЕДОМО не-clamped значении `now+30m` (17:45+30m=18:15) — `expect(() => assertClamped(...)).toThrow()`.
- **Ожидаемо:** (b) детектор срабатывает — реализация без `clampIntoWorkWindow` (сорванный clamp) гарантированно провалит 007. Детекторная сила доказана.

---

## Секция B — unit jest: emit-контракт + eligibility gauntlet (`onLeadCreated`)

### TC-OLC-011: emit-контракт `lead.created` в createLead
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §4.1, §18.1-enqueue · **FR/E:** FR-3
- **Шаги:** REAL `leadsService.createLead` с мокнутыми db/eventBus: создать лид со всеми полями; создать лид при eventBus.emit → rejected promise.
- **Ожидаемо:** `eventBus.emit(companyId, 'lead.created', payload, opts)` вызван ровно один раз, ПОСЛЕ SSE `emitLeadChange` (порядок spy); payload = `{id, uuid, first_name, last_name, phone, job_type, job_source, status}` (status default `'Submitted'`); opts = `{actorType:'system', aggregateType:'lead', aggregateId}`; `.catch` навешан — reject НЕ ломает создание (возврат createLead byte-неизменен, сигнатура `(fields, companyId)` не тронута); SSE-вызовы не изменились.

### TC-OLC-012: gate 1 — app not connected → ничего
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.2-1, SC-07 · **FR/E:** FR-3, FR-14(b)
- **Предусловия:** `isAppConnected → false`; лид полностью eligible в остальном.
- **Ожидаемо:** НОЛЬ db-writes (нет INSERT, нет comments-append), `getLeadById` НЕ вызван (connected-gate — первый, cheapest-first); лог `reason=app_not_connected`. Это же — конструктивное «no backfill»: событий, наблюдённых до connect, не существует.

### TC-OLC-013: gate 3 — source: disabled → стоп без trace; normalized match → проход
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.2-3, SC-06 · **FR/E:** FR-2, FR-3
- **Входные:** (a) лид `JobSource:'Thumbtack'`, enabled `['ProReferral']`; (b) лид `JobSource:'Pro Referral'` (прод-вариант с пробелом), enabled `['ProReferral']` (канон); (c) `JobSource:null`.
- **Ожидаемо:** (a) стоп `reason=source_not_enabled`, НЕТ comments-trace (SC-06 — тишина), НЕТ INSERT; (b) проход дальше по gauntlet (INSERT достигнут при остальных зелёных gates) — нормализация склеивает display-варианты; (c) стоп source_not_enabled (пустая нормализация → false).

### TC-OLC-014: gate 4 — no phone → Comments-trace + стоп
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.2-4, SC-05 · **FR/E:** FR-3, E-18
- **Входные:** eligible-лид с `Phone:'5551234'` (7 цифр → null); суб-кейс: UPDATE leads бросает.
- **Ожидаемо:** вызван ровно один `UPDATE leads SET comments = COALESCE(NULLIF(comments,'') || E'\n\n','') || $2 WHERE uuid = $1 AND company_id = $3` с `$2` = `'[AI Phone] <ISO> — Outbound call skipped — no phone number on the lead.'` (ISO — валидный timestamp, копия точная) и params `[lead.UUID, trace, companyId]`; INSERT в attempts НЕ вызван; `reason=no_phone`. Суб-кейс: append-ошибка ЛОГИРУЕТСЯ, скип сохраняется (chain всё равно не стартует), не бросает наружу (E-18).

### TC-OLC-015: gate 5 — goal-achieved at birth
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** §5.2-5, E-13 · **FR/E:** FR-6
- **Входные:** (a) лид с `LeadDateTime` установленным (Sara createLead с холдом); (b) `Status:'Lost'`; (c) `'converted'` (lower-case); (d) `'Submitted'` + без холда.
- **Ожидаемо:** (a)–(c) стоп `reason=goal_achieved_at_birth`, без INSERT и без trace; (d) проход дальше.

### TC-OLC-016: gate 6 + INSERT — lifetime-once и дубль `lead.created`
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.2-6/7, E-5 · **FR/E:** FR-14(a)(c)
- **Входные:** (a) прежняя строка ЛЮБОГО статуса (`exhausted`) по lead_uuid → SELECT 1 отдаёт строку; (b) две конкурентные доставки события: SELECT пуст в обеих, INSERT второй раз резолвится 0 rows (ON CONFLICT).
- **Ожидаемо:** (a) стоп `reason=chain_exists`, INSERT не вызван (lifetime-once, FR-14c); (b) оба вызова завершаются БЕЗ throw, INSERT-SQL содержит `ON CONFLICT (lead_uuid) WHERE status IN ('pending', 'dialing') DO NOTHING` (partial-index inference — FR-14a); итог — ровно одна цепочка. NB: то, что индекс РЕАЛЬНО блокирует, доказывает TC-OLC-057 (real-DB).

### TC-OLC-017: eligible → точный INSERT с clamped due_at
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §5.2-7, §18.1-enqueue · **FR/E:** FR-3, FR-4, N-6
- **Входные:** матрица (connected × enabled × dialable × открыт × нет цепочки) — ровно проходная клетка; (a) now внутри окна; (b) now суббота 22:40 (SC-03 фикстура).
- **Ожидаемо:** INSERT-params: `(companyId, lead.UUID, 'lead_call', lead.ContactId||null, '+1…', 1, 'pending', dueAt)`; `job_id`/`slot_json` в INSERT отсутствуют (NULL — slot считается на claim, не на enqueue); (a) dueAt ≈ now; (b) dueAt = понедельник 08:00 company-tz; лог `enqueued lead=<uuid> due_at=<iso>`. Каждая НЕпроходная клетка матрицы: ноль INSERT + свой `reason` в логе.

### TC-OLC-018: fail-safety gauntlet'а — throws не выходят наружу
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** §5.2 try/catch, E-17 · **FR/E:** N-2, E-15
- **Входные:** (a) `getLeadById` бросает не-LEAD_NOT_FOUND ошибку; (b) `getDispatchSettings` бросает на шаге 7; (c) `resolve` settings недоступен (уже safe-fail — вернёт DEFAULTS).
- **Ожидаемо:** (a) warn `[outboundLeadCall] onLeadCreated`-класс, промис резолвится (subscriber-обёртка не получает reject), никаких частичных записей; (b) используется клон `DEFAULT_DISPATCH_SETTINGS` (America/New_York, Пн–Пт 08–18) — INSERT ВСЁ РАВНО происходит с дефолтным окном; (c) gauntlet работает на DEFAULTS (ProReferral-only).

### TC-OLC-019: sabotage-eligibility — матрица умеет краснеть
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** house-rule sabotage · **FR/E:** FR-2/FR-3 (контроль)
- **Шаги:** фикстуру TC-OLC-013(a) (Thumbtack, стоп ожидается) прогнать с `jest.spyOn(settingsService,'isSourceEnabled').mockReturnValue(true)` — симуляция вырезанного source-gate.
- **Ожидаемо:** INSERT ВЫЗВАН (детектор «no INSERT» из 013 обязан упасть на такой реализации); после `mockRestore` честный прогон снова зелёный. Доказано: тесты матрицы реально различают наличие gate, а не проходят вакуумно.

---

## Секция C — worker jest: claim-time (`processLeadAttempt` + ladder + dispatch) и PARTS-регрессия

### TC-OLC-020: goal-achieved skip на claim — 4 варианта
- **Приоритет:** P0 · **Тип:** worker jest · **Якорь:** §5.3-1/2, SC-04, E-11 · **FR/E:** FR-6, D3
- **Входные:** claimed-строка `lead_call`; лид: (a) `LeadDateTime` установлен; (b) `Status:'Lost'`; (c) `'CONVERTED'`; (d) `getLeadByUUID` бросает `LEAD_NOT_FOUND`.
- **Ожидаемо:** terminate-UPDATE со status `canceled` и reason соответственно `goal_achieved:hold_set` / `goal_achieved:closed_lost` / `goal_achieved:closed_converted` / `lead_not_found`; `placeCall` НЕ вызван, `recommendSlots` НЕ вызван, задача НЕ создана. **D3-негатив:** фикстура с «живым человеческим контекстом» (свежая заметка/недавний звонок на лиде) НЕ останавливает обработку — никакого takeover-guard'а в коде пути нет (проверить: единственные skip-причины — goal/eligibility).

### TC-OLC-021: FR-15 на claim — disconnect / source-off отменяют queued
- **Приоритет:** P0 · **Тип:** worker jest · **Якорь:** §5.3-3, SC-07, E-3 · **FR/E:** FR-15
- **Входные:** (a) `isAppConnected → false`; (b) connected, но source выключен в settings.
- **Ожидаемо:** terminate `canceled`/`app_disconnected` и `canceled`/`source_disabled`; без dial, без task, без ladder-строки. Порядок: goal-check (§5.3-2) ДО eligibility (§5.3-3) — лид с холдом при отключённом app получает `goal_achieved:hold_set`, не `app_disconnected`.

### TC-OLC-022: window-carry на claim — перенос, не дроп и не dial
- **Приоритет:** P0 · **Тип:** worker jest · **Якорь:** §5.3-4, §18.1-worker · **FR/E:** FR-4, D2
- **Входные:** claimed-строка, now вне окна (после 18:00); суб-кейс `OUTBOUND_CALL_IGNORE_BUSINESS_HOURS=true`.
- **Ожидаемо:** `UPDATE outbound_call_attempts SET status='pending', scheduled_at=$2` с `$2 = nextWindowStart(now, ds)`; `placeCall`/`recommendSlots` НЕ вызваны; лог `carried attempt=<id> to=<iso>`; строка живёт (не canceled — carry, never drop). С toggle (regex `/^(1|true|yes|on)$/i` — проверить `'yes'`) — дозвон идёт немедленно. Источник окна = `scheduleService.getDispatchSettings`, НЕ `groupRouting.isBusinessHours` (D2/G6 — assert: groupRouting-мок не вызывался).

### TC-OLC-023: slot pre-compute — пусто/ошибка → technical failure в ladder, не park
- **Приоритет:** P0 · **Тип:** worker jest · **Якорь:** §5.3-5, §18.1-worker · **FR/E:** FR-9, E-1, E-8
- **Входные:** (a) `recommendSlots.run → {available:false, slots:[], fallback:true}`; (b) `{available:true, slots:[]}`; (c) run бросает; (d) location-трио: лид только с zip; лид с lat БЕЗ lng (both-or-nothing); лид с Address+City+State; лид совсем без локации.
- **Ожидаемо:** (a)–(c) `placeCall` НЕ вызван; `scheduleLeadRetryOrExhaust(attempt, 'no_slots', 'failed')` вызван ровно раз (ladder, НЕ бессрочный park); (d) run получает `{zip}` / `{}` без lat/lng (одинокая координата отброшена) / `{address:'A, City, ST'}` / `{}` — и в последнем случае engine-fallback ведёт в (a). Gate `smart-slot-engine` НЕ обходится (run — единственная точка вызова).

### TC-OLC-024: happy dial — SNAPSHOT контракта placeCall (variableValues + firstMessage)
- **Приоритет:** P0 · **Тип:** worker jest · **Якорь:** §5.3-6, §7.2/7.3, §18.1-worker, SC-01/SC-09 · **FR/E:** FR-7, FR-8, FR-13, D4
- **Предусловия:** eligible claimed-строка; recommendSlots → top-slot `{key,label,date,start,end,techId}`; лид с zip+коордами+описанием >300 симв.; profile → `{name:'ABC Homes'}`.
- **Ожидаемо (snapshot-объект аргумента placeCall):** `scenario:'lead_call'`, `leadUuid`, `contactId`, `customerName='First Last'`, `customerNumber=attempt.phone`, `zip`, `problemDescription` обрезан ровно до 300, `source='Pro Referral'`, `slot={...topSlot, lat, lng}` (координаты едут НА slot-объекте — TECHSLOT spread), `firstMessage` = вариант A: `Hi {{customerName}}, this is Sara with ABC Homes — you reached out on Pro Referral about your appliance. I can get you on the schedule right now: we have {{slotLabel}} available — would that work?` (токены `{{…}}` НЕ интерполированы сервером). Суб-кейсы: profile бросает/пуст → вариант B (без company); `JobSource` пуст → `<source label>='online'`; имени нет → `customerName='there'`. После `ok:true`: UPDATE стампит `vapi_call_id`+`slot_json=JSON.stringify(topSlot)`; `recordPlacement` вызван с `{attempt, vapiCallId, dialedNumber:attempt.phone, callerId}`; его throw НЕ реклассифицирует attempt (строка остаётся `dialing`); статус строки остаётся `dialing` до webhook.

### TC-OLC-025: placement failure → ladder
- **Приоритет:** P1 · **Тип:** worker jest · **Якорь:** §5.3-6, E-9, E-14 · **FR/E:** FR-5, N-5
- **Входные:** `placeCall → {ok:false, error:'vapi_config_missing'}` / `'vapi_http_500'` / `'missing_customer_number'` / `{ok:false}` без error.
- **Ожидаемо:** `scheduleLeadRetryOrExhaust(attempt, <error>, 'failed')` — последний вариант с reason `'place_call_failed'`; vapi_call_id НЕ стампится; recordPlacement НЕ вызван. `vapi_config_missing` идёт в ladder → на исчерпании станет видимой задачей (N-5: технично и видимо, не молча).

### TC-OLC-026: ladder-ступени — +30m/+2h, slot_json не копируется
- **Приоритет:** P0 · **Тип:** worker jest · **Якорь:** §5.4, §18.1-worker, SC-02 · **FR/E:** FR-5, D1
- **Входные:** (a) attempt_no=1 fail (`no_answer`); (b) attempt_no=2 fail.
- **Ожидаемо:** шаг 1 — честный terminal: `UPDATE ... SET status=$2('no_answer'), reason=$3(≤120 симв.)` (освобождает partial-unique для следующего INSERT); шаг 4 — INSERT новой строки: identity скопирована (company_id, lead_uuid, 'lead_call', contact_id, phone), `attempt_no+1`, `'pending'`, `scheduled_at=computeLeadNextDueAt(justFailedNo,…)` (+30m для (a), +2h для (b), клэмп как в 007); **`slot_json` НЕ скопирован** (свежий расчёт на claim — намеренная дивергенция от parts); `logEvent('lead', uuid, 'outbound_lead_call_retry', {attemptNo, nextScheduledAt, outcome})`.

### TC-OLC-027: исчерпание после 3 — marker + task + event
- **Приоритет:** P0 · **Тип:** worker jest · **Якорь:** §5.4-5, §5.6, SC-02 · **FR/E:** FR-12, FR-9
- **Входные:** attempt_no=3 fail (`max_attempts=3` из resolve); вариант финального reason: (a) `no_answer`; (b) `no_slots`.
- **Ожидаемо:** INSERT marker-строки `(…, attempt_no=3, 'exhausted', now(), 'max_attempts_reached')`; `createLeadCallTask(companyId, lead, attempt, 'exhausted')` вызван РОВНО один раз; `logEvent('outbound_lead_call_exhausted', {attempts:3})`. Копия задачи: (a) title `Couldn't reach <Name> — 3 automated call attempts`; (b) title `Couldn't offer <Name> a time — appointment slots unavailable (3 attempts)` + описание про slot engine + `Please schedule manually.` (FR-9: задача называет НАСТОЯЩУЮ причину).

### TC-OLC-028: no-resurrection в ladder — blocked retry
- **Приоритет:** P1 · **Тип:** worker jest · **Якорь:** §5.4-2 · **FR/E:** FR-15, FR-6
- **Входные:** между dial и ladder: (a) лид получил `LeadDateTime`; (b) лид закрыт; (c) app отключён; (d) source выключен; (e) лид исчез.
- **Ожидаемо:** во всех — НЕТ следующего INSERT, НЕТ task; текущая строка сохраняет свой честный terminal-статус (шаг 1 уже прошёл); `logEvent('outbound_lead_call_retry_skipped', {attemptNo, outcome, blockedBy})` с blockedBy = `goal_achieved`/`app_disconnected`/`source_disabled`/`lead_not_found`; fail-open (throw внутри re-check не роняет webhook/worker).

### TC-OLC-029: ★ PARTS-REGRESSION SABOTAGE CONTROL — смешанный batch, byte-identical parts
- **Приоритет:** **P0 (критический gate)** · **Тип:** worker jest · **Якорь:** §6, §18.1-worker «CRITICAL», §19 protected · **FR/E:** FR-8 (parts byte-identical), constraints frontmatter
- **Предусловия:** golden-фикстура `tests/fixtures/parts-placecall-golden.json` захвачена с origin/master ДО фичи (см. «Стратегия моков»); мокнутый claim возвращает В ОДНОМ tick ДВЕ строки: `{scenario:'parts_visit', job_id:J, …}` и `{scenario:'lead_call', lead_uuid:L, …}`.
- **Шаги/Ожидаемо:**
  1. **(claim picks both)** claim-SQL не содержит фильтра по scenario (byte-неизменен против существующей сюиты `tests/outboundCallWorker.test.js`); обе строки попали в per-attempt loop одного tick.
  2. **(feature intact → parts unchanged — ГЛАВНЫЙ инвариант)** parts-строка прошла через REAL `processAttempt`; тело placeCall deep-equal golden-фикстуре (включая ОТСУТСТВИЕ ключей `scenario`/`leadUuid`/`zip`/`problemDescription`/`source` в variableValues и отсутствие `firstMessage` в assistantOverrides); lead-строка вызвала `processLeadAttempt` ровно один раз и НЕ вызвала `processAttempt`.
  3. **(lead branch sabotaged → parts UNCHANGED)** застабить `outboundLeadCallService.processLeadAttempt` на `throw new Error('SABOTAGE')` — прогнать tick: parts-исход по-прежнему deep-equal golden (worker-catch изолировал: lead-строка → `terminate('failed','worker_error:SABOTAGE')`, tick выжил, parts не задет); затем ВЫРЕЗАТЬ dispatch (симулировать отсутствие ветки: все строки → processAttempt) — parts-исход ВСЁ ЕЩЁ deep-equal golden.
  4. **(discrimination control)** при инвертированном условии диспатча (`!==` вместо `===`, jest-обёртка) КРАСНЕЮТ ОБА assert'а шага 2 (parts ушёл в lead-ветку — golden mismatch; lead не попал в processLeadAttempt) — тест доказуемо различает маршрутизацию, а не проходит вакуумно.
  5. Touch-2 регрессия: `getTimezoneOffsetMs` экспортирован из worker'а; экспортный объект worker'а в остальном не изменился (снимок ключей `module.exports`).

### TC-OLC-030: worker throw-isolation + зелёные parts-сюиты
- **Приоритет:** P1 · **Тип:** worker jest · **Якорь:** §6, §14 · **FR/E:** N-2
- **Шаги:** (a) `processLeadAttempt` бросает НЕОЖИДАННО посреди batch'а из 3 строк (lead, parts, lead) → tick доживает, `terminate(id,'failed','worker_error:…')` для упавшей, остальные обработаны; (b) прогнать БЕЗ ИЗМЕНЕНИЙ существующие сюиты `tests/outboundCallWorker.test.js`, `tests/outboundCallService.test.js`, `tests/confirmPartsVisit.test.js`, `tests/vapiCallStatusWebhook.test.js`.
- **Ожидаемо:** (a) ожидаемые сбои (no_slots, placement-fail) идут в ladder ВНУТРИ processLeadAttempt и НЕ доходят до worker-catch (нет task-спама от crash-path); (b) все четыре сюиты зелёные с нулевым диффом их файлов (git diff --name-only не содержит их).

### TC-OLC-031: placeCall — условные spread'ы (аддитивный describe в `tests/outboundCallService.test.js`)
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §7.1/7.2 · **FR/E:** FR-7, FR-8
- **Входные:** fetch-seam мокнут. (a) parts-аргументы (jobId+contactId non-null, БЕЗ scenario/firstMessage); (b) lead-аргументы (полный набор §7.1); (c) lead без zip/problemDescription/source; (d) slot без lat/lng.
- **Ожидаемо:** (a) wire-body: `variableValues` содержит `jobId`,`contactId` и НЕ содержит ни одного lead-ключа; `assistantOverrides` без `firstMessage` — JSON.stringify(body) === golden parts-строка (та же фикстура, что 029); (b) `scenario:'lead_booking'` (**prompt-var, НЕ db-значение `lead_call`** — discriminator-naming ловушка §7.1), `leadUuid`, slot-ключи `slotLabel/slotDate/slotStart/slotEnd/slotKey`, `lat`/`lng` из slot-объекта, `firstMessage` присутствует; `jobId`-ключа НЕТ на wire; (c) отсутствующие опции НЕ дают ключей (`zip`/`problemDescription`/`source` absent, не `undefined`); (d) без lat/lng-ключей. Секреты: Bearer не логируется (spy console); config-guards/transient-Twilio ветки не тронуты (существующие describes зелёные).

### TC-OLC-032: createLeadCallTask — exactly-once belt + per-kind копия
- **Приоритет:** P1 · **Тип:** worker jest · **Якорь:** §5.6 · **FR/E:** FR-12, SC-08
- **Входные:** (a) первый вызов kind='exhausted'; (b) повторный вызов при открытой задаче (belt-SELECT отдаёт строку); (c) kind='declined' c `extra.summary`; (d) belt: задача закрыта диспетчером + поздний дубль-webhook; (e) createTask бросает.
- **Ожидаемо:** (a) belt-SELECT `FROM tasks WHERE company_id=$1 AND subject_type='lead' AND subject_id=$2(lead.ClientId) AND agent_type='outbound_lead_call' AND status='open'`; `findOrCreateTimeline(attempt.phone, companyId)`; `createTask({threadId, subjectType:'lead', subjectId:ClientId, priority:'p1', createdBy:'agent', agentType:'outbound_lead_call'})` и БЕЗ `agentStatus` (agentWorker никогда её не заклеймит); description содержит per-attempt строки `Attempt N: status (reason) — ISO` (терминальные, без pending/dialing/exhausted) + закрывашку `Please follow up and book the appointment.`; (b) skip, лог `task_exists`, createTask НЕ вызван; (c) title `<Name> answered but didn't book — follow up` + `Call summary: <summary>` + `Please follow up personally.`; (d) belt по closed-задаче пропускает создание ПОВТОРНОЙ (доп. защита поверх AUTO-upsert — принятое платформенное поведение AR-TASK-UNIFY документировано, не «чинится»); (e) non-fatal — переход цепочки не сломан, warn.

### TC-OLC-033: E-6 — два РАЗНЫХ лида с одним телефоном
- **Приоритет:** P3 · **Тип:** worker jest · **Якорь:** E-6, §5.6-note · **FR/E:** FR-14(a) scope
- **Входные:** лиды L1≠L2, phone одинаковый; обе цепочки активны.
- **Ожидаемо:** guard ключуется `lead_uuid` — ОБЕ цепочки живут одновременно (второй INSERT не конфликтует); recordPlacement обеих попадает в ОДИН phone-keyed timeline; двойной прозвон одного человека = принятое v1 поведение (документировано); их exhaustion-задачи через AUTO-upsert сливаются в одну открытую задачу треда (документированное платформенное поведение — assert, не fix).

---

## Секция D — API-integration jest: webhook `/api/vapi/call-status` (supertest)

### TC-OLC-034: таблица классификации endedReason → исход
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §5.5, §8, §18.1-webhook · **FR/E:** FR-10, FR-11, E-16
- **Предусловия:** коррелируемая строка `lead_call` в статусе `dialing` (correlate-SELECT содержит `scenario, lead_uuid`); лид открыт, без холда.
- **Входные (end-of-call report, table-driven):** (1) лид С холдом (`LeadDateTime` set) + ЛЮБОЙ endedReason; (2) `customer-did-not-answer` → klass `no_answer`; (3) voicemail-reason → `voicemail`; (4) declined-reason → klass `declined`; (5) неизвестный/error endedReason → `failed`; (6) transient на attempt_no=3 (последняя ступень).
- **Ожидаемо:** (1) **booked-belt**: `UPDATE … SET status='booked'` — БЕЗ задачи, БЕЗ retry (chain закрыт успехом, FR-11); (2)/(3)/(5) → `scheduleLeadRetryOrExhaust(attempt, endedReason, klass)` — следующая ступень (+30m/+2h clamped); (4) → terminal `declined` + follow-up задача (детали в 036); (6) → exhausted-marker + ровно одна задача; (5) дополнительно пиняет E-16: до VAPI-PATCH'а analysisPlan человеческое «нет» классифицируется `failed` → ограничено max_attempts−1 лишними повторами (bounded, не бесконечно). Ответ всегда `200 {ok:true}`; parts booked-detection (`jobsService`-spy) НЕ вызывался ни в одном lead-кейсе.

### TC-OLC-035: CC-07-аналог — терминальная идемпотентность и replay
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §8 touch-2, §5.5 preamble, §18.1-webhook · **FR/E:** FR-11, FR-12
- **Входные:** (a) строка уже `booked` (mid-call flip от confirmLeadBooking) + приходит end-of-call report; (b) повторный ИДЕНТИЧНЫЙ transient-report после того, как (2) из 034 уже отработал (строка больше не `dialing`); (c) повторный report после exhausted.
- **Ожидаемо:** (a) 200 no-op на :236-гейте, `handleLeadEndOfCall` НЕ вызван, timeline-finalize ВСЁ РАВНО отработал (finalize идёт ДО идемпотентного гейта — порядок spy); (b) НЕТ второй ladder-строки (dup-доставка webhook не двоит ступени); (c) НЕТ второй задачи (в связке с belt 032). Ни один replay не отвечает 5xx.

### TC-OLC-036: declined — через klass и через structuredData.outcome
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §5.5-2, SC-08 · **FR/E:** FR-11
- **Входные:** (a) klass `declined` по endedReason; (b) klass `failed`, но `message.analysis.structuredData.outcome='declined'`; (c) то же с `outcome='callback'`; (d) `outcome='other'` + klass `no_answer`.
- **Ожидаемо:** (a)–(c) `UPDATE … status='declined', reason=…(≤120)`; `createLeadCallTask(…, 'declined', {summary: analysis.summary})` — задача с копией `<Name> answered but didn't book — follow up` + call summary; `logEvent('outbound_lead_call_declined')`; **НЕТ retry-INSERT** (человек сказал «нет» — не перезваниваем, FR-11); (d) обычный transient-путь (outcome вне {declined,callback} не терминалит).

### TC-OLC-037: webhook после disconnect/disable — E-10
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** §5.4-2, E-10 · **FR/E:** FR-15
- **Входные:** app отключён МЕЖДУ dial и report: (a) transient `no_answer`; (b) лид с холдом (booked-belt).
- **Ожидаемо:** (a) текущая строка получает честный terminal (`no_answer`), но retry заблокирован — `outbound_lead_call_retry_skipped` (blockedBy=app_disconnected), НЕТ новой строки, НЕТ задачи; timeline финализирован (in-flight звонок дописан); (b) `booked` записывается честно (холд реально лёг — исход не переписывается).

### TC-OLC-038: неизвестный call.id + status-update ветка
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** §8, SC-09 · **FR/E:** FR-13, FR-10
- **Входные:** (a) end-of-call report с `call.id`, не коррелирующимся ни с одной строкой; (b) `status-update` (in-progress) для lead-строки в `dialing`.
- **Ожидаемо:** (a) 200 no-op, ноль записей (никакого 500-шторма); (b) `applyStatusUpdate` вызван (live-pill живёт для lead-звонков бесплатно — ветка scenario-agnostic), НОЛЬ записей в attempts; company/lead берутся ТОЛЬКО из коррелированной строки, не из тела (anti-spoof — подставить в body чужой companyId → игнор).

### TC-OLC-039: webhook auth — fail-closed
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** §15 anti-spoof · **FR/E:** N-1
- **Входные:** (a) без `x-vapi-secret`; (b) с неверным; (c) env-секрет не сконфигурирован.
- **Ожидаемо:** (a)/(b) 401, (c) 503 (существующий middleware, fail-closed) — lead-ветка недостижима без секрета; ноль db-вызовов классификации.

### TC-OLC-040: sabotage-webhook — таблица 034 умеет краснеть
- **Приоритет:** P2 · **Тип:** API-integration jest · **Якорь:** house-rule sabotage · **FR/E:** FR-10 (контроль)
- **Шаги:** застабить `classifyEndedReason` на константу `'failed'` (jest.spyOn route-модуля/обёртка) → прогнать фикстуры (2)/(3) из 034.
- **Ожидаемо:** assert'ы на `no_answer`/`voicemail` в записанном статусе ПАДАЮТ (детектор различает исходы, а не «какой-то terminal»); после restore — зелёные.

---

## Секция E — unit jest: скилл `confirmLeadBooking`

### TC-OLC-041: injected identity — precedence spread-last, отказ без identity
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §9.2-1, §15, §18.1-skill · **FR/E:** FR-7, N-1
- **Входные:** (a) input, собранный ПО ПОРЯДКУ buildSkillInput (model-args СНАЧАЛА, injected variableValues СВЕРХУ): model прислал `{leadUuid:'EVIL', companyId:'EVIL', slotKey:'EVIL', chosenSlot:…}`, injected несёт настоящие `leadUuid/companyId/slotKey`; (b) injected `leadUuid` отсутствует; (c) injected `companyId` отсутствует; (d) transport-аргумент `run(companyId=DEFAULT_COMPANY_ID,…)` ≠ injected `src.companyId`.
- **Ожидаемо:** (a) бронирование идёт против НАСТОЯЩЕГО лида (getLeadByUUID вызван с injected-значениями — EVIL нигде не всплывает); (b)/(c) `resultShapes.refusal("I couldn't pull up your request to book — let me have a teammate follow up with you.")`, НОЛЬ reads/writes; (d) скоупинг ТОЛЬКО по `src.companyId` — transport-аргумент не используется (assert по параметрам моков).

### TC-OLC-042: slotKey match → hold на ТОМ лиде, БЕЗ engine-вызова
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §9.2-3/5, SC-01 · **FR/E:** FR-8
- **Входные:** `chosenSlot {date,start,end}` c `derivedKey === src.slotKey` (pre-dial слот); лид открыт; координаты src.lat/lng присутствуют.
- **Ожидаемо:** `recommendSlots` НЕ вызван; `updateLead(leadUuid, {LeadDateTime: tzCombine(date,start,tz), LeadEndDateTime: tzCombine(date,end,tz), Latitude, Longitude}, cid)` — byte-shape bookOnLead; координаты both-or-nothing (одна → ни одной); attempt-flip `UPDATE … SET status='booked' … WHERE company_id=$1 AND lead_uuid=$2 AND status='dialing'`; `logEvent('lead_slot_held', {window, actor:'AI Phone', scenario:'lead_call'})`; ответ `resultShapes.ok("You're all set — I've got you down for <windowPhrase>. A dispatcher will confirm shortly.", {success:true, booked:true, bookedWindow, leadId})`. Никакого job/нового лида/ZB/FSM (соответствующие моки не тронуты).

### TC-OLC-043: mismatch → engine re-validation; fail-closed refusal
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §9.2-3, §15 booking-guard · **FR/E:** FR-8
- **Входные:** `derivedKey ≠ src.slotKey` (in-call альтернатива): (a) engine `{available:true, slots:[{key:derivedKey,…}]}` (targetDay=slot.date передан); (b) engine `{available:false, fallback:true}` (SLOT_FALLBACK); (c) engine slots без совпадающего key; (d) engine бросает.
- **Ожидаемо:** (a) бронирует (live re-validation прошла); (b)/(c)/(d) `resultShapes.refusal("Let me have a teammate confirm that time and follow up with you shortly.")` — **fail-closed**: `updateLead` НЕ вызван, flip НЕ вызван, никакого false success. Форма refusal — точная (message + отсутствие `success:true`).

### TC-OLC-044: tenant isolation + закрытый лид
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §9.2-4, §15 · **FR/E:** N-1
- **Входные:** (a) `getLeadByUUID(leadUuid, cid)` → not-found (чужая компания / нет лида — неразличимо); (b) лид `Status:'Lost'`/`'converted'`.
- **Ожидаемо:** (a) refusal `"I couldn't find that request on file — let me have a teammate follow up with you."` — cross-company НЕОТЛИЧИМ от missing (нет оракула существования); (b) refusal `"That request is already closed — let me have a teammate follow up with you."`; в обоих — ноль writes.

### TC-OLC-045: malformed slot / сбои записи — no false success
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** §9.2-2/5 · **FR/E:** FR-8, N-2
- **Входные:** (a) `chosenSlot` отсутствует / не объект / без end; (b) отрицательный span (`end ≤ start` — `slotSpanIsPositive` false); (c) `tzCombine` бросает; (d) `updateLead` бросает.
- **Ожидаемо:** (a)/(b) refusal `"Let's lock in a time first — which window works best for you?"` c `{needsConfirmation:true}`; (c)/(d) refusal `"I had trouble locking that time in — let me have a teammate confirm it with you."` — записи нет, success нет.

### TC-OLC-046: идемпотентный double-confirm + non-fatal flip
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** §9.2-6/7, CC-07 · **FR/E:** FR-8, FR-11
- **Входные:** (a) второй вызов с ТЕМ ЖЕ slot после успешного первого (лид уже с холдом, attempt уже `booked` → flip-UPDATE матчит 0 строк); (b) flip-UPDATE бросает; (c) `logEvent` бросает.
- **Ожидаемо:** (a) повторный success (перезапись того же холда — идемпотентна по эффекту), flip 0-rows НЕ ошибка, дубль-задач/строк нет; (b)/(c) `console.error`/warn only — ответ ВСЁ РАВНО success (холд уже лёг; webhook добьёт booked через belt 034-1). ⚠️ Зафиксировать в тесте документируемое поведение: double-confirm с ДРУГИМ слотом в том же звонке перезаписывает холд (customer передумал mid-call) — spec-gap, см. шапку отчёта.

### TC-OLC-047: sabotage-skill — offered-guard умеет краснеть
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** house-rule sabotage · **FR/E:** FR-8 (контроль)
- **Шаги:** симулировать вырезанный offered-guard: обёртка, подменяющая сравнение `derivedKey === src.slotKey` на `true` (или mock recommendSlots → всегда `{available:true, slots:[{key:derivedKey}]}` при фикстуре (b) из 043).
- **Ожидаемо:** detector-assert 043(b) («updateLead НЕ вызван при SLOT_FALLBACK») ПАДАЕТ на саботированной версии — доказано, что fail-closed-тест не вакуумный; после restore зелёный.

---

## Секция F — API-integration jest: settings-роуты `/api/outbound-lead-caller/settings`

### TC-OLC-048: 401 / 403
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §10.1/10.4 · **FR/E:** N-4
- **Шаги:** (a) REAL `authenticate`, без токена и с мусорным токеном — GET и PUT; (b) auth-stub БЕЗ `tenant.integrations.manage`.
- **Ожидаемо:** (a) 401; (b) 403; в обоих — НОЛЬ db-вызовов (моки legs не тронуты).

### TC-OLC-049: GET — сборка ответа + дефолты первого подключения
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** §10.2, SC-07 · **FR/E:** FR-2, D5, N-6
- **Предусловия:** нет строки settings; installations → connected; leads company_sources = `['Pro Referral','Google']`; attempts 30d = booked×4, no_answer×7 (+ строка `parts_visit`, которая НЕ должна попасть).
- **Ожидаемо:** `200 {ok:true, data:{settings:{enabled_sources:['ProReferral'], max_attempts:3, backoff_schedule:['immediate','+30m','+2h'], updated_at:null}, installed:true, install_status:'connected', company_sources:['Google','Pro Referral'], recent:[…]}}` — **ProReferral преселектнут из DEFAULTS** (D5); company_sources — DISTINCT, non-empty, ORDER BY, LIMIT 100; recent-запрос фильтрует `scenario='lead_call'` И `created_at >= now()-30d` (parts-строки не в rollup'е); settings-leg через `get` (может бросить → 500 `{ok:false,error:{code:'INTERNAL'}}` — `resolve` только для worker'а).

### TC-OLC-050: PUT — валидация + normalized dedup
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §10.3, §18.1-routes · **FR/E:** FR-2
- **Входные:** body `enabled_sources`: (a) не массив (`'ProReferral'`/`{}`/отсутствует); (b) 51 элемент; (c) `['ok','']` и `['ok','   ']`; (d) элемент 81 символ; (e) `['Pro Referral','ProReferral','  pro referral ']`; (f) `[]`; (g) `['SomeBrandNewSource']`; (h) не-строковый элемент `[42]`.
- **Ожидаемо:** (a)–(d),(h) → `400 {ok:false, error:{code:'VALIDATION', message}}`, БЕЗ записи; (e) → 200, сохранён ОДИН label — ПЕРВЫЙ display-вариант `'Pro Referral'` (dedup по normalizeSource, хранится display, матчинг нормализует обе стороны); (f) → 200 — пустой массив ВАЛИДЕН (app connected, ноль источников: новые цепочки не стартуют, queued отменит claim-re-check FR-15); (g) → 200 — **whitelist'а нет по спеке** (§10.3: любой непустой ≤80; произвольный label допустим — документированное решение, см. spec-gap в отчёте); ответ `{ok:true, data:{settings}}` через `saveSources`-upsert.

### TC-OLC-051: изоляция тенантов — companyFilter only
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §10.1, §15 · **FR/E:** N-1
- **Шаги:** auth-stub `companyFilter.company_id=COMPANY_A`; GET с `?company_id=B`; PUT с body `{company_id:'B', enabled_sources:[…]}`.
- **Ожидаемо:** ВСЕ захваченные db-параметры (4 GET-лега: settings, install, company_sources, recent; PUT-upsert) получили строго COMPANY_A; данных B в ответе нет; body/query company_id игнорируются полностью.

### TC-OLC-052: disconnect — installed:false, настройки НЕ стираются
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** §10.2, SC-07, §5.2-1/§5.3-3 · **FR/E:** FR-15, FR-14(b)
- **Предусловия:** строка settings существует (`['Google']`); installations-leg → нет connected-строки.
- **Ожидаемо:** GET → `installed:false, install_status:null`, settings при этом возвращаются как сохранены — **по спеке disconnect НЕ вайпит строку settings**; «disable»-поведение реализовано gate'ами (новые цепочки блокирует §5.2-1 — TC-OLC-012; queued отменяет §5.3-3 — TC-OLC-021), не удалением данных. Реконнект возвращает прежний выбор источников.

### TC-OLC-053: PUT round-trip + отсутствие retro-processing
- **Приоритет:** P2 · **Тип:** API-integration jest · **Якорь:** §10.3 · **FR/E:** FR-2
- **Шаги:** PUT `['Google']` → GET; проверить, что PUT не трогает `max_attempts`/`backoff_schedule` (upsert только enabled_sources) и не вызывает НИКАКОЙ обработки существующих лидов/attempts (ноль вызовов сервиса цепочек).
- **Ожидаемо:** GET отдаёт `['Google']`, ladder-колонки нетронуты (DB-editable only v1); изменение действует только на события ПОСЛЕ записи (ретро-диала нет — конструктивно: единственный триггер = lead.created).

### TC-OLC-054: sabotage-routes — изоляция умеет краснеть
- **Приоритет:** P2 · **Тип:** API-integration jest · **Якорь:** house-rule sabotage · **FR/E:** N-1 (контроль)
- **Шаги:** параметр-чекер из 051 (каждый db-вызов обязан получить COMPANY_A) прогнать против сфабрикованного лега, читающего `req.body.company_id` (стаб-хендлер в тестовом app, симулирующий срезанный companyFilter).
- **Ожидаемо:** чекер ПАДАЕТ (COMPANY_B пойман в параметрах) — детектор реально ловит утечку скоупа; честный роут — зелёный.

---

## Секция G — миграции 172/173

### TC-OLC-055: mig 172 — shape-ассерты + rollback-порядок (файловый тест)
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §2.2, §18.1 · **FR/E:** FR-5, FR-14(a)
- **Шаги:** прочитать `backend/db/migrations/172_outbound_lead_call.sql` + rollback как текст (precedent `tests/timeOffMigration.test.js`).
- **Ожидаемо (forward):** `ALTER COLUMN job_id DROP NOT NULL`; `ADD COLUMN IF NOT EXISTS scenario TEXT NOT NULL DEFAULT 'parts_visit'`; `lead_uuid VARCHAR(20) REFERENCES leads(uuid) ON DELETE CASCADE`; CHECK `chk_outbound_call_attempts_scope` с ОБОИМИ плечами (`scenario='lead_call' AND lead_uuid IS NOT NULL` / `scenario<>'lead_call' AND job_id IS NOT NULL`); `CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_call_attempts_active_lead ON outbound_call_attempts (lead_uuid) WHERE status IN ('pending', 'dialing') AND lead_uuid IS NOT NULL`; `idx_outbound_call_attempts_lead`; таблица `outbound_lead_call_settings` c дефолтами `'["ProReferral"]'`, `3`, `'["immediate","+30m","+2h"]'` + updated_at-триггер. **Негативные grep'ы:** файл НЕ упоминает `uq_outbound_call_attempts_active_job` (кроме комментария), НЕ трогает `outbound_call_settings` (parts-таблица). **Rollback:** `DELETE FROM outbound_call_attempts WHERE scenario='lead_call'` идёт РАНЬШЕ `ALTER COLUMN job_id SET NOT NULL` (позиция в тексте); дропает только объекты фичи. **Numbering:** ровно один `172_*` forward-файл — наш, rollback существует, `171_*` существует (нет дыры). **БЕЗ проверки максимальности номера** — глобальный tripwire «no duplicate forward-migration numbers ≥ 100» уже живёт в `tests/timeOffMigration.test.js` (TC-DO-29) и ловит коллизию параллельных worktree — не дублировать (TIMELINE-REVPAGE-урок: point-in-time «is maximal» ломается на каждой следующей миграции).

### TC-OLC-056: mig 173 — seed-идемпотентность + boot-регистрация, БЕЗ auto-install
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** §2.3/2.4 · **FR/E:** FR-1
- **Ожидаемо (файл 173):** INSERT в `marketplace_apps` с `app_key='outbound-lead-caller'`, `provider_name='Albusto'`, `category='lead_generation'`, `app_type='internal'`, `provisioning_mode='none'`, `status='published'`, `metadata.setup_path='/settings/integrations/outbound-lead-caller'`, `requires_credential_input:false`; `ON CONFLICT (app_key) DO UPDATE SET` покрывает КАЖДУЮ засеянную колонку + `updated_at=NOW()` (boot-reseed идемпотентен); **негативный grep: НЕТ INSERT в `marketplace_installations`** (connect — действие владельца, в отличие от mig 170). **Boot-регистрация (`backend/src/db/marketplaceQueries.js`):** строка `readMigration('173_seed_outbound_lead_caller_marketplace_app.sql')` присутствует в `ensureMarketplaceSchema` ПОСЛЕ строки 170 (ordering-правило 083); **172 в этом списке НЕТ** (DDL не боот-реплеится). Rollback_173 = только `DELETE FROM marketplace_apps WHERE app_key='outbound-lead-caller'`. Copy-ассерты: строки seed'а не содержат «Blanc» (N-7).

### TC-OLC-057: real-DB поведение миграций (house-lesson: индексы/CHECK доказываются живым PG)
- **Приоритет:** P1 · **Тип:** manual-stand · **Якорь:** §2, §18.3-1 · **FR/E:** FR-14(a)
- **Шаги (dev-БД, НИКОГДА не прод):** применить 172+173 дважды (идемпотентность IF NOT EXISTS/ON CONFLICT); psql-проверки: (a) существующие parts-строки валидны под CHECK (scenario='parts_visit' default + job_id NOT NULL); (b) INSERT lead_call без lead_uuid → CHECK violation; (c) parts-строка без job_id → CHECK violation; (d) две активные (`pending`) строки одного lead_uuid → unique violation по `uq_outbound_call_attempts_active_lead`; terminal+pending — ОК; (e) вторая активная parts-строка одного job_id по-прежнему блокируется старым guard'ом (не сломан); (f) DELETE лида каскадит его attempt-строки (FK); (g) rollback_172 на БД С lead-строками проходит (DELETE раньше SET NOT NULL), re-apply чист; rollback_173 удаляет tile.
- **Ожидаемо:** все ассерты зелёные; ошибки (b)–(e) — именно constraint-нарушения, не иные.

---

## Секция H — manual-stand (dev, §18.3 формализован)

### TC-OLC-058: E2E happy-path на стенде + safe-fail без VAPI env + sabotage-шаг S
- **Приоритет:** P0 · **Тип:** manual-stand · **Якорь:** §18.3-2/3, SC-01, SC-09 · **FR/E:** FR-3, FR-7, FR-13, N-3, N-5
- **Предусловия:** миграции применены; `FEATURE_OUTBOUND_CALL_WORKER=true`; app подключён, ProReferral включён; VAPI-слой НЕ живой: `placeCall` замокан/направлен на мок-сервер (canned `{id:'vapi_call_mock'}`); slot-engine доступен (или recommendSlots застаблен валидным слотом).
- **Шаги:** 1) создать лид `JobSource:'Pro Referral'` + 10-значный телефон (UI или POST /leads) → строка `outbound_call_attempts` (scenario `lead_call`, `pending`, due≈now, job_id NULL); 2) дождаться tick'а (≤ ~60 с — замерить, N-3) → `dialing`, стампованы `vapi_call_id`+`slot_json`, в Pulse на phone-треде живая строка «Ringing» (recordPlacement); 3) симулировать in-call booking: вызвать `confirmLeadBooking` через vapi-tools seam (POST `/api/vapi-tools` с `x-vapi-secret`, toolCall `confirmLeadBooking{chosenSlot=top-slot}` + injected variableValues `{leadUuid, companyId, slotKey}` в message.call) ИЛИ node-скриптом `run()` с тем же input → **холд виден на карточке лида** (LeadDateTime-окно), attempt `booked`; 4) форжнуть end-of-call report (`x-vapi-secret`) → 200 no-op (CC-07), Pulse-строка финализируется (transcript/summary из форжа); 5) **суб-кейс N-5:** снять VAPI env (`VAPI_API_KEY`) → новый лид → attempt падает `failed`/`vapi_config_missing` → ladder-строка +30m (clamped); лог явный, ничего не исчезло молча. **Шаг S (sabotage):** `FEATURE_OUTBOUND_CALL_WORKER=false` + новый eligible-лид → чек «dialing ≤60s» ОБЯЗАН провалиться (строка вечно `pending`) → вернуть флаг, чек снова зелёный — стендовая проверка доказуемо наблюдает worker, а не вакуум.
- **Ожидаемо:** цепочка `pending→dialing→booked`; холд на ЛИДЕ (не job, не ZB — проверить отсутствие ZB-вызовов/новых jobs); Pulse-строка live→finalized; N-3 в норме.

### TC-OLC-059: marketplace connect + settings page (UX/canon)
- **Приоритет:** P0 · **Тип:** manual-stand · **Якорь:** §11, §18.3-1, SC-07 · **FR/E:** FR-1, FR-2, N-7
- **Шаги:** каталог → tile «Outbound Lead Caller» (из seed 173); Connect (без credential-шага — `provisioning_mode='none'`); Configure → `/settings/integrations/outbound-lead-caller`; осмотреть секции; сохранить выбор; отключить app.
- **Ожидаемо:** «Pro Referral» и «ProReferral» отрисованы ОДНОЙ строкой (канон-label предпочтён) и она преселектнута; опция, нормализующаяся в `'aiphone'`, в списке ОТСУТСТВУЕТ; у Yelp-строки hint `Yelp leads are already handled by the email booking agent — enabling calls runs both.`; Save → toast; «Last 30 days» — StatChip только по присутствующим статусам (пустых состояний нет); «How it works» — копия из §11.2; язык английский, бренд Albusto, НИГДЕ не «Blanc»; Checkbox-канон (label рядом, не floated); disconnect → страница показывает connect-CTA, настройки при реконнекте сохранены (052).

### TC-OLC-060: стенд — ladder/exhaustion/decline + негативный gauntlet
- **Приоритет:** P1 · **Тип:** manual-stand · **Якорь:** §18.3-3/4/5/6, SC-02/04/05/06/07/08 · **FR/E:** FR-5, FR-6, FR-12, FR-14, FR-15
- **Шаги/Ожидаемо:** 1) форжить `no_answer`-report трижды (между ступенями подгонять `scheduled_at=now()` psql'ом) → ступени +30m/+2h (clamped), после 3-й — `exhausted`-marker + **РОВНО ОДНА** p1-задача на лиде (видна в Tasks/AR, открывает карточку лида, description с per-attempt строками); повторный форж после exhausted → задача НЕ дублируется; 2) decline-форж (analysis.structuredData.outcome='declined' + summary) на свежей цепочке → `declined` + follow-up задача с summary, БЕЗ новой ступени; 3) Thumbtack-лид → ничего (ни строки, ни trace); 4) phoneless ProReferral-лид → Comments-trace `[AI Phone] … no phone number …`, цепочки нет; 5) лид при отключённом app → ничего; реконнект → этот лид НИКОГДА не набирается (no backfill); 6) выставить LeadDateTime вручную между ступенями → следующий claim даёт `canceled`/`goal_achieved:hold_set` (SC-04); 7) PUT `enabled_sources:[]` при queued-строке → следующий tick `canceled`/`source_disabled`.

### TC-OLC-061: стенд — out-of-hours (SC-03) и carry
- **Приоритет:** P1 · **Тип:** manual-stand · **Якорь:** §18.3, SC-03 · **FR/E:** FR-4, D2
- **Шаги:** выставить dispatch-settings так, чтобы now вне окна (или work_days без сегодня); создать eligible-лид; наблюдать строку и tick; затем `OUTBOUND_CALL_IGNORE_BUSINESS_HOURS=true` (dev-only) и повторить.
- **Ожидаемо:** `scheduled_at` = следующий старт окна в TZ КОМПАНИИ (сверить арифметику вручную); tick НЕ набирает (и не дропает — строка `pending`); с toggle — набирает немедленно; вернуть toggle. Проверить также carry уже-заклеймленной строки: подогнать `scheduled_at=now()` вне окна → строка возвращена в `pending` на след. старт окна.

### TC-OLC-062: стенд — parts-робот жив + gates (jest + FE build)
- **Приоритет:** P0 · **Тип:** manual-stand · **Якорь:** §18.3-7, §19 · **FR/E:** FR-8 (parts byte-identical), N-2
- **Шаги/Ожидаемо:** 1) на ТОМ ЖЕ стенде прогнать Part-arrived-цепочку (кнопка robot_call) → поведение идентично до-фичевому (dial, классификация, ступени parts-ladder `immediate/+2h/next_business_morning`); 2) смешанный tick: parts-строка и lead-строка due одновременно → обе обработаны в один проход; 3) **gates:** `npx jest tests/outboundLeadCall* tests/confirmLeadBooking* backend/tests/outboundLeadCall* --testPathIgnorePatterns "/node_modules/"` зелёный И пре-существующие `tests/outboundCallWorker.test.js` / `tests/outboundCallService.test.js` / `tests/vapiCallStatusWebhook.test.js` / `tests/confirmPartsVisit.test.js` зелёные БЕЗ единого диффа их файлов; `cd frontend && npm run build` (tsc -b, прод-строгость noUnusedLocals) зелёный.

---

## Секция I — owner-smoke-prod (деплой + VAPI PATCH только по явному «да» владельца)

### TC-OLC-063: прод-смоук после деплоя + §17 PATCH
- **Приоритет:** P0 · **Тип:** owner-smoke-prod · **Якорь:** §17-5/7, §18.3-8, deploy-consent · **FR/E:** FR-7, FR-8, FR-10, FR-13, D4, N-3
- **Предусловия:** прод-деплой по стандартной процедуре; VAPI PATCH по §17 выполнен (GET→merge→PATCH, секрет re-injected, mirror закоммичен); **до включения** — аудит `SELECT id, name, trigger_event FROM automation_rules WHERE trigger_event='lead.created';` разобран с владельцем (§17-7).
- **Шаги/Ожидаемо:** 1) тестовый ProReferral-лид с телефоном владельца в рабочие часы → звонок ≤ ~1 мин; **greeting подставил живые значения** — Sara называет имя и конкретное окно, В ЭФИРЕ НЕТ буквальных `{{customerName}}`/`{{slotLabel}}` (arch-risk 2; если токены не подставились — активировать server-side интерполяцию §7.3 и повторить); Sara НЕ здоровается второй раз, ссылается на source и проблему, НЕ переспрашивает известные данные; 2) согласиться на слот → холд виден на лиде (окно), цепочка `booked`, Pulse-строка с recording/transcript/summary; ZB/джобов не создано; 3) второй тест-лид → отказаться («I'll call back») → в end-of-call report присутствует `structuredData.outcome` (§17-5b), цепочка `declined`, диспетчерская задача с summary, ПЕРЕзвона нет; 4) третий тест-лид → не брать трубку → ступень +30m видна в БД (можно погасить disconnect'ом после проверки); 5) parts-робот: один живой Part-arrived звонок — сценарий parts не изменился (greeting parts-скрипта, booking через confirmPartsVisit); 6) rollback-рычаг проверен документально: disconnect app останавливает новые цепочки и queued (FR-15) без деплоя; 7) метрики: `SELECT status, count(*) FROM outbound_call_attempts WHERE scenario='lead_call' GROUP BY status;` и settings-страница «Last 30 days» согласуются.

---

## Матрица покрытия FR/N/D → TC

| Требование | Тест-кейсы |
|---|---|
| FR-1 (marketplace app) | 056, 057, 059 |
| FR-2 (settings sources, normalized) | 001, 013, 049, 050, 052, 053, 059 |
| FR-3 (trigger + trace) | 003, 011, 012, 013, 014, 017, 058 |
| FR-4 (immediate + window, carry not drop) | 004, 005, 006, 008, 009, 017, 022, 061 |
| FR-5 (scenario-scoped ladder) | 002, 007, 025, 026, 055, 060 |
| FR-6 (goal-achieved skip) | 015, 020, 028, 060 |
| FR-7 (placement + injected context) | 024, 031, 041, 063 |
| FR-8 (same Sara / booking on THE lead / parts byte-identical) | 024, **029**, 042, 043, 046, 062, 063 |
| FR-9 (pre-computed slot, never empty-handed) | 023, 027, 060 |
| FR-10 (outcome classification) | 034, 040, 063 |
| FR-11 (ladder vs terminal; declined no-redial) | 034, 035, 036, 037 |
| FR-12 (exhaustion task exactly-once) | 027, 032, 035, 060 |
| FR-13 (Pulse visibility) | 024, 038, 058, 063 |
| FR-14 (idempotency + no backfill + lifetime-once) | 012, 016, 033, 057, 060 |
| FR-15 (disconnect/source-off mid-chain) | 021, 028, 037, 050(f), 052, 060 |
| N-1 (tenancy) | 038, 039, 041, 044, 051, 054 |
| N-2 (safe-fail worker) | 018, 028, 030, 045 |
| N-3 (≤60s latency) | 058, 063 |
| N-4 (permissions) | 048 |
| N-5 (vapi_config_missing visible) | 025, 058 |
| N-6 (machine-readable reasons / rollup) | 012–017, 020–022, 049 |
| N-7 (English/Albusto/canon) | 056, 059 |
| D1 (ladder 3×) | 007, 026, 027 |
| D2 (dispatch-settings window, не groupRouting) | 004–009, 022, 061 |
| D3 (no takeover; goal-exception only) | 020, 028 |
| D4 (same assistant, scenario var) | 024, 031, 063 |
| D5 (ProReferral launch default) | 001, 049, 059 |
| E-1/E-8 (no location / zero slots) | 023 |
| E-2 (foreign phone) | 003 |
| E-3/E-4 (disconnect / reconnect no backfill) | 021, 060 |
| E-5 (dup deliveries) | 016 |
| E-6 (same phone, two leads) | 033 |
| E-7/E-15 (malformed hours / no dispatch row) | 009, 018 |
| E-9/E-14 (VAPI errors / env missing) | 025, 058 |
| E-10 (webhook after disable) | 037 |
| E-11 (lead deleted mid-ladder) | 020, 057(f) |
| E-12 (DST) | 008 |
| E-13 (born booked/closed) | 015 |
| E-16 (analysisPlan not patched) | 034(5) |
| E-17 (dispatch-settings throw) | 018 |
| E-18 (comments-append fail) | 014 |
| SC-01..SC-09 | 024/042/058 · 026/027/060 · 005/061 · 020/060 · 014/060 · 013/060 · 021/052/059/060 · 036/060 · 024/038/058 |

## Порядок прогона (рекомендация Tester-агенту)
1. Секция A (чистые функции; сначала sabotage-самопроверка 010) → 2. Секция B (019 sabotage → матрица) → 3. Секция C (**029 первым** — если parts-golden красный, дальше идти нельзя) → 4. Секция D (webhook) → 5. Секция E (skill) → 6. Секция F (routes) → 7. G-файловые (055/056) → 8. Гейты 062-3 (полный jest + FE build) → 9. Стенд: 057 (миграции real-DB) → 058 (E2E + шаг S) → 059/060/061 → 062-1/2 (parts на стенде) → 10. TC-OLC-063 только после владельческого «да» на деплой + PATCH.
