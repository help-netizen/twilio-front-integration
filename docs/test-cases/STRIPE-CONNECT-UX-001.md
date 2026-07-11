# Тест-кейсы: STRIPE-CONNECT-UX-001 — violet-cloud connect surfaces (Settings hero + cost card, Job Finance banner, copy fixes)

**Источники:** `Docs/specs/STRIPE-CONNECT-UX-001-SPEC.md` (§0–§6), `Docs/requirements.md` `## STRIPE-CONNECT-UX-001` (FR-CLOUD/HERO/COST/COPY/JOB/MOBILE, AC-1..6), `Docs/architecture.md:5310`.

**Специфика фичи:** presentation-only UI-redesign. У frontend НЕТ тест-раннера — фронтовые кейсы имеют типы **STATIC** (grep/diff по коду), **BUILD** (tsc), **PREVIEW** (живой dev-сервер через preview-тулзы) и **MANUAL/REVIEW** (code-review против таблиц спецификации). Backend jest существует (`tests/stripePayments.test.js`, корневой `tests/`), но label-ассертов в нём нет (спека §0.5 D-4) — прогоняется без правок.

**Security/изоляция данных:** N/A — ни одного нового/изменённого endpoint'а, роутов, SQL или company-scope кода (спека §6; architecture §8 «middleware/company-scope checklist N/A»). Меняются только 3 label-строки в `buildChecklist` (чистые строки, `publicStatus`-форма не меняется).

**Протокол честности (спека §5.3):** живым preview достижимо ТОЛЬКО реальное состояние компании `not_connected` (Settings R3 + Job S-8). Состояния R2 (`configured===false`), R4/S-9 (finish-setup), S-10 (no-perm), R5 (`connected_ready`), S-11 (ничего) **в preview не воспроизводятся без хаков** — покрываются MANUAL/REVIEW + diff-проверкой неизменности условий (AC-4). Временные state-override'ы в коммитимом коде ЗАПРЕЩЕНЫ.

### Покрытие
- Всего тест-кейсов: 27
- P0: 12 | P1: 11 | P2: 3 | P3: 1
- STATIC: 12 | BUILD: 1 | UNIT: 1 | PREVIEW: 7 | MANUAL/REVIEW: 6

Базовая ревизия для diff-проверок: merge-base с `master` до начала имплементации (`BASE=$(git merge-base HEAD master)`; если фича коммитится поверх master — ревизия до первого коммита фичи).

---

## STATIC (grep/diff)

### TC-CUX-01: `.blanc-cloud` — единственный источник градиента, 5-слойный background посимвольно
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** спека §1.1, FR-CLOUD, AC-6
- **Шаги:**
  1. `grep -n 'blanc-cloud' frontend/src/styles/design-system.css` — блок `.blanc-cloud` + `::before`/`::after` существует, добавлен в зоне shared-паттернов (после `.blanc-eyebrow`/`.blanc-heading` ~:800–812, до хвостовых медиа-запросов).
  2. Байт-сравнить `background:` деклару с §1.1: РОВНО 4 `radial-gradient` + `#FFFFFF` одной декларацией, значения дословно (`58% 90% at 12% 18%`, `rgba(127,66,225,.16)` … `rgba(231,219,253,.7)`); `border-radius: 22px`; `border: 1px solid rgba(127, 66, 225, .16)`; `::before` 240px/blur(42px)/top -60px right -40px; `::after` 280px/blur(48px)/bottom -80px left -30px; `pointer-events: none`.
  3. `grep -rn 'radial-gradient' frontend/src --include='*.tsx'` → **0 совпадений** (градиент НЕ продублирован в TSX).
  4. `grep -c 'blanc-cloud {' frontend/src/styles/design-system.css` → ровно 1 определение базового класса во всём проекте (`grep -rn '\.blanc-cloud' frontend/src/styles/` — только design-system.css).
- **Ожидаемый результат:** один CSS-источник облака, значения канона совпадают посимвольно, нуль копий градиента вне design-system.css.

### TC-CUX-02: `CloudBanner` — единственный новый файл, используется ОБОИМИ call-site'ами
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** спека §1.2, FR-CLOUD
- **Шаги:**
  1. `git diff --stat $BASE..HEAD` → единственный новый исходник = `frontend/src/components/ui/CloudBanner.tsx`.
  2. В `CloudBanner.tsx`: props `{ variant?: 'hero' | 'compact'; className?: string; children: ReactNode }`; рендер `cn('blanc-cloud', variant === 'hero' ? 'p-6 sm:p-8' : 'p-5', className)` с единственным внутренним `<div className="relative z-[1]">{children}</div>` (z-[1] — спека §1.2 corrected: поднимает контент над ::before/::after); НЕТ state/queries/логики.
  3. `grep -rln 'CloudBanner' frontend/src --include='*.tsx'` → ровно 3 файла: `CloudBanner.tsx`, `StripePaymentsSettingsPage.tsx`, `JobFinancialsTab.tsx` (import + JSX-использование в обоих потребителях).
  4. `grep -rn "className=.*blanc-cloud" frontend/src --include='*.tsx' | grep -v CloudBanner.tsx` → 0 (никто не лепит класс мимо компонента).
- **Ожидаемый результат:** оба call-site'а делят одну поверхность через компонент; ручного copy-paste класса нет.

### TC-CUX-03: gating `JobFinancialsTab` байт-идентичен (AC-4) — извлечение условий pre/post
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** спека §0.1/§3/§6, FR-JOB, AC-4
- **Шаги (определение проверки):**
  1. Извлечь условия ДО и ПОСЛЕ: `git show $BASE:frontend/src/components/jobs/JobFinancialsTab.tsx | grep -nE "const (canCollect|canManageIntegrations|readiness|stripeReady|isConnectState|showCta)\b|enabled: canCollect|queryKey: \['stripe-payments-status'\]" > /tmp/pre.txt` и то же по рабочему дереву → `/tmp/post.txt`; `diff /tmp/pre.txt /tmp/post.txt` (сравнение по содержимому строк; номера строк допустимо нормализовать `cut -d: -f2-`).
  2. `git diff $BASE..HEAD -- frontend/src/components/jobs/JobFinancialsTab.tsx` — hunks НЕ трогают ни одну строку цитаты §0.1 (`:80-89`, `:125-…` вычисления вплоть до `showCta`; допустима замена только строк-констант `ctaTitle`/`ctaBody`/`ctaButtonLabel` — они презентация, не gating); условие `{showCta && …}` сохранено как обёртка.
  3. Кнопка «Collect payment» (условие `canCollect && stripeReady`) — блок в diff не встречается.
  4. `grep -n "/settings/integrations/stripe-payments" frontend/src/components/jobs/JobFinancialsTab.tsx` — navigate-цель присутствует и не изменилась (тот же путь в обеих кнопочных ветках).
- **Ожидаемый результат:** diff по файлу показывает изменения ТОЛЬКО в JSX-презентации внутри `{showCta && …}` и в строках копий; выражения условий/query/navigate идентичны по содержимому.

### TC-CUX-04: Settings-страница — защищённая логика не тронута (мутации/query/Dialog)
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** спека §0.2/§6, AC-4
- **Шаги:**
  1. `git diff $BASE..HEAD -- frontend/src/pages/StripePaymentsSettingsPage.tsx` — НЕ затронуты: `connectMut`/`resumeMut`/`refreshMut`/`disconnectMut` (тела мутаций, onSuccess/onError), query `['stripe-payments-status']`, disconnect-`Dialog`, компоненты `StatusBadge`/`ReadinessRow` (кроме текста `not_connected` в `READINESS_LABEL`), вычисления `const readiness = status?.readiness ?? 'not_connected'; const connected = status?.connected;`.
  2. В `READINESS_LABEL`: изменён ТОЛЬКО `not_connected.text` (`'Available'`→`'Not connected'`); `cls` остался `STATUS_NEUTRAL`; остальные 6 записей map — без изменений.
  3. Hero-CTA вызывает ИМЕННО `connectMut.mutate()`, compact-CTA — `resumeMut.mutate()` (те же мутации, что раньше были в actions row), с `disabled={…isPending}`.
  4. `git diff $BASE..HEAD -- backend/ | grep -v stripePaymentsService.js` → пусто (в backend изменён один файл); никаких изменений `SettingsPageShell.tsx`/`SettingsSection.tsx`/`authedFetch.ts`/`useRealtimeEvents.ts`.
- **Ожидаемый результат:** поведенческий слой Settings нетронут; поменялись только JSX-структура и строки.

### TC-CUX-05: копии Settings — description / badge / env / заголовок секции (§4 №1–4)
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** FR-COPY, AC-5, R2
- **Шаги:** grep по `StripePaymentsSettingsPage.tsx` на ТОЧНЫЕ строки (копировать из каталога §4, не перенабирать):
  1. `Take card payments on the job, by link, or over the phone` (description; старой `Accept customer payments by Stripe` в файле больше нет);
  2. `Not connected` в `READINESS_LABEL.not_connected` (строки `Available` нет);
  3. `Stripe isn't set up for this workspace yet. Once platform keys are added, you can connect your account here.` (апостроф `'` как в каталоге; старой env-строки `…not configured on this environment…` нет);
  4. `Setup steps` как title секции чеклиста (`Setup checklist` в файле отсутствует).
- **Ожидаемый результат:** 4/4 новых строк присутствуют посимвольно, 4/4 старых удалены.

### TC-CUX-06: копии hero — eyebrow/заголовок/sub/micro/trust (§4 №5–7, 15–16)
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** FR-HERO, AC-5, S-3
- **Шаги:** grep в `StripePaymentsSettingsPage.tsx`:
  1. `PAYMENTS` внутри элемента с классом `blanc-eyebrow`;
  2. `Get paid on the spot`;
  3. `Charge a card at the job, text a payment link, or key it in over the phone. Money lands in your bank in about 2 business days.`;
  4. `Takes about 5 minutes. Have your business details and bank account handy.`;
  5. `Powered by Stripe · Card data never touches Albusto` — с символом `·` (U+00B7), рядом иконка `Lock`.
- **Ожидаемый результат:** все 5 строк посимвольно; `·` не заменена на `-`/`|`.

### TC-CUX-07: копии hero — 3 benefit-строки + 3 pricing-чипа (§4 №8–13)
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** FR-HERO, AC-5, S-3
- **Шаги:** grep:
  1. `Every way to pay — Card on site, payment link by text or email` (иконка `CreditCard`);
  2. `Fast payouts — Free, to your bank in ~2 business days` (символ `~`; иконка `Banknote`);
  3. `No monthly fees — Pay only when you get paid` (иконка `ShieldCheck`);
  4. чипы: `2.9% + 30¢ per card payment` (символ `¢`), `$0 monthly`, `0% added by Albusto`; контейнер `flex flex-wrap gap-2`, чип = `rounded-full border border-[rgba(127,66,225,.2)] bg-white/70 px-3 py-1 text-[13px]`.
- **Ожидаемый результат:** 6/6 строк посимвольно (вкл. `—`, `~`, `¢`, `%`); иконки benefit-строк `size-4` цветом `var(--blanc-accent)` без кругов/фонов.

### TC-CUX-08: копии «What it costs» — 6 строк + footer + цвета ставок (§4 №20–27)
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** FR-COST, AC-5, S-3
- **Шаги:** grep в `StripePaymentsSettingsPage.tsx` (подкомпонент `WhatItCostsCard` module-level, в том же файле — НЕ отдельный shared-файл):
  1. `What it costs`; 2. `Card payment — link or keyed-in` + sub `Visa, Mastercard, Amex, Apple Pay, Google Pay` → `2.9% + 30¢`; 3. `Tap to Pay in person` + sub `on the technician's phone` → `2.7% + 5¢ · soon` (ставка цветом `--blanc-ink-3`); 4. `Monthly or setup fees` → `$0`; 5. `Payouts to your bank` + sub `about 2 business days` → `Free`; 6. `Instant payouts — optional` → `1.5%`; 7. `Albusto fee on top` → `0%`; footer `Stripe's standard US rates, charged by Stripe. International cards +1.5%. Full details at stripe.com/pricing.`
  2. Три «зелёные» ставки (`$0`, `Free`, `0%`) — `var(--blanc-success)`; поверхность карточки = `rgba(25,25,25,0.03)` / radius 16px (НЕ `blanc-cloud`); строки `flex items-start justify-between gap-3` + `space-y-3` + `min-w-0`; `<hr>`/`Separator` отсутствуют; ставки — хардкод (никаких fetch/query в `WhatItCostsCard`).
- **Ожидаемый результат:** 8/8 текстов посимвольно; цветовая раскладка и не-облачная поверхность соответствуют §2/архитектуре §3.

### TC-CUX-09: копии Job-баннера — 3 состояния (§4 №28–35)
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** FR-JOB, AC-5, S-8/S-9/S-10
- **Шаги:** grep в `JobFinancialsTab.tsx`:
  1. connect: `Get paid for this job today` + `Charge the card on the spot or text a secure payment link. No invoice needed — money hits your bank in days.` + кнопка `Connect Stripe` + micro `One-time setup · ~5 min` (символы `·` и `~`);
  2. finish-setup: `Almost there — finish your Stripe setup` + `Stripe needs a few more business details before you can take payments.` + кнопка `Finish setup`;
  3. no-perm: `Your company isn't set up for payments yet. Ask an account admin to connect Stripe in Settings → Integrations.` (символ `→`) + иконка `Lock`, БЕЗ кнопки в этой ветке;
  4. Старые строки удалены: `Accept payments right from the job`, `Connect Stripe to charge your customer's card…`, `Finish your Stripe setup to start collecting payments`; readiness-специфичный заголовок в no-perm-ветке больше не рендерится (единый текст для всех readiness — FR-JOB).
- **Ожидаемый результат:** 3 состояния = точная копия каталога; ветвление — 1:1 на существующие `isConnectState`/`canManageIntegrations`.

### TC-CUX-10: backend — ровно 3 label-строки в `buildChecklist` (§4 №36–38)
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** FR-COPY, AC-5, спека §0.3/§0.5 D-1
- **Шаги:**
  1. `git diff $BASE..HEAD -- backend/src/services/stripePaymentsService.js` — изменены ТОЛЬКО 3 строки label (`:67-69`): `Connect your Stripe account`, `Add your business details`, `Turn on card payments`.
  2. Не изменены: ключи (`connect`/`onboarding`/`payment_methods`), `done`-выражения, `deferred: true`, строки 70–71 (`Configure field payments (Tap to Pay)`, `Run a test payment` — дословно на месте), `computeReadiness`/`canCollect`/`publicStatus`.
  3. Старых labels (`Connect Stripe account`, `Complete business onboarding`, `Enable card payments`) в файле нет.
- **Ожидаемый результат:** diff файла = ровно 3 однострочные label-замены, ничего больше.

### TC-CUX-11: «Blanc» не встречается в новых UI-строках
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** ограничения requirements («"Blanc" never ships in UI»), §4 преамбула
- **Шаги:** `git diff $BASE..HEAD -U0 | grep '^+' | grep -i blanc | grep -viE '\-\-blanc-|blanc-cloud|blanc-eyebrow|blanc-heading|blanc-table'` → 0 совпадений (токены/классы `--blanc-*`/`.blanc-*` — внутренние, допустимы; пользовательских строк со словом «Blanc» нет; продукт в копиях — `Albusto`).
- **Ожидаемый результат:** пусто; в копиях фигурирует только «Albusto».

### TC-CUX-12: AC-6 — нуль image/SVG-ассетов для облака
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** AC-6, FR-CLOUD
- **Шаги:**
  1. `git diff --stat $BASE..HEAD` — ни одного нового/изменённого файла в `frontend/src/assets/`, `frontend/public/`, `*.svg`, `*.png`.
  2. В новом коде (`.blanc-cloud`-блок CSS, `CloudBanner.tsx`, hero/banner JSX): `grep -E 'url\(|\.svg|\.png'` → 0 в контексте облака.
- **Ожидаемый результат:** облако = чистый CSS.

### TC-CUX-13: копии Settings compact cloud R4 (§4 №17–19)
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** FR-HERO (partially-connected), AC-5, S-4
- **Шаги:** grep в `StripePaymentsSettingsPage.tsx`: `Almost there — finish your Stripe setup`, `Stripe needs a few more business details before you can take payments.`, кнопка `Finish setup` (строки `Resume onboarding` в файле больше нет — primary поглощён облаком).
- **Ожидаемый результат:** 3/3 строки посимвольно; «Resume onboarding» удалена.

---

## BUILD

### TC-CUX-14: `npm run build` зелёный (AC-1, noUnusedLocals)
- **Приоритет:** P0
- **Тип:** BUILD
- **Связанный сценарий:** AC-1, спека §5.1, architecture §7
- **Предусловия:** все правки внесены.
- **Шаги:** `cd frontend && npm run build` (tsc -b; prod Docker строже — `noUnusedLocals`).
- **Ожидаемый результат:** exit 0, ноль ошибок; особо: НЕТ осиротевших lucide-импортов после поглощения Connect/Resume в облака — `Loader2` остаётся использованным (pending-спиннеры cloud-CTA), `CheckCircle2`/`AlertCircle` — используются `ReadinessRow`.

---

## UNIT (backend jest)

### TC-CUX-15: `tests/stripePayments.test.js` зелёный БЕЗ правок (AC-2)
- **Приоритет:** P1
- **Тип:** UNIT
- **Связанный сценарий:** AC-2, спека §0.5 D-4 / §5.2
- **Предусловия:** label-правка TC-CUX-10 внесена. Файл — в КОРНЕВОМ `tests/` (не `backend/tests/`).
- **Шаги:** прогнать jest на `tests/stripePayments.test.js` (в worktree помнить про `--testPathIgnorePatterns`-gotcha при необходимости).
- **Ожидаемый результат:** все тесты зелёные без единой правки ассертов — файл ассертит только readiness-состояния, label/checklist-строк не пинит (verified: grep `label|checklist|Connect Stripe|Enable|Complete` = 0). Если тест красный — это регрессия семантики `computeReadiness`/`canCollect` (нарушение §6), НЕ повод править ассерты.

---

## PREVIEW (живой dev-сервер; реальное состояние компании = `not_connected`)

### TC-CUX-16: Settings R3 desktop — hero + «What it costs» + структура страницы (S-3)
- **Приоритет:** P0
- **Тип:** PREVIEW
- **Связанный сценарий:** S-3, FR-HERO, FR-COST, AC-3
- **Предусловия:** dev-сервер (`preview_start` + Vite), логин админом (perm `tenant.integrations.manage`), компания в `not_connected`; viewport desktop (≥1024px).
- **Шаги:**
  1. Открыть `/settings/integrations/stripe-payments`.
  2. Проверить первый ребёнок shell = grid `grid-cols-1 md:grid-cols-[1.15fr_.85fr] gap-5`: слева cloud-hero, справа карточка «What it costs» (preview_snapshot + preview_inspect грида).
  3. Порядок контента hero сверху вниз: eyebrow `PAYMENTS` → h3 `Get paid on the spot` → sub → 3 benefit-строки → 3 чипа → фиолетовая CTA `Connect Stripe` → micro-copy → trust row (snapshot: все блоки присутствуют и в этом порядке).
  4. Ниже грида — секция `Setup steps` с 5 пунктами чеклиста, labels с бэкенда новые (`Connect your Stripe account`, `Add your business details`, `Turn on card payments`, + 2 старых).
  5. Badge статуса = `Not connected` (нейтральный стиль); description шапки = новая строка.
  6. На странице ровно ОДНА фиолетовая (primary) кнопка — hero-CTA; actions row НЕ содержит Connect-кнопки.
- **Ожидаемый результат:** структура и порядок соответствуют §2 S-3; одна primary на страницу.

### TC-CUX-17: Settings R3 mobile 375×812 — hero above the fold (S-6, AC-3)
- **Приоритет:** P0
- **Тип:** PREVIEW
- **Связанный сценарий:** S-6, FR-MOBILE, AC-3
- **Предусловия:** как TC-CUX-16; `preview_resize` 375×812.
- **Шаги:**
  1. Открыть страницу, скролл-позиция 0.
  2. Проверить одну колонку: hero СВЕРХУ, «What it costs» ПОД ним, «Setup steps» ниже (snapshot).
  3. **Above the fold (определение S-6):** весь диапазон от eyebrow `PAYMENTS` до CTA `Connect Stripe` ВКЛЮЧИТЕЛЬНО виден без прокрутки (preview_inspect: bounding box кнопки CTA — нижняя грань ≤ 812px при scrollY=0; micro-copy/trust row могут уходить под сгиб).
- **Ожидаемый результат:** eyebrow→CTA видимы на 375×812 без скролла.

### TC-CUX-18: 320–375px — нет горизонтального переполнения, чипы переносятся
- **Приоритет:** P2
- **Тип:** PREVIEW
- **Связанный сценарий:** S-6 («And»-клауза), FR-MOBILE
- **Шаги:**
  1. `preview_resize` 320×812, затем 375×812; открыть Settings и Job → Finance.
  2. `preview_eval`: `document.documentElement.scrollWidth <= window.innerWidth` на обеих страницах → true.
  3. Чипы hero переносятся `flex-wrap`; benefit-строки стекуются; строки cost-card не переполняются (`min-w-0` + `justify-between`); Job-баннер — во всю ширину контейнера `max-w-5xl space-y-5`.
- **Ожидаемый результат:** нуль горизонтального скролла на 320 и 375; переносы корректны.

### TC-CUX-19: Job → Finance connect-баннер живьём (S-8) — cloud, копия, navigate
- **Приоритет:** P0
- **Тип:** PREVIEW
- **Связанный сценарий:** S-8, FR-JOB, AC-3
- **Предусловия:** админ (collect-perm + manage), компания `not_connected`; любой job.
- **Шаги:**
  1. Открыть job → вкладка Finance, desktop и 375px.
  2. Баннер = облако (не серый `bg-[var(--blanc-surface-muted)]`); контент: `Get paid for this job today` + body + фиолетовая `[Connect Stripe]` + micro `One-time setup · ~5 min` (snapshot).
  3. Клик по `Connect Stripe` → URL становится `/settings/integrations/stripe-payments` (navigate-цель не изменилась).
  4. Кнопка «Collect payment» на странице отсутствует (stripeReady=false) — как и раньше.
- **Ожидаемый результат:** S-8 рендер и переход соответствуют §3; на 375px облако во всю ширину, переполнения нет.

### TC-CUX-20: тап-таргеты ≥44px (FR-MOBILE)
- **Приоритет:** P0
- **Тип:** PREVIEW
- **Связанный сценарий:** S-6/FR-MOBILE («all tap targets ≥ 44px»)
- **Шаги:** на 375×812 `preview_inspect` bounding box: (a) hero-CTA `Connect Stripe` на Settings — высота ≥44px (`h-11` = 44px); (b) кнопка `Connect Stripe` в Job-баннере — высота ≥44px.
- **Ожидаемый результат:** обе cloud-CTA ≥44px по высоте. (Прочие кнопки — существующие размеры, вне скоупа изменения.)

### TC-CUX-21: визуальный рендер облака + поверхность cost-card (обе поверхности)
- **Приоритет:** P1
- **Тип:** PREVIEW
- **Связанный сценарий:** FR-CLOUD, §5.3(c), AC-3
- **Шаги:**
  1. `preview_inspect` элемента `.blanc-cloud` на Settings И на Job Finance: `border-radius: 22px`, `border: 1px solid rgba(127,66,225,.16)`-эквивалент, computed `background-image` содержит 4 radial-gradient.
  2. `preview_screenshot` обеих поверхностей: градиент/blur-круги видимы, контент читаем поверх кругов (внутренний `relative`-div поднимает контент).
  3. `preview_inspect` карточки «What it costs»: фон `rgba(25,25,25,0.03)`, radius 16px (НЕ облако); три зелёные ставки computed color = `--blanc-success` (#1b8b63), ставка `2.7% + 5¢ · soon` — цвет `--blanc-ink-3`.
- **Ожидаемый результат:** облако рендерится идентично по паттерну на обеих поверхностях; cost-card — обычная карточная поверхность.

---

## MANUAL/REVIEW (состояния, недостижимые в preview честно — code-review против таблиц §2/§3 + diff-факт AC-4)

### TC-CUX-22: R4/S-4 — Settings finish-setup (connected, не connected_ready)
- **Приоритет:** P1
- **Тип:** MANUAL/REVIEW
- **Связанный сценарий:** S-4, R4, FR-HERO (partially-connected)
- **Почему review:** требует реального Stripe-аккаунта посреди onboarding (§5.3); state-override в коммитимом коде запрещён. Опционально (без коммита): подмена `readiness` в React DevTools / локальный мок `/status`.
- **Шаги (review):** по коду `StripePaymentsSettingsPage.tsx` проверить ветку `connected && readiness !== 'connected_ready'`:
  1. Первым рендерится `<CloudBanner variant="compact">` с копией №17–18 и кнопкой `[Finish setup]` → `resumeMut.mutate()` + `disabled={resumeMut.isPending}` + pending-spinner;
  2. hero/cost-grid в этой ветке НЕ рендерится;
  3. далее «Setup steps» → «Account readiness» (`connected && acct`) → actions row БЕЗ primary «Resume onboarding» — только outline `Refresh status`, outline `Open Stripe Dashboard`, ghost `Disconnect` (одна фиолетовая кнопка на страницу);
  4. граница: `payouts_disabled` (connected, can_collect=true) попадает в ЭТУ же ветку — compact cloud + Finish setup (поведение как сегодняшний «Resume onboarding», меняется только оболочка).
- **Ожидаемый результат:** ветка кода 1:1 с таблицей R4; охват всех 4 readiness (`onboarding_incomplete`/`action_required`/`payments_disabled`/`payouts_disabled`).

### TC-CUX-23: S-9/S-10 — Job finish-setup и no-perm ветки
- **Приоритет:** P1
- **Тип:** MANUAL/REVIEW
- **Связанный сценарий:** S-9, S-10, FR-JOB
- **Почему review:** S-9 требует mid-onboarding аккаунта; S-10 — пользователя с collect-perm без manage (смена роли).
- **Шаги (review):** по коду `JobFinancialsTab.tsx` внутри `{showCta && <CloudBanner variant="compact">…}`:
  1. `canManageIntegrations && !isConnectState` → копия №32–34, кнопка `Finish setup` → тот же `navigate('/settings/integrations/stripe-payments')`;
  2. `!canManageIntegrations` → `Lock` + копия №35, БЕЗ кнопки, БЕЗ readiness-специфичного заголовка (единый текст для всех readiness);
  3. `payouts_disabled` в finish-setup НЕ попадает (can_collect=true → showCta=false) — подтверждается неизменностью `showCta` (TC-CUX-03);
  4. ветвление использует ТОЛЬКО существующие переменные (`isConnectState`, `canManageIntegrations`) — новых state/условий нет.
- **Ожидаемый результат:** оба состояния соответствуют таблице §3; в сочетании с TC-CUX-03 (условия байт-идентичны) даёт AC-4 для job-поверхности.

### TC-CUX-24: R1/R2/R5 — loading, not-configured, connected_ready
- **Приоритет:** P1
- **Тип:** MANUAL/REVIEW
- **Связанный сценарий:** S-1, S-2, S-5 (R1/R2/R5)
- **Почему review:** R2 требует энва без platform-ключей; R5 — реально подключённого аккаунта; R1 — транзиентен.
- **Шаги (review):** по коду `StripePaymentsSettingsPage.tsx`:
  1. R1: ветка `isLoading` — Loader row (`Loader2` + «Loading…») БЕЗ изменений в diff; облака-скелетона нет;
  2. R2: ветка `configured === false` — единственная `SettingsSection` с новой env-копией (№3); ни hero, ни cost card, ни чеклиста, ни кнопок;
  3. R5: при `readiness === 'connected_ready'` НИ ОДИН `CloudBanner` не рендерится (ни hero-грид — `!connected`=false, ни compact — `readiness !== 'connected_ready'`=false); «Setup steps» + «Account readiness» + actions (Refresh/Dashboard/Disconnect) + disconnect-Dialog — как сегодня; primary-кнопок нет.
- **Ожидаемый результат:** три ветки соответствуют R1/R2/R5; для R5 «no cloud anywhere» доказуемо чтением условий рендера.

### TC-CUX-25: S-11 — баннер не рендерится (негативный, AC-4)
- **Приоритет:** P2
- **Тип:** MANUAL/REVIEW
- **Связанный сценарий:** S-11, FR-JOB, AC-4
- **Шаги (review):** подтвердить по неизменённому коду (в связке с TC-CUX-03), что при каждом из условий: нет collect-perm (query даже не enabled), `stripeLoading`, `configured === false`, `can_collect === true` (вкл. `connected_ready` И `payouts_disabled`), `readiness` отсутствует → `showCta === false` → облако НЕ рендерится, в Finance-табе ничего нового не появляется; кнопка «Collect payment» при `canCollect && stripeReady` — на месте (блок не в diff).
- **Ожидаемый результат:** матрица (permissions × readiness × configured) даёт ТЕ ЖЕ состояния, что до изменения — доказательство = байт-идентичность условий + review ветвления.

### TC-CUX-26: S-7 — ошибки мутаций и success-redirect без изменений (негативный)
- **Приоритет:** P2
- **Тип:** MANUAL/REVIEW
- **Связанный сценарий:** S-7
- **Шаги (review):** по diff `StripePaymentsSettingsPage.tsx` (в связке с TC-CUX-04): тела `connectMut`/`resumeMut` не тронуты → при ошибке — `toast.error(e.message)` (sonner), кнопка выходит из pending (`isPending` → false); при успехе — `window.location.href` на `onboarding_url`/`url`. Новой обработки ошибок НЕ введено; cloud-CTA лишь переиспользуют `mutate()`/`isPending` существующих мутаций.
- **Ожидаемый результат:** error/success-поведение идентично сегодняшнему из самого факта неизменности мутаций.

### TC-CUX-27: типографика hero-заголовка (Manrope 800)
- **Приоритет:** P3
- **Тип:** PREVIEW
- **Связанный сценарий:** §2 S-3 (пункт 2), architecture §6
- **Шаги:** `preview_inspect` h3 `Get paid on the spot`: `font-family` содержит Manrope (`--blanc-font-heading`), `font-weight: 800`, `font-size` = 24px на 375px / 28px на desktop (`text-2xl sm:text-[28px]`), `color` = `--blanc-ink-1`.
- **Ожидаемый результат:** заголовок рендерится Manrope 800 нужных размеров (вес 800 реально загружен — @import :26).

---

## Матрица покрытия FR/AC/сценарии → TC

| Требование | TC | Полнота |
|---|---|---|
| FR-CLOUD (единый CSS-паттерн, без ассетов) | 01, 02, 12, 21 | Полная (STATIC + PREVIEW) |
| FR-HERO (hero R3 + compact R4 + none R5) | 06, 07, 13, 16, 17; R4→22, R5→24 | R3 живьём; R4/R5 — review |
| FR-COST | 08, 16, 21 | Полная (STATIC + PREVIEW) |
| FR-COPY (description/badge/env/labels/section) | 05, 10, 16 | Полная (STATIC; labels живьём в чеклисте — 16.4) |
| FR-JOB (3 состояния, gating unchanged) | 03, 09, 19; S-9/S-10→23, S-11→25 | S-8 живьём; S-9/S-10/S-11 — review |
| FR-MOBILE | 17, 18, 19, 20 | Полная (PREVIEW) |
| AC-1 build | 14 | Полная |
| AC-2 backend jest | 15 | Полная |
| AC-3 preview 375/desktop | 16, 17, 19, 21 | В пределах честно достижимого (см. gaps) |
| AC-4 gating identical | 03, 04, 22, 23, 25 | Diff-доказательство + review |
| AC-5 verbatim copy (38 строк каталога) | 05–10, 13 | Полная (все 38 строк распределены по 7 STATIC-кейсам) |
| AC-6 no image assets | 01 (шаг 3), 12 | Полная |
| S-1 | 24 | Review |
| S-2 | 05 (строка), 24 (ветка) | STATIC + review |
| S-3 | 06, 07, 08, 16 | Живьём |
| S-4 | 13 (строки), 22 (ветка) | Review |
| S-5 | 24 | Review |
| S-6 | 17, 18, 20 | Живьём |
| S-7 | 26 | Review |
| S-8 | 09 (строки), 19 (живьём) | Живьём |
| S-9 / S-10 | 09 (строки), 23 (ветки) | Review |
| S-11 | 25 | Review |

## Честные пробелы покрытия (by design, спека §5.3)

1. **R2 / R4 / R5 / S-9 / S-10 / S-11 не проверяются живым рендером** — требуют реального Stripe-аккаунта mid-onboarding, другого пользователя (без manage-perm) или энва без ключей. Компенсация: (i) code-review против таблиц §2/§3 (TC-22..25), (ii) diff-доказательство неизменности условий (TC-03/04) — если условия не менялись, состояния маппятся так же, как до правки, (iii) все копии этих состояний проверены STATIC посимвольно (TC-09/13). Допустимая доп. проверка БЕЗ коммита: подмена readiness в React DevTools / локальный мок `/status`.
2. **S-7 (ошибки мутаций)** — не триггерится в preview без порчи энва; покрыт review-фактом неизменности мутаций (TC-26).
3. **Пиксельная точность градиента** (соответствие утверждённым мокапам) — проверяется скриншотом (TC-21) на глаз; автоматической визуальной регрессии в проекте нет.
4. **Backend label-строки в live-чеклисте** — прямого API-теста нет (jest не ассертит labels); компенсация: TC-10 (STATIC diff) + TC-16 шаг 4 (labels видны в живом чеклисте Settings, т.к. реальный энв в `not_connected` отдаёт checklist с бэкенда).
