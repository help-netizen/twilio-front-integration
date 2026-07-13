# Тест-кейсы: TELEPHONY-WIZARD-UX-001

Спецификация: `docs/specs/TELEPHONY-WIZARD-UX-001.md`.
Моки Twilio: `twilio` npm — mock `masterClient()`/`getClientForCompany` на уровне
jest.mock (паттерн существующих telephony-тестов); Porting-методы
(`numbers.v1.portingPortabilities(...).fetch`, `portingPortIns.create/fetch/remove`) — jest.fn.
Jest в worktree — с `--testPathIgnorePatterns "/node_modules/"`.
Амендмент-9: TC-001/002 (идемпотентность $5) прогнать на dev-БД (реальный Postgres, mock только Twilio).

### Покрытие
- Всего: 28 · P0: 9 | P1: 11 | P2: 6 | P3: 2
- Unit: 9 | Integration: 15 | E2E/preview: 4

---

## A. $5 welcome-бонус + ленивый connect

### TC-WIZ-001: Первый connect начисляет ровно один кредит $5 и активирует payg
- **Приоритет:** P0 · **Тип:** Integration (jest, dev-БД)
- **Связанный сценарий:** §1.2
- **Предусловия:** свежая компания (не default), trial-подписка, кошелька нет; Twilio mock `accounts.create` → `{sid:'ACsub', authToken:'tok'}`.
- **Шаги:** `connectTelephony(companyId)` дважды подряд (sequential).
- **Ожидаемый результат:** `billing_wallet_ledger` содержит РОВНО одну строку `ref='welcome_credit:v1'`, `amount_usd=5`, `type='adjustment'`; `billing_wallets.balance_usd=5.00`; `billing_subscriptions.plan_id='payg', status='active'`; `accounts.create` вызван один раз.
- **Файл:** `tests/telephonyWelcomeCredit.test.js`

### TC-WIZ-002: Параллельный двойной connect → один кредит
- **Приоритет:** P0 · **Тип:** Integration (dev-БД)
- **Шаги:** `Promise.all([connectTelephony(c), connectTelephony(c)])` (mock create возвращает разные SID с задержкой).
- **Ожидаемый результат:** одна ledger-строка `welcome_credit:v1` (UNIQUE + FOR UPDATE); ошибок не всплывает.
- **Файл:** `tests/telephonyWelcomeCredit.test.js`

### TC-WIZ-003: Default-компания не получает бонус
- **Приоритет:** P1 · **Тип:** Integration
- **Шаги:** `connectTelephony(DEFAULT_COMPANY_ID)`.
- **Ожидаемый результат:** early return `mode:'master'`; ledger пуст; `accounts.create` не вызван.

### TC-WIZ-004: Уже подключённая компания (ретро) — без бонуса
- **Приоритет:** P1 · **Тип:** Integration
- **Предусловия:** `company_telephony` строка с SID существует.
- **Ожидаемый результат:** early return; ledger без `welcome_credit:v1`.

### TC-WIZ-005: Компания на платном пакете при первом connect — кредит есть, план не сбит
- **Приоритет:** P2 · **Тип:** Integration
- **Предусловия:** подписка `plan_id='team', status='active'`.
- **Ожидаемый результат:** кредит $5 начислен; `plan_id` остался `team` (subscribe('payg') НЕ вызван).

### TC-WIZ-006: Сбой начисления кредита не валит connect
- **Приоритет:** P1 · **Тип:** Unit
- **Моки:** `walletService.credit` → throws.
- **Ожидаемый результат:** `connectTelephony` резолвится `connected:true`; ошибка залогирована.

### TC-WIZ-007: GET /search лениво подключает телефонию
- **Приоритет:** P0 · **Тип:** Integration (supertest)
- **Предусловия:** компания не подключена; авторизованный tenant_admin.
- **Шаги:** `GET /api/telephony/numbers/search?area_code=617`.
- **Ожидаемый результат:** 200 с results (mock availablePhoneNumbers); `company_telephony` создана; бонус начислен. Повторный запрос НЕ создаёт второй субаккаунт.
- **Файл:** `tests/telephonyWelcomeCredit.test.js`

### TC-WIZ-008: POST /buy лениво подключает (deep-link страховка)
- **Приоритет:** P2 · **Тип:** Integration
- **Ожидаемый результат:** buy у неподключённой компании сначала создаёт субаккаунт, затем покупает; NUMBER_LIMIT-логика (422) не регрессировала при подключённой компании.

### TC-WIZ-009: Ошибка Twilio при ленивом connect → поиск падает без частичного состояния
- **Приоритет:** P1 · **Тип:** Integration
- **Моки:** `accounts.create` → throws.
- **Ожидаемый результат:** `/search` → 5xx структурный `{ok:false}`; `company_telephony` НЕ создана; ledger пуст.

## B. Endpoints: auth + изоляция

### TC-WIZ-010: Порт-ин endpoints без токена → 401
- **Приоритет:** P0 · **Тип:** Integration
- **Шаги:** `GET /api/telephony/port-in`, `POST /api/telephony/port-in`, `POST /check`, `GET /:id`, `DELETE /:id` без Authorization.
- **Ожидаемый результат:** все → 401.
- **Файл:** `tests/telephonyPortIn.test.js`

### TC-WIZ-011: Порт-ин без права tenant.telephony.manage → 403
- **Приоритет:** P0 · **Тип:** Integration
- **Предусловия:** токен роли provider (нет права).
- **Ожидаемый результат:** 403 на всех port-in endpoints и на `GET /numbers/locale`.

### TC-WIZ-012: Изоляция: компания A не видит заявки компании B
- **Приоритет:** P0 · **Тип:** Integration
- **Предусловия:** заявка у компании B.
- **Шаги:** от имени A: `GET /api/telephony/port-in` и `GET /api/telephony/port-in/:idB`, `DELETE /:idB`.
- **Ожидаемый результат:** список пуст; GET/DELETE по чужому id → 404 (не 200/403).

### TC-WIZ-013: GET /numbers/locale отдаёт локаль ТОЛЬКО своей компании
- **Приоритет:** P1 · **Тип:** Integration
- **Предусловия:** company A zip 02108 (в zip_geocache), company B zip 90210.
- **Ожидаемый результат:** под токеном A — координаты 02108; SQL фильтрует по company_id из req.companyFilter.

## C. Port-in флоу

### TC-WIZ-014: Happy path создания заявки
- **Приоритет:** P0 · **Тип:** Integration
- **Моки:** portability fetch → `{portable:true, numberType:'local'}`; doc upload → `{sid:'RD1'}`; portingPortIns.create → `{portInRequestSid:'KW1', portInRequestStatus:'pending', signatureRequestUrl:'https://…'}`.
- **Шаги:** `POST /api/telephony/port-in` multipart с валидными полями + utility_bill.pdf.
- **Ожидаемый результат:** 201; строка в `port_in_requests` (company_id, phone_number, twilio_port_in_sid='KW1', status='pending', created_by=crmUser.id, documents=['RD1']); create вызван с `accountSid` = субаккаунт компании; response БЕЗ losing_carrier_info.
- **Файл:** `tests/telephonyPortIn.test.js`

### TC-WIZ-015: Непереносимый номер → 422 NOT_PORTABLE, заявка не создаётся
- **Приоритет:** P0 · **Тип:** Integration
- **Моки:** portability → `{portable:false, notPortableReason:'Number is not active'}`.
- **Ожидаемый результат:** 422 `{code:'NOT_PORTABLE', error: содержит reason}`; portingPortIns.create НЕ вызван; таблица пуста.

### TC-WIZ-016: target_port_in_date < 7 дней → 422 TARGET_DATE_TOO_SOON
- **Приоритет:** P1 · **Тип:** Integration
- **Входные данные:** `target_port_in_date = today+3d`.
- **Ожидаемый результат:** 422 ДО любых Twilio-вызовов.

### TC-WIZ-017: Невалидный номер / отсутствующий файл → 422
- **Приоритет:** P1 · **Тип:** Integration
- **Входные данные:** (a) `phone_number='617555'`; (b) валидный номер, без файла utility_bill.
- **Ожидаемый результат:** оба → 422 VALIDATION с человекочитаемым текстом.

### TC-WIZ-018: Дубликат активной заявки → 409 PORT_ALREADY_REQUESTED
- **Приоритет:** P1 · **Тип:** Integration
- **Предусловия:** активная заявка (status='pending') на тот же номер той же компании.
- **Ожидаемый результат:** 409; вторая строка не создана. Терминальная (canceled) старая заявка НЕ блокирует новую (позитивная ветка).

### TC-WIZ-019: GET /:id делает live-refresh статуса
- **Приоритет:** P1 · **Тип:** Integration
- **Моки:** portingPortIns(sid).fetch → `{portInRequestStatus:'in review'}`.
- **Ожидаемый результат:** нормализация `in review → in_review`; строка обновлена (status, twilio_status, updated_at); response с новым статусом.

### TC-WIZ-020: DELETE отменяет незавершённую, отклоняет терминальную
- **Приоритет:** P2 · **Тип:** Integration
- **Ожидаемый результат:** pending → Twilio.remove вызван, status='canceled', 200; completed → 409 NOT_CANCELABLE, Twilio не вызван; Twilio 404 на remove → трактуется как успех отмены.

### TC-WIZ-021: Porting недоступен на аккаунте → 502 PORTING_UNAVAILABLE + строка action_required
- **Приоритет:** P2 · **Тип:** Integration
- **Моки:** portingPortIns.create → Twilio error 403/404 продукта.
- **Ожидаемый результат:** 502 `{code:'PORTING_UNAVAILABLE'}`; строка сохранена со status='action_required' (fallback-стейт §4.2).

## D. Frontend unit (vitest)

### TC-WIZ-022: suggestAreaCodes — локальные первыми по дистанции
- **Приоритет:** P0 · **Тип:** Unit (vitest)
- **Входные данные:** locale Boston `{lat:42.36, lon:-71.06}`; query ''.
- **Ожидаемый результат:** первые подсказки — 617/857 (Boston) раньше 508/413; ≤8 штук.
- **Файл:** `frontend/src/data/areaCodes.test.ts`

### TC-WIZ-023: suggestAreaCodes — фолбэки локали
- **Приоритет:** P1 · **Тип:** Unit (vitest)
- **Входные данные:** (a) locale без координат, state='MA' → только MA-коды; (b) locale пустая → пустой список (ничего не подсказываем).
- **Ожидаемый результат:** как указано; не-локальные коды не появляются ни в одном кейсе.

### TC-WIZ-024: detectSearchKind — цифры vs город
- **Приоритет:** P1 · **Тип:** Unit (vitest)
- **Входные данные:** '617' → area_code; '61' (ручной сабмит) → locality? НЕТ: '61' не 3 цифры → locality НЕ верно для цифр — ожидание: 1-2 цифры = невалидный сабмит (поиск без критерия кода), тест фиксирует контракт: ровно 3 цифры → `{kind:'area_code'}`; 'Boston' → `{kind:'locality'}`; '' → null.
- **Ожидаемый результат:** контракт функции стабилен (см. спека §3.2).

### TC-WIZ-025: Клик по текущему тарифу — no-op подтверждение
- **Приоритет:** P1 · **Тип:** Unit (vitest, RTL)
- **Предусловия:** subscription.plan_id='payg'.
- **Шаги:** рендер Plans-шага, клик по карте payg.
- **Ожидаемый результат:** fetch НЕ вызван (ни /connect, ни /checkout); переход на Number-шаг; карта payg НЕ disabled.

## E. E2E / preview (амендмент-9: живой стенд не обязателен, preview обязателен)

### TC-WIZ-026: Мобайл 375 — результаты поиска не обрезаются (OB-5)
- **Приоритет:** P0 · **Тип:** E2E (preview, viewport 375×812)
- **Шаги:** Number-шаг → поиск с ≥10 результатами (mock/dev-Twilio) → скролл вниз.
- **Ожидаемый результат:** все карточки достижимы скроллом экрана; нет вложенного скролла/пустой серой зоны; форма без серого контейнера (OB-2); десктоп 1280 — без регрессий.

### TC-WIZ-027: Полный новый флоу визарда (desktop preview)
- **Приоритет:** P1 · **Тип:** E2E (preview)
- **Шаги:** новая компания → визард: Plans с копией «You have $5…» и Skip → Number → поиск (лениво коннектит) → wallet-чип $5.00 появился (после refetch) → Buy → Completion.
- **Ожидаемый результат:** шага «Set up your line» нет; стрелка шагов = 2 шага; derived-переходы устойчивы к F5.

### TC-WIZ-028: Stripe-экран OB-7 (preview)
- **Приоритет:** P1 · **Тип:** E2E (preview)
- **Шаги:** Stripe Payments not-connected; затем connected-стейт.
- **Ожидаемый результат:** один hero-блок (What it costs отсутствует, чипы цен в hero на месте); Setup steps: «Link your Stripe account», «Tell Stripe about your business», «Card payments switched on», «Tap to Pay on your phone» (Coming soon), «Start getting paid — collect your first payment right from a job»; порядок и done-галки прежние.
