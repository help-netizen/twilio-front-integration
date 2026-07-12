# Спецификация: ONBOARDING-UX-001 — human onboarding hub `/welcome` + 4-step checklist + trial informer + marketplace connect-form redesign

**Дата:** 2026-07-12 · **Статус:** approved for implementation
**Требования:** `Docs/requirements.md` §ONBOARDING-UX-001 (решения заказчика — биндинг)
**Архитектура:** `Docs/architecture.md` §«Архитектурное решение для фичи ONBOARDING-UX-001»
**База:** ONBTEL-001 Part A (чеклист, write-once `completed_at`), STRIPE-CONNECT-UX-001 (CloudBanner-канон)

### Общее описание

Новая компания после self-signup попадает на тёплую hub-страницу `/welcome` (tenant_admin only) с прогрессом по 4 derived-шагам онбординга и trial-информером. Карточка на /pulse становится компактным трекером-ссылкой на hub. Setup-страницы маркетплейса приводятся к эталону Stripe (CloudBanner hero + человечная английская копия). Серверная семантика чеклиста (derived items, write-once `completed_at`, GET-only) не меняется — только аддитивное расширение.

---

## 1. Backend

### 1.1 Реестр шагов (нормативный порядок и деривации)

`CHECKLIST_ITEMS` в `backend/src/services/onboardingChecklistService.js` — ровно 4 записи, в этом порядке. Каждая деривация — SQL/сервис-чтение, фильтрованное по `companyId`; внешние API (Stripe/Google) НЕ вызываются.

| # | key | done ⇔ | Источник истины | cta.path | est_minutes |
|---|-----|--------|-----------------|----------|-------------|
| 1 | `company_profile` | `companies.logo_storage_key IS NOT NULL` | колонка `companies` (mig 134) | `/settings/company` | 1 |
| 2 | `connect_telephony` | `EXISTS(phone_number_settings WHERE company_id=$1)` — БЕЗ ИЗМЕНЕНИЙ | phone_number_settings | `/settings/integrations/telephony-twilio` | 2 |
| 3 | `connect_email` | `emailMailboxService.getMailboxStatus(companyId)` → mailbox существует И `provider==='gmail'` И `status==='connected'` | email_mailboxes | `/settings/integrations/google-email` | 1 |
| 4 | `stripe_payments` | `stripePaymentsService.getStatus(companyId).readiness === 'connected_ready'` | stripe_connected_accounts (DB-only чтение; provider не сконфигурирован → `not_connected` → false) | `/settings/integrations/stripe-payments` | 5 |

Обоснование `company_profile`: name/phone/email/адрес заполняются при bootstrapCompany — деривация по ним была бы всегда-true; логотип — единственное реальное действие (и он реально нужен: уходит на estimates/invoices/emails).

### 1.2 Нормативная копия items (English, «Blanc» запрещён)

| key | title | description | cta.label | done_note |
|-----|-------|-------------|-----------|-----------|
| company_profile | `Add your logo` | `Put your brand on every estimate, invoice, and email your customers see.` | `Set up` | `Looking sharp — your brand is on your documents.` |
| connect_telephony | `Connect telephony` | `Get a business phone number to make and receive calls and texts in Albusto.` (существующая нормативная строка ONBTEL-001 — не менять) | `Set up` | `Nice — your phone line is live!` |
| connect_email | `Connect your email` | `Bring your Gmail into Albusto so every customer email lands in one timeline.` | `Set up` | `Great — your email flows into Albusto now.` |
| stripe_payments | `Get paid with Stripe` | `Take card payments on the job, by link, or over the phone.` | `Set up` | `You're ready to get paid on the spot.` |

### 1.3 Расширение ответа GET /api/onboarding/checklist (строго аддитивно)

```
{
  ok: true,
  checklist: {
    visible: boolean,            // прежняя семантика: NOT (completed_at OR allDone)
    completed_at: string|null,   // прежняя write-once семантика
    progress: { done: number, total: number },          // NEW (total = items.length)
    trial: {                                            // NEW; null если нет/не trialing/ошибка
      active: true,
      days_left: number,        // max(0, ceil((trial_ends_at − now)/86400000))
      trial_ends_at: string     // ISO из billing_subscriptions.trial_ends_at
    } | null,
    items: [{
      key, title, description, done, cta: { label, path },  // прежние поля байт-в-байт
      est_minutes: number,      // NEW
      done_note: string         // NEW
    }]
  }
}
```

Правила:
- `trial` derived из `billingService.getSubscription(companyId)`: не-null ТОЛЬКО когда строка существует, `status === 'trialing'` и `trial_ends_at` не в прошлом (истёкший trial → `null`; отображение «expired» — вне скоупа v1).
- Чтение trial обёрнуто в try/catch: любая ошибка → `trial: null` + `console.warn`, ответ 200 (информер опционален).
- Ошибка деривации item'а — ПРЕЖНЯЯ семантика: bubbles → 500 `INTERNAL_ERROR` (как в существующем тесте ONBTEL).
- `visible`/write-once машина не меняется: первый GET, где все 4 done и `completed_at IS NULL` → один guarded UPDATE (only-if-NULL); конкурентный rowCount:0 → re-read; write-fail → visible:false без 500.
- Существующие компании: у кого `completed_at` уже стоит (по старому 1-шаговому каталогу) — `visible:false` навсегда, новые шаги НЕ ресурфейсят карточку (принятое решение заказчика §8). items при этом честно показывают их фактические done-статусы (важно для прямого захода на /welcome).

### 1.4 Redirect после создания компании

`POST /api/onboarding` (`routes/onboarding.js:82-86`): единственное изменение — `redirect: '/welcome'`. Всё остальное (OTP, bootstrapCompany, trust-device cookie, статус 201) — байт-в-байт. `OnboardingPage.tsx:199-208` уже следует `json.redirect` через SPA-навигацию после `refreshAuthz()` — фронт не меняется. Ветки `ALREADY_ONBOARDED` (:185) и «уже onboarded» (:100) остаются на `/pulse` — это не новые компании.

### 1.5 Middleware и изоляция (без изменений, контрольно)

- Mount: `app.use('/api/onboarding', authenticate, onboardingRouter)`; `/checklist`: `requireCompanyAccess` + inline `requireTenantAdmin` (role_key === 'tenant_admin'; `_devMode` pass).
- `company_id` ТОЛЬКО из `req.companyFilter?.company_id`; payload/query игнорируются.
- Все SQL дериваций и trial-чтение параметризованы `companyId` → изоляция тенантов.
- Без токена → 401; не-tenant_admin → 403 `TENANT_ADMIN_ONLY`; без company-контекста → 403 `TENANT_CONTEXT_REQUIRED`.

---

## 2. Frontend

### 2.1 Route и gate

- `App.tsx`: `<Route path="/welcome" element={<ProtectedRoute permissions={['pulse.view']}><WelcomePage/></ProtectedRoute>} />` внутри AppLayout-обёртки (тот же блок, что /pulse).
- В `WelcomePage`: `!isTenantAdmin()` → `<Navigate to="/pulse" replace />`. Пока authz грузится — нейтральный skeleton (не редиректить преждевременно).
- Данные — существующий `useOnboardingChecklist` (React Query, `refetchOnWindowFocus: true` — возврат из визардов сам обновляет прогресс).

### 2.2 Сценарии поведения

#### Сценарий 1: первый вход новой компании
- **Предусловия:** self-signup завершён, `bootstrapCompany` создал company + trial.
- **Шаги:** POST /api/onboarding → 201 `{redirect:'/welcome'}` → `refreshAuthz()` → `navigate('/welcome')` → GET /checklist.
- **Ожидаемо:** hero (eyebrow `WELCOME TO ALBUSTO`, заголовок, «about 3 minutes», прогресс-бар `0 of 4 done`), 4 карточки шагов (title, description, `~N min`, кнопка `Set up`), trial-информер `14 days left on your trial`.
- **Побочные эффекты:** нет (GET-only; completed_at не трогается — не allDone).

#### Сценарий 2: выполнение шага и возврат
- **Шаги:** клик CTA карточки → `navigate(cta.path)` → пользователь завершает существующий визард (например, покупает номер) → возвращается на /welcome (back / прямой заход).
- **Ожидаемо:** refetch (mount/focus) → шаг done: галочка (var(--blanc-success)) + `done_note` вместо description, CTA скрыт; прогресс-бар и «N of 4 done» обновлены.

#### Сценарий 3: 100% completion
- **Предусловия:** все 4 деривации true.
- **Ожидаемо:** первый такой GET фиксирует `completed_at` (write-once), ответ `visible:false, progress {4,4}`. /welcome показывает completion-состояние: тёплый hero («You're all set!» + «Your workspace is ready — calls, email, and payments are all wired up.») + CTA `Go to Pulse` → /pulse. БЕЗ конфетти/анимационного шума. Компактный трекер на /pulse исчезает (gate `checklist.visible`).

#### Сценарий 4: компактный трекер на /pulse
- **Предусловия:** tenant_admin, `visible:true`.
- **Ожидаемо:** `OnboardingChecklistCard` = одна строка-ссылка: `Finish setting up` + мини-прогресс-бар + `N of 4 done` + chevron; клик → `/welcome`. Списка шагов и collapse-механики больше нет (localStorage-ключ `albusto.onb-checklist.collapsed:*` не читается — упразднён).
- **Не-админ / visible:false / loading / error:** карточка = null (fail-quiet, прежняя семантика).

#### Сценарий 5: trial-информер
- **Ожидаемо:** отдельный компактный блок на /welcome (НЕ карточка шага, НЕ в прогрессе): `X days left on your trial` + `Your setup carries over when you pick a plan.` + CTA `View plans` → `/settings/billing`. `trial:null` → блок не рендерится (без пустых состояний). `days_left = 0` (последний день) → `Your trial ends today`.

#### Сценарий 6: не-админ и чужие компании
- Не-tenant_admin: hook disabled (существующий `enabled`), /welcome → мгновенный redirect на /pulse; прямой fetch API → 403.
- Данные компании B недоступны компании A: все деривации и trial фильтруются `req.companyFilter.company_id`.

#### Сценарий 7: existing-компания с completed_at (не ресурфейсим)
- GET → `visible:false` (write-once уважается, даже если новые шаги не-done). /pulse — трекера нет. Прямой заход на /welcome: `progress.done < total` → показываем hub с фактическими статусами (позволяет добровольно доделать), но БЕЗ авто-редиректов и без воскрешения карточки на /pulse.

#### Сценарий 8: redesign connect-форм
- GoogleEmailSettingsPage (not-connected): CloudBanner hero — eyebrow `EMAIL`, заголовок `Every customer email, one timeline`, ценность (Pulse timeline, send estimates/invoices, Mail Secretary), CTA `Connect Gmail`, футнот `Takes about a minute. You'll sign in with Google.`; connected — полировка копии.
- TelephonyTwilioSettingsPage: степпер и вся логика остаются; интро-шаг получает hero (`Your business phone line` / «You're 3 minutes away from your first call») + человечные подписи шагов.
- VapiSettingsPage / MailSecretarySettingsPage: not-connected hero по Stripe-образцу (ценность + CTA + time-футнот); connected-состояния — полировка.
- MarketplaceConnectDialog (IntegrationsPage.tsx:42-113): остаётся центр-модалкой (канон: подтверждение), копия очеловечивается: короткий value-абзац, блок `What Albusto will do` (вместо технического credentialCopy), доступы простым языком, CTA `Enable {app}`. Покрывает Smart Slot Engine и AI Repair Advisor (своих страниц нет — gate-only apps).
- Инвариант: mutations/queries/статусные машины страниц НЕ меняются; только JSX-представление и строки.

### 2.3 Дизайн-канон (обязательные правила для /welcome и redesign)

- Токены только `--blanc-*`; hex запрещён вне палитры. Слово «Blanc» в UI-строках запрещено.
- Hero — ТОЛЬКО через `<CloudBanner variant="hero">` (без самодельных градиентов); композиция по эталону StripePaymentsSettingsPage.tsx:142-203 (eyebrow → h heading-font → подстрока ink-2 → контент → CTA h-11 → футнот ink-3).
- Карточки шагов: `border 1px var(--blanc-line)`, rounded-xl, без теней; иконки-маркеры 4, `var(--blanc-ink-3)`, без кружков-подложек; done-галочка `var(--blanc-success)`.
- Прогресс-бар: тонкий трек `rgba(25,25,25,0.06)` + заливка `var(--blanc-accent)`; подпись `N of 4 done`.
- Разделение секций — отступами (`space-y-6`), НИКАКИХ `<hr>`/border-top; контейнеры невидимы (LAYOUT-CANON rule 7).
- Никаких пустых состояний («—»): нет trial → нет блока.
- Mobile: hub — одна колонка, карточки full-width; никаких новых модалок (существующий `variant="panel"` → bottom-sheet автоматически там, где диалоги уже есть).

### 2.4 Взаимодействие компонентов

- `WelcomePage` → `useOnboardingChecklist` → `GET /api/onboarding/checklist` → `onboardingChecklistService.getChecklist` → SQL (companies / phone_number_settings / email_mailboxes / stripe_connected_accounts / billing_subscriptions).
- `OnboardingChecklistCard` (PulsePage:218) → тот же hook (общий React Query кэш `['onboarding-checklist', companyId]` — hub и карточка консистентны без доп. запросов).
- `OnboardingPage` (signup) → POST /api/onboarding → `json.redirect === '/welcome'` → navigate.
- SSE не используется (низкочастотные данные; refetch on mount/focus достаточен — существующее решение ONBTEL A4).

---

## 3. Граничные случаи

1. Trial истёк (`trial_ends_at` в прошлом, статус ещё 'trialing') → `trial:null`, информер скрыт.
2. `billing_subscriptions` строки нет (старые компании до биллинга) → `trial:null`, 200.
3. Ошибка запроса trial (БД) → `trial:null` + warn, 200.
4. Stripe provider не сконфигурирован (нет STRIPE_SECRET_KEY) → `readiness 'not_connected'` → шаг не-done; чеклист работает.
5. Gmail mailbox в статусе `reconnect_required`/`sync_error` → `connect_email` done:false (истина = только `connected`).
6. Номер куплен, потом released → `connect_telephony` done:false, но если `completed_at` уже стоял — `visible:false` навсегда (прежний инвариант E-A3/E-A4).
7. Конкурентные GET при первом allDone → один UPDATE выигрывает, второй re-read (прежний инвариант).
8. Не-админ прямым URL /welcome → redirect /pulse; глубокая ссылка /welcome у совсем новой компании до загрузки authz → skeleton, потом рендер/redirect.
9. `_devMode` → admin-gate пропускает (как везде).
10. Пользователь без компании (mid-signup) на /welcome → OnboardingGate (App.tsx:16-27) уводит на /onboarding — существующее поведение, /welcome не в publicPath.

## 4. Обработка ошибок

1. GET /checklist 500 (ошибка деривации) → hub: fail-quiet нейтральное состояние (заголовок + `We couldn't load your setup progress. It'll retry automatically.`; React Query ретраит); карточка на /pulse → null (прежняя семантика A8). Без toast.
2. GET 403 у не-админа → hook не должен был запускаться (enabled-gate); если случилось — тот же fail-quiet.
3. Ошибка записи `completed_at` → 200 `visible:false`, ретрай на следующем GET (прежняя семантика).
4. POST /api/onboarding ошибки — без изменений (не в скоупе).

## 5. Безопасность и изоляция данных

- Все данные — только по `company_id` из `req.companyFilter` (requireCompanyAccess); инъекция company_id через query/payload игнорируется.
- Кросс-тенант: деривации/trial компании A не читают строки компании B (параметризованный `$1` во всех запросах).
- 401 без токена; 403 `TENANT_ADMIN_ONLY` для manager/dispatcher/provider; 403 `TENANT_CONTEXT_REQUIRED` без membership.
- Ошибки не раскрывают чужие данные; ответы не содержат Twilio SID / Stripe account id / токенов (только boolean done + readiness-производная).
- Новых мутаций нет → CSRF-поверхность не растёт; redirect-литерал server-side, не из user input.
