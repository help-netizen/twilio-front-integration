# E2E-REGRESSION-001 — Pre-deploy E2E regression suite

**Status:** Draft — Phase 1 (P0) описан, реализация не начата
**Owner decisions (locked 2026-08-09):** Playwright + TypeScript · target = **staging на mini** (`https://kurais-mac-mini.taile2152e.ts.net`) · «Регистрация» = публичный `/signup` + онбординг.
**Purpose:** зелёный свет на прод-деплой. Прогоняем против staging (авто из master ≤10 мин, интеграции обезврежены) **перед** прод-деплоем; если P0 красный — деплой стоп.

---

## 1. Scope

- **Phase 1 (P0, «smoke gate»)** — 16 тестов по ядру: auth, публичная регистрация, create contact/lead/job/estimate/invoice, approve estimate→invoice, schedule + assign + reschedule + reassign, on-the-way status transition (plain + notify-only modal + live card update). Это минимум, который должен быть зелёным перед каждым прод-деплоем.
- **Phase 2 (P1)** и **Phase 3 (P2)** — глубже (edit/detail/search/status/finance/void/RBAC/mobile) — перечислены в §9, детально опишем после того, как P0 поедет.
- **Вне скоупа suite:** нагрузочное, безопасность, кросс-браузер (кроме P2 mobile), реальная доставка email/SMS/charge (интеграции на staging обезврежены — проверяем только in-app подтверждение).

## 2. Framework & architecture

- **Playwright + TypeScript.** Каталог `e2e/` в корне репо (отдельно от Jest-юнитов).
- **Структура:**
  ```
  e2e/
    playwright.config.ts        # baseURL=staging, projects, retries=2, trace on-first-retry
    global-setup.ts             # логин по ролям → storageState/*.json (один раз)
    fixtures/
      auth.ts                   # per-role authed context (reuse storageState)
      api.ts                    # REST-клиент для setup/teardown (Bearer тест-юзера)
      data.ts                   # фабрики: makeContact/makeJob/makeTech + RUN_ID
    pages/                      # page-objects
      LoginPage.ts JobsPage.ts NewJobModal.ts ContactsPage.ts LeadsPage.ts
      CreateLeadDialog.ts JobPanel.ts EstimateEditor.ts InvoiceEditor.ts
      SchedulePage.ts SlotPicker.ts SignupPage.ts
    tests/
      smoke.spec.ts auth.spec.ts registration.spec.ts contacts.spec.ts
      leads.spec.ts jobs.spec.ts estimates.spec.ts invoices.spec.ts schedule.spec.ts
  ```
- **Config:** `retries: 2` (только на CI), `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'` — для разбора падений без переспрашивания.
- **npm-скрипты:** `e2e:smoke` (grep `@p0`), `e2e:full` (P0+P1), `e2e:headed`, `e2e:ui`.
- **Теги в названиях:** `@p0`/`@p1`/`@p2` + `@suite:auth` и т.п. — для фильтрации прогона.

## 3. Target environment

- **baseURL:** `https://kurais-mac-mini.taile2152e.ts.net` (staging на mini, доступ через Tailscale — раннер должен быть в tailnet).
- **Предусловие прогона:** авто-деплой master→staging зелёный. Гейт-скрипт сначала проверяет `ssh mini cat albusto-staging/state/status` (RED → тесты не запускаем, деплой стоп).
- Интеграции (Twilio/VAPI/Stripe/email) на staging **обезврежены** — см. §6.

## 4. Auth strategy

- **Один логин на роль в `global-setup`** через Keycloak (crm-prod realm) → `storageState` сохраняется → все не-auth тесты стартуют уже залогиненными (быстро, без флаки-логина на каждый тест).
- **Тест-юзеры без 2FA/SSO** (2FA ломает автоматизацию). Роли: `admin` (полный доступ) + `provider` (для RBAC-тестов в P1).
- **Креды — только через env** (`E2E_ADMIN_USER`/`E2E_ADMIN_PASS`, `E2E_PROVIDER_*`). В коде/репо паролей нет и не будет: секрет, попавший в общий remote, остаётся там навсегда, что бы потом ни вычищали.
- **ГДЕ ИХ БРАТЬ (чтобы не спрашивать каждый раз):** файл **`e2e/.env.local`** — он gitignored (`e2e/.gitignore`), шаблон рядом: `e2e/.env.local.example`. Значения — у владельца в менеджере паролей; админский логин — рабочая почта владельца. Файл локальный, поэтому в новом клоне/воркtree его не будет: спросить ОДИН раз, записать и дальше пользоваться молча.
- **Запуск:**
  ```sh
  set -a && . e2e/.env.local && set +a && cd e2e && npm run smoke   # только @p0
  set -a && . e2e/.env.local && set +a && cd e2e && npm test        # весь набор
  ```
- **Сами AUTH-тесты** (login/logout/invalid) гоняются в **свежем контексте** без storageState.

## 5. Test-data strategy

- **RUN_ID** = `e2e-<timestamp>-<shortRand>` префиксится ко всем создаваемым именам → идемпотентность + параллельные прогоны не сталкиваются + лёгкая идентификация/уборка.
- **Setup через REST API**, не через UI: фабрики создают предпосылочные сущности (контакт-клиент, работа, техники) быстро и стабильно. UI-клики — только для **самого проверяемого флоу** (правило «API поверх UI-кликов»).
- **Teardown:** после каждого теста удаляем созданное через API (best-effort; при падении — не валим тест). На staging накопление не критично (копия).
- **Скоуп:** ⚠ ОТКРЫТО — отдельная **тест-компания** на staging (tenant-изоляция, рекоменд.) vs создавать под копией ABC. См. §11.

## 6. External integrations on staging

Обезврежены → для флоу с отправкой/оплатой проверяем **in-app результат**, не реальную доставку:
- **Send estimate/invoice** → ассерт тоста «Sent» + записи в таймлайне (P2).
- **Payments/Stripe** → ручной платёж/void проверяем по изменению Due и статуса транзакции; card-popup — test-mode (P2).
- **Email verification** (нужно для онбординга REG-02) → ⚠ ОТКРЫТО: нужен способ верифицировать email на staging (тест-хук/админ-API `mark email verified`, либо предсозданный verified-аккаунт). См. §11.

## 7. Selector strategy

- Приоритет **`getByRole` / `getByLabel` / `getByText`** (устойчиво к смене вёрстки, читаемо).
- На критичных/неоднозначных узлах добавляем **`data-testid`** (мелкие правки фронта, перечислим по ходу реализации каждого теста — например `data-testid="new-job-btn"`, `job-tile`, `assign-tech-select`, `slot-option`).
- Никаких хрупких CSS-nth-child/классов palette-v2.

---

## 8. Phase 1 — P0 test descriptions

> Формат: **ID · Prio — цель** · **Precond** · **Steps** · **Expected** · **Cleanup** · **Notes**

### SMOKE-01 · P0 — App loads
- **Precond:** staging зелёный; свежий контекст (без auth).
- **Steps:** открыть baseURL.
- **Expected:** страница логина (Keycloak) рендерится; нет фатальных ошибок в console; нет 5xx в network на документ.
- **Cleanup:** нет. **Notes:** fail-fast — если красный, остальное не гоняем.

### AUTH-01 · P0 — Login (valid) `@suite:auth`
- **Precond:** тест-admin без 2FA существует; свежий контекст.
- **Steps:** открыть baseURL → редирект на Keycloak → ввести `E2E_ADMIN_USER`/`E2E_ADMIN_PASS` → submit.
- **Expected:** попадает на дефолтную страницу приложения; UI показывает залогиненного юзера; ошибок нет. **Сохраняет `storageState`** (используется в global-setup для всех остальных).
- **Cleanup:** нет. **Notes:** SSO/2FA — вне авто-smoke (P2).

### AUTH-02 · P0 — Login (invalid password) `@suite:auth`
- **Precond:** свежий контекст.
- **Steps:** Keycloak-логин с валидным email + **неверным** паролем → submit.
- **Expected:** Keycloak показывает ошибку («Invalid username or password»); в приложение НЕ пускает; сессии нет.
- **Cleanup:** нет. **Notes:** проверяем и то, что редиректа в app не произошло.

### AUTH-03 · P0 — Logout `@suite:auth`
- **Precond:** залогинен (admin storageState).
- **Steps:** открыть меню пользователя → Logout.
- **Expected:** возврат на логин; повторное открытие защищённого роута → редирект на логин (сессия очищена).
- **Cleanup:** нет.

### REG-01 · P0 — Public signup → email-sent `@suite:registration`
- **Precond:** свежий контекст; уникальный email `RUN_ID@e2e.local`.
- **Steps:** открыть `/signup` → заполнить **Full name**, **Work email**, **Password** (≥8) → «Create account».
- **Expected:** переход на экран **«Check your email»** с указанным адресом; кнопка «Resend» с обратным отсчётом. (Аккаунт создан, ждёт верификации.)
- **Cleanup:** удалить тест-аккаунт через API (если доступно).
- **Notes:** создание компании идёт в `/onboarding` ПОСЛЕ верификации email и первого логина → полный онбординг = REG-02 (нужен email-verify хук, §6/§11). Google-путь — вне авто-smoke.

### CONT-01 · P0 — Create contact `@suite:contacts`
- **Precond:** залогинен (admin); имя `RUN_ID Contact`.
- **Steps:** `/contacts` → кнопка создания контакта → шторка → заполнить имя + телефон/email → Save.
- **Expected:** шторка закрылась; контакт появился в списке (ассерт по `RUN_ID`); карточка показывает введённые имя/контакты.
- **Cleanup:** удалить контакт через API.
- **Notes:** ⚠ подтвердить точку входа standalone-создания контакта при реализации; фолбэк — создание контакта внутри CreateLeadDialog.

### LEAD-01 · P0 — Create lead `@suite:leads`
- **Precond:** залогинен (admin); маркер `RUN_ID` в имени/описании.
- **Steps:** `/leads` → «Create Lead» → `CreateLeadDialog` → заполнить обязательные (имя/телефон, источник и т.п.) → «Create Lead».
- **Expected:** диалог закрылся; лид в списке `/leads` (ассерт по `RUN_ID`); открывается карточка с данными.
- **Cleanup:** удалить лид через API.
- **Notes:** канон = `CreateLeadDialog.tsx` (submit «Create Lead»).

### JOB-01 · P0 — Create job `@suite:jobs`
- **Precond:** залогинен (admin); через API засеян контакт-клиент; маркер `RUN_ID`.
- **Steps:** `/jobs` → «New Job» → шторка **NewJobModal** → выбрать клиента (сид), адрес, описание/сервис → Save.
- **Expected:** шторка закрылась; тост; работа вверху `/jobs`; плитка показывает **«Customer, City»**; внутри — введённые данные.
- **Cleanup:** удалить работу через API.
- **Notes:** NewJobModal — канон create (gold-standard шторка).

### JOB-06 · P0 — "On the way" system transition `@suite:jobs`
- **Precond:** залогинен (admin, есть `messages.send` — модалка гейтится этим правом); через API засеяна работа (`RUN_ID`) в стартовом статусе.
- **Steps:** открыть работу → нажать кнопку статуса **«On the way»** → дождаться модалки ETA → закрыть её **Cancel** (без отправки).
- **Expected:** переход применяется сразу (blanc_status=`On the way` в API ещё до уведомления); всплывает **notify-only** модалка «On the way» (кнопка «Notify client»); закрытие модалки НЕ откатывает статус; **карточка показывает новый статус без перезагрузки** (SSE `job.updated` из FSM-apply + refetch инициатора).
- **Cleanup:** удалить работу через API.
- **Notes:** канон FSM-SYSTEM-TRANSITIONS-001 — поведение on-the-way на СОСТОЯНИИ (blanc:op=arrival_eta), не на ребре; регресс-гард против «статус меняется, а карточка старая до refresh».

### EST-01 · P0 — Create estimate on a job `@suite:estimates`
- **Precond:** залогинен (admin); через API засеяна работа (`RUN_ID`).
- **Steps:** открыть работу → Finance → создать эстимейт → добавить ≥1 позицию (`EstimateItemDialog`, ручная или из Price Book) → сохранить.
- **Expected:** эстимейт создан и виден на работе; тоталы посчитаны (subtotal/total > 0); статус Draft.
- **Cleanup:** удалить работу (каскад) через API.
- **Notes:** EstimateItemDialog — канон позиции.

### EST-04 · P0 — Approve estimate → Create Invoice available `@suite:estimates`
- **Precond:** залогинен (admin); через API засеяны работа + эстимейт с позициями.
- **Steps:** открыть эстимейт → **Approve**.
- **Expected:** статус → Approved; панель эстимейта **остаётся открытой** (approve-stay); кнопка **«Create Invoice»** доступна в один клик.
- **Cleanup:** удалить работу через API.
- **Notes:** канон ESTIMATE-APPROVE-STAY.

### INV-01 · P0 — Create invoice `@suite:invoices`
- **Precond:** залогинен (admin); через API засеяна работа (+опц. approved-эстимейт).
- **Steps:** открыть работу → Finance → «Create Invoice» (из approved-эстимейта или новый) → сохранить.
- **Expected:** инвойс создан и виден на работе; тоталы посчитаны; **Total Due = Total − Paid** (при Paid=0 → Due=Total).
- **Cleanup:** удалить работу через API.
- **Notes:** также есть entry `/invoices` → «New Invoice»; канон Due — FINANCE-DUE-001.

### SCH-01 · P0 — Schedule a job (slot picker) `@suite:schedule`
- **Precond:** залогинен (admin); через API засеяна **незапланированная** работа с адресом; ≥1 техник с рабочим расписанием.
- **Steps:** открыть работу → «Pick time»/Schedule → **SlotPicker** (BottomSheet Times⇄Map) → выбрать слот → подтвердить.
- **Expected:** у работы проставлено `scheduled_at` = выбранный слот; работа появляется в `/schedule` на этот день/время.
- **Cleanup:** удалить работу через API.
- **Notes:** slot-engine gated by marketplace; на staging должен быть включён — проверить при реализации.

### SCH-02 · P0 — Assign technician(s) `@suite:schedule`
- **Precond:** залогинен (admin); через API засеяна работа; ≥2 техника (A, B).
- **Steps:** открыть работу → picker техников (multi-select) → выбрать **Tech A** → сохранить.
- **Expected:** `assigned_techs` содержит A; в `/schedule` работа под колонкой A.
- **Cleanup:** удалить работу через API.
- **Notes:** канон job-provider-multi (multi-select).

### SCH-03 · P0 — Reschedule a job `@suite:schedule`
- **Precond:** залогинен (admin); через API засеяна работа, **уже запланированная** на слот T1.
- **Steps:** открыть работу → сменить время → SlotPicker → выбрать другой слот **T2** → подтвердить.
- **Expected:** `scheduled_at` = T2 (не T1); в `/schedule` работа переехала на T2; тот же техник (время меняется, назначение — нет).
- **Cleanup:** удалить работу через API.
- **Notes:** альтернативный путь — DnD на доске Schedule (TimelineWeekView) → вынесем в P1-вариант.

### SCH-04 · P0 — Reassign a job `@suite:schedule`
- **Precond:** залогинен (admin); через API засеяна работа, назначенная на **Tech A**; существуют A и B.
- **Steps:** открыть работу → picker техников → сменить A → **B** → сохранить.
- **Expected:** `assigned_techs` == **{B}** (REPLACES, не append); A снят; в `/schedule` работа под колонкой B.
- **Cleanup:** удалить работу через API.
- **Notes:** канон job-tech-assign (reassign ЗАМЕНЯЕТ; `null` = unassign → это SCH-05, P1). Альт. путь — DnD между колонками техников в TimelineWeekView (Move) → P1-вариант.

---

## 9. Phase 2 / 3 — перечень (детали позже)

**P1:** AUTH-04 (session persist), AUTH-05 (deep-link redirect), REG-02 (онбординг), REG-03 (admin Add-User), CONT-02..04, LEAD-02..04, JOB-02..05, EST-02/03/05, INV-02/05, SCH-05/06, PAY-01/02/04, X-01..04/06.
**P2:** AUTH-06/07/08 (SSO/2FA/reset), CONT-05 (merge), EST-06/07 (send/PDF), INV-03/04 (send/PDF), SCH-07/08 (day-off/drive-time), PAY-03 (card popup), X-05/07/08/09 (notif/mobile/404/deep-link).

## 10. Gate integration

1. master→staging авто-деплой зелёный (`ssh mini cat albusto-staging/state/status` ≠ RED).
2. `npm run e2e:smoke` против staging.
3. Всё зелёное → разрешён прод-деплой (см. prod-deploy-procedure). Красное → стоп + trace/screenshot в артефактах.
4. Полная регрессия `e2e:full` — ночью / перед релизом.

## 11. Open inputs (нужно от владельца, не блокирует описание)

- **A. Скоуп тест-данных:** отдельная тест-компания на staging (рекоменд.) vs под копией ABC.
- **B. Тест-юзеры:** admin (+ provider для P1) без 2FA/SSO на staging → логины в env (`E2E_ADMIN_*`).
- **C. Email-verify на staging:** способ верифицировать email (тест-хук/админ-API/предсозданный verified-аккаунт) — нужен для REG-02 (онбординг). REG-01 (до «Check your email») работает и без него.
- **D. slot-engine на staging** включён (для SCH-01)?

## Verification (как докажем, что сам suite валиден)

- **Негативный контроль на каждый P0:** временно «сломать» проверяемый элемент (или гонять против заведомо старой версии staging) → тест должен стать **КРАСНЫМ**. Vacuous-pass (тест зелёный при сломанной фиче) недопустим.
- **Изоляция:** прогон дважды подряд без ручной уборки → оба зелёные (RUN_ID + teardown работают).
- **Флаки-гейт:** каждый P0 гоняем ×5 подряд → 5/5 зелёных, иначе стабилизируем перед включением в гейт.
