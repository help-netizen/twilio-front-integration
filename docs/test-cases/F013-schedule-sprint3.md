# Тест-кейсы: F013 Schedule Sprint 3 — UX Hardening

## Покрытие
- Всего тест-кейсов: 34
- P0: 10 | P1: 12 | P2: 8 | P3: 4
- Unit: 16 | Integration: 14 | E2E: 4

---

## Сценарий 1: Timezone-aware отображение

### TC-F013-001: Item позиционируется по company TZ, не browser TZ
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** 1.2 — позиционирование items
- **Входные данные:**
  - item.start_at = "2026-03-30T17:00:00Z" (1pm EDT / 10am PDT)
  - settings.timezone = "America/New_York"
  - Browser TZ = "America/Los_Angeles"
- **Ожидаемый результат:** Item позиционируется на 1:00 PM (13:00), не на 10:00 AM
- **Файл для теста:** `tests/frontend/schedule/timezoneDisplay.test.ts`

### TC-F013-002: Hour labels отображаются в company TZ
- **Приоритет:** P0
- **Тип:** Unit
- **Входные данные:**
  - settings.timezone = "America/Chicago" (CDT = UTC-5)
  - settings.work_start_time = "08:00"
- **Ожидаемый результат:** Первый label = "8:00 AM" (не "9:00 AM" если browser в EDT)
- **Файл для теста:** `tests/frontend/schedule/timezoneDisplay.test.ts`

### TC-F013-003: "Today" highlight определяется по company TZ
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:**
  - Current UTC time: 2026-03-31T03:00:00Z (March 30 11pm EDT, March 31 in UTC)
  - settings.timezone = "America/New_York"
- **Ожидаемый результат:** Today = March 30 (не March 31)
- **Файл для теста:** `tests/frontend/schedule/timezoneDisplay.test.ts`

### TC-F013-004: Sidebar время в company TZ
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:**
  - item.start_at = "2026-03-30T17:00:00Z"
  - settings.timezone = "America/New_York"
- **Ожидаемый результат:** Sidebar показывает "1:00 PM" (не UTC "5:00 PM")
- **Файл для теста:** `tests/frontend/schedule/sidebar.test.ts`

### TC-F013-005: Fallback timezone при отсутствии настроек
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** settings.timezone = null
- **Ожидаемый результат:** Используется "America/New_York"
- **Файл для теста:** `tests/frontend/schedule/timezoneDisplay.test.ts`

---

## Сценарий 2: Past-time overlay + now-line

### TC-F013-006: Past overlay отображается в DayView на today
- **Приоритет:** P0
- **Тип:** Unit
- **Входные данные:**
  - currentDate = todayInTZ(tz)
  - Current time = 2:30 PM company TZ
  - work_start = 8:00 AM
- **Ожидаемый результат:** Overlay height = (14.5 - 8) * HOUR_HEIGHT / 1 = 6.5 * HOUR_HEIGHT px
- **Файл для теста:** `tests/frontend/schedule/pastOverlay.test.ts`

### TC-F013-007: No overlay на non-today days
- **Приоритет:** P0
- **Тип:** Unit
- **Входные данные:** currentDate = tomorrow
- **Ожидаемый результат:** Overlay height = 0, no now-line rendered
- **Файл для теста:** `tests/frontend/schedule/pastOverlay.test.ts`

### TC-F013-008: Now-line position matches current time
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** Current time = 10:00 AM company TZ
- **Ожидаемый результат:** Now-line top = (10 - workStart) * HOUR_HEIGHT
- **Файл для теста:** `tests/frontend/schedule/pastOverlay.test.ts`

### TC-F013-009: Overlay clamp — before work hours
- **Приоритет:** P2
- **Тип:** Unit
- **Входные данные:** Current time = 6:00 AM, work_start = 8:00 AM
- **Ожидаемый результат:** Overlay height = 0
- **Файл для теста:** `tests/frontend/schedule/pastOverlay.test.ts`

### TC-F013-010: Overlay clamp — after work hours
- **Приоритет:** P2
- **Тип:** Unit
- **Входные данные:** Current time = 8:00 PM, work_end = 6:00 PM
- **Ожидаемый результат:** Overlay покрывает всю сетку (full grid height)
- **Файл для теста:** `tests/frontend/schedule/pastOverlay.test.ts`

### TC-F013-011: WeekView overlay только на today-колонке
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** Week с today = Wednesday
- **Ожидаемый результат:** Overlay есть в колонке Wed, нет в Mon/Tue/Thu/Fri/Sat/Sun
- **Файл для теста:** `tests/frontend/schedule/pastOverlay.test.ts`

---

## Сценарий 3: Drag-and-drop reschedule

### TC-F013-012: Job reschedule via drag — happy path
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** Job #100 at 9:00 AM, company TZ = America/New_York
- **Шаги:**
  1. Drag job card to 2:00 PM slot
  2. Drop
- **Моки:** PATCH /api/schedule/items/job/100/reschedule → 200
- **Ожидаемый результат:** API called with start_at = dateInTZ(y,m,d,14,0,'America/New_York').toISOString(), toast "rescheduled"
- **Файл для теста:** `tests/frontend/schedule/dragReschedule.test.ts`

### TC-F013-013: Snap-to-grid при drop
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** Drop at raw minute 47, slotDuration = 30
- **Ожидаемый результат:** Snapped to minute 30 (not 47 or 60)
- **Файл для теста:** `tests/frontend/schedule/dragReschedule.test.ts`

### TC-F013-014: Lead не draggable
- **Приоритет:** P0
- **Тип:** Unit
- **Входные данные:** Lead item card
- **Ожидаемый результат:** draggable attribute = false, no drag handlers
- **Файл для теста:** `tests/frontend/schedule/dragReschedule.test.ts`

### TC-F013-015: Reschedule API error → revert
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** PATCH /reschedule → 500
- **Ожидаемый результат:** Card reverts to original position, error toast shown
- **Файл для теста:** `tests/frontend/schedule/dragReschedule.test.ts`

### TC-F013-016: Cross-day drag in WeekView
- **Приоритет:** P1
- **Тип:** Integration
- **Шаги:** Drag job from Monday 9am to Wednesday 2pm
- **Ожидаемый результат:** API called with Wednesday date + 2pm in company TZ
- **Файл для теста:** `tests/frontend/schedule/dragReschedule.test.ts`

---

## Сценарий 4: Drag-and-drop reassign

### TC-F013-017: Reassign job between providers
- **Приоритет:** P0
- **Тип:** Integration
- **Шаги:** Drag job from Provider A row to Provider B row in TimelineView
- **Моки:** PATCH /reassign → 200
- **Ожидаемый результат:** API called with assignee_id = providerB.id, toast "reassigned"
- **Файл для теста:** `tests/frontend/schedule/dragReassign.test.ts`

### TC-F013-018: Reassign to Unassigned row
- **Приоритет:** P1
- **Тип:** Integration
- **Шаги:** Drag job to "Unassigned" row
- **Ожидаемый результат:** API called with assignee_id = null
- **Файл для теста:** `tests/frontend/schedule/dragReassign.test.ts`

### TC-F013-019: Lead reassign → error toast
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** PATCH /reassign → 400 NOT_SUPPORTED
- **Ожидаемый результат:** Card reverts, toast "Leads cannot be reassigned"
- **Файл для теста:** `tests/frontend/schedule/dragReassign.test.ts`

---

## Сценарий 5: Расширенные фильтры

### TC-F013-020: Status multi-select filter
- **Приоритет:** P0
- **Тип:** Integration
- **Шаги:** Select statuses "new" + "scheduled" in toolbar
- **Ожидаемый результат:** API called with statuses=new,scheduled; only matching items shown
- **Файл для теста:** `tests/frontend/schedule/filters.test.ts`

### TC-F013-021: Filter persistence in localStorage
- **Приоритет:** P2
- **Тип:** Unit
- **Шаги:** Set filters → unmount → remount
- **Ожидаемый результат:** Filters restored from localStorage
- **Файл для теста:** `tests/frontend/schedule/filters.test.ts`

### TC-F013-022: Reset filters
- **Приоритет:** P2
- **Тип:** Unit
- **Шаги:** Click "Reset filters"
- **Ожидаемый результат:** All filters cleared, localStorage cleaned, API refetched without filters
- **Файл для теста:** `tests/frontend/schedule/filters.test.ts`

---

## Сценарий 6: Realtime updates

### TC-F013-023: SSE job update triggers refresh
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:** SSE event `onJobUpdate` with job_id = 100
- **Ожидаемый результат:** fetchScheduleItems() called again (debounced 500ms)
- **Файл для теста:** `tests/frontend/schedule/realtime.test.ts`

### TC-F013-024: Multiple rapid SSE events debounced
- **Приоритет:** P2
- **Тип:** Unit
- **Входные данные:** 5 events within 200ms
- **Ожидаемый результат:** Only 1 API call after 500ms debounce
- **Файл для теста:** `tests/frontend/schedule/realtime.test.ts`

---

## Сценарий 7: Settings UI

### TC-F013-025: Open settings dialog
- **Приоритет:** P1
- **Тип:** Unit
- **Шаги:** Click gear icon in toolbar
- **Ожидаемый результат:** Dialog opens with current settings values pre-filled
- **Файл для теста:** `tests/frontend/schedule/settings.test.ts`

### TC-F013-026: Save settings
- **Приоритет:** P0
- **Тип:** Integration
- **Шаги:** Change timezone to "America/Chicago", save
- **Моки:** PATCH /settings → 200
- **Ожидаемый результат:** API called with {timezone: "America/Chicago"}, toast "Settings saved", views re-render with new TZ
- **Файл для теста:** `tests/frontend/schedule/settings.test.ts`

### TC-F013-027: Validation — end time before start time
- **Приоритет:** P2
- **Тип:** Unit
- **Входные данные:** work_start = "18:00", work_end = "08:00"
- **Ожидаемый результат:** Inline error, save button disabled
- **Файл для теста:** `tests/frontend/schedule/settings.test.ts`

---

## Сценарий 8: Create-from-slot

### TC-F013-028: Create task from empty slot
- **Приоритет:** P1
- **Тип:** Integration
- **Шаги:** Click empty slot at 10:00 AM → "Create Task" → fill title → save
- **Моки:** POST /from-slot → 201
- **Ожидаемый результат:** Task created with start_at/end_at from slot, appears in grid
- **Файл для теста:** `tests/frontend/schedule/createFromSlot.test.ts`

### TC-F013-029: Create task with assigned provider (TimelineView)
- **Приоритет:** P2
- **Тип:** Integration
- **Шаги:** Click slot in Provider B row → "Create Task"
- **Ожидаемый результат:** Task created with assignee_id = providerB.id
- **Файл для теста:** `tests/frontend/schedule/createFromSlot.test.ts`

---

## Безопасность и изоляция данных

### TC-F013-030: Reschedule endpoint — 401 без auth
- **Приоритет:** P0
- **Тип:** Integration
- **Входные данные:** PATCH /api/schedule/items/job/1/reschedule без Authorization header
- **Ожидаемый результат:** 401 Unauthorized
- **Файл для теста:** `tests/routes/schedule.test.js`

### TC-F013-031: Reschedule endpoint — 403 без company
- **Приоритет:** P0
- **Тип:** Integration
- **Входные данные:** Authenticated user без привязки к компании
- **Ожидаемый результат:** 403 Forbidden
- **Файл для теста:** `tests/routes/schedule.test.js`

### TC-F013-032: Reschedule чужого job → 404
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** Job #200 belongs to Company B
- **Входные данные:** User from Company A → PATCH /reschedule job/200
- **Ожидаемый результат:** 404 Not Found (НЕ 200 с данными Company B)
- **Файл для теста:** `tests/routes/schedule.test.js`

### TC-F013-033: List items — company isolation
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** Company A has 5 jobs, Company B has 3 jobs
- **Входные данные:** User from Company A → GET /api/schedule
- **Ожидаемый результат:** Returns only Company A's 5 jobs, zero from Company B
- **Файл для теста:** `tests/routes/schedule.test.js`

### TC-F013-034: Settings — company isolation
- **Приоритет:** P1
- **Тип:** Integration
- **Предусловия:** Company A settings: timezone = "America/Chicago"
- **Входные данные:** User from Company B → GET /api/schedule/settings
- **Ожидаемый результат:** Returns Company B's settings (or defaults), NOT Company A's
- **Файл для теста:** `tests/routes/schedule.test.js`
