---
id: SCHED-ROUTE-001
title: Albusta Schedule Routes and Address Management
status: final_for_implementation
priority: P0
created_at: "2026-06-14"
language: ru
owner: product_engineering
implementation_target: twilio-front-integration
related_specs:
  - PF001-unified-schedule-dispatcher
  - SCHED-LIST-001-schedule-list-view
current_albusta_baseline:
  schedule_backend:
    read_model: "backend/src/db/scheduleQueries.js:getScheduleItems"
    service: "backend/src/services/scheduleService.js"
    entities_rendered:
      - jobs
      - leads
      - tasks
    current_sort: "start_at ASC NULLS LAST, created_at DESC"
  schedule_frontend:
    page: "frontend/src/pages/SchedulePage.tsx"
    views:
      - day
      - week
      - month
      - timeline
      - timeline-week
      - list
  jobs:
    table: jobs
    existing_fields:
      - address
      - lat
      - lng
      - start_date
      - end_date
      - assigned_techs
      - blanc_status
      - zb_status
      - zenbooker_job_id
    current_manual_create_gap: "frontend already can request entity_type=job from slot, but backend createFromSlot returns NOT_IMPLEMENTED"
  google:
    frontend_address_autocomplete: "frontend/src/components/AddressAutocomplete.tsx"
    frontend_address_helpers: "frontend/src/components/addressAutoHelpers.ts"
    backend_google_service: "backend/src/services/googlePlacesService.js"
    known_env_keys:
      - GOOGLE_PLACES_KEY
      - GOOGLE_GEOCODING_KEY
      - VITE_GOOGLE_MAPS_API_KEY
  timezone:
    company_timezone_field: "companies.timezone"
    dispatch_timezone_field: "dispatch_settings.timezone"
    frontend_helper: "frontend/src/utils/companyTime.ts"
product_decisions:
  zenbooker_transition: "ZenBooker integration is preserved for now, but Albusta owns job creation, editing, scheduling, addresses, and route UX."
  new_albusta_jobs: "Create and save the local Albusta job first, then create/sync the ZenBooker job best-effort for the current transition period."
  route_entities: "Only scheduled jobs participate in route calculation. Leads and tasks remain visible in Schedule but do not create route segments."
  excluded_job_statuses:
    - Canceled
    - Job is Done
  included_job_status_rule: "All other job statuses participate when the job has a schedule date and assigned technician."
  geocode_needs_review: "Address/geocoding status only. It is not a job status and must not exclude the job from routing by itself."
  multi_technician_jobs: "A job assigned to multiple technicians participates independently in each technician's route sequence."
  route_scope: "Only adjacent jobs for the same technician on the same company-local schedule day."
  no_route_scope:
    - "No home/base/warehouse/office to first job."
    - "No last job to home/base/warehouse/office."
    - "No automatic route optimization."
    - "No reordering customer appointment times."
route_capable_schedule_views:
  primary:
    - timeline
    - timeline-week
    - list
  not_primary_for_connectors:
    - day
    - week
    - month
route_statuses:
  - pending
  - success
  - failed
  - missing_address
  - address_needs_review
  - stale
acceptance_summary:
  - "Clickable Google Maps links for valid job addresses."
  - "Stored route segments only between adjacent jobs for the same technician and company-local schedule day."
  - "Schedule rendering never calls Google Maps APIs directly."
  - "Route recalculation is triggered only by route-affecting job changes."
  - "Schedule remains usable when Google Maps APIs or route data are unavailable."
---

# SCHED-ROUTE-001: Albusta Schedule Routes and Address Management

## Назначение

Albusta должна стать основным рабочим местом для создания, редактирования, планирования и просмотра работ. ZenBooker на текущем этапе сохраняется как интеграция и внешний синхронизируемый контур, но диспетчерский UX, адреса, расписание и маршруты должны развиваться внутри Albusta.

Этот документ задаёт требования для агента-исполнителя. Перед реализацией агент обязан изучить текущий код, перечисленный в YAML-блоке выше, и расширять существующие Schedule, Jobs, AddressAutocomplete и Google service patterns, а не создавать параллельную страницу маршрутов или независимый schedule module.

## Текущий контекст в Albusta

В Albusta уже есть единый Schedule read layer, который отображает `jobs`, `leads` и `tasks`. Backend собирает schedule items в `backend/src/db/scheduleQueries.js`, а `backend/src/services/scheduleService.js` мапит их в общий контракт. Frontend Schedule находится в `frontend/src/pages/SchedulePage.tsx` и поддерживает `day`, `week`, `month`, `timeline`, `timeline-week`, `list`.

В jobs уже есть базовые поля для адреса и координат: `address`, `lat`, `lng`, а также schedule-поля `start_date`, `end_date` и assignment через `assigned_techs`. Сейчас адрес в job details отображается как обычный текст, а не как Google Maps link.

В проекте уже есть Google address autocomplete на frontend: `AddressAutocomplete.tsx` и `addressAutoHelpers.ts`. На backend уже есть Google-related service `googlePlacesService.js` и существующие env key patterns. Новый функционал обязан переиспользовать эту основу и не добавлять hardcoded credentials.

Сейчас `SchedulePage` уже вызывает create-from-slot с `entity_type: 'job'`, но backend `createFromSlot` для `job` ещё возвращает `NOT_IMPLEMENTED`. В рамках перехода от ZenBooker нужно реализовать manual job creation/editing в Albusta, включая создание работы из Schedule slot.

## Бизнес-цели

1. Снизить операционную зависимость от ZenBooker для создания, редактирования и планирования работ.
2. Сделать Albusta основным dispatch interface для просмотра работ, адресов, техников и перемещений между работами.
3. Дать техникам и диспетчерам быстрый переход из Albusta в Google Maps по адресу работы.
4. Показывать примерную дистанцию и время в пути между соседними работами одного техника.
5. Снизить стоимость Google Maps API за счёт geocode и route cache.
6. Сохранить текущую ZenBooker integration на переходный период, включая создание или синхронизацию новых Albusta jobs в ZenBooker.

## Вне рамок

1. Автоматическая оптимизация маршрута.
2. Автоматическая перестановка работ или изменение согласованных appointment times.
3. Расчёт маршрута от дома, офиса, склада, warehouse или base к первой работе.
4. Расчёт маршрута от последней работы домой, в офис, на склад или base.
5. Live traffic и traffic-aware ETA.
6. Предупреждения, что travel time превышает свободное окно между работами.
7. GPS tracking техника.
8. Новая отдельная страница маршрутов вместо расширения существующего Schedule.
9. Полная замена ZenBooker integration в этой задаче.

## Принятые продуктовые решения

### Источник управления работами

Albusta должна поддерживать создание и редактирование работ напрямую. Адреса работ создаются и редактируются в Albusta. Для новых Albusta jobs backend должен сначала сохранять локальную работу, затем best-effort создавать или синхронизировать работу в ZenBooker, пока интеграция сохраняется.

Если ZenBooker sync не удался, локальная Albusta job не должна откатываться. Пользователь должен видеть понятное предупреждение или sync status, но Schedule должен продолжать работать с локальной job.

### Участие jobs в маршрутах

В маршрутизации участвуют только `jobs`, у которых есть:

1. schedule date/time через `start_date`;
2. назначенный technician/provider;
3. job status не равен `Canceled` и не равен `Job is Done`.

Все остальные job statuses участвуют в маршрутах. `needs_review` не является job status для маршрутизации. Если добавляется `geocoding_status = needs_review`, это только статус адреса.

`leads` и `tasks` остаются в Schedule, но не создают route segments. Они не должны разрывать job-to-job route sequence. Например, если в колонке техника визуально есть `Job A`, затем `Task`, затем `Job B`, маршрут для jobs остаётся `A -> B`.

### Мульти-техники

Если одна job назначена нескольким technicians, она участвует в маршруте каждого техника независимо. Сегмент всегда принадлежит конкретному technician/provider и конкретному schedule day.

Пример:

```text
Technician 1: Job A -> Shared Job X -> Job B
Technician 2: Job C -> Shared Job X -> Job D
```

Система должна хранить и показывать независимые сегменты:

```text
T1: A -> X, X -> B
T2: C -> X, X -> D
```

### Порядок соседних jobs

Маршрут считается только внутри одного company-local schedule day. День определяется по `jobs.start_date` в timezone компании, а не по UTC-дате.

Базовый порядок jobs для маршрутизации:

1. `start_date ASC`;
2. `end_date ASC NULLS LAST`;
3. стабильный tie-breaker по `id ASC` или другому уже принятому стабильному ключу.

Route order должен совпадать с фактическим порядком jobs, который видит пользователь в route-capable Schedule views. Если implementation меняет tie-breaker на UI, backend route sequence должен быть обновлён тем же правилом.

Manual schedule order сейчас в обнаруженном коде не найден. Если в процессе реализации агент найдёт существующее поле ручного порядка, оно должно стать tie-breaker перед `id ASC`.

## Функциональные требования

### FR-001. Manual job creation в Albusta

Albusta должна позволять создать job вручную, включая создание из пустого Schedule slot. Backend `createFromSlot` должен поддержать `entity_type = job`.

Минимальный набор полей для создания job:

1. customer/contact или данные клиента;
2. service address;
3. schedule date/time;
4. assigned technician/provider, если пользователь создаёт из provider lane;
5. job type/service details, если текущая job model требует эти поля;
6. статус по умолчанию, совместимый с текущей job lifecycle.

Создание job должно:

1. сохранять локальную Albusta job;
2. запускать geocoding flow для адреса;
3. запускать route recalculation для затронутого technician/day после появления или изменения schedule/assignment/address inputs;
4. best-effort создать или синхронизировать job в ZenBooker на переходный период.

### FR-002. Редактирование route-affecting job fields

Albusta должна позволять редактировать route-affecting fields у job:

1. service address;
2. assigned technicians/providers;
3. schedule date;
4. start time;
5. end time/duration, если влияет на видимый порядок или карточку;
6. manual order, если такое поле существует или будет добавлено позже.

Изменения должны сохраняться локально в Albusta и затем синхронизироваться с ZenBooker best-effort, если для этой job есть ZenBooker integration.

### FR-003. Google Maps link для адреса

В job details и Schedule job card адрес должен быть кликабельным, если есть usable service address.

Видимый текст ссылки должен оставаться человекочитаемым адресом. Нельзя показывать raw URL как основной текст.

Формат ссылки при наличии координат:

```text
https://www.google.com/maps/search/?api=1&query={latitude},{longitude}
```

Fallback при отсутствии координат, но наличии адреса:

```text
https://www.google.com/maps/search/?api=1&query={encoded_address}
```

Desktop behavior: открывать в новой вкладке через обычный external link.

Mobile behavior: использовать тот же Google Maps search URL, чтобы browser/device мог открыть Google Maps app, если она доступна.

### FR-004. Геокодинг адреса

Каждая scheduled job с service address должна поддерживать persisted geocoding data:

1. original address, введённый или выбранный в Albusta;
2. normalized address от Google, если доступен;
3. latitude;
4. longitude;
5. Google Maps URL или данные, достаточные для его стабильной генерации;
6. geocoding status;
7. geocoded timestamp;
8. geocoding provider/source;
9. optional provider place id;
10. optional error/review reason.

Рекомендуемое расширение текущей `jobs` модели:

```text
jobs.address                       existing, keep as visible/original service address
jobs.lat                           existing, keep
jobs.lng                           existing, keep
jobs.normalized_address            new
jobs.google_maps_url               new or generated server-side from lat/lng/address
jobs.geocoding_status              new: not_geocoded | pending | success | failed | needs_review
jobs.geocoded_at                   new
jobs.geocoding_provider            new, default google_maps
jobs.geocoding_place_id            new nullable
jobs.geocoding_error_code          new nullable
jobs.geocoding_error_message       new nullable, internal/admin-facing
```

Если frontend `AddressAutocomplete` уже предоставил place details, normalized address и coordinates, backend может сохранить эти данные сразу и не делать повторный paid geocode call, если данные достаточны и адрес не изменился.

Если пользователь ввёл адрес вручную или координаты отсутствуют, backend должен поставить geocode job в background queue. HTTP save не должен блокироваться на Google latency.

Если адрес не изменился с момента успешного geocode, повторный geocode запрещён.

### FR-005. Geocoding status behavior

`geocoding_status` должен иметь смысл только для адреса:

1. `not_geocoded`: адрес есть, но geocode ещё не запускался;
2. `pending`: geocode поставлен в очередь или выполняется;
3. `success`: адрес успешно нормализован и есть координаты;
4. `failed`: Google не смог вернуть usable result или произошла ошибка;
5. `needs_review`: Google вернул неоднозначный или низкокачественный result, требующий проверки человеком.

`needs_review` не исключает job из маршрутизации само по себе. Если coordinates usable и backend пометил confidence как acceptable для route, route segment можно считать. Если coordinates отсутствуют или не usable, соседний route segment должен перейти в `address_needs_review` или `missing_address`.

### FR-006. Route segments

Albusta должна хранить route calculations как route segments между двумя соседними jobs одного technician на один company-local schedule day.

Минимальная модель `schedule_route_segments`:

```text
id
company_id
technician_id
technician_source              e.g. zenbooker_team_member | company_user
schedule_date                  date in company timezone
from_job_id
to_job_id
from_latitude
from_longitude
to_latitude
to_longitude
travel_mode                    default driving
distance_miles
duration_minutes
source                         default google_maps
status                         pending | success | failed | missing_address | address_needs_review | stale
cache_key
error_code
error_message
calculated_at
created_at
updated_at
stale_at
```

`technician_id` должен соответствовать тому provider id, по которому текущий Schedule группирует карточки. В текущей реализации это связано с `assigned_techs[].id` и ZenBooker team members. Если implementation переводит Schedule на internal provider user ids, route layer должен использовать тот же canonical provider id, что и UI.

Route segment не является job и не должен отображаться или редактироваться как job.

### FR-007. Route cache

Google route API нельзя вызывать при каждом открытии Schedule.

Нужен route cache, валидный минимум по следующим inputs:

1. origin latitude;
2. origin longitude;
3. destination latitude;
4. destination longitude;
5. travel mode;
6. no live traffic dependency.

Рекомендуемая отдельная таблица `route_calculation_cache`:

```text
id
company_id
origin_latitude
origin_longitude
destination_latitude
destination_longitude
travel_mode
source
cache_key
distance_miles
duration_minutes
status
error_code
error_message
calculated_at
created_at
updated_at
```

Worker обязан сначала искать successful cache entry по equivalent route inputs. Если найден cache hit, Google Maps API не вызывается, а route segment заполняется из cache.

Для стабильного `cache_key` нельзя полагаться на raw floating point serialization. Использовать persisted DECIMAL values или нормализованное округление координат с явно выбранной точностью. Выбранная точность должна быть одинаковой для записи cache и lookup.

### FR-008. Route calculation API usage

Route estimate должен использовать driving mode без live traffic. Нельзя передавать параметры, которые делают результат traffic-aware или зависят от текущего времени.

Backend должен использовать существующие Google env key patterns. Нельзя hardcode API key. Frontend Schedule не должен напрямую вызывать route API.

Если Google API недоступен, возвращает ошибку, rate limit или invalid response:

1. worker записывает route segment/cache status `failed`;
2. Schedule продолжает рендериться;
3. UI показывает `Route unavailable`;
4. ошибка логируется с техническим error code без показа raw provider payload пользователю.

### FR-009. Schedule read behavior

Schedule rendering должен читать route segment records из database через Albusta API.

Открытие Schedule, refresh Schedule, переключение view, открытие job card или job details не должны вызывать Google geocoding или route API.

Schedule API должен возвращать route segments вместе с items или отдельным endpoint, но frontend должен получать route data как stored data.

Допустимые backend endpoints:

```text
GET /api/schedule/items
GET /api/schedule/route-segments?from=YYYY-MM-DD&to=YYYY-MM-DD&technician_id=...
```

Можно расширить существующий `GET /api/schedule/items`, если это лучше соответствует текущему frontend state management. Главное требование: no Google API calls during render.

## Recalculation triggers

Route recalculation должна запускаться только после route-affecting changes.

Recalculation требуется, когда:

1. новая job назначена technician;
2. job reassigned на другого technician;
3. job removed из schedule technician;
4. job date меняется;
5. job start time меняется так, что может измениться порядок;
6. manual schedule order меняется, если manual order существует;
7. job address меняется;
8. geocoded coordinates меняются;
9. job deleted, canceled или переведена в `Job is Done` и больше не участвует в routing;
10. job возвращена из excluded status в participating status.

Recalculation не требуется, когда меняются:

1. notes;
2. description;
3. photos or attachments;
4. price, invoice, payment fields;
5. internal comments;
6. tags, если они не влияют на schedule order или assignment;
7. job status, если он не меняет participation rule;
8. открытие или refresh Schedule;
9. открытие job card/details.

## Affected segment logic

Recalculation должна быть локальной, а не full-day rebuild без необходимости. Агент может реализовать helper, который по old state и new state определяет affected technician/day pairs и пересчитывает только соседние пары.

### Insert job X between A and B

```text
Before: A -> B
After:  A -> X -> B
```

Required changes:

1. mark old active `A -> B` segment as `stale`;
2. calculate or reuse cached `A -> X`;
3. calculate or reuse cached `X -> B`.

### Remove job X between A and B

```text
Before: A -> X -> B
After:  A -> B
```

Required changes:

1. mark `A -> X` and `X -> B` as `stale`;
2. calculate or reuse cached `A -> B`.

### Reassign job X from technician 1 to technician 2

Required changes:

1. for technician 1, repair the gap around removed `X`;
2. for technician 2, calculate only the new neighboring segments around inserted `X`;
3. do not recalculate unrelated segments for either technician.

### Change address or coordinates of job X

```text
A -> X -> B
```

Required changes:

1. recalculate or reuse cache for `A -> X`;
2. recalculate or reuse cache for `X -> B`;
3. do not recalculate unrelated segments.

### Multi-technician job X

If X belongs to multiple technicians, apply the same affected segment rules separately for each technician/day sequence where X appears.

## Backend flow

Recommended implementation flow:

1. User creates or edits a job in Albusta.
2. Backend saves the local job change in Albusta.
3. Backend detects whether address, coordinates, technician assignment, date, time, excluded status or manual order changed.
4. If address changed and coordinates are not already trustworthy, backend enqueues geocode job.
5. Backend computes affected technician/day sequences using company timezone.
6. Backend marks old affected active route segments as `stale`.
7. Backend creates `pending`, `missing_address` or `address_needs_review` segment records for new affected neighboring pairs.
8. Backend enqueues route calculation jobs only for pairs that can be calculated.
9. Worker checks route cache by cache key.
10. Worker uses cache result if available.
11. Worker calls Google route API only on cache miss.
12. Worker stores cache result and updates route segment.
13. Schedule reads stored route segments.

Geocoding and route calculation should run asynchronously. User-facing job save, reschedule or reassign operations should not wait on Google API latency.

## Schedule UI and UX requirements

### Общие UI принципы

Route data должна появляться внутри существующего Schedule, а не на отдельной странице. Route connector должен выглядеть как travel information между двумя jobs, а не как отдельная job card.

Connector treatment:

1. small horizontal or vertical connector between related job cards;
2. compact badge or pill with route/navigation icon from the existing icon library;
3. muted background;
4. short text only;
5. no large card treatment;
6. no nested cards;
7. no explanatory marketing text inside the product UI.

Recommended display text:

```text
success:              5 mi · 10 min
pending:              Calculating route
missing_address:      Missing address
address_needs_review: Address needs review
failed:               Route unavailable
```

Route estimates must be visibly approximate by context and copy. Do not label them as exact ETA.

### Address links in job cards

In Schedule job cards, address text should be clickable when usable address exists. Use the human-readable address as text and a subtle map/external icon where it fits without crowding the card.

If card is compact and does not currently show full address, preserve the existing card hierarchy. The route work must not make cards taller than necessary. In compact variants, show address link in tooltip, details popover, or selected job panel if the current card layout cannot fit it cleanly.

Clicking the address must not select, drag or open the job card accidentally. Stop event propagation where needed.

### Job details / Floating detail panel

Job details must show:

1. visible service address;
2. clickable Google Maps link;
3. geocoding status only when it needs user attention or is still pending;
4. clear warning for `failed` or `needs_review`;
5. no raw Google provider payload.

Address editing should use existing `AddressAutocomplete` where possible.

### List view

`list` is a primary route-capable view.

Current behavior groups items by provider column and company-local day, then stacks cards by time. Route connector should render inside each provider/day stack between adjacent participating jobs.

Rules:

1. Only jobs participate in connector placement.
2. Leads/tasks remain in their normal sorted position but do not create route segments.
3. Connector appears between the two related job cards in the visual stack where possible.
4. If a non-job item visually sits between two route-connected jobs, keep connector placement close to the destination job and make it visually clear it refers to travel from previous job to next job.
5. Do not show connector before the first participating job or after the last participating job.

Example:

```text
[Job A - 9:00 AM - 123 Main St]
        5 mi · 10 min
[Job B - 10:30 AM - 500 Oak Ave]
```

### Timeline view

`timeline` is a primary route-capable view.

In a provider lane for one day, render compact route connector for adjacent participating jobs. The connector should not move job cards or imply automatic optimization.

Placement guidance:

1. When there is visual space between two job cards, place the route pill in the gap.
2. When cards overlap or the gap is too small, anchor the route pill near the top of the destination job card or in a consistent lane gutter.
3. Connector must be visually smaller than job cards.
4. Connector must never cover job time, customer name, status, or primary actions.

### Timeline-week view

`timeline-week` is a primary route-capable view.

Render route connectors per provider per company-local day. The same rules as timeline apply, but the connector must remain compact enough for week density.

If week density makes full text unreadable, prefer a compact icon + `5 mi · 10 min` text. Do not show long error copy that breaks layout; use short labels from the status text table.

### Day, week and month views

`day`, `week` and `month` are not primary route connector views for this task. They are overview/calendar views and can become visually confusing if travel connectors are forced into the grid.

Required behavior for these views:

1. Keep clickable job address wherever the view already shows address or selected item details.
2. Do not render full route connectors in `month`.
3. Do not add a separate route page.
4. If implementation chooses to show route data in `day` or `week`, it must use the same stored route segments and must not trigger Google API calls.

### Empty, pending and error states

Schedule must render even when:

1. no route segment exists yet;
2. route segment is pending;
3. one or both addresses are missing;
4. address needs review;
5. Google route API failed;
6. route cache lookup failed.

UI state mapping:

```text
no segment yet but pair should exist: Calculating route
pending:                         Calculating route
missing_address:                 Missing address
address_needs_review:            Address needs review
failed:                          Route unavailable
stale:                           hide stale segment unless it is the only available state and no replacement exists
```

Stale route data should not be shown as if current. If stale fallback is used temporarily during recalculation, it must be visually marked as updating and replaced when pending/success segment arrives.

## API and data contract requirements

Schedule item contract for jobs should expose enough address fields for UI:

```text
entity_type
entity_id
start_at
end_at
assigned_techs
address_summary
address
normalized_address
lat
lng
google_maps_url
geocoding_status
```

Route segment API contract:

```text
id
technician_id
schedule_date
from_job_id
to_job_id
distance_miles
duration_minutes
travel_mode
status
calculated_at
```

Frontend should match route segments to cards by:

1. provider/technician id;
2. company-local schedule day;
3. `from_job_id`;
4. `to_job_id`.

Do not infer distances client-side. Do not call Google Maps route APIs from frontend.

## Security, tenancy and reliability

All new backend routes and queries must be tenant-safe.

Implementation requirements:

1. Use authenticated routes with existing auth and company access middleware.
2. Read company id through the current project pattern, usually `req.companyFilter?.company_id`.
3. Every SQL query must filter by `company_id`.
4. Never hardcode Google API keys.
5. Do not expose raw Google API errors or payloads to end users.
6. Use parameterized SQL.
7. Queue jobs must be idempotent.
8. Re-running the same route recalculation should not create duplicate active segments for the same technician/day/from/to pair.

## Implementation agent checklist

Before coding:

1. Read this spec fully.
2. Read `docs/specs/PF001-unified-schedule-dispatcher.md`.
3. Read `docs/specs/SCHED-LIST-001-schedule-list-view.md`.
4. Inspect `backend/src/db/scheduleQueries.js`.
5. Inspect `backend/src/services/scheduleService.js`.
6. Inspect current jobs routes/services and migrations for `jobs`.
7. Inspect `frontend/src/pages/SchedulePage.tsx`.
8. Inspect `frontend/src/components/AddressAutocomplete.tsx`.
9. Inspect `backend/src/services/googlePlacesService.js`.
10. Identify current timezone helper usage and use company timezone consistently.

Implementation must extend current modules where appropriate:

1. Extend job creation/editing instead of creating a separate job system.
2. Extend Schedule read model instead of creating a separate route page.
3. Extend existing address autocomplete behavior instead of replacing it.
4. Reuse existing Google API configuration patterns.
5. Preserve ZenBooker proxy/integration routes unless the task explicitly replaces them.

## Engineering Review — Binding Corrections (2026-06-14)

This section was added after verifying the YAML baseline against the actual code.
Where it conflicts with the body above, **this section wins** for the
implementation agent. Each item cites the verified source.

### C-1. Route order tie-breaker is WRONG in the body
The body (§"Порядок соседних jobs") proposes tie-breaker `id ASC`. The real
Schedule sort is `start_at ASC NULLS LAST, created_at DESC`
(`scheduleQueries.js:241`). The spec's own rule ("route order must match the
order the user sees") therefore requires the route sequence to use the **exact
same** sort: `start_date ASC, created_at DESC`. Do **not** introduce `id ASC`.
There is no manual order field today (confirmed) — if one is added later it
becomes the first key, then `created_at DESC`.

### C-2. `technician_id` is the INTERNAL crm_users.id, NOT the ZenBooker team member id
The body (FR-006) ties `technician_id` to `assigned_techs[].id` (ZB team member).
That is incorrect for the current code: Schedule groups provider lanes by the
**internal `crm_users.id`** held in `jobs.assigned_provider_user_ids`
(migration 096; `scheduleQueries.js:64-67`; PF007 provider scope uses this).
Binding rules:
- `schedule_route_segments.technician_id` = `crm_users.id`; `technician_source` = `company_user`.
- A job participates once **per `crm_users.id` in `assigned_provider_user_ids`**
  (this is the canonical multi-technician fan-out, not `assigned_techs`).
- `assigned_techs[].id` (ZB) is a sync bridge only — never the grouping/route key.

### C-3. Company-local schedule day — existing query is UTC-based (latent bug)
`scheduleQueries.js:73-76` filters/groups by `start_date::date` (UTC), with **no
`AT TIME ZONE`**. The spec correctly requires the **company-local** day. The
route layer MUST compute the day as `(start_date AT TIME ZONE <company_tz>)::date`
using `companies.timezone` (override `dispatch_settings.timezone`). Note the
divergence risk near UTC midnight: a job can land on a different "day" in the
route layer vs the (UTC-based) Schedule view. Fix the Schedule day filter to be
tz-aware in the same change so route-day == visible-day. Treat this as a required
dependency, not optional.

### C-4. Route cache must be GLOBAL, not company-scoped (cost)
Distance between two coordinates is tenant-independent; scoping
`route_calculation_cache` by `company_id` slashes the hit rate and **defeats the
cost goal (§Бизнес-цели #5)**. Make the cache **global**: drop `company_id` from
its key/uniqueness; key on `(round(origin_lat,5), round(origin_lng,5),
round(dest_lat,5), round(dest_lng,5), travel_mode)`. It stores only
distance/duration (no PII). Keep `schedule_route_segments` company-scoped (that
is the per-tenant context). ~5-decimal rounding (~1.1 m) is the agreed precision
for both write and lookup.

### C-5. Define the geocode confidence threshold (body leaves it undefined)
`googlePlacesService` currently exposes only `suggest`/`resolve(place_id)` and
does **not** return confidence signals. Add `geocodeAddress(address)` (Geocoding
API, `GOOGLE_GEOCODING_KEY`) returning `location_type` + `partial_match` +
`place_id`. Binding mapping:
- `success` when `partial_match` is false AND `location_type ∈ {ROOFTOP,
  RANGE_INTERPOLATED}`.
- `needs_review` when `partial_match` is true OR `location_type ∈
  {GEOMETRIC_CENTER, APPROXIMATE}` (coords still stored; routable if present).
- `failed` when Google returns no usable result.
The neighboring segment is `address_needs_review` only when coords are absent or
unusable; `needs_review` with usable coords still routes (per FR-005).

### C-6. Do NOT persist `jobs.google_maps_url`
It is deterministic from `lat`/`lng` (or address). Persisting it adds a
stale-data column. Generate it on read via a shared helper. Drop
`google_maps_url` from the jobs DDL in FR-004.

### C-7. Idempotency needs an explicit constraint (security req #8)
Add a partial unique index:
`schedule_route_segments (company_id, technician_id, schedule_date, from_job_id,
to_job_id) WHERE status <> 'stale'`. Recalc upserts the active row; old rows are
flipped to `stale`. This is what makes "no duplicate active segments" enforceable.

### C-8. Batch the Distance Matrix calls
Use the Google **Distance Matrix API** (cheapest for distance+duration, driving,
`departure_time` omitted = no traffic). For one technician/day, batch the N-1
adjacent pairs into a **single** request (within the 25×25 limit) instead of one
call per segment. Combined with the global cache this is the main cost lever.

### C-9. Reuse existing async infra (don't build a new queue)
Use the existing `agentWorker` (atomic `FOR UPDATE SKIP LOCKED`,
`backend/src/services/agentWorker.js`) with new `agent_type`s
(`job_geocode`, `route_calc`), or the `automation_scheduled_jobs` pattern. HTTP
save must not block on Google latency. If the frontend `AddressAutocomplete`
already supplied `lat`/`lng` and the address is unchanged, skip the paid geocode.

### C-10. Backfill existing jobs (otherwise routes never appear)
Existing ZB-synced jobs already have `lat`/`lng` (migration 041 + ZB sync) but no
`geocoding_status`. One-time backfill: set `geocoding_status='success'` for jobs
that already have coords (no paid call), `not_geocoded` otherwise; then seed
segments only for **today + future** company-local days to bound cost. New geocode
calls only for coordless addresses.

### C-11. Provider scope on the route-segments endpoint (PF007)
`GET /api/schedule/route-segments` must apply the same provider scope as the
schedule read: a provider with `job_visibility=assigned_only` sees only segments
whose `technician_id` = their own `crm_users.id`. Company scope alone is not
enough.

### C-12. ZenBooker best-effort create is feasible but must be dedupe-guarded
`zenbookerClient.createJob` / `createJobFromLead` exist, but ZB job creation is
**not idempotent** (their own note, `zenbookerClient.js:187-189`). A retried/
double-submitted create can make duplicate external jobs. Guard with a local
"zb_sync_pending/dedupe" marker and only attempt once per local job; store the
returned `zenbooker_job_id`. Confirm with product whether new Albusto jobs even
need ZB creation during the wind-down — if not, make it opt-in per company.

### C-13. Minor
- Units: `distance_miles` hardcodes US. Store `distance_meters` (or km) + format
  per company locale; the platform now allows non-US tenants.
- Stale/cache retention: purge `stale` segments older than ~30 days and prune the
  cache periodically; otherwise both tables grow unbounded.
- `createFromSlot` returns 501 for **both** `job` and `lead` today
  (`scheduleService.js:191`) — this spec implements `job`; `lead` stays out of scope.
- Spelling: the brand is **Albusto**, not "Albusta".

---

## Acceptance criteria

1. A job with valid service address shows a clickable address in job details.
2. A job with valid service address shows a clickable address in route-capable Schedule job card or selected job panel.
3. Clicking address opens Google Maps for that job location.
4. Visible address text remains human-readable, not a raw URL.
5. Manual Albusta job creation is supported, including create-from-slot for `entity_type = job`.
6. New Albusta job is saved locally even if ZenBooker sync fails.
7. New Albusta job attempts ZenBooker creation/sync during the transition period.
8. Address creation and editing happen in Albusta.
9. Address geocoding runs asynchronously when needed.
10. If address has not changed since successful geocode, backend does not geocode again.
11. Schedule shows route information only between consecutive participating jobs for the same technician on the same company-local day.
12. Schedule does not show travel time before the first participating job.
13. Schedule does not show travel time after the last participating job.
14. Schedule does not calculate routes from or to technician home/base/warehouse/office.
15. Jobs assigned to multiple technicians participate independently in each technician route.
16. Jobs with status `Canceled` do not participate in routes.
17. Jobs with status `Job is Done` do not participate in routes.
18. Jobs with all other statuses participate when scheduled and assigned.
19. Leads and tasks do not create route segments.
20. Opening Schedule does not call Google geocoding API.
21. Opening Schedule does not call Google route API.
22. Refreshing Schedule does not call Google geocoding API.
23. Refreshing Schedule does not call Google route API.
24. Editing a non-route field does not enqueue route recalculation.
25. Changing a job address recalculates only adjacent affected segments for each affected technician/day.
26. Changing geocoded coordinates recalculates only adjacent affected segments.
27. Reassigning a job recalculates only affected segments in old and new technician schedules.
28. Inserting a job between two jobs marks the old segment stale and creates/reuses two new segments.
29. Removing a job between two jobs marks old neighboring segments stale and creates/reuses the repaired segment.
30. If equivalent cached route exists, Google route API is not called.
31. If Google route API fails, Schedule still renders and shows `Route unavailable`.
32. If address is missing, connector shows `Missing address`.
33. If address requires review and cannot be reliably routed, connector shows `Address needs review`.
34. Route estimates use approximate driving duration without live traffic.
35. No automatic optimization or job reordering is introduced.
36. Route connectors are implemented in `timeline`, `timeline-week` and `list`.
37. `month` view is not cluttered with route connectors.
38. All new backend data is scoped by `company_id`.
39. No hardcoded Google credentials are introduced.
40. Tests or verification cover cache hit, cache miss, Google failure, address change, reassignment, insert and remove scenarios.
