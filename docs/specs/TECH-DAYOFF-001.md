---
id: TECH-DAYOFF-001
title: Day-off периоды техников — A′ post-filter в seam recommendSlots, миграция 167, серые блоки в расписании, warning-модалки
status: final_for_implementation
priority: P1
created_at: "2026-07-11"
language: ru
owner: product_engineering
requirements: "Docs/requirements.md § TECH-DAYOFF-001 (:5814)"
architecture: "Docs/architecture.md § TECH-DAYOFF-001 (:6247, binding)"
constraints:
  - slot-engine/ контейнер — НОЛЬ изменений (git diff по директории пуст), прод-деплой контейнера не нужен
  - Врезка ТОЛЬКО в slotEngineService.getRecommendations (A′ post-filter); buildTechnicians/buildScheduledJobs байт-в-байт
  - При 0 записей day-off на горизонте — запрос к движку и ответ БАЙТ-В-БАЙТ прежние (единственная дельта — один SELECT)
  - technician_id = ZB team-member TEXT id (как technician_base_locations.tech_id / jobs.assigned_techs[].id), НЕ crm_users.id
  - НИКАКИХ новых permission-ключей — schedule.view / schedule.dispatch уже существуют
  - НИКАКИХ серверных 4xx-блокировок ручных действий диспетчера (warning-only, FR-5)
  - Zenbooker availability не трогаем — day-off никуда не пушится
  - src/server.js не трогаем (mount /api/schedule уже существует, строка 221)
  - Смена техника из JobTechnicianControl — ОТЛОЖЕНА (out of scope v1)
---

# TECH-DAYOFF-001 — Спецификация поведения

## Общее описание

Пустой день выглядит для слот-движка как «свободно», поэтому Sara/VAPI, outbound parts-visit робот, Yelp convo-агент и слот-пикер UI бронируют клиентов на дни, когда никто не работает. Вводится сущность **day-off** (`technician_time_off`, миграция 167): период `[starts_at, ends_at)` (timestamptz UTC, может пересекать полночь и несколько дней), привязанный к ОДНОМУ технику по его **ZB team-member TEXT id**. Company-wide создание **материализуется** в K отдельных записей по ZB-ростеру активных техников; удаление всегда поштучное. Day-off глушит ТОЛЬКО предложение слотов — через **A′ post-filter внутри единого seam `slotEngineService.getRecommendations`** (все роботы и слот-пикер UI закрываются автоматически, ни один потребитель не патчится). Ручные действия диспетчера (DnD-перенос, создание job, reschedule из карточки) получают **предупреждение на фронте, но не блокируются**. В расписании day-off рендерится серыми неинтерактивными блоками «Time off»; управление — кнопка «Time off» на Schedule → FORM-CANON панель `TimeOffDialog`.

Идентичность техника (binding, верифицировано архитектурой): вся scheduling-плоскость ходит на ZB id (`buildTechnicians` → `zenbookerClient.getTeamMembers`, `jobs.assigned_techs[].id`, timeline-лейны `useProviders`, `technician_base_locations.tech_id`). Мост к `crm_users` (UUID) существует только через `company_user_profiles.zenbooker_team_member_id` и нужен ТОЛЬКО для provider-scope «свои блоки» — новый `membershipQueries.getZenbookerTeamMemberIdForUser(companyId, userId)` (обратный ход `resolveProviderUserIds`; сам `resolveProviderUserIds` не трогаем).

---

## Хранение — миграция 167 (binding DDL из архитектуры)

`backend/db/migrations/167_technician_time_off.sql` + `rollback_167_technician_time_off.sql` (номер 167 свободен на момент проектирования — последняя `166_yelp_conversations_lead_uuid_text.sql`; **RECHECK `ls backend/db/migrations/` при сборке** — параллельные worktree дрейфуют, прецедент 161).

```sql
CREATE TABLE IF NOT EXISTS technician_time_off (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    technician_id   TEXT NOT NULL,            -- ZB team-member id (= jobs.assigned_techs[].id, technician_base_locations.tech_id)
    technician_name TEXT,                     -- display-снапшот на момент создания (список НЕ дёргает ZB)
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
    note            TEXT,
    source          TEXT NOT NULL DEFAULT 'individual' CHECK (source IN ('individual','company')),
    batch_id        UUID,                     -- группирует company-wide материализацию (аудит; удаление ВСЕГДА поштучное)
    created_by      UUID REFERENCES crm_users(id),   -- req.user.crmUser.id, НЕ sub (created_by-FK gotcha)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tech_time_off_lookup
    ON technician_time_off (company_id, technician_id, starts_at);
```

**Решённые вопросы хранения:**
- `technician_name` — снапшот имени НА МОМЕНТ СОЗДАНИЯ: для individual-create имя приходит с клиента (из уже загруженного `useProviders`-ростера); для company-create сервер снимает имена из того же ZB-roster-ответа, которым материализует. UI-список и рендер блоков НИКОГДА не ходят в ZB за именем. Переименование техника в ZB задним числом снапшот не обновляет (принято, v1).
- Individual-create: `source='individual'`, `batch_id=NULL`. Company-create: `source='company'`, общий `batch_id` (uuid, генерируется на операцию) у всех K записей.
- Хранение — UTC timestamptz. Company-tz участвует ТОЛЬКО при вводе (UI, `settings.timezone`) и при построении company-local границ сравнения (`tzCombine`). Период через полночь / несколько дней = просто длинный интервал, НИГДЕ не режется по дням.

---

## Сценарии поведения

### S-1. Диспетчер создаёт day-off одному технику

- **Предусловия:** пользователь с `schedule.dispatch`; открыт `TimeOffDialog` (кнопка «Time off» на Schedule).
- **Входные данные:** техник из `FloatingSelect` (roster `useProviders`), from/to (date+time в company-tz), note (опц.).
- **Шаги:**
  1. Фронт конвертирует company-local ввод в UTC ISO (`dateInTZ`/companyTime.ts — тот же канон, что `tzCombine` на бэке) и шлёт `POST /api/schedule/time-off` с `{target:'technician', technician_id, technician_name, starts_at, ends_at, note?}`.
  2. Роут (`routes/schedule.js`, унаследованная цепочка `authenticate → requireCompanyAccess` + `requirePermission('schedule.dispatch')`) валидирует (см. контракт), пишет ОДНУ строку через `timeOffService.create`: `company_id = req.companyFilter?.company_id`, `created_by = req.user.crmUser?.id || null`.
  3. Ответ — созданная запись; диалог рефетчит свой список и дёргает refetch-callback `useScheduleData` → серый блок появляется в сетке без перезагрузки.
- **Ожидаемый результат:** одна запись `source='individual'`, `batch_id=NULL`; с этого момента `getRecommendations` не возвращает ни одного окна этого техника, пересекающегося с периодом (S-5..S-8).
- **Побочные эффекты:** только INSERT + фронт-рефетчи. SSE не эмитится (v1: мутации только из диалога → локальный refetch; отвергнутая альтернатива архитектуры).

### S-2. Company-wide создание: K активных техников → ровно K записей (AC-1)

- **Шаги:**
  1. `POST /api/schedule/time-off` с `{target:'company', starts_at, ends_at, note?}` (`technician_id` не передаётся/игнорируется).
  2. Сервер запрашивает roster: `zenbookerClient.getTeamMembers({service_provider:true, deactivated:false}, companyId)` — ровно тот же источник, что `buildTechnicians` (движок) и `useProviders` (лейны): «активен» = тот, кому вообще могут предлагаться слоты.
  3. Материализация: **один INSERT-statement на N строк** (по одной на каждого активного техника; `technician_id = String(m.id)`, `technician_name` из ростера, общий свежесгенерированный `batch_id`, `source='company'`, одинаковые `starts_at/ends_at/note/created_by`).
  4. Ответ — массив созданных записей.
- **Ожидаемый результат:** ровно K записей при K активных техниках; никакой «групповой» записи не существует. Техник, добавленный в компанию ПОЗЖЕ, записей задним числом не получает (FR-2 as-is).
- **Ошибки:** ZB-roster недоступен → **502, ноль вставок** (атомарность: либо все K, либо ничего); пустой roster → **400 `NO_ACTIVE_TECHNICIANS`** (решение: явная ошибка, не тихий no-op — диспетчер должен видеть, что закрывать некого).

### S-3. Поштучное удаление: DELETE одной записи из company-batch оставляет K-1 (AC-1, FR-3)

- **Шаги:** `DELETE /api/schedule/time-off/:id` → `DELETE ... WHERE id=$1 AND company_id=$2`.
- **Ожидаемый результат:** удалена ровно одна запись; остальные K-1 записей того же `batch_id` НЕ тронуты (batch_id — чистый аудит, каскада нет). 0 затронутых строк (нет такой записи ИЛИ чужой tenant) → **404** — чужой tenant неотличим от несуществующего id.
- **Редактирования периода в v1 нет** — только create/delete.

### S-4. Seam-фильтр, нулевой случай: горизонт не пересекается ни с одним day-off → байт-в-байт прежний ответ (AC-2, protected)

- **Шаги (внутри `slotEngineService.getRecommendations`, ЕДИНСТВЕННАЯ точка врезки):**
  1. После вычисления `earliest`/`latest` (company-local даты горизонта) выполняется `timeOffQueries.listOverlappingRange(companyId, horizonStartUtc, horizonEndUtc)` — один индексированный SELECT по `(company_id, technician_id, starts_at)`, где горизонт = `[tzCombine(earliest,'00:00',tz), tzCombine(addDaysLocal(latest,1),'00:00',tz))` (существующие `tzCombine`/`addDaysLocal`).
  2. **0 строк → ранний выход**: дальнейший код пути не меняется ВООБЩЕ — `technicians[]`, `config_override`, тело запроса к движку и ответ `{recommendations, summary, engine_status, coverage}` байт-в-байт прежние.
- **Ожидаемый результат:** при отсутствии day-off единственная дельта поведения всей фичи в seam — один SELECT. Tier-1/Tier-2 fallback, TECHSLOT one-tech логика, slot-persist path vapi-tools — нетронуты.

### S-5. Seam-фильтр, точечный day-off: частичное пересечение глушит окно (AC-2)

- **Предусловия:** у техника T day-off `сб 09:00 → сб 13:00` (UTC-инстанты).
- **Шаги (непустой список day-off):**
  1. **Pre-shaping** (по прецеденту TECHSLOT-фильтра `technicians`): техник, у которого ОДНА запись day-off целиком накрывает весь горизонт `[horizonStart, horizonEnd)`, выбрасывается из `technicians[]` ДО вызова движка. Мульти-записи НЕ склеиваются (v1, консервативно: не выкинули pre-shaping'ом — добьёт post-filter). T с частичным day-off остаётся в roster. `coverage` считается по roster ПОСЛЕ pre-shaping (описывает техников, реально участвующих в ранжировании).
  2. **Headroom:** `configOverride.ranking.top_n += TIMEOFF_TOPN_HEADROOM` (константа = **5**); компонуется ПОСЛЕ singleTech-виджининга; `max_recommendations_per_technician` / `max_recommendations_per_same_timeframe` НЕ трогаются (best-effort добор). Исходный (pre-headroom) `top_n` запоминается для slice.
  3. Движок вызывается как обычно; из `recommendations` **выбрасывается каждая rec, у которой хоть один `technicians[].id` имеет day-off, пересекающийся** с интервалом окна `[tzCombine(rec.date, rec.time_frame.start, tz), tzCombine(rec.date, rec.time_frame.end, tz))` — строгое пересечение `aStart < bEnd && bStart < aEnd` на чистых timestamptz-инстантах.
  4. Затем `slice(0, исходный top_n)` и перенумерация `rank` = 1..n.
- **Ожидаемый результат:** окна T `сб 08:00–10:00` и `сб 12:00–14:00` (частичное пересечение) выброшены; окно `сб 14:00–16:00` — предлагается; окна ДРУГИХ техников на сб — предлагаются как обычно. Граничный стык НЕ пересечение: day-off `09:00→13:00` не глушит окно `13:00–15:00` (полуоткрытые интервалы).
- **Побочные эффекты:** нет; форма ответа `{recommendations, summary, engine_status, coverage}` структурно не меняется.

### S-6. Seam-фильтр: day-off на весь день / через полночь / многодневный (AC-2)

- **Весь день** (company-wide «завтра 00:00 → послезавтра 00:00», сценарий 1 требований): все окна всех техников на завтра пересекаются → `recommendations` за завтра пусты; остальные дни горизонта — как обычно.
- **Через полночь / многодневный** (`сб 09:00 → вс 21:00`): интервал хранится ОДНОЙ записью и сравнивается как единый `[starts_at, ends_at)` — никакой per-date нарезки; глушатся окна сб с 09:00 и ВСЕ окна вс до 21:00.
- **Отпуск на весь горизонт:** одна запись накрывает `[horizonStart, horizonEnd)` → техник выброшен pre-shaping'ом; движок не тратит на него ranking-слоты; если это был единственный техник (TECHSLOT one-tech) → `technicians=[]` → движок отдаёт 0 rec'ов — существующая safe-fail семантика потребителей.

### S-7. Роботы получают отфильтрованные слоты без изменения своего кода (AC-3, FR-4)

- **Потребители seam (верифицировано архитектурой, НЕ редактируются):** `routes/schedule.js:200` (UI-прокси слот-пикера / CustomTimeModal / reschedule), `agentSkills/skills/recommendSlots.js` + `createLead.js` + `bookOnLead.js` (Sara/vapi-tools), `partsCallService.js` (outbound TECHSLOT), `yelpConvoAgentService.js` (Yelp convo-агент).
- **Ожидаемый результат:** все шесть путей автоматически перестают видеть окна, пересекающиеся с day-off. Company-wide day-off на день → `recommendations=[]` → Sara/parts-robot/Yelp говорят «нет слотов» — желаемое поведение (сценарий 4 требований); UI слот-пикер показывает существующее пустое состояние.
- **Инвариант:** ни один из перечисленных файлов не содержит diff'а.

### S-8. Provider видит СВОИ блоки (FR-8, AC-5/AC-6)

- **Предусловия:** пользователь роли provider (`getProviderScope(req)` → `assigned_only`), у него есть bridge-связка `company_user_profiles.zenbooker_team_member_id`.
- **Шаги:**
  1. `GET /api/schedule/time-off?from&to` под `schedule.view`.
  2. Сервер: `assigned_only` → резолв СВОЕГО ZB id через новый `membershipQueries.getZenbookerTeamMemberIdForUser(companyId, userId)`; выборка ТОЛЬКО по этому `technician_id` (параметр `technician_id` запроса игнорируется/перезаписывается). **Нет bridge-связки → пустой список** (deny-by-default, консистентно с providerScope-философией; лечится существующим admin-механизмом маппинга).
  3. Фронту фильтровать нечего — provider получает только свои блоки уже с сервера; в timeline/agenda видит серые блоки «Time off» на своих днях.
- **Ожидаемый результат:** provider НЕ видит чужих day-off ни в данных, ни в сетке; кнопка «Time off» (управление) ему не рендерится (гейт `schedule.dispatch` через `useAuthz`); POST/DELETE под его токеном → 403.

### S-9. Рендер серых блоков: desktop timeline + мобильная agenda (FR-7, AC-5)

- **Данные:** `useScheduleData` делает ОТДЕЛЬНЫЙ параллельный best-effort fetch `fetchTimeOff({from,to})` на тот же `dateRange`, что и items (паттерн route-segments): ошибка fetch'а НЕ валит расписание — блоки просто не рендерятся; refetch при смене диапазона и после мутаций `TimeOffDialog`.
- **Desktop (`TimelineView.tsx`, `TimelineWeekView.tsx`):** блок кладётся в лейн техника по `technician_id === provider id лейна`; отдельный слой ПОД items; `pointer-events: none` (клик/DnD НЕ перехватываются — protected DnD-цепочка); фон — тонировка/штриховка на базе `--blanc-ink-3`/`--blanc-line`; подпись «Time off». Блок клиппится видимым окном дня визуально, но данные — единый интервал.
- **Мобильная agenda (`DayView.tsx`, `useIsMobile` внутри):** решение — серая **неинтерактивная карточка** «Time off · {technician_name} · HH:MM–HH:MM» (время в company-tz), вставленная в agenda-список хронологически по `starts_at` среди items; если интервал накрывает весь видимый день — одна карточка «Time off · {technician_name} · All day» в начале списка. Карточка не кликается, не открывает панелей, не участвует в DnD; рендер-цепочка items не меняется (day-off — отдельный слой данных).
- **Прошедшие блоки** в сетке показываются, если попадают в видимый диапазон (сервер диапазон не режет) — история дня остаётся честной.

### S-10. UI управления: TimeOffDialog (FR-6)

- **Вход:** кнопка «Time off» на `SchedulePage`/`ScheduleToolbar` рядом с Dispatch settings; видимость — `schedule.dispatch` через `useAuthz` (как DispatchSettingsDialog).
- **Панель — строго FORM-CANON:** `<Dialog><DialogContent variant="panel">` + `DialogPanelHeader` (pinned title «Time off») + `DialogBody className="md:px-8 md:py-7"` (внутри `mx-auto w-full max-w-[740px] space-y-6`) + `DialogPanelFooter` (`<Button variant="ghost">Cancel</Button>` + primary `<Button>Save</Button>`). На мобиле авто-bottom-sheet. Закрытие — встроенный OverlayClose-канон, ничего не хэнд-роллим.
- **Форма:** `FloatingSelect` цели (список техников из `useProviders` + пункт «Whole company»), from/to = пары date+time (`FloatingField type="date"/"time"`, две короткие пары `grid grid-cols-1 sm:grid-cols-2 gap-3.5`), `FloatingField` note. Ввод в company-tz (`settings.timezone`), конверсия в UTC ISO перед POST. При выборе «Whole company» — поясняющий текст в панели, что на период НИ ОДИН слот предлагаться не будет (риск-нота архитектуры).
- **Список:** ниже формы — текущие и будущие записи (`fetchTimeOff({from: now, to: now + разумный горизонт})`; прошедшие НЕ показываются — FR-6); каждая строка: имя (снапшот `technician_name`), период в company-tz, note, source-маркер company-batch (ненавязчиво), кнопка Delete. Delete → **центр-модалка подтверждения** (`variant="dialog"` — канонично для «Delete this?») → `DELETE /:id` → рефетч списка + сетки.
- **Ожидаемый результат:** create/delete работают без перезагрузки; ошибки — sonner toast с `error.message`.

### S-11. Warning при DnD-переносе на конфликт (FR-5, AC-4)

- **Шаги:**
  1. Диспетчер тащит job на лейн/время техника T; в `handleDrop` (`TimelineView`/`TimelineWeekView`/`DayView`) ДО вызова reschedule проверяется `overlapsTimeOff(timeOffBlocks, [techIdЦелевогоЛейна], targetStartIso, targetEndIso)` — блоки уже в памяти `useScheduleData`, 0 сетевых запросов.
  2. Пересечение есть → **центр-модалка подтверждения** (`variant="dialog"`): «У {technician_name} time off {период}. Всё равно перенести?» → «Перенести» продолжает существующий reschedule-путь без изменений; «Отмена» — drop отменён, ничего не мутируется.
  3. Пересечения нет → существующий путь без модалки.
- **Ожидаемый результат:** предупреждение с именем и периодом, продолжение по подтверждению; **сервер не блокирует** (никаких новых 4xx в reschedule/reassign/from-slot).

### S-12. Warning в NewJobModal (create-from-slot) (FR-5)

- **Шаги:** `NewJobModal` знает `providerId` + `startAt/endAt`; блоки прокидываются из SchedulePage-контекста; при пересечении — **инлайн-предупреждение в форме** (текст с именем техника и периодом), Save НЕ дизейблится и не блокируется.
- **Ожидаемый результат:** диспетчер видит конфликт до сохранения, но может сознательно создать job.

### S-13. Warning при reschedule из карточки Job (FR-5)

- **Шаги:**
  1. Точка врезки — `JobInfoSections.tsx` (именно он открывает shared `CustomTimeModal` и знает `job.assigned_techs`). Сам `CustomTimeModal` НЕ трогается (shared: NewJobDialog/ConvertToJobSteps/WizardStep3/RobotCallSlotModal/TaskActionButtons; его engine-слоты уже отфильтрованы через seam).
  2. После выбора времени, ПЕРЕД подтверждением reschedule — **точечный** `fetchTimeOff({from,to: выбранный день, technician_id})` по каждому назначенному технику; пересечение → confirm-модалка как в S-11; подтверждение → существующий reschedule-путь.
  3. Ошибка точечного fetch'а → warning тихо пропускается (best-effort, консистентно с S-9), reschedule идёт как раньше.
- **Отложено (задокументировано, НЕ v1):** warning при смене техника (`JobTechnicianControl`) и в Month/Week/List-видах — добавится тем же `overlapsTimeOff` позже.

---

## Граничные случаи

- **E-1. `ends_at` в прошлом при создании** → **400 `VALIDATION`** (решение: `ends_at` должен быть строго больше «сейчас» на момент create — создание целиком прошедшего периода бессмысленно и только мусорит список). `starts_at` в прошлом при `ends_at` в будущем — ДОПУСТИМ (уже идущий отпуск, заведённый задним числом).
- **E-2. Пересекающиеся day-off одного техника** → допустимы, дедупликации/склейки нет; post-filter работает union-семантикой («пересекается хоть с одной записью → окно выброшено»), поэтому дубликаты безвредны. Pre-shaping при этом НЕ склеивает мульти-записи (v1) — техник с двумя стыкующимися записями, вместе накрывающими горизонт, останется в roster и будет добит post-filter'ом (корректно, лишь менее оптимально).
- **E-3. Пустой ZB-roster при company-wide create** → **400 `NO_ACTIVE_TECHNICIANS`**, ноль вставок. Ошибка/таймаут ZB-запроса → **502 `ZENBOOKER_UNAVAILABLE`**, ноль вставок (никакой частичной материализации — INSERT одним statement'ом).
- **E-4. Техник деактивирован в ZB ПОСЛЕ создания day-off** → запись остаётся (никакой чистки); движок его и так не вернёт (`buildTechnicians` фильтрует `deactivated:false`), лейн исчезнет из `useProviders` → блок просто не отрисуется; запись видна и удаляема в TimeOffDialog (снапшот-имя сохранён).
- **E-5. Неизвестный/произвольный `technician_id` при individual create** → сервер валидирует только непустой TEXT, против ZB-ростера НЕ проверяет (решение: без лишнего ZB-вызова; на практике id приходит из `FloatingSelect`-ростера; «осиротевшая» запись безвредна — движок такого кандидата не ранжирует, см. E-4).
- **E-6. `from`/`to` инверсия или невалидный ISO в GET** → **400 `VALIDATION`**; оба параметра обязательны (диапазон задаёт клиент; сервер прошедшее не режет).
- **E-7. `note` длиннее 500 символов** → **400 `VALIDATION`** (лимит 500; фронт ограничивает поле, сервер enforce'ит).
- **E-8. Timezone/DST:** все пересечения считаются на UTC-инстантах; company-local границы (горизонт `00:00`, окна `rec.date + time_frame`) строятся ТОЛЬКО через `tzCombine` (DST-aware, канон companyTime — та же функция, что slot-persist path), поэтому в день перевода часов окно `08:00–10:00` конвертируется в те же инстанты, что и у хранения/бронирования — расхождений нет. Ввод в диалоге тоже company-tz → UTC.
- **E-9. TECHSLOT one-tech + day-off:** `technician_id` в input seam сужает roster до одного техника; его day-off на targetDay → все окна дня выброшены post-filter'ом (или сам техник pre-shaping'ом) → 0 rec'ов → существующий fallback-путь робота («нет слотов»), никакой новой ветки.
- **E-10. `SLOT_ENGINE_URL` не задан / движок недоступен:** ранний return `{recommendations:[], summary:null, engine_status:'unavailable', coverage}` — существующее поведение; day-off SELECT выполняется до этого return'а безвредно (или после — импл. деталь), фильтровать нечего; форма ответа не меняется.
- **E-11. Недобор слотов после post-filter:** ranking-квоты движка потрачены на выброшенных кандидатов → rec'ов меньше `top_n` (или 0) даже когда физически окна есть. Принято v1: смягчено pre-shaping + headroom (+5) со slice; per-tech caps НЕ расширяются; все потребители уже переживают «мало/ноль слотов».
- **E-12. Затягивание работы в day-off из соседнего окна:** post-filter не считает route-feasibility — job из окна 14–16 может фактически затянуться в day-off с 17:00. Принятая v1-плата (окна-обещания и так не гарантируют конец работ); путь v2 = `unavailability[]` в протоколе движка с деплоем контейнера, post-filter остаётся страховкой.
- **E-13. DELETE чужого tenant'а / несуществующего id** → одинаковый **404** (0 строк по `WHERE id AND company_id`) — чужие данные не раскрываются.
- **E-14. Provider без bridge-связки** (`zenbooker_team_member_id` NULL) → GET отдаёт `[]` (deny-by-default); своих блоков он не видит, пока admin не настроит маппинг — задокументированный риск, не баг.
- **E-15. Ошибка SELECT day-off внутри seam** (БД): пропагируется как ошибки `buildTechnicians`/`buildScheduledJobs` — существующие потребители уже оборачивают (`runSkill` → SAFE_FALLBACK, роуты → 500). НЕ глотать в «0 строк» (иначе БД-икота тихо разблокирует мёртвые слоты).

---

## Обработка ошибок

| Ситуация | Реакция |
|---|---|
| POST без `schedule.dispatch` / DELETE без `schedule.dispatch` | 403 (существующий `requirePermission`) |
| POST: невалидные/отсутствующие `starts_at`/`ends_at`, `ends_at <= starts_at`, `ends_at <= now`, `target` вне `{'technician','company'}`, `target='technician'` без `technician_id`, note > 500 | 400 `{ok:false, error:{code:'VALIDATION'|'MISSING_FIELD', message}}` |
| POST company: ZB roster недоступен | 502 `{code:'ZENBOOKER_UNAVAILABLE'}`, ноль вставок |
| POST company: roster пуст | 400 `{code:'NO_ACTIVE_TECHNICIANS'}` |
| DELETE: не найдено / чужой tenant | 404 `{code:'NOT_FOUND'}` |
| GET: невалидный диапазон | 400 `{code:'VALIDATION'}` |
| Фронт: любой не-2xx из time-off API | sonner error-toast с `error.message`; диалог остаётся открытым |
| Фронт: fetchTimeOff в useScheduleData упал | тихий console.warn, блоки не рендерятся, расписание живёт (best-effort как route-segments) |
| Фронт: точечный fetch в S-13 упал | warning пропускается, reschedule не блокируется |

Формат ошибок — существующий канон `routes/schedule.js`: `res.status(status).json({ ok:false, error:{ code, message } })`.

---

## API-контракты

Все три роута живут в существующем `backend/src/routes/schedule.js` (mount `src/server.js:221`: `authenticate → requireCompanyAccess`, НЕ трогается). `company_id` — ТОЛЬКО `req.companyFilter?.company_id`; каждый SQL фильтрует по нему. Auth: authedFetch (фронт).

### `GET /api/schedule/time-off?from=<ISO>&to=<ISO>[&technician_id=<ZB id>]`

- Middleware: `requirePermission('schedule.view')` + `getProviderScope(req)`.
- `from`/`to` обязательны (UTC ISO); отдаются записи, **пересекающиеся** с `[from, to)` (не только целиком лежащие). `technician_id` — опциональный фильтр (для точечного S-13-запроса).
- Provider `assigned_only`: `technician_id` параметра игнорируется; выборка форсится на собственный ZB id (`getZenbookerTeamMemberIdForUser`); нет bridge → `[]`.
- Response `200`:

```json
{ "ok": true, "data": { "time_off": [ {
    "id": "uuid",
    "technician_id": "1234567",
    "technician_name": "John Smith",
    "starts_at": "2026-07-18T13:00:00.000Z",
    "ends_at": "2026-07-20T01:00:00.000Z",
    "note": "vacation",
    "source": "individual",
    "batch_id": null,
    "created_at": "2026-07-11T20:00:00.000Z"
} ] } }
```

- Ошибки: `400` (диапазон), `401/403` (существующая цепочка), `500`.

### `POST /api/schedule/time-off`

- Middleware: `requirePermission('schedule.dispatch')`.
- Request (individual):

```json
{ "target": "technician", "technician_id": "1234567", "technician_name": "John Smith",
  "starts_at": "2026-07-18T13:00:00.000Z", "ends_at": "2026-07-20T01:00:00.000Z", "note": "vacation" }
```

- Request (company-wide): `{ "target": "company", "starts_at": "...", "ends_at": "...", "note": "storm day" }` — материализация по S-2.
- `created_by = req.user.crmUser?.id || null` (НЕ `sub` — created_by-FK gotcha).
- Response `201`:

```json
{ "ok": true, "data": { "created": [ { "id": "...", "technician_id": "...", "technician_name": "...",
    "starts_at": "...", "ends_at": "...", "note": "...", "source": "company", "batch_id": "uuid", "created_at": "..." } ] } }
```

  (individual → массив из 1 записи, `source:'individual'`, `batch_id:null`; company → K записей, общий `batch_id`).
- Ошибки: `400 VALIDATION|MISSING_FIELD|NO_ACTIVE_TECHNICIANS`, `403`, `502 ZENBOOKER_UNAVAILABLE`, `500`.

### `DELETE /api/schedule/time-off/:id`

- Middleware: `requirePermission('schedule.dispatch')`.
- `DELETE FROM technician_time_off WHERE id=$1 AND company_id=$2`; 0 строк → `404`.
- Response `200`: `{ "ok": true, "data": { "deleted": true } }`.
- Ошибки: `404 NOT_FOUND`, `403`, `500`.

### Seam-контракт (не HTTP): `slotEngineService.getRecommendations(companyId, input)`

- Вход/выход **структурно НЕ меняются**: вход `{new_job:{...}}`, выход `{recommendations:[{rank,date,time_frame,technicians,score,confidence,...}], summary, engine_status:'ok'|'unavailable', coverage:{technicians_total, technicians_with_base}}`.
- Новая семантика: `recommendations` гарантированно не содержит ни одной rec, чьё окно `[tzCombine(date, time_frame.start, tz), tzCombine(date, time_frame.end, tz))` пересекает `[starts_at, ends_at)` любого day-off любого её `technicians[].id`; `rank` перенумерован 1..n; количество ≤ исходного (pre-headroom) `top_n`.
- `coverage` при непустом day-off-списке считается по pre-shaped roster.

---

## Взаимодействие компонентов

- `TimeOffDialog.tsx` → authedFetch → `POST/DELETE /api/schedule/time-off` → `timeOffService` → `timeOffQueries` (+ `zenbookerClient.getTeamMembers` на company-create) → PG.
- `useScheduleData` → параллельный `GET /time-off` (на dateRange) → `TimelineView`/`TimelineWeekView`/`DayView` (слой блоков) + `overlapsTimeOff` в handleDrop / `NewJobModal` / `JobInfoSections`.
- Sara/VAPI (`agentSkills`), `partsCallService`, `yelpConvoAgentService`, `POST /api/schedule/slot-recommendations` (UI) → `slotEngineService.getRecommendations` → `timeOffQueries.listOverlappingRange` → (pre-shape → headroom → slot-engine HTTP → post-filter → slice/re-rank).
- SSE — НЕ используется (v1); realtime-каналов фича не добавляет.

## Безопасность и изоляция данных

- Все SQL по `technician_time_off` фильтруют `company_id = req.companyFilter?.company_id`; seam-SELECT — по `companyId` вызова.
- DELETE чужого tenant'а → 404 (неотличим от несуществующего).
- Provider `assigned_only` — deny-by-default: без bridge-связки данные не отдаются вовсе; параметры запроса не позволяют ему читать чужие блоки.
- Никаких новых permission-ключей; `schedule.view` (чтение) / `schedule.dispatch` (CRUD) — существующие (`permissionCatalog.js:69-70`), каталог не меняется.

---

## Инварианты

- **INV-1.** Директория `slot-engine/` — ноль изменений (git diff пуст); прод-деплой контейнера НЕ требуется.
- **INV-2.** При 0 записей day-off на горизонте тело запроса к движку и ответ `getRecommendations` **байт-в-байт** совпадают с поведением до фичи (единственная дельта — один SELECT). Tier-1/Tier-2 fallback, TECHSLOT one-tech, slot-persist path vapi-tools, safe-failure semantics — нетронуты.
- **INV-3.** Форма ответа seam `{recommendations, summary, engine_status, coverage}` структурно не меняется; потребители seam (`vapi-tools.js`, `agentSkills/*`, `partsCallService.js`, `yelpConvoAgentService.js`, `slotRecommendationsApi.ts`, `CustomTimeModal.tsx` internals) НЕ редактируются.
- **INV-4.** `buildTechnicians` / `buildScheduledJobs` — байт-в-байт; pre-shaping — чистое input-shaping массива `technicians` уже ПОСЛЕ них (как TECHSLOT-фильтр).
- **INV-5.** Ни одно ручное действие диспетчера не блокируется сервером из-за day-off: reschedule/reassign/from-slot/создание job не получают новых 4xx-веток (FR-5 — warning-only на фронте).
- **INV-6.** Удаление — ВСЕГДА поштучное: ни один код-путь не удаляет по `batch_id` каскадом.
- **INV-7.** `technician_id` — ZB team-member TEXT id во всех слоях (таблица, API, фронт-тип `TimeOffBlock`, лейны); `crm_users.id` появляется только в `created_by` и в provider-bridge-резолве.
- **INV-8.** Хранение UTC timestamptz; все сравнения пересечений — строгие полуоткрытые интервалы `aStart < bEnd && bStart < aEnd` на UTC-инстантах; company-tz только через `tzCombine`/companyTime.
- **INV-9.** `scheduleQueries.getScheduleItems` (UNION) не трогается — day-off НЕ становится 4-м UNION/ScheduleItem; `reassignItem`/ZB write-through, recalc-хуки SCHED-ROUTE-001/VIS-001, FSM, task-механика CANCEL-001 — нетронуты.
- **INV-10.** Серые блоки — `pointer-events:none`, отдельный слой данных: DnD-цепочка и agenda-рендер items не меняются; блоки не кликаются, не таскаются, не открывают панелей.
- **INV-11.** RBAC-каталог не меняется (никаких новых ключей); `schedule.view` продолжает гейтить чтение расписания.
- **INV-12.** Zenbooker: day-off никуда не пушится (никакого write-through); ZB читается ТОЛЬКО на company-wide материализации (существующий `getTeamMembers`).
- **INV-13.** `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts` — без изменений.

---

## Тестируемые утверждения (для Test Cases)

- **T-1 (S-2/S-3, AC-1):** company-wide create при мокнутом ростере из K техников → ровно K строк, общий `batch_id`, `source='company'`; DELETE одной → K-1 нетронуты.
- **T-2 (S-4, AC-2/INV-2):** 0 day-off → тело запроса к движку (перехваченный fetch) deep-equal телу до фичи; ответ deep-equal.
- **T-3 (S-5/S-6, AC-2):** post-filter выбрасывает rec'и с частичным, полным, через-полночь и многодневным пересечением; граничный стык (`ends_at == начало окна`) НЕ выбрасывается; окна других техников остаются.
- **T-4 (S-5):** pre-shaping выкидывает техника с одной записью на весь горизонт из `technicians[]`; техник с частичным day-off остаётся; headroom: `ranking.top_n` в запросе к движку = исходный + 5, а итоговый `recommendations.length ≤` исходного `top_n`, `rank` = 1..n подряд.
- **T-5 (S-7, AC-3):** git diff по `vapi-tools.js`, `agentSkills/`, `partsCallService.js`, `yelpConvoAgentService.js`, `slot-engine/` пуст.
- **T-6 (S-8, AC-6):** GET под provider (assigned_only, с bridge) отдаёт только его записи; без bridge → `[]`; POST/DELETE под provider → 403; POST/DELETE без токена/пермишена → 401/403.
- **T-7 (E-1/E-6/E-7):** POST c `ends_at <= starts_at` → 400; `ends_at` в прошлом → 400; `starts_at` в прошлом + `ends_at` в будущем → 201; GET с `from > to` → 400; note 501 символ → 400.
- **T-8 (E-3):** company-create при ZB-ошибке → 502 и 0 строк в таблице; при пустом ростере → 400 `NO_ACTIVE_TECHNICIANS` и 0 строк.
- **T-9 (E-13/INV-6):** DELETE по id другой компании → 404, строка живa; удаление по batch_id как операции не существует.
- **T-10 (E-2):** два пересекающихся day-off одного техника → окно в зоне обоих выброшено ровно один раз (нет дублей/ошибок), окно вне обоих — живо.
- **T-11 (E-8):** день перевода DST: day-off, заданный company-local временем, глушит ровно те окна, чьи `tzCombine`-инстанты пересекаются (кейс на фиксированной tz America/New_York).
- **T-12 (E-9):** TECHSLOT one-tech (`technician_id` в input) + day-off на targetDay → `recommendations=[]`.
- **T-13 (S-1):** `created_by` = `req.user.crmUser.id` (НЕ sub) — строка пишется и при отсутствии crmUser (`null`).
- **T-14 (миграция, AC-7):** 167 up → таблица+индекс+CHECK работают (вставка `ends_at <= starts_at` падает); rollback down → чисто; повторный up идемпотентен (`IF NOT EXISTS`).
- **T-15 (фронт, ручная верификация):** серые блоки в TimelineView/TimelineWeekView/DayView не перехватывают клик/DnD; TimeOffDialog — FORM-CANON панель, на мобиле bottom-sheet; DnD на конфликт → confirm-модалка, подтверждение доводит перенос; NewJobModal — инлайн-warning без блокировки Save; `npm run build` (tsc -b) green.
