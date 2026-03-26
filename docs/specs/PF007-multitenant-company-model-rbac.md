# Спецификация: PF007 — Multi-tenant Company Model, Super Admin & RBAC

**Дата:** 2026-03-24
**Статус:** Proposed
**Приоритет:** P0
**Основа:** `docs/requirements.md`, `docs/architecture.md`, `docs/feature-backlog.md`
**Связанные артефакты:** `PF007-technical-design.md`, `PF102-tenancy-rbac-sprint-plan.md`, `PF103-tenancy-rbac-db-api-contracts.md`

---

## Цель

Сделать tenant/user platform обязательным foundation-layer перед дальнейшей реализацией `Schedule / Estimates / Invoices / Payments / Client Portal / Automations`.

Ключевой результат:

- платформа умеет безопасно хостить несколько tenant-компаний;
- `super_admin` отделён от tenant data-plane;
- в tenant-компании появляется полноценный `Team Management + Roles & Permissions`;
- текущая грубая модель `company_admin/company_member` уходит в migration compatibility слой;
- custom roles не вводятся: tenant-admin настраивает матрицы прав для фиксированных системных ролей и дополнительные permission toggles в профиле сотрудника.

---

## Почему это теперь самый высокий приоритет

Сейчас в проекте уже есть:

- `companies`
- `crm_users`
- `company_memberships`
- `CompanyUsersPage`
- `SuperAdminPage`
- `keycloakAuth`

Но это пока не полноценная tenant platform, а переходное состояние:

1. `super_admin` сейчас может обходить `company`-изоляцию.
2. Tenant authorization сведена к двум ролям `company_admin/company_member`.
3. Права не выражаются как capability matrix по модулям.
4. Team management не покрывает field-tech профиль, advanced restrictions и configurable system role matrices.
5. Будущие `Schedule / Finance Docs / Portal / Automation` без нормального RBAC будут быстро обрастать hardcoded exceptions.

---

## Что берём из Workiz и что осознанно не копируем

Берём по смыслу:

- шаблонную модель ролей `Admin / Manager / Dispatcher / Tech`, mapped in Blanc to `Tenant Admin / Manager / Dispatcher / Provider`;
- `Roles & Permissions` как отдельный tenant surface;
- `Manage team` как user-profile oriented workspace;
- advanced restrictions:
  - `assigned jobs only`
  - `financial data`
  - `dashboard/widgets`
  - `close jobs`
  - `collect payments`
  - `client job history`
  - `service areas`
  - `skills/job types`
  - `provider`
  - `call masking`
  - `GPS tracking`

Берём по механике из Zenbooker:

- фиксированный набор системных ролей без custom role builder;
- возможность менять матрицу доступов для установленных ролей внутри tenant-компании;
- возможность включать/выключать дополнительные permissions в профиле конкретного сотрудника;
- право на изменение ролей и permission-модели только у tenant-admin.

Осознанно не копируем:

- `Subcontractors`
- `Franchises`
- jump-into-subaccount flows
- seat billing logic
- marketplace/add-on gating как обязательную часть PF007

Дополнительное отличие от Workiz:

- `Keycloak` сохраняется как identity provider;
- `super_admin` в Blanc не должен иметь tenant-company access вообще.

---

## Current system reuse

### Уже существующие контуры, которые нужно расширять, а не заменять

- `backend/src/middleware/keycloakAuth.js`
- `backend/src/services/userService.js`
- `backend/src/routes/users.js`
- `frontend/src/auth/AuthProvider.tsx`
- `frontend/src/auth/ProtectedRoute.tsx`
- `frontend/src/pages/CompanyUsersPage.tsx`
- `frontend/src/pages/SuperAdminPage.tsx`
- `companies`, `crm_users`, `company_memberships`, `audit_log`

### Что нельзя делать

- нельзя строить вторую auth-модель параллельно с `Keycloak`;
- нельзя создавать отдельный tenant-routing слой вне текущего runtime;
- нельзя оставлять `super_admin` как universal bypass для tenant routes;
- нельзя внедрять новый RBAC через page-only toggles без backend enforcement.

---

## Акторы и fixed system roles

## Platform actor

### `Platform Super Admin`

- управляет tenant-компаниями и platform security;
- видит company directory, статусы, onboarding и health;
- не видит `Jobs / Leads / Contacts / Pulse / Messages / Payments / Schedule` tenant-компаний;
- не может impersonate tenant user и не может открывать tenant workspace.

## Tenant actors

### `Tenant Admin`

- полный доступ к tenant scope;
- управляет `Team Management`, `Roles & Permissions`, company settings, telephony settings, integrations и finance visibility;
- не имеет platform-admin прав.

### `Manager`

- широкий доступ к business-модулям tenant-компании;
- по умолчанию ограничен от user/role/security administration, role governance и main company settings;
- может получать дополнительные разрешения через tenant-admin configured role matrix и employee-level overrides.

### `Dispatcher`

- эквивалент Zenbooker `Scheduler`;
- ориентирован на `Pulse / Messages / Leads / Jobs / Schedule / dispatch operations`;
- не должен по умолчанию управлять ролями, критичными settings и platform/security surfaces;
- finance и reports доступны только по включённым permission keys.

### `Provider`

- эквивалент Zenbooker `Worker` и Workiz `Field Tech`;
- ориентирован на assigned work;
- по умолчанию видит только назначенные ему jobs и связанные client threads;
- может обновлять job progress;
- `close jobs`, `collect payments`, `client job history`, `GPS tracking` включаются отдельными permissions;
- не должен видеть весь tenant backlog, весь dashboard и все settings.

---

## Product principles

1. `Authentication != authorization`: `Keycloak` подтверждает личность, приложение решает tenant scope и permissions.
2. `Platform scope != tenant scope`: суперадмин управляет платформой, но не клиентскими данными.
3. `At least one admin`: у активной компании всегда есть минимум один активный tenant admin.
4. `First user is admin`: bootstrap компании всегда создаёт первого tenant admin.
5. `Backend is authoritative`: UI скрывает недоступные действия, но окончательное решение принимает backend.
6. `No greenfield duplication`: текущие `CompanyUsersPage`, `SuperAdminPage`, `AuthProvider`, `ProtectedRoute` должны эволюционировать, а не дублироваться новыми отдельными слоями.
7. `Fixed roles, configurable matrices`: tenant использует только системные роли, но может настраивать их permission matrix на уровне компании.
8. `Employee-level overrides`: дополнительные permissions настраиваются в профиле сотрудника поверх выбранной системной роли и только по админскому governance flow.
9. `Future-proof for P0 business suite`: PF007 должен заранее покрыть будущие `Schedule`, `Estimates`, `Invoices`, `Payments`, `Client Portal`, `Automations`.

---

## Функциональные требования

## 1. Platform company management

1. Система должна предоставлять platform-only workspace для списка tenant-компаний.
2. `Platform Super Admin` должен иметь возможность:
   - создать tenant-компанию;
   - изменить company status (`active`, `suspended`, `archived`);
   - просмотреть onboarding state;
   - инициировать bootstrap первого admin user;
   - просмотреть platform-level audit trail по company administration.
3. Создание компании должно выполняться атомарно вместе с bootstrap первого пользователя-админа или с созданием pending invite на этого пользователя.
4. Suspended company не должна пускать tenant users в рабочие tenant-модули, но platform super admin должен сохранять доступ к company card и audit.
5. Platform company directory не должен показывать tenant business records.

## 2. Tenant isolation

1. Все tenant-scoped backend routes должны требовать валидный tenant context.
2. `super_admin` не должен получать пустой глобальный `companyFilter` для tenant routes.
3. Если пользователь не имеет активного tenant membership, tenant routes должны возвращать `403`, а не silently fallback на другую компанию.
4. Tenant isolation должна распространяться на:
   - HTTP responses
   - search endpoints
   - exports
   - realtime payloads
   - webhook side effects
   - audit records
5. Tenant data не должна быть доступна через platform admin UI даже read-only.

## 3. Company bootstrap and invariants

1. В каждой активной компании должен существовать минимум один активный пользователь с tenant-admin полномочиями.
2. Первый пользователь компании всегда создаётся как tenant admin.
3. Нельзя понизить, отключить или удалить последнего активного tenant admin.
4. Если tenant admin меняет свою роль или статус, система должна проверить инвариант до фиксации изменений.
5. Если пользователь приглашён, но ещё не активирован, это не должно считаться удовлетворением admin invariant.

## 4. Team Management

1. Текущий `Company Users` должен быть расширен до полноценного `Team Management`.
2. Team Management должен поддерживать:
   - список пользователей компании;
   - фильтры по `status`, `role`, `provider`, `service area`, `skills/job type`;
   - поиск по имени, email, телефону;
   - создание/приглашение пользователя;
   - повторную отправку invite;
   - disable/enable пользователя;
   - смену роли;
   - редактирование user profile.
3. Создание пользователя должно учитывать текущий `Keycloak` onboarding flow и не ломать server-side creation через admin token.
4. User management должен быть tenant-scoped и недоступен platform super admin как способа читать tenant business data.

## 5. Roles & Permissions

1. В каждой компании должен быть отдельный tenant-scoped workspace `Roles & Permissions`.
2. При создании компании система должна seed-ить фиксированные системные роли:
   - `Tenant Admin`
   - `Manager`
   - `Dispatcher`
   - `Provider`
3. Только `Tenant Admin` должен иметь право:
   - просматривать и редактировать матрицу прав системных ролей;
   - менять дополнительные permission toggles в профиле сотрудника;
   - назначать сотруднику одну из системных ролей.
4. Система не должна поддерживать создание, клонирование, переименование или удаление custom roles в рамках PF007.
5. Для каждой системной роли tenant-admin должен иметь возможность открыть карточку роли и изменить набор разрешённых действий и ограничений для этой компании.
6. Permissions должны группироваться как минимум по секциям:
   - `Actions`
   - `Reports`
   - `Advanced`
7. Permission matrix должна покрывать не только текущие модули, но и уже утверждённый backlog будущих tenant-модулей.
8. `Tenant Admin` role должна иметь минимальный неизменяемый mandatory-admin baseline, который нельзя выключить через настройку матрицы.

## 6. User profile model

1. User profile внутри tenant-компании должен хранить и редактировать:
   - `full_name`
   - `email`
   - `phone`
   - `role`
   - `status`
   - `schedule color`
   - `provider status`
   - `call masking`
   - `track location`
   - `phone calls allowed`
   - `service areas`
   - `skills/job types`
2. `provider status` должен быть отдельным от роли атрибутом, как в Workiz field-tech модели.
3. `phone_calls_allowed` из текущей модели должен сохраниться, но стать частью общей permission/profile модели, а не отдельной ad-hoc настройки.
4. Service areas и skills должны использоваться как future-ready ограничения для `Schedule`, `Jobs`, `Online Booking`, `Dispatch`.
5. В профиле сотрудника tenant-admin должен иметь возможность включать/выключать дополнительные permissions, доступные для выбранной системной роли, по модели, близкой к Zenbooker.

## 7. Permission domains and advanced restrictions

Система должна поддерживать как минимум следующие категории прав.

### Workspace access

- dashboard
- pulse
- messages
- contacts
- leads
- jobs
- schedule
- payments
- providers
- telephony settings
- integrations
- company settings
- team management
- roles & permissions

### Record actions

- create/edit/delete leads
- create/edit/assign/reschedule jobs
- close jobs
- mark jobs done pending approval
- send client messages
- send internal messages
- create/send estimates and invoices
- collect online/offline payments

### Visibility restrictions

- assigned jobs only
- hide financial data
- dashboard access and widget-level visibility
- restrict client job history
- restrict other users' jobs
- restrict reports

### Field operations

- provider enabled
- call masking
- phone calling access
- location tracking
- collect payment on site
- view assigned client details

## 8. Workiz-like restrictions adapted to Blanc

1. `Assigned jobs only` должно ограничивать:
   - списки jobs;
   - доступ к карточке job;
   - client threads, связанные с job;
   - сообщения клиентов по этим job;
   - related contact/job history, если явно не выдано дополнительное право.
2. `Financial data hidden` должно скрывать:
   - цены, totals, costs, маржу;
   - payment collection actions;
   - finance exports и finance dashboards.
3. `Close jobs disabled` должно переводить field flow в `done pending approval`, а не просто ломать кнопку.
4. `Client job history` должно быть отдельным правом поверх доступа к assigned job.
5. `Dashboard restrictions` должны поддерживать как минимум:
   - полное скрытие dashboard;
   - widget-level visibility.

## 9. Enforcement and audit

1. Backend должен вычислять effective permissions на каждый запрос.
2. Frontend navigation и route guards должны использовать effective permissions, а не только hardcoded roles.
3. Все критичные изменения должны идти в audit:
   - company created/updated/suspended
   - role created/updated/deactivated
   - membership created/updated/disabled/enabled
   - first admin bootstrap
   - permission change
   - super admin assignment/revocation
4. Ошибки доступа должны быть audit-logged без утечки tenant data.

## 10. Совместимость и rollout constraints

1. `Keycloak` остаётся и не заменяется собственным auth UI.
2. Текущие страницы и API нельзя ломать big-bang способом.
3. `company_admin/company_member` должны быть поддержаны как migration mapping до полного перехода на фиксированные системные роли.
4. `ProtectedRoute roles=[...]` и `requireRole(...)` должны считаться transitional API.
5. PF007 должен быть реализован так, чтобы не блокировать уже подготовленные PF001..PF006, а стать для них foundation.

---

## Out of scope

- `Subcontractors`
- `Franchises`
- tenant impersonation
- cross-tenant user switching
- billing/seats automation
- SCIM / SSO enterprise provisioning

---

## Acceptance criteria

1. Платформа умеет создать вторую и последующие компании без shared tenant data.
2. `super_admin` не может открыть tenant business route и получить данные компании.
3. Tenant company нельзя оставить без активного admin.
4. Первый пользователь новой компании всегда получает tenant-admin роль.
5. В tenant settings есть отдельные surfaces `Team Management` и `Roles & Permissions`.
6. Есть 4 фиксированные системные роли, и tenant-admin может настраивать их permission matrix без создания custom roles.
7. Права применяются и в UI, и на backend.
8. `Assigned jobs only` и `financial data hidden` работают end-to-end.
9. User profile хранит field-tech и dispatch-related атрибуты, а не только email/role/status.
10. Текущий `phone_calls_allowed` встроен в общую модель доступов.
11. Platform admin управляет компаниями, но не читает tenant records.
12. Tenant-admin может включать granular permission toggles в профиле сотрудника поверх выбранной системной роли.
13. Все критичные изменения логируются в audit.

---

## External references used

- [How to add new team members to your Workiz account](https://help.workiz.com/hc/en-us/articles/18055926512401-How-to-add-new-team-members-to-your-Workiz-account)
- [Customizing team roles and permissions](https://help.workiz.com/hc/en-us/articles/18055878133521-Customizing-team-roles-and-permissions)
- [Managing user profiles](https://help.workiz.com/hc/en-us/articles/26943133124753-Managing-user-profiles)
- [Restricting a user to assigned jobs](https://help.workiz.com/hc/en-us/articles/18055840325521-Restricting-a-user-to-assigned-jobs)
- [Restricting users from seeing financial data](https://help.workiz.com/hc/en-us/articles/18055859340305-Restricting-users-from-seeing-financial-data)
- [Setting dashboard restrictions](https://help.workiz.com/hc/en-us/articles/18055801551633-Setting-dashboard-restrictions)
- [How to prevent technicians from closing jobs](https://help.workiz.com/hc/en-us/articles/33826850336017-How-to-prevent-technicians-from-closing-jobs)
- [How to allow techs to charge credit cards](https://help.workiz.com/hc/en-us/articles/18053144301457-How-to-allow-techs-to-charge-credit-cards)
- [Updating a team member's service areas](https://help.workiz.com/hc/en-us/articles/18054314328977-Updating-a-team-member-s-service-areas)
- [Updating a team member's skills](https://help.workiz.com/hc/en-us/articles/18054331026065-Updating-a-team-member-s-skills)
- [Tracking your team's location in Workiz](https://help.workiz.com/hc/en-us/articles/18055856754833-Tracking-your-team-s-location-in-Workiz)
- Zenbooker roles/permissions model excerpt provided by user in task context: fixed roles (`Worker`, `Scheduler`, `Manager`) plus granular permission toggles in employee profile, editable only by admin. In Blanc this maps to `Provider`, `Dispatcher`, `Manager`.
