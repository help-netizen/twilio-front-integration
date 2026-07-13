# TELEPHONY-WIZARD-UX-001 — Spec

Переработка визарда «Telephony — Twilio» + port-in + чистка Stripe-экрана.
Закрывает OB-1, OB-2, OB-3, OB-4, OB-5, OB-7 (`docs/owner-backlog.md`).
Требования: `docs/requirements.md` §TELEPHONY-WIZARD-UX-001 (решения владельца — БИНДИНГ).
Архитектура: `docs/architecture.md` §TELEPHONY-WIZARD-UX-001.

---

## 0. Общее описание

Визард сокращается до «Plans (опционален) → Number (+Transfer) → Done». Шаг
«Set up your line» удалён: Twilio-субаккаунт создаётся неявно перед первым
действием, которое его требует. Первый connect компании автоматически начисляет
$5 welcome-бонус (идемпотентно) и активирует payg при trial-подписке. Number-шаг
теряет block-in-block, получает комбо-поле «Area code or city» со статическими
NANPA-подсказками и полный self-service port-in через Twilio Porting API
(twilio-node 5.12.0, наличие методов проверено в SDK). Stripe Payments
not-connected остаётся с одним hero; чеклист очеловечивается.

---

## 1. Неявный connect + $5 welcome-бонус

### 1.1 Точки неявного connect

| Точка | Кто вызывает | Механика |
|---|---|---|
| Выбор тарифа (Plans) | Frontend | `choosePlan()` сначала `await POST /api/telephony/numbers/connect`, затем существующий `POST /api/billing/checkout` |
| Первый поиск номера | Backend | route `/api/telephony/numbers/search` перед `searchNumbers` вызывает `connectTelephony(companyId, { actorId, companyName })` |
| Покупка номера | Backend | route `/buy` — так же (страховка: прямой deep-link на шаг Number) |
| Port-in (check/create) | Backend | routes `/api/telephony/port-in/check` и `POST /` — так же |

`connectTelephony` уже идемпотентен (`existing.connected → early return`) — «ensureConnected» = просто его вызов. `getClientForCompany` НЕ меняется: 409 `TELEPHONY_NOT_CONNECTED` сохраняется для всех прочих потребителей (voice-токен, softphone, usage, list).

Ошибка connect в route → существующий `fail()`-хендлер (5xx/структурная ошибка Twilio) — поиск/покупка не выполняются. Frontend: ошибка connect перед choosePlan → inline-ошибка «Could not set up your phone workspace — try again» (тот же паттерн, что старый connectError), checkout не вызывается.

### 1.2 Сценарий: первый connect → бонус + payg

- **Предусловия:** компания ≠ default (`DEFAULT_COMPANY_ID`), строки `company_telephony` с SID нет.
- **Шаги:**
  1. `connectTelephony` создаёт субаккаунт (master client) и делает INSERT/UPSERT в `company_telephony` — как сейчас.
  2. ПОСЛЕ успешного INSERT (только свежий путь, НЕ early-return): `grantWelcomeCredit(companyId)`:
     a. `walletService.credit(companyId, 5, { type: 'adjustment', description: 'Welcome credit', ref: 'welcome_credit:v1' })` → при дубле ref вернёт `applied:false` (no-op).
     b. `billingService.getSubscription(companyId)` → если подписки нет или `plan_id === 'trial'` → `billingService.subscribe(companyId, 'payg')` (payg `monthly_base_usd <= 0` → прямая активация, идемпотентна).
     c. Ошибки a/b — `console.error` + продолжение (connect НЕ падает).
  3. Fire-and-forget `ensureSoftphoneSetup(companyId).catch(log)` (заменяет фронтовый best-effort вызов из удалённого шага 1).
- **Ожидаемый результат:** субаккаунт создан; ledger содержит ровно одну строку `welcome_credit:v1` на +$5 (`balance_after = 5.00` для нового кошелька); `billing_subscriptions.plan_id='payg', status='active'`; audit `telephony.connected` как раньше.
- **Побочные эффекты:** нет SSE; wallet виден через `GET /api/billing/wallet`.

### 1.3 Граничные случаи бонуса

1. Двойной вызов connect (double-click, параллельные вкладки) → второй проходит early-return (grant не вызывается) ИЛИ, при гонке до COMMIT, оба доходят до credit — UNIQUE `idx_wallet_ledger_ref` + FOR UPDATE в `applyDelta` гарантируют одну запись (`applied:false` у второго). Итог всегда: ОДИН кредит $5.
2. Default-компания: `getTelephonyState` → connected:true → early return → бонус НЕ начисляется никогда.
3. Компания, подключённая ДО фичи: early return → ретроактивного бонуса нет (решение: бонус только «при первом подключении»).
4. Компания уже на платном пакете к моменту первого connect (теоретически: подписка менялась через /settings/billing) → кредит начисляется, payg-активация ПРОПУСКАЕТСЯ (подписка не trial) — пакет не сбивается.
5. Кредит прошёл, payg-subscribe упал (сбой БД) → компания остаётся на trial с $5; повторный connect не чинит (early return) — деградация задокументирована, серьёзность низкая (выбор тарифа в визарде доступен).
6. Twilio-ошибка создания субаккаунта → connect кидает, бонуса нет, состояние не записано — повторная попытка полностью повторяет флоу.

### 1.4 Показ бонуса в визарде

Plans-шаг: intro-копия (нормативно): **«You have $5 to try Albusto pay-as-you-go — or pick a package.»** Под ней, когда `GET /api/billing/wallet → balance_usd > 0`, — чип «Wallet balance: $X.XX» (данные `billingApi.wallet()`; до первого connect чипа нет, копия остаётся обещанием). Ошибка wallet-запроса → чип просто не рендерится (fail-quiet).

---

## 2. Визард: новая степ-модель

### 2.1 Шаги и derived-логика

`stepsMeta`: 1 **Pick your plan** («$5 free credit included»), 2 **Choose your number** («New number or transfer yours»). Completion — состояние 3.

```
done_number = numbers.length >= 1 || есть port-in со status ∉ {canceled, failed}
derivedStep = done_number ? 3 : (subscription != null && plan_id !== 'trial') ? 2 : 1
activeStep  = stepOverride ?? derivedStep, где override к шагу 2 разрешён ВСЕГДА
              (Plans опционален — forward-переход валиден), а к шагу 1 — всегда можно вернуться.
```

`done1 (connected)` из дериваций УДАЛЯЕТСЯ (connect неявный). Запросы `statusQ` можно сохранить только если нужен статус для completion-копии; обязательные — `billingQ`, `numbersQ`, `portInQ` (новый: `GET /api/telephony/port-in`).
`?step=` hint: значения 1..2; hint=3 игнорируется (completion только derived).
Возврат со Stripe: `RETURN_PATH` меняется на `?step=2&billing=success`; поллинг `awaitingPayment` — без изменений.

### 2.2 Plans-шаг (OB-1.2/1.3)

- Карта текущего тарифа: бейдж «Current» остаётся, `disabled={disabled || isCurrent}` УБИРАЕТСЯ → кнопка активна. CTA текущей карты: «Keep this plan». Клик по текущему тарифу — подтверждение БЕЗ API-вызова: toast.success «You're on {name} — all set», переход на шаг 2 (`setStepOverride(2)`). (Причина: повторный `subscribe` платного тарифа повторно списал бы деньги; no-op-подтверждение закрывает требование владельца.)
- Выбор НЕ-текущего тарифа: `await POST /api/telephony/numbers/connect` (п.1.1) → существующий `choosePlan` (payg → activated → toast + шаг 2; пакет → Stripe redirect).
- Кнопка **«Skip — get a number first»** (ghost, под карточками): `setStepOverride(2)`. Никаких API-вызовов (connect случится лениво на первом поиске).
- После skip компания остаётся на trial до первого поиска; первый поиск неявно активирует payg (п.1.2) — «дефолт компании после бонуса = payg».

### 2.3 Completion

Показывается при `done_number`. Если номеров нет, но есть активный port-in: заголовок «Your number transfer is underway», копия про сроки/LOA + CTA «Manage telephony». Если есть номер — прежняя копия.

---

## 3. Number-шаг: форма, комбо-поле, результаты

### 3.1 Убрать block-in-block (OB-2)

`sectionCard`-обёртка (`TelephonyTwilioSettingsPage.tsx:44, :515`) удаляется: поля, Toll-free и Search лежат прямо в потоке шага (`space-y`-ритм; grid для пары полей `grid-cols-1 sm:grid-cols-2 gap-3.5`). Константа `sectionCard` удаляется из файла.

### 3.2 Комбо-поле «Area code or city» (OB-3/OB-4)

Одно поле (`AreaCodeCombo`) заменяет пару Area code + City.

- **Справочник:** `frontend/src/data/areaCodes.ts` — статический модуль, ~350 действующих US NANPA-кодов: `{ code, city, state, lat, lon }` (город = основной город зоны, координаты — его центроид). Никаких запросов в рантайме.
- **Локаль компании:** `GET /api/telephony/numbers/locale` → `{ city, state, zip, lat, lon }` (все nullable). Backend: `companies.city/state/zip` → координаты: `zip_geocache` по `companies.zip`; мисс → `territoryGeoService.geocodeZip` (best-effort, ошибки глотаются); нет zip → первый `territory_radii ORDER BY position LIMIT 1` (lat/lon уже в строке; city/state из zip_geocache по его зипу, если есть). Ничего не нашли → все поля null.
- **Подсказки (`suggestAreaCodes(query, locale)`):**
  - «Локальные» коды = при наличии `locale.lat/lon` — топ-8 по haversine-дистанции; иначе при `locale.state` — коды этого штата (алфавит по городу); иначе локальных нет.
  - Пустой ввод + фокус → показать локальные (до 8).
  - Ввод 1-3 цифр → локальные с префиксом; ЕСЛИ среди локальных нет совпадений — дропдаун пуст (остальные коды НЕ подсказываем, решение владельца), ввод остаётся ручным.
  - Ввод текста → локальные, чей город начинается с ввода (case-insensitive). Нет совпадений → дропдаун закрыт.
  - Формат строки подсказки: `617 — Boston, MA`.
- **Тип критерия (`detectSearchKind`):** выбранная подсказка → `{ kind:'area_code', value: code }` (в поле отображается «617 — Boston, MA»); ручной ввод ровно 3 цифр → area_code; любой другой непустой ввод → `{ kind:'locality', value: text }`. Поиск: area_code → `?area_code=`, locality → `?locality=` (существующие параметры `/search`).
- **Поведение:** дропдаун — лёгкий локальный список под полем (позиционирование в потоке/absolute от контейнера поля; НЕ Radix Select — нужен свободный ввод; на мобиле список тоже инлайн — без BottomSheet, т.к. это подсказки при наборе). Клавиатура: ↑/↓/Enter/Escape. Клик вне — закрыть. Toll-free=true — комбо-поле игнорируется Twilio-параметрами? Нет: `searchNumbers` уже передаёт и areaCode, и tollFree — поведение как раньше (сервер не менялся).
- Поле «Contains digits» и чекбокс Toll-free — без изменений.

### 3.3 Результаты поиска в потоке (OB-5)

- Результаты рендерятся как сейчас — колонкой карточек в потоке шага, БЕЗ max-height/overflow-обёрток. Ничего специально не добавлять — задача НЕ ДОБАВИТЬ обрезающий контейнер и НАЙТИ существующий.
- **Диагностика обрезания (обязательный шаг реализации):** воспроизвести на preview 375px с ≥10 результатами. Кандидаты-виновники: `.app-main { display:flex; flex-direction:column }` (`AppLayout.css:64`) в связке с обёрткой `SettingsLayout` (`md:flex md:h-full`, `SettingsLayout.tsx:35,67`) — проверить, что на мобиле контент страницы лежит в блочном потоке и скроллится `.app-main` (канон MobileListPage). Фикс — минимальный, на уровне виновного контейнера, БЕЗ ломки desktop-скролла (`md:overflow-y-auto` сайдбар-канон сохранить).
- **Acceptance:** на 375px все карточки результатов доскролливаются до конца, «пустой серой зоны» под обрезанной карточкой нет; desktop — без регрессий.

---

## 4. Port-in (Transfer your number)

### 4.1 Данные

Миграция `169_port_in_requests.sql` (+rollback) — см. архитектуру. Локальный `status` enum (TEXT):
`submitted | pending | in_review | action_required | completed | canceled | failed`.
Нормализация Twilio `port_in_request_status`/`portInPhoneNumberStatus`: lowercase, пробелы/дефисы → `_`; неизвестное значение → сохранить в `twilio_status`, локальный `status='pending'`. `completed`/`canceled`/`expired→failed` — терминальные.

### 4.2 Twilio-вызовы (SDK 5.12.0, проверено)

- Portability: `masterClient().numbers.v1.portingPortabilities(phoneE164).fetch({ targetAccountSid })` → `{ portable, notPortableReason, numberType }`.
- Create: `masterClient().numbers.v1.portingPortIns.create({ numbersV1PortingPortInCreate: { accountSid: targetAccountSid, documents: [docSid], phoneNumbers: [{ phoneNumber }], losingCarrierInformation: {...}, targetPortInDate?, notificationEmails? } })`.
- Status: `masterClient().numbers.v1.portingPortIns(sid).fetch()`; Cancel: `.remove()`.
- `targetAccountSid` = `company_telephony.twilio_subaccount_sid` (default-компания → master SID). Porting всегда через master-клиент (см. архитектурное решение).
- Документ (utility bill): SDK-обёртки нет → multipart POST `https://numbers-upload.twilio.com/v1/documents` (Basic auth master SID/token), file из multer memoryStorage (лимит 10MB, mime pdf/jpeg/png). Ответ → doc SID → `documents` create-модели + jsonb-колонка.
- LOA подписывает уполномоченный представитель по ссылке/письму Twilio (`signature_request_url` из ответа — сохраняем и показываем в статус-карточке).
- **Кэп сложности (зафиксирован):** программный Porting API в SDK ЕСТЬ — full-automation идёт. Если на живом master-аккаунте продукт Porting окажется не включён (Twilio feature-gate, ошибка 4xx на create) — endpoint отвечает 502 `PORTING_UNAVAILABLE`, UI показывает честный fallback «Number transfers aren't automated for this account yet — contact support and we'll run the port for you», строка сохраняется со status `action_required`; вопрос эскалируется оркестратору. Это ЕДИНСТВЕННОЕ отступление от full-automation.

### 4.3 API-контракты

Mount: `app.use('/api/telephony/port-in', authenticate, requirePermission('tenant.telephony.manage'), requireCompanyAccess, router)`. company_id ТОЛЬКО из `req.companyFilter?.company_id`. Все SQL — `WHERE company_id = $1`. Auth: authedFetch.

- `POST /check` — `{ phone_number }` (E.164 `+1XXXXXXXXXX`, иначе 422).
  Response: `{ ok, portable: boolean, number_type, reason: string|null }`. Ленивый connect внутри. Twilio-ошибка → 502 `PORTABILITY_CHECK_FAILED`.
- `POST /` — multipart: file `utility_bill` (обязателен) + поля `phone_number`, `customer_name`, `customer_type ('Individual'|'Business')`, `account_number?`, `account_telephone_number?`, `authorized_representative`, `authorized_representative_email`, `address_street`, `address_street2?`, `address_city`, `address_state`, `address_zip`, `address_country (default 'USA')`, `target_port_in_date?` (ISO date, ≥7 дней вперёд, иначе 422 `TARGET_DATE_TOO_SOON`).
  Шаги: валидация → ленивый connect → portability re-check (не portable → 422 `NOT_PORTABLE` с reason) → upload документа → `portingPortIns.create` → INSERT строки (`created_by = req.user.crmUser.id`) → 201 `{ ok, request }`. Дубликат: активная заявка на тот же `phone_number` у компании → 409 `PORT_ALREADY_REQUESTED`.
- `GET /` — `{ ok, requests: [...] }` компании, новые сверху. Для незавершённых (status не терминальный и есть twilio_port_in_sid) — best-effort live-refresh с Twilio (ошибки глотаются, отдаём БД).
- `GET /:id` — одна заявка + принудительный live-refresh; чужой/несуществующий id → 404 (не 403).
- `DELETE /:id` — отмена: Twilio `.remove()` (404 Twilio → считать уже отменённой) → `status='canceled'`; терминальный статус → 409 `NOT_CANCELABLE`; чужой id → 404.

Response-shape `request`: `{ id, phone_number, status, twilio_status, signature_request_url, target_port_in_date, created_at, updated_at }` (losing_carrier_info и documents наружу НЕ отдаём целиком — только `customer_name` для подписи карточки; в них PII).

### 4.4 UI

- **Number-шаг:** сегмент-тумблер «Get a new number | Transfer your number» над формой (в потоке, без контейнера). Вкладка Transfer → `PortInPanel`:
  1. Экран номера: FloatingField «Your current phone number» + кнопка «Check if it can move» (`POST /check`). portable=false → InlineError с reason + CTA «Get a new number instead» (переключает тумблер).
  2. Экран данных: поля losing carrier (канон FloatingField/FloatingSelect, группы `space-y-6`), file-input utility bill (человечная подпись «A recent bill from your current carrier — Twilio needs it to verify the account»), Submit «Start the transfer».
  3. Статус-карточка(и): номер, человечный статус («Waiting for your signature — check {email}», «In review with your current carrier», «Completed — the number is live», …), ссылка на LOA (`signature_request_url`), Cancel для не-терминальных.
- **Нормативная копия-рекомендация (владелец, дословно):** «We recommend grabbing a new number now — outbound calls keep flowing from it while the transfer completes, so you don't lose customers.» — постоянный текст на вкладке Transfer со ссылкой-действием «Get a new number» (переключение тумблера).
- Честный гайд под формой: перенос занимает обычно 2–4 недели; понадобятся данные счёта у текущего оператора; представителю придёт письмо на подпись; номер продолжает работать у старого оператора до завершения.
- **Страница телефонии** (`PhoneNumbersPage.tsx`): секция «Number transfers» (рендерится только когда `GET /api/telephony/port-in` непуст) — те же статус-карточки (реюз `PortInPanel` в status-only режиме).
- Активный port-in участвует в `done_number` (§2.1); completion-копия — §2.3.

---

## 5. OB-7 — Stripe Payments

- `StripePaymentsSettingsPage.tsx`: удалить `WhatItCostsCard` (:60-77) и `CostRow` (:48-58); grid-обёртку `grid-cols-1 md:grid-cols-[1.15fr_.85fr]` (:141) заменить на одиночный `CloudBanner` (hero без изменений — чипы цен уже внутри него).
- `stripePaymentsService.buildChecklist` (нормативные labels; done-логика и порядок БЕЗ изменений):

| key | label |
|---|---|
| `connect` | `Link your Stripe account` |
| `onboarding` | `Tell Stripe about your business` |
| `payment_methods` | `Card payments switched on` |
| `field_payments` | `Tap to Pay on your phone` (deferred: true — бейдж «Coming soon» рендерит фронт, как сейчас) |
| `first_payment` (переименован из `test_payment` — осознанно; единственное использование key — этот файл) | `Start getting paid — collect your first payment right from a job` |

- Никаких изменений `computeReadiness`/`canCollect`/`publicStatus`-механики; фронт продолжает рендерить `status.checklist` как есть.

---

## 6. Безопасность и изоляция данных

- Все новые endpoints — под существующими цепочками `authenticate, requirePermission('tenant.telephony.manage'), requireCompanyAccess`; company_id ТОЛЬКО из `req.companyFilter?.company_id` (НЕ `req.companyId`).
- `port_in_requests`: каждый SELECT/UPDATE/DELETE — `AND company_id = $N`; доступ к чужому id → 404.
- Twilio-креды не покидают сервер; master-креды используются только в сервисах; `losing_carrier_info` (PII) наружу не отдаётся.
- Бонус нельзя вызвать повторно с фронта: начисление живёт только внутри `connectTelephony` (свежий путь) + ref-UNIQUE.
- Файл utility bill не сохраняется на диск CRM (memoryStorage → Twilio → отбрасывается); в БД — только doc SID.

## 7. Сводная обработка ошибок (фронт)

| Ошибка | Реакция |
|---|---|
| connect 403 | inline «You don't have permission to manage telephony — ask your administrator.» |
| connect 5xx перед choosePlan/поиском | inline «Could not set up your phone workspace — try again.» |
| search fail | существующий toast |
| buy 422 NUMBER_LIMIT | существующий upsell (verbatim server text) — НЕ менять |
| buy 409 | существующий toast + re-search |
| port-in 422 NOT_PORTABLE | InlineError + CTA «Get a new number instead» |
| port-in 422 TARGET_DATE_TOO_SOON | field-error у даты |
| port-in 409 PORT_ALREADY_REQUESTED | toast + скролл к статус-карточке |
| port-in 502 PORTING_UNAVAILABLE / PORTABILITY_CHECK_FAILED | fallback-копия §4.2 |
| wallet fetch fail | чип не рендерится |

## 8. Взаимодействие компонентов

```
TelephonyTwilioSettingsPage
  ├─ billingQ → GET /api/billing            (plans, subscription — derived step)
  ├─ walletQ  → GET /api/billing/wallet     (бонус-чип)
  ├─ numbersQ → GET /api/telephony/numbers  (done_number)
  ├─ portInQ  → GET /api/telephony/port-in  (done_number, статусы)
  ├─ Plans: choosePlan → POST /api/telephony/numbers/connect → POST /api/billing/checkout
  ├─ Number(new): AreaCodeCombo(GET /api/telephony/numbers/locale, data/areaCodes.ts)
  │      → GET /api/telephony/numbers/search (route: ленивый connectTelephony)
  │      → POST /api/telephony/numbers/buy   (route: ленивый connectTelephony)
  └─ Number(transfer): PortInPanel → POST /api/telephony/port-in/check → POST / → GET /
PhoneNumbersPage → PortInPanel(status-only) → GET /api/telephony/port-in
connectTelephony → grantWelcomeCredit → walletService.credit + billingService.subscribe('payg')
portInService → masterClient().numbers.v1.portingPortabilities/portingPortIns (+ doc upload numbers-upload.twilio.com)
```

SSE-событий фича не добавляет (статусы port-in — поллинг при открытии страниц; webhook-конфигурация Twilio Porting — задокументированное будущее улучшение, НЕ в скоупе).

## 9. Риски

- Twilio Porting/Documents API находится в Public Beta; риск изменения контракта принят, а feature-gate аккаунта деградирует в `PORTING_UNAVAILABLE` + локальный `action_required`.

---

## Iteration T6 — owner-итерация: 3-шаговый визард, постоянный раздел телефонии, transfer-баннер (2026-07-13)

Требования владельца — БИНДИНГ (см. requirements §T6). Базовое состояние: T1–T5 реализованы
(stepsMeta = 2 шага, сегмент «Get a new number | Transfer your number» на Number-шаге,
`PortInPanel` реюзабелен со `statusOnly`, port-in endpoints T2 live, `PhoneNumbersPage` уже
рендерит секцию «Number transfers»).

### T6.1 Степ-модель: 3 шага

`stepsMeta` (нормативные подписи):

| n | label | description |
|---|---|---|
| 1 | Pick your plan | $5 free credit included |
| 2 | Choose your number | It's live right away |
| 3 | Transfer your numbers | Now or later |

```
done_plan     = subscription != null && plan_id !== 'trial'                 (как сейчас)
done_number   = numbers.length >= 1 || hasActivePortIn                      (transfer-only путь
                по-прежнему считается «номер есть» — телефония подключена)
done_transfer = ∃ port-in запрос со status ∉ {canceled, failed}             (submitted/pending/…/completed)
                || port_in_prompt === 'dismissed'                            (серверный флаг, §T6.3)
derivedStep   = !done_number ? (done_plan ? 2 : 1)
              : (done_transfer ? 4 : 3)                                      (4 = completion)
activeStep    = stepOverride ?? derivedStep; override разрешён к шагам 1..3
?step= hint   = 1..3 (hint=4 игнорируется — completion только derived)
```

- Сегмент-тумблер «Get a new number | Transfer your number» со шага 2 **УДАЛЯЕТСЯ** —
  шаг 2 содержит только форму поиска+результаты; transfer целиком переезжает в шаг 3.
- **Шаг 2, нормативное пояснение** (тёплым тоном, 1–2 строки, над поиском, БЕЗ контейнера):
  **«Pick a number to get started — it can be a temporary line while your own numbers move
  over, or stay on as your main one.»**
- **Шаг 3 «Transfer your numbers — now or later»:** intro-копия (нормативно):
  **«Already have a business number your customers know? Move it into Albusto now — or come
  back to this anytime.»** Под ней два действия:
  - **«Transfer now»** (primary) → разворачивает `PortInPanel` (полный T4-флоу: check →
    форма → статус-карточки) прямо в потоке шага.
  - **«I'll do it later»** (ghost) → `POST /api/telephony/numbers/port-in-prompt/dismiss`
    (§T6.3) → toast **«You can transfer numbers anytime from Settings → Phone Numbers»** →
    рефетч → derived → completion. Ошибка POST → toast error, шаг остаётся.
- `PortInPanel` получает опциональный prop `recommendNewNumber?: boolean` (default `true`,
  T4-поведение сохранено): рекомендация «We recommend grabbing a new number now…» рендерится
  только при `recommendNewNumber` — визард на шаге 3 передаёт `!hasPurchasedNumber` (у кого
  номер уже куплен, рекомендация «возьми новый номер» неуместна). `onGetNewNumber` на шаге 3 →
  `setStepOverride(2)`.
- Wizard добавляет запрос `statusQ → GET /api/telephony/numbers/status` (нужен
  `port_in_prompt`). Fail-open: ошибка чтения → флаг считается null (шаг 3 покажется —
  безопасная деградация, dismiss повторно доступен).
- Completion (state 4) — прежняя копия §2.3 без изменений.

### T6.2 Постоянный раздел телефонии (`PhoneNumbersPage.tsx`) — канон-раскладка

Страница остаётся на `SettingsPageShell`; порядок контента сверху вниз (секции разделяются
spacing'ом, контейнеры невидимы, LAYOUT-CANON 7):

1. **Header actions** (когда `telState.connected`): чип `N / limit numbers` (как сейчас) +
   **«Get another number»** (primary, Plus; бывший «Buy number») + **«Transfer a number»**
   (outline).
2. **Баннер «Finish transferring your number»** (§T6.4) — первым блоком контента.
3. Usage-чип, A2P-степпер — как сейчас.
4. **«Number transfers»** (eyebrow-секция, только когда список непуст) — `PortInPanel
   statusOnly` (как в T4), state расшарен с transfer-панелью через `onRequestsChange`.
5. Поиск по своим номерам + таблица номеров — как сейчас.

Формы — слоями (FORM-CANON, right-side panel):

- **«Get another number»** открывает существующий `Dialog variant="panel"`, но внутренности
  buy-диалога **заменяются реюзом визардной формы**: из шага 2 визарда извлекается общий
  компонент `frontend/src/components/telephony/NumberSearch.tsx` (NEW) — AreaCodeCombo +
  FloatingField «Contains digits» + Checkbox Toll-free + Search + карточки результатов + Buy
  + обработка ошибок §7 (422 NUMBER_LIMIT upsell verbatim, 409 re-search, 403/5xx inline).
  Props: `{ onPurchased(), onViewPlans() }`; визард: `onViewPlans → setStepOverride(1)`;
  страница: `onViewPlans → navigate('/settings/integrations/telephony-twilio?step=1')`,
  `onPurchased → закрыть панель + loadData()`. Сырые `<input>` старого диалога удаляются
  (floating-канон).
- **«Transfer a number»** открывает `Dialog variant="panel"` (`DialogPanelHeader` «Transfer
  a number») с `PortInPanel` (полный режим, `recommendNewNumber={numbers.length === 0}`,
  `onRequestsChange` → обновить статус-секцию, `onGetNewNumber` → закрыть панель + открыть
  «Get another number»). Футер не нужен — у PortInPanel собственные CTA; закрытие — штатный
  OverlayClose.

### T6.3 Серверный флаг `port_in_prompt` (backend)

- Хранение: `companies.settings` jsonb, top-level ключ `port_in_prompt` = строка
  `'dismissed'` (других значений нет; отсутствие ключа = не dismissed).
- Запись — паттерн `onboardingChecklistService.markCompleted` (конкатенация `||` с
  COALESCE, **НЕ `jsonb_set`** — gotcha L-003: jsonb_set молча no-op'ится без родителя):

```sql
UPDATE companies
   SET settings = COALESCE(settings, '{}'::jsonb)
       || jsonb_build_object('port_in_prompt', 'dismissed')
 WHERE id = $1
RETURNING settings->>'port_in_prompt' AS port_in_prompt
```

- **Endpoints** — в существующем `backend/src/routes/telephonyNumbers.js` (mount уже под
  `authenticate, requirePermission('tenant.telephony.manage'), requireCompanyAccess`;
  company_id ТОЛЬКО из `req.companyFilter?.company_id`):
  - `GET /api/telephony/numbers/status` — ответ расширяется **top-level** полем:
    `{ ok, state, port_in_prompt: 'dismissed' | null }`. `getTelephonyState` НЕ трогается
    (его shape используют вебхуки/сервисы); обогащение — на уровне route-хендлера отдельным
    `SELECT settings->>'port_in_prompt' FROM companies WHERE id=$1`. Существующие потребители
    (`TelephonyLayout`, `PhoneNumbersPage`) читают только `j.state` — аддитивно безопасно.
  - `POST /api/telephony/numbers/port-in-prompt/dismiss` — SQL выше, идемпотентен (повторный
    вызов возвращает то же состояние), ответ `{ ok: true, port_in_prompt: 'dismissed' }`.
- **«I'll do it later»** (шаг 3 визарда) и **«Don't show again»** (баннер) вызывают ОДИН и
  тот же endpoint — один флаг гасит и возврат на шаг 3, и баннер. Undo нет (осознанно):
  transfer остаётся доступен всегда через постоянный раздел.

### T6.4 Баннер «Finish transferring your number»

- Место: верх контента `PhoneNumbersPage` (§T6.2 п.2).
- Условие показа (все четыре):
  `telState.connected && numbers.length >= 1 && portRequests.length === 0 && port_in_prompt !== 'dismissed'`.
  (Любой существующий port-in запрос, включая canceled, гасит баннер — заявка уже была,
  пользователь дорогу знает.)
- Вид: одиночная карточка `border var(--blanc-line)`, radius 16, padding 14–16 (паттерн
  awaitingPayment-карточки визарда), без вложенных блоков, без full-width кнопок.
- Нормативная копия: заголовок **«Finish transferring your number»**, текст:
  **«Your new number is live. When you're ready, bring your existing number over — customers
  keep reaching you at the number they already know.»** Кнопки: **«Transfer now»** (primary,
  открывает панель «Transfer a number» §T6.2) и **«Don't show again»** (ghost → POST dismiss
  → optimistic скрытие; ошибка → toast + баннер остаётся).

### T6.5 Чистая логика и тесты

- `frontend/src/components/telephony/portInPrompt.ts` (NEW, pure, без React):
  `deriveWizardStep({donePlan, doneNumber, doneTransfer})` и
  `shouldShowTransferBanner({connected, numbersCount, portRequestsCount, portInPrompt})` —
  визард и страница используют их; vitest-сьют рядом.
- Jest (`tests/telephonyPortInPrompt.test.js`, NEW): 401 без токена; 403 без права;
  изоляция (dismiss компании A не задевает B; статус B остаётся null); идемпотентность
  (двойной POST → одна и та же строка `'dismissed'`, прочие ключи settings не потёрты);
  NULL-settings компания (COALESCE-ветка); `GET /status` отдаёт `port_in_prompt` null →
  `'dismissed'` после POST.

### T6.6 Безопасность / инварианты

- Никаких новых прав: всё под `tenant.telephony.manage`; изоляция — `req.companyFilter`.
- `getTelephonyState`, port-in endpoints T2, NUMBER_LIMIT-upsell (verbatim), Stripe-поллинг,
  derived-step принцип (сервер = источник правды) — не трогаются.
- Флаг — companies.settings (без миграции); прочие ключи settings (onboarding_checklist и
  будущие) сохраняются конкатенацией.
