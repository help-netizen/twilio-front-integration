# INPUT-KBD-AUDIT — мобильные текстовые вводы

Дата снимка: 2026-07-27. Это только research-инвентарь; код и поведение компонентов не менялись.

## Методика и границы

Просканированы `frontend/src/components` и `frontend/src/pages` по нативным
`input`/`textarea`, `Input`/`Textarea`, `FloatingField`, `PhoneInput`, а также по
`FloatingSelect`, `Command`, `combobox`, autocomplete и search-as-you-type. Контейнер каждого
кандидата проверен отдельно: normal-flow страница, viewport-bound колонка, `FloatingDetailPanel`,
mobile `BottomSheet`, `DialogContent variant="panel"` или центрированный fixed-dialog.

Единица счёта ниже — **JSX-шаблон текстового поля**, а не число DOM-узлов во всех возможных
данных. Поэтому поле внутри `.map()` считается один раз и помечается `×N`; известные варианты
перечислены в тексте. Внутренности переиспользуемых компонентов (`AddressAutocomplete`,
`ItemPresetSearchCombobox`, `AreaCodeCombo`) считаются в файле реализации один раз, а все
mobile call-sites перечислены в разделе B. Так счёт не раздувается одинаковым нативным
`input` на каждом месте использования.

- `A-simple`: одна строка `text/email/number/tel/search/password/url`.
- `A-textarea`: многострочный ввод, включая auto-grow composer.
- `B-combobox`: ввод меняет список совпадений, из которого пользователь выбирает строку.
- `уже-ок`: normal-flow input, который iOS может штатно проскроллить, либо уже готовый
  `NoteComposerOverlay`.
- `A`: на mobile исходное поле должно стать только триггером, а реальный ввод — карточкой
  `NoteComposerOverlay` над клавиатурой.
- `B`: нужен отдельный полноэкранный mobile-search с закреплённым сверху input и
  прокручиваемыми результатами.

Не входят в итог: `type=file`, checkbox/radio/switch, color, date/time, обычные
`FloatingSelect`/`select` без текстового поиска и Stripe-hosted iframe-поля. Все 24 найденных
`FloatingSelect` call-sites просмотрены: сами по себе software keyboard не вызывают.

Отдельно проверен существующий `components/shared/FloatingTextField.tsx:45-80`: на mobile
он уже делает inline field read-only триггером и открывает реальный input/textarea внутри
`NoteComposerOverlay`. Его единственный call-site отмечен ниже как `уже-ок`.

## Полный инвентарь mobile-reachable полей

`S`, `T`, `B` — количество шаблонов соответственно `A-simple`, `A-textarea`,
`B-combobox`.

### Shared, contacts, conversations, messaging

| Файл:строка | Компонент / экран и поля | S | T | B | Mobile-контекст | Текущее поведение | Цель |
|---|---|---:|---:|---:|---|---|---|
| `components/AddressAutocomplete.tsx:98,110,114,119` | Street search; Apt, City, Zip | 3 | 0 | 1 | 11 mobile-reachable экранов; список ниже | Input и absolute `z-50` listbox внутри текущего scroll/fixed-контейнера; клавиатура съедает нижнюю часть списка | Street → B; Apt/City/Zip → A только в fixed layer, иначе уже-ок |
| `components/auth/TwoFactorGate.tsx:146` | 6-digit OTP | 1 | 0 | 0 | Да; на mobile принудительный `BottomSheet` | Autofocus в fixed bottom sheet; явный риск перекрытия | A |
| `components/automation/RuleEditor.tsx:87,91,124,145,151,205` | Rule name, description, cron, condition field/value, action params `×N` | 6 | 0 | 0 | Да, но редкий admin-route | Inline settings editor, normal flow | уже-ок |
| `components/contacts/EditContactDialog.tsx:207,213,220,230,241,281,287,306` | First/last/company, primary phone, email `×N`, secondary phone/name, notes | 7 | 1 | 0 | Да; edit contact `Dialog panel` → mobile bottom sheet | Длинная fixed-sheet форма; нижние поля могут остаться под клавиатурой | A |
| `components/contacts/PulseContactPanel.tsx:176,205` | Inline email edit; contact notes | 1 | 1 | 0 | Да; Pulse mobile content column | Viewport-height flex column, не отдельный keyboard-aware overlay | A; email сверху имеет меньший риск |
| `components/conversations/ConversationList.tsx:130` | Search phone | 1 | 0 | 0 | Да | Inline list search, результаты — сама страница, не dropdown | уже-ок |
| `components/conversations/WizardStep1.tsx:70,156,157,160,161` | Territory Places search; first/last, phone, email | 4 | 0 | 1 | Да; Create Lead/Job wizard в Pulse | Wizard живёт в viewport-bound колонке; Places list absolute под input | Territory → B; остальные → A |
| `components/conversations/WizardStep2.tsx:18,21,24` | Description; duration, price | 2 | 1 | 0 | Да; тот же wizard | Viewport-bound wizard, без keyboard inset | A |
| `components/conversations/WizardStep4.tsx:23,24,27,28,53,56,59` | First/last, phone, email, description, duration, price; плюс shared address autocomplete | 6 | 1 | 0 | Да; review step wizard | Viewport-bound wizard | A; address street → B через shared component |
| `components/email/EmailComposer.tsx:66,92,107,119` | To, CC, Subject, body | 3 | 1 | 0 | Да; compose/reply в нижней части full-height email pane | Composer — нижний flex-child, не normal document flow; клавиатура уменьшает доступное место непредсказуемо | A |
| `components/email/EmailThreadList.tsx:35` | Search emails | 1 | 0 | 0 | Да | Inline search над списком | уже-ок |
| `components/feedback/FeedbackWidget.tsx:329,343,406` | Escalation email/message; chat composer | 1 | 2 | 0 | Да; mobile открывается из More | Fixed panel ограниченной высоты, keyboard inset не учитывается | A |
| `components/messaging/MessageThread.tsx:221` | Message composer | 0 | 1 | 0 | Да; legacy Messages | Нижний flex composer в viewport-height thread | A |
| `components/messaging/NewConversationDialog.tsx:56,67` | Customer phone; initial message | 1 | 1 | 0 | Да | Самодельный centered fixed overlay без keyboard handling | A |
| `components/pulse/SmsForm.tsx:133` | SMS/email composer | 0 | 1 | 0 | Да; основной Pulse composer | Нижний composer в viewport-bound Pulse pane; quick-message sheet отдельный | A |
| `components/settings/marketplace/MarketplaceAppDetail.tsx:208` | Review comment | 0 | 1 | 0 | Да; `FloatingDetailPanel` | Mobile entity layer / bottom sheet | A |
| `components/settings/marketplace/MarketplaceGrid.tsx:55` | Search marketplace apps | 1 | 0 | 0 | Да | Inline search, фильтрует уже видимую grid, не dropdown | уже-ок |
| `components/shared/NotesSection.tsx:381,409` | Mobile ADD и EDIT note | 0 | 2 | 0 | Да | Уже `NoteComposerOverlay`: portal в body, `visualViewport` inset, poll 250 ms | **уже-ок / DONE** |

### Estimates, invoices, payments, transactions

| Файл:строка | Компонент / экран и поля | S | T | B | Mobile-контекст | Текущее поведение | Цель |
|---|---|---:|---:|---:|---|---|---|
| `components/estimates/EstimateDetailPanel.tsx:495,503,526,692` | Discount fixed/percent branches, tax rate; decline reason | 3 | 1 | 0 | Да; `FloatingDetailPanel` + centered decline dialog | Viewport-bound entity layer; decline — fixed dialog | A |
| `components/estimates/EstimateEditorDialog.tsx:351,405,411,424,434,503,509,533,599,629,636,645,653` | AI report; line item title/description/qty/price `×N`; discount branches, tax; nested summary and new-item fields | 9 | 4 | 0 | Да; full-size panel + вложенные panel dialogs | Несколько длинных fixed sheets, keyboard inset отсутствует | A |
| `components/estimates/EstimateItemDialog.tsx:57,63,72,79` | Title, description, qty, unit price | 3 | 1 | 0 | Да; panel поверх estimate/invoice detail | Вложенный fixed bottom sheet | A |
| `components/estimates/EstimateSendDialog.tsx:226,237` | Email/phone recipient; personal message | 1 | 1 | 0 | Да | Centered fixed dialog | A |
| `components/estimates/EstimateSummaryDialog.tsx:24` | Summary | 0 | 1 | 0 | Да | Centered fixed dialog | A |
| `components/estimates/ItemPresetSearchCombobox.tsx:175` | Search/browse Price Book item | 0 | 0 | 1 | Да; 4 estimate/invoice call-sites | Input + absolute `top-full`, `max-h-80` dropdown внутри entity panel | B |
| `components/estimates/OrderListSection.tsx:53,61,69` | Part number, name, qty `×N` | 3 | 0 | 0 | Да; estimate/invoice editor panels | Inline внутри длинного fixed sheet | A |
| `components/invoices/InvoiceDetailPanel.tsx:460,665,685` | Record-payment amount; discount; tax rate | 3 | 0 | 0 | Да; `FloatingDetailPanel`, payment form также mobile dialog | Viewport-bound panel / fixed dialog | A |
| `components/invoices/InvoiceEditorDialog.tsx:318,374,380,392,402,445,464,530,562,569,578,586` | AI report; line item fields `×N`; discount/tax; nested summary and new-item fields | 8 | 4 | 0 | Да; full panel + вложенные panels | Длинные fixed sheets | A |
| `components/invoices/InvoiceSendDialog.tsx:235,246` | Email/phone recipient; personal message | 1 | 1 | 0 | Да | Centered fixed dialog | A |
| `components/invoices/ManualCardDialog.tsx:262`; `components/shared/FloatingTextField.tsx:45-80` | **Customer email** | 1 | 0 | 0 | Да; success state manual-card `Dialog panel` | Известный owner repro уже закрыт в текущем source: `FloatingTextField` оставляет read-only триггер и открывает `NoteComposerOverlay`; Stripe iframe-поля рядом не входят в app-owned счёт | **уже-ок (A), P0 regression** |
| `components/jobs/CollectPaymentDialog.tsx:220,317,325` | Amount; send-to email; send-to phone | 3 | 0 | 0 | Да; payment panel | Fixed bottom sheet | A |
| `components/jobs/JobRecordPaymentDialog.tsx:91,109,120` | Amount, reference; internal note | 2 | 1 | 0 | Да; panel | Fixed bottom sheet | A |
| `components/payments/VoidPaymentDialog.tsx:72` | Required void reason | 0 | 1 | 0 | Да; centered confirmation | Fixed dialog | A |
| `components/transactions/RecordPaymentDialog.tsx:80,102,109,118,125` | Amount, invoice, customer, reference; memo | 4 | 1 | 0 | Да; panel | Fixed bottom sheet | A |
| `components/transactions/RefundDialog.tsx:89,101` | Refund amount; reason | 1 | 1 | 0 | Да; panel | Fixed bottom sheet | A |
| `components/transactions/TransactionDetailPanel.tsx:274` | Receipt email/phone | 1 | 0 | 0 | Да; `FloatingDetailPanel` | Viewport-bound entity layer | A |

### Jobs, leads, schedule, tasks

| Файл:строка | Компонент / экран и поля | S | T | B | Mobile-контекст | Текущее поведение | Цель |
|---|---|---:|---:|---:|---|---|---|
| `components/jobs/JobDescription.tsx:59` | Job description inline edit | 0 | 1 | 0 | Да; job `FloatingDetailPanel` | Поле в viewport-bound entity layer | A |
| `components/jobs/JobDetailPanel.tsx:161` | Cancel reason | 0 | 1 | 0 | Да | Centered fixed dialog | A |
| `components/jobs/JobTechnicianControl.tsx:90` | Search providers | 0 | 0 | 1 | Да; permission-gated | `cmdk` input/list в mobile `BottomSheet`; keyboard уменьшает место списка | B |
| `components/jobs/JobsMobileBar.tsx:114` | Search jobs | 1 | 0 | 0 | Да; только mobile | Верхний sticky bar, поле уже над результатами страницы | уже-ок |
| `components/jobs/NewJobDialog.tsx:292,341,342,344,395,406,407` | Contact search; new name/phone/email; description; custom text/number/textarea `×N` | 4 | 2 | 1 | Да; panel | Contact results — absolute `.cld-candidates`; остальные поля — длинный fixed sheet | Contact → B; остальные → A |
| `components/jobs/OnTheWayModal.tsx:270` | Custom ETA minutes | 1 | 0 | 0 | Да; panel | Fixed bottom sheet | A |
| `components/leads/ConvertToJobSteps.tsx:59,60,62,82,84,86,87` | Name, phone, email, custom service name/price/duration; description | 6 | 1 | 0 | Да; convert flow в lead layer | Viewport-bound multi-step form | A; shared address street → B |
| `components/leads/CreateLeadDialog.tsx:117,118,123,124,132,135,138,143,175,186,187` | First/last/phone/email contact triggers; secondary phone/name/company branches; description; custom fields `×N` | 5 | 2 | 4 | Да; panel | Четыре поля запускают один absolute existing-contact dropdown; остальное — длинный fixed sheet | Contact triggers → B; остальные → A |
| `components/leads/EditLeadDialog.tsx:66,67,70,71,77,78,81,97,105` | Identity/contact fields, secondary fields, company, dynamic metadata; description | 8 | 1 | 0 | Да; panel | Длинный fixed sheet | A; shared address street → B |
| `components/leads/LeadsMobileBar.tsx:110` | Search leads | 1 | 0 | 0 | Да; только mobile | Верхний sticky bar | уже-ок |
| `components/schedule/MobileScheduleBar.tsx:174` | Search schedule | 1 | 0 | 0 | Да; только mobile | Поле находится внутри `View options` BottomSheet | A |
| `components/schedule/NewJobModal.tsx:85` | Title; плюс shared address autocomplete | 1 | 0 | 0 | Да; panel | Fixed bottom sheet | Title → A; address street → B |
| `components/schedule/ScheduleMapCanvas.tsx:297` | Find ZIP on map | 1 | 0 | 0 | Да; mobile map | Absolute control сверху карты, не bottom input; явная кнопка submit | уже-ок |
| `components/schedule/TimeOffDialog.tsx:192` | Note | 0 | 1 | 0 | Да; panel | Fixed bottom sheet | A |
| `components/tasks/TaskFormDialog.tsx:128` | Description | 0 | 1 | 0 | Да; panel | Fixed bottom sheet | A |
| `components/workflows/ActionsBlock.tsx:178,240` | Cancel reason; override reason | 0 | 2 | 0 | Да; действия из job/lead detail | Два panel dialogs | A |

### Settings, telephony, admin

| Файл:строка | Компонент / экран и поля | S | T | B | Mobile-контекст | Текущее поведение | Цель |
|---|---|---:|---:|---:|---|---|---|
| `components/settings/BankTransferDetails.tsx:96-101` | Bank/account/routing/SWIFT; payment instructions | 5 | 1 | 0 | Да | Inline settings normal flow | уже-ок |
| `components/settings/InspectorSettingsPanel.tsx:96,257` | Search statuses (component rendered twice); agent instruction | 0 | 1 | 1 | Да; Inspector panel, status picker сам открывает mobile popover-sheet | Search/list в `BottomSheet`, instruction в outer fixed panel | Status → B; instruction → A |
| `components/settings/RecommendationSettings.tsx:208,268` | Number field template `×3`; custom minute template `×2` | 2 | 0 | 0 | Да | Inline schedule settings | уже-ок |
| `components/super-admin/BootstrapAdminDialog.tsx:79,81,82` | Email, first name, last name | 3 | 0 | 0 | Да, role-gated | Panel → mobile bottom sheet | A |
| `components/super-admin/CompaniesManager.tsx:81` | Search companies | 1 | 0 | 0 | Да, role-gated | Inline page search | уже-ок |
| `components/super-admin/CreateCompanyDialog.tsx:88,89,92,93,95` | Company, slug, timezone, locale, admin email | 5 | 0 | 0 | Да, role-gated | Panel → mobile bottom sheet | A |
| `components/super-admin/PlatformUsersTab.tsx:66` | Search users | 1 | 0 | 0 | Да, role-gated | Inline page search | уже-ок |
| `components/telephony/A2pStepper.tsx:153` | Business registration input template `×11` | 1 | 0 | 0 | Да | Inline Phone Numbers settings, normal flow | уже-ок |
| `components/telephony/AreaCodeCombo.tsx:144` | Area code or city | 0 | 0 | 1 | Да | Absolute listbox под field; в buy-number panel или setup page | B |
| `components/telephony/NumberSearch.tsx:142` | Contains digits | 1 | 0 | 0 | Да | В buy-number panel — fixed sheet; в setup page — inline | A в panel; уже-ок inline |
| `components/telephony/PortInPanel.tsx:424,455,462,463,466,477,478,484,485,487,488,491,492` | Current/account phones, customer/account/auth representative and full address fields | 13 | 0 | 0 | Да; interactive form в transfer panel и telephony setup | Fixed sheet в Phone Numbers; inline в setup | A в panel; уже-ок inline |
| `components/users/UserFilters.tsx:28` | Search name/email | 1 | 0 | 0 | Да | Inline Users/Admin Company page search | уже-ок |
| `pages/CompanySettingsPage.tsx:83-86` | Company, contact email/phone, billing email | 4 | 0 | 0 | Да | Inline settings normal flow | уже-ок |
| `pages/CompanyUserDialogs.tsx:53,127,128,186,188,189` | Fallback Zenbooker ID; create/edit name, emails, phone | 6 | 0 | 0 | Да | Create/Edit panels | A |
| `pages/IntegrationDialogs.tsx:23` | Integration client name | 1 | 0 | 0 | Да | Panel | A |
| `pages/IntegrationsPage.tsx:361` | Zenbooker API key | 1 | 0 | 0 | Да | Inline settings | уже-ок |
| `pages/LeadFormSettingsPage.tsx:107,121,148` | New job type, metadata display name, new tag | 3 | 0 | 0 | Да | Inline settings | уже-ок |
| `pages/MailSecretarySettingsPage.tsx:315,337,338,340` | Exclusion rules; test from/subject/body | 3 | 1 | 0 | Да | Inline settings normal flow | уже-ок |
| `pages/RateMeSettingsDialog.tsx:195,207,260` | Google review URL, booking URL, subdomain | 3 | 0 | 0 | Да | Panel | A |
| `pages/RelyLeadsSettingsDialog.tsx:201` | ZIP codes | 0 | 1 | 0 | Да | Panel | A |
| `pages/ServiceTerritoriesPage.tsx:413,609,619,951,964,967,971` | ZIP filter; radius ZIP/miles; Add ZIP dialog fields | 7 | 0 | 0 | Да | Filter/radius inline; Add ZIP — panel | Add ZIP → A; inline fields → уже-ок |
| `pages/SortableTag.tsx:34` | Inline tag rename | 1 | 0 | 0 | Да | Inline settings row | уже-ок |
| `pages/VapiSettingsPage.tsx:113,234,240` | API key, SIP URI, server URL | 3 | 0 | 0 | Да | Inline settings | уже-ок |
| `pages/telephony/BlacklistPage.tsx:182` | Phone number | 1 | 0 | 0 | Да | Add-to-blacklist panel | A |
| `pages/telephony/PhoneNumbersPage.tsx:380` | Search owned numbers | 1 | 0 | 0 | Да | Inline page search | уже-ок |
| `pages/telephony/UserGroupDetailPage.tsx:200` | Inline group-name edit | 1 | 0 | 0 | Да | Inline settings header | уже-ок |
| `pages/telephony/UserGroupsPage.tsx:177` | Group name | 1 | 0 | 0 | Да; explicit mobile `BottomSheet size="full"` | Fixed sheet | A |

### Top-level lists, public/auth pages, content settings

| Файл:строка | Компонент / экран и поля | S | T | B | Mobile-контекст | Текущее поведение | Цель |
|---|---|---:|---:|---:|---|---|---|
| `pages/ContactsPage.tsx:110` | Search contacts | 1 | 0 | 0 | Да | Inline page search, фильтрует основной list | уже-ок |
| `pages/EstimatesPage.tsx:89` | Search estimates | 1 | 0 | 0 | Да | Inline page search | уже-ок |
| `pages/InvoicesPage.tsx:103` | Search invoices | 1 | 0 | 0 | Да | Inline page search | уже-ок |
| `pages/MessagesPage.tsx:43` | Search conversations | 1 | 0 | 0 | Да | Inline list search | уже-ок |
| `pages/PaymentsPage.tsx:49` | Search payments | 1 | 0 | 0 | Да | Input остаётся за открываемым mobile Filters `BottomSheet`; это не results-combobox | A |
| `pages/PriceBookPage.tsx:199,360,389,395,398,401,529,540,545,668,673` | Table search/edit cells `×N`; group name/qty/item picker; category name/description | 8 | 2 | 1 | Да, но таблица desktop-oriented и горизонтально скроллится | Inline table уже normal flow; group/category — panels; item results absolute | Dialog fields → A; item picker → B; table → уже-ок |
| `pages/PublicInvoicePayPage.tsx:162` | Custom tip | 1 | 0 | 0 | Да; public mobile-first page | Normal document flow | уже-ок |
| `pages/PulsePage.tsx:212` | Search Pulse contacts | 1 | 0 | 0 | Да | Верхний inline search | уже-ок |
| `pages/QuickMessagesPage.tsx:43,51,115,117` | Add/edit title and message | 2 | 2 | 0 | Да | Inline settings normal flow | уже-ок |
| `pages/RatePage.tsx:572` | Public negative-review feedback | 0 | 1 | 0 | Да; public page | Normal document flow | уже-ок |
| `pages/TasksPage.tsx:266` | Mobile task search | 1 | 0 | 0 | Да; desktop duplicate на `:315` исключён | Верхний sticky mobile bar | уже-ок |
| `pages/TransactionsPage.tsx:93` | Search transactions | 1 | 0 | 0 | Да | Inline page search | уже-ок |
| `pages/auth/OnboardingPage.tsx:67,235,275,279` | OTP-cell template, phone, company; City/ZIP autocomplete | 3 | 0 | 1 | Да; standalone auth flow | Normal-flow card, но location list absolute и с клавиатурой теряет место | Simple → уже-ок; location → B |
| `pages/auth/SignupPage.tsx:138,142,146` | Full name, email, password | 3 | 0 | 0 | Да; mobile-first auth page | Normal document flow | уже-ок |

## B: search-comboboxes

Всего mobile-reachable: **10 реализаций / 13 input-trigger шаблонов**. Разница возникает
из-за четырёх отдельных полей-триггеров contact dedupe в `CreateLeadDialog`.

Для всех десяти целевой контракт одинаков: на mobile оригинальный control лишь открывает
новый full-screen search; внутри него input закреплён сверху, результаты занимают
оставшуюся высоту и скроллятся независимо от клавиатуры. Desktop dropdown/popover можно
оставить как есть.

### 1. Price Book item picker — главный B-приоритет

- Реализация: `components/estimates/ItemPresetSearchCombobox.tsx:175,214`.
- Call-sites: `EstimateDetailPanel.tsx:459`, `EstimateEditorDialog.tsx:460`,
  `InvoiceDetailPanel.tsx:643`, `InvoiceEditorDialog.tsx:426`.
- Сейчас: debounced API search плюс categories/groups/frequent items/create-new; весь набор
  живёт в `absolute top-full z-30 max-h-80` внутри estimate/invoice layer.
- Mobile UX: input обычно находится ниже середины длинного bottom sheet; клавиатура закрывает
  dropdown и оставляет слишком мало высоты для category browsing.
- Цель: B. Это один новый reusable full-screen picker для всех четырёх call-sites.

### 2. Shared address autocomplete

- Реализация: `components/AddressAutocomplete.tsx:98-107`: Google Places + saved addresses,
  absolute `z-50` listbox.
- Все call-sites:
  - `settings/BaseAddressForm.tsx:47` → `CompanyBaseAddress.tsx:123` и
    `TechnicianPhotosPage.tsx:462`;
  - `schedule/NewJobModal.tsx:92`;
  - `leads/CreateLeadDialog.tsx:155`;
  - `leads/ConvertToJobSteps.tsx:63`;
  - `leads/EditLeadDialog.tsx:85`;
  - `contacts/PulseContactHelpers.tsx:73`;
  - `contacts/ContactInfoSections.tsx:153`;
  - `conversations/WizardStep4.tsx:35`;
  - `jobs/JobInfoSections.tsx:288`;
  - `jobs/NewJobDialog.tsx:349`.
- Сомнительный/неиспользуемый call-site: `contacts/AddressCard.tsx:74`; production import не
  найден, поэтому в mobile total не входит.
- Сейчас: suggestions прикреплены к street input и клипуются scroll-контейнером/клавиатурой;
  Apt/City/Zip остаются обычными полями ниже.
- Цель: street/saved-address selection → B; детали Apt/City/Zip остаются A-simple.

### 3. New Job: existing-contact search

- `components/jobs/NewJobDialog.tsx:292-334`.
- Сейчас: debounced name/phone search, `.cld-candidates` absolute под input в mobile panel;
  выбор контакта/его адреса заполняет форму.
- Mobile UX: панель и клавиатура конкурируют за высоту, результаты появляются под input и
  могут уйти под клавиатуру.
- Цель: B.

### 4. New Lead: existing-contact dedupe/search

- Triggers: `components/leads/CreateLeadDialog.tsx:117,118,123,124`
  (First name, Last name, Phone, Email).
- Логика/результаты: `components/leads/useContactSearch.tsx:86-157`;
  CSS dropdown: `components/leads/CreateLeadDialog.css:172-183`.
- Сейчас: один debounced candidate-search, но dropdown якорится к активной группе
  `name/phone/email`; `position:absolute`, `max-height:240px`.
- Mobile UX: четыре отдельных keyboard entry points и один dropdown внутри panel; особенно
  нижняя phone/email row легко оказывается у клавиатуры.
- Цель: B; mobile стоит свести к одному явному contact-search surface, а исходные поля
  оставить триггерами/полями выбранного или нового контакта.

### 5. Provider picker

- `components/jobs/JobTechnicianControl.tsx:87-109`.
- Сейчас: `cmdk` `CommandInput` + `CommandList`; desktop — Popover, mobile — canonical
  `BottomSheet`.
- Mobile UX: результаты уже скроллятся, но input находится внутри bottom sheet и сам sheet
  не поднимается по keyboard inset.
- Цель: B.

### 6. Wizard territory Places search

- `components/conversations/WizardStep1.tsx:17-95`, trigger на `:70`.
- Сейчас: Google Places suggestions в absolute listbox под input внутри Pulse wizard.
- Mobile UX: viewport-bound wizard + клавиатура оставляют мало места результатам.
- Цель: B.

### 7. Onboarding City/ZIP autocomplete

- `pages/auth/OnboardingPage.tsx:279-295`.
- Сейчас: debounced endpoint, absolute listbox под input в normal-flow auth card.
- Mobile UX: лучше, чем fixed sheet, но нижние suggestions всё равно оказываются за
  клавиатурой; это настоящий select-from-results flow.
- Цель: B.

### 8. Area code/city combobox

- `components/telephony/AreaCodeCombo.tsx:139-187`, используется через
  `NumberSearch.tsx:136`.
- Контексты: buy-number panel `PhoneNumbersPage.tsx:341`; telephony setup
  `TelephonyTwilioSettingsPage.tsx:448`.
- Сейчас: локально отфильтрованный listbox absolute под `FloatingField`.
- Mobile UX: в buy-number panel результаты ограничены fixed sheet + keyboard.
- Цель: B.

### 9. Inspector status picker

- `components/settings/InspectorSettingsPanel.tsx:49-123`, search input на `:96`;
  компонент вызван дважды для job и lead statuses.
- Сейчас: filterable checkbox list в shared Popover; на mobile Popover уже превращается в
  `BottomSheet`, но keyboard inset у sheet отсутствует.
- Цель: B; один reusable full-screen multi-select search.

### 10. Price Book group: Add an item

- `pages/PriceBookPage.tsx:487-549`, trigger на `:545`.
- Сейчас: debounced `listItems`, до 8 результатов в absolute dropdown внутри group panel.
- Mobile UX: нижний input в длинном panel и results под ним попадают под клавиатуру.
- Цель: B.

### Не входит в mobile B total

- `components/softphone/SoftPhoneWidget.tsx:74` + `ContactSearchDropdown.tsx`: настоящий
  contact combobox, но `AppLayout.tsx:46,259` не рендерит softphone при `isMobile` или
  `useIsMobileDevice()` (coarse pointer). Это чисто desktop surface.
- `components/settings/MarketplaceBrowser.tsx:58,147`: production call-site не найден;
  текущий `IntegrationsPage` использует `MarketplaceGrid`.
- List-page searches (Jobs, Leads, Contacts, Pulse, Tasks, Estimates, Invoices и т. п.)
  фильтруют основной экран и не открывают selectable dropdown, поэтому это A-simple /
  `уже-ок`, не B.

## Приоритеты

Порядок по частоте и ущербу на mobile:

1. **Заметка ADD/EDIT — DONE.** `NotesSection` уже открывает оба mobile ввода через
   `NoteComposerOverlay`; сохранить как regression reference.
2. **P0 regression — payment “Customer email”.** `ManualCardDialog.tsx:262`: известный
   owner repro, но в текущем source поле уже использует A-wrapper `FloatingTextField`.
   Новой реализации не требует; сохранить как второй regression reference после заметок.
3. **P0 — Estimate/Invoice item picker.** Один B-компонент закрывает четыре наиболее
   частых финансовых call-sites; текущий absolute dropdown практически несовместим с
   клавиатурой в bottom sheet.
4. **P1 — contact/address B flows.** `NewJobDialog` contact search, четыре trigger-поля
   `CreateLeadDialog`, shared `AddressAutocomplete` во всех entity panels.
5. **P1 — частые entity forms.** Create/Edit Lead, New Job, Edit Contact, estimate/invoice
   line-item/summary dialogs, Collect/Record/Refund/Void payment.
6. **P1 — рабочие composers.** Pulse SMS/email, legacy Messages, Email compose/reply,
   Feedback: эти поля находятся в viewport-height flex/fixed панелях и используются дольше,
   чем обычное однострочное поле.
7. **P2 — schedule/task operations.** Provider B-picker, mobile schedule search sheet,
   Time Off, Task, On-the-way, New Job from slot.
8. **P3 — admin/settings.** Inspector, telephony buy/port/A2P, company/users/integration
   dialogs, Rate Me/Rely, super-admin.

## Сомнительные и desktop-only поверхности

Следующие source inputs просмотрены, но не включены в mobile totals:

| Поверхность | Почему не в mobile inventory |
|---|---|
| `components/softphone/SoftPhoneWidget.tsx:74` | Явно не рендерится на mobile/coarse pointer. |
| `components/contacts/AddressCard.tsx:74` | Production call-site/import не найден; используемый Pulse-вариант живёт в `PulseContactHelpers`. |
| `components/schedule/SlotContextMenu.tsx:84` | Production call-site не найден; если компонент вернут, его mobile branch — BottomSheet и поле будет A. |
| `components/settings/MarketplaceBrowser.tsx:58,147` | Production call-site не найден; активная страница использует `MarketplaceGrid`. |
| `components/documents/TemplateStructure.tsx:750,818,872,905`; `pages/DocumentTemplateEditorPage.tsx:342` | Desktop-oriented document designer; mobile entry point/contract не найден. |
| `pages/telephony/CallFlowBuilderPage.tsx:706,784` и `nodeInspectors.tsx` | Canvas/inspector builder desktop-oriented; mobile contract не найден. |
| `pages/workflows/WorkflowBuilderPage.tsx:937`, `workflowInspectors.tsx`, `components/workflows/PublishDialog.tsx:69` | Canvas/inspector builder desktop-oriented; mobile contract не найден. |
| Desktop duplicate searches: `JobsPage.tsx:134`, `LeadsPage.tsx:173`, `TasksPage.tsx:315`, `ScheduleToolbar.tsx:18` | Их страницы явно выбирают отдельные mobile bars; mobile версии учтены. |
| `components/shared/NotesSection.tsx:285,471` | Desktop ADD/EDIT branches; mobile counterparts на `:381,:409` учтены как DONE. |
| `FloatingSelect`, native select, date/time, file, checkbox/radio/color | Не открывают текстовую software keyboard; это другой класс mobile UX. |
| Stripe Payment Element внутри `ManualCardDialog` | Hosted iframes, не app-owned `<input>`; этот аудит фиксирует только доступный frontend source. |

## Итоговые количества

- **A-simple: 204**
- **A-textarea: 51**
- **B-combobox: 13 input-trigger шаблонов в 10 реализациях**

Итого: **268 mobile-reachable текстовых input-шаблонов** в выбранной методике.
Динамические формы (`×N`) могут отрисовать больше DOM-полей; итог намеренно считает
source templates, чтобы инвентарь оставался воспроизводимым.
