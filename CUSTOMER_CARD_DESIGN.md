# 📐 Полное описание верстки и дизайна CustomerCard

## 🏗️ Структура компонента

```
Card (контейнер)
├── Header Section (синий градиент)
│   ├── Left Group
│   │   ├── Avatar (круглая иконка)
│   │   └── Info Block
│   │       ├── Name (заголовок)
│   │       └── Phone (с иконкой)
│   └── Stats Badge (количество звонков)
│
└── Details Section (белый фон)
    └── Grid (1 колонка mobile, 2 колонки desktop)
        ├── Email
        ├── Total Jobs
        ├── Address (занимает 2 колонки)
        ├── Customer Since
        └── Stripe Customer
```

---

## 1️⃣ Card Контейнер

### Стили:
```css
overflow: hidden;
border: 1px solid #e5e7eb; /* border-gray-200 */
border-radius: 0.5rem; /* 8px */
box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 
            0 4px 6px -2px rgba(0, 0, 0, 0.05); /* shadow-lg */
```

| Свойство | Значение | Описание |
|----------|----------|----------|
| `overflow` | `hidden` | Скрывает выступающие элементы |
| `border` | `1px solid #e5e7eb` | Светло-серая граница |
| `border-radius` | `8px` | Скруглённые углы |
| `box-shadow` | Large shadow | Крупная тень |

---

## 2️⃣ Header Section (Градиентная секция)

### Контейнер:
```css
background: linear-gradient(to right, #2563eb, #1d4ed8);
padding: 24px; /* p-6 */
color: white;
```

### Layout:
```css
display: flex;
align-items: flex-start;
justify-content: space-between;
```

---

### 2.1 Avatar (Аватар)

```
┌─────────────┐
│             │
│   👤 User   │  64x64px
│             │
└─────────────┘
```

#### Стили:
```css
width: 64px;          /* w-16 */
height: 64px;         /* h-16 */
border-radius: 9999px; /* rounded-full (круг) */
background: rgba(255, 255, 255, 0.2); /* bg-white/20 */
backdrop-filter: blur(4px); /* backdrop-blur-sm */
display: flex;
align-items: center;
justify-content: center;
flex-shrink: 0;
```

#### Иконка внутри:
```css
width: 32px;   /* w-8 */
height: 32px;  /* h-8 */
color: white;
```

---

### 2.2 Customer Name and Phone

#### Name (Имя):
```css
font-size: 24px;      /* text-2xl */
font-weight: 700;     /* font-bold */
line-height: 32px;
margin-bottom: 4px;   /* mb-1 */
color: white;
```

#### Phone Container:
```css
display: flex;
align-items: center;
gap: 8px;             /* gap-2 */
color: #dbeafe;       /* text-blue-100 */
```

#### Phone Icon:
```css
width: 16px;          /* w-4 */
height: 16px;         /* h-4 */
```

#### Phone Number:
```css
font-family: ui-monospace, monospace; /* font-mono */
font-size: 14px;      /* text-sm */
color: #dbeafe;       /* text-blue-100 */
```

Формат: `+1 (508) 290-4442`

---

### 2.3 Stats Badge (Бейдж звонков)

```
┌─────────┐
│    9    │  Число крупно
│  Calls  │  Подпись мелко
└─────────┘
```

#### Стили контейнера:
```css
background: rgba(255, 255, 255, 0.2); /* bg-white/20 */
backdrop-filter: blur(4px); /* backdrop-blur-sm */
border-radius: 8px;   /* rounded-lg */
padding: 8px 16px;    /* px-4 py-2 */
text-align: center;
flex-shrink: 0;
```

#### Number (число):
```css
font-size: 24px;      /* text-2xl */
font-weight: 700;     /* font-bold */
color: white;
```

#### Label (подпись):
```css
font-size: 12px;      /* text-xs */
color: #dbeafe;       /* text-blue-100*/
```

---

## 3️⃣ Details Section (Белая секция)

### Контейнер:
```css
padding: 24px;        /* p-6 */
background: white;
```

### Grid Layout:
```css
display: grid;
grid-template-columns: 1fr;           /* Mobile: 1 колонка */
gap: 16px;                            /* gap-4 */

/* Desktop (768px+) */
@media (min-width: 768px) {
  grid-template-columns: 1fr 1fr;     /* Desktop: 2 колонки */
}
```

---

### 3.1 Info Item (Общий паттерн для всех полей)

```
┌────────────────────────────────────┐
│ [📧]  Email                        │
│       help@bostonmasters.com       │
└────────────────────────────────────┘
```

#### Структура:
```css
display: flex;
align-items: flex-start;
gap: 12px;            /* gap-3 */
```

#### Icon Container (Контейнер иконки):
```css
width: 40px;          /* w-10 */
height: 40px;         /* h-10 */
border-radius: 8px;   /* rounded-lg */
background: #f3f4f6;  /* bg-gray-100 */
display: flex;
align-items: center;
justify-content: center;
flex-shrink: 0;
```

#### Icon:
```css
width: 20px;          /* w-5 */
height: 20px;         /* h-5 */
color: #4b5563;       /* text-gray-600 */
```

#### Content Container:
```css
flex: 1;
min-width: 0;         /* Для text overflow */
```

#### Label (Заголовок):
```css
font-size: 12px;      /* text-xs */
color: #6b7280;       /* text-gray-500 */
margin-bottom: 2px;   /* mb-0.5 */
```

#### Value (Значение):
```css
font-size: 14px;      /* text-sm */
color: #111827;       /* text-gray-900 */
```

---

### 3.2 Специфичные поля

#### Email (с hover):
```css
/* Ссылка */
color: #111827;                    /* text-gray-900 */
transition: color 0.2s;            /* transition-colors */
word-break: break-word;            /* break-words */

/* Hover */
&:hover {
  color: #2563eb;                  /* hover:text-blue-600 */
}
```

#### Total Jobs (с font-semibold):
```css
font-weight: 600;                  /* font-semibold */
```

#### Address (занимает 2 колонки):
```css
/* На desktop */
@media (min-width: 768px) {
  grid-column: span 2;             /* md:col-span-2 */
}
```

#### Stripe Customer ID (код):
```css
font-size: 12px;                   /* text-xs */
color: #374151;                    /* text-gray-700 */
background: #f9fafb;               /* bg-gray-50 */
padding: 4px 8px;                  /* px-2 py-1 */
border-radius: 4px;                /* rounded */
word-break: break-all;             /* break-all */
font-family: ui-monospace, monospace;
```

---

## 4️⃣ Точные размеры и отступы

### Header Section:
```
┌──────────────────────────────────────────────────┐
│  24px padding                                    │
│  ┌────┐  16px   ┌──────────┐        ┌──────┐   │
│  │ 64 │  gap    │   Name   │        │Badge │   │
│  │ px │         │  Phone   │        │      │   │
│  └────┘         └──────────┘        └──────┘   │
│  24px padding                                    │
└──────────────────────────────────────────────────┘
```

### Details Grid:
```
┌──────────────────────────────────────────────────┐
│  24px padding                                    │
│  ┌──────────────┐  16px gap  ┌──────────────┐   │
│  │ Email        │             │ Jobs         │   │
│  └──────────────┘             └──────────────┘   │
│  16px gap                                        │
│  ┌────────────────────────────────────────────┐  │
│  │ Address (spans 2 columns)                  │  │
│  └────────────────────────────────────────────┘  │
│  16px gap                                        │
│  ┌──────────────┐             ┌──────────────┐  │
│  │ Customer     │             │ Stripe       │  │
│  │ Since        │             │ Customer     │  │
│  └──────────────┘             └──────────────┘  │
│  24px padding                                    │
└──────────────────────────────────────────────────┘
```

---

## 5️⃣ Цветовая палитра

### Header (Gradient):
```javascript
{
  gradient: {
    from: '#2563eb',    // blue-600
    to: '#1d4ed8'       // blue-700
  },
  text: {
    primary: '#ffffff', // white
    secondary: '#dbeafe' // blue-100
  },
  overlay: 'rgba(255, 255, 255, 0.2)' // white/20
}
```

### Details Section:
```javascript
{
  background: '#ffffff',  // white
  iconBox: '#f3f4f6',     // gray-100
  icon: '#4b5563',        // gray-600
  label: '#6b7280',       // gray-500
  value: '#111827',       // gray-900
  link: {
    default: '#111827',   // gray-900
    hover: '#2563eb'      // blue-600
  },
  codeBackground: '#f9fafb', // gray-50
  codeText: '#374151'     // gray-700
}
```

### Borders & Shadows:
```javascript
{
  cardBorder: '#e5e7eb',  // gray-200
  shadow: {
    color: 'rgba(0, 0, 0, 0.1)',
    offset: '0 10px 15px -3px'
  }
}
```

---

## 6️⃣ Типографика

### Header:
| Элемент | Size | Weight | Color | Family |
|---------|------|--------|-------|--------|
| Name | 24px | 700 | white | Default |
| Phone | 14px | 400 | #dbeafe | Monospace |
| Badge Number | 24px | 700 | white | Default |
| Badge Label | 12px | 400 | #dbeafe | Default |

### Details:
| Элемент | Size | Weight | Color | Family |
|---------|------|--------|-------|--------|
| Label | 12px | 400 | #6b7280 | Default |
| Value | 14px | 400 | #111827 | Default |
| Jobs Value | 14px | 600 | #111827 | Default |
| Code | 12px | 400 | #374151 | Monospace |

---

## 7️⃣ Spacing System

### Padding:
- Header: `24px` (p-6)
- Details: `24px` (p-6)
- Icon box: `10px` (implied from w-10 h-10)
- Code: `4px 8px` (px-2 py-1)
- Badge: `8px 16px` (px-4 py-2)

### Gap:
- Header left group: `16px` (gap-4)
- Phone icon+text: `8px` (gap-2)
- Info items: `12px` (gap-3)
- Grid: `16px` (gap-4)

### Margin:
- Name bottom: `4px` (mb-1)
- Label bottom: `2px` (mb-0.5)

---

## 8️⃣ Border Radius

| Элемент | Radius | Pixels |
|---------|--------|--------|
| Card | `rounded` | 8px |
| Avatar | `rounded-full` | 9999px (круг) |
| Badge | `rounded-lg` | 8px |
| Icon box | `rounded-lg` | 8px |
| Code | `rounded` | 4px |

---

## 9️⃣ Responsive Behavior

### Mobile (< 768px):
```css
.details-grid {
  grid-template-columns: 1fr; /* Одна колонка */
}

.address {
  grid-column: span 1; /* Занимает всю ширину */
}
```

### Desktop (≥ 768px):
```css
.details-grid {
  grid-template-columns: 1fr 1fr; /* Две колонки */
}

.address {
  grid-column: span 2; /* Занимает обе колонки */
}
```

---

## 🔟 Иконки (Lucide React)

### Используемые иконки:
```javascript
{
  avatar: 'User',           // 32x32px, white
  phone: 'Phone',           // 16x16px, blue-100
  email: 'Mail',            // 20x20px, gray-600
  jobs: 'Briefcase',        // 20x20px, gray-600
  address: 'MapPin',        // 20x20px, gray-600
  date: 'Calendar',         // 20x20px, gray-600
  stripe: '$' (text)        // 12px, bold, gray-600
}
```

### Установка:
```bash
npm install lucide-react
```

---

## 1️⃣1️⃣ Эффекты

### Backdrop Blur (Размытие фона):
```css
backdrop-filter: blur(4px);
```
Применяется к:
- Avatar container
- Stats badge

### Transitions:
```css
transition: color 200ms;
```
Применяется к:
- Email link (hover)

### Shadows:
```css
/* Card shadow */
box-shadow: 
  0 10px 15px -3px rgba(0, 0, 0, 0.1),
  0 4px 6px -2px rgba(0, 0, 0, 0.05);
```

---

## 1️⃣2️⃣ Условная видимость

### Показываются только если данные есть:
- Stats Badge: `if (callCount !== undefined)`
- Email: `if (customer.email)`
- Jobs: `if (customer.jobs.length > 0)`
- Address: `if (defaultAddress)`
- Stripe: `if (customer.stripe_customer_id)`

### Customer Since:
Всегда показывается

---

## 1️⃣3️⃣ Text Overflow

### Email и Stripe ID:
```css
min-width: 0;           /* Позволяет flex item сжиматься */
word-break: break-word; /* Email */
word-break: break-all;  /* Stripe ID */
```

---

## 1️⃣4️⃣ Measurements Chart

```
Element Sizes:
├── Card border: 1px
├── Card radius: 8px
├─�� Header padding: 24px
├── Avatar: 64x64px
├── Avatar icon: 32x32px
├── Avatar radius: ∞ (circle)
├── Name: 24px
├── Phone icon: 16x16px
├── Phone text: 14px
├── Badge: padding 8x16px
├── Badge number: 24px
├── Badge label: 12px
├── Details padding: 24px
├── Icon box: 40x40px
├── Icon box radius: 8px
├── Icon: 20x20px
├── Label: 12px
├── Value: 14px
└── Grid gap: 16px
```

---

## 1️⃣5️⃣ Полный CSS (эквивалент)

```css
/* Card */
.customer-card {
  overflow: hidden;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 
              0 4px 6px -2px rgba(0, 0, 0, 0.05);
}

/* Header */
.customer-header {
  background: linear-gradient(to right, #2563eb, #1d4ed8);
  padding: 24px;
  color: white;
}

.header-content {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.header-left {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

/* Avatar */
.avatar {
  width: 64px;
  height: 64px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.avatar-icon {
  width: 32px;
  height: 32px;
  color: white;
}

/* Name & Phone */
.customer-name {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 4px;
}

.phone-container {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #dbeafe;
}

.phone-icon {
  width: 16px;
  height: 16px;
}

.phone-number {
  font-family: ui-monospace, monospace;
  font-size: 14px;
}

/* Badge */
.stats-badge {
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(4px);
  border-radius: 8px;
  padding: 8px 16px;
  text-align: center;
  flex-shrink: 0;
}

.badge-number {
  font-size: 24px;
  font-weight: 700;
}

.badge-label {
  font-size: 12px;
  color: #dbeafe;
}

/* Details */
.customer-details {
  padding: 24px;
  background: white;
}

.details-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

@media (min-width: 768px) {
  .details-grid {
    grid-template-columns: 1fr 1fr;
  }
  
  .address-field {
    grid-column: span 2;
  }
}

/* Info Item */
.info-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.icon-box {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: #f3f4f6;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.icon {
  width: 20px;
  height: 20px;
  color: #4b5563;
}

.info-content {
  flex: 1;
  min-width: 0;
}

.info-label {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 2px;
}

.info-value {
  font-size: 14px;
  color: #111827;
}

.info-value.semibold {
  font-weight: 600;
}

/* Email Link */
.email-link {
  color: #111827;
  transition: color 0.2s;
  word-break: break-word;
  text-decoration: none;
}

.email-link:hover {
  color: #2563eb;
}

/* Code */
.stripe-code {
  font-size: 12px;
  color: #374151;
  background: #f9fafb;
  padding: 4px 8px;
  border-radius: 4px;
  word-break: break-all;
  font-family: ui-monospace, monospace;
}
```

---

## 1️⃣6️⃣ Полный React компонент

```tsx
import { User, Phone, Mail, MapPin, Briefcase, Calendar } from 'lucide-react';
import { Card } from './ui/card';

interface CustomerCardProps {
  customer: {
    name: string;
    phone: string;
    email: string | null;
    addresses: Array<{
      formatted: string;
      is_default_address_for_customer: boolean;
    }>;
    jobs: string[];
    stripe_customer_id: string | null;
    created: string;
  };
  callCount?: number;
}

export function CustomerCard({ customer, callCount }: CustomerCardProps) {
  const defaultAddress = customer.addresses.find(
    addr => addr.is_default_address_for_customer
  ) || customer.addresses[0];
  
  const customerSince = new Date(customer.created);

  const formatPhoneNumber = (phone: string) => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
      return `+1 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
    } else if (cleaned.length === 11 && cleaned[0] === '1') {
      return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }
    return phone;
  };

  return (
    <Card className="overflow-hidden border border-gray-200 shadow-lg">
      {/* Header Section */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 p-6 text-white">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            {/* Avatar */}
            <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center shrink-0">
              <User className="w-8 h-8 text-white" />
            </div>
            
            {/* Customer Name and Primary Info */}
            <div className="flex-1">
              <h2 className="text-2xl font-bold mb-1">{customer.name}</h2>
              <div className="flex items-center gap-2 text-blue-100">
                <Phone className="w-4 h-4" />
                <span className="font-mono text-sm">
                  {formatPhoneNumber(customer.phone)}
                </span>
              </div>
            </div>
          </div>

          {/* Stats Badge */}
          {callCount !== undefined && (
            <div className="bg-white/20 backdrop-blur-sm rounded-lg px-4 py-2 text-center shrink-0">
              <div className="text-2xl font-bold">{callCount}</div>
              <div className="text-xs text-blue-100">
                Call{callCount !== 1 ? 's' : ''}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Details Section */}
      <div className="p-6 bg-white">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Email */}
          {customer.email && (
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <Mail className="w-5 h-5 text-gray-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-0.5">Email</div>
                <a 
                  href={`mailto:${customer.email}`} 
                  className="text-sm text-gray-900 hover:text-blue-600 transition-colors break-words"
                >
                  {customer.email}
                </a>
              </div>
            </div>
          )}

          {/* Jobs Count */}
          {customer.jobs.length > 0 && (
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <Briefcase className="w-5 h-5 text-gray-600" />
              </div>
              <div className="flex-1">
                <div className="text-xs text-gray-500 mb-0.5">Total Jobs</div>
                <div className="text-sm font-semibold text-gray-900">
                  {customer.jobs.length} {customer.jobs.length === 1 ? 'Job' : 'Jobs'}
                </div>
              </div>
            </div>
          )}

          {/* Address */}
          {defaultAddress && (
            <div className="flex items-start gap-3 md:col-span-2">
              <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <MapPin className="w-5 h-5 text-gray-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-0.5">Address</div>
                <div className="text-sm text-gray-900">
                  {defaultAddress.formatted}
                </div>
              </div>
            </div>
          )}

          {/* Customer Since */}
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
              <Calendar className="w-5 h-5 text-gray-600" />
            </div>
            <div className="flex-1">
              <div className="text-xs text-gray-500 mb-0.5">Customer Since</div>
              <div className="text-sm text-gray-900">
                {customerSince.toLocaleDateString('en-US', { 
                  month: 'short', 
                  day: 'numeric', 
                  year: 'numeric' 
                })}
              </div>
            </div>
          </div>

          {/* Stripe Customer */}
          {customer.stripe_customer_id && (
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <div className="text-xs font-bold text-gray-600">$</div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-0.5">Stripe Customer</div>
                <code className="text-xs text-gray-700 bg-gray-50 px-2 py-1 rounded break-all">
                  {customer.stripe_customer_id}
                </code>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
```

---

Готово! Полное описание для точного воспроизведения дизайна. 🎯
