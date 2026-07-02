# ONBTEL-001 — Spec

**Статус:** Specification · **Дата:** 2026-07-02 · **Автор:** Agent 03 (Spec Writer)
**Требования:** `Docs/requirements.md` §«Фича ONBTEL-001» (решения владельца — обязательны)
**Архитектура:** `Docs/architecture.md` §«ONBTEL-001» — авторитетный дизайн; данная спецификация фиксирует точное ПОВЕДЕНИЕ, ничего не передизайнивает.
**Продукт в UI-текстах — Albusto** (все user-visible строки — английские, «Blanc» в UI не встречается).

---

## 0. Общее описание

Три части одной фичи:

- **A** — онбординг-чеклист новой tenant-компании на `/pulse`: полноширинная карточка В ПОТОКЕ страницы, derived-статус пунктов, write-once `completed_at`, только `tenant_admin`.
- **B** — Marketplace-приложение «Telephony — Twilio»: seed-плитка (mig 145), derived-connected overlay (install-строка НЕ создаётся никогда), страница-визард из 3 шагов (Connect → Тариф, включая новый план Pay-as-you-go mig 146 → Номер), redirect неподключённых из Settings → Telephony.
- **C** — 5 фиксов изоляции Twilio: C1 Reject неизвестного номера + структурный лог; C2 NOT NULL + backfill `phone_number_settings.company_id` (mig 147) + C2b master-sync биндит DEFAULT; C3 guarded UNIQUE ×2 (mig 148); C4 wallet-гейт на резолвнутой компании; C5 fail-closed softphone-токен (409 `SOFTPHONE_NOT_PROVISIONED`).

`src/server.js` не меняется (все mounts существуют). Boston Masters (seed `00000000-0000-0000-0000-000000000001`, далее DEFAULT) — поведение байт-в-байт.

---

## 1. Часть A — онбординг-чеклист на `/pulse`

### 1.1 Модель данных и derived-состояние

- **Каталог пунктов** — data-driven registry в новом `backend/src/services/onboardingChecklistService.js` (прецедент `permissionCatalog.js`). Сейчас ровно один пункт: `key='connect_telephony'`. Расширение = одна запись каталога; фронт рендерит `items[]` из ответа, не зная состава.
- **Выполненность пункта телефонии** — derived, не хранится: `done ⇔ EXISTS(строка phone_number_settings WHERE company_id = <company>)`. Released-номера удаляются из таблицы (`releaseNumber`), поэтому «≥1 активный купленный номер» ≡ «есть строка».
- **Единственное персистентное поле** — `companies.settings.onboarding_checklist.completed_at` (ISO-timestamp, JSONB, колонка существует с mig 010; НОВЫХ миграций для Части A нет). Семантика **write-once**: пишется один раз, никогда не перезаписывается и не сбрасывается (guard «писать только если сейчас NULL»). Запись происходит в том же GET-запросе, в котором все пункты впервые оказались derived-выполнены.
- **Collapse** — только клиент: `localStorage` ключ `albusto.onb-checklist.collapsed:<companyId>`. Сервер collapse не хранит; мутационных endpoint'ов у чеклиста нет вообще.

### 1.2 Машина видимости (единственный источник правды — сервер)

```
items[].done  := derived-условия каталога (для connect_telephony — EXISTS выше)
allDone       := все items done
completed_at  := companies.settings#>>'{onboarding_checklist,completed_at}'

если completed_at IS NULL и allDone  → зафиксировать completed_at = now()
                                        (идемпотентный UPDATE c guard WHERE …completed_at IS NULL;
                                         конкурентные GET безопасны: пишет один, второй — no-op)
visible := NOT (completed_at установлен ИЛИ allDone)
```

Следствия (нормативные):

| Ситуация | visible | completed_at |
|---|---|---|
| Новая компания, номера нет | `true` | `null` |
| Номер куплен, первый GET после | `false` | записывается в этом GET |
| Boston Masters / любая старая компания с номерами, первый GET | `false` | записывается при первом же GET — бэкфилл не нужен |
| Номер released ПОСЛЕ фиксации `completed_at` | `false` навсегда (write-once) | не сбрасывается |
| Номер куплен и released ДО какого-либо GET | `true` (пункт снова не выполнен, фиксации не было) | `null` |
| В будущем добавлен новый пункт каталога, компания давно завершила | `false` навсегда (completed_at уже стоит) | не трогается |
| Ошибка записи completed_at при allDone | `false` в этом ответе (visible считается и от allDone); запись повторится в следующем GET | `null` до успешной записи |

### 1.3 Endpoint `GET /api/onboarding/checklist` (NEW)

Расширение существующего `backend/src/routes/onboarding.js` (mount `/api/onboarding` = `authenticate`-only — НЕ меняется). Защита route-level, строго в этом порядке:

1. `requireCompanyAccess` (из `backend/src/middleware/keycloakAuth.js`) → `req.companyFilter.company_id`;
2. inline-гейт tenant_admin: `req.authz?.membership?.role_key === 'tenant_admin'`; dev-mode (`req.user._devMode`) — пропуск. **`requireRole('company_admin')` использовать НЕЛЬЗЯ** — его legacy-mapping пропускает и `manager`.

**Ответ 200:**
```json
{ "ok": true, "checklist": {
    "visible": true,
    "completed_at": null,
    "items": [{
      "key": "connect_telephony",
      "title": "Connect telephony",
      "description": "Get a business phone number to make and receive calls and texts in Albusto.",
      "done": false,
      "cta": { "label": "Set up", "path": "/settings/integrations/telephony-twilio" }
    }]
} }
```
Строки `title`/`description`/`cta.label` живут в backend-каталоге (data-driven); указанные значения — нормативная копия.

**Ошибки:**

| Код | Условие | Тело |
|---|---|---|
| 401 | нет/невалидный токен | `{ code:'AUTH_REQUIRED' \| 'AUTH_INVALID', message, trace_id }` |
| 403 | platform-only пользователь (super_admin) | `{ code:'PLATFORM_SCOPE_ONLY', message:'Platform admins cannot access tenant resources.', trace_id }` |
| 403 | нет активного membership | `{ code:'TENANT_CONTEXT_REQUIRED', message:'No company association found', trace_id }` |
| 403 | membership есть, но роль ≠ tenant_admin (manager/dispatcher/provider) | `{ code:'TENANT_ADMIN_ONLY', message:'Tenant admin role required', trace_id }` |
| 500 | внутренняя ошибка | `{ ok:false, code:'INTERNAL_ERROR', error:'Failed to load onboarding checklist' }` |

403 срабатывает ДО каких-либо чтений/записей чеклиста (в т.ч. до write-once записи). `company_id` — только из `req.companyFilter.company_id`; из payload не принимается ничего (запрос без параметров).

### 1.4 Сценарии

**A1 — happy path нового владельца.**
- Given: пользователь завершил `/signup` → `/onboarding` → `POST /api/onboarding` (создан `tenant_admin`), у компании 0 номеров.
- When: открывает `/pulse`.
- Then: hook `useOnboardingChecklist` (React Query, `enabled: authenticated && !!company && isTenantAdmin()`) получает 200 `visible:true`; между `.blanc-unified-header` и `.pulse-layout` рендерится полноширинная карточка: заголовок **"Get started"**, прогресс **"0 of 1 done"**, пункт "Connect telephony" (иконка-статус не-выполнено), описание, кнопка **"Set up"**. Контент Pulse сдвинут вниз (`flex-shrink:0` в потоке), ничего не перекрыто, независимый скролл колонок сохранён (desktop и mobile).

**A2 — переход по CTA.**
- Given: A1. When: клик "Set up". Then: `navigate('/settings/integrations/telephony-twilio')` (SPA-переход, без reload).

**A3 — collapse персистентен.**
- Given: карточка развёрнута. When: клик по кнопке collapse (aria-label "Collapse checklist"). Then: карточка складывается в компактную строку: заголовок "Get started" + "0 of 1 done" + chevron (aria-label "Expand checklist"); в `localStorage` пишется `albusto.onb-checklist.collapsed:<companyId>`; состояние переживает reload/повторный визит на этом устройстве. Кнопки dismiss/скрыть НЕ существует by construction.

**A4 — автозавершение после покупки номера.**
- Given: владелец прошёл визард Части B, номер куплен. When: возврат на `/pulse` (перемонтирование страницы или window-focus — `refetchOnWindowFocus` по умолчанию). Then: GET возвращает `done:true` у пункта; в этом же GET сервер write-once фиксирует `completed_at`; `visible:false` → карточка не рендерится и больше не появится никогда.

**A5 — не-админ той же компании.**
- Given: manager/dispatcher/provider. When: открывает `/pulse`. Then: фронт запрос НЕ шлёт (`enabled` включает `isTenantAdmin()`); при прямом вызове API — 403 `TENANT_ADMIN_ONLY`. Карточки нет, страница как сейчас.

**A6 — существующая компания с номерами (вкл. Boston Masters).**
- Given: у компании есть строки `phone_number_settings`. When: tenant_admin открывает `/pulse` впервые после деплоя. Then: единственный GET возвращает `visible:false` и попутно фиксирует `completed_at`; карточка не показывается; поведение страницы не меняется. Никакого бэкфилла миграцией.

**A7 — пользователь без компании (мид-онбординг).**
- Given: авторизован, membership ещё нет. Then: hook не активен (`!!company` = false); при прямом вызове — 403 `TENANT_CONTEXT_REQUIRED`. `/onboarding`-флоу не затронут.

**A8 — ошибка загрузки чеклиста.**
- Given: API отвечает 5xx/сетевая ошибка. Then: карточка просто не рендерится (fail-quiet, без toast — второстепенный виджет не должен шуметь на главной); React Query ретраит по своим умолчаниям; Pulse работает как обычно.

### 1.5 UI-карточка (нормативно)

- Файл `frontend/src/components/onboarding/OnboardingChecklistCard.tsx`; вставка в `frontend/src/pages/PulsePage.tsx` строго между `.blanc-unified-header` и `.pulse-layout` (~строки 210–213). `usePulsePage.ts` НЕ трогается.
- Рендер-гейт: `isTenantAdmin() && checklist?.visible`.
- Дизайн: Blanc-токены; заголовок font `--blanc-font-heading`; eyebrow `.blanc-eyebrow` "Getting started"; карточка `border: var(--blanc-line)`, radius 16px, без теней и без `<hr>`; иконки статуса 4, цвет `--blanc-ink-3` (не выполнено) / `--blanc-success` (выполнено); прогресс "N of M done".
- Развёрнуто: заголовок+прогресс+список пунктов (иконка, title, description, CTA `<Button>`). Свёрнуто: одна компактная строка (заголовок + прогресс + chevron).
- SSE не используется; актуализация — refetch on mount + `refetchOnWindowFocus`.

---

## 2. Часть B — Marketplace «Telephony — Twilio»

### 2.1 Seed приложения (mig 145)

Одна строка в `marketplace_apps`, `ON CONFLICT (app_key) DO UPDATE` (идемпотентно, шаблон seed 116); регистрация `readMigration('145_seed_telephony_twilio_marketplace_app.sql')` в `ensureMarketplaceSchema` (`backend/src/db/marketplaceQueries.js`, после 132):

| Поле | Значение |
|---|---|
| `app_key` | `telephony-twilio` |
| `name` | `Telephony — Twilio` |
| `provider_name` | `Albusto` |
| `category` | `telephony` |
| `app_type` | `internal` |
| `short_description` | `Business phone numbers, calls and texts for your company — powered by Twilio.` |
| `requested_scopes` | `[]` |
| `provisioning_mode` | `none` |
| `status` | `published` |
| `metadata` | `{"setup_path":"/settings/integrations/telephony-twilio","derived_connection":true,"access_summary":["Buy and manage phone numbers","Route inbound calls and SMS"]}` |

Rollback 145: DELETE строки приложения (install-строк у него не бывает — FK-безопасно).

### 2.2 Derived installation-state (install-строка не создаётся НИКОГДА)

`backend/src/services/marketplaceService.js`, по прецеденту google-email:

- **`listApps`**: для `app_key==='telephony-twilio'` поле `installation` ЗАМЕЩАЕТСЯ synthetic-overlay из `telephonyTenantService.getTelephonyState(companyId)`:
  - `state.connected === true` → `{ id:null, status:'connected', installed_at: state.connected_at ?? null, disconnected_at:null, provisioning_error:null, last_used_at:null, external_installation_id:null }`;
  - `state.connected === false` → `installation: null`.
  - `subaccount_sid` наружу НЕ отдаётся ни в одном поле. Ошибка `getTelephonyState` ведёт себя как у google-email-overlay (всплывает → 500 списка) — специальной резилентности не добавляется.
- **`isAppConnected(companyId,'telephony-twilio')`** → тот же derived-ответ (симметрия с google-email).
- **`installApp`**: в начале (рядом с `validateInstallPrerequisites`, до создания installation) — data-driven reject: `metadata.derived_connection === true` → `MarketplaceServiceError('This app is configured from its setup page.', 'DERIVED_CONNECTION_APP', 409)`. Без hardcode `app_key`. Флаг сейчас стоит только у telephony-twilio; поведение прочих приложений (включая google-email, у которого флага в metadata нет) — без изменений.

**Матрица плитки на `IntegrationsPage`** (новая ветка `app.app_key === 'telephony-twilio'` рядом с существующими vapi/stripe/google-email; нормативны бейдж, кнопка и переход — остальная разметка карточки generic):

| Состояние компании | `getTelephonyState` | Бейдж | Кнопка | Клик |
|---|---|---|---|---|
| DEFAULT (Boston Masters) | `{connected:true, mode:'master'}` (без обращения к БД) | **Connected** | **Manage** (variant outline) | `navigate('/settings/telephony')` |
| Субаккаунт подключён (есть SID) | `{connected:true, mode:'subaccount', …}` | **Connected** | **Manage** | `navigate('/settings/telephony')` |
| Не подключена (строки нет) | `{connected:false}` | **Available** | **Configure** (variant default) | `navigate(metadata.setup_path)` |
| Строка `company_telephony` есть, но `twilio_subaccount_sid IS NULL` (autonomous-mode upsert, mig 142) | `{connected:false}` | **Available** | **Configure** | `navigate(metadata.setup_path)` |

Плитка становится Connected сразу после шага 1 визарда (субаккаунт есть, номера может не быть) — осознанное следствие «состояние выводится из фактического подключения»; полноту онбординга отслеживает чеклист Части A. Generic `Enable`/`MarketplaceConnectDialog` для этой плитки недостижимы (ветка кнопок своя); сервер-fail-safe — 409 `DERIVED_CONNECTION_APP`.

### 2.3 Страница-визард `/settings/integrations/telephony-twilio`

`frontend/src/pages/TelephonyTwilioSettingsPage.tsx` (канон `VapiSettingsPage`/`StripePaymentsSettingsPage`), роут в `App.tsx` с `ProtectedRoute permissions={['tenant.integrations.manage']}`. Заголовок страницы **"Telephony — Twilio"**, подзаголовок **"Connect your business phone: create a workspace, choose a plan, and get a number."**

**Деривация шагов (единственный источник правды — сервер; устойчиво к refresh/перезаходу):**

```
done1 := GET /api/telephony/numbers/status → state.connected === true
done2 := GET /api/billing → subscription != null && subscription.plan_id !== 'trial'
done3 := GET /api/telephony/numbers → numbers.length ≥ 1
         (ответ { ok:true, numbers:[], not_connected:true } читается как 0 — НЕ ошибка)
activeStep := первый невыполненный; все выполнены → экран Completion
```

Query-параметр `?step=` — только подсказка: если derived-шаг меньше запрошенного, показывается derived. Матрица повторного входа:

| done1 | done2 | done3 | Активный экран |
|---|---|---|---|
| ✗ | ✗ | ✗ | Шаг 1 |
| ✓ | ✗ | ✗ | Шаг 2 |
| ✓ | ✓ | ✗ | Шаг 3 |
| ✓ | ✓ | ✓ | Completion |
| ✗ | ✓ | ✗ | Шаг 1 (тариф выбран раньше через Billing — шаг 2 отмечен выполненным) |
| ✓ | ✗ | ✓ | Шаг 2 (номер куплен на trial — шаг 3 отмечен выполненным) |

Степпер: выполненные шаги — с галочкой, кликабельны назад (напр. сменить тариф — `subscribe` идемпотентен); вперёд дальше активного — заблокировано.

**Шаг 1 — "Connect".**
- Копия: "Albusto will create a dedicated Twilio workspace (subaccount) for your company. Your numbers, calls and texts stay isolated." Кнопка **"Connect telephony"**.
- When клик: `POST /api/telephony/numbers/connect` → 200 `{ok:true, state}`; затем best-effort `POST /api/telephony/numbers/softphone/setup` (fire-and-forget, ошибки глотаются — ровно как `PhoneNumbersPage.connectTelephony:103-117`); refetch статуса → шаг 2.
- Идемпотентность: повторный вход/повторный клик у подключённой компании второй субаккаунт НЕ создаёт (`connectTelephony` возвращает существующий state; подкреплено UNIQUE из C3).
- Ошибки: 500 → inline-ошибка "Could not connect telephony — try again." + кнопка активна (безопасный retry); 403 (нет `tenant.telephony.manage`) → inline "You don't have permission to manage telephony — ask your administrator."

**Шаг 2 — "Choose your plan".**
- Данные: `plans[]` из того же `GET /api/billing`; визард показывает карточку **Pay as you go** + пакетные планы `plans.filter(p => p.id !== 'trial' && p.id !== 'payg')` (API уже сортирует по цене). Trial не показывается никогда.
- Карточка PAYG: name "Pay as you go", цена "$0/mo", буллеты: "Calls $0.04 per minute", "Texts $0.03 each", "1 phone number", "Usage is paid from your wallet". Кнопка **"Choose Pay as you go"**.
- When PAYG: `POST /api/billing/checkout {plan_id:'payg'}` → 200 `{ok:true, activated:true}` → toast "Plan activated" → refetch `GET /api/billing` → шаг 3. Принудительного пополнения кошелька НЕТ (требование владельца).
- Пакет (starter $49 / pro $149 / huge $289): кнопка "Choose {name}", подпись "You'll be redirected to secure checkout." → `POST /api/billing/checkout {plan_id, return_path:'/settings/integrations/telephony-twilio?step=3&billing=success'}`:
  - ответ `{url}` → `window.location.href = url` (Stripe hosted checkout) → возврат на `return_path` → визард перемонтируется и ДЕРИВИТ шаг из серверного состояния;
  - ответ `{activated:true}` (карта уже на файле) → как PAYG-ветка, без redirect.
- **Ожидание вебхука**: если в URL `billing=success`, а `done2` ещё false — экран шага 2 показывает состояние "Confirming your payment…" и рефетчит `GET /api/billing` каждые 3 с; по флипу `plan_id` → шаг 3. Спустя 60 с без подтверждения — подсказка "Still waiting for payment confirmation. If you completed checkout, this page will update shortly — you can also check Settings → Billing." и выбор планов снова доступен (покрывает и отмену checkout, т.к. cancel возвращает на тот же `return_path`).
- Ошибки: 422 `PROVIDER_NOT_CONFIGURED` (только пакетные, Stripe не сконфигурирован) → inline "Billing is not enabled yet."; 404 `Plan not available` → toast текстом сервера; 422 `INVALID_RETURN_PATH` — дефект фронта, toast текстом сервера.

**Шаг 3 — "Get a number".**
- Форма поиска: Area code / City / Contains digits + переключатель "Toll-free"; кнопка "Search" → `GET /api/telephony/numbers/search?area_code=&contains=&locality=&toll_free=` → ≤15 результатов: номер, locality/region, voice/sms-бейджи, "$1.15/mo" ("$2.15/mo" toll-free), кнопка **"Buy"**. Пусто → "No numbers found — try another area code or city."
- When Buy: `POST /api/telephony/numbers/buy {phone_number}` → 201 `{ok:true, number}` — номер записан в `phone_number_settings` компании с webhooks (voiceUrl/fallback/statusCallback выставляются при покупке в Twilio, `routing_mode='client'`); refetch номеров → done3 → Completion.
- **422 `NUMBER_LIMIT` — upsell (обязателен):** блок с текстом сервера дословно (шаблон: `Your Pay as you go plan includes up to 1 phone number. Upgrade your plan to add more.`) + строка "Need more numbers? Switch to a package plan." + кнопка **"View plans"** → переключение на шаг 2. Покупка на этом плане дальше невозможна до апгрейда.
- 409 `NUMBER_UNAVAILABLE` → toast текстом сервера ("This number was just taken — pick another one") + результат убирается/поиск обновляется.
- 500 → toast "Failed to buy the number".

**Completion.** Заголовок "Telephony is connected", текст "Your number is active. Incoming calls and texts will appear in Albusto.", кнопки **"Manage telephony"** → `/settings/telephony` и **"Back to Integrations"** → `/settings/integrations`. Пункт чеклиста Части A выполнится сам (derived; refetch по focus/mount на `/pulse`).

### 2.4 Тарифный контракт PAYG

**Seed mig 146** — строка `billing_plans`, `ON CONFLICT (id) DO UPDATE` (идемпотентно, как 107):

| Поле | Значение |
|---|---|
| `id` / `name` | `payg` / `Pay as you go` |
| `monthly_base_usd` | `0` |
| `included_seats` / `per_seat_usd` | `3` / `0` (зеркало trial; на списания не влияет) |
| `metered` | `{"sms":0.03,"call_minutes":0.04,"agent_runs":0}` |
| `included_units` | `{"sms":0,"call_minutes":0,"agent_runs":0}` |
| `max_phone_numbers` | `1` (решение владельца; больше номеров = апсел в пакеты) |
| `provider_price_id` | `NULL` (Stripe для payg не используется) |
| `is_active` | `true` |

Rollback 146: `UPDATE … SET is_active=false` (НЕ DELETE — возможен FK из `billing_subscriptions`).

**`billingService.subscribe(companyId, planId, { successUrl, cancelUrl }?)` — изменения поведения:**

1. Загрузить план (`WHERE id=$1 AND is_active`); нет → 404 `Plan not available` (как сейчас).
2. **Новая ветка ДО `providerConfigured()`-проверки:** `Number(plan.monthly_base_usd) <= 0` → обновить подписку компании на `plan_id`, `status='active'`, `updated_at=now()` (по `WHERE company_id`); если строки подписки нет — вставка с теми же значениями, идемпотентно по PK `company_id`. Stripe customer/карта/`billPlanFee`/кошелёк — НЕ трогаются. Ответ `{activated:true}`. Работает и при полностью отсутствующем `STRIPE_SECRET_KEY` (no-Stripe branch).
3. **Идемпотентность:** повторный `subscribe('payg')` — тот же UPDATE тех же значений → снова `{activated:true}`; повторные проходы визарда планы/подписки не плодят.
4. Платные планы — существующая логика untouched (карта на файле → off-session charge → активация; нет карты → hosted checkout c `metadata.plan_id`, активация вебхуком `checkout.session.completed`), плюс опциональные `successUrl/cancelUrl` из route вместо захардкоженных.
5. Правило «≤ 0» распространяется на ЛЮБОЙ активный план с нулевой ценой — в т.ч. `trial` (см. edge E-B9): UI планов (`визард`, `BillingPage`) trial не предлагает; API-путь остаётся допустимым self-service «downgrade» без обхода изоляции/лимитов.

**`routes/billing.js POST /checkout` — опциональный `return_path`:**

- Валидация: значение отсутствует/`undefined`/`null` → дефолтные URL (`https://app.albusto.com/settings/billing?status=success` / `?status=cancel`). Иначе значение обязано быть строкой, начинаться с `/`, не содержать `//` и не содержать `:`; провал → **422** `{ ok:false, code:'INVALID_RETURN_PATH', error:'return_path must be a relative path' }`.
- Валидный → `successUrl = cancelUrl = 'https://app.albusto.com' + return_path` (path-only, анти-open-redirect; различение success/cancel — забота фронта, см. поллинг шага 2).

**Матрица `return_path`:**

| Значение | Вердикт |
|---|---|
| отсутствует | OK → дефолты |
| `/settings/integrations/telephony-twilio?step=3&billing=success` | OK |
| `/x` | OK |
| `//evil.com` | 422 (содержит `//`) |
| `http://evil.com` | 422 (не с `/`, содержит `:` и `//`) |
| `https://app.albusto.com/x` | 422 (содержит `:`) |
| `javascript:alert(1)` | 422 (не с `/`, содержит `:`) |
| `` (пустая строка) | 422 (не начинается с `/`) |
| `/a//b`, `/x:y` | 422 |
| не-строка (число/объект) | 422 |

**Списания PAYG — ноль нового кода:** usage пишется существующим конвейером (`EVENT_TO_METRIC`: sms / call_minutes → `billing_usage_records`), `computeOverage` при `included_units=0` делает весь usage платным по `metered`-ставкам, `billOverage` дебетует кошелёк **in arrears раз в период** через существующий `overageScheduler` (payg-подписка в `status='active'` уже попадает в выборку). Realtime-дебета за звонок нет; защита от минуса — существующий wallet-гейт (floor −$5, `MIN_TOPUP_USD` $10). `walletService.assertServiceActive` остаётся единственным сервис-гейтом исходящих SMS.

**Side effect (интендед):** после seed 146 план payg автоматически появляется в `plans[]` `GET /api/billing` → карточка «Pay as you go» видна и на существующей `BillingPage` (она фильтрует только `trial`); её generic-обработчик уже корректен: ответ без `url` → toast "Plan activated" + reload.

### 2.5 Redirect неподключённой компании из Settings → Telephony

`frontend/src/components/telephony/TelephonyLayout.tsx` (обёртка ВСЕХ `/settings/telephony/*` роутов; сами роуты гейтятся `tenant.telephony.manage` — без изменений). На mount — `GET /api/telephony/numbers/status`:

| Состояние | Поведение |
|---|---|
| Загрузка | ничего не рендерить (ни nav, ни children — без flash) |
| `state.connected === true` (вкл. DEFAULT — у неё state всегда connected) | рендер как сейчас, byte-identical |
| `connected === false` и `hasPermission('tenant.integrations.manage')` | `<Navigate to="/settings/integrations/telephony-twilio" replace />` |
| `connected === false` без права integrations | компактный empty-state: **"Telephony is not connected yet — ask your administrator."** (children не рендерятся; redirect-цикла в 403 нет) |
| Ошибка запроса статуса (5xx/сеть) | fail-open: рендер children как раньше (redirect только по достоверному `connected:false`; страницы имеют собственные not-connected состояния) |

`frontend/src/pages/telephony/PhoneNumbersPage.tsx`: локальный connect-обработчик (`:103-117`) и кнопка connect (`:288`) удаляются; на их месте — переход в визард (**"Connect in Marketplace"** → `navigate('/settings/integrations/telephony-twilio')`). Connect-флоу существует ровно в одном месте — визарде. Search/buy-функции страницы остаются для подключённых компаний.

---

## 3. Часть C — фиксы изоляции Twilio

### 3.1 C1 — Reject неизвестного номера (`twilioWebhooks.js handleVoiceInbound`)

Изменения только в inbound-ветке (`else` после `isOutbound`; SIP-outbound не трогается). Порядок обработчика:

1. Без изменений: невалидная подпись → **403** `<Response><Reject/></Response>`; нет `CallSid` → **400**; `ingestToInbox` — ДО резолва (аудит-след в `webhook_inbox` сохраняется для любых звонков, включая отклоняемые).
2. **Резолв компании ровно один раз:** `companyId = resolveCompanyByAccountSid(AccountSid)`, при null — fallback `companyIdForNumber(To)` (канон ALB-107 «AccountSid → To»). Ошибка БД в любом lookup'е трактуется как null этого lookup'а.
3. `companyId === null` → структурный лог + ответ **200 `text/xml`** `<Response><Reject/></Response>` (default reason `rejected` — отличим от wallet-гейта `reason="busy"`). `recordMissedInbound` НЕ вызывается (нет компании — не создаём orphan-timeline). Generic voicemail для company-less звонка более недостижим.
4. Далее — C4-гейт и существующий роутинг (см. 3.2).

**Форма лога — одна строка, warn, JSON-поля (нормативно):**
```
console.warn(`[${traceId}] inbound_call.rejected`, { event:'inbound_call.rejected', reason:'unknown_number', call_sid:<CallSid>, account_sid:<AccountSid>, to:<To>, from:<From> })
```

**Матрица резолва/Reject:**

| AccountSid | To | Результат |
|---|---|---|
| master (`TWILIO_ACCOUNT_SID`) | любой, даже без строки в `phone_number_settings` | → DEFAULT; **Reject НЕВОЗМОЖЕН**; дальше как сегодня (гейт → группа/флоу или generic voicemail) — Boston Masters байт-в-байт |
| известный субаккаунт, `status='connected'` | любой | → его компания (To не важен) |
| неизвестный/отсутствует | известный (есть строка) | → компания по To (fallback) |
| неизвестный | неизвестный | → **Reject + лог** `reason:'unknown_number'` |
| субаккаунт со `status≠'connected'` (suspended) | известный | резолв по SID даёт null → fallback To → компания (поведение ALB-107 сохранено) |
| субаккаунт suspended | неизвестный | → **Reject + лог** |
| ошибка БД в обоих lookup'ах | — | null → **Reject** (fail-closed) |

Residue: status-callback'и отклонённых unknown-звонков продолжают попадать в `webhook_inbox` (pre-existing конвейер) — осознанно вне скоупа.

### 3.2 C4 — wallet-гейт до роутинга без null-обхода

- Второй lookup `companyIdForNumber(To).catch(()=>null)` (`:336`) **удаляется**; гейт использует `companyId`, резолвнутый в C1 (в этой точке гарантированно non-null).
- Поведение при блокировке — без изменений: `isServiceBlocked(companyId)` true (баланс ≤ −$5) → лог + `recordMissedInbound` (ошибки non-blocking) + `<Response><Reject reason="busy"/></Response>`.
- `.catch(()=>false)` у `isServiceBlocked` сохраняется: транзиентная ошибка кошелька НЕ валит легитимную маршрутизацию (fail-open только здесь; сам резолв компании — fail-closed через C1).
- Гейт стоит ДО `resolveGroupForNumber`/`callFlowRuntime`; F017-роутинг, autonomous-mode override (fail-open чтение) — не изменяются.
- Дельта поведения: master-номера БЕЗ строки в `phone_number_settings` ранее обходили гейт (null); теперь гейтятся под DEFAULT-компанией. Видимых изменений нет, пока кошелёк DEFAULT ≥ floor (он не тарифицируется, баланс 0 > −5); если когда-либо упадёт — корректный Reject busy вместо обхода (це и есть фикс).

### 3.3 C2 — `phone_number_settings.company_id` NOT NULL + backfill (mig 147)

Идемпотентная одно-файловая миграция, паттерн mig 140 (`DO $$`-блоки, `RAISE NOTICE` с числом затронутых строк на КАЖДОМ шаге), порядок строго:

1. Посчитать и залогировать количество строк `company_id IS NULL`.
2. Повторить правило mig 091: backfill из `user_group_numbers → user_groups.company_id` для NULL-строк (страховка дрейфнувших сред); NOTICE с количеством.
3. Остальные NULL → DEFAULT `00000000-0000-0000-0000-000000000001`; NOTICE с количеством. Обоснование «в default, не DELETE» — зафиксировано архитектурой: NULL исторически порождались только master-путями (субаккаунтный `buyNumber` всегда пишет company_id → чужой номер default'у достаться не может); DELETE опасен — живой master-номер был бы re-claim'нут чужим tenant'ом при следующем GET-sync.
4. Guarded `ALTER COLUMN company_id SET NOT NULL` (безопасно к повторному прогону). Если NULL к этому шагу остался (не должен) — миграция падает и откатывается целиком (fail-closed).

Rollback `rollback_147`: только DROP NOT NULL; **данные backfill'а не откатываются** — задокументировано в заголовке файла (односторонняя data-миграция).

Инвариант после C2+C2b: «бесхозный» номер создать невозможно; все write-пути (`buyNumber`, GET-sync) пишут company_id всегда.

### 3.4 C2b — master-sync биндит DEFAULT (`routes/phoneSettings.js`)

GET `/api/phone-settings` sync-upsert (`:100-108`) сегодня листит **master**-аккаунт для ЛЮБОЙ компании и upsert'ит номера с `company_id` компании-запросчика (INSERT-значение и `COALESCE`-claim). **Контракт после фикса:** upsert биндит `company_id = telephonyTenantService.DEFAULT_COMPANY_ID` (номера master-аккаунта принадлежат default-компании — фактическому владельцу аккаунта).

| Кто вызывает GET | До | После |
|---|---|---|
| Админ Boston Masters | upsert с default (его же id) | byte-identical |
| Админ другого tenant'а | master-номера claim'ились его company_id (INSERT новых + COALESCE NULL-строк) и попадали в его список | upsert идёт под DEFAULT → его финальный `SELECT WHERE company_id=$1` master-номера НЕ возвращает; claim невозможен |

Выборка `WHERE company_id=$1` и `PUT /:id … AND company_id=$4` — не меняются. Исторически mis-claim'нутые строки (не-NULL, чужой company_id из прошлого) миграцией НЕ правятся — осознанный residual вне скоупа (C2 трогает только NULL); фикс закрывает ИСТОЧНИК новых.

### 3.5 C3 — guarded UNIQUE ×2 (mig 148, защитная формализация)

Разведка: на prod оба уникальных ограничения фактически ЕСТЬ (`phone_number_settings_phone_number_key`; `twilio_subaccount_sid TEXT UNIQUE` inline в mig 098). Поэтому **безусловный `ADD CONSTRAINT` писать НЕЛЬЗЯ** (упадёт duplicate); только guarded DO-блоки:

- **`phone_number_settings.phone_number`**: если в `pg_constraint`/`pg_indexes` НЕТ unique ровно по этой колонке → pre-dedup: из дублей оставить строку с `twilio_number_sid IS NOT NULL`, при равенстве — новейшую по `updated_at`; удалённые — `RAISE NOTICE` с количеством → создать `uq_phone_number_settings_phone_number`. Есть unique (prod) → **no-op**.
- **`company_telephony.twilio_subaccount_sid`**: аналогичный guard; UNIQUE допускает множественные NULL (Postgres-семантика — строки autonomous-mode с NULL-SID легальны). Pre-dedup: дубль одного non-NULL SID = кросс-tenant шаринг субаккаунта → оставить строку с ранним `connected_at`, у поздней `twilio_subaccount_sid = NULL` (строка сохраняется) + `RAISE WARNING` с обоими `company_id`. Fail-closed: «осиротевшая» компания получает `TELEPHONY_NOT_CONNECTED` до ручного разбора, а не чужие номера. Имя: `uq_company_telephony_twilio_subaccount_sid`.

Rollback `rollback_148`: DROP только объектов с именами `uq_…` (существующие исторические констрейнты не трогает); dedup-данные не восстанавливаются.

### 3.6 C5 — fail-closed softphone-токен

**`voiceService.generateTokenForCompany` — точное условие:**
- `companyId === telephonyTenantService.DEFAULT_COMPANY_ID` → env-fallback `generateToken(identity)` (как сейчас; Boston Masters untouched).
- Иначе (включая falsy companyId — защита на уровне сервиса, хотя route 401-ит раньше) → `getSoftphoneCreds(companyId)`:
  - креды есть → субаккаунт-токен (как сейчас);
  - `null` → **throw `{ httpStatus:409, code:'SOFTPHONE_NOT_PROVISIONED', message:'SoftPhone is not provisioned for this company — connect telephony and run softphone setup.' }`**. Тихий фолбэк на master env creds для не-default компаний исчезает.

`getSoftphoneCreds` возвращает null когда: телефония не подключена; подключена, но softphone-setup не выполнялся (`twiml_app_sid`/`api_key_sid`/`api_key_secret_enc` пусты); субаккаунт suspended (запрос фильтрует `status='connected'`). Все три случая → 409.

**`routes/voice.js GET /token`**: catch дополняется веткой `err.httpStatus` → `res.status(err.httpStatus).json({ error: err.message, code: err.code })`; прочие ошибки → 500 `{error:'Failed to generate voice token'}` как сейчас. Auto-provision в токен-роуте НЕ делается (провижининг — явное действие connect-флоу/визарда; токен-роут дергается часто и не должен ходить в Twilio). Ветки `401 'User not authenticated'` и `200 {allowed:false}` (нет `phone_calls_allowed`/групп) — без изменений и срабатывают ДО минтинга.

**Frontend-деградация (проверяемое поведение, изменений кода не требуется):** `fetchVoiceToken` бросает на не-200 → `initDevice` catch → `setError`, `Device` не создаётся, `deviceReady=false` → софтфон в состоянии «недоступен»; retry-цикла нет (init выполняется один раз на `enabled`); refresh по `tokenWillExpire` при 409 даёт state 'Token refresh failed' без крэша. Пользователи default-компании и корректно настроенных tenant'ов — не затронуты.

---

## 4. Сводка миграций 145–148

Перед созданием файлов перепроверить фактический максимум в `backend/db/migrations` (на 2026-07-02 — 144; параллельные ветки). Все миграции идемпотентны (повторный прогон — no-op/те же значения), backfill-шаги логируют количество строк (`RAISE NOTICE`), перед UNIQUE — детект/разрешение дубликатов. Перед деплоем — прогон РЕАЛЬНЫХ запросов миграций и чеклиста в one-off контейнере против копии prod DB (урок LIST-PAGINATION-001).

| # | Файл | Забота | Идемпотентность | Rollback |
|---|---|---|---|---|
| 145 | `145_seed_telephony_twilio_marketplace_app.sql` | seed `marketplace_apps` + регистрация в `ensureMarketplaceSchema` | `ON CONFLICT (app_key) DO UPDATE` | DELETE строки app |
| 146 | `146_seed_payg_billing_plan.sql` | seed `billing_plans` id='payg' | `ON CONFLICT (id) DO UPDATE` | `SET is_active=false` (НЕ DELETE) |
| 147 | `147_phone_number_settings_company_not_null.sql` | count→091-rule backfill→default backfill→guarded NOT NULL | повторный прогон: 0 строк, NOT NULL уже стоит | DROP NOT NULL; данные не откатываются (в заголовке) |
| 148 | `148_telephony_unique_guards.sql` | guarded dedup + UNIQUE ×2 | guard по `pg_constraint`/`pg_indexes`; на prod — no-op | DROP только своих `uq_…` |

---

## 5. Контракты API (новые/изменённые)

| Method/Path | Middleware (mount + route) | Request | 200/201 | Ошибки |
|---|---|---|---|---|
| `GET /api/onboarding/checklist` **NEW** | mount `authenticate`; route `requireCompanyAccess` + inline `role_key==='tenant_admin'`; company ТОЛЬКО из `req.companyFilter.company_id` | — | `{ ok:true, checklist:{ visible, completed_at, items:[{key,title,description,done,cta:{label,path}}] } }` | 401 `AUTH_REQUIRED`/`AUTH_INVALID`; 403 `PLATFORM_SCOPE_ONLY`/`TENANT_CONTEXT_REQUIRED`/`TENANT_ADMIN_ONLY`; 500 `INTERNAL_ERROR` |
| `POST /api/billing/checkout` **CHANGED** | mount `authenticate + requirePermission('tenant.company.manage') + requireCompanyAccess` | `{ plan_id:'payg'\|'starter'\|'pro'\|'huge', return_path?:string }` | план ≤$0: `{ok:true,activated:true}`; платный+карта: `{ok:true,activated:true}`; платный без карты: `{ok:true,url}` | 401/403 (mount); 404 `Plan not available`; 422 `plan_id required`; 422 `INVALID_RETURN_PATH`; 422 `PROVIDER_NOT_CONFIGURED` (только платные) |
| `GET /api/marketplace/apps` **CHANGED (payload)** | без изменений (`tenant.integrations.manage`) | — | для `telephony-twilio`: `installation` = synthetic overlay из `company_telephony` (connected → объект со `status:'connected'`; иначе `null`); SID не отдаётся | как сейчас |
| `POST /api/marketplace/apps/telephony-twilio/install` **CHANGED** | без изменений | — | не используется | **409 `DERIVED_CONNECTION_APP`** `'This app is configured from its setup page.'` (для любых app с `metadata.derived_connection===true`) |
| `GET /api/voice/token` **CHANGED (ошибки)** | без изменений (`authenticate + requireCompanyAccess`) | — | `{ token, identity, expiresAt, allowed:true }` / `{allowed:false}` | + **409 `{error, code:'SOFTPHONE_NOT_PROVISIONED'}`**; 401; 500 |
| `POST /webhooks/twilio/voice-inbound` **CHANGED (TwiML)** | подпись per-subaccount (без изменений) | Twilio form | unknown company → `200 text/xml <Response><Reject/></Response>` + warn-лог `{event:'inbound_call.rejected', reason:'unknown_number', call_sid, account_sid, to, from}`; wallet-blocked → `<Reject reason="busy"/>` (как сейчас) | 403 invalid signature; 400 нет CallSid (как сейчас) |
| `GET /api/phone-settings` **CHANGED (запись)** | без изменений | — | форма ответа прежняя; sync-upsert биндит `company_id = DEFAULT_COMPANY_ID` | как сейчас |
| Reuse БЕЗ изменений | — | `GET/POST /api/telephony/numbers/status·connect·search·buy·softphone/setup`, `GET /api/telephony/numbers`, `GET /api/billing` | | (в т.ч. 422 `NUMBER_LIMIT`, 409 `NUMBER_UNAVAILABLE`, 409 `TELEPHONY_NOT_CONNECTED`, 403 `TELEPHONY_SUSPENDED`) |

---

## 6. Полная матрица граничных случаев

**Часть A:**

| # | Случай | Ожидаемое поведение |
|---|---|---|
| E-A1 | Boston Masters, первый GET чеклиста | все пункты done → write-once `completed_at` в этом же GET → `visible:false` навсегда; бэкфилла нет |
| E-A2 | Конкурентные GET при первом завершении | guard `…completed_at IS NULL` — пишет один, второй no-op; оба получают `visible:false` |
| E-A3 | Release последнего номера ПОСЛЕ completed_at | чеклист НЕ воскресает (write-once) |
| E-A4 | Покупка → release ДО первого GET | completed_at не записан → `visible:true`, пункт не выполнен |
| E-A5 | Не-админ вызывает API напрямую | 403 `TENANT_ADMIN_ONLY`; никаких записей |
| E-A6 | super_admin | 403 `PLATFORM_SCOPE_ONLY` (requireCompanyAccess) |
| E-A7 | Пользователь без membership | 403 `TENANT_CONTEXT_REQUIRED`; фронт не вызывает (`enabled`-гейт) |
| E-A8 | Ошибка записи completed_at | ответ `visible:false` (по allDone); запись повторится следующим GET |
| E-A9 | Ошибка/5xx загрузки на фронте | карточка не рендерится, страница живёт; без toast |
| E-A10 | Смена компании пользователем (другой companyId) | collapse-ключ per-company → состояние другой компании не наследуется |
| E-A11 | Будущий новый пункт каталога у завершившей компании | `visible:false` навсегда (completed_at стоит) |
| E-A12 | 2FA-untrusted устройство | endpoint под `/api/onboarding` — 2FA-exempt (унаследовано от mount); read-only + admin-gate — приемлемо |

**Часть B:**

| # | Случай | Ожидаемое поведение |
|---|---|---|
| E-B1 | Повторный POST connect у подключённой компании | существующий state, второй субаккаунт не создаётся (идемпотентность + UNIQUE C3) |
| E-B2 | Повторный POST checkout payg | тот же UPDATE → `{activated:true}`; дублей подписок нет (PK company_id) |
| E-B3 | payg при отсутствующем STRIPE_SECRET_KEY | `{activated:true}` (ветка ДО providerConfigured); платный план → 422 `PROVIDER_NOT_CONFIGURED` "Billing is not enabled yet" |
| E-B4 | payg у компании без строки подписки | INSERT-ветка, идемпотентно |
| E-B5 | Возврат из Stripe ДО прихода вебхука | `billing=success` + `done2=false` → "Confirming your payment…", поллинг 3 с; >60 с → подсказка + выбор планов снова доступен |
| E-B6 | Отмена Stripe checkout | возврат на тот же `return_path` → план не активировался → после таймаута подсказка; повторный выбор доступен |
| E-B7 | Платный план при карте на файле | `{activated:true}` без redirect → сразу шаг 3 |
| E-B8 | 422 `NUMBER_LIMIT` на buy | upsell-блок: серверное сообщение дословно + "Need more numbers? Switch to a package plan." + "View plans" → шаг 2 |
| E-B9 | POST checkout `{plan_id:'trial'}` напрямую | trial ≤ $0 → активируется веткой ≤0 (self-service downgrade); UI никогда не предлагает; изоляция/биллинг не нарушаются — задокументированный acceptable edge |
| E-B10 | Админ DEFAULT-компании открывает визард по URL | шаг 1 done (master-connected); подписки может не быть → шаг 2; выбор payg наложит `max_phone_numbers=1` на будущие покупки (422 NUMBER_LIMIT, лечится выбором пакета) — класс self-service действий, существовавший и до фичи через BillingPage |
| E-B11 | Плитка при `company_telephony` строке с NULL SID (autonomous-mode) | `connected:false` → Available + Configure |
| E-B12 | POST install telephony-twilio (обход UI) | 409 `DERIVED_CONNECTION_APP`; installation-строка не создаётся |
| E-B13 | Шаг 3 у не-подключённой компании (обход деривации) | `GET numbers` → `not_connected:true` → done3=0; buy упрётся в 409 `TELEPHONY_NOT_CONNECTED`; derived-шаг всё равно вернёт на шаг 1 |
| E-B14 | 409 `NUMBER_UNAVAILABLE` (Twilio 21422) | toast текстом сервера; результаты обновляются |
| E-B15 | Пользователь с `tenant.integrations.manage`, но без `tenant.telephony.manage` | страница откроется, но numbers-вызовы вернут 403 → inline "You don't have permission to manage telephony — ask your administrator." |
| E-B16 | `?step=3` в URL при невыполненном шаге 1 | derived-шаг побеждает → показан шаг 1 |
| E-B17 | Best-effort softphone/setup упал на шаге 1 | визард НЕ блокируется; софтфон у tenant'а позже даст 409 C5 → «недоступен», лечится повторным setup из Settings → Telephony |
| E-B18 | Redirect-матрица TelephonyLayout | см. §2.5 (loading→пусто; connected→byte-identical; not-connected+perm→Navigate replace; not-connected без perm→empty-state; error→fail-open children) |
| E-B19 | payg в plans[] на BillingPage | карточка видна и работает через существующий generic-обработчик (`activated:true` → toast+reload) — intended |
| E-B20 | `getTelephonyState` упал в overlay | как у google-email — ошибка всплывает (500 списка приложений); спец-обработки нет |

**Часть C:**

| # | Случай | Ожидаемое поведение |
|---|---|---|
| E-C1 | Master AccountSid, номер без строки pns | → DEFAULT, Reject НЕВОЗМОЖЕН; generic voicemail как сегодня (byte-identical) |
| E-C2 | Неизвестный AccountSid + неизвестный To | 200 `<Response><Reject/></Response>` + warn-лог указанной формы; recordMissedInbound НЕ вызывается; ingestToInbox — вызван |
| E-C3 | Ошибка БД при резолве (оба lookup'а) | null → Reject (fail-closed) |
| E-C4 | Suspended субаккаунт, To известен | fallback по To → компания → нормальный роутинг (канон ALB-107) |
| E-C5 | Wallet blocked у резолвнутой компании | `<Reject reason="busy"/>` + missed call (как сейчас); null-обход невозможен |
| E-C6 | Ошибка `isServiceBlocked` | false → маршрутизация продолжается (fail-open защищает легитимные звонки) |
| E-C7 | DEFAULT-компания с кошельком ≤ −5 (гипотетически) | теперь Reject busy (ранее — обход гейта у номеров без pns-строки); при штатном балансе 0 — поведение неотличимо |
| E-C8 | SIP-outbound (`From` начинается `sip:`) | ветка не тронута |
| E-C9 | mig 147 повторный прогон | все счётчики 0, NOT NULL уже стоит — no-op |
| E-C10 | mig 147 при существующих NULL-строках | шаги 091-rule → default; NOTICE на каждом шаге; NOT NULL встаёт |
| E-C11 | mig 148 на prod | оба unique уже есть → no-op (безусловный ADD CONSTRAINT запрещён) |
| E-C12 | mig 148: дубли phone_number на дрейфнувшей среде | остаётся строка с `twilio_number_sid IS NOT NULL` (tie → новейшая `updated_at`); удалённые посчитаны в NOTICE |
| E-C13 | mig 148: два company_telephony с одним SID | ранний `connected_at` сохраняет SID; поздний → SID=NULL + RAISE WARNING с обоими company_id; осиротевшая компания видит `TELEPHONY_NOT_CONNECTED` (fail-closed), не чужие номера |
| E-C14 | GET /api/phone-settings другим tenant'ом | master-номера upsert'ятся под DEFAULT; в ответе их нет; claim невозможен (C2b) |
| E-C15 | Исторически mis-claim'нутые строки (не-NULL, чужие) | миграцией не правятся — задокументированный residual вне скоупа; источник новых закрыт |
| E-C16 | /token: tenant подключён, softphone-setup не выполнялся | 409 `SOFTPHONE_NOT_PROVISIONED` (сообщение из §3.6 дословно) |
| E-C17 | /token: tenant suspended | `getSoftphoneCreds` null (фильтр status='connected') → 409 |
| E-C18 | /token: DEFAULT-компания | env-creds токен, как сегодня (byte-identical) |
| E-C19 | /token: пользователь без `phone_calls_allowed`/групп | `{allowed:false}` 200 — до минтинга, без изменений |
| E-C20 | Frontend softphone при 409 | fetch бросает → initDevice catch → error-state, Device не создан, без retry-цикла и крэша; UI «софтфон недоступен» |

---

## 7. Взаимодействие компонентов

- `PulsePage` → `useOnboardingChecklist` (React Query) → `onboardingApi.ts` (authedFetch) → `GET /api/onboarding/checklist` → `onboardingChecklistService.getChecklist(companyId)` → SQL `EXISTS phone_number_settings` + JSONB `companies.settings` (+ write-once UPDATE).
- `IntegrationsPage` → `marketplaceApi.fetchMarketplaceApps` → `GET /api/marketplace/apps` → `marketplaceService.listApps` → overlay из `telephonyTenantService.getTelephonyState`.
- `TelephonyTwilioSettingsPage` → authedFetch → `/api/telephony/numbers/status|connect|search|buy|softphone/setup`, `/api/billing`, `/api/billing/checkout`, `/api/telephony/numbers` → `telephonyTenantService` / `billingService` → Twilio (subaccounts, AvailablePhoneNumbers, IncomingPhoneNumbers) / Stripe (hosted checkout только для пакетов).
- Stripe → `POST /api/billing/webhook` (raw-body mount, НЕ меняется) → `handleProviderWebhook` → активация плана по `metadata.plan_id`.
- Twilio → `POST /webhooks/twilio/voice-inbound` → C1 резолв (`resolveCompanyByAccountSid` → `companyIdForNumber`) → C4 `walletService.isServiceBlocked` → `groupRouting`/`callFlowRuntime` (untouched).
- Softphone: `useTwilioDevice` → `GET /api/voice/token` → `voiceService.generateTokenForCompany` (C5).
- **SSE: не используется и не добавляется** (чеклист — refetch on focus/mount; `useRealtimeEvents` не трогается).

---

## 8. Безопасность и изоляция данных

- `company_id` во всех новых/изменённых обработчиках — ТОЛЬКО из `req.companyFilter?.company_id`; чеклист и `subscribe` не принимают company от клиента вовсе; в новых endpoint'ах нет id-параметров → чужие сущности недостижимы by construction.
- Каждый SQL фильтрует по `company_id` (чеклист: `EXISTS … WHERE company_id=$1`, `UPDATE companies WHERE id=$1`; subscribe: `WHERE company_id=$1`; overlay: `getTelephonyState(companyId)`).
- Webhook-путь: компания по `AccountSid`→`To` (модель ALB-107), подпись — токеном соответствующего субаккаунта — без изменений.
- `return_path` — path-only (анти-open-redirect, матрица §2.4); subaccount SID наружу в marketplace-overlay не отдаётся.
- Fail-closed: C1 Reject при нерезолвнутой компании (вкл. DB-ошибку), C5 409 вместо master-creds, mig 148 dedup NULL-ит поздний дубль SID. Fail-open сохранён только где защищает легитимную маршрутизацию (ошибка `isServiceBlocked`) и в autonomous-mode (protected).
- Гейт tenant_admin чеклиста — на фронте (`isTenantAdmin()`) И на backend (inline `role_key`); `requireRole('company_admin')` не используется (пропускает manager).
- Ошибки API не раскрывают чужие данные; кросс-tenant чтение/запись невозможны (обязательные тесты ниже).

---

## 9. Обязательные тесты (из архитектуры §8)

| Файл | Покрытие |
|---|---|
| `tests/onboardingChecklist.test.js` | 401 без токена; 403 manager/dispatcher/provider (`TENANT_ADMIN_ONLY`); 403 platform-only; company-scope (данные только своей компании); write-once completed_at (первый GET all-done пишет, второй не перезаписывает); derived done по phone_number_settings |
| `tests/billingPaygSubscribe.test.js` | payg без Stripe → `{activated:true}`; идемпотентность повторного subscribe; платный путь не сломан (url/activated); reject абсолютных/невалидных `return_path` (матрица §2.4) |
| `tests/twilioInboundIsolation.test.js` | C1: master AccountSid НЕ reject'ится; unknown+unknown → Reject + лог-форма; DB-error → Reject; C4: гейт на резолвнутой компании, busy-Reject, ошибка isServiceBlocked → пропуск |
| `tests/voiceTokenFailClosed.test.js` | DEFAULT → env-токен; не-default без кредов → 409 `SOFTPHONE_NOT_PROVISIONED`; с кредами → субаккаунт-токен; route-маппинг httpStatus |
| `tests/marketplaceTelephonyOverlay.test.js` | derived connected: default / subaccount / не подключена / NULL-SID строка; SID не в ответе; install → 409 `DERIVED_CONNECTION_APP` |

Прогон Jest в worktree — с `--testPathIgnorePatterns "/node_modules/"`. Frontend верифицируется `npm run build` (tsc -b; prod строже — `noUnusedLocals`). Мокнутый Jest проверяет только SQL-строки — РЕАЛЬНЫЕ запросы миграций/чеклиста прогнать в one-off контейнере против копии prod DB до `up -d`.

---

## 10. Вне скоупа / защищённые части

**Вне скоупа:** email-пункт чеклиста и другие новые пункты; изменение цен/лимитов trial/starter/pro/huge; proration/downgrade-флоу; авто-пополнение кошелька; port-in/международные номера/A2P; изменение call flow сверх фиксов C; ретроактивная миграция компаний на новые планы; чистка исторически mis-claim'нутых номеров (E-C15); residue status-callback'ов отклонённых звонков в `webhook_inbox`.

**Не трогать:** `src/server.js` (0 изменений), `authedFetch.ts`, `useRealtimeEvents.ts`, миграции ≤144, `routes/billingWebhook.js` + raw-body mount, `platformCompanyService.bootstrapCompany`, `callFlowRuntime`/`groupRouting`/autonomous-mode (fail-open чтение), `walletService.assertServiceActive`, `telephonyTenantService.connectTelephony/buyNumber/searchNumbers` (reuse без правок), `MarketplaceConnectDialog`, существующие 5 приложений и их страницы, `usePulsePage.ts`; Boston Masters — байт-в-байт (master AccountSid → DEFAULT в C1; env-creds в C5; C2b для default — идентичные значения; деплой в прод — только по явному подтверждению владельца).
