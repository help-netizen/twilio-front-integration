# Спецификация проекта: Blanc Contact Center

## 1. Обзор системы

### 1.1 Назначение
Blanc Contact Center — CRM-платформа для управления клиентскими коммуникациями (звонки, SMS), лидами и заказами. Интегрирует Twilio (телефония), Front (канал коммуникаций) и Zenbooker (бронирование/заказы) в единый интерфейс оператора.

### 1.2 Ключевые возможности
- **Pulse** — рабочий экран оператора с timeline звонков и SMS, real-time обновлениями
- **Softphone** — встроенный VoIP телефон (Twilio Device SDK)
- **Contacts** — управление контактами с geocoding и Zenbooker sync
- **Leads** — управление лидами с фильтрацией, конвертация в заказы
- **Jobs** — управление заказами Zenbooker с нотами, тегами, CSV экспортом

### 1.3 Целевая аудитория
Операторы и менеджеры контакт-центра, обрабатывающие входящие/исходящие коммуникации.

## 2. Технологический стек

### 2.1 Backend
- Node.js 18+, Express 5, CommonJS
- PostgreSQL (pg)

### 2.2 Frontend
- Vite + React + TypeScript
- Shadcn/ui, Lucide React
- React Router v6, React Query
- sonner (toasts)

### 2.3 Интеграции
- Twilio (Voice SDK, SMS/Conversations API)
- Front (Channel API, JWT)
- Zenbooker (Booking, Contacts API)
- Google Places (Geocoding)
- Google Gemini (AI Summary, Polish)

### 2.4 Инфраструктура
- Fly.io (Docker)
- SSE (Server-Sent Events) для real-time

### 2.5 Тестирование
- Jest

## 3. Архитектура

> Подробная архитектура в `Docs/architecture.md`

### 3.1 Высокоуровневая схема
```
Twilio API ←→ Backend (Express) ←→ Frontend (React)
Front API  ←→       ↕                     ↕
Zenbooker  ←→   PostgreSQL         Twilio Device SDK
                     ↕
                SSE Events
```

### 3.2 Real-time
- SSE для обновлений: звонки, SMS, Action Required
- WebSocket (Twilio Device SDK) для VoIP

## 4. Развёртывание

### 4.1 Требования
- Node.js 18+
- PostgreSQL
- Twilio account + API credentials
- Front app + Application Channel
- Zenbooker account

### 4.2 Переменные окружения
См. `.env.example`

### 4.3 Шаги развёртывания
```bash
# Dev
npm run dev:local

# Production
npm run deploy:prod
```

### 4.4 Docker
- `Dockerfile` в корне проекта
- `fly.toml` конфигурация Fly.io

## 5. Интеграции

### 5.1 Twilio
- Voice: исходящие/входящие звонки, запись, транскрипция
- SMS: Conversations API, MMS вложения
- Webhooks: status callbacks, incoming calls

### 5.2 Front
- Channel API для синхронизации звонков/SMS
- JWT аутентификация

### 5.3 Zenbooker
- Booking API: CRUD заказов
- Contacts API: синхронизация контактов
- Webhooks: обновления статусов

### 5.4 Google Places
- Geocoding и автодополнение адресов

## 6. История изменений

См. `Docs/changelog.md`
