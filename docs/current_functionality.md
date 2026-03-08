# Текущий функционал — Blanc Contact Center

Подробное описание текущей реализации разделов **Pulse**, **Softphone**, **Contacts**, **Leads** и **Jobs**.

---

## 1. Pulse (`/pulse`)

Основной рабочий экран оператора. Три колонки: список контактов → карточка лида/контакта → хронология коммуникаций.

### 1.1 Левая колонка — Список контактов

| Возможность | Описание |
|---|---|
| **Поиск** | Server-side поиск по номеру телефона с debounce (300 мс) |
| **Infinite scroll** | Подгрузка контактов по мере прокрутки через `IntersectionObserver` |
| **Отображение** | Имя компании → имя лида → имя контакта → отформатированный номер (приоритет); вторичный номер; время последнего взаимодействия (relative «2h ago» + абсолютное) |
| **Иконки взаимодействия** | SMS inbound (синяя), SMS outbound (фиолетовая), звонок inbound/outbound/internal; цвет зависит от статуса (`completed` = зелёный, `no-answer` = красный и т.д.) |
| **Unread индикатор** | Синяя полоска слева (3px) при наличии непрочитанных сообщений/звонков |
| **Action Required бейдж** | Оранжевый бейдж «Action Required» с причиной (`New message`, `New call`, `Manual`, `Estimate approved`, `Time confirmed`) |
| **Snoozed бейдж** | Серый бейдж с часами «Snoozed until …» |
| **Open task due** | Красная метка «Due HH:MM» при наличии задачи с дедлайном |
| **Контекстное меню (3-dot)** | Только на активном элементе: «Mark as Unread», «Action Required», «Mark Handled», «Snooze…» (30 мин / 2 часа / Tomorrow 9 AM / конкретная дата) |
| **Click → навигация** | Переход на `/pulse/timeline/:id`; автоматическая пометка как «прочитано» (timeline + SMS conversation) |
| **Дедупликация** | Контакты дедуплицируются по цифрам номера, чтобы SMS-only и call-only записи не дублировались |

### 1.2 Средняя колонка — Карточка контакта/лида (400px)

**Сверху: Action Required header bar** (если активен):
- Бейдж «Action Required» или «Snoozed»
- Кнопки: «Handled», «Snooze» (с подменю), «Assign» (выбор из состава команды)

**Три варианта содержимого:**

1. **LeadDetailPanel** — если по номеру найден лид (полная карточка лида с действиями)
2. **PulseContactPanel** — если контакт есть, но лида нет (карточка контакта, список связанных лидов/jobs, адреса)
3. **CreateLeadJobWizard** — если нет ни контакта, ни лида (форма создания нового лида/джоба из звонка)

### 1.3 Правая колонка — Хронология и SMS

#### Timeline (`PulseTimeline`)
- Объединённая хронология звонков и SMS, сортированная хронологически
- **Date separators**: «Today», «Yesterday», или полная дата (в таймзоне `America/New_York`)
- Автоскролл к последнему событию при загрузке или смене контакта

#### Звонки (`PulseCallListItem`)
- Направление (inbound/outbound/internal), статус с цветом
- Длительность, время звонка
- **Аудиоплеер**: play/pause, перемотка, полоса прогресса — для записей разговоров
- **Транскрипция**: развернуть/свернуть текст транскрипции; статус (`processing`, `completed`)
- **AI-summary**: Gemini-generated саммари разговора
- **Sentiment**: эмодзи + цвет по шкале от -1 до +1
- Живая транскрипция: обновление через SSE (transcript delta/finalized)

#### SMS (`SmsListItem`)
- Bubble-стиль: inbound (серый, слева), outbound (синий, справа)
- Delivery status: Sent, Delivered, Read, Failed, Undelivered
- **MMS вложения**: превью картинок, скачивание файлов
- Время в формате часового пояса компании

#### Форма отправки SMS (`SmsForm`)
- Textarea с поддержкой `⌘+Enter` для отправки
- **Quick Messages**: предустановленные шаблоны с переменными `{Field Name}` (резолвятся из данных лида)
- **AI Polish** (Wand2): кнопка для улучшения текста через Gemini API
- **Прикрепление файлов**: выбор файла, отображение имени/размера, удаление
- **Счётчик символов**: подсветка красным при превышении 1600 символов
- **Выбор номера получателя**: если у лида два номера, dropdown для выбора (main / secondary)
- Создание новой SMS-conversation при отсутствии существующей (через `startConversation`)

### 1.4 Real-time обновления (SSE)
- `onCallUpdate`: обновление списка контактов и таймлайна при изменении статуса звонка
- `onCallCreated`: рефетч списка контактов
- `onMessageAdded`: рефетч контактов и таймлайна (SMS inbound/outbound)
- `onContactRead`: рефетч контактов
- **Action Required events**: `thread.action_required`, `thread.handled`, `thread.snoozed`, etc.
- **Транскрипция**: `onTranscriptDelta` (live), `onTranscriptFinalized` (готово)

---

## 2. Softphone

Встроенный VoIP-телефон на базе Twilio Device SDK. Не блокирует UI — можно продолжать работать во время звонка.

### 2.1 Состояния

| Состояние | UI | Действия |
|---|---|---|
| **Idle** | Поле ввода номера/поиска + кнопка «Call» | Ввод номера, поиск контакта, выбор Caller ID |
| **Incoming** | Номер + имя + «Incoming Call» | Accept / Decline |
| **Connecting** | Номер + «Connecting…» | End Call |
| **Ringing** | Номер + «Ringing…» | End Call |
| **Connected** | Номер + таймер `M:SS` | Mute/Unmute, DTMF-клавиатура, End Call |
| **Ended** | «Call Ended» | — |
| **Failed** | «Call Failed» + ошибка | — |

### 2.2 Ключевые функции

- **Caller ID picker**: dropdown с Blanc-номерами (`/api/voice/blanc-numbers`); выбор номера, с которого звонит оператор
- **Поиск контактов** (`ContactSearchDropdown`): debounce 500 мс, поиск в contacts API, отображение каждого номера как отдельной строки (Primary/Secondary)
- **Pre-flight busy check**: перед звонком GET `/api/voice/check-busy?phone=…` — проверка, не занят ли номер (ошибка на 5 сек)
- **Auto-resolve contact name**: при звонке без выбранного контакта — запрос `/api/pulse/timeline-by-phone` для получения имени
- **Minimize**: при активном звонке можно свернуть в header-панель; при idle — кнопка «Close»
- **DTMF keypad**: grid 3×4, отправка тонов в активный звонок
- **Mute/Unmute**: переключение микрофона

### 2.3 Интеграция с другими разделами

- **ClickToCallButton**: кнопка «Call» рядом с номерами в Contacts, Leads, Jobs → открывает SoftPhone с предзаполненным номером
- **OpenTimelineButton**: кнопка «Message» рядом с номерами → переход на `/pulse/timeline/:id` (создаёт timeline при необходимости)
- **SoftPhoneContext**: глобальный контекст для pending запросов (click-to-call), active call contact, openDialer

---

## 3. Contacts (`/contacts`)

Master list — двухколоночный layout: список контактов + детальная панель.

### 3.1 Список контактов (`ContactsList`)
- **Server-side поиск** по имени, номеру, email
- **Pagination**: кнопки Prev/Next, по 50 записей на страницу
- Каждый контакт: аватар (иконка User), полное имя, номер телефона или email
- Выделение активного контакта (голубой фон)
- URL обновляется при выборе: `/contacts/:contactId`

### 3.2 Детальная панель (`ContactDetailPanel`)

#### Секции:
1. **Contact Info**: полное имя, телефон (основной + доп.), email, компания
   - Рядом с телефоном: `ClickToCallButton` + `OpenTimelineButton`
   - Кнопка «Edit Contact» → `EditContactDialog`
2. **Addresses**: список адресов с inline-редактированием (address, unit, city, state, zip)
   - Geocoding через Google Places API (`AddressAutocomplete`)
   - `saveEdit` → PATCH `/api/contacts/:id/addresses/:index`
3. **Leads**: список привязанных лидов со статусом (цветной бейдж), датой, типом, источником
   - Клик → переход на `/leads/:serialId`
4. **Jobs** (`JobsList` subcomponent): список привязанных job'ов, загружаются динамически по `contact_id`
   - Отображение: дата, тип, статус (цветной бейдж), провайдер

#### Zenbooker интеграция:
- **Create in Zenbooker**: создание контакта в Zenbooker (если feature flag включён)
- **Sync to Zenbooker**: синхронизация существующего контакта с Zenbooker
- Отображение Zenbooker client ID и ссылки на Zenbooker

---

## 4. Leads (`/leads`)

Управление лидами — таблица с фильтрами + детальная панель + диалоги.

### 4.1 Фильтры (`LeadsFilters`)
- **Текстовый поиск** (клиентский): имя, компания, телефон, email, Serial ID + searchable metadata fields
- **Дата**: date range picker (start/end) с API-загрузкой
- **Only Open toggle**: фильтрация только активных лидов (по умолчанию ON)
- **Status multi-select**: фильтрация по статусу
- **Source multi-select**: фильтрация по источнику (client-side)
- **Job Type multi-select**: фильтрация по типу работы (client-side)

### 4.2 Таблица (`LeadsTable`)
- Настраиваемые колонки через `ColumnSettingsDialog` (сохраняется в `localStorage`)
- Колонки по умолчанию (`DEFAULT_COLUMNS`): Serial ID, Name, Status, Phone, Email, Job Source, Job Type, Date, Comments
- **Pagination**: Prev/Next, по 100 записей
- Клик по строке → загрузка полной детализации через API

### 4.3 Детальная панель (`LeadDetailPanel`)

#### Header:
- Имя + компания + Zenbooker ссылка
- Кнопки: Edit, More menu (Mark Lost, Delete)
- Телефон + `ClickToCallButton` + `OpenTimelineButton`

#### Actions:
- **Status dropdown**: изменение статуса лида (inline API call)
- **Source dropdown**: выбор источника из списка (Website, Referral, Google Ads…)
- **Comments**: inline-редактирование, auto-save при blur

#### Секции:
- **Contact Info**: телефон, 2-й телефон, email, адрес (full)
- **Service Info**: job type, description, scheduled date
- **Metadata**: динамические поля из конфигурации лид-формы (`CustomFieldDef`)
- **Actions**: Mark Lost / Activate (toggle), Convert to Job, Delete

### 4.4 Создание лида (`CreateLeadDialog`)
- Многоступенчатая форма: контактные данные → адрес → детали заказа → метаданные
- **Contact deduplication**: при вводе имени/телефона/email — поиск существующих контактов, предложение привязки
- **Address autocomplete**: Google Places
- **Custom fields**: загружаются из `/api/settings/lead-form`
- **Job types / Sources**: списки из конфигурации

### 4.5 Конвертация в Job (`ConvertToJobDialog`)
- 4-шаговый wizard:
  1. **Customer & Address**: данные клиента, выбор адреса
  2. **Service**: тип услуги, описание
  3. **Timeslot**: выбор даты и времени (с доступными слотами из Zenbooker)
  4. **Review & Confirm**: сводка + подтверждение бронирования
- Создание заказа в Zenbooker через API

---

## 5. Jobs (`/jobs`)

Управление заказами (связь с Zenbooker) — таблица с фильтрами + двухколоночная детальная панель.

### 5.1 Фильтры (`JobsFilters`)
- **Текстовый поиск**: по всем полям (client-side)
- **Date range**: date range picker с пресетами (Today, Last 7 days, Last 30 days, etc.)
- **Only Open toggle**: только активные заказы
- **Status multi-select**: фильтрация по Zenbooker-статусу
- **Provider multi-select**: по провайдеру
- **Source multi-select**: по источнику
- **Job Type multi-select**: по типу работы
- **Tag multi-select**: по тегам

### 5.2 Таблица (`JobsTable`)
- Настраиваемые колонки через header settings
- **Сортировка**: по колонкам (sort by + sort order)
- **Pagination**: с отображением `offset + 1 – offset + count of totalCount`, Prev/Next
- Клик → загрузка деталей + контактной информации

### 5.3 Header (`JobsHeader`)
- Название «Jobs» + кнопка Refresh
- **CSV Export**: выгрузка всех matching заказов (все страницы, не только текущую)
- **Column settings**: drag-and-drop настройка видимых колонок

### 5.4 Детальная панель (`JobDetailPanel`)

Двухколоночный layout (desktop):

**Левая половина:**
- **Header** (`JobDetailHeader`): ID заказа, контакт (имя, телефон, email + `ClickToCallButton` + `OpenTimelineButton`), кнопка закрытия, мобильный toggle для notes
- **Action Bar** (`JobActionBar`): кнопки статуса — Mark Enroute, Mark In Progress, Mark Complete, Cancel
- **Info Sections** (`JobInfoSections`): дата/время, адрес, тип, источник, провайдер, стоимость, длительность, описание

**Правая половина (desktop only):**
- **Status & Tags** (`JobStatusTags`): Blanc-статус (dropdown), теги с multi-select (список из API)
- **Description**: описание заказа
- **Comments**: комментарии
- **Metadata** (`JobMetadataSection`): Zenbooker metadata (ID, booking ID, etc.)
- **Notes** (`JobNotesSection`):
  - Список заметок (JobNotesList) — хронологический список
  - Форма добавления новой заметки (JobAddNote) — textarea + кнопка

### 5.5 Действия над заказом (`useJobsActions`)
- **Blanc Status Change**: обновление внутреннего статуса через API
- **Add Note**: добавление заметки к заказу
- **Mark Enroute / In Progress / Complete / Cancel**: изменение статуса Zenbooker через API
- **Tags Change**: управление тегами заказа

---

## Общие паттерны

| Паттерн | Описание |
|---|---|
| **Аутентификация** | `authedFetch` — обёртка над `fetch` с автоматическим добавлением auth headers |
| **Real-time** | SSE (Server-Sent Events) через `useRealtimeEvents` hook |
| **Навигация** | React Router v6; URL-deep-linking (выбранный контакт/лид/job отражается в URL) |
| **Уведомления** | `sonner` (toast) для success/error/warning |
| **UI библиотека** | Shadcn/ui (Button, Input, Badge, Dialog, DropdownMenu, Skeleton, etc.) |
| **Иконки** | Lucide React |
| **Timezone** | Всё нормализуется к `America/New_York` |
| **Data fetching** | React Query (`useQuery`, `useInfiniteQuery`) для Pulse; прямые fetch-вызовы для остальных разделов |
