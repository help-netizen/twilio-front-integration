# Спецификация: F013 Schedule Sprint 5 — UX Polish + Card Readability + Accessibility

## Общее описание

Sprint 5 фокусируется на UX-полировке schedule surface: устранение дублирующей информации на карточках, улучшение читаемости при collision lanes, повышение accessibility (touch targets, font sizes, keyboard navigation), и финальные визуальные доработки для dispatch-ready состояния.

**Источник:** Аудит визуального дизайна 2026-03-30, analysis Week View на реальных данных (abc-metrics.fly.dev/schedule).

---

## Подтверждённые UX-проблемы из аудита 2026-03-30

| # | Проблема | Severity | Текущее поведение | Ожидаемое поведение |
|---|----------|----------|-------------------|---------------------|
| UX-7 | **Дублирование статуса на compact-карточках** | 🟡 Moderate | Status badge отображается дважды: в Row 1 (рядом с title) и в Row 2 (compact block line 106-117). На экране одна и та же надпись "Submitted" / "Rescheduled" читается два раза подряд. | Status badge отображается ОДИН раз — в Row 1. Compact-блок (Row 2) удаляется или показывает только "Unassigned" label при отсутствии assignees. |
| UX-8 | **Title агрессивно обрезается в compact mode** | 🔴 Critical | В collision lanes (2+ items) или узких Week-колонках title truncate оставляет только icon + 1-2 символа (e.g., `🏢 \|`). Карточку невозможно идентифицировать без клика. | Title получает приоритет над status badge. При нехватке места badge скрывается, title остаётся читаемым (минимум 6-8 символов). |
| UX-9 | **Customer name отсутствует на compact-карточках** | 🟡 Moderate | В compact mode (WeekView, TimelineWeekView) вторая строка не рендерится — диспетчер не видит, ДЛЯ КОГО работа, без открытия sidebar. | В compact mode Row 2 показывает customer_name (truncated). Формат: `[customer_name]` или `[time · customer_name]`. |
| UX-10 | **Минимальные font sizes ниже порога читаемости** | 🟡 Moderate | Status badge: `text-[8px]` (compact) / `text-[9px]` (normal). На retina-дисплеях и стандартных мониторах эти размеры нечитаемы без приближения. | Минимальный font size для любого UI-текста: `text-[10px]` (= ~10px). Status badge compact: `text-[10px]`, normal: `text-[11px]`. |
| UX-11 | **Collision lanes при 3+ items делают карточки нечитаемыми** | 🟡 Moderate | 3 одновременных items делят колонку на 3 lane, каждый ~33% ширины. При ширине Week-колонки ~170px lane = ~55px — текст не помещается. | Максимум 2 видимых lanes на колонку. При 3+ items: 2 lanes отображаются + "+N more" badge/overlay на 2-й lane. Клик по badge открывает popup/tooltip со всеми items. |
| UX-12 | **Нет keyboard focus-visible стилей на карточках** | 🟢 Minor (A11y) | Card buttons не имеют visible focus indicator при Tab-навигации. `hover:ring-1` срабатывает только на hover. | Добавить `focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1` на ScheduleItemCard button. |
| UX-13 | **Time gutter обрезает длинные time labels** | 🟢 Minor | Gutter width = `w-16` (64px). "12:00 PM" визуально упирается в край. При узких viewports может обрезаться. | Увеличить gutter до `w-20` (80px) в WeekView. DayView уже использует 80px. |
| UX-14 | **"TL Week" — непонятная аббревиатура** | 🟢 Minor | Tab "TL Week" (Timeline Week) — jargon, неочевидно для новых пользователей. | Переименовать в "Team Week" или "Providers" — ближе к dispatch-контексту. |
| UX-15 | **Нет summary-count для текущего view** | 🟡 Moderate | Диспетчер не видит общее количество items на текущий период без подсчёта вручную. | Добавить count badge рядом с date label в toolbar: "12 items" (или "8 jobs · 3 leads · 1 task"). |
| UX-16 | **Sidebar Badge class interpolation может сломаться** | 🟢 Minor (Tech) | `ScheduleSidebar.tsx:52` использует `border-${style.border.replace('border-', '')}` — динамическая интерполяция Tailwind class, не поддерживается JIT purge. | Заменить на pre-defined map полных class strings (e.g., `ENTITY_BORDER_CLASSES = { job: 'border-blue-400', ... }`). |

---

## Сценарий 1: Compact Card Redesign (UX-7, UX-8, UX-9)

### Предусловия
- compact=true используется в: WeekView, TimelineWeekView, TimelineView (при узких lanes)
- Данные на карточке: icon, title, status badge, customer_name, unassigned label

### Поведение

**1.1. Layout compact-карточки (NEW)**

```
Row 1: [EntityIcon 12px] [Title — truncate, flex-1, font-medium]
Row 2: [customer_name — truncate, text-xs, opacity-75] [StatusBadge — flex-shrink-0, ТОЛЬКО если ширина позволяет]
```

- Title ВСЕГДА занимает Row 1 целиком (без status badge в Row 1 для compact)
- Status badge перемещается в Row 2, справа от customer_name, с `flex-shrink-0`
- Если customer_name пустой → Row 2 показывает только status badge
- Если card height < 32px → показать только Row 1 (title only)
- "Unassigned" label показывается вместо customer_name если `isUnassigned && !customer_name`

**1.2. Layout non-compact карточки (UNCHANGED)**

```
Row 1: [EntityIcon] [Title — truncate] [StatusBadge — flex-shrink-0]
Row 2: [time · customer_name — truncate] [Unassigned/+N techs — flex-shrink-0]
```

**1.3. Удаление дублирующего compact-блока**

- Удалить блок `{compact && (statusStyle || isUnassigned) && (...)}` (строки 106-117 в ScheduleItemCard.tsx)
- Вместо него: compact Row 2 с customer_name + status badge (описан в 1.1)

### Граничные случаи
- `customer_name = null` → Row 2 показывает только status badge
- `customer_name = ""` → аналогично null
- Очень длинный customer_name ("Johnson & Associates International LLC") → truncate, badge не сдвигается за edge
- `status = null` → Row 2 показывает только customer_name
- Card height = 24px (minimum) → только Row 1 (title)

---

## Сценарий 2: Collision Lane Cap (UX-11)

### Предусловия
- Используется assignLanes() из scheduleLayout.ts
- Результат: каждый item получает { lane, totalLanes }

### Поведение

**2.1. Visual cap на 2 lanes**

- Рендеринг в DayView/WeekView: если `totalLanes > 2`, показать первые 2 lanes
- Items в lane >= 2 НЕ рендерятся как отдельные карточки
- Вместо этого: на второй lane (lane=1) показать "overflow" indicator

**2.2. Overflow indicator**

- Формат: маленький badge "+ N" (где N = количество скрытых items в этом временном слоте)
- Позиция: правый нижний угол второй lane
- Стиль: `bg-gray-600 text-white text-[10px] rounded-full px-1.5 py-0.5`
- Click на overflow badge → открыть tooltip/popover со списком всех items этого слота
- Каждый item в tooltip кликабелен → onSelectItem

**2.3. Определение overflow items**

```
Для каждого временного кластера (connected group из assignLanes):
  visible_items = items где lane < 2
  overflow_items = items где lane >= 2
  overflow_count = overflow_items.length
```

### Граничные случаи
- 2 items overlap → 2 lanes, оба видимы, без overflow badge
- 3 items overlap → 2 lanes видимы + "+1" badge
- 5 items overlap → 2 lanes видимы + "+3" badge
- Overflow items из разных временных кластеров — считаются отдельно
- Click на overflow → popover позиционируется relative к badge, не выходит за viewport

---

## Сценарий 3: Font Size + Accessibility (UX-10, UX-12)

### Поведение

**3.1. Minimum font sizes**

| Элемент | Было | Стало |
|---------|------|-------|
| Status badge (compact) | `text-[8px]` | `text-[10px]` |
| Status badge (normal) | `text-[9px]` | `text-[11px]` |
| Unassigned label (compact) | `text-[8px]` | `text-[10px]` |
| Unassigned label (normal) | `text-[10px]` | `text-[11px]` |
| Tech count badge | `text-[10px]` | `text-[11px]` |

**3.2. Focus-visible styles**

Добавить в ScheduleItemCard `<button>`:
```
focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 outline-none
```

Аналогично для:
- UnscheduledPanel card items
- MonthView day cells (clickable)
- MonthView item title links

**3.3. Touch target minimum**

- Minimum card height: `32px` (вместо `24px`)
- Minimum interactive area: `44px` vertical при compact mode (через padding если content < 44px)
- Не применяется к desktop-only collision lanes (там допустимы меньшие targets)

---

## Сценарий 4: Time Gutter Width (UX-13)

### Поведение

- WeekView gutter: `w-16` → `w-20` (64px → 80px)
- DayView gutter: оставить `w-20` (уже 80px)
- TimelineView provider column: оставить `w-36` (144px) — достаточно

---

## Сценарий 5: Toolbar Enhancements (UX-14, UX-15)

### Поведение

**5.1. Tab rename**
- `TL Week` → `Team Week`

**5.2. Item count badge**

- Рядом с date label в toolbar (справа, inline):
  ```
  Mar 29 – Apr 4, 2026  [12 items]
  ```
- Badge стиль: `bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full`
- Count = количество `scheduledItems` в текущем date range (из useScheduleData)
- Tooltip on hover: "8 jobs · 3 leads · 1 task" (breakdown по entity type)
- При loading → badge показывает skeleton/spinner

---

## Сценарий 6: Sidebar Badge Fix (UX-16)

### Поведение

Заменить dynamic class interpolation в `ScheduleSidebar.tsx`:

**Было:**
```tsx
className={`${style.bg} ${style.text} border-${style.border.replace('border-', '')} text-xs`}
```

**Стало:**
Создать explicit map:
```tsx
const ENTITY_BADGE_CLASSES: Record<string, string> = {
    job:  'bg-blue-50 text-blue-700 border-blue-400',
    lead: 'bg-amber-50 text-amber-700 border-amber-400',
    task: 'bg-green-50 text-green-700 border-green-400',
};
```

---

## Ограничения и нефункциональные требования

- НЕ менять behavior существующих views (Day, Week, Month, Timeline, Timeline Week) — только visual polish
- НЕ менять API contracts или backend
- НЕ менять scheduleLayout.ts algorithm (assignLanes) — overflow cap реализуется на уровне рендеринга
- НЕ трогать protected files (server.js, authedFetch, useRealtimeEvents)
- Все изменения — frontend only
- Desktop-first: не деградировать dispatch UX ради мобильной адаптации
- Backward compatible: существующие unit tests (29 tests из Sprint 3) должны продолжать проходить

---

## Файлы для изменения

| Файл | Изменения |
|------|-----------|
| `frontend/src/components/schedule/ScheduleItemCard.tsx` | Compact card redesign, remove duplicate status, font sizes, focus-visible, min-height |
| `frontend/src/components/schedule/WeekView.tsx` | Gutter width, collision lane cap + overflow badge, min card height |
| `frontend/src/components/schedule/DayView.tsx` | Collision lane cap + overflow badge, min card height |
| `frontend/src/components/schedule/ScheduleToolbar.tsx` | Tab rename, item count badge |
| `frontend/src/components/schedule/ScheduleSidebar.tsx` | Fix badge class interpolation |
| `frontend/src/components/schedule/UnscheduledPanel.tsx` | Focus-visible styles |
| `frontend/src/components/schedule/MonthView.tsx` | Focus-visible styles |
| `frontend/src/hooks/useScheduleData.ts` | Expose item count by entity type for toolbar badge |
| `frontend/src/components/schedule/OverflowPopover.tsx` | NEW — popover for "+N more" overflow items |

---

## Acceptance criteria

- [ ] Compact-карточки показывают title на Row 1 без конкуренции с badge
- [ ] Status отображается ОДИН раз (не дублируется)
- [ ] Customer name видим на compact cards (Row 2)
- [ ] Минимальный font size >= 10px для всех UI элементов
- [ ] Focus-visible ring на Tab-навигации по карточкам
- [ ] При 3+ collision items — 2 lane + "+N" badge (не 3+ нечитаемых lane)
- [ ] Click на "+N" badge открывает список overflow items
- [ ] Time gutter в WeekView вмещает "12:00 PM" без обрезки
- [ ] Tab "TL Week" переименован в "Team Week"
- [ ] Item count badge видим в toolbar рядом с date range
- [ ] Sidebar badge рендерится корректно (не зависит от Tailwind JIT purge)
- [ ] Существующие 29 unit/integration tests проходят без изменений

---

## Приоритизация задач

| # | Задача | Приоритет | Сложность | Зависимости |
|---|--------|-----------|-----------|-------------|
| 1 | Compact card redesign (title priority, remove dupe status, add customer_name) | P0 | Medium | — |
| 2 | Font size minimums (10px floor) | P0 | Low | — |
| 3 | Focus-visible styles (a11y) | P1 | Low | — |
| 4 | Collision lane visual cap (2 lanes + overflow badge) | P1 | High | OverflowPopover.tsx |
| 5 | Gutter width fix (WeekView) | P2 | Low | — |
| 6 | Toolbar: tab rename + count badge | P2 | Low-Medium | useScheduleData expose counts |
| 7 | Sidebar badge class fix | P2 | Low | — |
