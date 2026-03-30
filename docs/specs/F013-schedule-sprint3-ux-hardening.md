# Спецификация: F013 Schedule Sprint 3 — UX Hardening + Interactive Dispatch

## Общее описание

Sprint 3 превращает read-only расписание (Sprint 2) в полноценный интерактивный диспетчерский инструмент: timezone-aware отображение, visual past-time indicator, drag-and-drop reschedule/reassign, расширенные фильтры, realtime updates, настройки dispatch, create-from-slot.

---

## Сценарий 1: Timezone-aware отображение

### Предусловия
- Company имеет `dispatch_settings.timezone` (или дефолт `America/New_York`)
- Пользователь может быть в любой timezone браузера

### Поведение

**1.1. Часовые метки в сетке**
- DayView/WeekView: вертикальные часовые label отображаются в company TZ
- TimelineView: горизонтальные часовые label — в company TZ
- Формат: `h:mm A` (12-hour, e.g. "9:00 AM")
- Для генерации label → `dateInTZ(y, m, d, hour, 0, tz)` → `fmtTime(date, tz)`

**1.2. Позиционирование items**
- Item `.start_at` (ISO UTC) конвертируется в минуты от полуночи в company TZ через `minutesSinceMidnight(parseISO(start_at), tz)`
- Позиция: `top = (minutesFromMidnight - workStartMinutes) / 60 * HOUR_HEIGHT`
- Аналогично для end_at → height
- Если item выходит за границы work hours — clamp к grid boundaries

**1.3. "Today" highlight**
- Текущий день определяется через `todayInTZ(tz)`, а не `new Date()`
- WeekView: today-колонка с bg-blue-50
- MonthView: today-ячейка с кружком
- TimelineWeekView: today-колонка с bg-blue-50

**1.4. Sidebar time display**
- Время в sidebar форматируется в company TZ: `Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })`

**1.5. Date navigation**
- "Today" button переходит к `todayInTZ(tz)`, а не `new Date()`

### Граничные случаи
- Пользователь в UTC+5, company TZ = America/New_York (UTC-4): разница 9 часов, item в 9:00 AM ET показывается как 9:00 AM (не 6:00 PM)
- Item.start_at = "2026-03-30T04:00:00Z" (midnight ET) → должен попадать на 30 марта, не на 29-е
- DST переход: при переходе EST→EDT items корректно сдвигаются

### Обработка ошибок
- settings.timezone = null/undefined → fallback `'America/New_York'`
- Невалидная timezone string → fallback `'America/New_York'`

---

## Сценарий 2: Past-time overlay + now-line

### Предусловия
- Текущий день определяется в company TZ

### Поведение

**2.1. DayView**
- Серый полупрозрачный overlay от начала сетки до текущего времени (company TZ)
- Красная горизонтальная линия (2px solid #ef4444) на текущем времени
- Overlay: `background: rgba(128, 128, 128, 0.18); pointer-events: none; z-index: 1`
- Now-line: `z-index: 6; pointer-events: none`
- Обновление позиции: при каждом render (не setInterval — достаточно при навигации/focus)

**2.2. WeekView**
- Overlay + now-line только на today-колонке
- Остальные дни недели — без overlay

**2.3. TimelineView**
- Вертикальная past-overlay (слева от now-line) на today
- Now-line — вертикальная красная линия

**2.4. TimelineWeekView**
- Today-колонка визуально отмечена (bg-accent), но без hourly now-line (нет hourly grid)

**2.5. MonthView**
- Без overlay (нет hourly grid)

### Вычисления (паттерн из CustomTimeModal)
```
isToday = selectedDate === todayInTZ(companyTz)
nowMinFromGrid = minutesSinceMidnight(new Date(), companyTz) - WORK_START_HOUR * 60
pastHeight = Math.max(0, Math.min(nowMinFromGrid, TOTAL_WORK_HOURS * 60)) / 60 * HOUR_HEIGHT
```

### Граничные случаи
- До начала work hours → overlay = 0 (не показывать)
- После конца work hours → overlay покрывает всю сетку
- Не today → overlay = 0
- Week view с today = Sunday → overlay на первой колонке

---

## Сценарий 3: Drag-and-drop reschedule

### Предусловия
- Работает в DayView, WeekView, TimelineView
- Item entity_type = 'job' или 'task' (leads — read-only)

### Поведение

**3.1. Drag start**
- User mousedown + drag на ScheduleItemCard → card становится draggable
- Ghost preview (opacity: 0.6) следует за курсором
- `dataTransfer.setData('schedule-item', JSON.stringify({entityType, entityId, duration}))`

**3.2. Drag over grid**
- Time slots показывают drop target highlight (bg-blue-100/50)
- Snap to grid: `snappedMinute = Math.round(rawMinute / slotDuration) * slotDuration`
- slotDuration берётся из settings (default 60 min)

**3.3. Drop**
- Вычислить newStartAt из drop position в company TZ → `dateInTZ(y, m, d, h, min, tz)`
- newEndAt = newStartAt + originalDuration (или slotDuration если end_at отсутствовал)
- Optimistic update: переместить card в UI сразу
- API call: `rescheduleItem(entityType, entityId, newStartAt.toISOString(), newEndAt.toISOString())`
- Success → toast "Job #123 rescheduled to Mar 30, 2:00 PM"
- Error → revert position, toast error

**3.4. Cross-day drag (WeekView)**
- Можно перетащить item с одного дня на другой
- День определяется по колонке drop target

### Ограничения
- Lead items: `draggable=false`, cursor: default
- MonthView, TimelineWeekView: no drag (нет hourly grid)

### Обработка ошибок
- API 404 (item deleted) → remove card + toast "Item no longer exists"
- API 400 (validation) → revert + toast error message
- Network error → revert + toast "Failed to reschedule. Try again."

---

## Сценарий 4: Drag-and-drop reassign

### Предусловия
- Работает в TimelineView и TimelineWeekView
- Items entity_type = 'job' или 'task'

### Поведение

**4.1. Drag between provider rows**
- User drags card from provider A row to provider B row
- Drop zone: provider row highlight (bg-green-100/50)
- На drop: `reassignItem(entityType, entityId, newAssigneeId)`

**4.2. Combined reschedule + reassign (TimelineView only)**
- Drag across both time axis AND provider rows → two API calls: reschedule + reassign
- Или один combined call (backend поддерживает оба по отдельности)

**4.3. Unassign**
- Drag to "Unassigned" row → `reassignItem(entityType, entityId, null)`

### Ограничения
- Leads: не поддерживают reassign (нет assigned_provider_id)
- Backend возвращает `NOT_SUPPORTED` для leads → toast warning

### Обработка ошибок
- API error → revert + toast

---

## Сценарий 5: Расширенные фильтры

### Поведение

**5.1. Status multi-select**
- Dropdown с чекбоксами: job statuses (new, scheduled, en_route, in_progress, completed) + lead statuses (new, contacted, qualified) + task (open)
- Multiple selection → API: `statuses=new,scheduled,en_route`

**5.2. Job type filter**
- Dropdown: список из lead-form-settings (job types)
- Single select

**5.3. Source filter**
- Dropdown: список sources (Zenbooker, Manual, Lead Form, etc.)

**5.4. Tags filter**
- Multi-select combobox из существующих tags

**5.5. Filter persistence**
- Сохранение в localStorage key `schedule-filters`
- Восстановление при mount
- "Reset filters" button

### Взаимодействие компонентов
- ScheduleToolbar → onFiltersChange → useScheduleData → fetchScheduleItems(newFilters)
- Toolbar UI: collapsible "More Filters" row для status/source/tags (чтобы не перегружать)

---

## Сценарий 6: Realtime updates

### Поведение
- `useScheduleData` подписывается через `useRealtimeEvents()`:
  - `onJobUpdate` → refresh items
  - `onLeadUpdate` → refresh items
  - `onTaskUpdate` → refresh items
- Debounce: 500ms (чтобы не спамить при batch updates)
- Не полная перезагрузка, а smart refresh: если event содержит entity_id, обновить только этот item

### Побочные эффекты
- Если item reschedule-ен другим оператором — карточка перемещается в realtime
- Если item удалён/отменён — исчезает из grid

---

## Сценарий 7: Settings UI

### Поведение

**7.1. Открытие**
- Кнопка Settings (gear icon) в ScheduleToolbar → DispatchSettingsDialog (modal)

**7.2. Форма**
- Timezone: searchable dropdown (IANA timezones, популярные сверху: America/New_York, America/Chicago, America/Denver, America/Los_Angeles)
- Work start/end: time pickers (HH:MM)
- Work days: 7 toggle buttons (Mon-Sun)
- Slot duration: select (15 / 30 / 45 / 60 / 90 / 120 min)
- Buffer: select (0 / 15 / 30 / 60 min)

**7.3. Сохранение**
- "Save" → `updateDispatchSettings(updates)` → toast "Settings saved"
- Все views немедленно переключаются на новые settings (через state refresh)

**7.4. Доступ**
- Все авторизованные пользователи компании могут просматривать
- Редактирование — роль admin/dispatcher (проверка на backend через role middleware)

### Обработка ошибок
- Невалидные значения (end < start) → inline validation error
- API error → toast "Failed to save settings"

---

## Сценарий 8: Create-from-slot

### Поведение

**8.1. Click на пустой слот**
- DayView/WeekView: click на пустое место в hourly grid
- Context menu (dropdown): "Create Task" / "Create Lead" / "Create Job"
- Slot time determined by click position → snap to slot boundaries

**8.2. Create Task**
- Inline или dialog: title (required), description (optional), priority
- Auto-fill: start_at, end_at (slot boundaries), assigned_provider_id (если timeline view)
- API: `POST /api/schedule/items/from-slot` (уже реализован для tasks)
- После создания: item появляется в grid

**8.3. Create Lead / Create Job**
- Открывает `CreateLeadJobWizard` с предзаполненным временем
- Передаёт: start time, end time, assigned provider (если есть)
- После успешного создания: refresh schedule

### Ограничения
- MonthView: нет create-from-slot (нет hourly precision)
- TimelineWeekView: create по клику на ячейку дня, но без часовой precision

---

## Безопасность и изоляция данных

- Все данные фильтруются по `company_id` — пользователь видит только items своей компании
- Reschedule/reassign проверяют принадлежность entity к company: `AND company_id = $N`
- Прямой доступ по entity_id — если entity принадлежит другой компании → 404
- Settings: один company → один dispatch_settings record (UNIQUE constraint на company_id)
