# Спецификация проекта: Blanc Contact Center

## 1. Обзор системы

### 1.1 Назначение
Blanc Contact Center — CRM-платформа для управления клиентскими коммуникациями, лидами, заказами, платежами и telephony admin flows. Система объединяет Twilio, Front, Zenbooker, Google services и AI-процессы в единый операторский интерфейс.

### 1.2 Ключевые возможности
- **Pulse** — timeline звонков, SMS и финансовых событий (estimates/invoices), action required, live transcript, AI summary
- **Softphone** — встроенный VoIP на Twilio Device SDK
- **Contacts / Leads / Jobs** — CRM-слой для оператора; Lead и Job detail panels содержат вкладки Estimates & Invoices
- **Estimates & Invoices** — создание, отправка, конвертация Estimate→Invoice; привязка к Contact/Lead/Job; отображение в Pulse Timeline
- **Transactions / Payments** — запись платежей через `RecordPaymentDialog`; список транзакций в InvoiceDetailPanel
- **Messaging** — SMS conversations и related media flows
- **Schedule / Dispatch** — dispatcher calendar (Day/Week/Month) с фильтрами и reassignment
- **Payments / Settings / Users** — административный и операционный контур
- **Telephony Admin** — call flows, user groups, phone numbers, Vapi integration

### 1.3 Целевая аудитория
Операторы, тимлиды и администраторы контакт-центра.

## 2. Технологический стек

### 2.1 Backend
- Node.js 18+
- Express 5
- CommonJS
- PostgreSQL (`pg`)
- Jest

### 2.2 Frontend
- Vite
- React 19
- TypeScript
- React Router 7
- React Query
- Shadcn/ui
- Lucide React
- Twilio Voice SDK

### 2.3 Интеграции
- Twilio Voice SDK, SMS, Conversations API, webhooks
- Front Channel API и JWT auth
- Zenbooker Booking API, Contacts API, webhooks
- Google Places
- Google Gemini
- Vapi / voice-agent flows

### 2.4 Инфраструктура
- Fly.io
- Docker
- SSE для realtime updates
- WebSocket path через Twilio Device SDK

## 3. Архитектура

### 3.1 Фактическая схема

```text
[Twilio / Front / Zenbooker / Google / Gemini / Vapi]
                     ↕
          [src/server.js runtime shell]
             ↕ auth / routing / SSE / static
      [backend/src application modules] ↔ [PostgreSQL]
             ↕
       [backend/src/services/realtimeService]
             ↕
        [frontend/src React application]
```

### 3.2 Основные слои
- `src/` — runtime shell и legacy adapter layer
- `backend/src/` — основной backend приложения
- `frontend/src/` — основной UI
- `voice-agent/` — supporting voice-agent runtime/config layer

### 3.3 Real-time
- SSE endpoint `/events/calls`
- `backend/src/services/realtimeService.js` как broker
- `frontend/src/hooks/useRealtimeEvents.ts` как canonical frontend subscription hook

## 4. Развёртывание

### 4.1 Требования
- Node.js 18+
- PostgreSQL
- настроенные Twilio / Front / Zenbooker credentials

### 4.2 Runtime модель
- Root server запускается из `src/server.js`
- Frontend production build обслуживается через тот же runtime shell
- Background worker в текущем состоянии запускается из того же процесса

### 4.3 Команды

```bash
# Backend / full app
npm run dev

# Local combined dev flow
npm run dev:local

# Frontend production build
cd frontend && npm run build
```

### 4.4 Конфигурация
- `Dockerfile`
- `fly.toml`
- `voice-agent/config/*`

## 5. Интеграции

### 5.1 Twilio
- Voice calls
- recordings / transcripts
- SMS / Conversations
- webhook ingestion

### 5.2 Front
- Channel API
- JWT generation

### 5.3 Zenbooker
- contacts
- leads/jobs sync
- payments sync
- webhook processing

### 5.4 Google и AI
- Google Places для address flows
- Gemini для polish / summary / transcript-related flows
- Vapi и voice-agent для telephony AI scenarios

## 6. Документация проекта

- Фактическая архитектурная карта: `docs/architecture.md`
- Актуальные требования: `docs/requirements.md`
- Refactor audit: `docs/refactor-readiness-audit.md`
- Спецификации: `docs/specs/`
- Тест-кейсы: `docs/test-cases/`
- История изменений: `docs/changelog.md`
