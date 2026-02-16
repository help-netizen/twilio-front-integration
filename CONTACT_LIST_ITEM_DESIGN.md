---
component: Contact List Item
type: Interactive List Element
framework: React + Tailwind CSS
date: 2026-02-16
version: 1.0.0
---

# 📋 Contact List Item - Design Specification

## 🎯 Overview

Компонент для отображения контакта/лида в боковом списке с поддержкой активного состояния, hover эффектов и адаптивного отображения информации.

---

## 📐 Structure

```
button (container)
├── Primary Line (flex row)
│   ├── Name/Company/Phone (left, flex-grow)
│   └── Call Count Badge (right)
├── Secondary Line (conditional)
│   └── Phone Number (monospace)
└── Metadata Line (flex row)
    ├── Time Ago
    ├── Separator (•)
    └── Full DateTime
```

---

## 🎨 Visual States

### State Map
```yaml
states:
  default:
    background: transparent
    border: transparent
    cursor: pointer
  
  hover:
    background: '#f9fafb' # gray-50
    transition: colors 150ms
  
  active:
    background: '#eff6ff' # blue-50
    border: none
  
  focus:
    outline: none
    ring: '2px solid #3b82f6' # blue-500
```

---

## 📏 Dimensions & Spacing

```yaml
dimensions:
  width: 100% (full width of container)
  padding:
    horizontal: 16px  # px-4
    vertical: 12px    # py-3
  
spacing:
  between_lines: 4px     # mb-1
  badge_left_margin: 8px # ml-2
  metadata_gap: 4px      # gap-1
```

---

## 🔤 Typography

### Font Specifications

```yaml
typography:
  primary_text:
    element: Company/Name/Phone
    size: 14px          # text-sm
    weight: 500         # font-medium
    color: '#111827'    # text-gray-900
    line_height: 20px
  
  call_count_badge:
    size: 12px          # text-xs
    weight: 400         # normal
    color: '#6b7280'    # text-gray-500
    format: '({count})'
  
  phone_number:
    size: 12px          # text-xs
    weight: 400
    color: '#4b5563'    # text-gray-600
    font_family: monospace  # font-mono
    line_height: 16px
  
  metadata:
    size: 12px          # text-xs
    weight: 400
    color: '#6b7280'    # text-gray-500
    separator_color: '#9ca3af' # text-gray-400
```

---

## 🏗️ Component Structure (HTML/JSX)

```jsx
<button
  onClick={handleSelect}
  className="w-full text-left px-4 py-3 transition-colors
    [STATE_CLASS: bg-blue-50 | hover:bg-gray-50]"
>
  {/* Row 1: Primary Information */}
  <div className="flex items-baseline justify-between mb-1">
    <span className="text-sm font-medium text-gray-900">
      {company || name || phone}
    </span>
    <span className="text-xs text-gray-500 ml-2">
      ({callCount})
    </span>
  </div>
  
  {/* Row 2: Secondary Phone (Conditional) */}
  {(company || name) && (
    <div className="text-xs text-gray-600 mb-1 font-mono">
      {phone}
    </div>
  )}
  
  {/* Row 3: Metadata */}
  <div className="flex items-center gap-1 text-xs text-gray-500">
    <span>{timeAgo}</span>
    <span className="text-gray-400">•</span>
    <span>{fullDateTime}</span>
  </div>
</button>
```

---

## 🎭 Display Logic

### Priority System

```yaml
display_priority:
  primary_text:
    priority_1: company    # если есть компания
    priority_2: name       # если нет компании, показать имя
    priority_3: phone      # если ничего нет, показать телефон
  
  secondary_line:
    show_if: company OR name exists
    content: phone_number
    hide_if: phone is primary text
```

### Example Variants

#### Variant A: Company + Phone
```
ABC LLC                           (70)
+1 (508) 514-0320
4h ago • Feb 15, 8:21 PM
```

#### Variant B: Name + Phone
```
Nur Ibragimov                     (6)
+1 (617) 620-4519
2h ago • Feb 15, 10:36 PM
```

#### Variant C: Phone Only
```
+1 (617) 555-1234                 (3)
5h ago • Feb 15, 7:00 PM
```

---

## ⏰ Time Formatting Logic

### Time Ago Function

```typescript
function getTimeAgo(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric' 
  });
}
```

### Full DateTime Format

```typescript
const fullDateTime = date.toLocaleDateString('en-US', {
  month: 'short',
  day: 'numeric'
}) + ', ' + date.toLocaleTimeString('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});
// Output: "Feb 15, 8:21 PM"
```

---

## 🎨 Color Palette

```yaml
colors:
  backgrounds:
    default: 'transparent'
    hover: '#f9fafb'      # gray-50
    active: '#eff6ff'     # blue-50
  
  text:
    primary: '#111827'    # gray-900
    secondary: '#4b5563'  # gray-600
    muted: '#6b7280'      # gray-500
    separator: '#9ca3af'  # gray-400
  
  borders:
    none: 'transparent'
```

---

## 📱 Responsive Behavior

```yaml
responsive:
  mobile:
    width: 100%
    padding: 12px 16px
    font_size: same as desktop
  
  tablet:
    width: 100%
    padding: 12px 16px
  
  desktop:
    width: 100%
    padding: 12px 16px
  
  notes: |
    Component maintains same size across all breakpoints
    since it's contained within fixed-width sidebar (320px)
```

---

## ♿ Accessibility

```yaml
accessibility:
  role: button
  keyboard:
    - key: Tab
      action: Focus next/previous item
    - key: Enter
      action: Select contact
    - key: Space
      action: Select contact
  
  screen_reader:
    label: "{name/company/phone} - {callCount} calls - Last call {timeInfo}"
  
  focus_visible:
    outline: 2px solid blue-500
    outline_offset: 2px
```

---

## 🔧 Implementation (Tailwind CSS)

### Full Class List

```yaml
classes:
  container:
    - w-full              # 100% width
    - text-left           # left align text
    - px-4                # 16px horizontal padding
    - py-3                # 12px vertical padding
    - transition-colors   # smooth color transitions
    - bg-blue-50          # active state (conditional)
    - hover:bg-gray-50    # hover state
  
  primary_line:
    - flex
    - items-baseline
    - justify-between
    - mb-1
  
  primary_text:
    - text-sm
    - font-medium
    - text-gray-900
  
  badge:
    - text-xs
    - text-gray-500
    - ml-2
  
  phone_line:
    - text-xs
    - text-gray-600
    - mb-1
    - font-mono
  
  metadata_line:
    - flex
    - items-center
    - gap-1
    - text-xs
    - text-gray-500
  
  separator:
    - text-gray-400
```

---

## 📦 Data Structure

```typescript
interface ContactItem {
  id: string;
  name: string | null;
  company: string | null;
  phone: string;
  callCount: number;
  lastCall: Date;
}
```

---

## 🎯 Usage Example

```tsx
import { useState } from 'react';

function ContactList({ contacts }: { contacts: ContactItem[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  
  const getTimeAgo = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  
  return (
    <div className="divide-y divide-gray-100">
      {contacts.map((contact) => (
        <button
          key={contact.id}
          onClick={() => setSelectedId(contact.id)}
          className={`w-full text-left px-4 py-3 transition-colors ${
            selectedId === contact.id ? 'bg-blue-50' : 'hover:bg-gray-50'
          }`}
        >
          {/* Primary Line */}
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-sm font-medium text-gray-900">
              {contact.company || contact.name || contact.phone}
            </span>
            <span className="text-xs text-gray-500 ml-2">
              ({contact.callCount})
            </span>
          </div>
          
          {/* Secondary Phone Line */}
          {(contact.company || contact.name) && (
            <div className="text-xs text-gray-600 mb-1 font-mono">
              {contact.phone}
            </div>
          )}
          
          {/* Metadata Line */}
          <div className="flex items-center gap-1 text-xs text-gray-500">
            <span>{getTimeAgo(contact.lastCall)}</span>
            <span className="text-gray-400">•</span>
            <span>
              {contact.lastCall.toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric' 
              })},{' '}
              {contact.lastCall.toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit', 
                hour12: true 
              })}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
```

---

## 📊 Measurement Chart

```
┌─────────────────────────────────────┐
│ 16px padding                        │
│ ┌─────────────────────────────────┐ │
│ │ ABC LLC              (70) ←─── Badge
│ │ +1 (508) 514-0320   ←────────── Phone (mono)
│ │ 4h ago • Feb 15, 8:21 PM ←───── Meta
│ └─────────────────────────────────┘ │
│ 12px padding                        │
└─────────────────────────────────────┘
    ↑                           ↑
    4px margin between lines    4px gap in meta
```

---

## 🐛 Edge Cases

```yaml
edge_cases:
  no_company_no_name:
    display: phone number as primary
    secondary_line: hide
  
  very_long_names:
    behavior: text wraps naturally
    no_truncation: true
  
  zero_calls:
    display: '(0)'
    style: same as normal
  
  future_dates:
    behavior: show as '0h ago' or handle gracefully
    validation: recommended on data layer
```

---

## 🔄 Variants & Extensions

### Possible Additions

```yaml
extensions:
  unread_indicator:
    position: left side
    style: blue dot (8px circle)
  
  status_badge:
    types: ['new', 'hot', 'vip']
    position: after name
  
  avatar_image:
    size: 40x40px
    position: left of text
  
  actions_menu:
    trigger: right click or three-dot icon
    items: ['Call', 'Message', 'Edit', 'Delete']
```

---

## 📝 Notes

- **Performance**: Use `React.memo()` if list has 100+ items
- **Virtualization**: Consider `react-virtual` for 1000+ items
- **Animation**: Keep transitions under 200ms for responsiveness
- **Testing**: Ensure keyboard navigation works correctly
- **Dark Mode**: Add dark mode color variants if needed

---

## ✅ Checklist для реализации

- [ ] Создать базовую структуру компонента
- [ ] Добавить все три строки (primary, phone, metadata)
- [ ] Реализовать логику приоритета отображения
- [ ] Добавить функцию `getTimeAgo()`
- [ ] Стилизовать все состояния (default, hover, active)
- [ ] Добавить transitions для плавности
- [ ] Проверить на разных данных (все 3 варианта)
- [ ] Добавить keyboard navigation
- [ ] Протестировать accessibility
- [ ] Оптимизировать производительность (если нужно)

---

**Готово для реализации!** 🚀
