# Требования — Blanc Contact Center

## Статус фич

| ID | Фича | Статус | Расположение |
|---|---|---|---|
| F001 | Pulse (Timeline + SMS + Call Log) | ✅ Реализована | `frontend/src/pages/Pulse/`, `src/routes/`, `backend/` |
| F002 | Softphone (Twilio Device SDK) | ✅ Реализована | `frontend/src/components/SoftPhone/`, `src/routes/voice.js` |
| F003 | Contacts (Master List + Detail) | ✅ Реализована | `frontend/src/pages/Contacts/`, `src/routes/contacts.js` |
| F004 | Leads (Фильтры + Таблица + Detail) | ✅ Реализована | `frontend/src/pages/Leads/`, `src/routes/leads.js` |
| F005 | Jobs (Zenbooker + Таблица + Detail) | ✅ Реализована | `frontend/src/pages/Jobs/`, `src/routes/jobs.js` |
| F006 | Real-time (SSE + WebSocket) | ✅ Реализована | `src/server.js` (SSE), `frontend/src/hooks/useRealtimeEvents.ts` |
| F007 | Twilio-Front интеграция (Channel API) | ✅ Реализована | `src/routes/webhooks.js`, `src/services/frontAPI.js` |
| F008 | Zenbooker интеграция | ✅ Реализована | `src/routes/zenbooker.js`, Zenbooker webhooks |
| F009 | Action Required / Snooze система | ✅ Реализована | `frontend/src/components/Pulse/`, `backend/src/` |
| F010 | AI функции (Summary, Polish, Transcript) | ✅ Реализована | `backend/src/`, Gemini API |

---

## Подробные требования

> Подробное описание текущего функционала см. в `docs/current_functionality.md`

### F001: Pulse
- Трёхколоночный layout: список контактов → карточка → хронология
- Server-side поиск по номеру, infinite scroll
- Объединённая хронология звонков + SMS
- Аудиоплеер с записями, транскрипция, AI-summary
- SMS форма с Quick Messages, AI Polish, вложения
- Real-time через SSE: onCallUpdate, onMessageAdded, etc.

### F002: Softphone
- VoIP на базе Twilio Device SDK
- Состояния: Idle → Incoming → Connecting → Ringing → Connected → Ended
- Caller ID picker, поиск контактов, pre-flight busy check
- Minimize в header, DTMF keypad, Mute/Unmute
- ClickToCallButton интеграция

### F003: Contacts
- Master list с поиском и pagination
- Детальная панель: контактная информация, адреса (geocoding), лиды, jobs
- Edit Contact dialog
- Zenbooker sync

### F004: Leads
- Фильтры: текст, дата, статус, источник, тип
- Таблица с настраиваемыми колонками
- Детальная панель: header, actions, metadata
- Create Lead dialog (многоступенчатая форма)
- Convert to Job (4-step wizard → Zenbooker)

### F005: Jobs
- Фильтры: текст, дата, статус, провайдер, источник, тип, теги
- Таблица с сортировкой, pagination, CSV export
- Двухколоночная детальная панель
- Action Bar: Mark Enroute/In Progress/Complete/Cancel
- Notes секция

---

## Общие паттерны

- **Аутентификация:** authedFetch + auth headers
- **Real-time:** SSE через useRealtimeEvents hook
- **UI:** Shadcn/ui, Lucide React icons
- **Timezone:** America/New_York
- **Data fetching:** React Query (Pulse), прямые fetch (остальные)
- **Toasts:** sonner
