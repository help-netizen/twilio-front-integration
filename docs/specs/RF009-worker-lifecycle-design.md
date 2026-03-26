# Спецификация: RF009 — Worker Lifecycle Separation Design Plan

**Дата:** 2026-03-24
**Статус:** Done (design plan only — no code changes)
**Зависит от:** RF005 (done)

---

## Текущее состояние

Workers co-located с web server в `src/server.js` (272 LOC):

| Worker | Файл | Lifecycle | Start point |
|---|---|---|---|
| Inbox Worker | `inboxWorker.js` | polling loop via `startWorker()` | `server.js:254` |
| Snooze Scheduler | `snoozeScheduler.js` | `setInterval()` (periodic tick) | started by service import |
| Reconcile Stale | `reconcileStale.js` | manual/cron trigger | not auto-started |

### Проблемы
1. **Shared process** — worker failure can crash web server
2. **No graceful shutdown** — `setInterval` not cleaned on SIGTERM
3. **Memory pressure** — inbox polling adds GC pressure to web process

---

## Design Plan (для будущей реализации)

### Architecture: Separate worker entrypoint

```
src/server.js              → web only (routes + SSE)
src/worker.js  [NEW]       → workers only (inbox, snooze, reconcile)
```

### Step 1: Extract worker bootstrap
Create `src/worker.js` that:
- Requires `db/connection`
- Starts `inboxWorker.startWorker()`
- Starts `snoozeScheduler.start()`
- Registers SIGTERM handler for graceful shutdown

### Step 2: Add graceful shutdown
- `snoozeScheduler`: export `stop()` → `clearInterval()`
- `inboxWorker`: set `running = false` flag for polling loop exit
- `worker.js`: on SIGTERM call both `stop()` functions

### Step 3: Deployment
- Fly.io: add `[processes]` section to `fly.toml`:
  ```toml
  [processes]
  web = "node src/server.js"
  worker = "node src/worker.js"
  ```
- Scale: web=2, worker=1

### Protected zones — NOT CHANGED
- `src/server.js` will only have worker lines removed (254-258)
- SSE/realtime stays in web process (it's HTTP-bound)
- `backend/db/` unchanged

### Risks
- Worker needs same env vars as web
- If worker is down, inbox events queue up (existing behavior — just more visible)
- SSE events from worker actions would need shared Redis/pg_notify (future)

---

## Не требует немедленных действий

Этот design plan — документация для будущей фазы. Текущая архитектура работает стабильно на Fly.io single-process.
