# Тест-кейсы: CLIENT-FEEDBACK-WIDGET-001

**Spec:** `docs/specs/CLIENT-FEEDBACK-WIDGET-001.md`

## Покрытие
- Всего тест-кейсов: 22
- P0: 7 | P1: 9 | P2: 5 | P3: 1
- Unit/Integration (backend jest+supertest): 15 | Component (frontend vitest): 7

Файлы тестов:
- Backend: `backend/tests/routes/feedback.test.js`, `backend/tests/services/feedbackService.test.js`
- Frontend: `frontend/src/components/feedback/FeedbackWidget.test.tsx`

Моки: `emailService.sendEmail` (jest-mock → resolve/reject); `feedbackQueries.insertFeedback` (spy);
внешних интеграций (Twilio/Front/Zenbooker) нет.

---

### TC-CFW-001: Успешное сохранение + best-effort письмо
- **Приоритет:** P0 · **Тип:** Integration (supertest)
- **Связанный сценарий:** SC-01
- **Предусловия:** валидный токен, `req.companyFilter.company_id = A`.
- **Входные данные:** `email='ok@x.com'`, `message='button broken'`, без файлов.
- **Моки:** `insertFeedback` → `{ id:'uuid' }`; `sendEmail` → resolve.
- **Шаги:** POST /api/feedback (multipart).
- **Ожидаемый результат:** `201 { ok:true, data:{ id } }`; `insertFeedback` вызван с `company_id=A`,
  `user_id=crmUser.id`, `user_email='ok@x.com'`; `sendEmail` вызван с `to=FEEDBACK_INBOX_EMAIL`,
  `SENDER_COMPANY_ID`.

### TC-CFW-002: Письмо-сбой НЕ роняет сохранение (надёжность)
- **Приоритет:** P0 · **Тип:** Integration
- **Связанный сценарий:** SC-05
- **Моки:** `insertFeedback` → `{ id }`; `sendEmail` → **reject** (`new Error('no mailbox')`).
- **Ожидаемый результат:** ответ всё равно `201`; строка создана; `meta.email_status='failed'`; ошибка
  залогирована, не проброшена. Запрос не 500.

### TC-CFW-003: Нет платформенного mailbox → email skipped, сохранение ок
- **Приоритет:** P1 · **Тип:** Integration
- **Связанный сценарий:** SC-05
- **Моки:** `emailMailboxService.getValidAccessToken` → reject; `insertFeedback` → `{ id }`.
- **Ожидаемый результат:** `201`; `meta.email_status` ∈ {`failed`,`skipped`}; строка есть.

### TC-CFW-004: Невалидный email → 422
- **Приоритет:** P0 · **Тип:** Integration
- **Связанный сценарий:** SC-04
- **Входные данные:** `email='not-an-email'`, `message='x'`.
- **Ожидаемый результат:** `422 { ok:false, error }`; `insertFeedback` НЕ вызван; `sendEmail` НЕ вызван.

### TC-CFW-005: Пустой message → 422
- **Приоритет:** P0 · **Тип:** Integration
- **Связанный сценарий:** SC-04, граничный #4
- **Входные данные:** `email='ok@x.com'`, `message='   '` (пробелы).
- **Ожидаемый результат:** `422`; ничего не сохранено/не отправлено.

### TC-CFW-006: Файл >10MB → 422
- **Приоритет:** P0 · **Тип:** Integration
- **Связанный сценарий:** SC-04, граничный #2
- **Входные данные:** один файл 10MB+1, валидный mime.
- **Ожидаемый результат:** `422` (multer `LIMIT_FILE_SIZE` смаплен в 422, НЕ 500); строка не создана.

### TC-CFW-007: >5 файлов → 422
- **Приоритет:** P1 · **Тип:** Integration
- **Связанный сценарий:** SC-04, граничный #2
- **Входные данные:** 6 валидных файлов.
- **Ожидаемый результат:** `422` (multer `LIMIT_FILE_COUNT` → 422).

### TC-CFW-008: Запрещённый mime → 422
- **Приоритет:** P1 · **Тип:** Integration
- **Связанный сценарий:** SC-04, граничный #5
- **Входные данные:** один файл `application/x-msdownload`.
- **Ожидаемый результат:** `422`; строка не создана.

### TC-CFW-009: Ровно 5 файлов ≤10MB → 201
- **Приоритет:** P2 · **Тип:** Integration
- **Связанный сценарий:** граничный #2
- **Входные данные:** 5 валидных файлов (png/pdf/jpg/webp/txt).
- **Ожидаемый результат:** `201`; `sendEmail` получил `files.length===5`; `meta.attachments` = 5 записей
  `{name,size,mime}`.

### TC-CFW-010: Текст без вложений → 201
- **Приоритет:** P2 · **Тип:** Integration
- **Связанный сценарий:** граничный #3
- **Ожидаемый результат:** `201`; `sendEmail` вызван с `files=[]`.

### TC-CFW-011: 401 без токена
- **Приоритет:** P0 · **Тип:** Integration (middleware)
- **Ожидаемый результат:** `401`; роут не выполняет тело; INSERT/email не вызваны.

### TC-CFW-012: 403 без привязки к компании
- **Приоритет:** P1 · **Тип:** Integration (middleware)
- **Предусловия:** токен есть, `requireCompanyAccess` не проходит (нет company).
- **Ожидаемый результат:** `403`.

### TC-CFW-013: Изоляция company_id — INSERT берёт company из req, не из тела
- **Приоритет:** P1 · **Тип:** Integration
- **Входные данные:** тело содержит подставной `company_id='B'`; `req.companyFilter.company_id='A'`.
- **Ожидаемый результат:** `insertFeedback` вызван с `company_id='A'` (тело игнорируется); кросс-тенантная
  запись невозможна.

### TC-CFW-014: user_id = crmUser.id, не Keycloak sub
- **Приоритет:** P1 · **Тип:** Integration
- **Предусловия:** `req.user.crmUser.id='c-1'`, `req.user.sub='kc-1'`.
- **Ожидаемый результат:** `insertFeedback` получил `user_id='c-1'` (created_by-FK gotcha соблюдён).

### TC-CFW-015: Email fallback из req.user.email
- **Приоритет:** P2 · **Тип:** Unit (feedbackService)
- **Входные данные:** `email` в теле пуст, `req.user.email='fallback@x.com'`, `message='x'`.
- **Ожидаемый результат:** `user_email='fallback@x.com'`; при отсутствии обоих → 422.

---

### TC-CFW-016: Бот эскалирует по клику «Talk to a human»
- **Приоритет:** P0 · **Тип:** Component (vitest)
- **Связанный сценарий:** SC-01
- **Шаги:** рендер `FeedbackWidget`; открыть панель; клик «Talk to a human».
- **Ожидаемый результат:** появляется нормативная фраза *«Okay — leave your details below…»* и форма
  (email + textarea + file input + Send).

### TC-CFW-017: Бот эскалирует после 2 канон-ответов
- **Приоритет:** P1 · **Тип:** Component
- **Связанный сценарий:** SC-02, граничный по счётчику
- **Шаги:** открыть панель; отправить 2 сообщения.
- **Ожидаемый результат:** после второго канон-ответа стейт `escalated`, форма показана без клика «human».

### TC-CFW-018: Email prefill из useAuth().user.email (редактируемо)
- **Приоритет:** P0 · **Тип:** Component
- **Моки:** `useAuth` → `{ user:{ email:'me@x.com' } }`.
- **Ожидаемый результат:** поле email в форме = `me@x.com`; ввод меняет значение (редактируемо).

### TC-CFW-019: Клиентская валидация — пустой message блокирует Send
- **Приоритет:** P1 · **Тип:** Component
- **Связанный сценарий:** SC-04
- **Ожидаемый результат:** при пустом «What happened?» Send дизейблен/показывает ошибку; `authedFetch` не
  вызывается.

### TC-CFW-020: Success-стейт после 201
- **Приоритет:** P1 · **Тип:** Component
- **Моки:** `authedFetch` → `{ ok:true, json:()=>({ ok:true, data:{ id:'1' } }) }`.
- **Ожидаемый результат:** показан success («Thanks — we got it»); форма скрыта.

### TC-CFW-021: Ошибка сети → inline-ошибка, Send снова активен
- **Приоритет:** P2 · **Тип:** Component
- **Связанный сценарий:** обработка ошибок #1
- **Моки:** `authedFetch` → reject.
- **Ожидаемый результат:** inline «Couldn't send — try again»; кнопка Send активна; success не показан.

### TC-CFW-022: Фича-флаг off → виджет не рендерится
- **Приоритет:** P3 · **Тип:** Component
- **Входные данные:** `VITE_FEATURE_FEEDBACK_WIDGET='false'`.
- **Ожидаемый результат:** floating-кнопка отсутствует в DOM.
