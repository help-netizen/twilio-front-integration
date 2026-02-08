# CRM Auth & User Management — Production Checklist (YAML + Markdown)

```yaml
meta:
  title: "CRM Auth & User Management Production Checklist"
  version: "1.0"
  date: "2026-02-08"
  owner: "CRM Platform Team"
  environment: "production"
  priority: "P0"
  status: "ready_for_implementation"

problem_statement:
  summary: >
    Все страницы и API самописной CRM внутри домена должны быть доступны
    только после авторизации, с разграничением прав доступа по ролям,
    централизованным управлением пользователями и аудитом действий.
  business_goal:
    - "Убрать анонимный доступ ко всем внутренним страницам CRM"
    - "Внедрить стабильный RBAC без кастомного велосипеда"
    - "Обеспечить управляемость пользователей/ролей и аудит"

architecture_decision:
  selected_stack:
    - "Keycloak (IdP, SSO, users/roles, policies)"
    - "OAuth2 Proxy (auth gateway перед CRM)"
    - "Nginx/Traefik (reverse proxy / ingress)"
    - "Redis (shared session store для OAuth2 Proxy)"
    - "PostgreSQL (CRM БД, user shadow profile)"
  pattern: "IdP + Auth Gateway + App-level RBAC"
  why_this:
    - "Минимум кастомной auth-логики в CRM"
    - "Централизованное управление доступом"
    - "Горизонтально масштабируемо"

scope:
  in_scope:
    - "100% страниц CRM за авторизацией"
    - "RBAC для UI и API"
    - "Provisioning пользователей и ролей"
    - "SSO/logout, session management, audit trail"
  out_of_scope:
    - "Внешний customer-portal (если есть)"
    - "SSO между независимыми сторонними продуктами (фаза 2)"

production_settings:
  keycloak:
    realm: "crm-prod"
    login:
      user_registration: false
      forgot_password: true
      verify_email: true
      login_with_email_allowed: true
      duplicate_emails_allowed: false
      remember_me: false
    sessions:
      sso_session_idle: "30m"
      sso_session_max: "10h"
      client_session_idle: "30m"
      client_session_max: "10h"
      offline_session_idle: "30d"
      offline_session_max_limited: true
      offline_session_max: "60d"
    tokens:
      access_token_lifespan: "5m"
      access_token_lifespan_for_implicit: "0 (implicit disabled)"
      revoke_refresh_token: true
      refresh_token_max_reuse: 0
    security_defenses:
      brute_force_detection: true
      brute_force_mode: "Lockout temporarily"
      max_login_failures: 8
      quick_login_check_milliseconds: 1000
      minimum_quick_login_wait: "1m"
      wait_increment: "1m"
      max_wait: "15m"
      failure_reset_time: "12h"
    required_actions_defaults:
      - "VERIFY_EMAIL: ON"
      - "UPDATE_PROFILE: ON"
      - "CONFIGURE_TOTP: ON for privileged roles (admin/accounting/support)"
      - "TERMS_AND_CONDITIONS: ON (если требуется юридически)"
    events_audit:
      user_events_save: true
      admin_events_save: true
      include_representation: true
      expiration_days: 90
      forward_to_siem: true

  keycloak_client_crm:
    client_id: "crm-web"
    protocol: "openid-connect"
    client_authentication: true
    standard_flow_enabled: true
    direct_access_grants_enabled: false
    implicit_flow_enabled: false
    service_accounts_enabled: false
    pkce_code_challenge_method: "S256"
    valid_redirect_uris:
      - "https://crm.example.com/oauth2/callback"
    valid_post_logout_redirect_uris:
      - "https://crm.example.com/"
    web_origins:
      - "https://crm.example.com"
    full_scope_allowed: false
    protocol_mappers:
      - "audience mapper for crm-web"
      - "groups mapper (if using group-based authz)"
      - "realm/client roles in token"

  oauth2_proxy:
    provider: "keycloak-oidc"
    oidc_issuer_url: "https://sso.example.com/realms/crm-prod"
    redirect_url: "https://crm.example.com/oauth2/callback"
    upstreams:
      - "http://crm-app:3000"
    session_store_type: "redis"
    set_xauthrequest: true
    pass_authorization_header: true
    pass_access_token: true
    cookie:
      name: "__Host-crm_sso"
      secure: true
      httponly: true
      samesite: "lax"
      path: "/"
      expire: "8h"
      refresh: "5m"
      csrf_expire: "30m"
    reverse_proxy: true
    trusted_ips:
      - "ingress/loadbalancer subnets only"

  ingress_nginx:
    protect_all_routes: true
    allow_unauthenticated_routes:
      - "/oauth2/*"
      - "/healthz"
      - "/readyz"
    auth_request: "/oauth2/auth"
    forwarded_headers_from_trusted_proxy_only: true
    force_https: true
    hsts_enabled: true

data_model_requirements:
  crm_user_shadow_table:
    table: "crm_users"
    fields:
      - "id (uuid pk)"
      - "keycloak_sub (unique)"
      - "email"
      - "full_name"
      - "status (active|disabled)"
      - "last_login_at"
      - "created_at"
      - "updated_at"
    notes:
      - "Источник истины по identity/roles — Keycloak"
      - "Локально хранить только бизнес-поля и служебный профиль"
  audit_tables:
    - "auth_events"
    - "permission_denials"
    - "admin_actions"

rbac_model:
  roles:
    - "owner_admin"
    - "dispatcher"
    - "technician"
    - "accountant"
    - "viewer"
  policy_rules:
    - "deny by default"
    - "UI route guard + API policy guard"
    - "каждый backend endpoint имеет required_role/scope"

tasks:
  - id: "AUTH-01"
    title: "Развернуть Keycloak production (HA-ready)"
    formulation: "Поднять Keycloak в production с резервированием, TLS и backup."
    requirements:
      - "Работать в режиме @orchestrator.md."
    dependencies: []
    estimate: "2d"
    acceptance_criteria:
      - "Доступен realm crm-prod"
      - "TLS и backup/restore проверены"

  - id: "AUTH-02"
    title: "Настроить realm, flows, required actions, defenses"
    formulation: "Включить политики безопасности, required actions, TTL и event audit."
    requirements:
      - "Работать в режиме @orchestrator.md."
    dependencies: ["AUTH-01"]
    estimate: "2d"
    acceptance_criteria:
      - "Все настройки из production_settings.keycloak применены"
      - "Brute force и audit включены"

  - id: "AUTH-03"
    title: "Создать client crm-web + mappers"
    formulation: "Настроить OIDC client для CRM по secure baseline."
    requirements:
      - "Работать в режиме @orchestrator.md."
    dependencies: ["AUTH-02"]
    estimate: "1d"
    acceptance_criteria:
      - "redirect URI и web origins заданы точно"
      - "direct grants выключен"
      - "roles/groups приходят в токен"

  - id: "AUTH-04"
    title: "Внедрить OAuth2 Proxy + Redis + Ingress auth_request"
    formulation: "Закрыть весь домен CRM через auth gateway."
    requirements:
      - "Работать в режиме @orchestrator.md."
    dependencies: ["AUTH-03"]
    estimate: "2d"
    acceptance_criteria:
      - "Анонимный доступ к CRM невозможен"
      - "Сессии стабильны при >1 replica"

  - id: "AUTH-05"
    title: "Реализовать backend RBAC middleware"
    formulation: "Проверка roles/scopes на каждом API endpoint."
    requirements:
      - "Работать в режиме @orchestrator.md."
    dependencies: ["AUTH-03"]
    estimate: "2d"
    acceptance_criteria:
      - "deny-by-default работает"
      - "403 логируется в audit"

  - id: "AUTH-06"
    title: "User provisioning и shadow profile sync"
    formulation: "Создать/обновлять crm_users при первом входе и изменениях профиля."
    requirements:
      - "Работать в режиме @orchestrator.md."
    dependencies: ["AUTH-05"]
    estimate: "2d"
    acceptance_criteria:
      - "keycloak_sub уникален"
      - "деактивация пользователя блокирует вход"

  - id: "AUTH-07"
    title: "Ролевая матрица и UAT"
    formulation: "Провести проверку прав по маршрутам/кнопкам/API."
    requirements:
      - "Работать в режиме @orchestrator.md."
    dependencies: ["AUTH-05", "AUTH-06"]
    estimate: "1d"
    acceptance_criteria:
      - "Нет privilege escalation"
      - "Матрица ролей согласована бизнесом"

  - id: "AUTH-08"
    title: "Go-live checklist и post-launch monitoring"
    formulation: "Запуск и контроль auth метрик/ошибок/инцидентов."
    requirements:
      - "Работать в режиме @orchestrator.md."
    dependencies: ["AUTH-07"]
    estimate: "1d"
    acceptance_criteria:
      - "Login success rate >= 99%"
      - "p95 login <= 1.5s"
      - "Алерты настроены"
```

---

## Production Checklist

### 1) Go-Live: Keycloak Realm
- [ ] Создан realm `crm-prod`
- [ ] `Verify Email` включён
- [ ] `User Registration` выключен
- [ ] `Brute Force Detection` включен (temporary lockout)
- [ ] Настроены `SSO Session Idle/Max`, `Client Session Idle/Max`
- [ ] `Access Token Lifespan = 5m`
- [ ] `Revoke Refresh Token = ON`, `Refresh Token Max Reuse = 0`
- [ ] Включены `User Events` + `Admin Events`, retention 90 дней
- [ ] Включены required actions по профилю ролей

### 2) Go-Live: Keycloak Client (`crm-web`)
- [ ] `OpenID Connect` client создан
- [ ] `Client authentication = ON` (confidential client)
- [ ] `Standard Flow = ON`
- [ ] `Direct Access Grants = OFF`
- [ ] `Valid Redirect URIs` только точные, без `*`
- [ ] `Web Origins` только точные
- [ ] `Audience mapper` добавлен
- [ ] `groups/roles mappers` добавлены
- [ ] `Full Scope Allowed = OFF`

### 3) Go-Live: OAuth2 Proxy + Ingress
- [ ] Все бизнес-роуты CRM закрыты через `auth_request`
- [ ] Разрешены без auth только `/oauth2/*`, `/healthz`, `/readyz`
- [ ] `cookie_secure=true`, `cookie_httponly=true`
- [ ] `cookie_name` с префиксом `__Host-`
- [ ] `cookie_samesite=lax` (или `none`, если нужен cross-site)
- [ ] Session store = Redis (не in-memory)
- [ ] `trusted_ips` ограничены подсетями ingress/LB
- [ ] Только HTTPS + HSTS

### 4) Backend RBAC
- [ ] В каждом endpoint задан required role/scope
- [ ] Политика `deny by default`
- [ ] UI скрывает недоступные действия по claims
- [ ] Сервер повторно валидирует права (UI не источник истины)
- [ ] Все 401/403 пишутся в audit log

### 5) User Lifecycle
- [ ] Автосоздание `crm_users` при первом входе
- [ ] Связь с IdP по `keycloak_sub` (unique)
- [ ] Деактивация в Keycloak блокирует доступ в CRM
- [ ] Password reset / email verify процессы протестированы
- [ ] Onboarding/offboarding регламент утвержден

### 6) Security Hardening
- [ ] Админ endpoints Keycloak не торчат наружу
- [ ] Прокси доверяет `X-Forwarded-*` только trusted proxy
- [ ] Secret rotation и хранение секретов через vault/secret manager
- [ ] Алёрты на brute-force/login spikes
- [ ] Еженедельный аудит ролей и “лишних” прав

### 7) Нагрузочные и отказоустойчивые тесты
- [ ] 200+ одновременных логинов без деградации
- [ ] Перезапуск 1 pod OAuth2 Proxy не ломает сессии
- [ ] Перезапуск CRM app не требует повторного логина у всех
- [ ] Проверен сценарий недоступности Keycloak (graceful fail)

---

## Шаблон матрицы ролей (заполнить под вашу CRM)

| Модуль / Действие | owner_admin | dispatcher | technician | accountant | viewer |
|---|---|---|---|---|---|
| Dashboard (R) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Calls (R/U) | ✅ | ✅ | R | R | R |
| Jobs (C/R/U/D) | ✅ | ✅ | R/U (own) | R | R |
| Customers (C/R/U) | ✅ | ✅ | R | R | R |
| Billing/Invoices (C/R/U) | ✅ | R | ❌ | ✅ | R |
| Users & Roles (C/R/U/D) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Settings / Integrations (U) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Audit Log (R) | ✅ | R | ❌ | R | R |

---

## Notes
- Источник истины по identity/roles: Keycloak.
- В CRM хранить только shadow profile + доменные поля.
- Проверка прав обязательна на backend для каждого API endpoint.
