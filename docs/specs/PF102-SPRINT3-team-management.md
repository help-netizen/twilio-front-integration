# Спецификация: PF102 Sprint 3 — Tenant Team Management MVP

## 1. Введение
Этот документ описывает функциональные спецификации для Sprint 3 согласно генеральному плану PF102. Текущая страница пользователей компании будет заменена на полноценный интерфейс "Team Management" с управлением гранулярными ролями и настройками профиля сотрудника.

## 2. API Контракты (расширение над Users API)

### `GET /api/users`
Возвращает список сотрудников.
**Response Additions:**
- `role_key` (вместо legacy `role`).
- `user_profile` объект (is_provider, phone_calls_allowed, schedule_color, location_tracking_enabled).

### `POST /api/users`
**Request Body:**
```json
{
  "email": "user@test.com",
  "full_name": "John Doe",
  "role_key": "dispatcher",
  "profile": {
    "phone_calls_allowed": true,
    "is_provider": false,
    "schedule_color": "#FFAA00"
  }
}
```

### `PATCH /api/users/:id`
Редактирование профиля и роли существующего сотрудника.
**Request Body:** (Частичное обновление)
```json
{
  "role_key": "manager",
  "profile": {
    "phone_calls_allowed": false
  }
}
```

### `PATCH /api/users/:id/status`
Активация/деактивация сотрудника.
**Request Body:**
```json
{
  "status": "disabled",
  "reason": "left_company"
}
```

## 3. Граничные случаи (Edge Cases)
1. **Последний администратор:** Бэкенд обязан отклонить запрос (`403` или `400 LAST_ADMIN`), если `tenant_admin` пытается понизить свою роль до `manager` или деактивировать себя, будучи последним администратором.
2. **Keycloak Sync:** Если email уже существует в Keycloak (при POST /api/users), пользователь должен быть приглашен на уровне БД (company_memberships), без падения с REST Error 409 от Keycloak. Вместо этого `crm_users` линкуется с существующим `keycloak_sub`.
3. **Защита ролей:** Можно назначить только роли из списка `tenant_admin`, `manager`, `dispatcher`, `provider`.
