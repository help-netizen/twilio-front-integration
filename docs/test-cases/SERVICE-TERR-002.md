# Тест-кейсы: SERVICE-TERR-002 — radius-территории + containment-seam + онбординг-шаг

**Спецификация:** `Docs/specs/SERVICE-TERR-002.md`. Существующие тест-кейсы проверены: `tests/serviceTerritoryZip.test.js` (normalizeZip/query-слой — НЕ дублируем, остаётся как есть), `tests/onboardingChecklist.test.js` (39 — нормативный payload обновляется). Моки: `db/connection` (jest.fn query), `global.fetch` (Google Geocoding), для route-тестов — express-app с фейковым `req.companyFilter` (паттерн onboardingChecklist.test.js appWith).

### Покрытие
- Всего тест-кейсов: 31 (24 автоматических Jest + 7 preview/manual)
- P0: 12 | P1: 11 | P2: 6 | P3: 2
- Unit: 10 | Integration: 14 | E2E/preview: 7

---

## A. utils/geo + territoryGeoService (unit) — файл `tests/territoryService.test.js`

### TC-TERR2-001: haversineMiles — известные расстояния
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** спека §1.3
- **Входные данные:** (42.3601,-71.0589)↔(42.3601,-71.0589) → 0; Boston(42.3601,-71.0589)↔NYC(40.7128,-74.0060) → ≈190 mi (допуск ±2).
- **Ожидаемый результат:** значения в допуске; функция чистая, без побочных эффектов.

### TC-TERR2-002: geocodeZip — кэш-hit не зовёт Google
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** §1.2 шаг 2
- **Моки:** db.query → zip_geocache row {lat,lon,city,state}; global.fetch — jest.fn.
- **Ожидаемый результат:** вернул объект из кэша; `fetch` НЕ вызван; INSERT не выполнялся.

### TC-TERR2-003: geocodeZip — miss → Google OK → INSERT ON CONFLICT + возврат
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** §1.2 шаги 3-4
- **Моки:** кэш → rows:[]; fetch → {status:'OK', results:[{geometry:{location:{lat,lng}}, address_components:[locality, admin_area_1]}]}.
- **Ожидаемый результат:** URL содержит `components=postal_code:02135%7Ccountry:US` и env-ключ; выполнен INSERT INTO zip_geocache … ON CONFLICT DO NOTHING; возврат {zip:'02135', lat, lon, city, state}.

### TC-TERR2-004: geocodeZip — ZERO_RESULTS / нет ключа / fetch-throw → null, не throw
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** §1.2 шаг 5
- **Входные данные:** три под-кейса (parametrized): ZERO_RESULTS; delete env-ключей; fetch reject.
- **Ожидаемый результат:** каждый → `null`; исключение не пробрасывается; INSERT не выполнен.

### TC-TERR2-005: geocodeZip нормализует leading-zero
- **Приоритет:** P1 · **Тип:** Unit · **Сценарий:** граничный случай 4
- **Входные данные:** zip='2135' (и число 2135).
- **Ожидаемый результат:** кэш-SELECT и components-параметр используют '02135'.

## B. territoryService.isZipInTerritory (unit, тот же файл)

### TC-TERR2-006: mode='list' → делегирует stQueries.search байт-в-байт
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** §1.3 list; сценарий 2
- **Моки:** settings-SELECT → rows:[] (строки нет → 'list'); spy на stQueries.search → row {zip,area,city,state,county}.
- **Ожидаемый результат:** search вызван с (companyId, исходный query БЕЗ модификаций); возврат {inside:true, area, city, state, zip, mode:'list'}; geocodeZip/haversine НЕ вызывались.

### TC-TERR2-007: list not-found → inside:false с пустыми строками
- **Приоритет:** P1 · **Тип:** Unit
- **Моки:** search → null. · **Ожидаемо:** {inside:false, area:'', city:'', state:'', zip:'', mode:'list'}.

### TC-TERR2-008: radius — зип внутри одного круга
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** сценарий 3
- **Моки:** settings → 'radius'; radii → [{zip:'02135', lat:42.35, lon:-71.16, radius_miles:25}]; geocodeZip('02461') → {lat:42.32, lon:-71.21, city:'Newton', state:'MA'}.
- **Ожидаемый результат:** {inside:true, area:'02135', city:'Newton', state:'MA', zip:'02461', mode:'radius'}; stQueries.search НЕ вызван.

### TC-TERR2-009: radius — вне всех кругов → inside:false + city/state из геокода
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** сценарий 4
- **Моки:** geocodeZip далёкого зипа (расстояние > radius). · **Ожидаемо:** {inside:false, zip, city, state, area:''}.

### TC-TERR2-010: radius — два покрывающих круга → area = зип БЛИЖАЙШЕГО центра
- **Приоритет:** P1 · **Тип:** Unit · **Сценарий:** граничный случай 5
- **Входные данные:** пары A (5 mi от точки, radius 30) и B (20 mi, radius 30).
- **Ожидаемый результат:** area = A.zip.

### TC-TERR2-011: radius — зип извлекается из адресной строки; строка без зипа → inside:false
- **Приоритет:** P1 · **Тип:** Unit · **Сценарий:** граничный случай 3
- **Входные данные:** '123 Main St, Brockton, MA 02301, USA' → геокод '02301'; 'Boston' → inside:false без вызова geocodeZip.

### TC-TERR2-012: radius — geocodeZip → null (safe-fail) и пустой radii-набор
- **Приоритет:** P1 · **Тип:** Unit · **Сценарии:** ошибка 2, граничный 2
- **Ожидаемый результат:** оба под-кейса → {inside:false}; не throw, потребитель получит «вне зоны», не 500.

## C. Endpoints config/mode/radii (integration, supertest) — файл `tests/serviceTerritoriesConfig.test.js`

### TC-TERR2-013: GET /config — полный shape
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** §1.5
- **Моки:** settings 'radius'; radii 2 шт (JOIN city/state); counts; companies.zip; list_centroids.
- **Ожидаемый результат:** 200, `config` ровно {active_mode, radii[] (id,zip,radius_miles,lat,lon,position,city,state), counts:{list_zips,radii}, company_zip, list_centroids[]}; каждый SQL-вызов содержит company_id-параметр.

### TC-TERR2-014: GET /config — lazy-seed центроидов cap 10
- **Приоритет:** P2 · **Тип:** Integration · **Сценарий:** граничный 9
- **Моки:** 15 list-зипов без кэша; geocodeZip mock-счётчик.
- **Ожидаемый результат:** geocodeZip вызван ≤10 раз, дубликаты зипов не геокодятся повторно; ответ 200 при частичных фейлах геокода.

### TC-TERR2-015: PUT /mode — UPSERT + валидация
- **Приоритет:** P0 · **Тип:** Integration
- **Входные данные:** {active_mode:'radius'} → 200 + UPSERT-SQL с company_id; {active_mode:'both'} → 400; {} → 400. Данные territory_radii/service_territories НЕ трогаются (нет DELETE в вызовах).

### TC-TERR2-016: POST /radii — happy path с геокодом
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** сценарий 1
- **Моки:** geocodeZip → {lat,lon,city,state}; INSERT RETURNING row.
- **Ожидаемый результат:** 201 {radius:{id,zip,radius_miles,lat,lon,position,city,state}}; INSERT-параметры включают company_id и lat/lon ИЗ ГЕОКОДА; position для первой пары = 0.

### TC-TERR2-017: POST /radii — 422 ZIP_NOT_FOUND
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** сценарий 5
- **Моки:** geocodeZip → null. · **Ожидаемо:** 422 {error:'ZIP_NOT_FOUND'}; INSERT НЕ выполнен.

### TC-TERR2-018: POST /radii — валидация зипа и радиуса
- **Приоритет:** P1 · **Тип:** Integration
- **Входные данные:** zip '123' → 400; radius_miles 0 → 400; 200.1 → 400; 'abc' → 400; zip '1721' → нормализован в '01721' (geocodeZip получил '01721'); radius 200 → 201 (валиден).

### TC-TERR2-019: DELETE /radii/:id — свой → 200, чужой/несуществующий → 404
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** изоляция; сценарий 6
- **Моки:** DELETE…RETURNING → row (свой) / rows:[] (чужой id компании B).
- **Ожидаемый результат:** 200 {success:true} / 404 {error:'Radius not found'}; SQL содержит `AND company_id = $N`.

### TC-TERR2-020: middleware — 401 без токена, 403 без права/компании (все 4 endpoint'а)
- **Приоритет:** P0 · **Тип:** Integration (real-auth app, паттерн realAuthApp)
- **Ожидаемый результат:** без Authorization → 401; с токеном без tenant.company.manage / без company-контекста → 403; счётчик: все 4 новых endpoint'а покрыты. (Mount-цепочка в server.js уже существует — тест фиксирует, что router полагается на неё и company_id берёт только из req.companyFilter.)

### TC-TERR2-021: tenant isolation — данные компании A не видны компании B
- **Приоритет:** P0 · **Тип:** Integration
- **Шаги:** GET /config с companyFilter=B при данных A в моках (query проверяет company_id-параметр = B).
- **Ожидаемый результат:** каждый SQL всех 4 endpoint'ов получает B; radii компании A в ответ не попадают.

## D. Потребители seam (integration)

### TC-TERR2-022: zip-check — list-режим байт-в-байт прежний контракт
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** §1.4
- **Моки:** mode 'list', search → row. · **Ожидаемо:** `{ok:true, data:{success:true, exists:true, area, city, state, zip}}` — поля и типы идентичны текущим; not-found → exists:false, пустые строки.

### TC-TERR2-023: checkServiceArea skill — три frozen-ветки в radius-режиме
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** сценарий 3; AC-11
- **Входные данные:** in-area → `{inServiceArea:true, area, city, state, zip}`; out-area → РОВНО `{inServiceArea:false, zip}` (без лишних ключей — deepEqual); без зипа → `{inServiceArea:false, error:'zip is required'}`. Никаких ok/speak.

### TC-TERR2-024: онбординг — service_territory деривация (4 комбинации)
- **Приоритет:** P0 · **Тип:** Integration (обновление tests/onboardingChecklist.test.js)
- **Входные данные:** (list, есть service_territories) → true; (list, пусто) → false; (radius, есть radii) → true; (radius, пусто) → false; строки settings нет → ведёт себя как list.
- **Ожидаемый результат:** нормативный payload: items[0] = {key:'service_territory', title:'Set up your service territory', cta:{label:'Set up', path:'/settings/service-territories'}, est_minutes:2, description/done_note — §1.6}; ключа company_profile НЕТ; всего 4 шага; write-once регрессы прежние зелёные; внешние API не вызывались.

### TC-TERR2-025: онбординг — «Blanc» отсутствует в новых строках
- **Приоритет:** P2 · **Тип:** Integration
- **Ожидаемый результат:** JSON.stringify ответа checklist не содержит 'Blanc' (существующий assert остаётся валиден с новым шагом).

## E. Frontend / preview (manual, амендмент-9 — реальные данные dev-БД)

### TC-TERR2-F01: toggle режимов — данные не теряются
- **Приоритет:** P0 · **Тип:** E2E preview · **Сценарий:** сценарий 2
- **Шаги:** list с зипами → Radius → добавить 2 пары → Zip list → Radius. · **Ожидаемо:** всё на месте после каждого переключения и reload; активный режим переживает reload (persist в БД).

### TC-TERR2-F02: radius-CRUD + карта
- **Приоритет:** P0 · **Тип:** E2E preview · **Сценарий:** сценарии 1, 6
- **Ожидаемо:** первая пара prefill company_zip + бейдж Base; круги на карте (radius-режим), fitBounds по всем; удаление пары убирает круг; карта не реагирует на drag/scroll/клики (read-only).

### TC-TERR2-F03: 422-путь в UI
- **Приоритет:** P1 · **Тип:** E2E preview · **Шаги:** добавить zip '00000'. · **Ожидаемо:** warm-toast из Copy-таблицы, ввод сохранён, пара не появилась.

### TC-TERR2-F04: list-карта — маркеры центроидов
- **Приоритет:** P2 · **Тип:** E2E preview · **Ожидаемо:** маркеры только у закэшированных зипов; fitBounds; при нуле центроидов блок Coverage preview скрыт.

### TC-TERR2-F05: мобильная вёрстка 375px
- **Приоритет:** P1 · **Тип:** E2E preview (resize_window mobile) · **Сценарий:** сценарий 7
- **Ожидаемо:** нет горизонтального скролла страницы в ОБОИХ режимах и обоих list-видах; ZipTable скроллится в своём контейнере; кнопки/toggle переносятся; тап-мишени ≥36px.

### TC-TERR2-F06: /welcome — шаг service_territory с MapPin
- **Приоритет:** P1 · **Тип:** E2E preview · **Сценарий:** сценарий 8
- **Ожидаемо:** карточка шага 1 = «Set up your service territory» + MapPin-плитка; CTA ведёт на /settings/service-territories; после добавления пары/зипа и возврата — done + done_note.

### TC-TERR2-F07: Sara/zip-check живой прогон против dev-БД (амендмент-9)
- **Приоритет:** P1 · **Тип:** E2E manual · **Сценарии:** 3, 4
- **Шаги:** dev-БД: включить radius-режим с реальной парой; дернуть GET /api/zip-check?q=<зип в радиусе> и <вне>; вызвать skill checkServiceArea напрямую (node-скрипт) с теми же зипами; переключить на list и повторить.
- **Ожидаемо:** ответы соответствуют режиму; list-ответы идентичны поведению до фичи (сравнить с прод-копией/старым кодом); zip_geocache наполняется, повторный запрос Google не зовёт (проверка по логам).

## Негативные краевые (P3)

### TC-TERR2-026: zip_geocache строка с NULL lat/lon → трактуется как miss
- **Приоритет:** P3 · **Тип:** Unit · **Сценарий:** граничный 7 · **Ожидаемо:** geocodeZip выполняет повторный Google-вызов.

### TC-TERR2-027: дубль зипа в парах — оба валидны, containment корректен
- **Приоритет:** P3 · **Тип:** Integration · **Сценарий:** граничный 8 · **Ожидаемо:** POST второй пары того же зипа → 201; isZipInTerritory inside:true если покрывает хотя бы одна.
