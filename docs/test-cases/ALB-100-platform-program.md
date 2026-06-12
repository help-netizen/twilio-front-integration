# ALB-100 — Test Cases

## ALB-105 Sanitizer (unit, P0)
- TC-105-01: файл-роут с `req.user?.company_id` → тест падает с именем файла.
- TC-105-02: SQL с `'${companyId}'` интерполяцией → падает.
- TC-105-03: чистые файлы → проходит.

## ALB-101 Public auth (unit/integration, P0)
- TC-101-01: otp/send нормализует телефон, пишет hash (не код), TTL 5 мин.
- TC-101-02: 6-я отправка за час → 429 OTP_RATE_LIMITED.
- TC-101-03: verify с неверным кодом ×3 → 410 на 4-й, код consumed.
- TC-101-04: verify ok → otp_token (JWT purpose), повторный verify → 410.
- TC-101-05: signup существующего email → 200 ok (анти-enumeration).
- TC-101-06: FEATURE_SELF_SIGNUP=false → 503 на всех /api/public/*.
- TC-101-07: onboarding без otp_token → 422; с чужим purpose → 401.
- TC-101-08: onboarding повторно (уже есть membership) → 409.
- TC-101-09: bootstrapCompany создаёт company+membership+role configs+profile
  одной транзакцией; повторный вызов идемпотентен.
- TC-101-10: places/suggest без ключа → 200 { suggestions: [] }.

## 2FA trusted devices (P0)
- TC-2FA-01: authenticate без cookie при FEATURE_SMS_2FA=on и наличии телефона
  → 401 PHONE_VERIFICATION_REQUIRED.
- TC-2FA-02: trust-device с валидным otp_token → cookie + строка в БД; повторный
  запрос проходит.
- TC-2FA-03: revoked/expired device row → снова 401.
- TC-2FA-04: пользователь без телефона → проходит без 2FA (legacy grace).
- TC-2FA-05: смена телефона через PATCH /api/users/:id → trusted_devices revoked.

## ALB-102 Platform companies (P0)
- TC-102-01: GET list требует platform super_admin (tenant_admin → 403).
- TC-102-02: PATCH suspend → companies.status=suspended + audit; tenant-роут
  компании → 403 COMPANY_SUSPENDED.
- TC-102-03: GET :id чужого/несуществующего id → 404.

## ALB-103 HARDENING-002 (P0)
- TC-103-01: /api/calls list требует reports.calls.view; запрос company-scoped.
- TC-103-02: /api/messaging send требует messages.send.
- TC-103-03: leads detail чужой компании → 404.
- TC-103-04: provider (assigned_only) видит только звонки своих клиентов.
- TC-103-05: email threads company-scoped; чужой id → 404.

## ALB-104 Provider bridge UI (manual, P1)
- TC-104-01: тумблер provider + выбор из ростера → PATCH с
  zenbooker_team_member_id; зелёная точка.
- TC-104-02: ростер недоступен → ручной ввод id.
- TC-104-03: Unlink → null, провайдер теряет видимость джобов.

## ALB-106 (P0)
- TC-106-01: /api/admin/* с tenant_admin токеном → 403; с platform_role
  super_admin → 200.
- TC-106-02: realm-роль super_admin БЕЗ platform_role → 403 (компат закрыт).
- TC-106-03: видимых строк "Blanc" в UI нет (grep по dist/исходникам страниц).
