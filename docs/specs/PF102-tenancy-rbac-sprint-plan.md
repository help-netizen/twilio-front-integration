# Спецификация: PF102 — Tenancy / RBAC Sprint Plan

**Дата:** 2026-03-24
**Статус:** Proposed
**Основа:** `PF007`

---

## Цель

Разложить PF007 на последовательность спринтов так, чтобы:

- сначала убрать архитектурный риск `super_admin -> tenant bypass`;
- не ломать текущие `users`, `settings`, `telephony`, `payments`, `pulse`;
- подготовить foundation для PF001..PF006, а не спорить с ними позднее;
- перевести проект с role enum на полноценный tenant RBAC поэтапно.

---

## Планирующие принципы

1. Сначала разделяется `platform scope` и `tenant scope`, потом расширяется UI.
2. `Keycloak` не меняется как auth-provider; меняется только authorization model вокруг него.
3. Нельзя начинать PF001..PF006 как массовый rollout по нескольким tenant-компаниям до завершения минимум Sprint 3 этого пакета.
4. На каждом этапе должен оставаться совместимый migration path для текущих `company_admin/company_member`.

---

## Sprint 1 — Authz Foundation and Invariants

### Цель

Зафиксировать целевую authorization model и убрать опасный `super_admin` bypass.

### Scope

- canonical authz contract:
  - platform role
  - tenant membership
  - effective permissions
  - advanced scopes
- правило `super_admin is platform-only`
- правило `at least one tenant admin`
- правило `first user is admin`
- mapping current `company_admin/company_member` -> fixed system roles
- правило `only tenant admin edits role matrices and employee permission overrides`
- audit requirements for access denials and role changes

### Exit criteria

- утверждена доменная модель ролей и membership invariant;
- tenant routes больше не проектируются с допущением `super_admin sees all`;
- PF001..PF006 получают target permission model для своих future endpoints.

---

## Sprint 2 — Platform Super Admin and Company Lifecycle

### Цель

Запустить platform-only company administration.

### Scope

- company directory
- company card
- create company
- bootstrap first tenant admin
- activate/suspend/archive company
- platform audit visibility
- расширение `SuperAdmin` workspace без tenant business data

### Exit criteria

- можно создать новую tenant-компанию без ручных DB операций;
- `super_admin` управляет компаниями, но не может открыть tenant business routes;
- onboarding state компании прозрачен для платформы.

---

## Sprint 3 — Tenant Team Management MVP

### Цель

Превратить текущий `Company Users` в usable tenant user-management surface.

### Scope

- list/filter/search users
- invite/create user
- enable/disable user
- change role
- reset/resend invite flows
- first-class company user profile:
  - phone
  - status
  - provider flag
  - phone calls allowed
  - schedule color
  - call masking
  - location tracking

### Exit criteria

- tenant admin управляет командой без ручных обходов через Keycloak console;
- last-admin invariant соблюдается end-to-end;
- user profile больше не ограничен только `role/status`.

---

## Sprint 4 — Roles & Permissions

### Цель

Внедрить fixed system roles, company-level permission matrices и employee-level granular overrides.

### Scope

- seeded roles:
  - `Tenant Admin`
  - `Manager`
  - `Dispatcher`
  - `Provider`
- `Roles & Permissions` page
- permission categories:
  - `Actions`
  - `Reports`
  - `Advanced`
- company-level matrix editor for fixed roles
- employee-profile permission toggles for selected role
- permission-aware navigation and route guards
- backend permission middleware foundation

### Exit criteria

- кастомные роли не создаются; каждая компания настраивает матрицу прав для фиксированного набора системных ролей;
- frontend navigation и backend route protection завязаны на effective permissions;
- `company_admin/company_member` остаются только compatibility mapping.

---

## Sprint 5 — Advanced Restrictions and Field Ops Scopes

### Цель

Довести RBAC до Workiz-like operational granularity.

### Scope

- `assigned jobs only`
- `financial data hidden`
- `dashboard/widgets`
- `close jobs`
- `collect payments`
- `client job history`
- `service areas`
- `skills/job types`
- telephony and phone access scopes
- schedule-readiness scopes for dispatch/provider

### Exit criteria

- provider и dispatcher различаются не только видимостью меню, но и фактической data scope;
- finance and dashboard restrictions работают в API и UI;
- профиль пользователя начинает влиять на future `Schedule / Jobs assignment` сценарии.

---

## Sprint 6 — Hardening, Migration, Rollout Gate

### Цель

Закрыть migration debt и сделать PF007 официальным foundation для следующей волны фич.

### Scope

- migrate legacy route guards
- remove unsafe super-admin shortcuts
- compatibility adapters for `/api/users`
- audit completeness
- regression and UAT checklist
- rollout plan for multiple tenant companies

### Exit criteria

- основные tenant routes используют permission-based checks;
- нет известных global bypass paths для tenant data;
- можно запускать PF100 Sprint 1+ на новой tenant/RBAC foundation.

---

## Что идёт после PF102

После завершения этого пакета roadmap продолжается через `PF100-p0-sprint-plan.md`:

1. `Schedule / Dispatcher`
2. `Estimates`
3. `Invoices`
4. `Payment Collection`
5. `Client Portal`
6. `Automation Engine`

Но уже поверх tenant-safe authorization model.
