# UI-AUDIT-001 — аудит консистентности фронтенда

**Дата:** 2026-07-02 · **Скоуп:** `frontend/src` @ master `d7803a9` · **Метод:** механические сканы (grep/подсчёты) + 4 параллельных read-only агента (шеллы Настроек / инпуты / оверлеи / вёрстка+Pulse-зона). Код не менялся.

---

## Executive summary

| # | Находка | Масштаб | Корень |
|---|---------|---------|--------|
| 1 | **6 почти неразличимых кремовых поверхностей** в токенах + холодные чернила на тёплом фоне | вся палитра | сами токены |
| 2 | **8 разных «видов» инпута**, floating-канону соответствует ~45% | ~340 полей | примитивы расходятся: Floating* = прозрачный, raw Input = белый `#fff` |
| 3 | **Оверлеи: ядро чистое, но ~40–60% поверхностей мимо канона** | ~26–30 поверхностей | самодельные дропдауны + z-литералы |
| 4 | **Настройки: 25+ страниц на 4–5 разных шеллах** | все Settings | нет `SettingsPageShell`-компонента |
| 5 | **CSS размазан:** ядро 991 строка + **5 148 строк** в 11 покомпонентных css | 11 файлов | страницы стилизуются локально |

Итоговая консистентность UI — грубо **40–50%**. Хорошая новость: примитивы (Overlay/Dialog/BottomSheet/FloatingField) в порядке — лечится миграцией **использований**, ядро слоёв не трогаем.

---

## 1. Палитра и токены (корень «грязного» ощущения)

Все токены определены в одном месте — `src/styles/design-system.css` (единственный источник, дублей-определений нет). Проблемы в самих значениях:

**1a. Шесть near-white/кремовых поверхностей:**

| Токен | Значение | Роль сейчас |
|---|---|---|
| `--blanc-bg` | `#efe9df` | фон приложения («кофейный») |
| `--blanc-bg-deep` | `#e3dacd` | глубокий фон |
| `--blanc-surface` | `rgba(252,249,244,.84)` | frosted-стекло |
| `--blanc-surface-strong` | `#fdf8f0` | карточки |
| `--blanc-surface-muted` | `#f4ede2` | приглушённые блоки |
| `--blanc-panel-surface` | `#fffdf9` | поверхность шторок/форм |

Плюс седьмой де-факто: `bg-input-background = #ffffff` (tailwind-переменная, на ней сидят raw-инпуты). Когда «почти белых» семь — каждый компонент берёт свою, глаз читает это как грязь. **Целевое: 3 семантических уровня** (фон / карточка / поле) + frosted как модификатор.

**1b. Температурный конфликт.** Чернила холодные сине-серые (`--blanc-ink-1 #202734`, `-2 #536070`, `-3 #7d8796`), фон и бордеры — тёплые (`rgba(117,106,89,…)`). Тёплое+холодное = мутность. Лечится согласованием температуры (проще всего — осветлить/нейтрализовать фон, чернила оставить).

**1c. Фрагментация CSS.** Помимо ядра: `MessagesPage.css` 898, `SoftPhoneWidget.css` 638, `CustomTimeModal.css` 620, `PaymentsPage.css` 561, `CreateLeadJobWizard.css` 478, `AppLayout.css` 405, `CreateLeadDialog.css` 323, `LeadCard.css` 321, `PulsePage.css` 288, `LeadFormSettingsPage.css` 260, `auth-shell.css` 135 = **5 148 строк** локальных стилей. Плюс `theme.css`/`tailwind.css`/`schedule-redesign.css`. В самом ядре секция «page-level overrides» — страничные стили в глобальном файле.

**1d. Хардкоды цвета в tsx.** Топ: `CallFlowBuilderPage` (118 hex), `UserGroupsPage` (92), `UserGroupDetailPage` (63), `apiDocsData/ApiDocsPage` (54+52), `workflowNodeTypes` (47), `PhoneNumbersPage` (40), `nodeInspectors` (36). rgba-хардкоды: весь кластер `schedule/*` (ScheduleSidebar 23, DayView 19, CalendarControls 18, WeekView 17…).

---

## 2. Инпуты — 8 «видов» поля (жалоба «где-то белые, где-то прозрачные»)

| Вид | Кол-во | Статус |
|---|---|---|
| 1. `FloatingField`/`FloatingSelect`/`PhoneInput` floating — **прозрачные, border-only** | ~152 (45%) | ✅ канон |
| 2. Raw `Input`/`Textarea`/`SelectTrigger` — **белая заливка `#ffffff`** | ~150 | ⚠️ терпимо в таблицах/тулбарах, неверно на панелях (белое на `#fffdf9`) |
| 3. Auth-мир (`auth-shell.css` floating) — Signup/Onboarding | 3 стр. | ⚠️ работает, но параллельная система |
| 4. **Stacked `<Label>` над полем** — нарушение floating-канона | ~20–30 | ❌ WizardStep1 (5), WizardStep4 (8), CompanyUserDialogs (5), UserFilters (3) |
| 5. Инлайн `background:'#fff'`/rgba на полях | ~60 | ❌ PhoneNumbersPage:317–367, UserGroupsPage:367, PriceBookPage:362/418/539, TemplateStructure |
| 6–8. **Мир инспекторов** — свой `fieldStyle`, бордер `#d1d5db` (не из палитры) | 67 полей | ❌ `nodeInspectors` (45), `RuleEditor` (12), `workflowInspectors` (10) |

Ключевая развилка примитивов: `floating-field` = `bg-transparent`, а `ui/input` = `bg-input-background(#fff)`. Это и есть системная причина «то белые, то прозрачные».

---

## 3. Оверлеи — ядро чистое, дрейф в использованиях

Ядро (`Overlay.tsx`, `OverlayStack.tsx` z-aware, `dialog.tsx`, `BottomSheet`, `FloatingDetailPanel`, тиры panel 80 / modal 140 / popover 150 / sheet 200 / lightbox 1000) — **менять не нужно**.

**3a. Самодельные дропдауны (6), вместо `ui/popover`:**

| Компонент | z | Проблема |
|---|---|---|
| `pulse/SnoozeDropdown` :83 | `z-[101]` | выше панели(80), НИЖЕ модалки(140) → из модалки спрячется; свой click-outside |
| `pulse/AssignOwnerDropdown` :96 | `z-[101]` | то же |
| `pulse/SmsForm` quick-messages :190 | `z-[101]` | то же |
| `pulse/PulseContactItem` меню :303 | `z-[100]` | то же |
| `schedule/SlotContextMenu` :128 | `z-50` | спрячется под ЛЮБОЙ оверлей |
| `schedule/OverflowPopover` :46 | `z-50` | то же |

(Мобильные версии Snooze/AssignOwner уже на BottomSheet — мигрировать только desktop-ветку.) Канонический popover-тир = `z-[150]` — миграция на `ui/popover` решает z автоматически.

**3b. Fixed-оверлеи вне шкалы:** `auth/TwoFactorGate` :32 (`z-9999`), `layout/AppLayout` access-denied :165 (`z-9999`), `layout/AutonomousModeBanner` :31 (`z-100`; по-хорошему это toast/баннер, не оверлей).

**3c. Нарушение канона шторок:** `estimates/EstimateSummaryDialog` :22 — **редактор в центр-модалке** (default variant), должен быть `variant="panel"`. `EstimateItemDialog` :43 — правильный panel, но с загадочным `z-[70]` (ниже собственного тира 80) — снять.

**3d. z-литералы в Schedule:** `SidebarStack` z-40/50/51 (спрячется за модалкой), `CalendarControls` z-120/130 (на волосок от 140). Внутренние z-1..9 в Day/Week/TimelineView — локальный стекинг, конфликта нет, не трогать.

**3e. `CustomTimeModal`** (966 строк + свой css 620 строк): модалка канонична, но внутренний z-стек маркеров Google Maps (`zIndex:999`, `100-i`) вне констант. Низкий приоритет.

---

## 4. Настройки — 25+ страниц, 4–5 шеллов

Кластеры: **(I) «панель+секции»** — 8 стр. (Company, TechnicianPhotos, Vapi, Stripe, GoogleEmail, ActionRequired, ServiceTerritories, PriceBook-модалки); **(II) full-flex с вкладками** — LeadForm, QuickMessages; **(III) плоские списки/гриды без заголовка** — Providers, Automation, Billing, AudioLibrary, ProviderSettings, OperationsDashboard, RoutingLogs; **(IV) таблично-диалоговые** — Users, Roles, SuperAdmin, AdminCompanyDetail; **(V) полностью самопальные** — ApiDocs (сплошные инлайн-стили, hex `#111/#666`), UserGroups (самодельная модалка), PhoneNumbers.

Разнобой по всем осям: max-width (нет / 3xl / 4xl / 5xl / 6xl / fullscreen), заголовок (h1/h2/нет; eyebrow есть/нет; back-link есть/нет), секции (rgba-карточки / ui/card / flat / инлайн), сохранение (Save-на-секцию / sticky / auto-save / диалоги). Функция-обёртка `Eyebrow()` скопирована минимум в 3 файла вместо класса `.blanc-eyebrow`.

**Эталон:** `CompanySettingsPage` (~85–90% канона: sectionCard rgba(117,106,89,.04)/r16, eyebrow, FloatingField, back-link, max-w-4xl). Доработать (инлайн-стили → классы) и извлечь из неё `SettingsPageShell` + `SettingsSection`.

**Худшие:** ApiDocsPage → UserGroupsPage → PhoneNumbersPage → RolesAccessPage → BillingPage.

---

## 5. Вёрстка (div-soup)

Топ по глубине JSX (грубая метрика; App.tsx=132 — артефакт Route-дерева, не DOM): `TemplateStructure` 66, `CallFlowBuilderPage` 63 (**107 инлайн-style в файле**), `PriceBookPage` 60, `WorkflowBuilderPage` 53, `InvoiceDetailPanel` 50, `EstimateDetailPanel` 45.

Типовые дубли:
- `JobMobileCard` (206 стр.) и `LeadMobileCard` (93 стр.) — **на ~90% одинаковый** каркас (border-left 4px accent, r18, shadow-card) → shared `MobileListCard`;
- статус-пиллы (одинаковый `inline-flex rounded-full px-2.5…`) в обоих → shared `StatusPill`;
- 4+ идентичных скелетона в `TemplateStructure` → shared `SkeletonLine`;
- wrapper-only `<div>` (одноклассные прокси-обёртки) — по выборке ~120–180 лишних узлов.

В `shared/` сейчас только AttachmentsSection / NotesSection / HistorySection — карточных shared-компонентов нет вовсе.

---

## 6. Охраняемая зона — Pulse-таймлайн (FREEZE)

| Компонент | Строк | Критичность |
|---|---|---|
| `pulse/PulseTimeline.tsx` | 188 | оркестратор ленты |
| `pulse/PulseCallListItem.tsx` | 148 | плитка звонка |
| `pulse/PulseCallAudioPlayer.tsx` | **358** | **КРИТИЧНО**: live-транскрипция (`useLiveTranscript`/WebSocket), `/api/calls/:id/media`, `/api/calls/:id/transcribe`, Gemini-summary |
| `pulse/SmsListItem.tsx` | 161 | chat-bubbles + медиа-загрузка |
| `pulse/EmailListItem.tsx` | 84 | парсинг отправителя |
| `pulse/FinancialEventListItem.tsx` / `DateSeparator.tsx` | 69/41 | низкая |

Правило: в волнах 1–5 эти файлы **не трогаются** (кроме, при необходимости, чисто токен-подстановок значений цвета). Волна 6 — отдельно, поштучно, с ручным чек-листом: live-транскрипция, плеер+синхронизация, regenerate, медиа-SMS, email-лейблы.

---

## 7. План волн

Механика против «поломки как со слоями»: **(а)** волна = один смысл (либо стили, либо разметка, либо поведение — никогда вместе); **(б)** каждая волна деплоится отдельно; **(в)** фронт без тестов → верификация = `npm run build` + скриншоты фиксированного списка роутов до/после; **(г)** ядро OverlayStack не трогаем.

| Волна | Что | Риск | Эффект |
|---|---|---|---|
| **W0. Скриншот-база** | Чек-лист ~15 роутов (Pulse, Jobs, Leads, Schedule, Contacts, Estimates/Invoices, 5–6 Настроек, мобильные варианты), эталонные скриншоты | нулевой | страховка для всех волн |
| **W1. Токенизация** (визуально ≈ноль) | Все хардкод-hex/rgba/`#fff` → существующие токены; `ui/input`/`textarea`/`select` → единый токен поверхности поля; stacked Label → Floating* (4 файла); инспекторы (67 полей) → примитивы; z-литералы → тиры/`ui/popover` | низкий | палитра становится управляемой из ОДНОГО файла |
| **W2. Палитра v2** | Правка ЗНАЧЕНИЙ токенов по выбранному мокапу: 6 поверхностей → 3, фон чище, температура согласована | низкий (один коммит, мгновенный revert) | **весь редизайн цвета одним деплоем** |
| **W3. Оверлей-дрейф** | 6 дропдаунов → `ui/popover`; EstimateSummaryDialog → panel; снять `z-[70]`; SidebarStack/CalendarControls в тиры; TwoFactorGate/access-denied/баннер → канон | средний | одинаковое поведение слоёв везде |
| **W4. Настройки** | `SettingsPageShell`+`SettingsSection` из CompanySettingsPage → миграция кластерами I→III→IV→(ApiDocs отдельно) | средний | один дизайн всех настроек |
| **W5. Вёрстка** | shared `MobileListCard`/`StatusPill`/`SkeletonLine`; CallFlowBuilder инлайн→CSS; wrapper-only divs; распил покомпонентных css | средний | −500+ LOC, ровные списки |
| **W6. Pulse (охраняемая)** | Токен-подстановки и аккуратная чистка плитки звонка/плеера/транскрипции, поштучно | высокий → медленно | консистентность без потери функций |

Порядок W1→W2 принципиален: сначала всё сажаем на токены при старой палитре (визуально ничего не меняется — легко проверять), потом меняем значения токенов — редизайн приезжает одним атомарным, обратимым коммитом.

**Ворота перед W2:** выбор палитры глазами на живом мокапе (2–3 варианта рядом с текущей).
