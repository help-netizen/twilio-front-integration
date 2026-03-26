# Спецификация: PF103 — Tenancy / RBAC DB Tables & API Contracts

**Дата:** 2026-03-24
**Статус:** Proposed
**Основа:** `PF007`

---

## Цель

Зафиксировать proposed data model и canonical API contracts для:

- platform company administration;
- tenant team management;
- tenant roles and permissions;
- effective authorization context.

Этот документ не заменяет `PF007`, а переводит его в инженерные контракты.

---

## Архитектурные решения

1. `Keycloak` остаётся source of truth для identity, login, sessions и password flows.
2. Platform role и tenant authorization хранятся и вычисляются приложением.
3. `super_admin` больше не должен жить как tenant membership.
4. `company_memberships` остаётся основой tenant membership, но роль внутри membership переходит с legacy enum на `role_key` из фиксированного системного набора.
5. `company_admin/company_member` сохраняются как compatibility mapping на rollout-период.
6. `crm_users.company_id` не должен считаться авторитетным источником tenant access; authoritative source — активная membership.

---

## Existing tables reused

### Reuse without replacement

- `companies`
- `crm_users`
- `company_memberships`
- `audit_log`
- все существующие tenant-scoped доменные таблицы с `company_id`

### Existing tables that need extension

## `crm_users`

Добавить:

- `platform_role` — `none | super_admin`
- `primary_membership_id` — nullable FK на `company_memberships`
- `last_invited_at`
- `onboarding_status` — `invited | active | disabled`

Назначение:

- отделить platform authority от tenant membership;
- перестать использовать `crm_users.role` как полноценный RBAC источник;
- сохранить совместимость со старым shadow profile.

## `companies`

Добавить/нормализовать:

- `timezone`
- `locale`
- `contact_email`
- `contact_phone`
- `billing_email`
- `created_by_user_id`
- `suspended_at`
- `archived_at`
- `status_reason`

Назначение:

- company registry для platform super admin;
- source для tenant bootstrap и company-level settings.

## `company_memberships`

Добавить:

- `role_key` — `tenant_admin | manager | dispatcher | provider`
- `is_primary`
- `invited_by`
- `invited_at`
- `activated_at`
- `disabled_at`
- `disabled_reason`

Сохранить временно:

- `role` как compatibility column на rollout-период

Назначение:

- membership становится связью `user <-> company <-> fixed role + user profile`, а не только `user <-> company <-> legacy enum`.

---

## Proposed tables

## 1. `company_role_configs`

- `id`
- `company_id`
- `role_key` — `tenant_admin | manager | dispatcher | provider`
- `display_name`
- `description`
- `is_locked`
- `created_by`
- `created_at`
- `updated_at`

Назначение:

- tenant-scoped конфигурации для фиксированных системных ролей;
- по одной записи на каждую системную роль в компании;
- custom role rows не создаются.

## 2. `company_role_permissions`

- `id`
- `role_config_id`
- `permission_key`
- `is_allowed`
- `created_at`
- `updated_at`

Назначение:

- canonical permission matrix по модулям и действиям.

## 3. `company_role_scopes`

- `id`
- `role_config_id`
- `scope_key`
- `scope_json`
- `created_at`
- `updated_at`

Назначение:

- advanced restrictions:
  - `job_visibility`
  - `dashboard_widgets`
  - `service_area_scope`
  - `status_scope`
  - `report_scope`
  - `finance_scope`

## 4. `company_membership_permission_overrides`

- `id`
- `membership_id`
- `permission_key`
- `override_mode` — `allow | deny`
- `created_by`
- `created_at`
- `updated_at`

Назначение:

- granular permission toggles в профиле конкретного сотрудника;
- применяются поверх role matrix;
- доступны только для overrideable permissions выбранной роли.

## 5. `company_membership_scope_overrides`

- `id`
- `membership_id`
- `scope_key`
- `scope_json`
- `created_by`
- `created_at`
- `updated_at`

Назначение:

- user-level scope overrides для `assigned jobs only`, widget visibility и других доп-настроек в профиле сотрудника.

## 6. `company_user_profiles`

- `id`
- `membership_id`
- `phone`
- `schedule_color`
- `is_provider`
- `call_masking_enabled`
- `location_tracking_enabled`
- `phone_calls_allowed`
- `job_close_mode` — `close | done_pending_approval`
- `created_at`
- `updated_at`

Назначение:

- profile-атрибуты пользователя внутри конкретной tenant-компании;
- field-tech и dispatch-specific свойства не должны жить только в `crm_users`.

## 7. `company_user_service_areas`

- `id`
- `membership_id`
- `service_area_id`
- `created_at`

Назначение:

- ограничение доступных зон работ для пользователя.

## 8. `company_user_skills`

- `id`
- `membership_id`
- `job_type_id`
- `created_at`

Назначение:

- ограничение доступных job types / skills для пользователя.

## 9. `company_invitations`

- `id`
- `company_id`
- `email`
- `role_key`
- `invited_by`
- `keycloak_sub`
- `status` — `pending | accepted | expired | revoked`
- `expires_at`
- `created_at`
- `updated_at`

Назначение:

- локальный invite/onboarding tracking поверх `Keycloak` flows.

---

## Canonical permission keys

Ниже минимальный набор, который должен быть стабилен в API и middleware.

### Platform

- `platform.companies.view`
- `platform.companies.manage`
- `platform.super_admins.manage`
- `platform.audit.view`

### Tenant settings and admin

- `tenant.company.view`
- `tenant.company.manage`
- `tenant.users.view`
- `tenant.users.manage`
- `tenant.roles.view`
- `tenant.roles.manage`
- `tenant.integrations.manage`
- `tenant.telephony.manage`

### Core workspaces

- `dashboard.view`
- `pulse.view`
- `messages.view_internal`
- `messages.view_client`
- `messages.send`
- `contacts.view`
- `contacts.edit`
- `leads.view`
- `leads.create`
- `leads.edit`
- `leads.convert`
- `jobs.view`
- `jobs.create`
- `jobs.edit`
- `jobs.assign`
- `jobs.close`
- `jobs.done_pending_approval`
- `schedule.view`
- `schedule.dispatch`

### Finance and future P0 modules

- `financial_data.view`
- `estimates.view`
- `estimates.create`
- `estimates.send`
- `invoices.view`
- `invoices.create`
- `invoices.send`
- `payments.view`
- `payments.collect_online`
- `payments.collect_offline`
- `payments.refund`

### Reports and visibility

- `reports.dashboard.view`
- `reports.jobs.view`
- `reports.leads.view`
- `reports.calls.view`
- `reports.payments.view`
- `reports.financial.view`
- `client_job_history.view`

### Field operations

- `provider.enabled`
- `phone_calls.use`
- `call_masking.use`
- `gps_tracking.view`
- `gps_tracking.collect`

---

## Canonical scopes

### `job_visibility`

- `all`
- `assigned_only`

### `financial_scope`

- `full`
- `hidden`

### `dashboard_scope`

- `all_widgets`
- `selected_widgets`
- `no_dashboard`

### `report_scope`

- `all`
- `operational_only`
- `none`

### `job_close_scope`

- `close_allowed`
- `done_pending_approval_only`

### `service_area_scope`

- list of allowed `service_area_id`

### `skill_scope`

- list of allowed `job_type_id`

---

## API contracts

## 1. Auth context

### `GET /api/auth/me`

Назначение:

- вернуть текущий identity + tenant context + effective permissions.

Ответ:

```json
{
  "ok": true,
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "full_name": "Jane Doe",
    "platform_role": "none"
  },
  "company": {
    "id": "uuid",
    "name": "Tenant Co",
    "slug": "tenant-co",
    "status": "active",
    "timezone": "America/New_York"
  },
  "membership": {
    "id": "uuid",
    "role_key": "dispatcher",
    "role_name": "Dispatcher",
    "is_primary": true,
    "status": "active"
  },
  "permissions": [
    "pulse.view",
    "messages.view_client",
    "jobs.view",
    "jobs.assign",
    "schedule.view",
    "schedule.dispatch"
  ],
  "scopes": {
    "job_visibility": "all",
    "financial_scope": "hidden",
    "dashboard_scope": "selected_widgets",
    "dashboard_widgets": ["dispatch_queue", "my_jobs"]
  }
}
```

## 2. Platform companies

### `GET /api/platform/companies`

Фильтры:

- `status`
- `q`
- `page`
- `limit`

### `POST /api/platform/companies`

Тело:

```json
{
  "company": {
    "name": "Tenant Co",
    "slug": "tenant-co",
    "timezone": "America/New_York",
    "contact_email": "ops@tenantco.com"
  },
  "initial_admin": {
    "email": "owner@tenantco.com",
    "full_name": "Owner User",
    "phone": "+15551234567"
  }
}
```

Требование:

- company creation и bootstrap first admin выполняются как один orchestrated flow.

### `GET /api/platform/companies/:companyId`

Только platform metadata:

- company status
- created/updated timestamps
- onboarding state
- first admin state
- audit summary

### `PATCH /api/platform/companies/:companyId`

Разрешённые изменения:

- name
- slug
- timezone
- locale
- contact info
- status
- status_reason

## 3. Tenant company settings

### `GET /api/settings/company`

### `PATCH /api/settings/company`

Не должны менять platform-only поля и не должны быть доступны `super_admin`.

## 4. Team management

### `GET /api/settings/users`

Фильтры:

- `q`
- `status`
- `role_key`
- `provider`
- `service_area_id`
- `job_type_id`
- `page`
- `limit`

### `POST /api/settings/users`

Тело:

```json
{
  "email": "tech@example.com",
  "full_name": "Provider User",
  "phone": "+15551230000",
  "role_key": "provider",
  "profile": {
    "is_provider": true,
    "schedule_color": "#3B82F6",
    "call_masking_enabled": true,
    "location_tracking_enabled": true,
    "phone_calls_allowed": true
  }
}
```

### `GET /api/settings/users/:userId`

Возвращает:

- membership
- role
- profile
- role_matrix
- permission_overrides
- effective_permissions
- service areas
- skills
- onboarding state

### `PATCH /api/settings/users/:userId`

Разрешает обновить:

- `full_name`
- `phone`
- `role_key`
- `profile`

### `PATCH /api/settings/users/:userId/status`

Тело:

```json
{ "status": "active" }
```

или

```json
{ "status": "disabled", "reason": "left_company" }
```

### `POST /api/settings/users/:userId/resend-invite`

### `POST /api/settings/users/:userId/reset-password`

### `PATCH /api/settings/users/:userId/permission-overrides`

```json
{
  "permissions": {
    "jobs.close": false,
    "payments.collect_offline": true
  },
  "scopes": {
    "job_visibility": "assigned_only"
  }
}
```

Правила:

- endpoint доступен только `Tenant Admin`;
- можно менять только overrideable permissions/scopes для выбранной системной роли.

### `PUT /api/settings/users/:userId/service-areas`

```json
{ "service_area_ids": ["uuid-1", "uuid-2"] }
```

### `PUT /api/settings/users/:userId/skills`

```json
{ "job_type_ids": ["uuid-1", "uuid-2"] }
```

## 5. Roles and permissions

### `GET /api/settings/roles`

### `GET /api/settings/roles/:roleKey`

### `PATCH /api/settings/roles/:roleKey`

```json
{
  "permissions": {
    "schedule.dispatch": true,
    "financial_data.view": true,
    "payments.collect_offline": true
  },
  "scopes": {
    "job_visibility": "all",
    "dashboard_scope": "selected_widgets",
    "dashboard_widgets": ["dispatch_queue", "today_jobs", "payments_due"]
  }
}
```

Правила:

- endpoint доступен только `Tenant Admin`;
- `tenant_admin` role имеет mandatory-admin permissions, которые нельзя выключить;
- custom role creation/clone/deactivate endpoints отсутствуют в PF007.

---

## Error contracts

Минимальный набор кодов:

- `ACCESS_DENIED`
- `TENANT_CONTEXT_REQUIRED`
- `PLATFORM_SCOPE_ONLY`
- `TENANT_SCOPE_ONLY`
- `LAST_ADMIN_REQUIRED`
- `ROLE_IN_USE`
- `ROLE_NOT_ASSIGNABLE`
- `COMPANY_SUSPENDED`
- `INVITE_EXPIRED`
- `VALIDATION_ERROR`

---

## Domain events

- `company.created`
- `company.updated`
- `company.suspended`
- `company.archived`
- `company.first_admin_bootstrapped`
- `membership.created`
- `membership.updated`
- `membership.disabled`
- `membership.enabled`
- `role.created`
- `role.updated`
- `role.deactivated`
- `user.profile.updated`
- `super_admin.assigned`
- `super_admin.revoked`

---

## Compatibility requirements

1. Текущий `/api/users` должен иметь временный compatibility layer поверх новых tenant user services.
2. Текущие значения `company_admin/company_member` должны маппиться на фиксированные системные роли.
3. Текущий `SuperAdminPage` session/auth-policy функционал остаётся и дополняется company management, а не переносится в новый отдельный экран.
4. `ProtectedRoute roles` должен постепенно мигрировать на permission-aware contract после появления `GET /api/auth/me`.
