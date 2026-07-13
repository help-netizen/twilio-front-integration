# Спецификация: CLIENT-FEEDBACK-WIDGET-001 — In-app product feedback (CRM user → Albusto developer)

**Status:** Spec
**Requirements:** `docs/requirements.md` → CLIENT-FEEDBACK-WIDGET-001
**Architecture:** `docs/architecture.md` → «Архитектурное решение для фичи CLIENT-FEEDBACK-WIDGET-001»
**Test cases:** `docs/test-cases/CLIENT-FEEDBACK-WIDGET-001.md`

## Общее описание

Глобально смонтированный floating-виджет, через который залогиненный пользователь CRM пишет продуктовый
фидбек разработчику Albusto. Мессенджер-панель начинается с детерминированной бот-заглушки (правила, НЕ AI);
по клику «Talk to a human» или после N=2 канон-ответов бот эскалирует и показывает форму. На Send обращение
сохраняется в `feedback_submissions` (истина) и best-effort уходит письмом на `support@albusto.com`. Тенантный
таск НЕ создаётся, телефон НЕ запрашивается.

---

## Сценарии поведения

### Сценарий 1: Фидбек через форму-эскалацию (happy path)
- **Предусловия:** пользователь залогинен; `AppLayout` активен (не `/signup`, не `/onboarding`); фича-флаг on.
- **Входные данные:** email (prefill из `useAuth().user.email`, редактируемо), message (textarea), 0..5 файлов.
- **Шаги:**
  1. (FE) Клик по floating-кнопке → панель открывается, бот-стейт `greeting`: приветственный пузырь +
     всегда видимая кнопка «Talk to a human».
  2. (FE) Пользователь пишет сообщение(я); бот отвечает канон-репликой (эфемерно, без бэка) и инкрементит
     `botReplies`.
  3. (FE) Пользователь жмёт «Talk to a human» ИЛИ `botReplies` достигает 2 → стейт `escalated`: бот постит
     *«Okay — leave your details below and we'll get back to you»* и рендерит форму.
  4. (FE) Пользователь правит/подтверждает email, заполняет «What happened?», опц. прикрепляет файлы, жмёт Send.
  5. (FE) Клиентская валидация (email-формат, message non-empty, файлы ≤5/≤10MB/mime) → при ОК собирается
     `FormData` (`email`, `message`, `files[]`) и `authedFetch('/api/feedback', { method:'POST', body })`.
  6. (BE) `feedbackService.submitFeedback`: серверная валидация → `insertFeedback` (истина) → best-effort
     `emailService.sendEmail(SENDER_COMPANY_ID, { to: FEEDBACK_INBOX_EMAIL, files, … })` в try/catch.
  7. (BE) Ответ `201 { ok:true, data:{ id } }`.
  8. (FE) Success-стейт: тёплое «Thanks — we got it» ; панель можно закрыть.
- **Ожидаемый результат:** одна строка в `feedback_submissions` с `company_id`/`user_id`/`user_email`/`message`
  и `meta` (вложения-мета + `email_status`). Письмо доставлено (если платформенный mailbox подключён).
- **Побочные эффекты:** best-effort письмо; НЕ создаётся тенантный task; нет SSE.

### Сценарий 2: Эскалация по счётчику сообщений
- **Шаги:** пользователь отправляет 2 сообщения без клика «human» → бот эскалирует автоматически (шаг 3 выше).
- **Ожидаемый результат:** форма показана; далее как SC-01.

### Сценарий 3: Только бот, без обращения
- **Шаги:** пользователь общается со стабом и закрывает панель, не эскалировав / не нажав Send.
- **Ожидаемый результат:** НИ строки в БД, НИ письма. Стейт панели эфемерный (сброс при повторном открытии —
  допускается сохранение стейта в рамках сессии страницы, но НЕ персист на бэке).

### Сценарий 4: Ошибка валидации на Send
- **Входные данные:** невалидный email / пустой message / файл >10MB / >5 файлов / запрещённый mime.
- **Шаги:** FE-валидация ловит первым; если проскочило — BE возвращает `422 { ok:false, error }`.
- **Ожидаемый результат:** inline-ошибка в панели, строка НЕ создаётся, письмо НЕ шлётся.

### Сценарий 5: Email-канал недоступен/сбоит (надёжность)
- **Предусловия:** у платформенной компании нет подключённого Gmail ИЛИ Gmail отдаёт ошибку.
- **Шаги:** `insertFeedback` проходит; `emailService.sendEmail` бросает → перехвачено в try/catch →
  `meta.email_status='failed'|'skipped'` + `console.warn`.
- **Ожидаемый результат:** ответ всё равно `201`, пользователь видит успех (истина = строка в БД). Данные не
  потеряны. Письмо-сбой не роняет запрос.

---

## Граничные случаи

1. `email` пустой, но `user.email` есть → сервер fallback на `req.user.email`; если и он пуст → 422.
2. Ровно 5 файлов по 10MB → принять; 6-й файл или файл 10MB+1 → 422 (multer `LIMIT_FILE_COUNT`/`LIMIT_FILE_SIZE`
   маппится в 422, не 500).
3. Пустой `files[]` (текст без вложений) → валидно.
4. `message` из одних пробелов → trim → пусто → 422.
5. mime не из allowlist (pdf/png/jpg/gif/webp/txt) → 422; проверка по `file.mimetype`.
6. Панель открыта на `/schedule` или узком мобиле → панель узкая, не перекрывает `BottomNavBar`/softphone.
7. Двойной клик Send → кнопка дизейблится на время запроса (idempotency на клиенте; дубль-строки допустимы, но
   не желательны — сервер не дедуплицирует в MVP).
8. Живой звонок в softphone (z-9000) перекрывает FAB (z<9000) — ожидаемо.

---

## Обработка ошибок

1. Сетевой сбой на Send → inline-ошибка «Couldn't send — try again», кнопка снова активна, строка не создана.
2. `422` с бэка → показать `error` из ответа под формой.
3. `401` (протухший токен) → `authedFetch` уже управляет редиректом; виджет показывает generic-ошибку.
4. BE: ошибка INSERT (истина не создалась) → `500`, письмо НЕ шлётся, пользователь видит ошибку (успех
   только при созданной строке).
5. BE: ошибка письма при успешном INSERT → залогировать, вернуть `201` (best-effort).

---

## Взаимодействие компонентов

- `FeedbackWidget` (FE) → `authedFetch POST /api/feedback` (multipart) → `routes/feedback.js` (multer) →
  `feedbackService.submitFeedback` → `feedbackQueries.insertFeedback` (PostgreSQL) → best-effort
  `emailService.sendEmail(SENDER_COMPANY_ID)` → Gmail API.
- Бот-заглушка: чисто клиентский стейт-автомат, без сети до момента Send.
- SSE: не используется (одноразовое обращение, без real-time обновлений).

---

## API-контракты

### `POST /api/feedback`
- **Назначение:** принять и надёжно сохранить обращение фидбека; best-effort уведомить письмом.
- **Middleware:** `authenticate, requireCompanyAccess` (маунт в `src/server.js`).
- **Изоляция:** `company_id` из `req.companyFilter?.company_id`; `user_id` из `req.user?.crmUser?.id`
  (НЕ `sub`). INSERT всегда с `company_id`.
- **Request:** `multipart/form-data`
  - `email: string` (required; проверяется формат)
  - `message: string` (required; non-empty после trim)
  - `files: File[]` (0..5; каждый ≤10MB; mime ∈ {pdf,png,jpg,gif,webp,txt})
- **Response 201:** `{ ok: true, data: { id: uuid } }`
- **Ошибки:** `422` (валидация email/message/файлов), `401` (нет токена), `403` (нет привязки к компании),
  `500` (сбой INSERT).
- **Env:** `FEEDBACK_INBOX_EMAIL` (default `support@albusto.com`), `FEEDBACK_SENDER_COMPANY_ID`
  (default `00000000-0000-0000-0000-000000000001`), `FEEDBACK_MAX_FILES=5`, `FEEDBACK_MAX_FILE_MB=10`.

---

## Безопасность и изоляция данных

- Все записи содержат `company_id` из `req.companyFilter` — обращения одной компании не смешиваются с другой.
- `user_id` = `req.user.crmUser.id` (FK на `crm_users`), nullable для tokenless-контекстов; НИКОГДА не пишем
  Keycloak `sub` в FK-колонку (created_by-FK gotcha → 500).
- Письмо шлётся от ПЛАТФОРМЕННОГО отправителя (дефолт-компания), не раскрывая mailbox тенанта и не завися от
  его подключения Gmail.
- Виджет не рендерится на `/signup` и `/onboarding` (нет сессии — нет канала).
- Prompt-injection неактуален: бот детерминированный, LLM в цепочке нет.

## Дизайн (канон)

- Токены `--blanc-*`; `FloatingField` для email + textarea; без block-in-block; без «Blanc» в копирайте.
- Тон копирайта — тёплый, английский (ONBOARDING-UX-001): greeting, канон-реплики, нормативная фраза
  эскалации *«Okay — leave your details below and we'll get back to you»*, success *«Thanks — we got it»*.
- Позиция: FAB нижний-правый, `z-index` 8000-8500 (ниже softphone 9000); мобайл — `bottom` выше `BottomNavBar`,
  узкая панель.
