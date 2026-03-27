# Спецификация: Atomic Admin Bootstrap on Company Creation

**ID:** PF007-bootstrap  
**Статус:** Draft  
**Связь:** PF007 §1.3, §3 (атомарное создание компании + первый admin)

## Общее описание

При создании tenant-компании Super Admin указывает email первого администратора (обязательно). Система атомарно создаёт компанию и bootstrap-ит первого пользователя-админа: Keycloak user + `crm_users` + `company_memberships`.

## Обновление фичи F012

**Текущее состояние:** `POST /api/admin/companies` создаёт только запись в `companies`. Admin bootstrap — отдельный вызов `POST /:id/bootstrap-admin`.  
**Предлагаемые изменения:** Интегрировать bootstrap в `POST /api/admin/companies` когда передан `admin_email`.  
**Затронутые модули:** `admin-companies.js` (backend route), `keycloakService.js` (Keycloak integration), `CreateCompanyDialog.tsx` (frontend).  
**Затронутые интеграции:** Keycloak Admin API.  
**Защищённые части:** `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`, `backend/db/` schema.

## Сценарии поведения

### Сценарий 1: Создание компании с admin email

- **Предусловия:** Super Admin авторизован, Keycloak доступен
- **Входные данные:** `{ name, slug, timezone, locale, admin_email }`
- **Шаги:**
  1. Frontend отправляет `POST /api/admin/companies` с `admin_email`
  2. Backend валидирует: `name`, `slug`, `admin_email` обязательны
  3. Backend создаёт запись в `companies`
  4. Backend вызывает `keycloakService.ensureUserExistsAndExecuteAction()` с `admin_email` и `companyId`
  5. Backend вызывает `keycloakService.assignGlobalRole(kcUser.id, 'company_admin')`
  6. Backend создаёт `crm_users` + `company_memberships` (role_key=`tenant_admin`) в транзакции
  7. Backend логирует `company_created` + `company_admin_bootstrapped` в audit
- **Ожидаемый результат:** 201 с данными компании, пользователь создан в Keycloak и БД
- **Побочные эффекты:** Keycloak user с temp password `admin123`, audit records

### Граничные случаи

1. Keycloak user с таким email уже существует → `ensureUserExistsAndExecuteAction` обновит `company_id` атрибут, не упадёт
2. Keycloak недоступен → 500 с `{ error: "Failed to bootstrap admin: ..." }`, компания остаётся созданной (можно повторить через `bootstrap-admin`)
3. `admin_email` не передан → 400 `{ error: "Admin email is required" }`
4. `slug` уже занят → 409 (существующее поведение)

## API-контракт

### `POST /api/admin/companies`

**Request:**
```json
{
  "name": "Test Company",
  "slug": "test-company",
  "timezone": "America/New_York",
  "locale": "en-US",
  "admin_email": "admin@test.com"
}
```

**Response 201:**
```json
{
  "id": "uuid",
  "name": "Test Company",
  "slug": "test-company",
  "status": "active",
  "admin_bootstrapped": true,
  "admin_email": "admin@test.com"
}
```

**Response 400:** `{ "error": "Name, slug and admin_email are required" }`  
**Response 500 (Keycloak fail):** `{ "error": "Company created but admin bootstrap failed: ..." }`

## Файлы для изменений

| Файл | Действие | Описание |
|---|---|---|
| `backend/src/routes/admin-companies.js` | MODIFY | Интегрировать bootstrap в POST / |
| `frontend/src/components/super-admin/CreateCompanyDialog.tsx` | MODIFY | `contact_email` → `admin_email`, required |

## План задач

### AB001: Backend — интегрировать bootstrap в POST /api/admin/companies

**Файлы:** `backend/src/routes/admin-companies.js`  
**Нельзя менять:** `src/server.js`, `backend/src/services/keycloakService.js` (только использовать)  
**Результат:** POST / принимает `admin_email`, создаёт Keycloak user + DB records  
**Зависимости:** нет

### AB002: Frontend — заменить Contact Email на Admin Email

**Файлы:** `frontend/src/components/super-admin/CreateCompanyDialog.tsx`  
**Нельзя менять:** `frontend/src/services/apiClient.ts`  
**Результат:** Форма отправляет `admin_email` (required) вместо `contact_email`  
**Зависимости:** AB001
