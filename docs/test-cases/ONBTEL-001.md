# ONBTEL-001 — Test Cases

**Статус:** Test Cases · **Дата:** 2026-07-02 · **Автор:** Agent 04 (Test Cases)
**Спецификация (первоисточник):** `Docs/specs/ONBTEL-001.md` (сценарии A1–A8, матрицы E-A1–E-A12, E-B1–E-B20, E-C1–E-C20, §9 обязательные файлы тестов)
**Требования:** `Docs/requirements.md` §«Фича ONBTEL-001» · **Архитектура:** `Docs/architecture.md` §«ONBTEL-001»

**Типы тестов:**
- `unit-jest` / `integration-jest` — backend Jest (фронтенд-харнесса НЕТ). Прогон в worktree строго с флагом:
  `npx jest --runTestsByPath tests/<file>.test.js --testPathIgnorePatterns "/node_modules/"`
- `migration-DB` — прогон РЕАЛЬНОГО SQL миграций в one-off контейнере против **копии prod DB** (`docker compose run app …`, урок LIST-PAGINATION-001). Мокнутый Jest проверяет только SQL-строки — этого недостаточно для миграций.
- `manual-preview` — ручная проверка во фронтенд dev-preview + `npm run build` (tsc -b; prod-сборка строже — `noUnusedLocals`). Вьюпорты: **desktop 1280×800**, **mobile 390×844** (где указано).
- `build` / `structural` — сборка / git-diff-проверка защищённых файлов.

**Правило P0:** безопасность/изоляция (401/403-матрицы, кросс-tenant, C1 reject-матрица, C5 fail-closed, C2b master-sync bind, payg-активация без Stripe, валидация `return_path`) и байт-в-байт регрессии Boston Masters (DEFAULT `00000000-0000-0000-0000-000000000001`).

## Покрытие

| Секция | Файл / вид | Кейсы | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A. Чеклист — backend | `tests/onboardingChecklist.test.js` | 16 | 9 | 3 | 4 | — |
| A. Чеклист — frontend | manual-preview | 8 | 2 | 3 | 3 | — |
| B. Биллинг PAYG + return_path | `tests/billingPaygSubscribe.test.js` | 14 | 8 | 4 | 2 | — |
| B. Marketplace overlay | `tests/marketplaceTelephonyOverlay.test.js` | 10 | 6 | 3 | 1 | — |
| B. Миграции 145/146 | migration-DB | 5 | — | 3 | 2 | — |
| B. Визард/плитка/redirect — frontend | manual-preview | 19 | 5 | 10 | 4 | — |
| C. Inbound-изоляция + C2b | `tests/twilioInboundIsolation.test.js` | 15 | 7 | 6 | 2 | — |
| C. Softphone-токен | `tests/voiceTokenFailClosed.test.js` | 7 | 5 | 2 | — | — |
| C. Миграции 147/148 | migration-DB | 9 | 4 | 2 | 2 | 1 |
| C. Softphone-деградация — frontend | manual-preview | 1 | — | 1 | — | — |
| R. Регрессии (MUST stay green) | смешанный | 8 | 6 | 2 | — | — |
| **Итого** | | **112** | **52** | **39** | **20** | **1** |

Все 5 обязательных jest-файлов из спеки §9 покрыты конкретными списками кейсов. Каждая строка edge-матриц E-A*/E-B*/E-C* отображена на ≥1 TC либо явно помечена N/A с причиной (см. §12 «Трассируемость»).

**Общие тестовые данные:**
- `DEFAULT = '00000000-0000-0000-0000-000000000001'` (Boston Masters, seed); `COMPANY_A = '11111111-…-1111'`; `COMPANY_B = '22222222-…-2222'`.
- Master AccountSid: `process.env.TWILIO_ACCOUNT_SID = 'ACmaster000…'` (выставлять в тесте); субаккаунт `'ACsub111…'`; неизвестный `'ACghost999…'`.
- Номера: `+15085550001` (есть строка `phone_number_settings` COMPANY_A), `+15085559999` (нет строки нигде).
- Планы: `payg` (base 0, `max_phone_numbers=1`), `starter` $49, `trial` $0.

---

## 1. Часть A — `tests/onboardingChecklist.test.js` (обязательный файл, спека §9)

**Стратегия моков (канон дома):** `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))`; route-уровень — mini-express + supertest либо прямой вызов handler'а с req-моком `{ user, authz: { membership: { role_key } }, companyFilter: { company_id } }` (прецеденты: `tests/keycloakAuth.test.js`, `tests/contactsPulseTenantIsolation.test.js`, `tests/orphanTaskRehome.test.js` — assert на emitted SQL + params + порядок вызовов). 401-ветки — через реальный `authenticate` (как в `keycloakAuth.test.js`). Сервис: `backend/src/services/onboardingChecklistService.js`.

| ID | P | Тип | Given / шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-A-01 | P0 | integration-jest | `GET /api/onboarding/checklist` без Authorization | 401 `{code:'AUTH_REQUIRED', message, trace_id}`; handler/db не вызваны | §1.3 |
| TC-A-02 | P0 | integration-jest | Невалидный/просроченный токен | 401 `{code:'AUTH_INVALID'}` | §1.3 |
| TC-A-03 | P0 | integration-jest | platform-only пользователь (super_admin, без tenant-scope) | 403 `{code:'PLATFORM_SCOPE_ONLY', message:'Platform admins cannot access tenant resources.'}`; **ноль** обращений к БД чеклиста (403 ДО чтений/записей) | E-A6 |
| TC-A-04 | P0 | integration-jest | Авторизован, membership нет (`authz.company=null`) | 403 `{code:'TENANT_CONTEXT_REQUIRED', message:'No company association found'}`; ноль обращений к БД | E-A7 |
| TC-A-05 | P0 | integration-jest | Параметризовано по `role_key ∈ {manager, dispatcher, provider}` с активным membership | 403 `{code:'TENANT_ADMIN_ONLY', message:'Tenant admin role required'}`; ноль чтений/записей чеклиста (в т.ч. write-once НЕ выполняется). Гейт — inline `role_key==='tenant_admin'`, НЕ `requireRole('company_admin')` (тот пропускает manager) | E-A5, §1.3 |
| TC-A-06 | P2 | integration-jest | dev-mode: `req.user._devMode === true`, роль отсутствует | Пропуск admin-гейта → 200 (как всюду в проекте) | §1.3 |
| TC-A-07 | P0 | integration-jest | tenant_admin COMPANY_A; mock db: `EXISTS phone_number_settings` → false; `settings#>>'{onboarding_checklist,completed_at}'` → null | 200 `{ok:true, checklist:{visible:true, completed_at:null, items:[{key:'connect_telephony', done:false, title:'Connect telephony', cta:{label:'Set up', path:'/settings/integrations/telephony-twilio'}}]}}` | A1 |
| TC-A-08 | P0 | integration-jest | tenant_admin; EXISTS → true; completed_at → null (первый GET after all-done; сценарий Boston Masters/A6 тоже) | 200 `visible:false`; выполнен **ровно один** идемпотентный `UPDATE companies SET settings=jsonb_set(…)` c guard `WHERE …completed_at IS NULL` и `WHERE id=$1` (=COMPANY_A); бэкфилл-миграции не требуется | E-A1, A4, A6 |
| TC-A-09 | P0 | unit-jest | completed_at уже установлен (`'2026-07-01T…'`), EXISTS → true | 200 `visible:false`, `completed_at` = существующее значение; `UPDATE` **не вызывается вовсе** (write-once, не перезаписывается) | §1.1, §1.2 |
| TC-A-10 | P0 | unit-jest | Вызов с `req.companyFilter.company_id=COMPANY_A`; в query/body подсунут `company_id=COMPANY_B` | Все SQL (`EXISTS … WHERE company_id=$1`, `UPDATE companies WHERE id=$1`) получают параметр COMPANY_A; payload-значение никуда не попадает (endpoint без параметров by construction); данные COMPANY_B (номера есть) не влияют на ответ A (visible:true) | §8 |
| TC-A-11 | P1 | unit-jest | completed_at установлен, но derived done=false (номер released ПОСЛЕ фиксации; эквивалентно будущему невыполненному пункту каталога) | `visible:false` навсегда; completed_at не сброшен; UPDATE не вызван | E-A3, E-A11 |
| TC-A-12 | P1 | unit-jest | Номер куплен и released ДО какого-либо GET (EXISTS → false, completed_at → null) | `visible:true`, `completed_at:null`, item done:false — фиксации не было | E-A4 |
| TC-A-13 | P2 | unit-jest | Конкурентный GET: guard-UPDATE возвращает `rowCount:0` (первый писатель успел) | Без ошибки; ответ всё равно `visible:false` (второй — no-op) | E-A2 |
| TC-A-14 | P2 | unit-jest | allDone, но guard-UPDATE бросает (DB error) | Ответ 200 `visible:false` (visible считается и от allDone), НЕ 500; запись повторится следующим GET | E-A8 |
| TC-A-15 | P1 | unit-jest | Каталог data-driven: ответ строится из registry сервиса | `items[]` ровно из каталога; нормативные строки §1.3 дословно: title `Connect telephony`, description `Get a business phone number to make and receive calls and texts in Albusto.` (продукт — Albusto, не Blanc), cta.label `Set up` | §1.1, §1.3 |
| TC-A-16 | P2 | integration-jest | EXISTS-запрос бросает | 500 `{ok:false, code:'INTERNAL_ERROR', error:'Failed to load onboarding checklist'}` | §1.3 |

## 2. Часть A — frontend (manual-preview; кода-харнесса нет)

Предусловие всех кейсов: dev-preview, свежая tenant-компания (после `/signup`→`/onboarding`) + учётки manager/dispatcher.

| ID | P | Тип | Шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-A-30 | P0 | manual-preview | tenant_admin открывает `/pulse`. Проверить **оба вьюпорта: 1280×800 и 390×844** | Полноширинная карточка строго между `.blanc-unified-header` и `.pulse-layout`, В ПОТОКЕ (контент сдвинут вниз, не оверлей); заголовок "Get started", eyebrow "Getting started", прогресс "0 of 1 done", пункт "Connect telephony" + описание + кнопка "Set up"; независимый скролл колонок Pulse сохранён на обоих вьюпортах | A1, §1.5 |
| TC-A-31 | P1 | manual-preview | Клик "Set up" | SPA-переход на `/settings/integrations/telephony-twilio` без full reload (Network: нет document-запроса) | A2 |
| TC-A-32 | P1 | manual-preview | Клик collapse (aria-label "Collapse checklist") → reload страницы | Компактная строка: "Get started" + "0 of 1 done" + chevron (aria-label "Expand checklist"); в localStorage ключ `albusto.onb-checklist.collapsed:<companyId>`; состояние переживает reload. Кнопки dismiss/скрыть НЕ существует | A3 |
| TC-A-33 | P0 | manual-preview | Пройти визард Части B до покупки номера → вернуться на `/pulse` (window focus) | Refetch по focus/mount → `visible:false` → карточка исчезла; повторные заходы/reload — карточки нет никогда | A4, E-A1 |
| TC-A-34 | P1 | manual-preview | Открыть `/pulse` под manager/dispatcher/provider; Network tab | Запрос `GET /api/onboarding/checklist` **не отправляется** (`enabled`-гейт `isTenantAdmin()`); карточки нет; страница как сейчас | A5 |
| TC-A-35 | P2 | manual-preview | Заглушить API (5xx/network) devtools'ами | Карточка не рендерится, БЕЗ toast (fail-quiet); Pulse работает | E-A9, A8 |
| TC-A-36 | P2 | manual-preview | Свернуть чеклист в компании A → переключиться на компанию B (без completed_at) | Collapse-ключ per-company: у B карточка развёрнута (состояние A не наследуется) | E-A10 |
| TC-A-37 | P2 | manual-preview | Визуальный аудит карточки | Только Blanc-токены; border `var(--blanc-line)`, radius 16px, без теней и `<hr>`; иконки статуса size-4 `--blanc-ink-3`/`--blanc-success`; в текстах "Albusto", нигде не "Blanc" | §1.5 |

---

## 3. Часть B — `tests/billingPaygSubscribe.test.js` (обязательный файл, спека §9)

**Стратегия моков:** прецедент `tests/billingUI.test.js` — `jest.mock('../backend/src/db/connection')`; no-Stripe ветка = `delete process.env.STRIPE_SECRET_KEY`; платные пути — `jest.mock('../backend/src/services/billing/billingProvider')` (`getProvider().chargeOffSession/createTopupCheckout`); `walletService` мокается. Route `/checkout` — mini-express + supertest.

| ID | P | Тип | Given / шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-B-01 | P0 | unit-jest | `STRIPE_SECRET_KEY` отсутствует; `subscribe(COMPANY_A,'payg')`; план payg загружен (`WHERE id=$1 AND is_active`) | `{activated:true}`; выполнен `UPDATE billing_subscriptions SET plan_id='payg', status='active', updated_at=now() WHERE company_id=$1` (или INSERT-ветка); ветка сработала **ДО** `providerConfigured()` (нет throw `PROVIDER_NOT_CONFIGURED`); `ensureCustomerId`/`chargeOffSession`/`billPlanFee`/`walletService.credit` НЕ вызваны; кошелёк не тронут | E-B3, §2.4 п.2 |
| TC-B-02 | P0 | unit-jest | Тот же no-Stripe env; `subscribe(COMPANY_A,'starter')` (платный) | throw 422 `{code:'PROVIDER_NOT_CONFIGURED', message:'Billing is not enabled yet'}`; подписка НЕ изменена | E-B3 |
| TC-B-03 | P0 | unit-jest | Повторный `subscribe('payg')` после успешного первого | Снова `{activated:true}`; тот же UPDATE тех же значений; дублей подписок нет (PK `company_id`) | E-B2, §2.4 п.3 |
| TC-B-04 | P1 | unit-jest | У компании нет строки `billing_subscriptions` | INSERT-ветка (`ON CONFLICT (company_id) DO UPDATE`-семантика), `{activated:true}`, идемпотентно при повторе | E-B4 |
| TC-B-05 | P0 | unit-jest | Платный `starter`, карта на файле (`wallet.default_payment_method_id` есть), Stripe configured | Существующая логика untouched: `chargeOffSession` → `walletService.credit` → UPDATE подписки → `billPlanFee` → `{activated:true}` (регрессия платного пути) | E-B7, §2.4 п.4 |
| TC-B-06 | P0 | unit-jest | Платный `starter`, карты нет, `return_path` не передан | `createTopupCheckout` с `metadata.plan_id='starter'` и ДЕФОЛТНЫМИ URL `https://app.albusto.com/settings/billing?status=success` / `?status=cancel`; ответ `{url}` | §2.4 |
| TC-B-07 | P0 | integration-jest | `POST /api/billing/checkout` — **полная матрица `return_path` §2.4 (все 10 строк):** отсутствует; `/settings/integrations/telephony-twilio?step=3&billing=success`; `/x`; `//evil.com`; `http://evil.com`; `https://app.albusto.com/x`; `javascript:alert(1)`; `''`; `/a//b`; `/x:y`; число/объект | Отсутствует + оба валидных → OK; **все 7 невалидных → 422 `{ok:false, code:'INVALID_RETURN_PATH', error:'return_path must be a relative path'}`**, при 422 `subscribe` НЕ вызван (никаких side effects) | §2.4 матрица |
| TC-B-08 | P1 | integration-jest | Валидный `return_path='/settings/integrations/telephony-twilio?step=3&billing=success'`, платный план без карты | `successUrl === cancelUrl === 'https://app.albusto.com' + return_path` прокинуты в `createTopupCheckout` (path-only, анти-open-redirect) | §2.4 |
| TC-B-09 | P1 | unit-jest | `subscribe('nonexistent')` / план `is_active=false` | throw 404 `'Plan not available'` | §2.4 п.1 |
| TC-B-10 | P2 | integration-jest | `POST /checkout` без `plan_id` | 422 `{ok:false, error:'plan_id required'}` (существующее поведение, регрессия) | §5 |
| TC-B-11 | P2 | unit-jest | `POST /checkout {plan_id:'trial'}` напрямую (API-путь) | trial ≤ $0 → активация веткой ≤0 → `{activated:true}`; документированный acceptable edge (self-service downgrade, UI не предлагает) | E-B9, §2.4 п.5 |
| TC-B-12 | P0 | integration-jest | Route-матрица `/api/billing/checkout`: (а) без токена; (б) с токеном, но без `tenant.company.manage` | (а) 401; (б) 403 (существующий mount `authenticate + requirePermission('tenant.company.manage') + requireCompanyAccess` не ослаблен). Если уже покрыто `billingUI.test.js` — расширить, не дублировать | §5 |
| TC-B-13 | P0 | integration-jest | `POST /checkout` от COMPANY_A с `company_id: COMPANY_B` в body | `subscribe` вызван с `req.companyFilter.company_id` (=COMPANY_A); body-значение игнорируется; подписка B не тронута | §8 |
| TC-B-14 | P1 | unit-jest | payg при **configured** Stripe И карте на файле | Всё равно ветка ≤0: `{activated:true}` БЕЗ `chargeOffSession`/`billPlanFee`/Stripe-вызовов (ветка стоит до провайдера безусловно) | §2.4 п.2 |

## 4. Часть B — `tests/marketplaceTelephonyOverlay.test.js` (обязательный файл, спека §9)

**Стратегия моков:** точный прецедент `tests/googleEmailMarketplace.test.js` — mock `marketplaceQueries` (строка app `telephony-twilio` c `metadata.derived_connection:true`), mock `telephonyTenantService.getTelephonyState`, остальные top-level requires — стабы; гонять реальный `marketplaceService`.

| ID | P | Тип | Given / шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-B-30 | P0 | unit-jest | `listApps(DEFAULT)`; `getTelephonyState` → `{connected:true, mode:'master', status:'connected'}` | `installation = {id:null, status:'connected', installed_at:null, disconnected_at:null, provisioning_error:null, last_used_at:null, external_installation_id:null}` — Boston Masters сразу Connected (нулевые изменения поведения) | §2.2, E-C18-смежный |
| TC-B-31 | P0 | unit-jest | Субаккаунт подключён: state `{connected:true, mode:'subaccount', connected_at:'2026-07-01…', subaccount_sid:'ACsub111…'}` | `installation.status='connected'`, `installed_at=connected_at`; `id:null`, `external_installation_id:null` | §2.2 |
| TC-B-32 | P0 | unit-jest | Не подключена: state `{connected:false}` | `installation: null` (плитка Available) | §2.2 |
| TC-B-33 | P0 | unit-jest | Строка `company_telephony` есть, `twilio_subaccount_sid IS NULL` (autonomous-mode upsert) → state `{connected:false}` | `installation: null` | E-B11 |
| TC-B-34 | P0 | unit-jest | Для TC-B-31 сериализовать ВЕСЬ ответ `listApps` | `JSON.stringify(result)` НЕ содержит `'ACsub111'` — subaccount_sid наружу не отдаётся ни в одном поле | §2.2, §8 |
| TC-B-35 | P0 | unit-jest | `installApp(COMPANY_A, 'telephony-twilio', …)` | throw `MarketplaceServiceError` **409 `DERIVED_CONNECTION_APP`** `'This app is configured from its setup page.'`; reject ДО создания installation (`createInstallation`/insert НЕ вызван) | E-B12 |
| TC-B-36 | P1 | unit-jest | (а) фиктивный app c `metadata.derived_connection:true`; (б) app без флага (google-email, vapi-ai) | (а) тоже 409 (data-driven, без hardcode app_key); (б) install-путь работает как раньше (не reject) | §2.2 |
| TC-B-37 | P1 | unit-jest | `isAppConnected(companyId,'telephony-twilio')` при connected/не-connected state | true/false — тот же derived-ответ (симметрия с google-email) | §2.2 |
| TC-B-38 | P1 | unit-jest | `listApps` со списком из telephony-twilio + vapi-ai + stripe-payments + google-email | Прочие приложения возвращены ровно как `mapAppRow` их построил (overlay трогает только telephony-twilio; google-email-overlay работает как раньше) | §2.2, регрессия |
| TC-B-39 | P2 | unit-jest | `getTelephonyState` бросает | Ошибка всплывает из `listApps` (→ 500 списка у route) — ровно как у google-email-overlay, спец-резилентности нет | E-B20 |

## 5. Часть B — миграции 145/146 (migration-DB, one-off контейнер против копии prod DB)

| ID | P | Тип | Шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-B-20 | P1 | migration-DB | Прогнать mig 145 → проверить строку → прогнать ПОВТОРНО | Строка `marketplace_apps` `app_key='telephony-twilio'` со ВСЕМИ значениями таблицы §2.1 (name `Telephony — Twilio`, category `telephony`, `provisioning_mode='none'`, status `published`, `requested_scopes=[]`, metadata c `setup_path`/`derived_connection:true`/`access_summary`); повторный прогон — no-op/те же значения (`ON CONFLICT (app_key) DO UPDATE`); `readMigration('145_…')` зарегистрирован в `ensureMarketplaceSchema` после 132 | §2.1 |
| TC-B-21 | P2 | migration-DB | `rollback_145` | Строка app удалена; FK-безопасно (install-строк у приложения не бывает by construction) | §2.1 |
| TC-B-22 | P1 | migration-DB | Прогнать mig 146 → проверить → повторить | Строка `billing_plans` `id='payg'`, name `Pay as you go`, `monthly_base_usd=0`, `included_seats=3`/`per_seat_usd=0`, `metered={"sms":0.03,"call_minutes":0.04,"agent_runs":0}`, `included_units` все 0, `max_phone_numbers=1`, `provider_price_id IS NULL`, `is_active=true`; повтор — идемпотентен (`ON CONFLICT (id) DO UPDATE`) | §2.4 seed |
| TC-B-23 | P2 | migration-DB | `rollback_146` при существующей подписке payg | `is_active=false` (НЕ DELETE); FK из `billing_subscriptions` не ломается | §2.4 |
| TC-B-24 | P1 | migration-DB + integration | После 146: `GET /api/billing` | `plans[]` содержит payg (сортировка по `monthly_base_usd` — существующий SELECT без правок) → визард и BillingPage получают план автоматически | §2.4 side effect |

## 6. Часть B — frontend визард/плитка/redirect (manual-preview)

Предусловия: dev-preview; тестовая компания без телефонии; учётка tenant_admin с `tenant.integrations.manage` + `tenant.telephony.manage` + `tenant.company.manage`; Stripe в test-mode (для B-55). Вьюпорты — desktop 1280, mobile 390 где отмечено.

| ID | P | Тип | Шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-B-50 | P0 | manual-preview | IntegrationsPage — **матрица плитки §2.2 (все 4 состояния):** DEFAULT; субаккаунт подключён; не подключена; строка с NULL SID (autonomous). Desktop 1280 + mobile 390 | DEFAULT/субаккаунт → бейдж **Connected** + кнопка **Manage** (outline) → `navigate('/settings/telephony')`; не подключена/NULL-SID → **Available** + **Configure** (default) → `navigate('/settings/integrations/telephony-twilio')`. Generic Enable/`MarketplaceConnectDialog` для этой плитки недостижимы | §2.2 |
| TC-B-51 | P1 | manual-preview | Открыть `/settings/integrations/telephony-twilio` без `tenant.integrations.manage` | `ProtectedRoute` не пускает (канон соседних страниц VAPI/Stripe) | §2.3 |
| TC-B-52 | P0 | manual-preview | Шаг 1: клик "Connect telephony" → дождаться шага 2 → выйти → зайти в визард снова → повторить клик где доступен | `POST /connect` 200 → best-effort `softphone/setup` (fire-and-forget) → refetch → шаг 2; повторные входы/клики второй субаккаунт НЕ создают (в БД одна строка `company_telephony`; идемпотентность + UNIQUE C3); заголовок "Telephony — Twilio", подзаголовок и копия шага 1 — по §2.3 | E-B1 |
| TC-B-53 | P1 | manual-preview | Шаг 1: (а) заглушить connect → 500; (б) учётка без `tenant.telephony.manage` | (а) inline "Could not connect telephony — try again.", кнопка активна (retry safe); (б) inline "You don't have permission to manage telephony — ask your administrator." | §2.3, E-B15 |
| TC-B-54 | P0 | manual-preview | Шаг 2: карточка PAYG → "Choose Pay as you go" | Карточка: "Pay as you go", "$0/mo", буллеты "Calls $0.04 per minute" / "Texts $0.03 each" / "1 phone number" / "Usage is paid from your wallet"; клик → `{activated:true}` → toast "Plan activated" → refetch → шаг 3. **Принудительного пополнения кошелька НЕТ** | §2.3 шаг 2 |
| TC-B-55 | P1 | manual-preview | Шаг 2: пакет starter → Stripe hosted checkout → (а) оплатить, вернуться ДО вебхука; (б) отменить checkout | Подпись "You'll be redirected to secure checkout."; redirect по `{url}`; возврат на `return_path` c `billing=success`: (а) "Confirming your payment…" + поллинг `GET /api/billing` каждые 3 с → по флипу plan_id → шаг 3; (б) план не активирован → после 60 с подсказка "Still waiting for payment confirmation…" + выбор планов снова доступен | E-B5, E-B6 |
| TC-B-56 | P1 | manual-preview | Шаг 2: пакет при карте на файле | Ответ `{activated:true}` без redirect → сразу шаг 3 | E-B7 |
| TC-B-57 | P1 | manual-preview | Шаг 2: состав планов | PAYG + пакеты starter/pro/huge (`p.id !== 'trial' && p.id !== 'payg'` для пакетного списка); **trial не показывается никогда** | §2.3 шаг 2 |
| TC-B-58 | P0 | manual-preview | Шаг 3: поиск (area code / city / contains / toll-free) → Buy. Desktop 1280 + mobile 390 | ≤15 результатов: номер, locality/region, voice/sms-бейджи, "$1.15/mo" ("$2.15/mo" toll-free); Buy → 201 → refetch → **Completion** ("Telephony is connected" / "Your number is active. Incoming calls and texts will appear in Albusto." + кнопки "Manage telephony" → `/settings/telephony`, "Back to Integrations"). Пустой поиск → "No numbers found — try another area code or city." | §2.3 шаг 3, Completion |
| TC-B-59 | P0 | manual-preview | Шаг 3 на payg с уже 1 номером: Buy второго | 422 `NUMBER_LIMIT` → **upsell-блок обязателен**: серверный текст дословно ("Your Pay as you go plan includes up to 1 phone number. Upgrade your plan to add more.") + строка "Need more numbers? Switch to a package plan." + кнопка "View plans" → переключение на шаг 2; дальнейшая покупка невозможна до апгрейда | E-B8 |
| TC-B-60 | P2 | manual-preview | Шаг 3: эмулировать 409 `NUMBER_UNAVAILABLE` (Twilio 21422) | Toast текстом сервера ("This number was just taken — pick another one"); результат убирается/поиск обновляется. 500 → toast "Failed to buy the number" | E-B14 |
| TC-B-61 | P1 | manual-preview | **Матрица повторного входа §2.3 (все 6 строк)** + `?step=3` при невыполненном шаге 1 | ✗✗✗→Шаг 1; ✓✗✗→Шаг 2; ✓✓✗→Шаг 3; ✓✓✓→Completion; ✗✓✗→Шаг 1 (шаг 2 отмечен ✓); ✓✗✓→Шаг 2 (шаг 3 отмечен ✓). `?step=` — только подсказка: derived-шаг побеждает. Степпер: выполненные — галочка + кликабельны назад; вперёд дальше активного — заблокировано | §2.3, E-B16 |
| TC-B-62 | P1 | manual-preview | Экран Completion + возврат на `/pulse` | Пункт чеклиста Части A выполнился сам (derived, refetch по focus) — сквозной e2e A4+B | §2.3 |
| TC-B-63 | P1 | manual-preview | **Redirect-матрица TelephonyLayout §2.5 (все 5 строк):** загрузка; connected (вкл. DEFAULT); not-connected + `tenant.integrations.manage`; not-connected без права; ошибка статуса (заглушить 500) | Загрузка → ничего (ни nav, ни children, без flash); connected → рендер byte-identical (mobile 390: top tab strip телефонии как сейчас); not-connected+perm → `<Navigate to="/settings/integrations/telephony-twilio" replace />`; not-connected без perm → empty-state "Telephony is not connected yet — ask your administrator." (children нет, redirect-цикла в 403 нет); ошибка → fail-open рендер children | E-B18 |
| TC-B-64 | P1 | manual-preview | PhoneNumbersPage подключённой компании | Search/buy работают как раньше; локального connect-обработчика (`:103-117`) и старой connect-кнопки НЕТ; замена — "Connect in Marketplace" → визард (connect-флоу существует ровно в одном месте) | §2.5 |
| TC-B-65 | P1 | manual-preview | Существующая **BillingPage**: карточка payg | Карточка "Pay as you go" видна (страница фильтрует только trial); выбор → generic-обработчик: ответ без `url` → toast "Plan activated" + reload — intended side effect; пакетный checkout со страницы не сломан | E-B19 |
| TC-B-66 | P2 | manual-preview | Админ DEFAULT-компании открывает визард по прямому URL | Шаг 1 done (master-connected) → шаг 2 (подписки может не быть); документированный self-service класс (как BillingPage) | E-B10 |
| TC-B-67 | P2 | manual-preview | Не-подключённая компания, `?step=3` (обход деривации) | `GET /api/telephony/numbers` → `{ok:true, numbers:[], not_connected:true}` читается как 0 — НЕ ошибка; derived возвращает на шаг 1; гипотетический buy → 409 `TELEPHONY_NOT_CONNECTED` | E-B13 |
| TC-B-68 | P2 | manual-preview | Шаг 1: заглушить `softphone/setup` → 500 | Визард НЕ блокируется (ошибка проглочена, fire-and-forget) → шаг 2; софтфон tenant'а позже даст 409 C5 (см. TC-C-50), лечится повторным setup | E-B17 |

---

## 7. Часть C — `tests/twilioInboundIsolation.test.js` (обязательный файл, спека §9) + C2b

**Стратегия моков:** вызывать `handleVoiceInbound(req,res)` с req/res-моками (`res.type/send/status` — jest.fn); `NODE_ENV=development` для пропуска подписи (кроме TC-C-11); mock `telephonyTenantService` (`resolveCompanyByAccountSid`, `DEFAULT_COMPANY_ID`), `db/connection` (через него идёт `companyIdForNumber` — `SELECT company_id FROM phone_number_settings WHERE phone_number=$1`), `walletService.isServiceBlocked`, `groupRouting.resolveGroupForNumber`, `callFlowRuntime`, инфраструктуру `ingestToInbox`/`recordMissedInbound`; `jest.spyOn(console,'warn')` для лог-формы. C2b — describe в этом же файле (изоляционная тема) либо отдельный `tests/phoneSettingsMasterSyncBind.test.js` — на выбор Tester'а, кейсы обязательны.

| ID | P | Тип | Given / шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-C-01 | P0 | integration-jest | `AccountSid = TWILIO_ACCOUNT_SID` (master), `To=+15085559999` (строки pns НЕТ); resolveCompanyByAccountSid → DEFAULT | **Reject НЕВОЗМОЖЕН**: `<Reject/>` НЕ отправлен; дальше как сегодня — `resolveGroupForNumber` → (null) → generic voicemail TwiML. Boston Masters байт-в-байт | E-C1 |
| TC-C-02 | P0 | integration-jest | Неизвестный `AccountSid='ACghost…'` + неизвестный `To` (оба lookup'а → null) | 200, `content-type text/xml`, тело ровно `<Response><Reject/></Response>` (БЕЗ `reason="busy"`); `console.warn` вызван один раз: первый аргумент содержит `inbound_call.rejected`, второй — объект `{event:'inbound_call.rejected', reason:'unknown_number', call_sid, account_sid, to, from}` (все 6 полей); `recordMissedInbound` НЕ вызван (нет orphan-timeline); `ingestToInbox` ВЫЗВАН и ДО резолва (аудит-след webhook_inbox) | E-C2, §3.1 |
| TC-C-03 | P0 | integration-jest | `resolveCompanyByAccountSid` бросает И db-запрос `companyIdForNumber` бросает | Ошибки обоих lookup'ов → null → Reject + лог (fail-closed), не 500 | E-C3 |
| TC-C-04 | P0 | integration-jest | Известный субаккаунт `status='connected'` → COMPANY_A; To — любой (в т.ч. без строки) | Резолв по SID → COMPANY_A (To не важен, fallback НЕ вызывается); нормальный роутинг | §3.1 матрица |
| TC-C-05 | P1 | integration-jest | Субаккаунт со `status≠'connected'` (suspended) → resolveByAccountSid null; To известен → COMPANY_A | Fallback по To → COMPANY_A → нормальный роутинг (канон ALB-107 сохранён) | E-C4 |
| TC-C-06 | P1 | integration-jest | Suspended субаккаунт + To неизвестен | Reject + warn-лог `reason:'unknown_number'` | §3.1 матрица |
| TC-C-07 | P0 | integration-jest | Резолв → COMPANY_A; `isServiceBlocked(COMPANY_A)` → true | `<Response><Reject reason="busy"/></Response>`; `recordMissedInbound` вызван с `companyId=COMPANY_A`; **второй lookup удалён**: SQL `companyIdForNumber` выполнен максимум 1 раз за запрос (0 — при резолве по SID); `resolveGroupForNumber`/`callFlowRuntime` НЕ вызваны (гейт ДО роутинга) | E-C5, §3.2 |
| TC-C-08 | P1 | integration-jest | `isServiceBlocked` бросает | `.catch(()=>false)` сохранён → false → маршрутизация продолжается (fail-open защищает легитимные звонки) | E-C6 |
| TC-C-09 | P2 | integration-jest | DEFAULT-компания, `isServiceBlocked(DEFAULT)` → true (гипотетически, кошелёк ≤ −5) | Reject busy (ранее номера без pns-строки обходили гейт через null — обход невозможен); при штатном балансе 0 поведение неотличимо | E-C7 |
| TC-C-10 | P1 | integration-jest | `From='sip:agent@…'` (SIP-outbound) | Outbound-ветка не тронута: обычный `<Dial>` TwiML; резолв компании C1/Reject-логика не вызываются | E-C8 |
| TC-C-11 | P1 | integration-jest | (а) `NODE_ENV=production` + невалидная подпись; (б) валидный запрос без `CallSid` | (а) 403 `<Response><Reject/></Response>` ДО ingest; (б) 400 — порядок обработчика §3.1 п.1 без изменений (регрессия) | §3.1 |
| TC-C-30 | P0 | integration-jest | **C2b:** `GET /api/phone-settings` от tenant COMPANY_B; Twilio-мок листит master-номера | Sync-upsert INSERT-параметры содержат `company_id = DEFAULT_COMPANY_ID` (НЕ COMPANY_B) — и в INSERT-значении, и в `EXCLUDED` для COALESCE; финальный `SELECT … WHERE company_id=$1` ($1=COMPANY_B) master-номера НЕ возвращает; claim невозможен | E-C14, §3.4 |
| TC-C-31 | P0 | integration-jest | `GET /api/phone-settings` от админа Boston Masters (DEFAULT) | Upsert с DEFAULT (его же id) — byte-identical поведению до фикса; его номера в ответе | §3.4 |
| TC-C-32 | P1 | unit-jest | Существующая строка pns c `company_id IS NULL` (пре-147 среда), sync от COMPANY_B | `COALESCE(company_id, EXCLUDED.company_id)` подставляет DEFAULT, не COMPANY_B — источник новых claim'ов закрыт | §3.4 |
| TC-C-33 | P2 | integration-jest | `PUT /api/phone-settings/:id` чужой строки (company_id=DEFAULT) от COMPANY_B | `… AND company_id=$4` не изменён → 0 строк → 404/не обновлено (регрессия выборки) | §3.4 |

## 8. Часть C — `tests/voiceTokenFailClosed.test.js` (обязательный файл, спека §9)

**Стратегия моков:** mock `telephonyTenantService` (`getSoftphoneCreds`, `DEFAULT_COMPANY_ID`); env `TWILIO_API_KEY/SECRET/ACCOUNT_SID/TWIML_APP_SID` — фиктивные строки (twilio AccessToken их принимает); route — прямой вызов handler'а `GET /token` с req-моком либо supertest.

| ID | P | Тип | Given / шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-C-20 | P0 | unit-jest | `generateTokenForCompany(DEFAULT, identity)` | Env-fallback `generateToken(identity)` → `{token, identity, expiresAt}` на master env creds — Boston Masters byte-identical (ветка по `companyId === DEFAULT_COMPANY_ID` ДО обращения к кредам) | E-C18, §3.6 |
| TC-C-21 | P0 | unit-jest | `generateTokenForCompany(COMPANY_A, …)`; `getSoftphoneCreds` → null (не подключена / setup не выполнялся) | **throw** объект с `httpStatus:409`, `code:'SOFTPHONE_NOT_PROVISIONED'`, message дословно `'SoftPhone is not provisioned for this company — connect telephony and run softphone setup.'`; тихий фолбэк на master env creds исчез (env-`generateToken` НЕ вызван) | E-C16, §3.6 |
| TC-C-22 | P0 | unit-jest | `getSoftphoneCreds` → `{accountSid:'ACsub…', apiKeySid, apiKeySecret, twimlAppSid}` | Субаккаунт-токен: AccessToken построен на creds субаккаунта (НЕ env); `{token, identity, expiresAt}` | §3.6 |
| TC-C-23 | P0 | unit-jest | `generateTokenForCompany(undefined/null, …)` | НЕ env-fallback: путь через `getSoftphoneCreds(falsy)` → null → 409 (защита на уровне сервиса, хотя route 401-ит раньше) | §3.6 |
| TC-C-24 | P0 | integration-jest | Route `GET /api/voice/token`: (а) сервис бросил `{httpStatus:409, code:…}`; (б) сервис бросил обычный Error | (а) `res.status(409).json({error:<message>, code:'SOFTPHONE_NOT_PROVISIONED'})`; (б) 500 `{error:'Failed to generate voice token'}` как сейчас | §3.6 |
| TC-C-25 | P1 | integration-jest | Route: (а) нет userId/companyId; (б) `phone_calls_allowed=false` или 0 групп | (а) 401 `{error:'User not authenticated'}`; (б) 200 `{allowed:false}` — обе ветки ДО минтинга, без изменений (регрессия) | E-C19 |
| TC-C-26 | P1 | unit-jest | SQL-контракт реального `getSoftphoneCreds` (mock db): суспендированный tenant | Запрос фильтрует `status='connected'` → rows пусто → null → (через TC-C-21) 409; suspended не получает токен | E-C17 |

## 9. Часть C — миграции 147/148 (migration-DB, копия prod DB)

| ID | P | Тип | Шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-C-40 | P0 | migration-DB | Подготовить копию с NULL-строками 3 видов: (1) покрыта `user_group_numbers→user_groups`, (2) непокрытый NULL, (3) не-NULL строки (в т.ч. «чужие» mis-claimed). Прогнать mig 147 | Порядок строго: count NULL (NOTICE с числом) → 091-rule backfill (строка 1 получает company_id группы; NOTICE) → остальные NULL → DEFAULT (строка 2; NOTICE) → guarded `SET NOT NULL` встал. **Не-NULL строки (3) НЕ изменены** (E-C15 residual — вне скоупа, миграция трогает только NULL) | E-C10, E-C15, §3.3 |
| TC-C-41 | P0 | migration-DB | Прогнать mig 147 ПОВТОРНО после TC-C-40 | Все счётчики NOTICE = 0; NOT NULL уже стоит; no-op без ошибки (идемпотентность) | E-C9 |
| TC-C-42 | P3 | migration-DB (конструкция) | Code-review + негативный прогон: искусственно оставить NULL к шагу 4 (закомментировать шаг 3 в копии файла) | `ALTER … SET NOT NULL` падает → миграция откатывается целиком (fail-closed, один транзакционный файл); в штатном файле недостижимо | §3.3 п.4 |
| TC-C-43 | P1 | migration-DB | `rollback_147` | Только DROP NOT NULL; данные backfill'а НЕ откатываются; заголовок файла документирует одностороннюю data-миграцию | §3.3 |
| TC-C-44 | P0 | migration-DB | Прогнать mig 148 на **копии prod** (оба unique фактически есть: `phone_number_settings_phone_number_key`, inline UNIQUE mig 098) | **No-op** (guard по `pg_constraint`/`pg_indexes`); повторный прогон — no-op; в файле НЕТ безусловного `ADD CONSTRAINT` (иначе duplicate-fail) | E-C11 |
| TC-C-45 | P1 | migration-DB | «Дрейфнувшая» среда: снять unique c `phone_number`, вставить дубли (одна строка `twilio_number_sid IS NOT NULL`, другая NULL; отдельно пара с равными sid-условиями и разным `updated_at`). Прогнать 148 | Dedup: остаётся строка с `twilio_number_sid IS NOT NULL`; при равенстве — новейшая по `updated_at`; удалённые посчитаны в `RAISE NOTICE`; создан `uq_phone_number_settings_phone_number` | E-C12 |
| TC-C-46 | P0 | migration-DB | Две строки `company_telephony` (COMPANY_A ранний `connected_at`, COMPANY_B поздний) с ОДНИМ non-NULL SID. Прогнать 148 | Ранняя (A) сохраняет SID; у поздней (B) `twilio_subaccount_sid = NULL`, **строка сохраняется**; `RAISE WARNING` с обоими company_id; создан `uq_company_telephony_twilio_subaccount_sid`; после — `getTelephonyState(B)` → `{connected:false}` → B видит `TELEPHONY_NOT_CONNECTED` (fail-closed), НЕ чужие номера | E-C13 |
| TC-C-47 | P2 | migration-DB | `rollback_148` на prod-копии (где свои `uq_…` не создавались) и на дрейф-копии (где создались) | DROP только объектов с именами `uq_…`; исторические `phone_number_settings_phone_number_key`/inline-UNIQUE НЕ тронуты; dedup-данные не восстанавливаются | §3.5 |
| TC-C-48 | P2 | migration-DB | После 148 вставить 2 строки `company_telephony` с `twilio_subaccount_sid IS NULL` | Обе живут — UNIQUE допускает множественные NULL (Postgres-семантика; autonomous-mode строки легальны) | §3.5 |

## 10. Часть C — frontend softphone (manual-preview)

| ID | P | Тип | Шаги | Ожидаемый результат | Spec |
|---|---|---|---|---|---|
| TC-C-50 | P1 | manual-preview | **Desktop 1280 только** (softphone desktop-only, MOBILE-NO-SOFTPHONE-001). Tenant, у которого connect выполнен, но softphone-setup нет → логин → открыть приложение; Network + Console | `GET /api/voice/token` → 409 → `fetchVoiceToken` бросает → `initDevice` catch → error-state; `Device` не создан, `deviceReady=false`, софтфон «недоступен»; **retry-цикла нет** (в Network один запрос, не шторм); крэша/белого экрана нет; при `tokenWillExpire`-refresh — state 'Token refresh failed' без крэша. Изменений кода фронта не требуется — проверяется существующая деградация | E-C20, §3.6 |

---

## 11. Регрессии — MUST stay green (блокирующие для Reviewer)

| ID | P | Тип | Проверка | Ожидаемый результат |
|---|---|---|---|---|
| TC-R-01 | P0 | jest-регрессия | Полный прогон существующих сьютов, особенно: `billingUI.test.js`, `googleEmailMarketplace.test.js`, `keycloakAuth.test.js`, `bug-answered-call-shown-missed.test.js`, `bug009-missed-call-status.test.js`, `bug006-stale-availability.test.js`, `contactsPulseTenantIsolation.test.js` | Все зелёные; C1/C4 не изменили маршрутизацию легитимных звонков; overlay не сломал google-email |
| TC-R-02 | P0 | manual-preview | IntegrationsPage: существующие плитки vapi-ai / stripe-payments / google-email (+ mail-secretary, call-qa-agent, lead-generator) | Состояния/бейджи/кнопки/переходы как раньше; `MarketplaceConnectDialog` для обычных приложений работает |
| TC-R-03 | P0 | manual-preview | Существующий BillingPage checkout пакетов + wallet topup | Redirect в Stripe checkout работает; вебхук активирует план; кошелёк/леджер как раньше |
| TC-R-04 | P0 | manual-preview | PhoneNumbersPage ПОДКЛЮЧЁННОЙ компании: search + buy | Работают как раньше (удалён только локальный connect); купленный номер получает webhooks + `routing_mode='client'` |
| TC-R-05 | P0 | manual/prod-smoke | **Boston Masters байт-в-байт:** входящий звонок на master-номер (с группой и без); softphone-токен админа DEFAULT | Роутинг группа/флоу или generic voicemail — как сегодня (TC-C-01 jest-двойник); токен минтится на env creds (TC-C-20 двойник); чеклист на `/pulse` не появляется (E-A1) |
| TC-R-06 | P0 | build | `cd frontend && npm run build` (tsc -b) | exit 0 (prod-сборка строже — `noUnusedLocals`) |
| TC-R-07 | P1 | structural | `git diff master -- src/server.js backend/src/routes/billingWebhook.js frontend/src/lib/authedFetch.ts frontend/src/hooks/useRealtimeEvents.ts frontend/src/hooks/usePulsePage.ts backend/db/migrations/0*..144*` | Пусто — защищённые файлы не тронуты (`src/server.js` — 0 изменений; mount `/api/onboarding` = `authenticate`-only → E-A12 2FA-exempt унаследован by construction) |
| TC-R-08 | P1 | manual-preview | Существующий онбординг-флоу: `/signup` → `/onboarding` → `POST /api/onboarding` | `bootstrapCompany` работает; редирект на `/pulse` своей компании; чеклист-эндпоинт не сломал соседние route'ы онбординга |

---

## 12. Трассируемость: edge-матрица спеки → тест-кейсы

Каждая строка E-* покрыта ≥1 TC либо помечена N/A с причиной.

| Edge | TC | Edge | TC | Edge | TC |
|---|---|---|---|---|---|
| E-A1 | TC-A-08, TC-A-33, TC-R-05 | E-B1 | TC-B-52 (+TC-C-44 UNIQUE-подпорка) | E-C1 | TC-C-01, TC-R-05 |
| E-A2 | TC-A-13 | E-B2 | TC-B-03 | E-C2 | TC-C-02 |
| E-A3 | TC-A-11 | E-B3 | TC-B-01, TC-B-02 | E-C3 | TC-C-03 |
| E-A4 | TC-A-12 | E-B4 | TC-B-04 | E-C4 | TC-C-05 |
| E-A5 | TC-A-05, TC-A-34 | E-B5 | TC-B-55(а) | E-C5 | TC-C-07 |
| E-A6 | TC-A-03 | E-B6 | TC-B-55(б) | E-C6 | TC-C-08 |
| E-A7 | TC-A-04 | E-B7 | TC-B-05, TC-B-56 | E-C7 | TC-C-09 |
| E-A8 | TC-A-14 | E-B8 | TC-B-59 | E-C8 | TC-C-10 |
| E-A9 | TC-A-35 | E-B9 | TC-B-11 | E-C9 | TC-C-41 |
| E-A10 | TC-A-36 | E-B10 | TC-B-66 | E-C10 | TC-C-40 |
| E-A11 | TC-A-11 | E-B11 | TC-B-33, TC-B-50 | E-C11 | TC-C-44 |
| E-A12 | **N/A-jest** (2FA-harness нет; mount не меняется — покрыто структурно TC-R-07) | E-B12 | TC-B-35 | E-C12 | TC-C-45 |
| | | E-B13 | TC-B-67 | E-C13 | TC-C-46 |
| | | E-B14 | TC-B-60 | E-C14 | TC-C-30 |
| | | E-B15 | TC-B-53(б) | E-C15 | **N/A-фикс** (задокументированный residual вне скоупа; TC-C-40 проверяет, что mig 147 не-NULL строки НЕ трогает) |
| | | E-B16 | TC-B-61 | E-C16 | TC-C-21, TC-C-24 |
| | | E-B17 | TC-B-68 | E-C17 | TC-C-26 |
| | | E-B18 | TC-B-63 | E-C18 | TC-C-20, TC-R-05 |
| | | E-B19 | TC-B-65 | E-C19 | TC-C-25 |
| | | E-B20 | TC-B-39 | E-C20 | TC-C-50 |

**Явно НЕ тестируется (вне скоупа спеки §10):** residue status-callback'ов отклонённых звонков в `webhook_inbox`; чистка исторически mis-claim'нутых номеров; email-пункт чеклиста; proration/downgrade; авто-пополнение кошелька; port-in/A2P.

**Гейт готовности (для Tester/Reviewer):** все P0 (52) автоматизированы в Jest / прогнаны на копии prod DB / пройдены в preview ДО approve; P1 — по возможности до деплоя; P2/P3 допустимо отложить, но перечислить в отчёте. Прогон Jest в worktree — только с `--testPathIgnorePatterns "/node_modules/"`; миграции — реальные SQL против копии prod в one-off контейнере до `up -d`; деплой в прод — только по явному подтверждению владельца.
