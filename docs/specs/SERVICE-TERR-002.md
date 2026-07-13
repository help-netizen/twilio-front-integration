# Спецификация: SERVICE-TERR-002 — radius-территории с картой покрытия, единый containment-seam, онбординг-шаг service_territory

**Дата:** 2026-07-13 · **Статус:** approved for implementation
**Требования:** `Docs/requirements.md` §SERVICE-TERR-002 (решения заказчика — биндинг)
**Архитектура:** `Docs/architecture.md` §«Архитектурное решение для фичи SERVICE-TERR-002»
**База:** service-territories list-режим (существующий), ONBOARDING-UX-001 (чеклист /welcome), AGENT-SKILLS-001 §7.3 (frozen-шейп checkServiceArea)

### Общее описание

Компания описывает территорию обслуживания одним из двух режимов: **List** (существующий список зипов) или **Radius** (пары «зип-центр + радиус в милях»). Активен ровно один режим (`company_territory_settings.active_mode`), данные обоих режимов хранятся независимо. Все проверки «обслуживаем ли зип» (zip-check UI, Sara/VAPI/Yelp через skill `checkServiceArea`) идут через ЕДИНЫЙ серверный seam `territoryService.isZipInTerritory`. Страница настроек получает read-only карту покрытия и мобильную вёрстку; шаг онбординга `company_profile` заменяется шагом `service_territory`.

---

## 1. Backend

### 1.1 Хранение (миграция 168 + rollback_168, additive, IF NOT EXISTS)

| Таблица | Поля | Примечания |
|---|---|---|
| `company_territory_settings` | company_id UUID PK FK→companies ON DELETE CASCADE; active_mode TEXT NOT NULL DEFAULT 'list' CHECK IN ('list','radius'); updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() | Нет строки ≡ 'list' (существующие компании не мигрируются) |
| `territory_radii` | id UUID PK DEFAULT gen_random_uuid(); company_id UUID NOT NULL FK→companies ON DELETE CASCADE; zip VARCHAR(10) NOT NULL; lat NUMERIC(9,6) NOT NULL; lon NUMERIC(9,6) NOT NULL; radius_miles NUMERIC(5,1) NOT NULL CHECK (radius_miles > 0 AND radius_miles <= 200); position INT NOT NULL DEFAULT 0; created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() | INDEX (company_id). lat/lon — снапшот геокода на момент создания |
| `zip_geocache` | zip VARCHAR(10) PK; lat NUMERIC(9,6); lon NUMERIC(9,6); city TEXT; state TEXT; geocoded_at TIMESTAMPTZ NOT NULL DEFAULT NOW() | БЕЗ company_id — глобальная публичная география (единственное задокументированное исключение из tenant-фильтрации; коммент в миграции обязателен) |

`service_territories` не трогается. `dim_zip` НЕ используется (легаси, 5 строк на проде).

### 1.2 territoryGeoService.geocodeZip(zip) — серверный геокод, кэш-first

1. `normalizeZip(zip)` (shared `utils/zip.js`); пусто → null.
2. `SELECT lat, lon, city, state FROM zip_geocache WHERE zip = $1` → hit (lat/lon не NULL) → вернуть `{zip, lat, lon, city, state}`.
3. Miss → Google Geocoding: `https://maps.googleapis.com/maps/api/geocode/json?components=postal_code:{zip}|country:US&key={GOOGLE_GEOCODING_KEY || GOOGLE_PLACES_KEY}` (env-паттерн googlePlacesService; ключ никогда не уходит в браузер).
4. `OK` + results[0] с координатами → извлечь lat/lon (`geometry.location`), city (`address_components: locality|sublocality|postal_town`), state (`administrative_area_level_1` short_name) → `INSERT INTO zip_geocache … ON CONFLICT (zip) DO NOTHING` → вернуть объект.
5. `ZERO_RESULTS` / не-OK / нет ключа / fetch-исключение → `null` (функция НИКОГДА не throw; ошибка логируется console.warn).

### 1.3 territoryService.isZipInTerritory(companyId, query) — ЕДИНЫЙ containment-seam

Вход: companyId + сырая строка запроса (зип / город / полный адрес — как сейчас у search). Выход: `{ inside: boolean, area: string, city: string, state: string, zip: string, mode: 'list'|'radius' }`.

- `mode = active_mode` компании (нет строки → 'list').
- **mode='list':** `stQueries.search(companyId, query)` — ПОЛНОЕ прежнее поведение (зип/город/area/адрес-парсинг, normalizeZip внутри). row → `{inside:true, area, city, state, zip}`; null → `{inside:false, area:'', city:'', state:'', zip:''}`. Байт-идентично текущему поведению потребителей.
- **mode='radius':**
  1. Извлечь зип: если query — только цифры (3-10) → `normalizeZip`; иначе первый матч `\b(\d{5})(?:-\d{4})?\b` в строке. Зип не извлечён → `{inside:false, …}` (radius-режим проверяет ТОЛЬКО зипы — города/area-имена не матчатся; задокументированное сужение).
  2. `geocodeZip(zip)` → null → `{inside:false, zip}` (safe-fail).
  3. Для каждой пары `territory_radii` компании: `haversineMiles(pair.lat, pair.lon, geo.lat, geo.lon) <= pair.radius_miles` → покрывает.
  4. Ни одна не покрывает → `{inside:false, zip, city, state}` (city/state из геокода — потребители могут озвучить город). Покрывают ≥1 → ближайший центр: `area = zip центра` (пусто → 'Radius'), `{inside:true, area, city, state, zip}`.
- `haversineMiles` — NEW чистая функция в `backend/src/utils/geo.js` (R=3958.8 mi); в кодовой базе haversine отсутствует (проверено).

### 1.4 Перевод потребителей на seam (frozen-шейпы сохраняются)

| Потребитель | Было | Станет | Внешний контракт |
|---|---|---|---|
| `routes/zip-check.js` | `stQueries.search` | `territoryService.isZipInTerritory` | `{ok:true, data:{success:true, exists, area, city, state, zip}}` — байт-в-байт (exists ⇔ inside) |
| `agentSkills/skills/checkServiceArea.js` | `stQueries.search` | seam | in: `{inServiceArea:true, area, city, state, zip}`; out: `{inServiceArea:false, zip}` (+ city/state допустимо пустыми строками НЕ добавлять — шейп frozen, AC-11: out-ветка возвращает только `{inServiceArea:false, zip}`); no-zip: `{inServiceArea:false, error:'zip is required'}` — все три ветки как сейчас |
| `routes/vapi-tools.js` | — | — | ПРОВЕРЕНО: тонкий адаптер, диспатчит generic через `agentSkills.runSkill`, stQueries напрямую не зовёт → НЕ меняется |

В list-режиме оба потребителя байт-идентичны текущему поведению (тот же search-вызов под seam'ом).

### 1.5 API-контракты (все — существующий router `routes/service-territories.js`)

Mount (server.js:316, НЕ трогаем): `authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess`. company_id ТОЛЬКО `getCompanyId(req)` ← `req.companyFilter?.company_id` (существующий хелпер с DEFAULT_COMPANY_ID-фолбэком — сохранить). Auth: authedFetch. Без токена → 401; без права/компании → 403. Все SQL фильтруют по company_id.

- `GET /config` — конфигурация territory-страницы.
  - Response 200: `{ config: { active_mode: 'list'|'radius', radii: [{id, zip, radius_miles, lat, lon, position, city, state}], counts: { list_zips: number, radii: number }, company_zip: string|null, list_centroids: [{zip, lat, lon}] } }`
  - `radii[].city/state` — LEFT JOIN zip_geocache (может быть null). `company_zip` — `companies.zip` (prefill первой пары). `list_centroids` — зипы из `service_territories`, у которых есть строка zip_geocache с координатами (маркеры list-карты); дополнительно на каждый GET лениво геокодится ≤10 некэшированных list-зипов (кэш-first, dedup по zip; паттерн lazy-seed SCHED-ROUTE-VIS-001) — карта list-режима постепенно наполняется без ручных действий.
  - Ошибки: 500.
- `PUT /mode` — переключить активный режим. Request: `{ active_mode: 'list'|'radius' }`. UPSERT company_territory_settings. Response 200: `{ config: { active_mode } }`. Ошибки: 400 (иное значение), 500. Данные неактивного режима НЕ трогаются.
- `POST /radii` — добавить пару. Request: `{ zip: string, radius_miles: number }`.
  - Валидация: normalizeZip → ровно 5 цифр, иначе 400 `{error:'zip must be 5 digits'}`; radius_miles — число >0 и ≤200, иначе 400 `{error:'radius_miles must be between 0 and 200'}`.
  - `geocodeZip(zip)` → null → **422** `{ error: 'ZIP_NOT_FOUND' }` (пара НЕ добавляется).
  - Успех → INSERT territory_radii (lat/lon из геокода; position = max(position)+1 компании, первая пара → 0) → 201 `{ radius: {id, zip, radius_miles, lat, lon, position, city, state} }`.
  - Дубль зипа НЕ блокируется (две пары с одним зипом и разными радиусами валидны).
- `DELETE /radii/:id` — удалить пару. `DELETE … WHERE id=$1 AND company_id=$2 RETURNING id` → нет строки → **404** `{error:'Radius not found'}` (чужой id неотличим от несуществующего). Успех → 200 `{success:true}`.

Существующие endpoints list-режима (GET /, /areas, /export, POST /, /bulk-import, DELETE /:zip) — без изменений.

### 1.6 Онбординг-шаг service_territory (замена company_profile)

`CHECKLIST_ITEMS[0]` — запись `company_profile` УДАЛЯЕТСЯ, на её месте (позиция 1 из 4):

```
key: 'service_territory'
title: 'Set up your service territory'
description: 'Tell Albusto where you work — service-area checks and booking slots follow your coverage.'
cta: { label: 'Set up', path: '/settings/service-territories' }
est_minutes: 2
done_note: 'Mapped out — Albusto knows where you work.'
```

(нормативные строки; «Blanc» запрещён — продукт Albusto). Деривация done (один SQL, tenant-scoped, внешние API не зовутся):

```
done ⇔ (active_mode='list'  AND EXISTS(service_territories WHERE company_id=$1))
     OR (active_mode='radius' AND EXISTS(territory_radii  WHERE company_id=$1))
```
где active_mode = COALESCE((SELECT active_mode FROM company_territory_settings WHERE company_id=$1), 'list').

Write-once/visible-машина `getChecklist`/`markCompleted` — байт-в-байт прежняя. Существующие компании с установленным completed_at не ресурфейсятся (принятое решение ONBOARDING-UX-001 §8). `Docs/specs/ONBOARDING-UX-001.md` §1.1-1.2 — нормативные таблицы обновляются (строка company_profile → service_territory, обоснование замены: профильный шаг покрыт визардом signup + логотип-подшагом Company Profile; территория — реальный gating-шаг для Sara/слотов).

---

## 2. Frontend — /settings/service-territories

### 2.1 Каркас страницы

- `SettingsPageShell` (канон) — title/description; НОВОЕ: три list-кнопки (Import CSV / Export / Add Zip Code) ПЕРЕЕЗЖАЮТ из header-слота `actions` в wrap-toolbar list-режима (см. 2.3) — они относятся только к list-режиму, и header на 375px перестаёт разъезжаться.
- Под header'ом — сегмент-toggle режимов (паттерн `.blanc-control-chip`/ViewToggle): `Zip list` | `Radius`. Активный режим = `config.active_mode`; клик → `PUT /mode` (optimistic UI, откат при ошибке + toast). Под toggle — подпись-успокоение (см. Copy).
- Ниже — контент активного режима + блок «Coverage preview» (карта).
- Данные: React Query `['service-territories-config']` (GET /config) + существующие `['service-territories']`/`['service-territories-areas']`. Мутации radii/mode инвалидируют config.

### 2.2 Radius-режим

- Список пар (карточки-строки, border var(--blanc-line), rounded-xl, без теней): `{zip} · {radius_miles} mi`, вторичной строкой city/state (если есть; пусто — не рендерим), у ПЕРВОЙ пары (min position) — бейдж `Base`. Справа — Trash-иконка (delete, var(--blanc-ink-3)).
- Форма добавления: `FloatingField` «ZIP code» (inputMode numeric, только цифры, max 5; ТОЛЬКО инпут — никаких карт-кликов/выбора) + `FloatingField` «Radius (miles)» (число) + Button `Add coverage`. При пустом списке пар зип предзаполняется `config.company_zip` (база компании). Submit disabled пока zip.length!==5 или радиус не в (0,200].
- POST /radii: pending-спиннер; 201 → пара появляется + toast success; 422 ZIP_NOT_FOUND → warm-toast (Copy), поля не очищаются; 400 → toast с текстом ошибки.
- DELETE: подтверждение НЕ требуется (пара тривиально восстанавливается), toast success.
- Пустое состояние (см. Copy) — dashed-блок как в list-режиме.

### 2.3 List-режим (существующий функционал сохранён + мобильный фикс)

- Wrap-toolbar над контентом: `flex flex-wrap gap-2` — Import CSV / Export / Add Zip Code (те же обработчики/диалоги; на 375px кнопки переносятся на новую строку, не выталкивая layout).
- Всё остальное как есть: stats-строка, ViewToggle (By Area | All Zip Codes), AreaCardsGrid, ZipTable, AddZipDialog, ImportDialog.
- **Мобильный фикс ZipTable:** таблица оборачивается в `overflow-x-auto` контейнер (`-webkit-overflow-scrolling: touch`; внешний border/radius на обёртке, `min-width` таблице), страница НЕ скроллится горизонтально на 375px.

### 2.4 Coverage preview (карта, оба режима)

- NEW `frontend/src/components/settings/TerritoryCoverageMap.tsx`; заголовок-eyebrow `Coverage preview` (`.blanc-eyebrow`).
- Loader: `loadGoogleMaps()` (реюз, VITE_GOOGLE_MAPS_API_KEY). Паттерн JobMap (`CustomTimeModal.tsx:363+`): `mapRef`/`mapInstanceRef`, пере-рендер overlays через refs при смене данных.
- Read-only: `disableDefaultUI: true, gestureHandling: 'none', clickableIcons: false, keyboardShortcuts: false`; никаких обработчиков кликов.
- **radius-режим:** на каждую пару — `new google.maps.Circle({ center:{lat,lng:lon}, radius: radius_miles*1609.34, strokeColor/fillColor: var(--blanc-accent)-производные (fillOpacity ~0.12, strokeWeight 1.5) })`; fitBounds = union `circle.getBounds()`; одна пара → тот же fitBounds (без зума-в-точку).
- **list-режим:** `google.maps.Marker` на каждый `list_centroids[]`; `LatLngBounds.extend` + `fitBounds`; один маркер → `setCenter` + zoom 11 (паттерн JobMap idle-guard от чрезмерного зума).
- Нет данных для активного режима ИЛИ ключ не сконфигурирован / loadGoogleMaps reject → карта и eyebrow НЕ рендерятся (без пустых состояний — канон).
- Высота: ~280px desktop / ~220px mobile, rounded-xl, border var(--blanc-line).

### 2.5 Мобильная вёрстка (375px, приёмочные требования)

- Нет горизонтального скролла страницы ни в одном режиме/виде.
- Header по канону SettingsPageShell (back-link mobile-only, title 2xl); actions-слот шелла страницей больше не используется.
- Toggle режимов и toolbar-кнопки переносятся по строкам (flex-wrap), таппабельны (высота ≥36px).
- ZipTable читается через горизонтальный скролл СВОЕГО контейнера; radius-карточки — full-width колонка; карта full-width.

### 2.6 Онбординг-поверхности

- `WelcomePage.tsx` stepIcons: удалить `company_profile: Receipt`, добавить `service_territory: MapPin` (lucide; импорт Receipt убрать, MapPin добавить). Фолбэк Sparkles сохраняется.
- Никаких других фронт-изменений: карточка шага рендерится data-driven из API.

---

## 3. Сценарии поведения

#### Сценарий 1: первая настройка radius-режима новой компанией
- **Предусловия:** tenant_admin, territory не сконфигурирована (оба режима пусты), active_mode='list' (строки settings нет).
- **Шаги:** /welcome → CTA шага service_territory → /settings/service-territories → toggle Radius (PUT /mode) → форма (zip предзаполнен company_zip) → радиус 25 → Add coverage → POST /radii (геокод: кэш-miss → Google → INSERT zip_geocache) → 201.
- **Ожидаемо:** пара в списке с бейджем Base + city/state; карта показывает круг; счётчик radii=1. Следующий GET /api/onboarding/checklist → service_territory done:true (mode=radius AND EXISTS territory_radii).
- **Побочные эффекты:** строки в company_territory_settings, territory_radii, zip_geocache.

#### Сценарий 2: переключение режимов без потери данных
- **Предусловия:** list-режим с 120 зипами; владелец добавил 2 radius-пары и активировал radius.
- **Шаги:** toggle Zip list → PUT /mode {active_mode:'list'}.
- **Ожидаемо:** список зипов/areas в исходном виде (таблица service_territories не тронута); zip-check/Sara снова отвечают по list-логике (search); radius-пары сохранены и видны при обратном переключении. Никакие данные не стираются НИКОГДА (единственный destructive-путь — существующий bulk-import replace list-режима, он не меняется).

#### Сценарий 3: Sara проверяет зип в radius-режиме
- **Предусловия:** active_mode='radius', пара {zip:'02135', radius:25}; звонок VAPI → tool-call checkServiceArea {zip:'02461'}.
- **Шаги:** vapi-tools (generic dispatch) → skill checkServiceArea → isZipInTerritory → geocodeZip('02461') (кэш или Google) → haversine 02135↔02461 ≈ 7 mi ≤ 25.
- **Ожидаемо:** `{inServiceArea:true, area:'02135', city:'Newton Highlands', state:'MA', zip:'02461'}` — frozen-шейп, Sara озвучивает in-area.
- **Побочные эффекты:** возможная новая строка zip_geocache.

#### Сценарий 4: zip-check из Pulse в radius-режиме, зип вне покрытия
- **Шаги:** GET /api/zip-check?q=01960 → seam → геокод → haversine 30 mi > 25.
- **Ожидаемо:** `{ok:true, data:{success:true, exists:false, area:'', city:'Peabody', state:'MA', zip:'01960'}}` — контракт прежний, exists=false.

#### Сценарий 5: невалидный/несуществующий зип при добавлении пары
- **Шаги:** POST /radii {zip:'00000', radius_miles:25} → normalizeZip ok → geocodeZip → Google ZERO_RESULTS → null.
- **Ожидаемо:** 422 `{error:'ZIP_NOT_FOUND'}`; UI — warm-toast, пара не появилась, territory_radii не изменилась.

#### Сценарий 6: удаление пары
- **Шаги:** Trash на паре → DELETE /radii/:id → 200 → инвалидация config.
- **Ожидаемо:** пара исчезла из списка и с карты; если удалили Base — бейдж переходит к следующей по position паре; удаление последней пары в active_mode='radius' → онбординг-шаг снова not-done (если completed_at ещё не зафиксирован), zip-check отвечает exists:false на всё (safe: пустой radius-набор ничего не покрывает).

#### Сценарий 7: list-режим на мобиле
- **Шаги:** 375px, list-режим, All Zip Codes.
- **Ожидаемо:** header/toggle/кнопки в потоке с переносами; таблица скроллится внутри своего контейнера; страница без горизонтального скролла; карта (если есть центроиды) full-width read-only и не мешает вертикальному скроллу (gestureHandling 'none').

#### Сценарий 8: онбординг-чеклист с новым шагом
- **Предусловия:** новая компания, ничего не настроено.
- **Ожидаемо:** GET /checklist → items[0] = service_territory (done:false, est_minutes:2, нормативные строки §1.6), итого 4 шага; /welcome рендерит карточку с MapPin. После конфигурации территории (любой режим) → done:true, done_note. Ключ company_profile в ответе отсутствует.

### Граничные случаи

1. Строки company_territory_settings нет → везде mode='list' (byte-compat для всех существующих компаний).
2. active_mode='radius', пар нет → isZipInTerritory всегда inside:false; страница показывает radius-empty-state; онбординг-шаг not-done.
3. Radius-запрос городом/адресом без зипа («Boston») → inside:false (radius сужен до зипов — задокументировано); list-режим матчит города как раньше.
4. Зип с ведущим нулём, пришедший как число/«1721» → normalizeZip → «01721» на всех входах (POST /radii, seam, геокод).
5. Две пары покрывают один зип → area = зип БЛИЖАЙШЕГО центра.
6. Пара с радиусом 200 (максимум) — валидна; 200.1 → 400.
7. zip_geocache имеет строку с lat/lon NULL (не должен появляться при DO NOTHING-инсертах успешных геокодов, но защитно) → трактуется как miss → повторный геокод.
8. Дубль зипа в парах (02135×10mi и 02135×40mi) — допустим; containment берёт максимальное покрытие естественно (любая покрывающая).
9. GET /config при >10 некэшированных list-зипов → ленивый досев ровно 10 за запрос; карта наполняется на последующих загрузках.
10. Existing-компания с completed_at (онбординг завершён по старому каталогу) → карточка/hub не ресурфейсятся; прямой заход на /welcome честно покажет service_territory not-done (write-once семантика ONBOARDING-UX-001 сценарий 7).

### Обработка ошибок

1. Геокод-фейл на POST /radii → 422 ZIP_NOT_FOUND → toast «We couldn't find that ZIP — check the digits and try again.», форма сохраняет ввод.
2. Геокод-фейл/нет ключа внутри isZipInTerritory (radius) → inside:false + console.warn (safe-fail; Sara/zip-check отвечают «вне зоны» — не 500).
3. PUT /mode сеть/500 → optimistic-откат toggle + toast error.
4. DELETE чужого/несуществующего id → 404 (не 403 — не раскрываем существование чужих данных).
5. GET /config 500 → страница показывает существующий list-UI (queries независимы) + toast; radius-панель — skeleton/недоступна.
6. loadGoogleMaps reject (нет VITE-ключа/сеть) → карта тихо не рендерится, консоль-warn; остальная страница полнофункциональна.
7. Ошибка деривации онбординг-шага → прежняя семантика (bubbles → 500 INTERNAL_ERROR, как в существующих тестах ONBTEL).

### Взаимодействие компонентов

- ServiceTerritoriesPage → authedFetch GET /config → routes/service-territories → territoryRadiusQueries (+ territoryGeoService lazy-seed) → PG.
- ServiceTerritoriesPage (Add) → POST /radii → territoryGeoService.geocodeZip (zip_geocache → Google Geocoding) → territoryRadiusQueries.createRadius.
- TerritoryCoverageMap ← props (mode, radii, list_centroids) ← config; loadGoogleMaps → Circle/Marker.
- useZipCheck (НЕ меняется) → GET /api/zip-check → territoryService.isZipInTerritory → {stQueries.search | geocodeZip+haversine}.
- VAPI → routes/vapi-tools (не меняется) → agentSkills.runSkill('checkServiceArea') → skill → territoryService.isZipInTerritory. Yelp-агент/outbound — те же skills → получают режим бесплатно.
- onboardingChecklistService → SQL по company_territory_settings/service_territories/territory_radii → /welcome карточка.
- SSE не используется (настройки — не realtime; refetch по мутациям/фокусу достаточен).

### Copy (нормативные строки UI; English, «Blanc» запрещён)

| Место | Строка |
|---|---|
| Онбординг-шаг | см. §1.6 (title/description/done_note — нормативные) |
| Page description | `Tell Albusto where you work — as a zip list, or as a radius around your base.` |
| Mode toggle | `Zip list` · `Radius` |
| Подпись под toggle | `Both setups are saved — switching modes never erases anything.` |
| Radius empty state (заголовок/подзаголовок) | `No coverage yet` / `Add your base ZIP and how far you'll drive — that's your service area.` |
| Radius inputs | `ZIP code` · `Radius (miles)` |
| Add-кнопка radius | `Add coverage` |
| Бейдж первой пары | `Base` |
| Строка пары | `{zip} · {radius} mi` (вторичная строка `{city}, {state}` — только если есть) |
| Карта (eyebrow) | `Coverage preview` |
| 422-toast | `We couldn't find that ZIP — check the digits and try again.` |
| Toast добавления/удаления | `Coverage added` / `Coverage removed` |
| List empty state | без изменений (`No zip codes yet` / `Add zip codes manually or import from a CSV file.`) |

### Безопасность и изоляция данных

- Все новые endpoints — под существующим mount `authenticate + requirePermission('tenant.company.manage') + requireCompanyAccess`; company_id ТОЛЬКО из `req.companyFilter?.company_id` (через существующий `getCompanyId`, DEFAULT_COMPANY_ID-фолбэк сохранён). Без токена → 401; без права → 403.
- Все SQL по company_territory_settings/territory_radii фильтруют по company_id; DELETE /radii/:id чужой компании → 404.
- zip_geocache — глобальная таблица БЕЗ tenant-данных (только публичные координаты зипов) — задокументированное исключение.
- Геокодинг-ключ — только сервер (env); фронт-карта — свой VITE_GOOGLE_MAPS_API_KEY (как JobMap).
- isZipInTerritory не раскрывает потребителям ничего сверх frozen-шейпов.
