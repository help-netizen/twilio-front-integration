# Спецификация: RF005 — Backend Communication Slices

**Дата:** 2026-03-24
**Статус:** Done
**Зависит от:** RF002 (done)

---

## Цель

Определить границы application / service / query boundaries для backend модулей.
Это документационный слайс — без изменения runtime-кода.

---

## Текущая архитектура

```
Route layer (33 files) → Service layer (32 files) → Query layer (db/*.js)
```

### Query layer (db/)

| Файл | LOC | Consumers |
|---|---|---|
| `queries.js` | 1107 | pulse, calls, conversations, contacts, leads, voice — **монолит** |
| `conversationsQueries.js` | 230 | messaging, pulse |
| `quickMessagesQueries.js` | ~40 | quick-messages |
| `connection.js` | ~30 | everywhere |

### Критические паттерны (нарушения)

1. **Route → DB direct** — 18+ маршрутов обращаются к `db.query()` напрямую, минуя service layer
2. **Monolithic queries.js** — 1107 строк покрывают calls, contacts, leads, voice, pulse
3. **Inline require()** — многие routes используют lazy `require()` внутри handler body

---

## Определённые Communication Slices

### Slice 1: Pulse (Timeline)
- **Routes:** `pulse.js`
- **Services:** `realtimeService.js`
- **Queries:** `queries.js` (getCallsByContactId, getCallRecording), `conversationsQueries.js` (getMessagesByContactId)
- **Boundary violations:** Direct db.query() for timeline/snooze/action-required operations

### Slice 2: Calls
- **Routes:** `calls.js`, `voice.js`, `twiml.js`
- **Services:** `callProcessor.js`, `callSummaryService.js`, `voiceService.js`, `mediaStreamServer.js`, `transcriptionService.js`, `realtimeTranscriptService.js`
- **Queries:** `queries.js` (getCalls, insertCall, updateCall, getCallRecording)
- **Boundary violations:** calls.js has 3+ inline require('../db/connection')

### Slice 3: Messaging (SMS/Conversations)
- **Routes:** `messaging.js`
- **Services:** `conversationsService.js`
- **Queries:** `conversationsQueries.js`
- **Boundary violations:** minimal — relatively clean separation

### Slice 4: Contacts
- **Routes:** `contacts.js`
- **Services:** `contactsService.js`, `contactDedupeService.js`, `contactAddressService.js`, `contactsSyncService.js`, `timelineMergeService.js`
- **Queries:** `queries.js` (contact-related queries)
- **Boundary violations:** contacts.js has inline require('../db/connection')

### Slice 5: Leads
- **Routes:** `leads.js`, `integrations-leads.js`
- **Services:** `leadsService.js`, `contactDedupeService.js`, `contactAddressService.js`
- **Queries:** `queries.js` (lead-related queries)
- **Boundary violations:** leads.js has 5+ inline require('../db/connection')

### Slice 6: Jobs / Zenbooker
- **Routes:** `jobs.js`, `zenbooker.js`, `integrations-zenbooker.js`
- **Services:** `jobsService.js`, `jobSyncService.js`, `zenbookerClient.js`, `zenbookerSyncService.js`, `reconcileService.js`
- **Queries:** через services (clean)
- **Boundary violations:** minimal

### Slice 7: Settings / Admin
- **Routes:** `lead-form-settings.js`, `job-tags-settings.js`, `jobs-list-fields-settings.js`, `notification-settings.js`, `phoneSettings.js`, `phoneNumbers.js`, `action-required-settings.js`, `quick-messages.js`, `callFlows.js`
- **Services:** none
- **Queries:** direct db.query() — все settings routes обращаются к DB напрямую
- **Boundary violations:** **all** — no service layer for settings

### Slice 8: Auth / Users
- **Routes:** `users.js`, `userGroups.js`, `sessions.js`
- **Services:** `userService.js`, `auditService.js`
- **Queries:** mixed (some direct db.query())
- **Boundary violations:** users.js has inline require('../db/connection')

---

## Целевая архитектура (для RF006+)

```
Route → Service → {feature}Queries → db/connection
```

### Delivery order для RF006

1. Extract `callsQueries.js` from `queries.js` (used by calls.js, voice.js, pulse.js)
2. Extract `contactsQueries.js` from `queries.js` (used by contacts.js)
3. Extract `leadsQueries.js` from `queries.js` (used by leads.js, integrations-leads.js)
4. Keep `conversationsQueries.js` as-is (already clean)
5. Keep `quickMessagesQueries.js` as-is (already clean)
6. Remaining `queries.js` → shared utilities only

---

## Метрики

- 33 route files
- 32 service files
- 4 query modules (1 monolith 1107 LOC)
- ~18 route files with direct db.query() calls → target: 0
