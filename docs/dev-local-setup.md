# Dev Local Setup — Blanc Contact Center

Инструкция для запуска локального окружения без авторизации (Keycloak).

---

## Быстрый старт

```bash
cd /Users/rgareev91/contact_center/twilio-front-integration
npm run dev:local
```

Открыть: **http://localhost:3001**

---

## Чеклист перед запуском

Выполни по порядку, если что-то не работает.

### 1. Отключить авторизацию в `.env.development`

```
FEATURE_AUTH_ENABLED=false
VITE_FEATURE_AUTH_ENABLED=false
```

Файл: `twilio-front-integration/.env.development` (строки 51 и 58)

### 2. Отключить авторизацию в `frontend/.env`

```
VITE_FEATURE_AUTH_ENABLED=false
```

Файл: `twilio-front-integration/frontend/.env` (строка 1)

> **Важно:** этот файл перекрывает корневой `.env` для Vite. Если здесь `true` — авторизация будет требоваться даже при `false` в корне.

### 3. Проверить dev mock-контекст в AuthProvider

Файл: `frontend/src/auth/AuthProvider.tsx`

В блоке `if (!FEATURE_AUTH)` должны быть выставлены все permissions:

```ts
setPermissions([
    'tenant.company.view', 'tenant.company.manage',
    'tenant.users.view', 'tenant.users.manage',
    'tenant.roles.view', 'tenant.roles.manage',
    'tenant.integrations.manage', 'tenant.telephony.manage',
    'dashboard.view', 'pulse.view',
    'messages.view_internal', 'messages.view_client', 'messages.send',
    'contacts.view', 'contacts.edit',
    'leads.view', 'leads.create', 'leads.edit', 'leads.convert',
    'jobs.view', 'jobs.create', 'jobs.edit', 'jobs.assign',
    'jobs.close', 'jobs.done_pending_approval',
    'schedule.view', 'schedule.dispatch',
    'financial_data.view',
    'estimates.view', 'estimates.create', 'estimates.send',
    'invoices.view', 'invoices.create', 'invoices.send',
    'payments.view', 'payments.collect_online', 'payments.collect_offline', 'payments.refund',
    'reports.dashboard.view', 'reports.jobs.view', 'reports.leads.view',
    'reports.calls.view', 'reports.payments.view', 'reports.financial.view',
    'client_job_history.view',
    'provider.enabled', 'phone_calls.use', 'call_masking.use',
    'gps_tracking.view', 'gps_tracking.collect',
]);
setScopes({ job_visibility: 'all', financial_scope: 'full', dashboard_scope: 'all_widgets', report_scope: 'all', job_close_scope: 'close_allowed' });
```

Если permissions неполные — разделы будут заблокированы `ProtectedRoute` с «Access Denied».

### 4. Проверить dev company в БД

```bash
node -e "
const db = require('./backend/src/db/connection');
db.query(\"SELECT id, name FROM companies WHERE id = '00000000-0000-0000-0000-000000000001'\")
  .then(r => { console.log(r.rows[0] || 'NOT FOUND'); db.end(); })
  .catch(e => { console.error(e.message); db.end(); });
"
```

Ожидаемый результат: `{ id: '00000000-0000-0000-0000-000000000001', name: 'Boston Masters' }`

---

## Адреса после запуска

| Сервис | URL |
|--------|-----|
| Frontend | http://localhost:3001 |
| Backend API | http://localhost:3000 |
| Ngrok (webhooks) | https://\<случайный>.ngrok-free.dev |
| Ngrok dashboard | http://localhost:4040 |

---

## Диагностика проблем

### Требует авторизацию при открытии

1. Проверь `frontend/.env` — там должно быть `VITE_FEATURE_AUTH_ENABLED=false`
2. Перезапусти Vite: `lsof -ti:3001 | xargs kill -9 && cd frontend && npx vite --host --port 3001`

### Разделы недоступны («Access Denied»)

Причина: `AuthProvider.tsx` выдаёт неполный список permissions в dev-режиме.
Решение: см. пункт 3 чеклиста выше.

### Backend возвращает 401/403

Проверь `.env` (не `.env.development`):

```bash
grep FEATURE_AUTH .env
```

Оба должны быть `false`. Если нет — скрипт `dev-start.sh` скопировал старую версию. Перезапусти `npm run dev:local`.

### Ngrok не стартует

```bash
pkill -f "ngrok http"
npm run dev:local
```

### Перезапустить только фронтенд (без ngrok и бэкенда)

```bash
lsof -ti:3001 | xargs kill -9
cd /Users/rgareev91/contact_center/twilio-front-integration/frontend
npx vite --host --port 3001
```

### Перезапустить только бэкенд

```bash
lsof -ti:3000 | xargs kill -9
cd /Users/rgareev91/contact_center/twilio-front-integration
node src/server.js
```

---

## Как работает bypass авторизации

**Backend** (`backend/src/middleware/keycloakAuth.js`):
При `FEATURE_AUTH_ENABLED=false` middleware `authenticate` инжектирует dev-пользователя:
```js
req.user = { sub: 'dev-user', email: 'dev@localhost', roles: ['company_admin'],
             company_id: '00000000-0000-0000-0000-000000000001', _devMode: true }
```
Все последующие middleware (`requireCompanyAccess`, `requirePermission`, `requireRole`) пропускают запрос если `req.user._devMode === true`.

**Frontend** (`frontend/src/auth/AuthProvider.tsx`):
При `VITE_FEATURE_AUTH_ENABLED=false` провайдер сразу устанавливает `authenticated=true` и полный набор permissions без обращения к Keycloak.

---

## Правила (из agent-orchestrator.md)

- `frontend/.env` **не в git** (gitignore) — изменения только локально
- Dev `.env` не деплоится в prod — `prod-deploy.sh` использует отдельные настройки
- При создании нового worktree — проверить и адаптировать оба файла `.env`
