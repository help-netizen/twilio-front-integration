# Спецификация: F016 — VAPI AI Marketplace Integration + Call Flow Gating

## Общее описание

VAPI AI регистрируется как приложение в маркетплейсе Blanc (`/settings/integrations`).
Плитка ведёт на отдельную страницу `/settings/integrations/vapi-ai`, где пользователь
вводит API key, верифицирует подключение и настраивает SIP resource. После завершения
установки нода `vapi_agent` становится доступной в редакторе Call Flow для групп.

---

## Сценарии поведения

### Сценарий 1: Первичное подключение VAPI

- **Предусловия:** VAPI не подключён (нет active installation, нет active connection).
- **Шаги:**
  1. Пользователь открывает `/settings/integrations` → вкладка Marketplace.
  2. `fetchMarketplaceApps()` возвращает массив apps, среди которых `app_key: 'vapi-ai'` с `installation: null`.
  3. На плитке VAPI кнопка "Configure" (вместо generic "Enable").
  4. Клик → `navigate('/settings/integrations/vapi-ai')`.
  5. `VapiSettingsPage` монтируется: параллельно запускаются `GET /api/vapi/connections` и `GET /api/marketplace/apps` (или данные уже в React Query cache).
  6. Оба запроса вернули пустые/null результаты → страница показывает режим настройки.
  7. **Секция "API Connection":** поля API Key (input type=password), Display Name, Environment select (prod / dev).
  8. Нажать "Verify & Connect" → `POST /api/vapi/connections` `{ api_key, display_name, environment }`.
  9. Backend: валидирует ключ через `GET https://api.vapi.ai/assistant?limit=1`, при успехе вставляет запись в `provider_connections` (status: active), возвращает `{ ok: true, data: { id, status, display_name, environment } }`.
  10. Frontend: скрывает форму, показывает статус "✓ Connected — {display_name}", сохраняет `connectionId` в state.
  11. **Секция "SIP Resource"** появляется: поля SIP URI, Server URL.
  12. Нажать "Save" → `POST /api/vapi/resources` `{ provider_connection_id: connectionId, sip_uri, server_url, environment }`.
  13. Backend вставляет запись в `vapi_tenant_resources`, возвращает `{ ok: true, data: { id, sip_uri, server_url } }`.
  14. Frontend: показывает SIP URI в режиме просмотра.
  15. Появляется кнопка "Finish Setup".
  16. Нажать "Finish Setup" → `POST /api/marketplace/apps/vapi-ai/install` (body: `{}`).
  17. Backend: `installApp(companyId, actorId, 'vapi-ai')` → `provisioning_mode: none` → немедленно `status: connected`.
  18. Frontend: `toast.success('VAPI AI connected')` → `navigate('/settings/integrations')`.
- **Ожидаемый результат:** Плитка VAPI показывает статус "Connected", кнопка сменилась на "Manage".
- **Побочные эффекты:** Записи в `provider_connections`, `vapi_tenant_resources`, `marketplace_installations`.

---

### Сценарий 2: Просмотр и управление существующим подключением

- **Предусловия:** VAPI подключён (active installation, active connection, resource существует).
- **Шаги:**
  1. Пользователь нажимает "Manage" на плитке VAPI → `navigate('/settings/integrations/vapi-ai')`.
  2. `VapiSettingsPage`: `GET /api/vapi/connections` возвращает запись со `status: 'active'`; `GET /api/vapi/resources` возвращает запись с `sip_uri`.
  3. Страница отображается в режиме просмотра:
     - API Key: "••••••••" + display_name + статус Active + environment badge
     - SIP URI: значение из resource, копируемое поле
     - Server URL: значение
  4. Кнопка "Disconnect" внизу страницы.
- **Ожидаемый результат:** Информация о подключении без возможности редактировать ключ.

---

### Сценарий 3: Отключение VAPI

- **Предусловия:** Активная installation существует.
- **Шаги:**
  1. На `VapiSettingsPage` нажать "Disconnect".
  2. Подтверждение (Alert Dialog): "Disconnect VAPI AI? Routing to VAPI AI nodes will stop working."
  3. Подтвердить → `POST /api/marketplace/installations/:installationId/disconnect`.
  4. Backend: `disconnectInstallation(companyId, actorId, id)` → статус `revoked`.
  5. Frontend: `toast.success('VAPI AI disconnected')` → `navigate('/settings/integrations')`.
  6. Плитка: статус "Available", кнопка "Configure".
  7. Call Flow Builder после отключения: при следующей загрузке `GET /api/vapi/connections` вернёт пустой массив → нода `vapi_agent` исчезает из insert picker.
- **Ожидаемый результат:** Installation revoked, нода недоступна в flow editor.
- **Побочные эффекты:** `marketplace_installations.status = revoked`. Записи `provider_connections` и `vapi_tenant_resources` остаются (soft state).

---

### Сценарий 4: Гейтинг vapi_agent в Call Flow Builder

- **Предусловия:** Пользователь открывает редактор flow для группы.
- **Шаги:**
  1. `CallFlowBuilderPage` монтируется → `useEffect`: `GET /api/vapi/connections`.
  2. Если ответ содержит хотя бы одну запись со `status === 'active'` → `setVapiConnected(true)`.
  3. Иначе → `setVapiConnected(false)`.
  4. Insert picker рендерит список node kinds → фильтрует `vapi_agent` если `vapiConnected === false`.
  5. Если нода уже есть в сохранённом flow (из прошлого) → отображается как обычно (не удаляется), но insert picker не предлагает добавить новую.
- **Ожидаемый результат:** Нода доступна только при active VAPI connection.

---

## Граничные случаи

1. **Неверный API key** → backend возвращает `400 { ok: false, error: 'Invalid Vapi API key' }` → inline error под полем API Key, форма не очищается, кнопка снова активна.
2. **Vapi API недоступен при верификации** → `400 { ok: false, error: 'Could not verify API key' }` → inline error "Unable to reach Vapi. Check key and try again."
3. **Дублирующий install** → `409 APP_ALREADY_INSTALLED` → toast.error, страница остаётся, пользователь видит Manage-режим.
4. **Пользователь уходит со страницы после шага 1 (connection создан, install не завершён)** → при следующем открытии страницы `GET /api/vapi/connections` вернёт active connection → секция SIP Resource уже показывается, нужно только добавить resource и finish.
5. **SIP URI уже существует для tenant** → backend может вернуть ошибку уникального индекса → `400 { error: 'SIP resource already exists for this environment' }` → inline error под SIP URI полем.
6. **VAPI connected, но resource не заполнен** → страница показывает секцию SIP Resource в edit-режиме, секция API Connection в view-режиме. Кнопка "Finish Setup" недоступна до заполнения resource.
7. **Call Flow Builder загружается до завершения GET /api/vapi/connections** → нода `vapi_agent` скрыта пока `vapiConnected === null` (loading state), показывается после resolve.

---

## Обработка ошибок

| Ошибка | Источник | Реакция |
|--------|----------|---------|
| 400 Invalid Vapi API key | POST /api/vapi/connections | Inline error под полем "API Key", кнопка снова active |
| 400 Could not verify API key | POST /api/vapi/connections | Inline error "Unable to reach Vapi. Try again." |
| 400 SIP resource error | POST /api/vapi/resources | Inline error под полем SIP URI |
| 409 APP_ALREADY_INSTALLED | POST marketplace install | toast.error + reload installations query |
| 500 любой | любой | toast.error('Something went wrong. Try again.') |
| Сеть недоступна | любой | toast.error('Network error. Check connection.') |

---

## Взаимодействие компонентов

```
VapiSettingsPage
  ├─ useQuery(['vapi-connections'])  → GET /api/vapi/connections
  ├─ useQuery(['vapi-resources'])    → GET /api/vapi/resources
  ├─ useQuery(['marketplace-apps'])  → GET /api/marketplace/apps  (React Query cache)
  │
  ├─ useMutation: createConnection  → POST /api/vapi/connections
  ├─ useMutation: createResource    → POST /api/vapi/resources
  ├─ useMutation: installApp        → POST /api/marketplace/apps/vapi-ai/install
  └─ useMutation: disconnectApp     → POST /api/marketplace/installations/:id/disconnect

IntegrationsPage (marketplace tab)
  └─ app.app_key === 'vapi-ai'
       → кнопка "Configure" | "Manage"  → navigate('/settings/integrations/vapi-ai')
       → НЕ открывает MarketplaceConnectDialog

CallFlowBuilderPage
  └─ useEffect on mount
       → vapiApi.getConnections()  → GET /api/vapi/connections
       → vapiConnected = data.some(c => c.status === 'active')
       → insert picker: NODE_KINDS.filter(k => k !== 'vapi_agent' || vapiConnected)
```

---

## API-контракты

### GET /api/vapi/connections
- **Auth:** authedFetch, `authenticate + requireCompanyAccess`
- **Response:** `{ ok: true, data: VapiConnection[] }`
- **VapiConnection:** `{ id, tenant_id, provider, environment, status, display_name, created_at, updated_at }`

### POST /api/vapi/connections
- **Auth:** authedFetch, `authenticate + requireCompanyAccess`
- **Request:** `{ api_key: string, display_name?: string, environment?: 'prod' | 'dev' }`
- **Response 200:** `{ ok: true, data: VapiConnection }`
- **Response 400:** `{ ok: false, error: 'Invalid Vapi API key' | 'Could not verify API key' }`

### GET /api/vapi/resources
- **Auth:** authedFetch, `authenticate + requireCompanyAccess`
- **Response:** `{ ok: true, data: VapiResource[] }`
- **VapiResource:** `{ id, tenant_id, provider_connection_id, environment, sip_uri, server_url, is_active, created_at }`

### POST /api/vapi/resources
- **Auth:** authedFetch, `authenticate + requireCompanyAccess`
- **Request:** `{ provider_connection_id: string, sip_uri: string, server_url?: string, environment?: 'prod' | 'dev' }`
- **Response 200:** `{ ok: true, data: VapiResource }`
- **Response 400:** `{ ok: false, error: string }`

### POST /api/marketplace/apps/vapi-ai/install
- **Auth:** authedFetch, `authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess`
- **Request:** `{}`
- **Response 201:** `{ success: true, installation: MarketplaceInstallation }`
- **Response 409:** `{ success: false, code: 'APP_ALREADY_INSTALLED' }`

### POST /api/marketplace/installations/:id/disconnect
- **Auth:** authedFetch, `authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess`
- **Request:** `{}`
- **Response 200:** `{ success: true, installation: { id, status: 'revoked', ... } }`

---

## Безопасность и изоляция данных

- `/api/vapi/*` роуты используют `DEFAULT_TENANT` — сейчас single-tenant. При переходе на multi-tenant: заменить `DEFAULT_TENANT` на `req.companyFilter?.company_id`.
- Marketplace endpoints полностью изолированы по `company_id` через `requireCompanyAccess`.
- API key Vapi хранится в `provider_connections.encrypted_credentials_json` как JSON `{ api_key }`. Никогда не возвращается в GET-ответах (поле удаляется перед отправкой).
- SIP URI и Server URL не секретные, возвращаются в GET /api/vapi/resources.
