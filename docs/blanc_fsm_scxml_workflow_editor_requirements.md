---
doc: "Blanc Admin — Workflow Editor (SCXML) + Live Graph Preview"
version: "1.0"
status: "requirements"
owners:
  product: "Blanc"
  engineering: "FSM/Platform"
stack:
  frontend: "React 19 + TypeScript + Vite"
  backend: "Node.js + Express + PostgreSQL"
  auth: "Keycloak"
  deploy: "Fly.io (Docker)"
dependencies:
  editor: "Monaco Editor"
  diagram_render: "state-machine-cat (inpage preview + optional server render)"
  cli: "smcat (state-machine-cat CLI) + optional graphviz"
feature_flags:
  - "fsm_editor_enabled"
  - "fsm_publishing_enabled"
rbac_roles:
  - "fsm.viewer"
  - "fsm.editor"
  - "fsm.publisher"
  - "fsm.override" # manual status change bypass/override
---

# 1) Цель

Сделать **прозрачное управление статусными моделями** (Lead, Job) без построения “системы управления жизненным циклом с нуля”:
- хранение модели в **SCXML** (источник истины),
- **Live-превью** графа (вершины/переходы) прямо в админке,
- возможность добавлять:
  - новые статусы (states),
  - разрешённые переходы (transitions),
  - “горячие кнопки” (UI actions) для выполнения переходов,
- версионирование, валидация, публикация,
- генерация диаграмм через CLI для CI/локально (`smcat`).

---

# 2) Нефункциональные требования

## 2.1. Безопасность
- SCXML используется **как декларативная схема**.
- В runtime запрещены/игнорируются исполняемые конструкции SCXML (например, `<script>`, `<invoke>`, `<send>` и т.п.).
- Валидация должна блокировать публикацию, если найдено что-то вне “разрешённого подмножества”.

## 2.2. Производительность
- Live preview обновляется с debounce (рекомендуемо: 250–400 ms; по умолчанию 300 ms).
- Диаграмма должна рендериться < 300 ms на типичных схемах (до ~100 состояний, до ~300 переходов).
- Рендер ошибок — мгновенно (без “подвисаний” редактора).

## 2.3. Аудит и контроль
- Любое сохранение/публикация логируется: кто, когда, что изменил (как минимум: новая версия SCXML + комментарий).
- Есть “Active (Published)” версия и “Draft”.

---

# 3) Сущности и данные

## 3.1. FSM Machine
Объект: “машина состояний” для конкретного типа сущности.
- `machine_key`: `"lead"` | `"job"` | (в будущем: любое)
- `title`: "Lead FSM", "Job FSM"
- `description`
- `active_version_id`

## 3.2. FSM Version
Версия SCXML и метаданных.
- `version_id`
- `machine_key`
- `version_number` (int) или `semver` (string)
- `status`: `draft` | `published` | `archived`
- `scxml_source` (text)
- `created_by`, `created_at`
- `published_by`, `published_at`
- `change_note` (text)

## 3.3. UI Actions (горячие кнопки)
Источник истины по кнопкам — SCXML + расширение Blanc metadata (см. раздел 4).
- кнопка = transition с `event`, помеченный `blanc:action="true"` или блоком `<blanc:ui ... />`.
- если кнопки нет — переход может существовать (разрешён), но не показываться в карточке.

---

# 4) SCXML “подмножество” + расширение Blanc

## 4.1. Разрешённые элементы SCXML (MVP)
- `<scxml ... initial="...">`
- `<state id="...">`
- `<final id="...">`
- `<transition event="..." target="...">`

Запрещено (MVP): `<script>`, `<onentry>`, `<onexit>`, `<parallel>`, `<history>`, `<invoke>`, `<send>`, `<datamodel>` и т.д.

## 4.2. Blanc metadata namespace (для UI и прав)
В корневом `<scxml>` добавляем namespace:
- `xmlns:blanc="https://blanc.app/fsm"`

### 4.2.1. Метаданные на transition (кнопки)
Переход может содержать атрибуты:
- `blanc:action="true|false"` — показывать кнопку в карточке
- `blanc:label="..."` — текст кнопки
- `blanc:icon="..."` — имя иконки (условный набор: `check`, `phone`, `wrench`, `truck`, `clock`, `x`, ...)
- `blanc:hotkey="..."` — напр. `Shift+S`
- `blanc:confirm="true|false"` и `blanc:confirmText="..."`
- `blanc:roles="fsm.editor,fsm.override,..."` — кто видит/может нажимать
- `blanc:order="10"` — сортировка кнопок в карточке

> Если `blanc:action!="true"`, переход остаётся разрешённым, но кнопка не отображается.

---

# 5) Runtime поведение (применение событий)

## 5.1. Применение перехода по event
- В карточке сущности кнопка вызывает: `POST /api/fsm/{machine_key}/apply`
- Payload: `{ entityId, event }`
- Backend:
  1) Берёт активную опубликованную версию SCXML,
  2) Находит текущее состояние сущности,
  3) Проверяет, есть ли transition из этого состояния с данным `event`,
  4) Если есть — переводит в `target`,
  5) Пишет audit log.

## 5.2. Ручная смена статуса (override)
Требование “если кнопки нет — можно вручную переключить статус” реализуем так:
- Для ролей без `fsm.override`: только кнопки (и только разрешённые переходы).
- Для `fsm.override`:
  - доступна секция “Manual status change”
  - можно установить любой статус напрямую (с подтверждением),
  - логируется как override (отдельный тип события).

---

# 6) Админка: Workflow Editor (SCXML + Live Diagram)

## 6.1. Навигация
Раздел админки: **Admin → Workflows**
- список машин: Lead, Job, (в будущем — другие)
- статус: Active version, Draft exists?

## 6.2. Экран: “Workflow Editor”
### Основной layout (Desktop 1440+)
- Верхний toolbar (фиксированный)
- Контент: split-view 2 колонки
  - слева: Monaco (SCXML)
  - справа: Diagram preview (SVG)

### Toolbar (слева направо)
- Breadcrumb: `Admin / Workflows / {Lead FSM}`
- Machine selector (dropdown): Lead | Job | ...
- Version selector:
  - Active: `v12 (published)`
  - Draft: `draft`
  - View history (opens modal)
- Buttons:
  - **Validate** (runs validation, shows results panel)
  - **Save Draft**
  - **Publish** (only `fsm.publisher`, requires confirm + change note)
  - **Revert Draft** (discard changes -> last saved draft)
  - **Export** (download SCXML)
  - **Copy** (copy SCXML)
- Status pill: `Draft has changes` / `Valid` / `Has errors`

### Left pane: Monaco (SCXML)
- Syntax highlighting: XML
- Line numbers, minimap on
- “Problems” panel (bottom): errors/warnings from validation
- Автосохранение:
  - Опция (toggle): Off by default
  - Если On: сохранять draft каждые N секунд при отсутствии ошибок парсинга

### Right pane: Diagram Preview (SVG)
- Заголовок: “Diagram Preview”
- Контролы:
  - Zoom - / +
  - Fit to screen
  - Toggle labels: show/hide event labels
  - Download SVG
- Canvas:
  - рендерит SVG из SCXML
  - pan/zoom (mouse wheel + drag)
- Ошибки:
  - если SCXML не парсится/не валиден — показывать error overlay (без падения)

### Live preview behavior
- onChange (Monaco) → debounce 300ms → render diagram
- если рендер успешен:
  - обновить SVG
  - очистить overlay
- если рендер упал:
  - показать overlay “Render error”
  - записать ошибку в Problems panel (если возможно — line/col)

---

# 7) UI в карточке Lead/Job: Hot Actions + Manual

## 7.1. Hot Actions блок (в карточке сущности)
- Заголовок: “Actions”
- Ряд кнопок (или 2 ряда), сортировка по `blanc:order`
- Кнопка показывается если:
  - текущий статус имеет transition с `event`,
  - transition помечен `blanc:action="true"`,
  - роль пользователя входит в `blanc:roles` (или `blanc:roles` отсутствует → по умолчанию разрешено редактору),
  - backend подтверждает, что event применим.

## 7.2. Manual status change (только `fsm.override`)
- Dropdown “Change status…”
- Подтверждение:
  - “This is an override. It bypasses allowed transitions.”
- Требуется comment (обязательное поле) для аудита.

---

# 8) Валидация SCXML (Publish-gate)

## 8.1. Ошибки (blocking)
- XML не парсится
- нет `initial`
- `initial` не существует среди `<state>/<final>`
- дубли `state id`
- transition target не существует
- transition без `event` (если это критично для твоей модели)
- обнаружены запрещённые элементы SCXML

## 8.2. Предупреждения (non-blocking)
- unreachable states (нет входящих путей)
- states без исходящих transitions (если не `<final>`)
- дубли событий `event` внутри одного state
- слишком длинные label/icon/hotkey значения

---

# 9) Backend API (Express)

## 9.1. Machines / Versions
- `GET /api/fsm/machines` → список (lead, job, ...)
- `GET /api/fsm/:machineKey/active` → активная опубликованная версия
- `GET /api/fsm/:machineKey/draft` → draft версия (или 404)
- `PUT /api/fsm/:machineKey/draft` → сохранить draft `{ scxml_source }`
- `POST /api/fsm/:machineKey/validate` → `{ scxml_source }` → `{ errors[], warnings[] }`
- `POST /api/fsm/:machineKey/publish` → publish draft `{ change_note }`

## 9.2. Runtime
- `POST /api/fsm/:machineKey/apply` → `{ entityId, event }`
- `POST /api/fsm/:machineKey/override` → `{ entityId, targetStateId, comment }`
- `GET /api/fsm/:machineKey/actions?state=Submitted` → вычислить доступные actions (для UI)

## 9.3. Diagram rendering (опционально)
MVP: preview рендерится в браузере (inpage).  
Опция/фолбек: серверный рендер (если браузерный рендер отключён/ломается):
- `POST /api/fsm/render` → `{ scxml_source }` → `{ svg }`
- Кэш: hash(scxml_source) → svg

---

# 10) PostgreSQL (минимальная схема)

## 10.1. Таблицы
- `fsm_machines(machine_key pk, title, description, active_version_id, created_at, updated_at)`
- `fsm_versions(version_id pk, machine_key fk, version_number, status, scxml_source, change_note, created_by, created_at, published_by, published_at)`
- `fsm_audit_log(id pk, machine_key, version_id, actor_id, actor_email, action, payload_json, created_at)`
- (опционально) `fsm_render_cache(hash pk, svg, created_at)`

---

# 11) CLI (локально/CI)

## 11.1. Зависимости
- `state-machine-cat` как devDependency (даёт CLI `smcat`)

## 11.2. Артефакты
- `./fsm/lead.scxml`
- `./fsm/job.scxml`
- outputs:
  - `./fsm/out/lead.svg`, `./fsm/out/lead.dot`
  - `./fsm/out/job.svg`, `./fsm/out/job.dot`

## 11.3. NPM scripts (пример)
```json
{
  "scripts": {
    "fsm:svg": "smcat -I scxml -T svg ./fsm/lead.scxml -o ./fsm/out/lead.svg && smcat -I scxml -T svg ./fsm/job.scxml -o ./fsm/out/job.svg",
    "fsm:dot": "smcat -I scxml -T dot ./fsm/lead.scxml -o ./fsm/out/lead.dot && smcat -I scxml -T dot ./fsm/job.scxml -o ./fsm/out/job.dot",
    "fsm:build": "npm run fsm:dot && npm run fsm:svg"
  }
}
```

---

# 12) Initial SCXML templates (Seed)

> Zenbooker интеграцию на этом этапе игнорируем (как ты попросил).  
> Главное — управляемый граф статусов/переходов + кнопки.

## 12.1. Lead FSM (seed)
```xml
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       version="1.0"
       initial="Submitted">

  <state id="Submitted">
    <transition event="TO_NEW" target="New" blanc:action="true" blanc:label="Mark as New" blanc:order="10"/>
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Mark Lost" blanc:confirm="true" blanc:order="90"/>
  </state>

  <state id="New">
    <transition event="TO_CONTACTED" target="Contacted" blanc:action="true" blanc:label="Contacted" blanc:order="10"/>
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Mark Lost" blanc:confirm="true" blanc:order="90"/>
  </state>

  <state id="Contacted">
    <transition event="TO_QUALIFIED" target="Qualified" blanc:action="true" blanc:label="Qualified" blanc:order="10"/>
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Mark Lost" blanc:confirm="true" blanc:order="90"/>
  </state>

  <state id="Qualified">
    <transition event="TO_PROPOSAL_SENT" target="Proposal Sent" blanc:action="true" blanc:label="Proposal Sent" blanc:order="10"/>
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Mark Lost" blanc:confirm="true" blanc:order="90"/>
  </state>

  <state id="Proposal Sent">
    <transition event="TO_NEGOTIATION" target="Negotiation" blanc:action="true" blanc:label="Negotiation" blanc:order="10"/>
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Mark Lost" blanc:confirm="true" blanc:order="90"/>
  </state>

  <state id="Negotiation">
    <transition event="TO_CONVERTED" target="Converted" blanc:action="true" blanc:label="Convert" blanc:confirm="true" blanc:order="10"/>
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Mark Lost" blanc:confirm="true" blanc:order="90"/>
  </state>

  <final id="Lost"/>
  <final id="Converted"/>

</scxml>
```

## 12.2. Job FSM (seed, updated manual transitions)
```xml
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       version="1.0"
       initial="Submitted">

  <state id="Submitted">
    <transition event="TO_FOLLOW_UP" target="Follow Up with Client" blanc:action="true" blanc:label="Follow up" blanc:order="10"/>
    <transition event="TO_WAITING_PARTS" target="Waiting for parts" blanc:action="true" blanc:label="Waiting for parts" blanc:order="20"/>
  </state>

  <state id="Waiting for parts">
    <transition event="TO_SUBMITTED" target="Submitted" blanc:action="true" blanc:label="Back to Submitted" blanc:order="10"/>
    <transition event="TO_FOLLOW_UP" target="Follow Up with Client" blanc:action="true" blanc:label="Follow up" blanc:order="20"/>
  </state>

  <state id="Follow Up with Client">
    <transition event="TO_WAITING_PARTS" target="Waiting for parts" blanc:action="true" blanc:label="Waiting for parts" blanc:order="10"/>
    <transition event="TO_VISIT_COMPLETED" target="Visit completed" blanc:action="false"/>
  </state>

  <state id="Visit completed">
    <transition event="TO_FOLLOW_UP" target="Follow Up with Client" blanc:action="true" blanc:label="Follow up" blanc:order="10"/>
    <transition event="TO_DONE" target="Job is Done" blanc:action="true" blanc:label="Job Done" blanc:confirm="true" blanc:order="90"/>
  </state>

  <final id="Job is Done"/>

</scxml>
```

---

# 13) Figma Make — UI инструкции (frames + components + interactions)

## 13.1. Frame: “Workflows List” (Desktop 1440)
**Цель:** выбрать машину и перейти в редактор.
- Header: “Workflows”
- Table columns: Machine | Active Version | Draft | Updated | Actions
- Row actions:
  - “Open Editor”
  - “View History”

## 13.2. Frame: “Workflow Editor” (Desktop 1440)
**Layout:**
- Top toolbar (height ~56)
- Below: split view (лево/право), splitter draggable
  - Left pane default 50%
  - Right pane default 50%

**Top toolbar content:**
- Breadcrumb + Title: “Admin / Workflows / Lead FSM”
- Dropdown: Machine selector
- Dropdown: Version selector (Published + Draft)
- Buttons (primary -> secondary order):
  - Validate
  - Save Draft
  - Publish (danger confirm modal, only for publisher)
  - Export
- Status pill: “Valid / Errors / Draft changed”

**Left pane (SCXML Editor):**
- Monaco editor area
- Bottom collapsible panel:
  - Tabs: Problems | Outline
  - Problems list shows (error/warn): message + line:col
- Footer microcopy: “Live preview updates automatically”

**Right pane (Diagram Preview):**
- Toolbar inside pane:
  - Zoom -, Zoom +, Fit
  - Toggle “Show event labels”
  - Download SVG
- Canvas:
  - shows SVG
  - supports pan (drag) + zoom (wheel)
- Error overlay state:
  - Title: “Can’t render diagram”
  - Shows short error + “See Problems” link

**Modals:**
- Publish modal:
  - Requires change note (textarea)
  - Confirm publish
- History modal:
  - List of versions
  - Actions: view, restore as draft, compare (optional later)

## 13.3. Component: “Actions block” (Entity Card)
**Purpose:** показывать горячие кнопки из текущего состояния.
- Header: “Actions”
- Buttons row (wrap):
  - label + optional icon
  - disabled state if backend says not allowed
- Secondary link/button: “Change status…” (visible only for role `fsm.override`)
- Manual change modal:
  - dropdown target status
  - required textarea “Reason”
  - confirm

## 13.4. Interaction notes
- Typing in Monaco updates preview after debounce 300ms
- Clicking problem item scrolls Monaco to line and highlights
- Publish updates “Active version” и инвалидирует кэши
- Export downloads current open version SCXML

---

# 14) Acceptance Criteria (MVP)
- Можно открыть Lead/Job FSM в админке, редактировать SCXML, видеть live preview графа.
- Validation показывает ошибки/предупреждения; publish запрещён при errors.
- Есть версии: Draft и Published; опубликованная версия используется runtime.
- Горячие кнопки в карточке сущности строятся из transitions с `blanc:action="true"`.
- Manual status change доступен только `fsm.override` и логируется.
- CLI `npm run fsm:build` генерирует SVG/DOT из SCXML.
