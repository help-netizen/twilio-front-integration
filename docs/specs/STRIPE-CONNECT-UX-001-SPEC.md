# STRIPE-CONNECT-UX-001 — Спецификация: violet-cloud connect surfaces (Settings hero + cost card, Job Finance banner, copy fixes)

**Источники:** `## STRIPE-CONNECT-UX-001` в `Docs/requirements.md` (FR-CLOUD/HERO/COST/COPY/JOB/MOBILE, AC-1..6) + `Docs/architecture.md:5310` (§0–§8). Presentation-layer follow-up к STRIPE-PAY-001 и STRIPE-ADHOC-PAY-001. **FRONTEND-ONLY + 3 label-строки в backend `buildChecklist`.** Никаких изменений gating/API/readiness/роутов; НЕТ миграции; НЕТ новых зависимостей. Все цитаты копий в §4 — FINAL, воспроизводить посимвольно (включая «·», «¢», «~», «%»).

---

## §0 — Ground truth: текущий код (verified 2026-07-10; код — источник истины)

### §0.1 `JobFinancialsTab.tsx` — gating CTA (STRIPE-ADHOC-PAY-001), строки 79–139 — БАЙТ-ИДЕНТИЧНО СОХРАНИТЬ

`frontend/src/components/jobs/JobFinancialsTab.tsx`:

```tsx
// :80-89
const navigate = useNavigate();
const { hasAnyPermission, hasPermission } = useAuthz();
const canCollect = hasAnyPermission('payments.collect_online', 'payments.collect_offline', 'payments.collect_keyed');
const { data: stripeStatus, isLoading: stripeLoading } = useQuery({
    queryKey: ['stripe-payments-status'],
    queryFn: () => stripePaymentsApi.getStatus().then(r => r.status),
    enabled: canCollect,
});
const canManageIntegrations = hasPermission('tenant.integrations.manage');

// :125-139
const readiness = stripeStatus?.readiness;
const stripeReady = !!stripeStatus?.configured && !!stripeStatus?.can_collect;
const isConnectState = readiness === 'not_connected' || readiness === 'disconnected';
const ctaTitle = isConnectState
    ? 'Accept payments right from the job'
    : 'Finish your Stripe setup to start collecting payments';
const ctaBody = isConnectState
    ? "Connect Stripe to charge your customer's card or send a payment link in seconds — no invoice required."
    : undefined;
const ctaButtonLabel = isConnectState ? 'Connect Stripe' : 'Finish setup';
const showCta = canCollect && !stripeLoading && !!stripeStatus?.configured && !stripeStatus?.can_collect && !!readiness;
```

Текущий CTA-блок (строки 160–178) — ЕДИНСТВЕННЫЙ заменяемый JSX в этом файле:

```tsx
{showCta && (
    <div className="rounded-2xl bg-[var(--blanc-surface-muted)] px-4 py-4">
        <p className="text-sm font-semibold text-[var(--blanc-ink-1)]">{ctaTitle}</p>
        {ctaBody && <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">{ctaBody}</p>}
        {canManageIntegrations ? (
            <Button size="sm" className="mt-3" onClick={() => navigate('/settings/integrations/stripe-payments')}>
                {ctaButtonLabel}
            </Button>
        ) : (
            <p className="mt-3 text-sm text-[var(--blanc-ink-2)]">
                Ask an account admin to connect Stripe in Settings → Integrations.
            </p>
        )}
    </div>
)}
```

Кнопка Collect payment (строки 153–159, условие `canCollect && stripeReady`) — НЕ трогается.

### §0.2 `StripePaymentsSettingsPage.tsx` — state branching / badge map / actions

Badge map (строки 18–26):

```tsx
const READINESS_LABEL: Record<StripeReadiness, { text: string; cls: string }> = {
    not_connected: { text: 'Available', cls: STATUS_NEUTRAL },
    onboarding_incomplete: { text: 'Setup incomplete', cls: STATUS_WARNING },
    action_required: { text: 'Action required', cls: STATUS_WARNING },
    payments_disabled: { text: 'Setup incomplete', cls: STATUS_WARNING },
    payouts_disabled: { text: 'Payouts disabled', cls: STATUS_WARNING },
    connected_ready: { text: 'Connected', cls: STATUS_SUCCESS },
    disconnected: { text: 'Disconnected', cls: STATUS_NEUTRAL },
};
```

Ветвление рендера (строки 74–155, вычисления `readiness`/`connected` сохраняются как есть: `const readiness = status?.readiness ?? 'not_connected'; const connected = status?.connected;`):

1. `isLoading` → Loader row (`Loader2` + «Loading…», строки 91–94);
2. `status?.configured === false` → `SettingsSection` с env-копией: `"Stripe is not configured on this environment yet. Once the platform Stripe keys are set, you can connect your account here."` (строки 95–100);
3. иначе → `SettingsSection title="Setup checklist"` (строки 103–110) → `{connected && acct && <SettingsSection title="Account readiness">…}` (строки 112–124) → actions row (строки 126–153):
   - `!connected` → primary `Connect Stripe` → `connectMut.mutate()` (строки 128–132);
   - `connected && readiness !== 'connected_ready'` → primary `Resume onboarding` → `resumeMut.mutate()` (строки 133–137);
   - `connected` → outline `Refresh status` (`refreshMut`), outline `Open Stripe Dashboard` (`window.open('https://dashboard.stripe.com/', '_blank')`), ghost `Disconnect` (`setDisconnectOpen(true)`) (строки 138–152).

`description="Accept customer payments by Stripe"` — строка 83. Мутации `connectMut`/`resumeMut`/`refreshMut`/`disconnectMut` (строки 53–72), query `['stripe-payments-status']` (47–50), disconnect `Dialog` (157–172) — БАЙТ-ИДЕНТИЧНО СОХРАНИТЬ.

### §0.3 `backend/src/services/stripePaymentsService.js` — `buildChecklist` (строки 65–72)

```js
function buildChecklist(account, readiness) {
    return [
        { key: 'connect', label: 'Connect Stripe account', done: Boolean(account) },
        { key: 'onboarding', label: 'Complete business onboarding', done: Boolean(account?.details_submitted) },
        { key: 'payment_methods', label: 'Enable card payments', done: account?.capabilities?.card_payments === 'active' },
        { key: 'field_payments', label: 'Configure field payments (Tap to Pay)', done: false, deferred: true },
        { key: 'test_payment', label: 'Run a test payment', done: false },
    ];
}
```

Меняются ТОЛЬКО три `label`-строки в строках 67–69; ключи, `done`-выражения, `deferred`, строки 70–71, `computeReadiness`/`canCollect`/`publicStatus` — не трогаются.

### §0.4 `design-system.css` — точки привязки

- Токены: `--blanc-accent: #7F42E1` (:69), `--blanc-accent-soft: #E7DBFD` (:70), `--blanc-success: #1b8b63` (:86), `--blanc-font-heading: "Manrope", …` (:115). Manrope 800 загружен (@import :26 — `wght@400;500;600;700;800`).
- Shared-паттерны: `.blanc-table-tiles` (:762), `.blanc-eyebrow` (:800), `.blanc-heading` (:812). Новый блок `.blanc-cloud` добавляется в эту же зону (после `.blanc-eyebrow`/`.blanc-heading`, ДО медиа-запросов в хвосте файла ~:1060+).
- Dark mode в приложении ОТСУТСТВУЕТ (нет `.dark`/`prefers-color-scheme` цветовых правил) — тёмный вариант облака не нужен.

### §0.5 Обнаруженные расхождения (код побеждает)

| # | Расхождение | Резолюция |
|---|---|---|
| D-1 | Requirements указывают labels в `stripePaymentsService.js:67-71`; фактически меняемые три label — строки **67–69**; 70–71 не меняются (architecture §5 указывает верно) | Менять только :67–69 |
| D-2 | Requirements в «Защищённых частях» называют компонент `CollectPaymentModal`; фактическое имя — **`CollectPaymentDialog`** (`JobFinancialsTab.tsx:12`, рендер :473–479; architecture §8 называет верно) | Защищён `CollectPaymentDialog` |
| D-3 | Architecture §0 цитирует `.blanc-eyebrow :801` / `.blanc-heading :813` / `buildChecklist :66-73`; фактически :800 / :812 / :65-72 (off-by-one, несущественно) | Ориентироваться на фактические строки |
| D-4 | Architecture/AC-2 упоминают `tests/stripePayments.test.js` — файл лежит в **корневом** `tests/` (не `backend/tests/`); grep по `label|checklist|Connect Stripe|Enable|Complete` даёт **0 совпадений** — label-ассертов нет, правка теста не нужна | AC-2 = запустить jest без правок |

Иных расхождений между requirements/architecture и кодом не найдено; строки старых копий в коде совпадают с цитатами «old» в requirements дословно.

---

## §1 — Контракт: `.blanc-cloud` + `CloudBanner`

### §1.1 CSS: `.blanc-cloud` (append в `design-system.css` рядом с `.blanc-eyebrow`)

Ровно один источник градиента на весь проект. Блок (значения — канон, background дословно из FR-CLOUD):

```css
.blanc-cloud {
    position: relative;
    overflow: hidden;
    border: 1px solid rgba(127, 66, 225, .16);
    border-radius: 22px;
    background:
        radial-gradient(58% 90% at 12% 18%, rgba(127,66,225,.16), transparent 62%),
        radial-gradient(48% 74% at 88% 8%, rgba(231,219,253,.95), transparent 66%),
        radial-gradient(70% 100% at 78% 96%, rgba(127,66,225,.12), transparent 58%),
        radial-gradient(36% 52% at 40% 78%, rgba(231,219,253,.7), transparent 70%),
        #FFFFFF;
}
.blanc-cloud::before,
.blanc-cloud::after {
    content: '';
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
}
.blanc-cloud::before {
    width: 240px; height: 240px;
    top: -60px; right: -40px;
    background: rgba(127, 66, 225, .10);
    filter: blur(42px);
}
.blanc-cloud::after {
    width: 280px; height: 280px;
    bottom: -80px; left: -30px;
    background: rgba(231, 219, 253, .8);
    filter: blur(48px);
}
```

Инварианты: 5-слойный `background` (4 radial-gradient + `#FFFFFF`) — одной декларацией, посимвольно; радиус 22px; рамка `1px solid rgba(127,66,225,.16)`; НОЛЬ image/SVG-ассетов (AC-6). Геометрия кругов ::before/::after — канон архитектуры (единственная не-verbatim часть FR-CLOUD), одинакова для всех поверхностей.

### §1.2 Компонент: `frontend/src/components/ui/CloudBanner.tsx` (единственный НОВЫЙ файл)

```tsx
export interface CloudBannerProps { variant?: 'hero' | 'compact'; className?: string; children: ReactNode }
export function CloudBanner({ variant = 'compact', className, children }: CloudBannerProps)
```

Поведение:
- Рендерит `<div className={cn('blanc-cloud', variant === 'hero' ? 'p-6 sm:p-8' : 'p-5', className)}>` с единственным ребёнком `<div className="relative z-[1]">{children}</div>`.
- Внутренний `relative z-[1]`-div поднимает контент над псевдо-кругами; НИКАКИХ z-index-требований к children. (corrected after live preview: parent's ::before/::after paint above in-flow positioned children without a z-index — content must establish a higher stacking order)
- Паддинги: `hero` = `p-6 sm:p-8`; `compact` = `p-5`. `className` мержится через `cn()` из `lib/utils.ts`.
- Без логики, без состояния, без запросов — чистая поверхность. Потребители: `StripePaymentsSettingsPage` (hero + compact) и `JobFinancialsTab` (compact, все 3 состояния).

---

## §2 — Сценарии: Settings-страница (`StripePaymentsSettingsPage.tsx`)

Таблица «состояние → рендер» (состояния вычисляются РОВНО как сегодня, §0.2):

| # | Состояние | Рендер (сверху вниз) |
|---|---|---|
| R1 | `isLoading` | Loader row — БЕЗ изменений |
| R2 | `configured === false` | `SettingsSection` с НОВОЙ env-копией (§4 №3) |
| R3 | `!connected` (`not_connected`/`disconnected`) | grid hero+cost → «Setup steps» → actions row БЕЗ Connect-кнопки |
| R4 | `connected && readiness !== 'connected_ready'` | compact cloud [Finish setup] → «Setup steps» → Account readiness → actions (Refresh/Dashboard/Disconnect) |
| R5 | `connected && readiness === 'connected_ready'` | НИКАКОГО облака: «Setup steps» → Account readiness → actions — как сегодня |

Во всех состояниях: `description` шапки = новая копия (§4 №1); badge `not_connected` = «Not connected» (§4 №2, `cls` остаётся `STATUS_NEUTRAL`); остальные значения `READINESS_LABEL` не меняются; «Test mode»-badge — без изменений.

### Сценарий S-1: загрузка статуса

- **Given** страница `/settings/integrations/stripe-payments` открыта, query `['stripe-payments-status']` в полёте.
- **Then** рендер идентичен текущему: `Loader2` spin + «Loading…». Никакого облака-скелетона.

### Сценарий S-2: платформа не сконфигурирована

- **Given** `status.configured === false`.
- **Then** единственная `SettingsSection` с текстом: **"Stripe isn't set up for this workspace yet. Once platform keys are added, you can connect your account here."** Ни hero, ни cost card, ни чеклиста, ни кнопок.

### Сценарий S-3: не подключено — cloud hero + «What it costs» (desktop)

- **Given** `configured !== false`, `!connected` (readiness `not_connected` или `disconnected`), десктопная ширина (≥768px).
- **Then** первый ребёнок `SettingsPageShell` — `div.grid.grid-cols-1.md:grid-cols-[1.15fr_.85fr].gap-5`:
  - **Левая колонка — `<CloudBanner variant="hero">`**, контент строго в порядке:
    1. eyebrow `.blanc-eyebrow`: **PAYMENTS**
    2. заголовок `<h3 className="text-2xl sm:text-[28px]" style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800, color: 'var(--blanc-ink-1)' }}>`: **Get paid on the spot**
    3. sub: **Charge a card at the job, text a payment link, or key it in over the phone. Money lands in your bank in about 2 business days.**
    4. 3 benefit-строки, иконка `size-4` цветом `var(--blanc-accent)`, без кругов/фонов: `CreditCard` → **Every way to pay — Card on site, payment link by text or email**; `Banknote` → **Fast payouts — Free, to your bank in ~2 business days**; `ShieldCheck` → **No monthly fees — Pay only when you get paid**
    5. pricing-чипы `flex flex-wrap gap-2`, каждый `rounded-full border border-[rgba(127,66,225,.2)] bg-white/70 px-3 py-1 text-[13px]`: **2.9% + 30¢ per card payment** · **$0 monthly** · **0% added by Albusto**
    6. большая фиолетовая CTA **Connect Stripe** (высота `h-11`, ≥44px), `onClick={() => connectMut.mutate()}`, `disabled={connectMut.isPending}`, при pending — `Loader2` spinner (ровно та же мутация, что была на кнопке actions row)
    7. micro-copy: **Takes about 5 minutes. Have your business details and bank account handy.**
    8. trust row: иконка `Lock` + **Powered by Stripe · Card data never touches Albusto**
  - **Правая колонка — `WhatItCostsCard`** (module-level подкомпонент в том же файле; поверхность = карточные значения SettingsSection: `background: rgba(25,25,25,0.03)`, radius 16px, padding 20px/22px — НЕ облако). Заголовок карточки: **What it costs**. 6 строк `flex items-start justify-between gap-3` (label слева, опц. sub `text-xs` `--blanc-ink-3`; ставка справа `font-medium`), `space-y-3`, `min-w-0`, без `<hr>`:
    | Label (+sub) | Rate | Цвет ставки |
    |---|---|---|
    | Card payment — link or keyed-in / *Visa, Mastercard, Amex, Apple Pay, Google Pay* | 2.9% + 30¢ | ink-1 |
    | Tap to Pay in person / *on the technician's phone* | 2.7% + 5¢ · soon | `--blanc-ink-3` (серый) |
    | Monthly or setup fees | $0 | `--blanc-success` |
    | Payouts to your bank / *about 2 business days* | Free | `--blanc-success` |
    | Instant payouts — optional | 1.5% | ink-1 |
    | Albusto fee on top | 0% | `--blanc-success` |
    Footer: **Stripe's standard US rates, charged by Stripe. International cards +1.5%. Full details at stripe.com/pricing.** Все ставки — ХАРДКОД, никакого API.
- **And** ниже грида — `SettingsSection title="Setup steps"` (переименовано с «Setup checklist», рендер элементов чеклиста не меняется; labels придут новыми с бэкенда, §4 №36–38).
- **And** actions row в этом состоянии НЕ содержит Connect-кнопки (поглощена hero-CTA; строки 128–132 условно не рендерятся при `!connected`) — на странице ровно ОДНА фиолетовая кнопка. Account readiness не рендерится (как и сегодня: `connected && acct` = false).

### Сценарий S-4: onboarding начат, не завершён — compact cloud

- **Given** `connected === true`, `readiness !== 'connected_ready'` (`onboarding_incomplete`/`action_required`/`payments_disabled`/`payouts_disabled`).
- **Then** вместо hero/cost-грида первым идёт `<CloudBanner variant="compact">`: заголовок **Almost there — finish your Stripe setup** + текст **Stripe needs a few more business details before you can take payments.** + фиолетовая кнопка **[Finish setup]** → `resumeMut.mutate()` c `disabled={resumeMut.isPending}` + pending-spinner (та же мутация, что нынешняя «Resume onboarding»).
- **And** дальше как сегодня: «Setup steps», «Account readiness», actions row — но primary «Resume onboarding» из actions row УДАЛЁН (поглощён облаком); остаются только outline `Refresh status`, outline `Open Stripe Dashboard`, ghost `Disconnect` — одна фиолетовая кнопка на страницу.
- **Граница:** `payouts_disabled` (connected, `can_collect === true`) — тоже это состояние на Settings (как и сегодня «Resume onboarding» показывался): compact cloud + Finish setup. Поведение не меняется, только оболочка.

### Сценарий S-5: подключено и готово

- **Given** `readiness === 'connected_ready'`.
- **Then** НИКАКОГО облака на странице. «Setup steps» + «Account readiness» + actions (Refresh / Open Stripe Dashboard / Disconnect) + disconnect-Dialog — как сегодня. Меняются только: description шапки, заголовок секции «Setup steps», тексты labels чеклиста (с бэкенда).

### Сценарий S-6: мобильный 375px — hero above the fold

- **Given** состояние R3, viewport 375×812 (iPhone-класс).
- **Then** грид схлопывается в одну колонку (`grid-cols-1` ниже `md`): hero СВЕРХУ, «What it costs» ПОД ним, «Setup steps» ниже.
- **Определение «above the fold» (AC-3):** при вертикальном viewport 812px весь диапазон контента hero от eyebrow «PAYMENTS» до CTA «Connect Stripe» включительно виден БЕЗ прокрутки (micro-copy и trust row могут уходить под сгиб; кнопка — обязана быть видимой).
- **And** чипы переносятся `flex-wrap` без горизонтального переполнения на 320–375px; benefit-строки стекуются; строки cost-card не переполняются (`min-w-0` + `justify-between`).
- **And** все тап-таргеты ≥44px: cloud-CTA `h-11` (44px); прочие кнопки — существующие размеры.

### Сценарий S-7: ошибки мутаций (без изменений поведения)

- **Given** hero-CTA / [Finish setup] нажаты и мутация упала.
- **Then** ровно как сегодня: `toast.error(e.message)` (sonner), кнопка выходит из pending. Успех: `window.location.href` на `onboarding_url`/`url` (если пришёл). Никакой новой обработки не вводится.

---

## §3 — Сценарии: Job → Finance (`JobFinancialsTab.tsx`)

Presentation-only swap: условие `{showCta && …}` и ВСЯ логика §0.1 сохраняются байт-в-байт; серый `div.rounded-2xl.bg-[var(--blanc-surface-muted)]` заменяется на `<CloudBanner variant="compact">`. Ветвление — 1:1 на СУЩЕСТВУЮЩИЕ переменные; navigate-цель `/settings/integrations/stripe-payments` не меняется. Старые константы `ctaTitle`/`ctaBody`/`ctaButtonLabel` заменяются новой копией (допустимо инлайном или новыми константами — семантика ветвления та же).

| Существующее условие (из кода) | Новая презентация |
|---|---|
| `showCta && canManageIntegrations && isConnectState` | S-8 connect |
| `showCta && canManageIntegrations && !isConnectState` | S-9 finish-setup |
| `showCta && !canManageIntegrations` | S-10 no-perm |
| `!showCta` | ничего (S-11) |

### Сценарий S-8: connect state (manage-пользователь, компания не подключена)

- **Given** пользователь с любым `payments.collect_*` И `tenant.integrations.manage`; `stripeStatus.configured === true`, `can_collect === false`, `readiness ∈ {not_connected, disconnected}`.
- **Then** в облаке: заголовок **Get paid for this job today** · текст **Charge the card on the spot or text a secure payment link. No invoice needed — money hits your bank in days.** · фиолетовая кнопка **[Connect Stripe]** → `navigate('/settings/integrations/stripe-payments')` (без изменений) · micro **One-time setup · ~5 min**.

### Сценарий S-9: finish-setup state (manage-пользователь, onboarding не завершён)

- **Given** то же, но `readiness ∈ {onboarding_incomplete, action_required, payments_disabled}` (`payouts_disabled` сюда не попадает — `can_collect === true` → `showCta === false`).
- **Then** то же облако: **Almost there — finish your Stripe setup** + **Stripe needs a few more business details before you can take payments.** + **[Finish setup]** → тот же `navigate(...)`.

### Сценарий S-10: без `tenant.integrations.manage`

- **Given** пользователь с collect-perm, но без manage; `showCta === true` (любой readiness).
- **Then** то же облако: иконка `Lock` + текст **Your company isn't set up for payments yet. Ask an account admin to connect Stripe in Settings → Integrations.** — БЕЗ кнопки. Отличие от сегодня: readiness-специфичный `ctaTitle` в no-perm-ветке больше НЕ показывается (спецификация FR-JOB), единый текст для всех readiness.

### Сценарий S-11: баннер не рендерится (без изменений)

- **Given** любое из: нет collect-perm (`canCollect === false` — query даже не включается), `stripeLoading`, `configured === false`, `can_collect === true` (включая `connected_ready` и `payouts_disabled`), `readiness` отсутствует.
- **Then** `showCta === false` → НИЧЕГО (баннера нет). Кнопка «Collect payment» при `canCollect && stripeReady` — как сегодня. AC-4: для каждой комбинации (permissions × readiness × configured) рендерится ТО ЖЕ состояние, что и до изменения.

### Мобильный (FR-MOBILE): баннер в потоке `max-w-5xl space-y-5`, на 375px облако — во всю ширину контейнера, кнопки ≥44px тап-таргет, переполнения нет.

---

## §4 — Copy catalog (источник истины AC-5; воспроизводить посимвольно)

«—» в колонке Old = строки раньше не существовало. Все строки — английские; «Blanc» в UI не встречается.

### Settings: шапка, badge, env, секция

| # | Место | Old | New |
|---|---|---|---|
| 1 | description шапки | `Accept customer payments by Stripe` | `Take card payments on the job, by link, or over the phone` |
| 2 | badge `not_connected` | `Available` | `Not connected` |
| 3 | env-копия (`configured===false`) | `Stripe is not configured on this environment yet. Once the platform Stripe keys are set, you can connect your account here.` | `Stripe isn't set up for this workspace yet. Once platform keys are added, you can connect your account here.` |
| 4 | заголовок секции чеклиста | `Setup checklist` | `Setup steps` |

### Settings: cloud hero (состояние R3)

| # | Место | Old | New |
|---|---|---|---|
| 5 | eyebrow | — | `PAYMENTS` |
| 6 | заголовок | — | `Get paid on the spot` |
| 7 | sub | — | `Charge a card at the job, text a payment link, or key it in over the phone. Money lands in your bank in about 2 business days.` |
| 8 | benefit 1 (CreditCard) | — | `Every way to pay — Card on site, payment link by text or email` |
| 9 | benefit 2 (Banknote) | — | `Fast payouts — Free, to your bank in ~2 business days` |
| 10 | benefit 3 (ShieldCheck) | — | `No monthly fees — Pay only when you get paid` |
| 11 | чип 1 | — | `2.9% + 30¢ per card payment` |
| 12 | чип 2 | — | `$0 monthly` |
| 13 | чип 3 | — | `0% added by Albusto` |
| 14 | CTA (переносится из actions row) | `Connect Stripe` | `Connect Stripe` (текст тот же; кнопка живёт в hero) |
| 15 | micro-copy под CTA | — | `Takes about 5 minutes. Have your business details and bank account handy.` |
| 16 | trust row (Lock) | — | `Powered by Stripe · Card data never touches Albusto` |

### Settings: compact cloud (состояние R4)

| # | Место | Old | New |
|---|---|---|---|
| 17 | заголовок | — | `Almost there — finish your Stripe setup` |
| 18 | текст | — | `Stripe needs a few more business details before you can take payments.` |
| 19 | primary-кнопка (была в actions row) | `Resume onboarding` | `Finish setup` |

### Settings: «What it costs» (состояние R3; ХАРДКОД)

| # | Место | Old | New |
|---|---|---|---|
| 20 | заголовок карточки | — | `What it costs` |
| 21 | строка 1 | — | `Card payment — link or keyed-in` / sub `Visa, Mastercard, Amex, Apple Pay, Google Pay` → `2.9% + 30¢` |
| 22 | строка 2 (серая ставка) | — | `Tap to Pay in person` / sub `on the technician's phone` → `2.7% + 5¢ · soon` |
| 23 | строка 3 (зелёная) | — | `Monthly or setup fees` → `$0` |
| 24 | строка 4 (зелёная) | — | `Payouts to your bank` / sub `about 2 business days` → `Free` |
| 25 | строка 5 | — | `Instant payouts — optional` → `1.5%` |
| 26 | строка 6 (зелёная) | — | `Albusto fee on top` → `0%` |
| 27 | footer | — | `Stripe's standard US rates, charged by Stripe. International cards +1.5%. Full details at stripe.com/pricing.` |

### Job → Finance баннер

| # | Место | Old | New |
|---|---|---|---|
| 28 | connect: заголовок | `Accept payments right from the job` | `Get paid for this job today` |
| 29 | connect: текст | `Connect Stripe to charge your customer's card or send a payment link in seconds — no invoice required.` | `Charge the card on the spot or text a secure payment link. No invoice needed — money hits your bank in days.` |
| 30 | connect: кнопка | `Connect Stripe` | `Connect Stripe` (без изменений) |
| 31 | connect: micro | — | `One-time setup · ~5 min` |
| 32 | finish-setup: заголовок | `Finish your Stripe setup to start collecting payments` | `Almost there — finish your Stripe setup` |
| 33 | finish-setup: текст | — (тела не было) | `Stripe needs a few more business details before you can take payments.` |
| 34 | finish-setup: кнопка | `Finish setup` | `Finish setup` (без изменений) |
| 35 | no-perm: текст (+Lock; readiness-заголовок удаляется) | `Ask an account admin to connect Stripe in Settings → Integrations.` (под readiness-заголовком) | `Your company isn't set up for payments yet. Ask an account admin to connect Stripe in Settings → Integrations.` |

### Backend: `buildChecklist` labels (`stripePaymentsService.js:67-69`)

| # | key | Old | New |
|---|---|---|---|
| 36 | `connect` | `Connect Stripe account` | `Connect your Stripe account` |
| 37 | `onboarding` | `Complete business onboarding` | `Add your business details` |
| 38 | `payment_methods` | `Enable card payments` | `Turn on card payments` |

`field_payments` (`Configure field payments (Tap to Pay)`) и `test_payment` (`Run a test payment`) — БЕЗ изменений. Итого: 38 строк каталога.

---

## §5 — Протокол верификации

1. **AC-1 build:** `cd frontend && npm run build` (tsc -b; prod Docker строже — `noUnusedLocals`: после поглощения Connect/Resume в облака проверить, что `Loader2` остаётся использованным (pending-спиннеры в cloud-CTA), `CheckCircle2`/`AlertCircle` — используются `ReadinessRow`; ни одного осиротевшего импорта).
2. **AC-2 backend jest:** прогнать `tests/stripePayments.test.js` (корневой `tests/`, НЕ `backend/tests/`) — verified: файл ассертит только readiness-состояния, НОЛЬ label/checklist-строк → тест должен пройти БЕЗ правок; если вдруг красный — это регрессия семантики, не повод править ассерты.
3. **AC-3 визуальная верификация (browser preview) — что реально достижимо честно:**
   - Прод/дев-состояние компании сейчас — `not_connected` (реальное состояние). Через dev-сервер (`preview_start` + Vite) под админом проверяются ЖИВЬЁМ: **(a)** Settings hero + «What it costs» + «Setup steps» на 375×812 (hero eyebrow→CTA above the fold по определению S-6) и на desktop (грид 1.15fr/.85fr); **(b)** Job → Finance connect-баннер (S-8) на 375 и desktop; **(c)** рендер облака (градиент, рамка, круги) на обеих поверхностях.
   - Состояния `finish-setup` (R4/S-9), `no-perm` (S-10), `connected_ready` (R5) и `configured===false` (R2) требуют либо реального Stripe-аккаунта посреди onboarding, либо другого пользователя/энва — **в превью честно НЕ воспроизводятся**. НИКАКИХ временных хаков (state-override, стабов query) в коммитимом коде НЕ допускается. Эти состояния верифицируются: **(i)** code review против таблиц R1–R5 (§2) и S-8..S-11 (§3) — ветвления малы и читаются глазами; **(ii)** тем фактом, что условия ветвления не изменились ни на байт (AC-4 = diff-проверка условий); **(iii)** опционально, БЕЗ коммита: временная подмена `readiness` в React DevTools / локально изменённый мок ответа `/status` — допустимо только как незакоммиченная ручная проверка.
   - Мобильная проверка: `preview_resize` 375×812 → скролл-позиция 0 → CTA «Connect Stripe» видима; отсутствие горизонтального скролла на 320–375; `preview_inspect` кнопки CTA → высота ≥44px.
4. **AC-4 gating:** git-diff обоих TSX не должен затрагивать ни одной строки из §0.1-цитаты (`canCollect`…`showCta`) и ни одного условия/мутации/query из §0.2; меняется только JSX-презентация и строки.
5. **AC-5 copy:** сверить каждую строку §4 посимвольно (включая `·`, `¢`, `~`, `%`, `’`/`'` как в каталоге — копировать из этого файла, не перенабирать).
6. **AC-6:** `git diff --stat` — ни одного нового файла в `assets/`/`public/`; grep нового кода на `url(`/`.svg`/`.png` в контексте облака = пусто.

---

## §6 — Out of scope / защищённое (ломать НЕЛЬЗЯ)

- **Gating-логика целиком:** `canCollect`, `stripeReady`, `isConnectState`, `showCta`, `canManageIntegrations`, `enabled: canCollect` на query, navigate-цель `/settings/integrations/stripe-payments` (§0.1 — байт-идентично).
- **Мутации/queries Settings-страницы:** `connectMut`/`resumeMut`/`refreshMut`/`disconnectMut`, query `['stripe-payments-status']`, disconnect-Dialog, `StatusBadge`/`ReadinessRow` компоненты (кроме текста `not_connected` в map).
- **Backend:** `computeReadiness`, `canCollect`, `publicStatus` (форма ответа), ключи/`done`/`deferred` чеклиста — меняются ТОЛЬКО 3 label-строки :67–69. Никаких новых endpoint'ов/роутов; company-scope middleware не затрагивается (изменений API нет — чеклист N/A).
- **`CollectPaymentDialog`** и вся collect-механика (STRIPE-ADHOC-PAY-001), кнопка «Collect payment».
- **Invoice/estimate send-and-pay** (SEND-DOC-001), инвойсные collect-поверхности.
- **`SettingsPageShell`/`SettingsSection` API** (hero — просто первый ребёнок shell), `authedFetch.ts`, `useRealtimeEvents.ts`.
- **НЕТ:** миграций, новых зависимостей, dark-mode варианта (dark mode в приложении отсутствует), pricing-API (ставки хардкод), изменений readiness-машины, SSE.
