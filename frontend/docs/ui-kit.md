# BLANC CRM — UI Kit & Design Requirements

> **Baseline Reference**: Страница `/leads` (`LeadsPage.tsx`)
> **Цель**: Обеспечить консистентность дизайна всех страниц и компонентов проекта. Этот документ — живой справочник, который пополняется по мере добавления новых паттернов.

---

## 1. Стек и фундамент

| Слой | Технология |
|---|---|
| UI-библиотека | **shadcn/ui** (Radix primitives + CVA) |
| Стилизация | **Tailwind CSS v4** (`@theme inline`) |
| Иконки | **Lucide React** (`lucide-react`) |
| Тема | CSS custom properties (`styles/theme.css`, `styles/tailwind.css`) |
| Утилиты | `cn()` из `lib/utils` (class merging) |
| Тосты | `sonner` |
| Дата | `date-fns` (`format`) |

---

## 2. Цветовая система (Design Tokens)

Все цвета определены как CSS custom properties в `:root` и `.dark` и маппятся в Tailwind через `@theme inline`.

### 2.1 Семантические токены

| Token | Light | Назначение |
|---|---|---|
| `--background` | `#ffffff` | Фон страницы |
| `--foreground` | `#0a0a0a` | Основной текст |
| `--primary` | `#030213` | Основные кнопки, акценты |
| `--primary-foreground` | `#ffffff` | Текст на primary |
| `--secondary` | `#f0f0f5` | Вторичные элементы |
| `--muted` | `#ececf0` | Приглушённый фон |
| `--muted-foreground` | `#717182` | Вторичный текст, подписи |
| `--accent` | `#e9ebef` | Hover-фон, акцентный фон |
| `--destructive` | `#d4183d` | Ошибки, удаление |
| `--border` | `rgba(0,0,0,0.1)` | Границы |
| `--input-background` | `#f3f3f5` | Фон полей ввода |
| `--ring` | `#b0b0b0` | Focus ring |

### 2.2 Дополнительные (legacy из `App.css`)

| Token | Значение | Назначение |
|---|---|---|
| `--front-primary` | `#5C6AC4` | Legacy-акцент (не использовать для нового UI) |
| `--front-gray` | `#637381` | Серый текст (header) |
| `--front-border` | `#E1E3E5` | Border header |
| `--front-bg` | `#F9FAFB` | Background (legacy) |
| `--front-text` | `#202223` | Текст (header, legacy) |

### 2.3 Специализированные цвета (inline)

Эти цвета допускается использовать **только в контексте**, описанном ниже:

| Цвет | Tailwind-класс | Контекст |
|---|---|---|
| Зелёный | `bg-green-600` | Badge «в зоне обслуживания», успех |
| Оранжевый | `text-orange-600` | Предупреждение (Mark Lost) |
| Розовый фон | `bg-rose-50`, `border-rose-100` | Comments area (LeadDetailPanel) |
| Красный | `text-red-600` | Logout |

> [!IMPORTANT]
> **Для нового кода** не используйте raw-цвета (`text-red-500`, `bg-blue-400`). Используйте семантические токены (`text-destructive`, `bg-primary`). Если нужен новый семантический цвет — добавьте token в `theme.css`.

---

## 3. Типографика

### 3.1 Шрифт

```css
font-family: system-ui, Avenir, Helvetica, Arial, sans-serif;
/* Альтернативная запись из App.css: */
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
```

Базовый размер: `--font-size: 16px` (задано на `html`).

### 3.2 Масштаб

| Элемент | Размер | Вес | Класс |
|---|---|---|---|
| h1 (app title) | `text-2xl` | `font-semibold` | — |
| h2 (page title) | `text-xl` | `font-semibold` | — |
| h3 (section title) | `text-lg` / `font-semibold` | `font-semibold` или `font-medium` | — |
| h4 (subsection) | `text-base` | `font-medium` | — |
| Body text | `text-sm` (14px) | `font-medium` | Основной текст в таблицах и вкладках |
| Secondary text | `text-sm` | normal | `text-muted-foreground` |
| Label / hint | `text-xs` (12px) | `font-medium` | `text-muted-foreground` |
| Mono (ID, phone) | `text-sm` | normal | `font-mono` |

### 3.3 Правила типографики

- **Заголовок страницы** = `<h2 className="text-xl font-semibold">Leads</h2>`
- **Заголовок секции** = `<h3 className="font-medium">Contact Information</h3>` или `<h4 className="font-medium mb-3">...</h4>`
- **Подписи к полям** (label) = `<Label className="text-xs text-muted-foreground">`
- **Моноширинный текст** для ID, телефонов = `className="font-mono text-sm"`

---

## 4. Скругления и отступы

| Token | Значение | Применение |
|---|---|---|
| `--radius` | `0.625rem` (10px) | Базовый радиус |
| `--radius-sm` | `6px` | Маленькие элементы (badge, select items) |
| `--radius-md` | `8px` | Средние (buttons, inputs) |
| `--radius-lg` | `10px` | Cards |
| `--radius-xl` | `14px` | Tabs, large cards |

### Система отступов (spacing)

| Контекст | Значение | Пример |
|---|---|---|
| Page / section padding | `p-4` (16px) | FilterBar, DetailPanel |
| Grid gap | `gap-3` / `gap-4` | Form grids |
| Inline gap (кнопки) | `gap-2` (8px) | Action buttons |
| Stack spacing | `space-y-3` / `space-y-4` | Form sections, detail fields |
| Section dividers | `border-b` / `border-t` | Между header/content/footer |

---

## 5. Компоненты (UI Kit)

### 5.1 Button

**Файл**: `components/ui/button.tsx`

| Variant | Использование | Пример |
|---|---|---|
| `default` | Основные действия (CTA) | "Create Lead", "Convert to Job", "Create Job" |
| `outline` | Второстепенные действия | "Edit", "Previous", "Column Settings" |
| `ghost` | Иконки, inline-действия | Copy phone, Close, MoreVertical |
| `destructive` | Опасные действия | (не используется inline — через DropdownMenuItem) |
| `link` | Текстовые ссылки | (не используется на leads) |
| `secondary` | Мягкие действия | (доступен, пока не используется) |

| Size | Использование |
|---|---|
| `default` (h-9) | Стандартные кнопки |
| `sm` (h-8) | Компактные кнопки (в таблицах, footer) |
| `lg` (h-10) | Крупные (пока не используется) |
| `icon` (size-9) | Только иконка |

**Паттерн: кнопка с иконкой**
```tsx
<Button onClick={...}>
    <Plus className="size-4 mr-2" />
    Create Lead
</Button>
```

**Паттерн: кнопки в footer (высокие)**
```tsx
<Button variant="outline" size="sm" className="h-12">
    <Edit className="size-4 mr-2" />
    Edit
</Button>
```

---

### 5.2 Badge

**Файл**: `components/ui/badge.tsx`

| Variant | Использование |
|---|---|
| `default` | Активные статусы (New, Submitted, Qualified) |
| `secondary` | Промежуточные статусы (Contacted) |
| `destructive` | Lost / ошибки |
| `outline` | Converted, источник, sub-status |

**Маппинг статусов Lead → Badge variant:**
```ts
'New' | 'Submitted'        → 'default'
'Contacted'                 → 'secondary'
'Qualified' | 'Proposal Sent' | 'Negotiation' → 'default'
'Converted'                 → 'outline'
'Lost'                      → 'destructive'
```

**Паттерн: clickable badge (dropdown trigger)**
```tsx
<button className="inline-flex items-center gap-1 ...">
    <Badge variant="..." className="cursor-pointer hover:opacity-80 transition-opacity">
        {status}
    </Badge>
    <ChevronDown className="size-3 text-muted-foreground" />
</button>
```

---

### 5.3 Input

**Файл**: `components/ui/input.tsx`

- Высота: `h-9`
- Фон: `bg-input-background` (`#f3f3f5`)
- Border: `border-input` (transparent → focus: `border-ring`)
- Focus ring: `ring-ring/50`

**Паттерн: поиск с иконкой**
```tsx
<div className="relative flex-1 min-w-[200px]">
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
    <Input placeholder="Search..." className="pl-9" />
</div>
```

---

### 5.4 Select

**Файл**: `components/ui/select.tsx`

- Тот же фон `bg-input-background` и стилистика, что и у Input.
- Использовать Radix-based `Select` из shadcn.
- В исключительных случаях (ConvertToJobDialog) используется нативный `<select>` с ручными классами — **новый код должен использовать shadcn `<Select>`**.

---

### 5.5 Table

**Файл**: `components/ui/table.tsx`

| Элемент | Стили |
|---|---|
| TableHead | `h-10 px-2 font-medium text-foreground whitespace-nowrap` |
| TableCell | `p-2 whitespace-nowrap` |
| TableRow | `border-b hover:bg-muted/50` |
| Selected row | `bg-muted` |
| TableHeader | `sticky top-0 bg-background z-10` |

**Паттерн: таблица с пагинацией**
```tsx
{/* Table */}
<div className="flex-1 overflow-auto">
    <Table>...</Table>
</div>
{/* Pagination footer */}
<div className="border-t p-4 flex items-center justify-between">
    <div className="text-sm text-muted-foreground">
        Showing {start} - {end} items
    </div>
    <div className="flex gap-2">
        <Button variant="outline" size="sm">Previous</Button>
        <Button variant="outline" size="sm">Next</Button>
    </div>
</div>
```

---

### 5.6 Dialog

**Файл**: `components/ui/dialog.tsx`

- Overlay: `bg-black/50`
- Content: `max-w-lg` (по умолч.), расширяется до `max-w-2xl` или `max-w-xl`
- Max height: `max-h-[85vh]` / `max-h-[90vh]` + `overflow-y-auto`
- Padding: `p-6`, gap: `gap-4`
- Close: крестик `X` в правом верхнем углу

**Паттерн: стандартный диалог**
```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
        </DialogHeader>
        <form className="space-y-6">
            {/* Sections */}
            <DialogFooter>
                <Button variant="outline">Cancel</Button>
                <Button type="submit">Submit</Button>
            </DialogFooter>
        </form>
    </DialogContent>
</Dialog>
```

---

### 5.7 DropdownMenu

- Используется для контекстных действий (⋮ кнопка в таблице) и для навигационного меню Settings.
- Trigger: `<Button variant="ghost" size="sm" className="size-8 p-0">`
- Иконки в пунктах меню: `<IconName className="size-4 mr-2" />`
- Разделитель: `<DropdownMenuSeparator />`
- Деструктивные действия: `className="text-destructive"` или `className="text-orange-600"` (warn)

---

### 5.8 Popover + Calendar (Date Picker)

**Паттерн: дата с пресетами**
```tsx
<Popover>
    <PopoverTrigger asChild>
        <Button variant="outline" className="gap-2">
            <CalendarIcon className="size-4" />
            {formattedDate}
        </Button>
    </PopoverTrigger>
    <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
            <div className="border-r p-3 space-y-1">
                {/* Presets: Today, Last 7 days, Last 30 days */}
            </div>
            <Calendar mode="single" selected={date} onSelect={setDate} />
        </div>
    </PopoverContent>
</Popover>
```

---

### 5.9 Multi-Select Filter (Command + Popover)

**Паттерн: фильтр со счётчиком**
```tsx
<Popover>
    <PopoverTrigger asChild>
        <Button variant="outline" className="gap-2">
            <Filter className="size-4" />
            Status
            {count > 0 && <Badge variant="secondary" className="ml-1 px-1.5 py-0">{count}</Badge>}
        </Button>
    </PopoverTrigger>
    <PopoverContent className="w-[240px] p-0" align="start">
        <Command>
            <CommandInput placeholder="Search..." />
            <CommandList>
                <CommandGroup>
                    {items.map(item => (
                        <CommandItem onSelect={() => toggle(item)}>
                            <Checkbox /> {item}
                        </CommandItem>
                    ))}
                </CommandGroup>
            </CommandList>
            {/* Clear button at bottom */}
        </Command>
    </PopoverContent>
</Popover>
```

---

### 5.10 Switch + Label

**Паттерн: toggle в рамке**
```tsx
<div className="flex items-center gap-2 px-3 py-2 border rounded-md">
    <Switch id="toggle-id" checked={value} onCheckedChange={setValue} />
    <Label htmlFor="toggle-id" className="cursor-pointer">Label</Label>
</div>
```

---

### 5.11 Skeleton (Loading)

```tsx
{[...Array(8)].map((_, i) => (
    <Skeleton key={i} className="h-16 w-full" />
))}
```

---

### 5.12 StatusBadge (Call Status)

**Файл**: `components/StatusBadge.tsx`

Специализированный компонент для статусов звонков (Twilio). Использует inline Tailwind-цвета (`bg-green-500`, `bg-red-500`), а не семантические токены.

> [!NOTE]
> Этот компонент исторический. При рефакторинге рекомендуется мигрировать на семантические CSS tokens для call-статусов.

---

## 6. Паттерны компоновки (Layout Patterns)

### 6.1 App Shell

```
┌──────────── Header (60px, fixed) ─────────────┐
│ Logo  [Tabs: Calls / Leads]     [Settings ▾]  │
├───────────────────────────────────────────────┤
│                                               │
│              Main (flex: 1)                   │
│                                               │
└───────────────────────────────────────────────┘
```

- Header: `height: 60px`, `white bg`, `border-bottom: #E1E3E5`
- Навигация: `Tabs` (shadcn) с иконками
- Контейнер: `display: flex; flex-direction: column; height: 100vh;`

### 6.2 Master-Detail Layout (Leads, рекомендован для новых страниц)

```
┌──────────── Page ──────────────────────────────┐
│ ┌──── List Panel (flex-1) ──┐ ┌── Detail ──┐  │
│ │ ┌── Filter Bar ─────────┐ │ │  Header    │  │
│ │ │ Title    [+ Create]   │ │ │  ────────  │  │
│ │ │ [Search] [Date] [Flt] │ │ │  Contact   │  │
│ │ └───────────────────────┘ │ │  Job Info   │  │
│ │ ┌── Table ──────────────┐ │ │  Metadata  │  │
│ │ │ (scrollable)          │ │ │            │  │
│ │ └───────────────────────┘ │ │  ────────  │  │
│ │ ┌── Pagination ─────────┐ │ │  Actions   │  │
│ │ │ Showing x-y  [< >]   │ │ │            │  │
│ │ └───────────────────────┘ │ └────────────┘  │
│ └───────────────────────────┘                  │
└────────────────────────────────────────────────┘
```

**CSS-паттерн:**
```tsx
<div className="flex h-full overflow-hidden">
    {/* Left panel */}
    <div className="flex-1 flex flex-col border-r overflow-x-auto">
        <div className="border-b p-4 space-y-4">{/* Filters */}</div>
        {/* Table (flex-1 overflow-auto) */}
    </div>
    {/* Right detail panel */}
    <div className="w-[400px] min-w-[240px] border-l flex flex-col shrink-0">
        {/* Header → Scrollable content → Footer actions */}
    </div>
</div>
```

**Респонсив:**
- На mobile (`< md`): Detail panel — `fixed inset-0 z-50 bg-background`
- Список скрывается при открытом detail: `hidden md:flex`

### 6.3 Detail Panel

Структура:
1. **Header** (`p-4 border-b`): имя, badges со статусами, actions
2. **Content** (`flex-1 overflow-y-auto`): секции с `<Separator />` между ними
3. **Footer** (`p-4 border-t`): action buttons

**Паттерн: поле с иконкой**

```tsx
<div className="flex items-start gap-3">
    <Phone className="size-4 mt-0.5 text-muted-foreground" />
    <div className="flex-1">
        <Label className="text-xs text-muted-foreground">Phone</Label>
        <div className="text-sm font-medium mt-1">{value}</div>
    </div>
</div>
```

### 6.4 Empty State

```tsx
<div className="flex-1 flex items-center justify-center">
    <div className="text-center">
        <Users className="size-12 mx-auto mb-3 opacity-20" />
        <p className="text-lg mb-2">No leads found</p>
        <p className="text-sm text-muted-foreground">
            Helpful suggestion text
        </p>
    </div>
</div>
```

### 6.5 Wizard Dialog (Multi-Step Form)

**Step Indicator:**
```tsx
<div className="flex items-center gap-1 mb-4">
    {steps.map(s => (
        <div className="flex items-center gap-1">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
                ${s === current ? 'bg-primary text-primary-foreground'
                 : s < current ? 'bg-primary/20 text-primary'
                 : 'bg-muted text-muted-foreground'}`}>
                {s < current ? '✓' : s}
            </div>
            {s < total && <div className={`w-8 h-0.5 ${s < current ? 'bg-primary/40' : 'bg-muted'}`} />}
        </div>
    ))}
    <span className="ml-2 text-sm font-medium text-muted-foreground">{stepTitle}</span>
</div>
```

**Footer с Back / Next / Submit:**
```tsx
<DialogFooter className="flex justify-between pt-4">
    <div>{step > 1 && <Button variant="outline">Back</Button>}</div>
    <div className="flex gap-2">
        <Button variant="ghost">Cancel</Button>
        {step < maxStep
            ? <Button disabled={!canProceed}>Next</Button>
            : <Button disabled={submitting}>Create Job</Button>}
    </div>
</DialogFooter>
```

### 6.6 Review / Summary Panel (Step 4 of Wizard)

```tsx
<h4 className="font-semibold">Section Title</h4>
<div className="bg-muted/50 rounded-md p-3 space-y-1">
    <p><span className="text-muted-foreground">Label:</span> {value}</p>
</div>
```

---

## 7. Формы

### 7.1 Структура формы

```tsx
<form className="space-y-6">
    <div className="space-y-4">
        <h3 className="font-medium">Section Title</h3>
        <div className="grid grid-cols-2 gap-4">
            <div>
                <Label htmlFor="id" className="mb-2">
                    Field Name <span className="text-destructive">*</span>
                </Label>
                <Input id="id" ... />
            </div>
        </div>
    </div>
</form>
```

### 7.2 Grid-раскладки

| Контекст | Grid | Gap |
|---|---|---|
| 2 поля в ряд | `grid-cols-2` | `gap-4` / `gap-3` |
| 3 поля (city/state/zip) | `grid-cols-3` | `gap-4` / `gap-3` |
| Textarea на всю ширину | `col-span-2` | — |

### 7.3 Обязательные поля

`<span className="text-destructive">*</span>` рядом с label.

---

## 8. Уведомления (Toast)

Используется `sonner`:

```tsx
import { toast } from 'sonner';

toast.success('Lead created successfully');
toast.error('Failed to load leads', {
    description: error.message
});
```

---

## 9. Иконки

**Библиотека**: `lucide-react`

### Стандартные размеры:

| Контекст | Размер |
|---|---|
| В кнопке / inline | `size-4` (16px) |
| В dropdown пунктах | `size-4 mr-2` |
| Empty state | `size-12 opacity-20` |
| Detail panel поля | `size-4 mt-0.5 text-muted-foreground` |
| Маленькие | `size-3` |

### Часто используемые иконки:

| Иконка | Контекст |
|---|---|
| `Plus` | Создание |
| `Settings` | Настройки |
| `Search` | Поиск |
| `Filter` | Фильтры |
| `Edit` | Редактирование |
| `X` | Закрытие / отмена |
| `MoreVertical` | Контекстное меню |
| `Phone` | Телефон |
| `Mail` | Email |
| `MapPin` | Адрес |
| `Calendar`, `CalendarIcon` | Даты |
| `Briefcase` | Job / Convert |
| `Copy` | Копирование |
| `ChevronDown` | Dropdown arrow |
| `CheckCircle2` | Activate |
| `PhoneOff` | Mark Lost |
| `Trash2` | Удаление |
| `Users` | Лиды (nav) |
| `Tag` | Источник лида |
| `FileText` | Документ / доп. поля |

---

## 10. Правила для разработки новых страниц

### ✅ DO

1. Используй компоненты из `components/ui/` — не создавай свои кнопки/инпуты
2. Используй семантические токены (`text-muted-foreground`, `bg-primary`) — не raw-цвета
3. Придерживайся master-detail layout для списковых страниц
4. Используй паттерн Filter Bar для страниц с фильтрацией
5. Добавляй Empty State с иконкой и описанием
6. Используй `border-b` / `border-t` для разделения секций, `<Separator />` внутри контента
7. Все диалоги создания/редактирования — через `Dialog` shadcn
8. Для действий в строке таблицы — `DropdownMenu` с `MoreVertical`
9. Для loading state — `Skeleton` или `animate-pulse`
10. Телефоны и ID отображай моноширинным: `font-mono text-sm`
11. `toast.success()` / `toast.error()` для feedback'а

### ❌ DON'T

1. Не используй `alert()` для нового кода (legacy в `AppLayout.tsx`)
2. Не создавай inline styles — используй Tailwind классы
3. Не используй нативный `<select>` — используй shadcn `Select`
4. Не дублируй цветовые значения — ссылайся на CSS tokens
5. Не используй `window.confirm()` — создавай confirmation-диалоги

---

## 11. Доступные UI-примитивы (shadcn/ui)

Полный список компонентов в `components/ui/`:

| Компонент | Файл | Статус |
|---|---|---|
| Badge | `badge.tsx` | ✅ Используется |
| Button | `button.tsx` | ✅ Используется |
| Calendar | `calendar.tsx` | ✅ Используется |
| Card | `card.tsx` | ✅ Доступен |
| Collapsible | `collapsible.tsx` | 📦 Доступен |
| Command | `command.tsx` | ✅ Используется |
| Dialog | `dialog.tsx` | ✅ Используется |
| DropdownMenu | `dropdown-menu.tsx` | ✅ Используется |
| Input | `input.tsx` | ✅ Используется |
| Label | `label.tsx` | ✅ Используется |
| Popover | `popover.tsx` | ✅ Используется |
| ScrollArea | `scroll-area.tsx` | 📦 Доступен |
| Select | `select.tsx` | ✅ Используется |
| Separator | `separator.tsx` | ✅ Используется |
| Skeleton | `skeleton.tsx` | ✅ Используется |
| Slider | `slider.tsx` | 📦 Доступен |
| Sonner | `sonner.tsx` | ✅ Используется |
| Switch | `switch.tsx` | ✅ Используется |
| Table | `table.tsx` | ✅ Используется |
| Tabs | `tabs.tsx` | ✅ Используется |
| Textarea | `textarea.tsx` | ✅ Используется |
| Tooltip | `tooltip.tsx` | 📦 Доступен |

---

## 12. Расширение библиотеки

При добавлении новых компонентов:

1. **Новый shadcn-примитив**: `npx shadcn@latest add <component>` → появится в `components/ui/`
2. **Новый domain-компонент**: создавай в `components/<domain>/` (пример: `components/leads/`, `components/jobs/`)
3. **Новый токен цвета**: добавь в `:root` и `.dark` в `styles/theme.css`, затем в `@theme inline` в `styles/tailwind.css`
4. **Обнови этот документ** при добавлении нового паттерна или компонента
