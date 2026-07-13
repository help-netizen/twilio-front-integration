# Тест-кейсы: TIMELINE-REVPAGE-001 — messenger-паджинация Pulse-ленты (reverse cursor, 20 merged items, bottom-anchor, sticky AR-бар)

**Спецификация:** `docs/specs/TIMELINE-REVPAGE-001.md` (§15 задаёт анкеры **T-1..T-12 / H-1..H-7 / N1 / N2-1..10** — здесь они формализованы и расширены, id сохранены) · **Требования:** `docs/requirements.md § TIMELINE-REVPAGE-001` (FR-01..FR-15, N1–N3) · **Дата:** 2026-07-13
**Dedup:** прежних тест-кейсов на детальную ленту нет; LIST-PAGINATION-001 покрывает ТОЛЬКО левый список (`getUnifiedTimelinePage`) — пересечения нет.

### Покрытие
- Всего: **53**
- **P0: 26 | P1: 23 | P2: 3 | P3: 1**
- **unit jest: 13** (секция A) | **API-integration jest: 15** (секция B) | **harness-script: 12** (секция C) | **manual-browser: 13** (секция D)
- **Sabotage / negative control** (домашнее правило: минимум один кейс на слой, ОБЯЗАННЫЙ провалиться при заглушенной фиче): TC-TRP-013 (unit), TC-TRP-033 (API), TC-TRP-H10 (harness), TC-TRP-M07 шаг S (manual)

### Файлы тестов
- `tests/timelinePage.test.js` — секция A (чистый модуль `backend/src/services/timelinePage.js`; НОЛЬ моков — модуль без импортов)
- `tests/pulseTimelinePageRoute.test.js` — секция B (REAL `routes/pulse.js` + mini-express + supertest, mocked db)
- `backend/scripts/verify-timeline-revpage.mjs` — секция C (прод-копия БД, env `DATABASE_URL`; ЛОВУШКА: скриптов нет в Docker-образе — `scp` + `docker cp` для серверного прогона)
- Секция D — живой preview (real browser), desktop 1280 + mobile 375 (N2; house-lesson: только живой рендер ловит scroll/anchor-поведение)

### Стратегия моков (секция B)
jest-mock `backend/src/db/connection`: `db.query` диспетчеризуется **по SQL-паттерну** (substring: `FROM calls` / discovery-`UNION` / `FROM estimates` / `FROM invoices`), НЕ по порядку вызовов — леги идут `Promise.all`. jest-mock `conversationsQueries` (`getMessagesPageDesc` + legacy `getMessages`), `emailQueries` (DESC-твины + legacy ASC), `contactsService.getContactEmails`. REAL `routes/pulse.js`, REAL `services/timelinePage.js` (чистый модуль не мокается). REAL `authenticate` только для 401-кейсов; остальное — auth-stub (конфигурируемые `permissions`, `companyFilter.company_id = COMPANY_A`). Для walk-кейсов лег-фейки честно применяют `{limit, cursorPred}` к in-memory фикстуре (фильтр по предикату + sort DESC + slice — симуляция SQL). В SMS-фикстурах `date_created_remote = created_at` — нейтрализует задокументированное расхождение ключа сортировки (§3.2), чтобы jest-сравнение с legacy сходилось точно; реальное расхождение меряет harness (H01). Внешние API (Twilio/Gmail/Stripe/ZB) не вызываются нигде.
**JEST GOTCHA** (JOBS-UX-RBAC-001): прогон из worktree — проверить `testPathIgnorePatterns` корневого `package.json`.

---

## Секция A — unit jest: чистый модуль `timelinePage.js` (`tests/timelinePage.test.js`)

### TC-TRP-001: cursor roundtrip, включая µs-точность
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** T-1 · **FR/INV:** FR-01, INV-11
- **Входные:** `encodeCursor→parseCursor` для (a) digit-id `{ts:'2026-07-12T18:22:01.123456Z', k:0, id:'8412'}`; (b) uuid-id, k=1; (c) financial k=3 `id:'33'` (числовая часть, БЕЗ префикса `estimate-`); (d) µs-хвосты `.000210` и `.999999`.
- **Ожидаемо:** deep-equal вход/выход во всех вариантах; µs не теряются (никакого `Date` на пути); выход — валидный base64url (без `=`/`+`/`/`).

### TC-TRP-002: malformed cursor → типизированная ошибка
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** T-2 · **FR/INV:** FR-01, §3.1, INV-11
- **Входные (каждый — отдельный assert):** не-base64url; base64url не-JSON; JSON-массив; `v:2`; `v` отсутствует; `k:-1`; `k:5`; `k:'1'` (строка); ts с ms-точностью (3 знака дроби); ts без `Z`; ts с `+00:00`; `id:''`; id 41 символ; id с `../`; id с `;`; вход `null` / `42` / пустая строка.
- **Ожидаемо:** каждый бросает `InvalidCursorError` (или `.code==='INVALID_CURSOR'`) — НЕ generic throw; ни один не возвращает объект. Uppercase-hex uuid в `id` — ВАЛИДЕН (regex `^[0-9a-fA-F-]{1,40}$` допускает A-F).

### TC-TRP-003: compareDesc — kind-rank tie на ИДЕНТИЧНОМ µs ts, все 5 kinds
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** T-3 · **FR/INV:** FR-01, §3.3–3.4, INV-10
- **Входные:** 5 элементов, по одному каждого kind, все с ts `2026-07-12T12:00:00.000001Z`.
- **Ожидаемо:** DESC-поток строго `call, sms, email, estimate, invoice` (rank ASC внутри равного µs); элемент с ts `.000002Z` любого kind — впереди всех `.000001Z` (µs доминирует над rank).

### TC-TRP-004: compareDesc — id DESC внутри kind (digit-числовое, uuid-строковое)
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** T-3 · **FR/INV:** FR-01, §3.4
- **Входные:** равный ts + равный kind: (a) digit-ids `'9'` vs `'10'`; (b) сверхдлинные digit-ids `'99999999999999999'` vs `'100000000000000000'` (>2^53 — ловит наивный `Number()`); (c) uuid `'f0…'` vs `'a1…'`.
- **Ожидаемо:** (a) `'10'` первым; (b) `'100000000000000000'` первым (длиннее строка → больше; равная длина → лексикографика; без BigInt); (c) `'f0…'` первым (lowercase-строковое сравнение) — идентично PG `bigint`/`uuid`.

### TC-TRP-005: predicateModeFor — полная матрица
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** T-4 · **FR/INV:** FR-01, §3.5
- **Входные:** 5 kinds × cursor `k∈0..4` + cursor `null`.
- **Ожидаемо:** `KIND_RANK[S] > C.k → 'lte'`; `=== → 'tuple'`; `< → 'lt'`; `null` cursor → `null` для всех 5 kinds (30 assertions).

### TC-TRP-006: mergePage — cut ровно до limit + next_cursor = последний эмитированный
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** T-5 · **FR/INV:** FR-01, FR-02, INV-10
- **Входные:** леги суммарно 35 строк всех 5 kinds, limit 20; items #20 и #21 делят один µs-ts, #20 — estimate.
- **Ожидаемо:** ровно 20 items в DESC-порядке; `nextCursor` = `encodeCursor({ts, k:3, id:'<число БЕЗ префикса>'})` item'а #20; envelope: financial → `src:'financial'`, `id:'estimate-33'`; call → `src:'call'`, `id:String(bigint)`; sms → uuid.

### TC-TRP-007: mergePage — hasMore-эвристика (per-leg full-window)
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** T-6 · **FR/INV:** FR-01, §4
- **Входные:** (a) один лег ровно `limit` строк, leftover после cut = 0; (b) все леги `< limit`, leftover 0; (c) leftover > 0; (d) sms-лег 20 строк из 2 бесед (10+10), limit 20.
- **Ожидаемо:** (a) `hasMore:true` (правило `legs.some(l => l.rows.length >= limit)` — консервативно, без false-negative); (b) `{hasMore:false, nextCursor:null}`; (c) `true`; (d) `true` (TOTAL rows лега ≥ limit).

### TC-TRP-008: mergePage — permission-filtered merge: страница остаётся полной
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** T-7 · **FR/INV:** FR-02, FR-06, INV-10
- **Входные:** фикстура TC-TRP-006, но estimate/invoice леги НЕ переданы вовсе (роут их не запрашивает без `financial_data.view`).
- **Ожидаемо:** ровно 20 items из оставшихся kinds; ни одного `src:'financial'`; взаимный порядок остальных не изменился (filter-before-cut, страница не «худеет»).

### TC-TRP-009: mergePage — все леги пустые
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** T-8 · **FR/INV:** FR-14, §4
- **Ожидаемо:** `{items:[], nextCursor:null, hasMore:false}`.

### TC-TRP-010: mergePage — неотсортированный sms-лег
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** T-9 · **FR/INV:** FR-01, §4
- **Входные:** sms-лег = конкатенация per-conversation батчей (глобальный порядок нарушен).
- **Ожидаемо:** выход mergePage = эталонный глобальный DESC (модуль сортирует сам, вход-порядок не важен).

### TC-TRP-011: синтетический page-walk 100 items — no dup / no skip
- **Приоритет:** P0 · **Тип:** unit jest · **Якорь:** T-10 · **FR/INV:** FR-01, FR-02, INV-10
- **Входные:** 100 items всех 5 kinds; ≥3 equal-µs runs по 4+ элементов, минимум один run пересекает границу страницы; walk `mergePage` по 20 с курсорами до `hasMore:false` (фейк-леги применяют предикаты §3.5).
- **Ожидаемо:** конкатенация страниц == полный DESC-сорт эталона; set-equality по `src:id` (ни дубля, ни пропуска); `hasMore:false` только на последней.

### TC-TRP-012: курсор на удалённый item + произвольный валидный курсор
- **Приоритет:** P2 · **Тип:** unit jest · **Якорь:** E-2, E-11 · **FR/INV:** FR-01
- **Входные:** (a) из фикстуры TC-TRP-011 удалить строку-носитель курсора между страницами; (b) курсор с будущим ts `2099-01-01T00:00:00.000000Z`, k=0; (c) курсор с uppercase-uuid id.
- **Ожидаемо:** (a) следующая страница продолжает строго-после ЗНАЧЕНИЙ курсора — без ошибки, без dup/skip по оставшимся; (b) страница = newest 20, ошибок нет; (c) принят (сравнение уходит в SQL/предикаты, регистр безопасен).

### TC-TRP-013: sabotage-unit — негативный контроль walk-чекера
- **Приоритет:** P1 · **Тип:** unit jest · **Якорь:** T-10 (контроль) · **FR/INV:** house-rule sabotage
- **Шаги:** чекер инвариантов walk'а (страницы дизъюнктны по `src:id`; стык строгий: `page2.items[0]` строго-после `page1.items[last]` по compareDesc) прогнать на ЗАВЕДОМО сломанном потоке: итерация 2 вызывает `mergePage` с `cursor=null` (симуляция «курсор игнорируется»).
- **Ожидаемо:** чекер возвращает нарушения (дубль первой страницы) — `expect(violations.length).toBeGreaterThan(0)`; честный прогон тех же ассёртов (TC-TRP-011) — зелёный. Тест доказуемо «умеет краснеть» — заглушенная паджинация не пройдёт.

---

## Секция B — API-integration jest (`tests/pulseTimelinePageRoute.test.js`)

### TC-TRP-020: выбор ветки — legacy без параметров, paged с limit
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** T-12 · **FR/INV:** FR-01, INV-4
- **Шаги:** (a) GET без query-параметров; (b) GET `?limit=20` — оба эндпоинта (`/timeline-by-id/:id`, `/timeline/:contactId`).
- **Ожидаемо:** (a) spy: `buildTimeline` вызван, `buildTimelinePage` — нет; в ответе НЕТ ключей `page`/`meta`; (b) наоборот; ответ `{page:{items,next_cursor,has_more}, meta:{…}}`; в обоих режимах guards (`getTimelineInCompany` / contact-lookup / `isContactVisibleToProvider`) отработали ДО ветвления (порядок вызовов spy).

### TC-TRP-021: invalid limit → 400
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** T-11 · **FR/INV:** §2.1, E-12
- **Входные:** `?limit=abc | 0 | -5 | 1.5 | ''` (не проходит `/^[1-9]\d*$/`) — оба эндпоинта.
- **Ожидаемо:** `400 {"error":"Invalid limit"}`; НОЛЬ вызовов лег-моков/discovery.

### TC-TRP-022: invalid cursor → 400 (включая before без limit)
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** T-11 · **FR/INV:** §2.1, §3.1
- **Входные:** `?limit=20&before=<junk | v:2 | ms-ts | плохой id>` (типизированная ошибка parseCursor → 400); `?before=<валидный курсор>` БЕЗ `limit`.
- **Ожидаемо:** во всех — `400 {"error":"Invalid cursor"}`; НОЛЬ лег-вызовов.

### TC-TRP-023: 401 без токена (регресс middleware)
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §2.4 · **FR/INV:** FR-06
- **Шаги:** REAL `authenticate`; оба эндпоинта, оба режима (`?limit=20` и без), запрос без `Authorization` и с мусорным токеном.
- **Ожидаемо:** 401; ноль db-вызовов.

### TC-TRP-024: 403 без pulse.view
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §2.4 · **FR/INV:** FR-06
- **Шаги:** auth-stub с ролью БЕЗ `pulse.view` (router-wide `requirePermission('pulse.view')`, `routes/pulse.js:18`).
- **Ожидаемо:** 403 на оба эндпоинта в обоих режимах; ноль лег-вызовов.

### TC-TRP-025: cross-tenant 404 — timeline и contact
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §2.4, H-5 (jest-зеркало) · **FR/INV:** FR-06
- **Шаги:** auth-stub company A; (a) `:timelineId` компании B (`getTimelineInCompany` → null) — paged и legacy; (b) `:contactId` компании B.
- **Ожидаемо:** (a) `404 {"error":"Timeline not found"}`; (b) `404 {"error":"Contact not found"}`; чужой id неотличим от несуществующего (тот же ответ); леги/discovery НЕ вызывались (spy count 0).

### TC-TRP-026: provider assigned_only → 404
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** §2.4, H-4 (jest-зеркало) · **FR/INV:** FR-06, SC-07
- **Шаги:** auth-stub provider-scope; `isContactVisibleToProvider` → false; плюс orphan-timeline (без contact) под тем же scope; `?limit=20`.
- **Ожидаемо:** 404 (тот же текст, что и tenant-miss); леги не вызываются.

### TC-TRP-027: legacy no-limit — byte-shape неизменен (golden)
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §2.5 · **FR/INV:** INV-4, INV-5, E-14
- **Предусловия:** фикстура со всеми 4 типами item'ов, включая call с `started_at=NULL`, sms с media (строка JSON), email с quote-strip; golden `tests/fixtures/timeline-legacy-golden.json` зафиксирован прогоном buildTimeline с master ДО фичи на ТОЙ ЖЕ фикстуре (одноразовая процедура; файл коммитится).
- **Шаги:** GET без параметров (оба эндпоинта).
- **Ожидаемо:** точный набор ключей `{calls, messages, conversations, email_messages, financial_events, timeline_id, display_name, external_source, contact}` — никаких `page`/`meta`/`ts`/`src`; порядок массивов: calls `started_at DESC NULLS LAST` (NULL-call последним), messages per-conversation oldest-first, email_messages ASC, financial DESC; deep-equal с golden (включая `formatCall`-поля `gemini_summary`/`playback_url`/`answered_by`, распарсенный `media`, `toTimelineBody`-вывод).

### TC-TRP-028: paged happy-path walk — 3 страницы vs legacy на одной фикстуре
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** T-10/H-1 (jest-зеркало) · **FR/INV:** FR-01, FR-02, FR-05, INV-5, INV-10, INV-11
- **Предусловия:** фикстура ~50 items всех 5 kinds; equal-µs run через границу p1/p2; лег-фейки применяют `{limit, cursorPred}` честно.
- **Шаги:** `?limit=20` → `before=next_cursor` → ещё раз (3 запроса).
- **Ожидаемо:** страницы 20+20+10; `has_more: true,true,false`; `next_cursor:null` на p3; конкатенация = set-equality по `src:id` И порядок = DESC-эталон И `data` каждого item'а deep-equal соответствующему элементу legacy-ответа на той же фикстуре (DTO parity); `meta` ТОЛЬКО на p1 (на p2/p3 ключа нет вовсе); `meta.conversations[].proxy_e164` присутствует (композер); envelope `ts` соответствует `^\d{4}-…\.\d{6}Z$` (µs-строка).

### TC-TRP-029: limit clamping
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** E-12 · **FR/INV:** §2.1
- **Входные:** `?limit=500` / `?limit=50` / `?limit=20`.
- **Ожидаемо:** 500 → 200 OK, клэмп до 50 — лег-моки получили `limit=50`, items ≤ 50; 50 и 20 — как заданы; никакого 400 для 500 (формат валиден, клэмп тихий).

### TC-TRP-030: contactless timeline — paging email-лега
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** E-4, H-6 (jest-зеркало) · **FR/INV:** FR-04, FR-05
- **Предусловия:** timeline без contact (YELP conv-id, YELP-TIMELINE-DEDUP-001); только email-строки.
- **Ожидаемо:** вызван `getTimelineEmailPageByTimeline` (timeline_id), НЕ `…ByContact`; financial леги НЕ вызваны (нет `contact.id`); sms-discovery пуст → sms-лег скипнут; страницы корректны; `meta.contact:null`, `display_name`/`external_source` из timeline-строки.

### TC-TRP-031: financial gating — гейт вербатим из legacy
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** S-07 · **FR/INV:** FR-02, FR-06
- **Входные:** (a) permissions без `financial_data.view`; (b) с ним; (c) `_devMode:true` без permission.
- **Ожидаемо:** (a) estimates/invoices-моки НЕ вызваны; страница полная (20) из остальных kinds; (b) financial items присутствуют (`src:'financial'`, `type` классификация paid/partial/created); (c) как (b) — гейт `req.user?._devMode || permissions.includes('financial_data.view')` вербатим.

### TC-TRP-032: изоляция тенантов — company_id только из companyFilter
- **Приоритет:** P0 · **Тип:** API-integration jest · **Якорь:** §13 · **FR/INV:** FR-06 (LIST-PAGINATION-001 precedent)
- **Шаги:** auth-stub `companyFilter=COMPANY_A`; запрос `?limit=20&company_id=COMPANY_B` + body `{company_id:B}`.
- **Ожидаемо:** ВСЕ лег-вызовы и discovery получили строго COMPANY_A (проверка захваченных параметров каждого из 6 легов: calls, discovery, sms, email, estimates, invoices); в ответе нет данных B.

### TC-TRP-033: sabotage-API — дизъюнктность страниц (негативный контроль)
- **Приоритет:** P1 · **Тип:** API-integration jest · **Якорь:** house-rule sabotage · **FR/INV:** FR-01
- **Шаги:** p1 = `?limit=20`; p2 = `?limit=20&before=<p1.next_cursor>`; assert: (a) пересечение по `src:id` пусто; (b) `p2.items[0]` строго-после `p1.items[19]` в тотальном порядке; (c) p2 ≠ p1 (deep). Контроль детекторной силы: временно застабить обработку `before` (parseCursor → null внутри теста через jest.spyOn на модуль) → (a) обязан упасть дублем первой страницы → снять стаб.
- **Ожидаемо:** честная реализация зелёная; реализация, игнорирующая `before`, НЕ проходит.

### TC-TRP-034: before глубже реальной истории
- **Приоритет:** P3 · **Тип:** API-integration jest · **Якорь:** E-16 · **FR/INV:** FR-01
- **Входные:** валидный курсор, указывающий глубже остатка (история короче страницы).
- **Ожидаемо:** 200; `items` < 20 (или пусто), `has_more:false`, `next_cursor:null`; никакого special-case.

---

## Секция C — harness-script: N3 real-DB (`backend/scripts/verify-timeline-revpage.mjs`, прод-копия) + гейты

### TC-TRP-H01: page-walk vs legacy на самом тяжёлом треде (SMS-diff — отдельный отчёт, не fail)
- **Приоритет:** P0 · **Тип:** harness-script · **Якорь:** H-1 · **FR/INV:** FR-01, FR-02, INV-4, N3
- **Предусловия:** прод-копия; выбрать timeline с max items.
- **Шаги:** walk страницами до `has_more:false`; параллельно собрать legacy full-feed (buildTimeline-эквивалент) того же треда.
- **Ожидаемо:** (a) set-equality по `src:id` — no dup / no skip; (b) порядок потока — валидный СТРОГИЙ DESC (каждая соседняя пара по compareDesc); (c) расхождения ПОРЯДКА SMS (ключ `created_at` vs legacy `date_created_remote||created_at` — задокументированное изменение §3.2) идут в ОТДЕЛЬНЫЙ WARN-отчёт (пары, дельты) и НЕ валят прогон; FAIL — если SMS-реордер пересекает границу суток (не ingest-latency-bounded) или если реордер затронул не-SMS kind. Беседы >200 SMS исключаются из set-equality и делегируются H02.

### TC-TRP-H02: тред >200 SMS — новые страницы КОРРЕКТНЫ, legacy известно-lossy (направление diff документировано)
- **Приоритет:** P1 · **Тип:** harness-script · **Якорь:** H-1 (расширение, §5.4) · **FR/INV:** FR-01, FR-03
- **Предусловия:** найти или засеять беседу >200 сообщений.
- **Шаги:** full walk нового пути; legacy-поток той же беседы (`getMessages ASC LIMIT 200` — видит только СТАРЕЙШИЕ 200; известный баг, спекой «fixed by construction» — не «сохранять»).
- **Ожидаемо:** new ⊇ legacy; `new − legacy` = ровно сообщения с `created_at` ≥ max(created_at legacy-набора беседы), count = total−200 (то есть diff — строго НОВЕЙШИЕ, которые legacy терял); `legacy − new` = ∅; харнес печатает явный вердикт направления: «EXPECTED DIFF: NEW correct / LEGACY lossy (oldest-200)» — это ожидаемое расхождение, НЕ fail.

### TC-TRP-H03: equal-µs run на границе страницы
- **Приоритет:** P0 · **Тип:** harness-script · **Якорь:** H-2 · **FR/INV:** FR-02, INV-10, INV-11
- **Шаги:** найти equal-µs run разных kinds (или засеять: INSERT нескольких строк с одним timestamp в одной транзакции); подогнать walk так, чтобы cut прошёл ВНУТРИ run'а.
- **Ожидаемо:** no dup / no skip через границу; курсор в run'е несёт `k`/`id`; режимы `lte`/`tuple`/`lt` дают точный стык на реальном PG (row-value comparison, касты `::bigint`/`::uuid`).

### TC-TRP-H04: permission fullness — 20/страница без financial
- **Приоритет:** P1 · **Тип:** harness-script · **Якорь:** H-3 · **FR/INV:** FR-02, FR-06, SC-07
- **Шаги:** walk с исключёнными financial легами на треде, где financial события есть.
- **Ожидаемо:** каждая не-финальная страница ровно 20; ни одного financial item; никаких «дыр».

### TC-TRP-H05: provider assigned_only — 404-путь, леги не достигаются
- **Приоритет:** P1 · **Тип:** harness-script · **Якорь:** H-4 · **FR/INV:** FR-06
- **Шаги:** чужой/orphan тред под `assigned_only`-scope; инструментировать счётчик лег-вызовов.
- **Ожидаемо:** решение `isContactVisibleToProvider` → 404-путь ДО легов; лег-SQL не выполнялся.

### TC-TRP-H06: cross-tenant изоляция на реальной БД
- **Приоритет:** P0 · **Тип:** harness-script · **Якорь:** H-5 · **FR/INV:** FR-06, §13
- **Шаги:** (a) timeline id чужой компании → `getTimelineInCompany` null (404-путь); (b) КАЖДЫЙ из 6 легов (calls, discovery, sms, email×2, estimates, invoices) выполнить с чужим `company_id`, с курсором и без.
- **Ожидаемо:** (b) 0 строк у каждого лега; ни одной строки чужого тенанта ни при каком курсоре (E-11: произвольный валидный курсор не даёт утечки).

### TC-TRP-H07: contactless YELP-timeline на прод-копии
- **Приоритет:** P1 · **Тип:** harness-script · **Якорь:** H-6 · **FR/INV:** FR-04
- **Шаги:** реальный conv-id-timeline (YELP-TIMELINE-DEDUP-001); full walk.
- **Ожидаемо:** страницы только из email-лега (`…ByTimeline`); meta contactless-поля корректны; walk до конца без ошибок.

### TC-TRP-H08: кардинальность — ровно 20 / <20 / 0
- **Приоритет:** P1 · **Тип:** harness-script · **Якорь:** H-7, E-7 · **FR/INV:** FR-01, FR-14
- **Шаги:** три треда: ровно 20 items; меньше 20; ноль.
- **Ожидаемо:** последовательности `has_more`: ровно-20 → `true`, затем пустая страница `{"items":[],"next_cursor":null,"has_more":false}` (принятый один лишний запрос); <20 → `false` сразу; 0 → `items:[]`, `false`.

### TC-TRP-H09: N1 — EXPLAIN (ANALYZE) + тайминги до/после
- **Приоритет:** P1 · **Тип:** harness-script · **Якорь:** N1, §6 · **FR/INV:** FR-03, INV-15
- **Предусловия:** миграция 168 применена на копии; повторное применение — no error (`IF NOT EXISTS`, идемпотентность INV-15); rollback-файл существует.
- **Шаги:** EXPLAIN (ANALYZE) calls-лега и sms-лега на самом тяжёлом треде; замер page-1 vs legacy full-load.
- **Ожидаемо:** calls-лег использует `idx_calls_timeline_page`, inner LIMIT ограничивает LATERALs ≤ limit строк; sms-лег — backward-scan `idx_sms_msg_conversation_created` (без сортировки всего треда); page-1 «решительно быстрее и никогда не хуже» legacy — тайминги в отчёт; если email-EXPLAIN плох — ЗАДОКУМЕНТИРОВАТЬ (санкционированный follow-up §6), индекс спекулятивно не добавлять.

### TC-TRP-H10: sabotage-harness — самопроверка детектора
- **Приоритет:** P2 · **Тип:** harness-script · **Якорь:** house-rule sabotage · **FR/INV:** N3
- **Шаги:** режим `--sabotage=ignore-cursor`: харнес шлёт `before=null` на каждой итерации walk'а (симуляция заглушенного курсора); запустить ДО доверия зелёному H01.
- **Ожидаемо:** харнес падает (exit ≠ 0) с диагностикой «duplicate page-1 detected»; в честном режиме тот же детектор зелёный. Детекторная сила доказана.

### TC-TRP-H11: статический zero-diff защищённых файлов
- **Приоритет:** P1 · **Тип:** harness-script · **Якорь:** §16 «NOT touched» · **FR/INV:** INV-1, INV-2, INV-3, INV-6, INV-12, INV-13
- **Шаги:** `git diff <base>..HEAD --name-only` ветки фичи.
- **Ожидаемо:** diff НЕ содержит: `src/server.js`; route/response `timeline-by-phone` + `useSoftPhoneWidget.ts` / `OpenTimelineButton.tsx` / `AppLayout.tsx`; `ConversationPage.tsx` + `components/conversations/*`; `getUnifiedTimelinePage` (левый список); `SmsForm.tsx`; `authedFetch.ts`; `useRealtimeEvents.ts`; sseManager; `DateSeparator.tsx`; bubble-компоненты (`PulseCallListItem`/`SmsListItem`/`EmailListItem`/`FinancialEventListItem`); `permissionCatalog.js`. Внутри изменённых файлов: `convQueries.getMessages` и ASC-email функции без диффа (INV-12).

### TC-TRP-G01: build gates
- **Приоритет:** P0 · **Тип:** harness-script · **Якорь:** §15.4 · **FR/INV:** N3
- **Шаги:** корневой `npm test` (включая обе новые сюиты); `cd frontend && npm run build` (tsc -b).
- **Ожидаемо:** оба зелёные; прод-Docker строже (`noUnusedLocals`) — `callDataItems` и осиротевшие импорты удалены чисто.

---

## Секция D — manual-browser: N2 (живой preview; desktop 1280 И mobile 375)

### TC-TRP-M01: открытие длинного треда — bottom-anchor без вспышки
- **Приоритет:** P0 · **Тип:** manual-browser · **Якорь:** N2-1 · **FR/INV:** FR-07, SC-01
- **Предусловия:** тред 500+ items; тред с открытой задачей (для AR-бара).
- **Шаги:** открыть тред; повторить с CPU-троттлингом ×4 (ловля кадра); повторить на 375px.
- **Ожидаемо:** лента приземляется ВНИЗУ — newest items + композер видны без скролла; НИ ОДНОГО кадра top-anchored с последующим прыжком (pre-paint anchor §8.1); AR-бар приколот сверху; network: ровно один `?limit=20`, никакого full-history многосекундного лоада.

### TC-TRP-M02: скролл вверх — prepend с сохранением позиции + one-in-flight
- **Приоритет:** P0 · **Тип:** manual-browser · **Якорь:** N2-2 · **FR/INV:** FR-08, SC-02
- **Шаги:** скроллить вверх до сработки сентинела; зафиксировать взглядом конкретный пузырь; агрессивно спамить скролл у верха (провокация параллельных фетчей); повторять до исчерпания истории.
- **Ожидаемо:** reserved spinner-row (36px) — layout НЕ прыгает при появлении/уходе спиннера; older-батч препендится, видимый пузырь НЕ смещается на экране (компенсация §8.4, включая отрицательную дельту −36px на финальной странице); network: НЕ БОЛЕЕ одного older-запроса in flight в любой момент; после `has_more:false` сентинел исчез; продолжая вверх — достижимы Lead/Contact card (и wizard, где есть) над лентой.

### TC-TRP-M03: inbound при скролле вверх — pill + dot, позиция на месте
- **Приоритет:** P0 · **Тип:** manual-browser · **Якорь:** N2-3 · **FR/INV:** FR-11, SC-03, INV-9
- **Предусловия:** вторая сессия/webhook для реального inbound SMS.
- **Шаги:** отскроллить вверх (>120px от дна); триггернуть inbound; кликнуть pill.
- **Ожидаемо:** позиция чтения НЕ сдвинулась; pill «Jump to latest» показан (fixed bottom 90px / right 40px), 8px dot `var(--blanc-danger)` в правом-верхнем углу pill, aria-label «Jump to latest — new activity»; клик → smooth-скролл к низу, dot очищен; на странице ровно ОДИН jump-affordance (старая fixed-кнопка удалена — INV-9).

### TC-TRP-M04: у дна — auto-stick, pill скрыт
- **Приоритет:** P0 · **Тип:** manual-browser · **Якорь:** N2-4 · **FR/INV:** FR-11, SC-04
- **Шаги:** встать в пределах 120px от дна; триггернуть новый item (inbound SMS / live robo-call / email).
- **Ожидаемо:** лента авто-доскролливается и показывает новый item (эффект новейшего ключа + ResizeObserver-belt, включая догрузку изображений/media); pill при nearBottom НЕ отображается.

### TC-TRP-M05: send → bottom (SMS и email) + первый outbound SMS
- **Приоритет:** P0 · **Тип:** manual-browser · **Якорь:** N2-5 · **FR/INV:** FR-12, FR-05, SC-05, E-8
- **Шаги:** отправить SMS; отправить email; отдельно — контакту БЕЗ существующей беседы отправить первый SMS; спровоцировать ошибку отправки (невалидный номер).
- **Ожидаемо:** после успешной отправки — head-refresh, плавный скролл к низу, отправленное сообщение видно; первый outbound: conversation создан, fresh `meta.conversations` подхвачен, `targetConv` резолвится БЕЗ перезагрузки страницы; при ошибке — существующий toast, скролла НЕТ (сигнал бампается только после успешного refresh).

### TC-TRP-M06: короткий тред и ровно-20
- **Приоритет:** P1 · **Тип:** manual-browser · **Якорь:** N2-6 · **FR/INV:** FR-14, SC-06, E-7
- **Шаги:** (a) тред <20 items; (b) тред ровно 20 items — проскроллить к верху ленты.
- **Ожидаемо:** (a) весь контент, НЕТ сентинела/спиннера, bottom-anchored, композер виден; (b) page-1 `has_more:true` → у верха один дополнительный ПУСТОЙ fetch → сентинел размонтируется (−36px скомпенсированы) БЕЗ видимого flicker/прыжка.

### TC-TRP-M07: sticky AR-бар + sabotage-control
- **Приоритет:** P0 · **Тип:** manual-browser · **Якорь:** N2-7 · **FR/INV:** FR-13, INV-8, house-rule sabotage
- **Предусловия:** тред с открытой задачей (AR); тред с задачей в snooze.
- **Шаги:** скроллить ленту вверх/вниз; открыть Done/Snooze/Assign дропдауны и TaskActionButtons в sticky-состоянии; открыть dialog / bottom-sheet поверх; закрыть задачу. **Шаг S (sabotage):** в devtools отключить `position:sticky` у `.pulse-ar-sticky` → бар обязан уехать со скроллом → чек «бар всегда виден» ПРОВАЛИВАЕТСЯ → вернуть стиль, чек снова зелёный.
- **Ожидаемо:** бар прибит к верху колонки во время скролла, контент уходит ПОД него (непрозрачный фон `#fff7ed` / `var(--blanc-surface-muted)` в snooze — без просвечивания); все действия работают; бар НИКОГДА не поверх оверлеев (z=5 < OVERLAY_Z.panel=80); нет открытой задачи → ничего не рендерится; шаг S доказал, что проверка умеет проваливаться.

### TC-TRP-M08: contactless / anonymous / пустой тред
- **Приоритет:** P1 · **Тип:** manual-browser · **Якорь:** N2-8 · **FR/INV:** FR-04, FR-14, E-4, E-5
- **Шаги:** открыть contactless YELP-тред; anonymous-тред; пустой тред.
- **Ожидаемо:** YELP: рендер + скролл-паджинация работают (email-only); anonymous: композер скрыт (существующая логика), bottom-anchor работает; пустой: существующий empty state «No activity found for this contact», карточки + композер как сегодня; в UI-копиях нет «Blanc».

### TC-TRP-M09: mobile 375 — полный паритет + iOS momentum
- **Приоритет:** P1 · **Тип:** manual-browser · **Якорь:** N2-9 · **FR/INV:** FR-15, SC-08
- **Шаги:** прогнать M01–M07 в mobile 'content'-панели (тот же `.pulse-right-column`); на реальном iOS (или качественной эмуляции) — momentum-скролл ВО ВРЕМЯ prepend'а.
- **Ожидаемо:** идентичное поведение (никакого отдельного mobile data-path); позиция удержана при momentum (rAF-belt §8.1/8.4); pill не перекрыт нижней навигацией; list⇄content переключение панелей не тронуто.

### TC-TRP-M10: соседние поверхности не задеты (spot-check)
- **Приоритет:** P1 · **Тип:** manual-browser · **Якорь:** N2-10 · **FR/INV:** INV-1, INV-2, INV-3
- **Шаги:** левый список Pulse (скролл-пагинация списка); softphone-виджет (открытие таймлайна по номеру — `timeline-by-phone`); legacy ConversationPage.
- **Ожидаемо:** всё работает byte-как-раньше; никаких новых запросов/регрессий от фичи.

### TC-TRP-M11: быстрое переключение тредов — нет cross-thread bleed
- **Приоритет:** P1 · **Тип:** manual-browser · **Якорь:** E-6 (расширение N2) · **FR/INV:** FR-01, FR-10
- **Шаги:** быстро кликать между 3+ тредами (не дожидаясь загрузки); затем в финальном треде дождаться SSE-события.
- **Ожидаемо:** network показывает abort незавершённых запросов (AbortSignal); ни одного пузыря чужого треда; каждый тред заново bottom-anchored (anchoredRef сброшен); pill/dot/`hasNewActivity` не «переезжают» между тредами; после переключения head-refresh обновляет ПРАВИЛЬНЫЙ тред (in-flight ref сброшен на смене ключа).

### TC-TRP-M12: SSE-скоуп — только head-страница (network-ассерт)
- **Приоритет:** P1 · **Тип:** manual-browser · **Якорь:** FR-10 (расширение N2) · **FR/INV:** FR-10, E-9, E-10, INV-6
- **Предусловия:** тред с ≥3 загруженными страницами (наскроллить историю).
- **Шаги:** триггернуть `message.added`, `call.updated` (включая robo-call placement→live→finalize), `transcript.finalized`; наблюдать network; отдельно — финализация транскрипта звонка, живущего ТОЛЬКО в старой загруженной странице.
- **Ожидаемо:** на каждое событие — РОВНО один GET `?limit=20` БЕЗ `before` (head), НОЛЬ запросов с `before` (сегодняшний full-reload истории удалён); загруженные старые страницы визуально не перерендериваются/не перезапрашиваются; robo-call строка обновляется на месте (union по `src:id`; DB id стабилен через vapi→CallSid re-key); item только-в-старой-странице остаётся stale до реоткрытия (accepted v1) — без ошибок и без full-refetch; live-транскрипт (deltas) продолжает течь через useLiveTranscript.

### TC-TRP-M13: date separators через prepend'ы
- **Приоритет:** P2 · **Тип:** manual-browser · **Якорь:** FR-09 (расширение N2 — в §15.5 отсутствует) · **FR/INV:** FR-09
- **Шаги:** подгрузить подряд 3+ страниц, пересекающих ≥2 календарных дня, включая случай «страница режет день пополам» (часть items дня на p1, часть на p2).
- **Ожидаемо:** ровно один разделитель на день-переход в загруженном окне; после prepend'а НЕТ дублей и «съехавших» разделителей — разделитель дня сидит над OLDEST loaded item этого дня и переезжает вверх при догрузке более старых items того же дня; company-tz день как сегодня; отсутствие разделителя у невыгруженной части дня — принятое поведение (§8.7).

---

## Матрица покрытия FR → TC

| FR | Тест-кейсы |
|---|---|
| FR-01 (cursor contract) | 001, 002, 003, 004, 005, 006, 011, 012, 013, 020, 028, 033, 034, H01, H08, M11 |
| FR-02 (filter-before-cut, no dup/skip) | 006, 007, 008, 011, 028, 031, H01, H03, H04 |
| FR-03 (bounded work) | H02, H09 |
| FR-04 (обе identity + contactless) | 030, H07, M08 |
| FR-05 (meta once) | 028, 030, M05 |
| FR-06 (permissions/tenancy) | 023, 024, 025, 026, 031, 032, H05, H06 |
| FR-07 (bottom-anchor open) | M01, M09 |
| FR-08 (scroll-up older, one-in-flight, preserve) | M02, M06, M09 |
| FR-09 (date separators) | M13 |
| FR-10 (SSE = newest page) | M11, M12 |
| FR-11 (auto-stick + pill) | M03, M04 |
| FR-12 (send → bottom) | M05 |
| FR-13 (sticky AR) | M07 |
| FR-14 (empty/short) | 009, 034, H08, M06, M08 |
| FR-15 (mobile parity) | M09 |
| N1 | H09 |
| N2 | M01–M13 |
| N3 | H01–H08, G01 |
| INV-1/2/3/13 (protected zero-diff) | H11, M10 |
| INV-4 (legacy byte-identity) | 020, 027, H01 |
| INV-5 (DTO parity) | 027, 028 |
| INV-8 (AR byte-behavior) | M07 |
| INV-9 (один jump-affordance) | M03 |
| INV-10 (единый тотальный порядок) | 003, 004, 006, 008, 011, 028, H03 |
| INV-11 (µs-строки end-to-end) | 001, 002, 028, H03 |
| INV-12 (legacy queries untouched) | H11 |
| INV-15 (мig 168 index-only, идемпотентна) | H09 |

## Порядок прогона (рекомендация Tester-агенту)
1. Секция A (чистый модуль) → 2. Секция B (route) → 3. TC-TRP-G01 (гейты) → 4. Секция C на прод-копии (сначала H10 sabotage-самопроверка, потом H01–H09, H11) → 5. Секция D в живом preview (desktop → mobile), sabotage-шаг M07-S обязателен.
