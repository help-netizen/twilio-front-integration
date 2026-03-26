# Тест-кейсы: PF102 Sprint 3 — Tenant Team Management MVP

## Priority P0
- **Тест 01 (E2E):** `tenant_admin` создает нового пользователя с ролью `dispatcher` и профилем `phone_calls_allowed=true`. Проверка, что в базе создана запись `company_user_profiles`.
- **Тест 02 (Unit/Integration):** Запрос на изменение роли последнего `tenant_admin` на `dispatcher` должен вернуть ошибку `400 LAST_ADMIN_REQUIRED`.
- **Тест 03 (Unit/Integration):** Деактивация последнего администратора должна отклоняться.

## Priority P1
- **Тест 04 (API):** `PATCH /api/users/:id` успешно обновляет цвет расписания сотрудника (`schedule_color`) внутри `company_user_profiles`.
- **Тест 05 (Frontend):** На странице CompanyUsers кнопка "Disable" для своего собственного пользователя либо заблокирована (если последний админ), либо вызывает предупреждающий диалог.
- **Тест 06 (E2E):** Если указан email уже существующего в глобальной системе пользователя, он успешно прикрепляется к новой компании с новой ролью, вместо ошибки дублирования Keycloak.

## Priority P2
- **Тест 07 (UI):** Выпадающий список ролей при редактировании пользователя obsahuje только новые системные роли (`tenant_admin`, `manager`, `dispatcher`, `provider`).
