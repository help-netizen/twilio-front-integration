# MOBILE-TECH-APP-001 — Spec

**Статус:** Detailed Spec (pre-build) · **Дата:** 2026-07-02 · **Продукт:** Albusto (в UI — только «Albusto»)
**Родитель (дизайн, авторитетный):** `Docs/specs/MOBILE-TECH-APP-001.md` — этот документ его НЕ переопределяет, а углубляет (поведение, контракты, протоколы, edge-cases).
**Тип:** greenfield нативный iOS-клиент (`albusto-mobile`, отдельный репо, RN + Expo dev-client) + минимальные аддитивные изменения существующего Node/Express + Postgres + Keycloak backend. Кода ещё нет.
**Смежные спеки (переиспользуем/не дублируем):** RBAC-FSM-FIX-001 (FSM-гейты provider), JOBS-UX-RBAC-001 (provider finance + `payments.collect_terminal`), NOTE-ATTACH-UPLOAD-001 (`note_attachments`, S3/Tigris), ONWAY-001 (`notifyOnTheWay`, geolocation→ETA), AUTH-SESSION-001 (30-дневная сессия Keycloak), STRIPE-PAY-001 (Connect + Terminal Phase 4), JOB-TECH-ASSIGN-001 (reassign путь → триггер пуша).

> **LOCKED DECISIONS (binding, не пересматриваются):** RN + Expo dev-client; отдельный репо; **офлайн = READ-ONLY** (просмотр кэша; ЛЮБАЯ запись требует сети — нет офлайн-очереди, нет разрешения конфликтов); v1 = schedule + job detail + смена статуса (start/en-route/done) + notes+photos + навигация (Apple Maps) + звонок (`tel:`) + **APNs push**; **Tap to Pay (Stripe Terminal) = v1.5**; **CallKit VoIP = v2**; **iOS only**.

---

## 0. Ground-truth backend (сверено с исходниками — не пересматривать при реализации)

Расхождения между дизайн-доком и кодом, которые этот spec фиксирует явно:

| # | Факт (проверено) | Файл | Следствие для мобилы |
|---|---|---|---|
| G1 | **Заметки job хранятся в `jobs.notes` JSONB**, не в `crm_notes` (та — sales-CRM, без `updated_at`). `addNote` делает `UPDATE jobs SET notes=$1::jsonb, updated_at=NOW()`. | `services/jobsService.js:909` | **Изменение заметки бампает `jobs.updated_at`** → delta-sync тянет заметки внутри строки job. Отдельный курсор по заметкам НЕ нужен. |
| G2 | **Нет soft-delete нигде** (`deleted_at` отсутствует у jobs/notes). Удаления — hard. | миграции | Тумбстоуны для delta-sync НЕ существуют «из коробки». Нужен новый механизм (§4.1 + §8.T1). Основной кейс «работа пропала из списка» — это **снятие назначения** (job жив, но перестал `@>` мой id), а не удаление строки. |
| G3 | `POST /:id/enroute` и `/:id/start` гейтятся **`jobs.edit` ТОЛЬКО** — а `provider` его НЕ имеет. `/:id/complete` = `('jobs.close','jobs.done_pending_approval')` (OR). Заметки `POST` уже расширены до `('jobs.edit','jobs.done_pending_approval')`. | `routes/jobs.js:393,408,423,432` | **Прямые роуты enroute/start дадут provider 403.** RBAC-FSM-FIX-001 декларирует расширение start/enroute до OR-гейта, но в дедицированных роутах оно НЕ применено (только у notes и у `PATCH /:id/status`? — нет, `PATCH /:id/status` тоже `jobs.edit`). **Backend-prerequisite §8.T0** — иначе смена статуса из приложения не работает для техника. |
| G4 | Stripe Terminal **уже частично есть**: `POST /api/stripe-terminal/connection-token` + `/payment-intents/:id/cancel` (гейт `payments.collect_terminal`); сервис `createTapToPayIntent()` (surface `tap_to_pay`, `card_present`, `capture_method:'automatic'`) существует, но **роут create НЕ смонтирован**. `assertCollectable()` → **409 `NOT_READY`** если онбординг/entitlement не готовы. | `routes/stripeTerminal.js`, `services/stripePaymentsService.js:304,338,354` | v1.5 — это ОДИН новый роут (create) + провод в существующий сервис. §8.T4. |
| G5 | Пуши сегодня — только Web Push (VAPID, `push_subscriptions`) + SSE (browser-only). **Ни APNs, ни FCM, ни device-token-таблицы нет.** | `routes/push-subscriptions.js` | Нативный APNs — с нуля. §8.T2. |
| G6 | `company_id` берётся ТОЛЬКО из `req.authz.company.id` (fallback на `crm_users.company_id` удалён — ONBOARD-FIX-001). `getProviderScope` → `assigned_only` + `crm_users.id`; **нет id → deny-by-default (0 работ)**. | `middleware/keycloakAuth.js`, `middleware/providerScope.js:15` | Кэш `/api/auth/me` критичен; см. §2.5 (риск нулевой видимости). |

Ключевые проверенные значения (используются в контрактах ниже):
- **Предикат scope:** `j.assigned_provider_user_ids @> $n::jsonb` (JSONB-массив с `crm_users.id`; GIN-индекс `idx_jobs_assigned_provider_user_ids`).
- **`jobs` колонки (для карточки):** `id`, `blanc_status`, `assigned_provider_user_ids` (jsonb), `assigned_techs` (jsonb, внешние ZB-метаданные), `customer_name`, `customer_phone`, `customer_email`, `address`, `city`, `normalized_address`, `lat`, `lng`, `start_date`, `end_date`, `zb_status` (`scheduled|en-route|in-progress|complete`), `zenbooker_job_id`, `job_number`, `service_name`, `invoice_total`, `invoice_status`, `notes` (jsonb), `created_at`, `updated_at` (trigger `trg_jobs_updated_at`).
- **`blanc_status` значения:** `Submitted`, `Waiting for parts`, `Follow Up with Client`, `Visit completed`, `Job is Done`, `Rescheduled`, `Canceled`.
- **Семантика роутов статуса:** `enroute`→ `zb_status='en-route'` (blanc_status НЕ меняется); `start`→ `zb_status='in-progress'`; `complete`→ `zb_status='complete'` + `blanc_status='Visit completed'`; `cancel`→ `blanc_status='Canceled'`+`zb_canceled=true`.
- **Multer (notes):** поле `attachments`, ≤ **5** файлов, ≤ **10 MB**/файл, MIME image/*(jpeg,png,webp,heic,heif,gif)+pdf/doc/xls, `memoryStorage`. Вложения → таблица `note_attachments` (S3 `storage_key`, `note_index`).
- **Keycloak:** realm `crm-prod`, public client `crm-web` (PKCE S256); `accessTokenLifespan=300` (5 мин); `rememberMe=true`, `ssoSession{Idle,Max}TimeoutRememberMe=2592000` (30 дней). Setup: `scripts/setup-keycloak.sh`, export `keycloak/realm-export.json`.
- **Курсорный паттерн (мирроринг):** `emailQueries.js` — cursor `"{ts}|{id}"`, `WHERE (col, id) <cmp> ($ts,$id)`, `ORDER BY col DESC, id DESC`. Для delta берём **forward**: `ORDER BY updated_at ASC, id ASC`, `WHERE (updated_at,id) > (...)`.

---

## 1. Общее описание

Нативное iOS-приложение для роли `provider` (полевой техник). Источник правды для чтения — локальный SQLite-кэш; экраны рисуются мгновенно из кэша, sync-движок тихо обновляет. Любая запись (статус/заметка/фото/оплата) идёт прямо на backend и **только при сети**. Пуши через APNs. v1.5 добавляет приём оплаты картой на месте (Tap to Pay), v2 — CallKit VoIP.

---

## 2. Раздел A — Офлайн-протокол read-only sync (ядро)

### 2.1 Контракт `GET /api/sync/jobs` (новый)

**Назначение:** provider-scoped delta — вернуть изменённые/выпавшие-из-скоупа/удалённые назначенные работы (с их заметками внутри строки) с момента курсора.

- **Path:** `GET /api/sync/jobs`
- **Middleware:** `authenticate, requireCompanyAccess, requirePermission('jobs.view')` + `getProviderScope(req)` внутри хендлера.
- **Query:**
  - `since` (string, опц.) — курсор `"{ISO8601}|{jobId}"`. Отсутствует/пусто → **initial full sync** (всё в скоупе).
  - `limit` (int, опц., default 200, max 500) — размер страницы (для пагинации большого initial pull).
  - `window_days` (int, опц., default 30) — окно расписания для full sync (см. §2.4). Игнорируется при incremental (delta всегда полное по времени, чтобы не потерять правки старых открытых работ).
- **Изоляция:** `company_id` только из `req.authz.company.id`; scope только `@>` `crm_users.id`. Нет `crm_users.id` (deny-by-default) → `changed: [], unassigned: [], tombstones: []`, `next_cursor` = входной (клиент не двигается) + флаг `scope_empty: true` (§6.C3).

**Response `200`:**
```
{
  "ok": true,
  "data": {
    "changed": [ Job, ... ],          // upsert в SQLite; заметки — в Job.notes
    "unassigned": [ 4412, 4417 ],     // jobId, ВЫПАВШИЕ из моего скоупа (снят с назначения) — удалить из кэша
    "tombstones": [ 4390 ],           // jobId, HARD-удалённые (из job_tombstones) — удалить из кэша
    "next_cursor": "2026-07-02T15:04:05.123Z|4420",
    "has_more": false,                // true → страниц ещё есть, повторить с next_cursor немедленно
    "scope_empty": false,             // true → deny-by-default (нет crm_users.id)
    "server_time": "2026-07-02T15:04:06.000Z"
  }
}
```

`Job` — та же форма, что `GET /api/jobs/:id` (`data`), плюс гарантированно включает `notes[]` (с `attachments[]`: `{ id, fileName, contentType, fileSize }` — БЕЗ presigned URL; URL берётся лениво по `GET /api/note-attachments/:id/url`, см. §3.4).

**Ошибки:** `401` (нет/невалидный токен — Bearer), `403` (не участник компании / platform-only), `400` (битый `since`). Роут НЕ отдаёт `404` — пустой скоуп ≠ ошибка.

### 2.2 Устройство курсора (стабильный tiebreak)

Мирроринг `emailQueries.js`, но forward:
- **`ORDER BY j.updated_at ASC, j.id ASC`**.
- **`WHERE (j.updated_at, j.id) > ($since_ts, $since_id)`** для `changed`.
- `next_cursor = "{last.updated_at.toISOString()}|{last.id}"`; при пустой странице → возвращаем входной `since` без изменений.
- **Почему `(updated_at, id)`, а не `updated_at`:** несколько работ с одинаковым `updated_at` (батч ZB-sync) не потеряются и не задублируются — id разрывает ничью детерминированно. Тот же приём, что `getUnifiedTimelinePage`.
- **Clock-safety:** курсор — это `updated_at` последней ОТДАННОЙ строки, а не «сейчас» сервера. Поэтому запись, случившаяся во время пагинации, не проскочит мимо (её `updated_at` ≥ курсора → попадёт на следующей странице). `server_time` — только для UX «данные от {время}», НЕ для курсора.

### 2.3 `unassigned` и `tombstones` (решение проблемы G2 «нет soft-delete»)

Две причины, по которым работа должна исчезнуть из кэша:
1. **Снятие/переназначение** (частый кейс): диспетчер убрал техника → `assigned_provider_user_ids` больше не содержит его id. Строка ЖИВА, `updated_at` бампнулся (см. JOB-TECH-ASSIGN-001: `reassignJob` пишет `assigned_provider_user_ids` + `updated_at=NOW()`). Delta-запрос должен вернуть такие id в `unassigned`.
   - **Реализация:** отдельным под-запросом — «работы компании, чей `updated_at > since_ts`, которые я НЕ вижу под своим scope, но которые я МОГ видеть раньше». «Мог видеть раньше» точно вычислить нельзя (истории членства нет), поэтому применяем безопасное правило: вернуть в `unassigned` **все** `job.id`, у которых `updated_at > since` и `NOT (assigned_provider_user_ids @> [me])`. Клиент удаляет их из кэша, если они там были (если не было — no-op). Стоимость мала (у техника десятки работ), лишних данных не течёт (возвращаются только id, без полей).
2. **Hard-delete** (редкий кейс): нужна новая таблица `job_tombstones(company_id, job_id, deleted_at)` (§8.T1), заполняемая хуком удаления job. Delta возвращает `tombstones = SELECT job_id FROM job_tombstones WHERE company_id=$c AND deleted_at > since_ts`.

> **Важно:** `unassigned` и `tombstones` НЕ двигают `next_cursor` сами по себе — курсор ведётся по `changed.updated_at`. Но их «since» — тот же `since_ts` из курсора, поэтому клиент, продвинув курсор по `changed`, на следующем sync не потеряет удаления (они привязаны к тому же временно́му порогу). При `has_more:true` (пагинация initial pull) `unassigned/tombstones` отдаются ТОЛЬКО на последней странице (когда `has_more:false`), чтобы не удалить преждевременно.

### 2.4 Initial full sync vs incremental

- **Fresh install / `since` пуст:** full sync = «все назначенные работы в окне `window_days` (default 30, вперёд+назад от now) ПЛЮС все открытые (не `Visit completed`/`Job is Done`/`Canceled`) вне окна». Пагинация по `limit` + `has_more`. Клиент гоняет страницы, пока `has_more:false`, копит `changed`, применяет разом. `next_cursor` последней страницы → `sync_state.last_cursor`.
- **Incremental / `since` задан:** только `(updated_at,id) > cursor`, БЕЗ ограничения окном (иначе правка старой открытой работы вне окна потеряется). Объёмы тривиальны (§ данные: 10–50 работ/нед).
- **Full re-sync (recovery):** клиент сбрасывает `since` (посылает пусто) если: (a) детектит разрыв (напр. 401→refresh не помог и кэш старше N дней), (b) юзер дёрнул «Reload data» в настройках, (c) сменился `crm_user_id` в `/api/auth/me` (другой аккаунт). Полный pull идемпотентен (upsert по id).

### 2.5 Схема SQLite-кэша (по колонкам)

БД: `op-sqlite` (или `expo-sqlite`), WAL, файл в app-sandbox (не в iCloud-бэкапе — `NSURLIsExcludedFromBackupKey`, т.к. кэш восстановим).

**`jobs`** (зеркало нужного подмножества строки job):
| колонка | тип | заметка |
|---|---|---|
| `id` | INTEGER PK | `jobs.id` |
| `blanc_status` | TEXT | |
| `zb_status` | TEXT | `scheduled/en-route/in-progress/complete` |
| `customer_name` | TEXT | |
| `customer_phone` | TEXT | для `tel:` |
| `customer_email` | TEXT | |
| `address` | TEXT | для Apple Maps |
| `city` | TEXT | тайл «Name, City» |
| `normalized_address` | TEXT | предпочтителен для гео-ссылки |
| `lat` / `lng` | REAL | если есть — маршрут по координатам |
| `start_date` / `end_date` | TEXT (ISO) | окно визита |
| `service_name` | TEXT | |
| `job_number` | TEXT | |
| `invoice_total` / `invoice_status` | TEXT | инфо (Tap to Pay в v1.5) |
| `zenbooker_job_id` | TEXT | для баннера ZB-расхождения (§6.C4) |
| `assigned_techs_json` | TEXT (JSON) | отображение назначения |
| `updated_at` | TEXT (ISO) | локальный водяной знак строки |
| `raw_json` | TEXT (JSON) | полный `Job` (forward-compat, чтобы не мигрировать схему на каждое новое поле) |

**`notes`** (разворачиваем `job.notes[]` для быстрых списков; source of truth всё равно `raw_json`):
| колонка | тип | заметка |
|---|---|---|
| `job_id` | INTEGER | FK jobs.id (индекс) |
| `note_index` | INTEGER | порядковый (ключ join к вложениям) |
| `note_id` | TEXT | ZB note id или локальный (nullable) |
| `text` | TEXT | |
| `author` | TEXT | |
| `created` | TEXT (ISO) | |
| `attachments_json` | TEXT (JSON) | `[{id,fileName,contentType,fileSize}]` — без URL |
PK: `(job_id, note_index)`. При upsert job: `DELETE FROM notes WHERE job_id=? ` затем реинсерт (заметки — часть строки job, перезаписываются целиком).

**`schedule_index`** (лёгкий индекс для экрана расписания — день/неделя без парсинга каждого `raw_json`):
| колонка | тип |
|---|---|
| `job_id` | INTEGER PK |
| `day` | TEXT (`YYYY-MM-DD`, локальный день по `start_date` в TZ компании) |
| `start_at` | TEXT (ISO) |
| `sort_key` | INTEGER (epoch сек для ORDER BY) |
Индекс `(day, sort_key)`. Перестраивается из `jobs` при каждом применении delta.

**`sync_state`** (одна строка):
| колонка | тип | заметка |
|---|---|---|
| `id` | INTEGER PK CHECK(id=1) | синглтон |
| `last_cursor` | TEXT | `"{ts}|{id}"`; NULL → ещё не синхронизировались |
| `last_synced_at` | TEXT (ISO) | `server_time` последнего успешного sync (для UX-баннера) |
| `crm_user_id` | TEXT | из `/api/auth/me`; смена → wipe+full re-sync |
| `company_id` | TEXT | из `/api/auth/me` |
| `schema_version` | INTEGER | миграции локальной БД |
| `full_sync_done` | INTEGER (0/1) | завершён ли первый полный pull |

### 2.6 Клиентский sync state-machine

Состояния: `UNINITIALIZED → FULL_SYNCING → READY → INCREMENTAL_SYNCING → READY` (+ `ERROR`, `OFFLINE`).

| Состояние | Вход | Действие | Выход |
|---|---|---|---|
| **UNINITIALIZED** | fresh install / после wipe | требует валидный токен (auth §2 A). Нет сети → `OFFLINE` с пустым кэшем (экран «Connect to load your schedule»). | → FULL_SYNCING при сети+токене |
| **FULL_SYNCING** | `since` пуст | цикл `GET /api/sync/jobs?since=` → applyDelta → пока `has_more` | успех → `full_sync_done=1`, `READY`; ошибка → `ERROR` (кэш всё ещё пуст) |
| **READY** | кэш валиден | рисуем из SQLite. Триггеры инкремента: **app-foreground**, **pull-to-refresh**, **push-received (data)** , **таймер 60 с при активном приложении** (мягкий), **экран job detail открыт → точечный refresh этой работы через `/api/sync/jobs?since=<её updated_at минус эпсилон>`** (или просто общий incremental). | любой триггер → INCREMENTAL_SYNCING |
| **INCREMENTAL_SYNCING** | `since=last_cursor` | `GET /api/sync/jobs?since=...` → applyDelta (upsert changed, delete unassigned+tombstones, rebuild schedule_index), продвинуть `last_cursor`+`last_synced_at`. | успех → `READY`; сеть-ошибка → `READY` + тихий баннер «Couldn't refresh»; 401 → auth-refresh (§2 A), затем retry раз |
| **OFFLINE** | сеть пропала | рисуем кэш, баннер staleness (§2.7). Записи заблокированы. | сеть вернулась → INCREMENTAL_SYNCING |
| **ERROR** | full sync упал | экран «Couldn't load. [Retry]». | Retry → FULL_SYNCING |

`applyDelta` — атомарно в одной SQLite-транзакции: upsert `changed`, delete `unassigned`+`tombstones`, rebuild `notes`+`schedule_index` для затронутых job, обновить `sync_state`. При сбое транзакции — rollback, `last_cursor` НЕ двигается (следующий sync повторит тот же diff — идемпотентно).

### 2.7 Staleness UX

- Онлайн, sync свежий (< 5 мин): баннера нет.
- Онлайн, sync давно / идёт refresh: тонкий верхний бар «Refreshing…» (не блокирует).
- **Офлайн:** постоянный баннер (Albusto ink-2, без border): **`Offline — showing data from {relativeTime}`**, где `{relativeTime}` = «2 minutes ago» / «today 9:14 AM» / «Jul 1». Источник — `sync_state.last_synced_at`.
- Кэш старше **7 дней** (порог) в офлайне: баннер усиливается — **`Offline — data may be outdated (last updated {date})`** (ink-1). Данные всё равно показываем (read-only, лучше что-то, чем ничего).
- Все действия-записи в офлайне: кнопки `disabled` + подпись **`Needs connection`** (см. §3.3).

---

## 3. Раздел C — Поведение по фичам (Given/When/Then, вкл. OFFLINE + ERROR)

Все UI-строки — английские; продукт «Albusto».

### 3.1 Schedule (день/неделя)

- **Given** техник аутентифицирован и `full_sync_done=1`.
  **When** открывает Schedule.
  **Then** экран рисует из `schedule_index`+`jobs` мгновенно; дни-заголовки; тайл = `blanc_status` бейдж + `CustomerName, City` (одна строка, plain-text — не Maps-ссылка, JOBS-UX-RBAC-001) + окно времени. Переключатель Day/Week. По умолчанию — сегодня.
- **When** pull-to-refresh **Then** INCREMENTAL_SYNCING; спиннер; по успеху список обновляется, `last_synced_at` свежий.
- **OFFLINE:** список из кэша + баннер staleness; pull-to-refresh показывает «Offline» тост, немедленно завершается.
- **ERROR (ещё не было full sync, сеть есть, sync упал):** «Couldn't load your schedule. [Retry]».
- **Empty (скоуп пуст, `scope_empty:true`):** «No jobs assigned to you» + подсказка refresh. НЕ трактовать как ошибку.
- **Edge:** работа с `start_date=NULL` → секция «Unscheduled» внизу текущего дня.

### 3.2 Job detail (офлайн-чтение)

- **Given** тап по тайлу.
  **When** открывается карточка.
  **Then** из кэша (`raw_json`): заголовок (крупно, per Albusto — имя/клиент), контакт (phone/email в шапке, без «CONTACT» заголовка), адрес, окно, статус, назначение, финансы (`invoice_total/status`), лента заметок (текст + миниатюры вложений). Технические id (`zenbooker_job_id`, `contact_id`) не показываем; ZB-иконка-ссылка опционально.
- Открытие карточки триггерит тихий incremental (свежесть именно этой работы).
- **OFFLINE:** всё из кэша; миниатюры вложений — только если файл уже в локальном image-кэше (иначе плейсхолдер «Photo — needs connection»; см. §3.4). Баннер staleness.
- **Edge (работа исчезла на сервере — reassign/tombstone — но юзер уже внутри карточки):** следующий sync вернёт id в `unassigned/tombstones` → карточка показывает мягкий оверлей **`This job is no longer assigned to you`** + [Back to schedule]; кэш-строка удаляется по выходу.

### 3.3 Смена статуса (start / en-route / done) — ТОЛЬКО ОНЛАЙН

Кнопки по состоянию (мирроринг JOBS-UX-RBAC-001 `JobStatusTags`): Submitted/scheduled → **[On the way]** + **[Start job]**; en-route → **[Start job]**; in-progress → **[Complete job]**; terminal → нет.

- **Given** онлайн, provider назначен, соответствующий переход валиден.
  **When** тап «Start job».
  **Then** `POST /api/jobs/:id/start` → in-flight (кнопка disabled+spinner) → `200` → тост `Job started` → точечный refresh этой работы (incremental) → кнопки перерисовываются. Побочно: `zb_status='in-progress'`, `updated_at` бампнут (delta подхватит).
- «On the way»: см. **ONWAY-001** — открывает лист (geolocation→ETA-плитки→«Notify client»): SMS клиенту (первично) → затем статус (best-effort). Тот же контракт `jobsApi.notifyOnTheWay(id,{eta_minutes})`. В мобиле geolocation — нативный CoreLocation (permission-запрос), фейл → плитки без ETA (состояние (c)).
- «Complete job»: `POST /api/jobs/:id/complete` → `blanc_status='Visit completed'` → тост `Job completed`.
- **Cancel** в v1 из приложения — **не даём** (dispatch-решение; `jobs.close` у provider нет). Кнопки Cancel в мобиле нет вовсе.
- **OFFLINE:** все кнопки статуса `disabled`, подпись **`Needs connection`**; тап → тост `You're offline — reconnect to update this job`. Нет очереди (LOCKED).
- **FSM-guard (ERROR ветка):** если сервер отклонит переход (напр. работа уже `Canceled`) → `400 {ok:false,error:"Transition X → Y is not allowed"}` → тост **`Can't change status — this job was updated. Refreshing…`** + форс-incremental + перерисовка кнопок из свежего статуса.
- **Provider-permission (ERROR ветка):** `403` → тост **`You don't have permission for this action`** (не должно случаться после §8.T0; ловим на всякий).
- **Race (работа переназначена, пока техник жмёт):** `404 {ok:false,error:"Job not found"}` (scope больше не совпал) → тост **`This job is no longer assigned to you`** + удалить из кэша + [Back to schedule]. См. §6.C6.

### 3.4 Заметки + фото — ТОЛЬКО ОНЛАЙН

- **Given** онлайн, provider назначен.
  **When** добавляет заметку (текст и/или до 5 фото с камеры/галереи).
  **Then** аналогично NOTE-ATTACH-UPLOAD-001, но нативно:
  - Фото делаются нативной камерой (permission `NSCameraUsageDescription`), сжимаются на устройстве (≤ ~10 MB, длинная сторона ~2048 px, JPEG q~0.7 — под лимит multer 10 MB).
  - **Опция А (рекоменд., переиспользует NOTE-ATTACH-UPLOAD-001):** каждое фото сразу `POST /api/note-attachments/upload` (FormData: `attachments`, `entity_type=job`, `entity_id`) → чип со спиннером → `{id}`. «Save» задизейблен пока хоть один upload идёт. Отправка заметки: `POST /api/jobs/:id/notes` с `text` + `attachment_ids` (JSON), БЕЗ сырых байт.
  - **Опция Б (фолбэк):** `POST /api/jobs/:id/notes` мультипарт `attachments[]` напрямую (роут это принимает).
  - Успех → `200` → тост `Note added` → incremental (заметка появляется в ленте; `jobs.updated_at` бампнут — G1).
- **Просмотр вложения (URL ленивый):** миниатюра/полноэкран → `GET /api/note-attachments/:id/url` → presigned S3 URL → загрузка + локальный image-кэш (по `attachment.id`). Кэш переживает офлайн: раз загруженное фото видно офлайн; незагруженное офлайн → плейсхолдер `Photo — needs connection`.
- **OFFLINE:** «Add note» и камера-кнопка `disabled` + `Needs connection`.
- **ERROR (upload фото упал):** чип в состоянии ⚠ + [Retry]; «Save» остаётся disabled пока не убрать/переуспешить (см. §6.C7). `413`/большой файл → `400` → «Photo too large — try again».
- **ERROR (сеть отвалилась в момент submit):** тост `Upload failed — you're offline. Nothing was saved.` (write-through, без очереди).

### 3.5 Навигация (Apple Maps deep-link из кэша)

- **Given** у работы есть `normalized_address`/`address` (и/или `lat,lng`) в кэше.
  **When** тап «Directions».
  **Then** открыть Apple Maps: предпочтительно по координатам `maps://?daddr={lat},{lng}` если есть; иначе по адресу `maps://?daddr={urlEncoded(normalized_address||address)}` (universal link `https://maps.apple.com/?daddr=...` как фолбэк).
- **OFFLINE:** работает — адрес из кэша; Apple Maps сам разрулит офлайн-карту как умеет. Кнопка НЕ дизейблится офлайн.
- **Edge:** нет ни адреса, ни координат → кнопка скрыта.
- Google Maps как альтернатива — не в v1 (Apple Maps, LOCKED).

### 3.6 Звонок клиенту (`tel:`)

- **Given** `customer_phone` в кэше.
  **When** тап «Call».
  **Then** `tel:{e164}` → системный dialer (MOBILE-NO-SOFTPHONE-001: на мобиле VoIP не используем в v1; CallKit — v2). Caller ID — личный номер устройства (в v1; company-caller-id придёт с CallKit v2, §7).
- **OFFLINE:** работает (номер из кэша, звонок — сотовая сеть, не наш backend). Не дизейблить.
- **Edge:** нет номера → кнопка скрыта.

### 3.7 APNs push

- **Регистрация:** после логина + APNs-permission (`UNUserNotificationCenter`) → получить device token → `POST /api/devices` (§4.2). При каждом cold-start/refresh токена — переотправить (idempotent upsert). При logout → `DELETE /api/devices/:token`.
- **Что триггерит push (сервер, §8.T2/§4.2):**
  1. **Новое назначение** — provider добавлен в `assigned_provider_user_ids` (хук в reassign-путь `scheduleService.reassignItem`/`reassignJob`, JOB-TECH-ASSIGN-001).
  2. **Перенос (reschedule)** назначенной работы — изменение `start_date`/`end_date` на работе, где provider назначен.
- **Payload:** `alert` (локализованный текст) + `data: { type: 'job_assigned'|'job_rescheduled', job_id }`. Silent-часть (`content-available:1`) — чтобы приложение при получении дёрнуло incremental sync.
- **Тап по пушу:** deep-link `albusto://job/{job_id}` → открыть карточку. Если работы нет в кэше (только пришла) → сначала incremental sync, потом карточка; если всё ещё нет (гонка) → «Loading job…» → по появлению открыть, иначе тост.
- **Given foreground** пуш пришёл **Then** тихий баннер в приложении + фон-incremental (не выдёргиваем экран).
- **Edge (нет прав на пуши):** приложение работает; вместо пуша — обновление по foreground/60-с таймеру. Показать в настройках подсказку включить нотификации.

---

## 4. Раздел D — Контракты новых backend-эндпоинтов

Общая рамка: `authenticate, requireCompanyAccess`; `company_id` ТОЛЬКО из `req.authz.company.id`; provider-scope где применимо; тесты `401/403` + межтенантная изоляция. Конверт ответа: `{ ok, data }` / `{ ok:false, error }`.

### 4.1 `GET /api/sync/jobs` (v1) — см. §2.1/§2.2/§2.3

- **Middleware:** `authenticate, requireCompanyAccess, requirePermission('jobs.view')`; `getProviderScope(req)`.
- **Query:** `since?`, `limit?`(≤500), `window_days?`.
- **200:** `{ ok, data: { changed[], unassigned[], tombstones[], next_cursor, has_more, scope_empty, server_time } }`.
- **Ошибки:** `400` битый `since`; `401`; `403`.
- **SQL-скелет:** `changed`: `SELECT ... FROM jobs j WHERE j.company_id=$c AND j.assigned_provider_user_ids @> $me::jsonb AND (j.updated_at,j.id) > ($ts,$id) ORDER BY j.updated_at ASC, j.id ASC LIMIT $lim+1`. `unassigned`: `SELECT j.id FROM jobs j WHERE j.company_id=$c AND j.updated_at > $ts AND NOT (j.assigned_provider_user_ids @> $me::jsonb)`. `tombstones`: `SELECT job_id FROM job_tombstones WHERE company_id=$c AND deleted_at > $ts`. (initial full: WHERE добавляет окно `window_days` + open-фильтр вместо курсора.)

### 4.2 APNs device-register (v1)

- **`POST /api/devices`** — `authenticate, requireCompanyAccess`.
  - **Req:** `{ apns_token: string, platform: "ios", app_version?: string, device_model?: string }`.
  - **Поведение:** upsert в `device_tokens(company_id, crm_user_id, apns_token, platform, app_version, last_seen_at, created_at)` c уникальностью по `(apns_token)` (переносим владельца при смене юзера на устройстве — старую пару обнуляем/перепривязываем). `crm_user_id = req.user.crmUser.id` (если нет — `409 {code:'NO_CRM_USER'}`, т.к. пуши без scope бессмысленны).
  - **201/200:** `{ ok, data:{ registered:true } }`. **Ошибки:** `400` (нет токена/битый), `401`, `403`, `409` (нет crm_user_id).
- **`DELETE /api/devices/:token`** — `authenticate, requireCompanyAccess`.
  - Удаляет пару `(company_id, apns_token)` **только своего** `crm_user_id`. `200 { ok, data:{ removed:true } }`. Идемпотентно (нет строки → тоже `200`). `401/403`.
- **Server-side триггеры пуша (хуки, не эндпоинты):**
  - В `scheduleService.reassignItem` / `jobsService` reassign-путь: после успешного `UPDATE ... assigned_provider_user_ids` — вычислить **добавленные** id (diff old→new), для каждого добавленного → `pushService.sendToUser(company_id, crm_user_id, {type:'job_assigned', job_id})`.
  - В reschedule-путь (изменение `start_date`/`end_date`): для текущих назначенных id → `{type:'job_rescheduled', job_id}`.
  - `pushService` резолвит `device_tokens` по `(company_id, crm_user_id)`, шлёт через APNs (token-based auth, `.p8` key; env `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY`). Инвалидный токен (410 от APNs) → удалить строку (§6.C_push-rotation).

### 4.3 Keycloak `crm-mobile` client — это КОНФИГ, не эндпоинт

- Public OIDC client `crm-mobile` в realm `crm-prod`: `publicClient=true`, `standardFlowEnabled=true`, `implicitFlowEnabled=false`, `pkce.code.challenge.method=S256`, `redirectUris=["albusto://auth", "albusto://auth/*"]` (custom scheme), `webOrigins=[]`. Мирроринг `scripts/setup-keycloak.sh` (блок создания `crm-web`) + добавить в `keycloak/realm-export.json` (как делали для google-idp). Веб-клиент `crm-web` НЕ трогаем. (Bundle id, напр. `com.albusto.crm`, и scheme фиксируются в конфиге приложения.)

### 4.4 [v1.5] Stripe Terminal create-intent (ОДИН новый роут — остальное есть, G4)

- **`POST /api/stripe-terminal/payment-intents`** — `authenticate, requireCompanyAccess, requirePermission('payments.collect_terminal')`.
  - **Req:** `{ amount: number(cents), invoice_id?: number, job_id?: number, contact_id?: number }` (одна из привязок; сумма валидируется против баланса инвойса, если задан).
  - **Поведение:** вызывает существующий `stripePaymentsService.createTapToPayIntent(companyId, actor, params)` → `assertCollectable` (гейт готовности) → `provider.createTerminalPaymentIntent` (`card_present`, `capture_method:'automatic'`) → строка `stripe_payment_sessions (surface='tap_to_pay', status='open')` + аудит `stripe_payments.tap_to_pay_started`.
  - **200:** `{ ok, data:{ session_id, client_secret, payment_intent_id, account_id, amount } }`.
  - **Ошибки:** `400 INVALID_AMOUNT`; `409 NOT_READY` (онбординг/entitlement не готовы — §5, §6); `503 NOT_CONFIGURED` (нет ключей); `401/403`.
- **Существуют (переиспользуем):** `POST /api/stripe-terminal/connection-token` → `{ secret, location_id }`; `POST /api/stripe-terminal/payment-intents/:id/cancel` → `{ canceled:true }`. Оба гейт `payments.collect_terminal`.
- **Запись платежа в CRM** — уже автоматом: webhook `payment_intent.succeeded` → `getSessionByPaymentIntent` → ledger (`payment_transactions`, идемпотентно по внешнему id). Отдельный «capture/confirm на backend» НЕ нужен (`capture_method:'automatic'`; confirm происходит на устройстве через Stripe Terminal SDK по `client_secret`).

### 4.5 [v2] Twilio Voice / CallKit — вне v1/v1.5

`GET /api/voice/token` уже отдаёт `{ token, identity:"{companyId}:{userId}", expiresAt, allowed }` (TTL 3600). Для CallKit v2 добавить: refresh-механику токена + VoIP-push (PushKit) маршрут. Не специфицируется здесь (§7 non-goals).

---

## 5. Раздел E — v1.5 Tap to Pay flow (Stripe Terminal RN, `localMobile` reader)

Библиотека: `@stripe/stripe-terminal-react-native`. Reader type — **`localMobile`** (Tap to Pay on iPhone, NFC, без железа).

**Предпосылки (prerequisites):**
- Apple entitlement `com.apple.developer.proximity-reader.payment.acceptance` (запрос у Apple, лид-тайм ~дни).
- Stripe Terminal онбординг на connected-аккаунте компании; `charges_enabled` + card capability `active` (иначе backend `409 NOT_READY`).
- Provider имеет `payments.collect_terminal` (есть — JOBS-UX-RBAC-001).
- Устройство: iPhone с поддержкой Tap to Pay, iOS-версия по требованиям Stripe; Apple ID/регион аккаунта поддерживает фичу.

**Поток (Given онлайн + всё готово):**
1. **Token provider:** SDK при инициализации зовёт наш `POST /api/stripe-terminal/connection-token` → `secret`. (Location — из `location_id`, если задан.)
2. **discoverReaders** (`discoveryMethod: localMobile`) → **connectLocalMobileReader** (первый раз — системный prompt Tap to Pay/T&C Apple).
3. Экран «Take payment»: сумма (префилл из `invoice_total`/баланса или ручной ввод) → **`POST /api/stripe-terminal/payment-intents`** `{amount, invoice_id?|job_id?}` → `{ client_secret, payment_intent_id, session_id }`.
4. **collectPaymentMethod(client_secret)** → UI «Hold card near the top of iPhone» → клиент прикладывает карту/телефон.
5. **confirmPaymentIntent** (на устройстве по client_secret) → успех.
6. **CRM-запись** — автоматически через webhook (§4.4). Приложение по успеху делает `GET /api/jobs/:id` (или incremental) чтобы показать обновлённый `invoice_status`; тост **`Payment received`**.

**Ошибки/деклайны:**
- **Backend `409 NOT_READY`** (на шаге 3) → фичу скрыть/выключить фиче-флагом (§6.C8): экран «Card payments aren't set up yet» + подсказка (owner завершает Stripe/entitlement в вебе). Кнопку «Take payment» не показывать, если `readiness ≠ collectable` (узнаём из существующего `/status`-эндпоинта Stripe при входе на экран).
- **Decline / карта отклонена** (`confirmPaymentIntent` error `card_declined`, `expired_card`, и т.п.) → тост **`Card declined — try another card`**; PaymentIntent остаётся, можно повторить collect или **cancel** (`POST /payment-intents/:id/cancel`).
- **Reader/NFC ошибка** (Tap to Pay недоступен на устройстве, T&C не приняты) → «Tap to Pay isn't available on this device».
- **Сеть пропала в процессе** → collect/confirm фейлятся; если PI создан но не подтверждён — при возврате онлайн показать «Payment not completed» + [Cancel] (`/cancel`) чтобы не висел `open`.
- **Идемпотентность:** create использует `idempotencyKey` (surface-company-invoice/job-amount-ts). Двойной тап «Take payment» до ответа — кнопка in-flight disabled.
- **Офлайн:** экран оплаты недоступен (кнопка `Needs connection`) — платёж требует сети (LOCKED).

---

## 6. Раздел F — Полная матрица edge-cases

| # | Ситуация | Поведение / HTTP | User-visible copy |
|---|---|---|---|
| C1 | **Офлайн, устаревшие данные — как далеко назад** | Показываем что есть (нет TTL-протухания кэша — read-only). Порог мягкого предупреждения — 7 дней. | `Offline — showing data from {time}` → (≥7д) `Offline — data may be outdated (last updated {date})` |
| C2 | **Токен истёк, пока офлайн** | Access-token (5 мин) почти всегда протух в офлайне — это ОК: кэш отдаётся без живого токена. На первом онлайне — silent refresh против Keycloak (SSO-сессия 30 дней). Если refresh-токен тоже мёртв (>30д, или сессия отозвана деплоем — «Deploy invalidates sessions») → на онлайне мягкий редирект на логин; **кэш НЕ стираем**, чтения остаются до успешного ре-логина. | (на реконнекте, если ре-логин нужен) `Please sign in again to sync` |
| C3 | **Provider-scope кэш протух → deny-by-default** | Если `crm_users.id` рассинхронён/пуст, sync вернёт `scope_empty:true` (0 работ). Митигируем: (а) кэшируем `/api/auth/me` на логине; (б) ревалидируем `/api/auth/me` на каждом cold-start и после refresh; (в) при `scope_empty:true` показываем НЕ «нет работ», а `Can't load your jobs — please sign in again` + кнопку re-auth (различаем «реально 0 назначено» от «scope пуст» по флагу). | `Can't load your jobs — please sign in again` |
| C4 | **`blanc_status` vs Zenbooker расхождение на реконнекте** | Показываем `blanc_status` как основной. Если приходит признак расхождения с ZB (напр. `zb_status`/`zb_canceled` не согласуются с `blanc_status`), в карточке — мягкая плашка. Не блокируем. (ZenBooker — мастер платежей, не статусов визита.) | `Status may differ from the office system` |
| C5 | **Фото upload упал (онлайн)** | Чип ⚠ + [Retry]; «Save» disabled пока не убрать/переуспеть. `413`→`400` большой файл. (NOTE-ATTACH-UPLOAD-001.) | `Upload failed — retry` / `Photo too large` |
| C6 | **Гонка статуса: работа переназначена, пока техник жмёт** | Scope перестал совпадать → `POST /:id/{start,complete,...}` вернёт `404 {error:"Job not found"}`. Приложение: удалить из кэша, увести из карточки. | `This job is no longer assigned to you` |
| C7 | **Отмена/повторный тап write** | Кнопка in-flight disabled (клиентский дедуп). Повторного статуса нет (сервер: тот же статус — FSM no-op; но заметка задвоилась бы — потому дедуп на клиенте обязателен). | — |
| C8 | **Tap to Pay entitlement не одобрен / онбординг не завершён** | Backend `409 NOT_READY` на create-intent; фиче-флаг оплаты OFF (узнаём из Stripe `/status`); кнопку скрываем. Ядро v1 при этом полностью функционально (потому Tap to Pay вынесен в v1.5). | `Card payments aren't set up yet` |
| C9 | **Push-token ротация** | APNs может выдать новый токен (переустановка, восстановление). Приложение переотправляет `POST /api/devices` на каждом cold-start. Сервер: APNs-ответ `410 Unregistered` при отправке → удалить строку `device_tokens`. Дубликаты по `apns_token` невозможны (unique). | — |
| C10 | **Приложение свёрнуто во время sync** | iOS может приостановить процесс. `applyDelta` атомарна (транзакция) — либо целиком применилась (курсор двинулся), либо rollback (курсор на месте, повтор идемпотентен). Долгий initial pull переживает пересворачивания: применяем постранично, `full_sync_done` ставим только по последней странице; при обрыве — на foreground продолжаем с `since=last_cursor` (или, если full не завершён, начинаем с чистого — обе ветки идемпотентны). | — |
| C11 | **2FA-гейт (`401 PHONE_VERIFICATION_REQUIRED`) на API** | В нативе нет `albusto_td`-cookie (AUTH-2FA-GATE — веб-механика). Полагаемся на 2FA-шаг ВНУТРИ Keycloak browser-flow при PKCE-логине (SMS-OTP там же). Если бэкенд всё же вернёт этот 401 на API (не `/api/auth/*`) — показать экран «Verify it's you» с `POST /api/auth/otp/send`+`/verify` и (нативным эквивалентом) trust-device; после — retry запроса. Пометить как редкую ветку. | `Verify it's you to continue` |
| C12 | **Часы устройства сдвинуты** | Курсор — серверный `updated_at`, не клиентское время → сдвиг часов НЕ ломает delta. `last_synced_at` для UX берём из `server_time`, а не из `Date.now()` устройства (относительное время может быть неточным при сильном сдвиге — приемлемо). | — |
| C13 | **Смена аккаунта на устройстве** | `/api/auth/me.crm_user_id` ≠ `sync_state.crm_user_id` → **wipe локальной БД + image-кэша + full re-sync**; `DELETE /api/devices/:token` старого владельца, регистрация нового. | — |
| C14 | **Деплой отозвал сессии** | «Deploy invalidates sessions»: refresh может внезапно фейлиться. Ветка как C2 (ре-логин), кэш сохраняем, чтения доступны. | `Please sign in again to sync` |

---

## 7. Раздел G — Non-goals / границы фаз

Явно НЕ в v1 (и почему):
- **Офлайн-записи** (очередь статусов/заметок, append-only, разрешение конфликтов) → **v3+** (LOCKED: v1 read-only; write требует сети — сознательное упрощение, убирает мердж/конфликты). Пока read-only не начнёт мешать.
- **CallKit / in-app VoIP** (Twilio Voice iOS SDK + PushKit/VoIP-push, входящие как системные звонки, company caller-id на исходящих) → **v2**. В v1 звонок = `tel:` (MOBILE-NO-SOFTPHONE-001).
- **Android** → позже (v1 iOS-only, решение владельца).
- **Фоновая геолокация / геозоны** (авто-«на месте», авто-en-route по въезду) → **v3+**.
- **Роли кроме `provider`** (диспетчер/менеджер/админ) → остаются в веб-приложении.
- **Leads/Contacts/Payments-списки, эстимейты/инвойс-редакторы** → веб (техник видит лид/контакт только by-phone в pop-up контексте; не список). Финансовый просмотр job (`invoice_total/status`) — да; полноценная работа с документами — нет.
- **Refunds** → у provider `payments.refund` намеренно нет (JOBS-UX-RBAC-001).
- **Push кроме назначения/переноса** (напр. новое сообщение клиента) → возможно позже; в v1 только `job_assigned`/`job_rescheduled`.

**Фазовые границы:**
- **v1 (ядро):** RN+Expo · PKCE-auth (`crm-mobile`) · офлайн-read кэш + `GET /api/sync/jobs` + `job_tombstones` · Schedule/Detail · статусы (start/en-route/done + On-the-way/ONWAY) · notes+photos · Apple Maps · `tel:` · APNs (`device_tokens` + reassign/reschedule-хуки). **Backend-prereq §8.T0** (гейты enroute/start).
- **v1.5 (оплата):** Tap to Pay — один новый роут `POST /api/stripe-terminal/payment-intents` + Stripe Terminal RN. Вынесено отдельно, чтобы Apple-entitlement-ожидание не блокировало выпуск ядра.
- **v2 (звонки):** CallKit + VoIP-push + voice-token refresh.

---

## 8. Backend changes checklist (аддитивно; все — `authenticate`+`requireCompanyAccess`, provider-scope, тесты 401/403+изоляция)

- **T0 (prereq, БАГ):** расширить гейты `POST /:id/enroute` и `POST /:id/start` (и, для консистентности, `PATCH /:id/status` для операционных переходов) с `jobs.edit` → **`requirePermission('jobs.edit','jobs.done_pending_approval')`**, чтобы `provider` мог менять статус своих работ (сейчас 403 — G3; scope уже защищает через `getProviderScope`→404). Cancel/close остаётся `jobs.close`. Мирроринг того, что уже сделано для notes и заявлено в RBAC-FSM-FIX-001.
- **T1:** `GET /api/sync/jobs` (§4.1) — новый роут/сервис; курсор `(updated_at,id)` forward; `changed/unassigned/tombstones`. + Миграция: таблица **`job_tombstones(company_id UUID, job_id BIGINT, deleted_at TIMESTAMPTZ, PK(company_id,job_id))`** + хук в путь hard-delete job (INSERT tombstone). Индекс `(company_id, deleted_at)`.
- **T2:** APNs — миграция `device_tokens(company_id UUID, crm_user_id UUID, apns_token TEXT UNIQUE, platform TEXT, app_version TEXT, last_seen_at, created_at)`; роуты `POST /api/devices`, `DELETE /api/devices/:token` (§4.2); `pushService` (APNs `.p8` token-auth); хуки в reassign (diff→added ids) и reschedule (start/end change) → отправка. Инвалид-токен (410) → удаление.
- **T3:** Keycloak `crm-mobile` public client (PKCE S256, redirect `albusto://auth`) — `realm-export.json` + setup-скрипт (§4.3). Конфиг, не эндпоинт.
- **T4 [v1.5]:** роут `POST /api/stripe-terminal/payment-intents` → существующий `createTapToPayIntent` (§4.4). (connection-token и cancel уже есть.)
- **T5 [v2]:** Twilio Voice token refresh + VoIP-push маршрут (не сейчас).

---

## 9. Взаимодействие компонентов (сводно)

- **Read:** `RN UI → TanStack Query (persist на SQLite) → SQLite (source of truth) `; фон: `SyncEngine → GET /api/sync/jobs → applyDelta(txn) → SQLite`. Нет сети → рендер из SQLite + staleness-баннер.
- **Write:** `RN UI → apiClient(Bearer) → POST /api/jobs/:id/{start,enroute,complete} | /notes | /note-attachments/upload → Postgres` (только онлайн; при успехе — incremental sync). `zb_status/blanc_status/notes` бампают `jobs.updated_at` → delta подхватывает.
- **Auth:** `react-native-app-auth (PKCE S256) ↔ Keycloak crm-prod/crm-mobile`; токены в Keychain; refresh client↔Keycloak напрямую (наш backend в refresh не участвует). `/api/auth/me` → кэш authz-контекста (company_id, crm_user_id, role, permissions, scopes).
- **Push:** `Backend reassign/reschedule hook → pushService → APNs → устройство (data+alert) → deep-link albusto://job/{id} + фон-incremental`.
- **Pay (v1.5):** `Stripe Terminal RN ↔ POST /connection-token, POST /payment-intents (→createTapToPayIntent) ; confirm на устройстве ; webhook payment_intent.succeeded → ledger`.

---

## 10. Безопасность и изоляция данных

- `company_id` — исключительно из `req.authz.company.id` (fallback на `crm_users.company_id` удалён; ONBOARD-FIX-001). Все новые роуты — `authenticate`+`requireCompanyAccess`.
- Provider видит только свои работы: `getProviderScope` → `assigned_provider_user_ids @> [crm_user_id]`; нет `crm_users.id` → **deny-by-default (0)**, НЕ утечка. Прямой `GET/POST /api/jobs/:id/*` по чужому id → **404** (не 403 — не раскрываем существование).
- `GET /api/sync/jobs`, `POST/DELETE /api/devices`, `POST /api/stripe-terminal/*` — все provider/tenant-scoped; `device_tokens` и `stripe_payment_sessions` фильтруются `company_id`; `note_attachments` — `company_id`+`entity`.
- Токены в iOS Keychain (не в UserDefaults); local image-кэш вложений исключён из iCloud-бэкапа; SQLite-кэш — в app-sandbox, исключён из бэкапа.
- Тесты (обязательны для §8): `401` без токена; `403` чужая компания / platform-only; межтенантная изоляция (юзер компании A не получает работы/устройства/сессии компании B); provider-scope (техник не видит чужие назначенные работы); `NO_CRM_USER`→409 на `/api/devices`; `NOT_READY`→409 на terminal create.

---

**Готовность:** контракты конкретны, каждый сценарий — с HTTP-кодами и английской UI-копией; всё сверено с исходниками backend. Кода нет — только поведение/контракты/схемы. Следующий шаг пайплайна — test-cases (Agent 04) и атомарный план (Agent 05) по фазам v1 → v1.5 → v2.

---
