# Архитектура — Blanc Contact Center

## Обзор

Blanc Contact Center — интеграционный сервер и CRM-интерфейс для управления клиентскими коммуникациями (звонки, SMS), лидами и заказами.

```
[Twilio API] ←→ [Backend (Express)] ←→ [Frontend (React)]
[Front API]  ←→      ↕                       ↕
[Zenbooker]  ←→ [PostgreSQL]           [Twilio Device SDK]
                      ↕
                 [SSE Events]
```

---

## Backend

### Основной сервер (`src/server.js`)
- Express 5, CommonJS
- SSE infrastructure для real-time событий
- Middleware: CORS, JSON parsing, rate limiting, auth
- **PROTECTED — менять core middleware только с отдельной задачей**

### Routes (`src/routes/`)
| Route | Файл | Ответственность |
|---|---|---|
| `/api/pulse/*` | `pulse.js` | Timeline, contacts list, SMS |
| `/api/voice/*` | `voice.js` | Twilio Voice, call management |
| `/api/contacts/*` | `contacts.js` | CRUD контактов |
| `/api/leads/*` | `leads.js` | CRUD лидов |
| `/api/jobs/*` | `jobs.js` | CRUD заказов |
| `/api/settings/*` | `settings.js` | Настройки компании |
| `/webhooks/*` | `webhooks.js` | Twilio/Front webhooks |
| `/api/zenbooker/*` | `zenbooker.js` | Zenbooker интеграция |

### Services (`src/services/`)
| Сервис | Ответственность |
|---|---|
| `frontAPI.js` | Front Channel API клиент |
| `jwtService.js` | JWT генерация для Front |
| `callFormatter.js` | Форматирование Twilio → Front |

### Backend extended (`backend/`)
| Директория | Ответственность |
|---|---|
| `backend/src/` | Расширенные сервисы (AI, cron, sync) |
| `backend/db/` | PostgreSQL модели и миграции |
| `backend/cron/` | Cron задачи |
| `backend/scripts/` | Утилитные скрипты |

### Database (`backend/db/`)
- PostgreSQL через `pg`
- SQLite (`backend/database.sqlite3`) — legacy/dev
- **PROTECTED — менять schema только с отдельной задачей**

---

## Frontend

### Стек
- Vite + React + TypeScript
- Shadcn/ui (Button, Input, Badge, Dialog, DropdownMenu, Skeleton, etc.)
- Lucide React (иконки)
- React Router v6
- React Query (data fetching для Pulse)
- sonner (toast notifications)

### Pages (`frontend/src/pages/`)
| Page | URL | Описание |
|---|---|---|
| `Pulse/` | `/pulse`, `/pulse/timeline/:id` | Рабочий экран оператора |
| `Contacts/` | `/contacts`, `/contacts/:id` | Список контактов |
| `Leads/` | `/leads`, `/leads/:id` | Управление лидами |
| `Jobs/` | `/jobs` | Управление заказами |

### Ключевые компоненты (`frontend/src/components/`)
| Компонент | Ответственность |
|---|---|
| `SoftPhone/` | VoIP телефон (Twilio Device SDK) |
| `Pulse/` | Timeline, SMS, Call items |
| `Contacts/` | Contact list, detail panel |
| `Leads/` | Lead table, detail panel, create dialog |
| `Jobs/` | Jobs table, detail panel |
| `ui/` | Shadcn/ui компоненты |

### Hooks (`frontend/src/hooks/`)
| Hook | Ответственность |
|---|---|
| `useRealtimeEvents.ts` | SSE подписки (**PROTECTED**) |
| `usePulseContacts.ts` | React Query для Pulse |
| `useJobsActions.ts` | Действия с заказами |

### Lib (`frontend/src/lib/`)
| Модуль | Ответственность |
|---|---|
| `authedFetch.ts` | Auth wrapper для fetch (**PROTECTED**) |
| `utils.ts` | Общие утилиты |

---

## Интеграции

### Twilio
- **Voice SDK:** исходящие/входящие звонки, запись, транскрипция
- **SMS/Conversations API:** отправка/получение SMS, MMS
- **Webhooks:** status callbacks, incoming calls

### Front
- **Channel API:** синхронизация звонков и SMS как сообщений
- **JWT Auth:** генерация JWT для API вызовов

### Zenbooker
- **Booking API:** создание, обновление, отмена заказов
- **Contacts API:** синхронизация контактов
- **Webhooks:** обновления статусов заказов

### Google Places
- Geocoding и автодополнение адресов

---

## Деплой

- **Platform:** Fly.io
- **Container:** Docker (`Dockerfile`)
- **Config:** `fly.toml`
- **Environments:** `.env.development`, `.env.production`
- **Scripts:** `scripts/dev-start.sh`, `scripts/prod-deploy.sh`
