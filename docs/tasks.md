# Blanc Contact Center — Tasks

> FSM-001: FSM/SCXML Workflow Editor — Task Breakdown

---

## LQV2: Lead Qualifier v2 — AI Inbound Phone Assistant

**Feature:** VAPI assistant with full lead qualification, address validation, schedule booking, CRM creation
**Status:** implemented (deployed — assistant `30e85a87-9d7e-4694-828e-1fea7d10f3ef`; 42 Jest tests passing)
**Pending ops:** set `VAPI_TOOLS_SECRET` on Fly.io; deploy backend; assign profile `lead_qualifier_v2` to a call-flow `vapi_agent` node
**Related docs:**
- Requirements: `Docs/requirements.md#LQV2`
- Architecture: `Docs/architecture.md#LQV2`
- Spec: `Docs/specs/LQV2-lead-qualifier-v2-assistant.md`
- Test cases: `Docs/test-cases/LQV2-lead-qualifier-v2.md`
- Product spec: `voice-agent/assistants/lead-qualifier-v2-spec.md`

---

### TASK-LQV2-001: Backend — добавить `handleValidateAddress` в vapi-tools.js

**Цель:** Реализовать обработчик `validateAddress` tool call, использующий Google Maps Geocoding API для стандартизации адреса и извлечения исправленного zip.

**Файлы, которые можно менять:**
- `backend/src/routes/vapi-tools.js`
- `.env.example` (добавить `VITE_GOOGLE_MAPS_API_KEY`)

**Файлы, которые трогать нельзя:**
- `src/server.js` — монтирование уже есть, не трогать
- `backend/src/services/leadsService.js` — не менять сигнатуру
- `backend/src/db/serviceTerritoryQueries.js` — нет изменений в схеме

**Ожидаемый результат:**
- Функция `handleValidateAddress({ street, apt, city, state, zip })` добавлена в `vapi-tools.js`
- Делает GET запрос к `https://maps.googleapis.com/maps/api/geocode/json?address=...&key=VITE_GOOGLE_MAPS_API_KEY`
- При статусе `OK` возвращает `{ valid: true, standardized, correctedZip, lat, lng }`
- При ZERO_RESULTS / ошибке / отсутствии ключа — возвращает `{ valid: false }`, никогда не throws
- Диспатчер в роутере (`name === "validateAddress"`) вызывает новый обработчик
- TC-LQV2-012 – TC-LQV2-016 покрываются

**Зависимости:** Нет (параллельна TASK-LQV2-002)

**Статус:** done

---

### TASK-LQV2-002: Backend — добавить `handleCheckAvailability` в vapi-tools.js

**Цель:** Реализовать обработчик `checkAvailability` tool call, который через Blanc scheduleService получает доступные слоты расписания и форматирует их в человекочитаемые строки.

**Файлы, которые можно менять:**
- `backend/src/routes/vapi-tools.js`

**Файлы, которые трогать нельзя:**
- `backend/src/services/scheduleService.js` — добавить `getAvailableSlots` (новая функция)
- `src/server.js`

**Ожидаемый результат:**
- Функция `handleCheckAvailability({ zip, unitType, days })` добавлена
- Вызывает `scheduleService.getAvailableSlots(DEFAULT_COMPANY_ID, { days, slotDurationMin: 120, maxSlots: 3 })`
  (scheduleService читает dispatch_settings + booked items из БД)
- Форматирует до 3 ближайших слотов в `{ date, label, start, end }`, где `label` — *"Tuesday, June 10th between 10am and 1pm"* (ET timezone)
- При ошибке / пустом расписании — `{ slots: [], error: "..." }`, никогда не throws
- Диспатчер (`name === "checkAvailability"`) вызывает новый обработчик
- TC-LQV2-017 – TC-LQV2-021 покрываются

**Зависимости:** Нет (параллельна TASK-LQV2-001)

**Статус:** done

---

### TASK-LQV2-003: Backend — обновить `handleCreateLead` для LQV2 полей

**Цель:** Расширить существующий `handleCreateLead` поддержкой новых полей LQV2: `preferredSlot`, `addressValidated`, `escalationRequested`; обновить `buildCallSummary`; добавить retry логику.

**Файлы, которые можно менять:**
- `backend/src/routes/vapi-tools.js`

**Файлы, которые трогать нельзя:**
- `backend/src/services/leadsService.js` — сигнатура `createLead(fields, companyId)` не меняется

**Ожидаемый результат:**
- `handleCreateLead` принимает `preferredSlot`, `addressValidated`, `escalationRequested`
- `buildCallSummary` включает все поля: `Unit | Brand | Age | Problem | Fee agreed: Yes | Slot | Address validated | escalation_requested (если true)`
- `Age: unknown` если не передан
- `Slot: pending callback` если `preferredSlot` null/undefined
- Retry: при ошибке `createLead` — ждёт 2 секунды, повторяет 1 раз; после двух ошибок возвращает `{ success: false, error }`, HTTP 200
- TC-LQV2-022 – TC-LQV2-029, TC-LQV2-031 – TC-LQV2-032 покрываются

**Зависимости:** Нет (можно делать параллельно с TASK-LQV2-001 и 002)

**Статус:** done

---

### TASK-LQV2-004: Tests — написать `tests/routes/vapi-tools.test.js`

**Цель:** Покрыть все 34 тест-кейса из `Docs/test-cases/LQV2-lead-qualifier-v2.md` Jest тестами. Следовать паттернам из `tests/routes/vapi.test.js`.

**Файлы, которые можно менять:**
- `tests/routes/vapi-tools.test.js` (создать новый)

**Файлы, которые трогать нельзя:**
- `tests/routes/vapi.test.js` — не трогать существующие тесты
- Любые production файлы

**Ожидаемый результат:**
- Файл `tests/routes/vapi-tools.test.js` создан (+ `tests/services/scheduleService.getAvailableSlots.test.js` для slot-логики)
- Моки: `jest.mock` для `serviceTerritoryQueries`, `leadsService`, `scheduleService`, и `https` для Google Maps geocoding
- Тесты TC-LQV2-001 – TC-LQV2-033 реализованы
- Группы: middleware (001-004), dispatcher (005-007), checkServiceArea (008-011), validateAddress (012-016), checkAvailability (017-020), createLead (022a,022-029,029a), parallel tool calls (030), buildCallSummary (031-032), server mount (033)
- slot-логика: label-формат, one-slot-per-day, overlap-фильтрация, work_days/work_hours, custom dispatch_settings
- LLM-evaluation кейсы (TC-038–057: objections, NLP, FAQ, escalation, time-cutoff) — вне Jest, в `tests/prompts/*` (отдельный слой, не покрыт здесь)

**Зависимости:** TASK-LQV2-001, TASK-LQV2-002, TASK-LQV2-003 (тесты пишутся по итогу реализации)

**Статус:** done — 42 теста проходят (`tests/routes/vapi-tools.test.js` + `tests/services/scheduleService.getAvailableSlots.test.js`)

---

### TASK-LQV2-005: Voice Agent — создать `voice-agent/assistants/lead-qualifier-v2.json`

**Цель:** Собрать полный конфиг VAPI ассистента "Lead Qualifier v2" для деплоя через CLI / REST API. Включить все 4 tools, полный system prompt (FR-1 – FR-12), корректные `server.url` и `server.secret`.

**Файлы, которые можно менять:**
- `voice-agent/assistants/lead-qualifier-v2.json` (создать новый)

**Файлы, которые трогать нельзя:**
- `voice-agent/assistants/lead-qualifier-v1.json` — v1 остаётся активным до валидации v2
- `voice-agent/assistants/lead-qualifier-v2-spec.md` — это source of truth, только читать

**Ожидаемый результат:**
- Валидный JSON для VAPI REST API `POST /assistant`
- `name: "Lead Qualifier v2"`, `model.provider: "openai"`, `model.model: "gpt-4o"`, `model.temperature: 0.5`, `model.maxTokens: 400`
- `voice.provider: "azure"`, `voice.voiceId: "andrew"`
- `firstMessage: "Hi, this is Alex from ABC Homes Appliance Repair! How can I help you today?"`
- `firstMessageMode: "assistant-speaks-first"`
- `maxDurationSeconds: 900` (**обязательно** — 15 мин hard cap)
- `silenceTimeoutSeconds: 30`
- `endCallFunctionEnabled: true`
- `endCallMessage: "Thank you for calling ABC Homes Appliance Repair. Have a great day!"`
- System prompt полностью описывает поведение согласно FR-1 – FR-12 (из spec.md):
  - Persona: "Alex", company info (rating 4.9, partners, 5+ years)
  - Eligible/ineligible appliances lists
  - Всю conversation flow state machine (S0–S12)
  - FR-4 objection matrix (7 типов, 2-attempt limit)
  - FR-5 marketing triggers (FOMO, scarcity, social proof — без ограничений; time-limited offer ТОЛЬКО до 14:00 ET)
  - FR-6 NLP techniques (choice-without-choice, pacing, reframing, presuppositions, meta-model)
  - FR-11 FAQ answers
  - FR-11b escalation flow (1 retention attempt, затем callback)
  - FR-12 disqualification scripts
  - Current time injection: `{{now}}` variable для определения 14:00 ET cutoff
- 4 tools: `checkServiceArea`, `validateAddress`, `checkAvailability`, `createLead` — каждый с `server.url: "https://abc-metrics.fly.dev/api/vapi-tools"` и `server.secret: "{{VAPI_TOOLS_SECRET}}"`
- `metadata.slug: "lead_qualifier_v2"`, `metadata.stage: "2"`, `metadata.version: "2.0.0"`
- После создания файла — деплой: `curl -X POST https://api.vapi.ai/assistant -H "Authorization: Bearer $VAPI_API_KEY" -d @lead-qualifier-v2.json` и обновление секрета через PATCH

**Зависимости:** TASK-LQV2-001, TASK-LQV2-002, TASK-LQV2-003 (конфиг finaliz-ируется после имплементации tool handlers)

**Статус:** done

---

### TASK-LQV2-006: Ops — добавить env vars на Fly.io и в .env.example

**Цель:** Добавить `VITE_GOOGLE_MAPS_API_KEY` в `.env.example` и установить на Fly.io продакшн.

**Файлы, которые можно менять:**
- `.env.example`

**Файлы, которые трогать нельзя:**
- `fly.toml` — конфиг деплоя, только ops команды

**Ожидаемый результат:**
- `.env.example` содержит `VITE_GOOGLE_MAPS_API_KEY=your_google_maps_server_key_here`
- Fly.io: key already set as `VITE_GOOGLE_MAPS_API_KEY` — no action needed
- Примечание: ключ должен иметь разрешение только на Geocoding API, ограничен по IP до Fly.io VM

**Зависимости:** Нет (можно сделать первым)

**Статус:** done (key VITE_GOOGLE_MAPS_API_KEY exists; VAPI_TOOLS_SECRET still to set on Fly.io)

---

## Порядок выполнения LQV2

```
TASK-LQV2-006 (env vars)  ←── сначала
       │
       ▼
TASK-LQV2-001  ──┐
TASK-LQV2-002  ──┤  (параллельно)
TASK-LQV2-003  ──┘
       │
       ▼
TASK-LQV2-004 (tests)
       │
       ▼
TASK-LQV2-005 (assistant config + deploy)
```

---

## PF002-R2: Estimates Composer Refresh

**Feature:** Repair-focused estimate composer and lifecycle correction
**Status:** implemented
**Related docs:** `docs/requirements.md#PF002-R2`, `docs/architecture.md#PF002-R2`, `docs/specs/PF002-R2-estimates-composer-refresh.md`

### TASK-EST-R2-001: Migration — estimates schema alignment
**Status:** done
**Files to modify:**
- `backend/db/migrations/082_pf002_r2_estimates_refresh.sql`
**Expected result:**
- Add `summary`, discount type/value, archive fields, approved snapshot, signature fields, estimate sequence, item future fields.
- Status constraint supports `approved` and migrates existing `accepted` rows.
- Existing estimates/items remain readable.

### TASK-EST-R2-002: Backend queries — schema-correct CRUD/totals/archive
**Status:** done
**Dependencies:** TASK-EST-R2-001
**Files to modify:**
- `backend/src/db/estimatesQueries.js`
**Expected result:**
- No writes to missing columns.
- Items write `name` and `taxable`.
- List supports `includeArchived`.
- Totals use taxable subtotal minus discount.
- Archive/restore and item replace helpers exist.
- All estimate access remains company-scoped.

### TASK-EST-R2-003: Backend service — lifecycle validation and numbering
**Status:** done
**Dependencies:** TASK-EST-R2-002
**Files to modify:**
- `backend/src/services/estimatesService.js`
**Expected result:**
- Create/update resolve Lead/Job context, validate items/discounts, reset editable non-draft statuses to `draft`.
- Approve requires items and stores approved snapshot.
- Decline reason required.
- Archive/restore implemented.
- Send is a non-mutating stub.
- Convert requires `approved` and keeps estimate approved.

### TASK-EST-R2-004: Backend route — tenant context and new actions
**Status:** done
**Dependencies:** TASK-EST-R2-003
**Files to modify:**
- `backend/src/routes/estimates.js`
**Files not to modify:**
- `src/server.js` — route is already mounted with auth + tenant middleware.
**Expected result:**
- Route uses `req.companyFilter?.company_id || req.user?.company_id`, not `req.companyId`.
- Adds archive/restore and decline reason contracts.
- Send endpoint does not mutate status.

### TASK-EST-R2-005: Backend tests
**Status:** done
**Dependencies:** TASK-EST-R2-004
**Files to modify:**
- `tests/estimatesLifecycleR2.test.js`
- `tests/estimatesConvert.test.js`
**Expected result:**
- Service tests cover item schema, totals, approve snapshot, decline reason, archive/restore, send stub.
- Existing convert tests updated from `accepted` to `approved`.

### TASK-EST-R2-006: Frontend API contract
**Status:** done
**Dependencies:** TASK-EST-R2-004
**Files to modify:**
- `frontend/src/services/estimatesApi.ts`
**Expected result:**
- Types include `approved`, archive fields, summary, discount type/value, signature fields.
- API exposes archive/restore and decline reason.

### TASK-EST-R2-007: Frontend editor and preview
**Status:** done
**Dependencies:** TASK-EST-R2-006
**Files to modify:**
- `frontend/src/components/estimates/EstimateEditorDialog.tsx`
- `frontend/src/components/estimates/EstimatePreviewDialog.tsx`
**Expected result:**
- Editor uses Add custom item dialog, Summary flow, read-only Terms & Warranty, discount, signature toggle, disabled deposit.
- Preview modal renders client-facing document.

### TASK-EST-R2-008: Frontend detail/list/send integration
**Status:** done
**Dependencies:** TASK-EST-R2-007
**Files to modify:**
- `frontend/src/components/estimates/EstimateDetailPanel.tsx`
- `frontend/src/components/estimates/EstimateSendDialog.tsx`
- `frontend/src/pages/EstimatesPage.tsx`
- `frontend/src/hooks/useEstimates.ts`
- `frontend/src/components/leads/LeadFinancialsTab.tsx`
- `frontend/src/components/jobs/JobFinancialsTab.tsx`
**Expected result:**
- No global create on `/estimates`.
- Only Open / All filter controls archived visibility.
- Detail supports Preview, Decline reason, Archive/Restore, approved status.
- Send dialog is workflow-only and keeps status draft.

### TASK-EST-R2-009: Final documentation and verification
**Status:** done
**Dependencies:** TASK-EST-R2-008
**Files to modify:**
- `docs/changelog.md`
- `docs/project-spec.md`
**Expected result:**
- Changelog/project spec updated.
- Relevant Jest/frontend build checks run and results recorded.

### TASK-EST-R2-010: Backend PDF generation
**Status:** done
**Dependencies:** TASK-EST-R2-003
**Files modified:**
- `backend/src/services/estimatePdfService.js`
- `backend/src/services/estimatesService.js`
- `backend/src/routes/estimates.js`
- `frontend/src/components/estimates/EstimateDetailPanel.tsx`
- `tests/estimatePdfService.test.js`
**Expected result:**
- `GET /api/estimates/:id/pdf` returns `application/pdf` generated from the current estimate.
- PDF includes company header, customer/job context, Summary, items, totals, Terms & Warranty, and ACH payment details.
- Estimate detail includes a PDF action.

---

**Feature:** Database-driven FSM replacing hardcoded status constants
**Migration range:** 072–074
**Total tasks:** 30
**Phases:** 5

---

## Phase 1: Database & Parser Foundation

---

### TASK-001: Migration — fsm_machines, fsm_versions, fsm_audit_log tables
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/db/migrations/072_create_fsm_tables.sql` — CREATE TABLE fsm_machines, fsm_versions, fsm_audit_log with indexes, FK constraint from fsm_machines.active_version_id to fsm_versions.id
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/db/migrations/README.md` — do not rename existing migrations
**Acceptance criteria:**
- [ ] `fsm_machines` table created with columns: id, machine_key, company_id (FK to companies), title, description, active_version_id, created_at, updated_at
- [ ] UNIQUE constraint on (company_id, machine_key)
- [ ] `fsm_versions` table created with columns: id, machine_id (FK to fsm_machines ON DELETE CASCADE), company_id (FK to companies), version_number, status (CHECK 'draft'/'published'/'archived'), scxml_source, change_note, created_by, created_at, published_by, published_at
- [ ] `fsm_audit_log` table created with columns: id, company_id, machine_key, version_id, actor_id, actor_email, action, payload_json (JSONB), created_at
- [ ] All indexes from architecture spec created (idx_fsm_machines_company, idx_fsm_versions_machine, idx_fsm_versions_company, idx_fsm_versions_status, idx_fsm_audit_company, idx_fsm_audit_machine, idx_fsm_audit_created)
- [ ] Migration runs without errors on a fresh DB with existing `companies` table
**Related test cases:** TC-FSM-008 (data isolation depends on schema)

---

### TASK-002: Migration — FSM permission roles
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/db/migrations/074_add_fsm_permissions.sql` — INSERT fsm.viewer, fsm.editor, fsm.publisher, fsm.override into role_permissions
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/middleware/authorization.js` — existing requirePermission middleware already supports arbitrary permission keys
**Acceptance criteria:**
- [ ] `admin` role receives all four permissions: fsm.viewer, fsm.editor, fsm.publisher, fsm.override
- [ ] `manager` role receives only fsm.viewer
- [ ] ON CONFLICT DO NOTHING ensures idempotent reruns
- [ ] Migration runs without errors
**Related test cases:** TC-FSM-007

---

### TASK-003: Install backend dependency (fast-xml-parser)
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/package.json` — add `fast-xml-parser` dependency
**Files NOT to modify:**
- `frontend/package.json`
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `fast-xml-parser` added to `dependencies` (not devDependencies)
- [ ] `npm install` in backend directory succeeds
- [ ] Package version is latest stable (^5.x)
**Related test cases:** TC-FSM-001 (parser depends on this)

---

### TASK-004: SCXML parser service — parseSCXML, validateSCXML
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-003
**Files to modify:**
- `backend/src/services/fsmService.js` — NEW FILE: implement `parseSCXML(xml)` and `validateSCXML(xml)` functions using fast-xml-parser
**Files NOT to modify:**
- `backend/src/services/jobsService.js` — do not modify yet
- `backend/src/services/leadsService.js` — do not modify yet
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `parseSCXML(xmlString)` returns a ParsedGraph object with: `states` (Map of state id -> { id, label, statusName, transitions, isFinal }), `initialState` (string), `finalStates` (array), `metadata` ({ machine, title })
- [ ] Transitions parsed with all `blanc:*` namespace attributes: action (bool), label, confirm (bool), confirmText, roles (array), order (number), icon
- [ ] State `blanc:label` and `blanc:statusName` attributes extracted correctly
- [ ] `<final>` elements parsed with `isFinal: true`
- [ ] `validateSCXML(xmlString)` returns `{ valid: boolean, errors: [{line, col, message, severity}], warnings: [{...}] }`
- [ ] Forbidden elements rejected: `<script>`, `<invoke>`, `<send>`, `<onentry>`, `<onexit>`, `<parallel>`, `<history>`, `<datamodel>`
- [ ] Missing `initial` attribute on `<scxml>` root produces error
- [ ] Transition target referencing non-existent state produces error
- [ ] Unreachable states (no incoming transitions, not initial) produce warning
- [ ] Duplicate events in same state produce warning
- [ ] Malformed XML returns parse error
- [ ] Module exports: `parseSCXML`, `validateSCXML`
**Related test cases:** TC-FSM-001, TC-FSM-002, TC-FSM-003, TC-FSM-004, TC-FSM-020, TC-FSM-021, TC-FSM-030

---

### TASK-005: Seed SCXML files for reference
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `fsm/job.scxml` — NEW FILE: Job workflow SCXML matching ALLOWED_TRANSITIONS in jobsService.js exactly (7 states: Submitted, Waiting_for_parts, Follow_Up_with_Client, Visit_completed, Job_is_Done, Rescheduled, Canceled)
- `fsm/lead.scxml` — NEW FILE: Lead workflow SCXML (8 states: Submitted, New, Contacted, Qualified, Proposal_Sent, Negotiation, Lost, Converted)
**Files NOT to modify:**
- `backend/src/services/jobsService.js` — reference only, do not modify
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `fsm/job.scxml` is valid SCXML with `xmlns:blanc="https://blanc.app/fsm"`, `initial="Submitted"`, `blanc:machine="job"`, `blanc:title="Job Workflow"`
- [ ] All 7 job states present with correct transitions matching architecture spec
- [ ] All `blanc:confirm` and `blanc:confirmText` attributes present on Cancel transitions
- [ ] `fsm/lead.scxml` is valid SCXML with 8 lead states and correct transitions
- [ ] `<final>` used for terminal states (Canceled for jobs; Lost, Converted for leads)
- [ ] Both files pass `validateSCXML()` with zero errors
**Related test cases:** TC-FSM-001, TC-FSM-005

---

### TASK-006: Migration — seed initial published FSM versions for existing companies
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-001
**Files to modify:**
- `backend/db/migrations/073_seed_fsm_machines.sql` — DO $$ block that iterates over all companies, inserts fsm_machines rows for 'job' and 'lead', inserts fsm_versions with status='published' and version_number=1, updates active_version_id
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/db/migrations/072_create_fsm_tables.sql` — already created in TASK-001
**Acceptance criteria:**
- [ ] For every existing company: 2 fsm_machines rows (job, lead) created with ON CONFLICT DO NOTHING
- [ ] For each machine: 1 fsm_versions row with status='published', version_number=1, scxml_source matching seed SCXML from architecture spec
- [ ] `fsm_machines.active_version_id` updated to point to the published version
- [ ] created_by and published_by set to 'system'
- [ ] Migration is idempotent (ON CONFLICT DO NOTHING)
- [ ] SCXML content in SQL exactly matches the seed SCXML from Docs/architecture.md
**Related test cases:** TC-FSM-005, TC-FSM-008

---

## Phase 2: Backend API

---

### TASK-007: FSM service — machine CRUD and version reads
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-001, TASK-004, TASK-006
**Files to modify:**
- `backend/src/services/fsmService.js` — add functions: `listMachines(companyId)`, `getActiveVersion(companyId, machineKey)`, `getDraft(companyId, machineKey)`, `listVersions(companyId, machineKey)`
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/services/jobsService.js`
**Acceptance criteria:**
- [ ] `listMachines(companyId)` queries fsm_machines WHERE company_id=$1, joins fsm_versions for active_version info and has_draft boolean
- [ ] `getActiveVersion(companyId, machineKey)` returns published version with scxml_source, version_number, published_at, published_by
- [ ] `getDraft(companyId, machineKey)` returns draft version or null if none exists
- [ ] `listVersions(companyId, machineKey)` returns all versions sorted by version_number DESC
- [ ] All queries filter by company_id — data isolated between tenants
- [ ] Returns null/empty for non-existent machines (not error)
**Related test cases:** TC-FSM-008, TC-FSM-009, TC-FSM-012

---

### TASK-008: FSM service — draft management (saveDraft, publishDraft, restoreVersion)
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-007
**Files to modify:**
- `backend/src/services/fsmService.js` — add functions: `saveDraft(companyId, machineKey, scxml, userId, email)`, `publishDraft(companyId, machineKey, changeNote, userId, email)`, `restoreVersion(companyId, machineKey, versionId, userId, email)`, `logAudit(companyId, machineKey, versionId, actorId, actorEmail, action, payload)`, `invalidateCache(companyId, machineKey)`
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/services/jobsService.js`
**Acceptance criteria:**
- [ ] `saveDraft` validates SCXML first (returns 400 equivalent on errors), then upserts draft version; logs `save_draft` to fsm_audit_log
- [ ] `saveDraft` supports optimistic concurrency: if version_id provided and differs from current draft, throws conflict error
- [ ] `publishDraft` in a DB transaction: re-validates, archives current published, promotes draft to published with incremented version_number, updates fsm_machines.active_version_id, invalidates cache, logs `publish`
- [ ] `publishDraft` rejects if draft has validation errors (returns errors array)
- [ ] `restoreVersion` copies scxml_source from specified version into a new/updated draft; logs `restore`
- [ ] `logAudit` inserts into fsm_audit_log with payload_json
- [ ] `invalidateCache` clears in-memory parsed graph for (companyId, machineKey)
- [ ] In-memory graph cache: Map keyed by `${companyId}:${machineKey}`, stores ParsedGraph, invalidated on publish
**Related test cases:** TC-FSM-009, TC-FSM-010, TC-FSM-011, TC-FSM-024, TC-FSM-027

---

### TASK-009: FSM routes — read endpoints
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-007, TASK-002
**Files to modify:**
- `backend/src/routes/fsm.js` — NEW FILE: Express router with GET /machines, GET /:machineKey/active, GET /:machineKey/draft, GET /:machineKey/versions, GET /:machineKey/actions
**Files NOT to modify:**
- `src/server.js` (protected — mounting happens in TASK-012)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] `GET /machines` requires `fsm.viewer` permission via `requirePermission('fsm.viewer')`
- [ ] `GET /:machineKey/active` requires `fsm.viewer`
- [ ] `GET /:machineKey/draft` requires `fsm.editor`
- [ ] `GET /:machineKey/versions` requires `fsm.viewer`
- [ ] `GET /:machineKey/actions` requires any authenticated user (no additional permission)
- [ ] company_id obtained via `req.companyFilter?.company_id` (NOT req.companyId)
- [ ] All responses follow `{ ok: true, data: ... }` pattern
- [ ] Actions endpoint accepts `?state=X&roles=a,b` query params
- [ ] 404 returned for non-existent machines, not 500
**Related test cases:** TC-FSM-007, TC-FSM-008, TC-FSM-012, TC-FSM-022, TC-FSM-023, TC-FSM-031, TC-FSM-032

---

### TASK-010: FSM routes — write endpoints
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-008, TASK-009
**Files to modify:**
- `backend/src/routes/fsm.js` — add PUT /:machineKey/draft, POST /:machineKey/validate, POST /:machineKey/publish, POST /:machineKey/versions/:versionId/restore
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] `PUT /:machineKey/draft` requires `fsm.editor`, accepts `{ scxml_source }`, validates, upserts draft
- [ ] `POST /:machineKey/validate` requires `fsm.editor`, accepts `{ scxml_source }`, returns `{ valid, errors, warnings }`
- [ ] `POST /:machineKey/publish` requires `fsm.publisher`, accepts `{ change_note }`, promotes draft
- [ ] `POST /:machineKey/versions/:versionId/restore` requires `fsm.editor`, copies version as new draft
- [ ] 400 returned with error details when SCXML validation fails
- [ ] 409 returned on draft version conflict
- [ ] 404 returned when no draft exists for publish, or version not found for restore
- [ ] company_id from `req.companyFilter?.company_id`
- [ ] Empty change_note on publish returns 400
**Related test cases:** TC-FSM-009, TC-FSM-010, TC-FSM-011, TC-FSM-024, TC-FSM-027

---

### TASK-011: FSM runtime — resolveTransition, getAvailableActions, apply, override
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-008
**Files to modify:**
- `backend/src/services/fsmService.js` — add functions: `resolveTransition(companyId, machineKey, currentState, event)`, `getAvailableActions(companyId, machineKey, currentState, userRoles)`
- `backend/src/routes/fsm.js` — add POST /:machineKey/apply, POST /:machineKey/override
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/services/jobsService.js` — do not modify yet (Phase 4)
- `backend/src/services/leadsService.js` — do not modify yet (Phase 4)
**Acceptance criteria:**
- [ ] `resolveTransition` loads published graph from cache or DB, finds matching transition from currentState with given event, returns `{ valid: true, targetState }` using blanc:statusName or state id
- [ ] `resolveTransition` returns `{ valid: false }` for invalid event from current state
- [ ] `resolveTransition` falls back to hardcoded ALLOWED_TRANSITIONS when no published FSM exists
- [ ] `getAvailableActions` filters by blanc:action="true", filters by user roles (intersection with blanc:roles or no roles = visible to all), sorts by blanc:order
- [ ] `getAvailableActions` falls back to hardcoded constants when no published FSM
- [ ] `POST /:machineKey/apply` loads entity via jobsService/leadsService, validates transition, updates status, logs audit
- [ ] `POST /:machineKey/override` requires `fsm.override`, validates target state exists in SCXML, requires non-empty reason, updates status, logs audit
- [ ] Override rejects if target state equals current state (400)
- [ ] Override rejects if target state does not exist in published SCXML (400)
- [ ] Entity not found returns 404 (not 403 — data isolation)
**Related test cases:** TC-FSM-005, TC-FSM-006, TC-FSM-013, TC-FSM-014, TC-FSM-015, TC-FSM-016, TC-FSM-017, TC-FSM-018, TC-FSM-019, TC-FSM-022, TC-FSM-025, TC-FSM-026

---

### TASK-012: Mount FSM route in server.js + audit logging
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-009, TASK-010, TASK-011
**Files to modify:**
- `src/server.js` — add import for fsmRouter and mount line: `app.use('/api/fsm', authenticate, requireCompanyAccess, fsmRouter)` in the "Auth + tenant-scoped CRM API routes" section
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `frontend/src/hooks/useRealtimeEvents.ts` (protected)
**Acceptance criteria:**
- [ ] Only ONE new require/import line and ONE app.use() line added to server.js
- [ ] Route mounted in correct section (alongside other authenticated routes)
- [ ] No other changes to server.js
- [ ] `GET /api/fsm/machines` accessible with valid auth token
- [ ] `GET /api/fsm/machines` returns 401 without token
**Related test cases:** TC-FSM-007

---

## Phase 3: Frontend Editor

---

### TASK-013: Install frontend dependencies
**Phase:** 3
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `frontend/package.json` — add `@monaco-editor/react` and `state-machine-cat` as dependencies
**Files NOT to modify:**
- `backend/package.json`
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `@monaco-editor/react` added to dependencies
- [ ] `state-machine-cat` added to dependencies
- [ ] `npm install` in frontend directory succeeds
- [ ] Both packages importable in a .tsx file without type errors
**Related test cases:** TC-FSM-028, TC-FSM-029

---

### TASK-014: FSM API client hooks — useFsmEditor.ts, useFsmActions.ts
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-012
**Files to modify:**
- `frontend/src/hooks/useFsmEditor.ts` — NEW FILE: React Query hooks for editor operations (load draft, load active, save draft, validate, publish, list versions, restore)
- `frontend/src/hooks/useFsmActions.ts` — NEW FILE: React Query hooks for runtime (fetch available actions, apply transition, override)
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected — use it, don't modify)
- `frontend/src/hooks/useRealtimeEvents.ts` (protected)
**Acceptance criteria:**
- [ ] `useFsmEditor(machineKey)` provides: draft query, active query, saveDraft mutation, validate mutation, publish mutation, versions query, restore mutation
- [ ] All API calls use `authedFetch` with correct paths (`/api/fsm/...`)
- [ ] `useFsmActions(machineKey, currentState, roles)` provides: actions query, applyTransition mutation
- [ ] Override mutation in separate hook or export
- [ ] Proper React Query cache invalidation on save/publish/restore/apply
- [ ] Loading, error, and success states handled
- [ ] Types defined for API responses
**Related test cases:** TC-FSM-009, TC-FSM-013

---

### TASK-015: LeadFormSettingsPage — add Shadcn Tabs wrapper
**Phase:** 3
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `frontend/src/pages/LeadFormSettingsPage.tsx` — wrap existing content in Shadcn Tabs component, add "Workflows" tab trigger (gated by fsm_editor_enabled feature flag)
**Files NOT to modify:**
- `frontend/src/pages/LeadFormSettingsPage.css` — no CSS changes needed (Tabs component uses its own styles)
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Existing page content wrapped in `<Tabs defaultValue="settings">`
- [ ] `<TabsTrigger value="settings">Settings</TabsTrigger>` renders for all users
- [ ] `<TabsTrigger value="workflows">Workflows</TabsTrigger>` renders only when `fsm_editor_enabled` feature flag is true
- [ ] `<TabsContent value="settings">` contains all existing page content unchanged — no functional changes
- [ ] `<TabsContent value="workflows">` renders `<MachineList />` placeholder (or empty div until TASK-016)
- [ ] All existing functionality (Job Types, Metadata Fields, Job Tags, DnD) works exactly as before
**Related test cases:** SC-01 (spec scenario)

---

### TASK-016: MachineList component
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-014
**Files to modify:**
- `frontend/src/components/workflows/MachineList.tsx` — NEW FILE: list of FSM machines with active version badge and draft indicator; "Open Editor" action per machine
**Files NOT to modify:**
- `frontend/src/pages/LeadFormSettingsPage.tsx` — already has Workflows tab from TASK-015
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Fetches machines via `useFsmEditor` or direct `authedFetch` to `GET /api/fsm/machines`
- [ ] Renders each machine: title, description, active version number, published_at date, has_draft indicator
- [ ] "Open Editor" button/link per machine row
- [ ] Loading state while fetching
- [ ] Error state with retry button on fetch failure
- [ ] Empty state if no machines (unlikely but handled)
- [ ] Styling follows Blanc design system: `--blanc-line` borders, `rounded-xl`, no decorative elements
**Related test cases:** SC-01

---

### TASK-017: WorkflowEditor — Monaco editor pane
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-013, TASK-014
**Files to modify:**
- `frontend/src/components/workflows/WorkflowEditor.tsx` — NEW FILE: split-view layout with Monaco editor (left pane), manages SCXML draft state, toolbar with validate/save/publish/export/history buttons
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Split-view layout: Monaco editor (left), diagram preview placeholder (right)
- [ ] Monaco configured with XML language, line numbers, minimap enabled
- [ ] Loads draft SCXML first; falls back to active version if no draft; falls back to minimal template if neither
- [ ] 300ms debounce on content changes for preview updates
- [ ] Toolbar buttons: Validate, Save Draft, Publish, Export, Version History
- [ ] Dirty state tracked (comparing editor content to last saved)
- [ ] Status pill: "Valid" (green), "Draft has changes" (yellow), "Has errors" (red)
- [ ] Save Draft button disabled while save request in flight
- [ ] Publish button hidden for users without fsm.publisher role
**Related test cases:** SC-01, SC-02, SC-03

---

### TASK-018: DiagramPreview component — SCXML to SVG rendering
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-013
**Files to modify:**
- `frontend/src/components/workflows/DiagramPreview.tsx` — NEW FILE: renders SVG from SCXML via state-machine-cat, pan/zoom support, error overlay
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Converts SCXML to smcat format, then renders SVG via state-machine-cat
- [ ] SVG rendering triggered by parent passing SCXML string (debounced by parent)
- [ ] Pan and zoom support on the SVG container
- [ ] Error overlay when SCXML is malformed: "Can't render diagram" + error message
- [ ] Loading spinner during render
- [ ] Warning for large diagrams (>1 second render time)
- [ ] SVG contains visual state nodes and transition arrows
**Related test cases:** TC-FSM-028, TC-FSM-029, SC-01

---

### TASK-019: ProblemsPanel + toolbar integration
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-017
**Files to modify:**
- `frontend/src/components/workflows/ProblemsPanel.tsx` — NEW FILE: collapsible panel displaying validation errors (red) and warnings (yellow) with line:column references; click navigates Monaco to error line
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Panel below editor, collapsible
- [ ] Errors shown with red severity icon, warnings with yellow
- [ ] Each entry: severity, message, line:column reference
- [ ] Clicking an entry scrolls Monaco to that line and highlights it (via ref callback from WorkflowEditor)
- [ ] Panel opens automatically when validation returns errors
- [ ] "N errors, M warnings" summary in panel header
**Related test cases:** SC-02 (validate and save flow)

---

### TASK-020: VersionHistory modal + PublishDialog modal
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-014
**Files to modify:**
- `frontend/src/components/workflows/VersionHistory.tsx` — NEW FILE: modal listing versions with restore action
- `frontend/src/components/workflows/PublishDialog.tsx` — NEW FILE: confirmation modal with change note textarea
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] VersionHistory modal lists versions: version_number, status badge, author, date, change_note (truncated with expand)
- [ ] Versions sorted by version_number DESC
- [ ] "Restore as draft" button per archived/published version
- [ ] Restore confirmation if unsaved changes exist in editor
- [ ] PublishDialog: textarea for change_note (required), "Confirm Publish" button disabled when empty
- [ ] Both modals follow Blanc design: no `<hr>`, section separation by spacing, `--blanc-line` borders
**Related test cases:** SC-03, SC-06, TC-FSM-024

---

## Phase 4: Runtime Integration

---

### TASK-021: ActionsBlock component
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-014
**Files to modify:**
- `frontend/src/components/workflows/ActionsBlock.tsx` — NEW FILE: renders hot action buttons from published SCXML transitions; handles confirmation dialogs; override dropdown for fsm.override role
**Files NOT to modify:**
- `frontend/src/components/jobs/JobStatusTags.tsx` — not yet (TASK-022)
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Props: machineKey, entityId, currentState
- [ ] Fetches available actions via `useFsmActions` hook
- [ ] Renders button per action, label from `blanc:label`, sorted by `blanc:order`
- [ ] Handles `confirm: true` actions: shows confirmation dialog with `confirmText` (or default text)
- [ ] Clicking action calls `POST /api/fsm/:machineKey/apply`
- [ ] "Change status..." link visible only for users with fsm.override role
- [ ] Override dropdown lists all states from published SCXML (excluding current)
- [ ] Override requires reason textarea, calls `POST /api/fsm/:machineKey/override`
- [ ] Empty actions = no buttons rendered, no "Actions" header
- [ ] React Query cache invalidation on successful transition
**Related test cases:** TC-FSM-022, TC-FSM-023, SC-04, SC-05, SC-08

---

### TASK-022: Replace hardcoded buttons in JobStatusTags.tsx with ActionsBlock
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-021
**Files to modify:**
- `frontend/src/components/jobs/JobStatusTags.tsx` — replace hardcoded status-change dropdown/buttons with `<ActionsBlock machineKey="job" entityId={job.id} currentState={job.blanc_status} />`
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] Hardcoded status dropdown removed
- [ ] `<ActionsBlock>` component renders in its place
- [ ] All other card content, layout, and styling preserved
- [ ] Existing status badge display unchanged
- [ ] Works with both FSM-driven and fallback (hardcoded) actions
**Related test cases:** SC-04

---

### TASK-023: Manual override UI in ActionsBlock
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-021
**Files to modify:**
- `frontend/src/components/workflows/ActionsBlock.tsx` — ensure override UI is complete: dropdown of all states, reason textarea, confirmation dialog
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] "Change status..." link only visible if user has `fsm.override` role (checked via Keycloak token claims)
- [ ] Dropdown lists all valid states from published SCXML excluding current state
- [ ] Confirmation dialog: "This is an override. It bypasses allowed transitions." + reason textarea (mandatory)
- [ ] On confirm, calls `POST /api/fsm/:machineKey/override` with entityId, targetState, reason
- [ ] Toast on success: "Status changed to X (override)"
- [ ] Toast on error with server message
- [ ] Falls back to BLANC_STATUSES list when no published FSM
**Related test cases:** TC-FSM-015, TC-FSM-016, TC-FSM-017, TC-FSM-025, TC-FSM-026, SC-05

---

### TASK-024: Modify jobsService.js — delegate to FSM runtime with fallback
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-011
**Files to modify:**
- `backend/src/services/jobsService.js` — modify `updateBlancStatus()` to try fsmService.resolveTransition first, fall back to ALLOWED_TRANSITIONS; add `getJobTransitions(companyId, currentState, userRoles)` export
**Files NOT to modify:**
- `src/server.js` (protected)
- OUTBOUND_MAP, computeBlancStatusFromZb, syncFromZenbooker, cancelJob, markEnroute, markInProgress, markComplete, zbJobToColumns — preserve all Zenbooker logic
**Acceptance criteria:**
- [ ] `updateBlancStatus()` calls `fsmService.resolveTransition(companyId, 'job', currentState, newStatus)` first
- [ ] If no published FSM exists (fsmService returns fallback), uses existing ALLOWED_TRANSITIONS check
- [ ] BLANC_STATUSES and ALLOWED_TRANSITIONS constants kept intact as fallback
- [ ] `getJobTransitions(companyId, currentState, userRoles)` delegates to fsmService.getAvailableActions or falls back to ALLOWED_TRANSITIONS
- [ ] OUTBOUND_MAP and Zenbooker sync logic completely unchanged
- [ ] All existing Zenbooker pass-through actions (cancelJob, markEnroute, markInProgress, markComplete) unchanged
**Related test cases:** TC-FSM-005, TC-FSM-014, TC-FSM-018

---

### TASK-025: Modify leadsService.js — delegate to FSM runtime with fallback
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-011
**Files to modify:**
- `backend/src/services/leadsService.js` — modify `updateLead()` to validate Status changes via fsmService.resolveTransition when published FSM exists; add `getLeadTransitions(companyId, currentStatus, userRoles)` export
**Files NOT to modify:**
- `src/server.js` (protected)
- All existing CRUD, convertLead, markLost, activateLead, phone normalization, metadata extraction — preserve
**Acceptance criteria:**
- [ ] When `Status` field changes in `updateLead()`, validates via `fsmService.resolveTransition(companyId, 'lead', currentStatus, newStatus)` if published FSM exists
- [ ] If no published FSM, allows current implicit behavior (no validation)
- [ ] `getLeadTransitions(companyId, currentStatus, userRoles)` delegates to fsmService.getAvailableActions or returns empty array as fallback
- [ ] All existing CRUD, convertLead, markLost, activateLead functions unchanged
**Related test cases:** TC-FSM-018

---

### TASK-026: Feature flag gating
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-015, TASK-021
**Files to modify:**
- `frontend/src/pages/LeadFormSettingsPage.tsx` — ensure Workflows tab visibility gated by `fsm_editor_enabled` flag
- `backend/src/routes/fsm.js` — check `fsm_publishing_enabled` flag on publish endpoint; check `fsm_editor_enabled` on editor endpoints
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] Workflows tab hidden when `fsm_editor_enabled` is false
- [ ] Publish endpoint returns 403 when `fsm_publishing_enabled` is false
- [ ] Editor read/write endpoints return 403 when `fsm_editor_enabled` is false
- [ ] Runtime endpoints (actions, apply, override) always available regardless of feature flags
- [ ] Feature flags read from company settings or environment config
**Related test cases:** SC-01 (feature flag precondition)

---

## Phase 5: Tests

---

### TASK-027: Unit tests — SCXML parser
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-004, TASK-005
**Files to modify:**
- `tests/services/fsmService.test.js` — NEW FILE: unit tests for parseSCXML and validateSCXML
**Files NOT to modify:**
- `backend/src/services/fsmService.js` — test only, do not modify
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] TC-FSM-001: valid SCXML produces correct graph (7 job states, all transitions, initialState, finalStates, metadata)
- [ ] TC-FSM-002: forbidden elements (`<script>`, `<invoke>`, `<send>`, `<onentry>`, `<onexit>`, `<parallel>`, `<history>`, `<datamodel>`) rejected
- [ ] TC-FSM-003: missing initial state produces error
- [ ] TC-FSM-004: blanc namespace attributes extracted correctly (label, statusName, action, confirm, confirmText, roles, order, icon)
- [ ] TC-FSM-020: unreachable states detected as warning
- [ ] TC-FSM-021: duplicate events in same state detected as warning
- [ ] TC-FSM-030: malformed XML returns parse error
- [ ] All tests pass with `npm test`
**Related test cases:** TC-FSM-001, TC-FSM-002, TC-FSM-003, TC-FSM-004, TC-FSM-020, TC-FSM-021, TC-FSM-030

---

### TASK-028: Integration tests — FSM API endpoints
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-012
**Files to modify:**
- `tests/routes/fsm.test.js` — NEW FILE: integration tests for all FSM API endpoints
**Files NOT to modify:**
- `backend/src/routes/fsm.js` — test only
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] TC-FSM-007: 401 without token, 403 without permission for each endpoint
- [ ] TC-FSM-008: company A cannot access company B's FSM data (machines, active, history, apply, override)
- [ ] TC-FSM-009: save draft, load draft, load active — draft does not affect active
- [ ] TC-FSM-010: publish draft — version incremented, active updated, old version archived
- [ ] TC-FSM-011: publish blocked when validation errors exist
- [ ] TC-FSM-012: version history returns in order
- [ ] TC-FSM-019: entity not found returns 404
- [ ] TC-FSM-027: version conflict returns 409
- [ ] TC-FSM-032: missing state query parameter returns 400
- [ ] All tests use proper test DB setup/teardown with company isolation
**Related test cases:** TC-FSM-007 through TC-FSM-019, TC-FSM-027, TC-FSM-032

---

### TASK-029: Unit tests — FSM runtime (transitions, fallback)
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-011
**Files to modify:**
- `tests/services/fsmService.test.js` — add test suites for resolveTransition and getAvailableActions (append to file from TASK-027)
**Files NOT to modify:**
- `backend/src/services/fsmService.js` — test only
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] TC-FSM-005: valid transition applied correctly (Submitted + TO_FOLLOW_UP -> Follow Up with Client)
- [ ] TC-FSM-006: invalid transition rejected (Canceled + TO_FOLLOW_UP -> invalid)
- [ ] TC-FSM-018: fallback to hardcoded constants when no published FSM exists
- [ ] TC-FSM-022: actions filtered by role (admin-only transition hidden from agent)
- [ ] TC-FSM-023: confirm dialog metadata returned in actions
- [ ] TC-FSM-031: fallback actions from hardcoded constants
- [ ] All tests pass with `npm test`
**Related test cases:** TC-FSM-005, TC-FSM-006, TC-FSM-018, TC-FSM-022, TC-FSM-023, TC-FSM-031

---

### TASK-030: Integration tests — ActionsBlock, WorkflowEditor
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-021, TASK-017
**Files to modify:**
- `tests/components/ActionsBlock.test.tsx` — NEW FILE: component tests for ActionsBlock
- `tests/components/WorkflowEditor.test.tsx` — NEW FILE: component tests for WorkflowEditor
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] ActionsBlock renders correct buttons for a given state and actions response
- [ ] ActionsBlock shows confirmation dialog for confirm transitions
- [ ] ActionsBlock hides override link when user lacks fsm.override role
- [ ] ActionsBlock renders empty when no actions available
- [ ] WorkflowEditor loads draft/active SCXML correctly
- [ ] WorkflowEditor toolbar buttons trigger correct API calls
- [ ] TC-FSM-013: apply endpoint integration — entity status updated
- [ ] TC-FSM-014: Zenbooker outbound sync fires on mapped statuses
- [ ] TC-FSM-015: override requires fsm.override role
- [ ] TC-FSM-016: successful override with audit log
- [ ] TC-FSM-017: missing reason rejected
- [ ] TC-FSM-025: target state not in SCXML rejected
- [ ] TC-FSM-026: override to current state rejected
**Related test cases:** TC-FSM-013 through TC-FSM-017, TC-FSM-025, TC-FSM-026

---

## Dependency Graph

```
TASK-001 (migration: tables) ─────────────────────┐
TASK-002 (migration: permissions)                  │
TASK-003 (install fast-xml-parser) ───► TASK-004   │
TASK-005 (seed SCXML files)                        │
TASK-006 (migration: seed data) ◄─── TASK-001     │
                                                   │
TASK-004 + TASK-006 ──► TASK-007 (service: reads)  │
TASK-007 ──► TASK-008 (service: writes)            │
TASK-007 + TASK-002 ──► TASK-009 (routes: read)    │
TASK-008 + TASK-009 ──► TASK-010 (routes: write)   │
TASK-008 ──► TASK-011 (runtime)                    │
TASK-009 + TASK-010 + TASK-011 ──► TASK-012 (mount)│
                                                   │
TASK-013 (install frontend deps)                   │
TASK-012 ──► TASK-014 (hooks)                      │
TASK-015 (tabs wrapper)                            │
TASK-014 ──► TASK-016 (MachineList)                │
TASK-013 + TASK-014 ──► TASK-017 (WorkflowEditor)  │
TASK-013 ──► TASK-018 (DiagramPreview)             │
TASK-017 ──► TASK-019 (ProblemsPanel)              │
TASK-014 ──► TASK-020 (VersionHistory + Publish)   │
                                                   │
TASK-014 ──► TASK-021 (ActionsBlock)               │
TASK-021 ──► TASK-022 (replace JobStatusTags)      │
TASK-021 ──► TASK-023 (override UI)                │
TASK-011 ──► TASK-024 (jobsService integration)    │
TASK-011 ──► TASK-025 (leadsService integration)   │
TASK-015 + TASK-021 ──► TASK-026 (feature flags)   │
                                                   │
TASK-004 + TASK-005 ──► TASK-027 (parser tests)    │
TASK-012 ──► TASK-028 (API tests)                  │
TASK-011 ──► TASK-029 (runtime tests)              │
TASK-021 + TASK-017 ──► TASK-030 (component tests) │
```

## Execution Order (recommended)

**Wave 1 (parallel):** TASK-001, TASK-002, TASK-003, TASK-005, TASK-013
**Wave 2:** TASK-004, TASK-006
**Wave 3:** TASK-007
**Wave 4:** TASK-008
**Wave 5 (parallel):** TASK-009, TASK-011, TASK-015
**Wave 6:** TASK-010
**Wave 7:** TASK-012, TASK-014
**Wave 8 (parallel):** TASK-016, TASK-017, TASK-018, TASK-020, TASK-021, TASK-027
**Wave 9 (parallel):** TASK-019, TASK-022, TASK-023, TASK-024, TASK-025, TASK-028, TASK-029
**Wave 10:** TASK-026, TASK-030

---
---

# IMG-001: Fullscreen Image Viewer — Task Breakdown

**Feature:** Shared fullscreen lightbox for image attachments
**Total tasks:** 2
**Phases:** 1

---

## Phase 1: Extract & Implement

---

### TASK-IMG-001: Extract FullscreenImageViewer + RotatableImage to shared component

**Phase:** 1
**Status:** done
**Dependencies:** none
**Files to modify:**
- `frontend/src/components/shared/FullscreenImageViewer.tsx` — **NEW**: Create shared component with `FullscreenImageViewer` and `RotatableImage` exports
- `frontend/src/components/payments/PaymentDetailPanel.tsx` — Remove inline `FullscreenViewer` and `RotatableImage`, import from shared

**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)

**Acceptance criteria:**
- [ ] `FullscreenImageViewer` exported from shared with generic `{url, filename}[]` interface
- [ ] `RotatableImage` exported from shared (used by both inline preview and fullscreen)
- [ ] `PaymentDetailPanel` imports from shared, no inline FullscreenViewer/RotatableImage
- [ ] Fullscreen opens on image click, closes on Escape/backdrop/X
- [ ] Arrow key navigation works, rotation resets on navigate
- [ ] Thumbnail strip at bottom, body scroll locked
- [ ] TypeScript compiles without errors

---

### TASK-IMG-002: Write tests for FullscreenImageViewer

**Phase:** 1
**Status:** skipped (no frontend test infrastructure — Jest not configured for TSX/JSdom)
**Dependencies:** TASK-IMG-001
**Files to modify:**
- `frontend/src/components/shared/__tests__/FullscreenImageViewer.test.tsx` — **NEW**: Jest + RTL tests

**Files NOT to modify:**
- All production code (only tests)

**Acceptance criteria:**
- [ ] Tests cover: open/close, keyboard navigation, rotation reset, body scroll lock, non-image skip
- [ ] All tests pass with `npm test`
- [ ] Test-cases from `Docs/test-cases/IMG-001-fullscreen-image-viewer.md` covered

---

## Execution Order

**Wave 1:** TASK-IMG-001
**Wave 2:** TASK-IMG-002

---

# SCHED-LIST-001: Schedule List View — Tasks

**Feature:** New "List" view mode for Schedule page
**Total tasks:** 4
**Phases:** 2

---

## Phase 1: Plumbing (ViewMode + wiring)

### TASK-LIST-001: Add 'list' to ViewMode and useScheduleData
**Phase:** 1
**Status:** done
**Dependencies:** none
**Files to modify:**
- `frontend/src/hooks/useScheduleData.ts` — Add `'list'` to ViewMode union, dateRange switch (week range), navigateDate (week-like)
**Acceptance criteria:**
- [ ] `ViewMode` type includes `'list'`
- [ ] `dateRange` returns week range for `'list'`
- [ ] `navigateDate` uses week navigation for `'list'`

---

### TASK-LIST-002: Add 'List' to CalendarControls VIEW_OPTIONS
**Phase:** 1
**Status:** done
**Dependencies:** none
**Files to modify:**
- `frontend/src/components/schedule/CalendarControls.tsx` — Add `{ value: 'list', label: 'List' }` to VIEW_OPTIONS, add 'list' to getDateLabel
**Acceptance criteria:**
- [ ] VIEW_OPTIONS includes `{ value: 'list', label: 'List' }`
- [ ] Date label shows week range for 'list' mode

---

## Phase 2: ListView component + wiring

### TASK-LIST-003: Create ListView component
**Phase:** 2
**Status:** done
**Dependencies:** TASK-LIST-001
**Files to modify:**
- `frontend/src/components/schedule/ListView.tsx` — NEW: Provider columns, day grouping with DateSeparator, ScheduleItemCard rendering, DnD support
**Acceptance criteria:**
- [ ] Provider columns rendered (sorted alphabetically, Unassigned last)
- [ ] Items grouped by day with DateSeparator-style headings
- [ ] Empty days not rendered
- [ ] Items sorted by start_at within each day
- [ ] ScheduleItemCard used with compact={false} (time slot visible)
- [ ] Click triggers onSelectItem
- [ ] DnD reassign between columns works
- [ ] Horizontal scroll when columns overflow

---

### TASK-LIST-004: Wire ListView into SchedulePage
**Phase:** 2
**Status:** done
**Dependencies:** TASK-LIST-003
**Files to modify:**
- `frontend/src/pages/SchedulePage.tsx` — Import ListView, add case 'list' to renderCalendarView switch
**Acceptance criteria:**
- [ ] SchedulePage renders ListView when viewMode === 'list'
- [ ] All props passed correctly (currentDate, items, settings, providers, onSelectItem, onReassign, onCreateFromSlot)

---

## Execution Order

**Wave 1:** TASK-LIST-001, TASK-LIST-002 (parallel)
**Wave 2:** TASK-LIST-003
**Wave 3:** TASK-LIST-004

---

# EMAIL-001: Gmail Shared Mailbox + Email Workspace — Task Breakdown

**Feature:** One shared Gmail mailbox per company + separate `/email` operator workspace
**Migration range:** 079
**Total tasks:** 12
**Phases:** 5

---

## Phase 1: Persistence + OAuth Foundation

### TASK-EMAIL-001: Migration — email mailbox, thread, message, attachment, and sync tables
**Phase:** 1
**Status:** done
**Dependencies:** none
**Files to modify:**
- `backend/db/migrations/079_create_email_tables.sql` — **NEW**: create `email_mailboxes`, `email_threads`, `email_messages`, `email_attachments`, `email_sync_state` with indexes and constraints from architecture spec
**Files NOT to modify:**
- `src/server.js` (protected)
- existing migrations `072`–`078`
**Acceptance criteria:**
- [ ] `email_mailboxes` created with UNIQUE (`company_id`, `provider`) and encrypted token columns
- [ ] `email_threads` created with UNIQUE (`company_id`, `provider_thread_id`)
- [ ] `email_messages` created with UNIQUE (`company_id`, `provider_message_id`)
- [ ] `email_attachments` linked to `email_messages` with cascading delete
- [ ] `email_sync_state` created with one row per mailbox
- [ ] All new tables include `company_id` for tenant isolation
- [ ] Required indexes for thread list sort/filter and provider id lookups created
- [ ] Migration runs on a fresh DB without breaking existing tables
**Related test cases:** TC-EMAIL-001, TC-EMAIL-004, TC-EMAIL-005, TC-EMAIL-010, TC-EMAIL-014

---

### TASK-EMAIL-002: Query layer + mailbox credential storage
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-EMAIL-001
**Files to modify:**
- `backend/src/db/emailQueries.js` — **NEW**: mailbox CRUD, thread list/detail queries, idempotent upserts, sync-state helpers
- `backend/src/services/emailMailboxService.js` — **NEW**: token encryption/decryption, mailbox status updates, OAuth state signing/validation helpers
- `package.json` — add `googleapis`
**Files NOT to modify:**
- `backend/src/db/queries.js` — keep existing cross-domain facade intact unless a thin export is strictly necessary
- `frontend/package.json`
**Acceptance criteria:**
- [ ] `emailQueries` exposes canonical methods for mailbox lookup, thread list/detail, mark read, upsert thread/message/attachment, sync state, and due-mailbox selection
- [ ] Gmail tokens are encrypted at rest via `EMAIL_TOKEN_ENCRYPTION_KEY`
- [ ] Mailbox service never returns raw access/refresh tokens to route handlers or frontend payloads
- [ ] Package install succeeds with new Gmail dependency
**Related test cases:** TC-EMAIL-001, TC-EMAIL-003, TC-EMAIL-005, TC-EMAIL-012

---

### TASK-EMAIL-003: Settings routes + OAuth callback
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-EMAIL-002
**Files to modify:**
- `backend/src/routes/email-settings.js` — **NEW**: `GET /`, `POST /google/start`, `POST /disconnect`, `POST /sync`
- `backend/src/routes/email-oauth.js` — **NEW**: `GET /google/callback`
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `frontend/src/auth/ProtectedRoute.tsx`
**Acceptance criteria:**
- [ ] Settings routes require `tenant.integrations.manage`
- [ ] Callback route validates signed OAuth state and redirects back to `/settings/email`
- [ ] Disconnect marks mailbox `disconnected` without deleting synced local history
- [ ] Manual sync endpoint returns current sync status and does not leak credential data
**Related test cases:** TC-EMAIL-001, TC-EMAIL-002, TC-EMAIL-003, TC-EMAIL-013

---

## Phase 2: Gmail Sync + Message Domain

### TASK-EMAIL-004: Email sync service — bounded backfill and incremental history sync
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-EMAIL-002
**Files to modify:**
- `backend/src/services/emailSyncService.js` — **NEW**: `syncMailbox`, `runInitialBackfill`, `syncIncrementalHistory`, `startScheduler`
**Files NOT to modify:**
- `backend/src/services/inboxWorker.js` — keep Twilio worker isolated
- `backend/src/services/conversationsService.js` — keep SMS provider logic isolated
**Acceptance criteria:**
- [ ] Initial sync imports a bounded recent window (`EMAIL_SYNC_LOOKBACK_DAYS`)
- [ ] Incremental sync uses stored Gmail history checkpoint
- [ ] Duplicate provider payloads are handled idempotently
- [ ] Invalid/missing Gmail history checkpoint falls back to bounded backfill path
- [ ] Mailbox sync status/timestamps updated on success and failure
**Related test cases:** TC-EMAIL-004, TC-EMAIL-005, TC-EMAIL-013, TC-EMAIL-014

---

### TASK-EMAIL-005: Email service — send, reply, hydrate sent message, attachment proxy
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-EMAIL-002
**Files to modify:**
- `backend/src/services/emailService.js` — **NEW**: Gmail client factory, raw MIME send/reply, sent-message hydration, attachment streaming/download
**Files NOT to modify:**
- `backend/src/services/storageService.js` — do not introduce S3 persistence unless Gmail proxying proves insufficient
- `backend/src/services/textPolishService.js`
**Acceptance criteria:**
- [ ] New email send supports To, CC, subject, body, and attachments
- [ ] Reply uses existing Gmail thread context instead of creating a new thread
- [ ] Backend fetches the canonical sent Gmail message after send and upserts local records
- [ ] Attachment download streams through backend and enforces tenant scope
- [ ] Compose/reply reject when mailbox is `reconnect_required` or `disconnected`
**Related test cases:** TC-EMAIL-008, TC-EMAIL-009, TC-EMAIL-010, TC-EMAIL-011

---

## Phase 3: Backend API + App Wiring

### TASK-EMAIL-006: Email workspace routes
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-EMAIL-004, TASK-EMAIL-005
**Files to modify:**
- `backend/src/routes/email.js` — **NEW**: `GET /mailbox`, `GET /threads`, `GET /threads/:id`, `POST /threads/:id/read`, `POST /threads/compose`, `POST /threads/:id/reply`, `GET /attachments/:attachmentId/download`
**Files NOT to modify:**
- `backend/src/routes/messaging.js` — keep SMS routes unchanged
- `backend/src/routes/pulse.js` — keep Pulse timeline contract unchanged
**Acceptance criteria:**
- [ ] Read routes require `messages.view_internal`
- [ ] `GET /api/email/mailbox` returns non-secret mailbox state for `/email`
- [ ] Compose/reply routes require `messages.send`
- [ ] Thread list supports server-driven `view`, `q`, `cursor`, `limit`
- [ ] Thread detail returns messages + attachments in chronological order
- [ ] Mark-read endpoint is idempotent and tenant-safe
**Related test cases:** TC-EMAIL-006, TC-EMAIL-007, TC-EMAIL-008, TC-EMAIL-009, TC-EMAIL-010, TC-EMAIL-012, TC-EMAIL-028

---

### TASK-EMAIL-007: Mount routes and start sync scheduler
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-EMAIL-003, TASK-EMAIL-004, TASK-EMAIL-006
**Files to modify:**
- `src/server.js` — mount `/api/settings/email`, `/api/email`, `/api/email/oauth`; start email sync scheduler
**Files NOT to modify:**
- existing route protection order for unrelated modules
- `frontend/src/hooks/useRealtimeEvents.ts` (protected)
**Acceptance criteria:**
- [ ] Public OAuth callback route is mounted before SPA/static fallbacks
- [ ] Tenant-scoped email/settings routes are mounted with existing auth middleware
- [ ] Scheduler starts once per backend process and does not block server boot
- [ ] Existing `/api/messaging` and `/api/pulse` behavior is preserved
**Related test cases:** TC-EMAIL-002, TC-EMAIL-013, TC-EMAIL-015

---

## Phase 4: Frontend Settings + Email Workspace

### TASK-EMAIL-008: Email settings page + typed API wrapper
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-EMAIL-003, TASK-EMAIL-007
**Files to modify:**
- `frontend/src/services/emailApi.ts` — **NEW**: typed settings/workspace calls
- `frontend/src/pages/EmailSettingsPage.tsx` — **NEW**: mailbox status, connect/reconnect/disconnect, manual sync
- `frontend/src/App.tsx` — add `/settings/email`
- `frontend/src/components/layout/appLayoutNavigation.tsx` — add Settings menu entry
**Files NOT to modify:**
- top navigation tabs in `AppNavTabs`
- `frontend/src/services/messagingApi.ts`
**Acceptance criteria:**
- [ ] `/settings/email` is protected by `tenant.integrations.manage`
- [ ] Settings dropdown contains `Email`
- [ ] Top navigation tabs remain unchanged
- [ ] Connect action redirects browser to backend-provided Google auth URL
- [ ] Reconnect/disconnect/sync states are visible and user-readable
**Related test cases:** TC-EMAIL-016, TC-EMAIL-024, TC-EMAIL-025, TC-EMAIL-026

---

### TASK-EMAIL-009: Email workspace shell + thread list
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-EMAIL-006, TASK-EMAIL-008
**Files to modify:**
- `frontend/src/pages/EmailPage.tsx` — **NEW**
- `frontend/src/components/email/MailboxRail.tsx` — **NEW**
- `frontend/src/components/email/EmailThreadList.tsx` — **NEW**
- `frontend/src/components/email/EmailThreadRow.tsx` — **NEW**
- `frontend/src/App.tsx` — add `/email`
**Files NOT to modify:**
- `frontend/src/pages/MessagesPage.tsx`
- `frontend/src/pages/PulsePage.tsx`
**Acceptance criteria:**
- [ ] `/email` is protected by `messages.view_internal`
- [ ] `/email` loads mailbox state from a reader-safe workspace endpoint, not the admin settings endpoint
- [ ] No-mailbox state renders CTA to `/settings/email`
- [ ] Left rail supports system views (`Inbox`, `All`, `Sent`, `Unread`, `With attachments`)
- [ ] Thread list uses server-driven search/filter queries
- [ ] Thread row shows sender, subject, preview, time, unread, attachment state
**Related test cases:** TC-EMAIL-017, TC-EMAIL-018, TC-EMAIL-019, TC-EMAIL-023, TC-EMAIL-026, TC-EMAIL-028

---

### TASK-EMAIL-010: Thread pane + compose/reply + attachment UI
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-EMAIL-005, TASK-EMAIL-009
**Files to modify:**
- `frontend/src/components/email/EmailThreadPane.tsx` — **NEW**
- `frontend/src/components/email/EmailMessageItem.tsx` — **NEW**
- `frontend/src/components/email/EmailComposer.tsx` — **NEW**
**Files NOT to modify:**
- `frontend/src/components/pulse/SmsForm.tsx`
- `frontend/src/components/messaging/MessageThread.tsx`
**Acceptance criteria:**
- [ ] Selecting a thread loads detail on demand
- [ ] Opening unread thread triggers mark-read mutation
- [ ] Composer supports new email + reply modes
- [ ] Validation requires To + Subject + (body or attachment) for compose
- [ ] Reply stays in current thread after success
- [ ] Previewable image attachments can reuse existing fullscreen image viewer
**Related test cases:** TC-EMAIL-020, TC-EMAIL-021, TC-EMAIL-022, TC-EMAIL-024, TC-EMAIL-027

---

## Phase 5: Verification

### TASK-EMAIL-011: Backend automated tests
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-EMAIL-004, TASK-EMAIL-005, TASK-EMAIL-006, TASK-EMAIL-007
**Files to modify:**
- `tests/routes/email.test.js` — **NEW**
- `tests/services/emailMailboxService.test.js` — **NEW**
- `tests/services/emailSyncService.test.js` — **NEW**
**Files NOT to modify:**
- unrelated Twilio tests
**Acceptance criteria:**
- [ ] Route tests cover auth/permission guards, tenant isolation, list/detail/read, compose/reply, attachment download
- [ ] Service tests cover token encryption, OAuth callback persistence, initial backfill, incremental sync idempotency, history-gap fallback
- [ ] Jest suite passes with new email tests included
**Related test cases:** TC-EMAIL-001 through TC-EMAIL-015

---

### TASK-EMAIL-012: Frontend verification and regression checklist
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-EMAIL-008, TASK-EMAIL-009, TASK-EMAIL-010
**Files to modify:**
- `docs/test-cases/EMAIL-001-gmail-shared-mailbox-workspace.md` — keep manual/visual verification aligned with implemented UI
**Files NOT to modify:**
- unrelated page specs
**Acceptance criteria:**
- [ ] QA pass covers route protection, no-mailbox state, thread selection, mark-read, compose, reply, search, attachment open/download, reconnect-required state
- [ ] Regression pass confirms top nav unchanged and existing `MessagesPage`/`PulsePage` flows still work
- [ ] Any missing frontend automation gaps are explicitly documented
**Related test cases:** TC-EMAIL-016 through TC-EMAIL-027

---

## Execution Order

**Wave 1:** TASK-EMAIL-001
**Wave 2:** TASK-EMAIL-002, TASK-EMAIL-003 (serial preferred if OAuth state helpers live in mailbox service)
**Wave 3:** TASK-EMAIL-004, TASK-EMAIL-005 (parallel)
**Wave 4:** TASK-EMAIL-006
**Wave 5:** TASK-EMAIL-007
**Wave 6:** TASK-EMAIL-008, TASK-EMAIL-009 (parallel once routes exist)
**Wave 7:** TASK-EMAIL-010
**Wave 8:** TASK-EMAIL-011, TASK-EMAIL-012

---

# PF007-HARDENING-001: Provider Scope, Tenant Isolation & RBAC Hardening — Task Breakdown

**Feature:** Enforce provider-assigned-only visibility, close tenant isolation gaps, and make backend/frontend RBAC deny-by-default
**Migration range:** 096 (originally planned as 080 — that number was already taken by 080_seed_analytics_scope.sql)
**Total tasks:** 17
**Phases:** 5

---

## Phase 1: Ownership Foundation

### TASK-RBAC-001: Migration — provider bridge and internal assignee mirrors
**Phase:** 1
**Status:** done (2026-06-12)
**Dependencies:** none
**Files to modify:**
- `backend/db/migrations/080_pf007_provider_scope_hardening.sql` — **NEW**: add provider bridge field on `company_user_profiles`, add internal assignee mirror on `jobs`, create indexes/backfill
**Files NOT to modify:**
- `src/server.js` (protected)
- existing migrations `001`–`079`
**Acceptance criteria:**
- [ ] `company_user_profiles` has nullable `zenbooker_team_member_id` used only as an integration bridge
- [ ] `jobs` has `assigned_provider_user_ids JSONB NOT NULL DEFAULT '[]'`
- [ ] Required indexes exist for company-scoped provider visibility queries
- [ ] Migration is idempotent and runs on a fresh DB without breaking existing PF007 tables
- [ ] Internal ownership remains authoritative via `crm_users.id`; external provider ids do not become an auth source

---

### TASK-RBAC-002: Team Management API — expose provider bridge in user profile
**Phase:** 1
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-001
**Files to modify:**
- `backend/src/routes/users.js` — expose provider bridge field in user read/update flows
- `backend/src/services/userService.js` — persist and validate `profile.zenbooker_team_member_id`
- `backend/src/db/membershipQueries.js` — load/store profile mapping tenant-safely
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/CompanyUsersPage.tsx` — frontend wiring comes later
**Acceptance criteria:**
- [ ] `GET /api/users/:id` returns membership profile including `zenbooker_team_member_id`
- [ ] `PATCH /api/users/:id` accepts and persists `profile.zenbooker_team_member_id`
- [ ] Updates stay tenant-scoped and cross-company user ids return `404`
- [ ] Audit payload records mapping changes

---

### TASK-RBAC-003: Job sync — map external provider assignments to internal CRM users
**Phase:** 1
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-001, TASK-RBAC-002
**Files to modify:**
- `backend/src/services/jobsService.js` — populate `assigned_provider_user_ids` during upsert/sync
- `backend/src/services/jobSyncService.js` — keep internal assignee mirror updated on assignment events
- `backend/src/db/membershipQueries.js` — resolve company-scoped provider bridge lookups
**Files NOT to modify:**
- `backend/src/routes/jobs.js` — visibility enforcement comes later
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Job sync resolves external provider ids to internal `crm_users.id` within the same company
- [ ] `jobs.assigned_provider_user_ids` is updated whenever Zenbooker assignment changes
- [ ] Unmapped external provider ids do not grant visibility to any CRM user
- [ ] Re-syncs remain idempotent and company-scoped

---

## Phase 2: Provider Scope and Tenant Isolation

### TASK-RBAC-004: Jobs API — enforce `assigned_only` provider visibility
**Phase:** 2
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-003
**Files to modify:**
- `backend/src/routes/jobs.js` — enforce visibility checks on list/detail/history/notes surfaces
- `backend/src/services/jobsService.js` — apply `req.authz.scopes.job_visibility` and current `crm_users.id`
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/JobsPage.tsx` — frontend gating comes later
**Acceptance criteria:**
- [ ] When `job_visibility = assigned_only`, list queries return only jobs whose `assigned_provider_user_ids` include the current `crm_users.id`
- [ ] `GET /api/jobs/:id`, `/history`, and `/notes` apply the same visibility rule
- [ ] Non-visible jobs return `404`, not `403`
- [ ] All jobs queries continue filtering by `company_id`
- [ ] Roles with `job_visibility = all` keep current tenant-wide behavior

---

### TASK-RBAC-005: Schedule read model — provider sees only own work
**Phase:** 2
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-003
**Files to modify:**
- `backend/src/db/scheduleQueries.js` — filter `job` and `task` rows by current assignee for provider scope
- `backend/src/services/scheduleService.js` — apply authz-aware filters for list/detail/mutations
- `backend/src/routes/schedule.js` — enforce read vs dispatch capability boundaries
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/SchedulePage.tsx` — frontend gating comes later
**Acceptance criteria:**
- [ ] Providers with `assigned_only` receive only their own `job` items and their own assigned `task` items
- [ ] Provider schedule responses do not include `lead` items
- [ ] Schedule item detail enforces the same scope and returns `404` for non-visible entities
- [ ] Dispatch mutations and settings remain unavailable without dispatch-capable permissions
- [ ] Tenant context is taken only from `req.companyFilter?.company_id`

---

### TASK-RBAC-006: Contacts API — tenant-safe queries and provider client scope
**Phase:** 2
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-004
**Files to modify:**
- `backend/src/routes/contacts.js` — require tenant-safe list/detail/update flows
- `backend/src/services/contactsService.js` — add company-scoped and provider-scoped contact queries
- `backend/src/db/contactsQueries.js` — remove cross-tenant phone lookups
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/ContactsPage.tsx` — frontend changes come later
**Acceptance criteria:**
- [ ] `GET /api/contacts` filters by `company_id`
- [ ] Provider contact list/detail includes only contacts linked to currently visible assigned jobs
- [ ] Phone lookup helpers no longer search globally across tenants
- [ ] `GET/PATCH /api/contacts/:id` return `404` for foreign-company or non-visible contacts
- [ ] Related lead queries remain company-scoped

---

### TASK-RBAC-007: Pulse timeline access — own clients only
**Phase:** 2
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-004, TASK-RBAC-006
**Files to modify:**
- `backend/src/routes/pulse.js` — enforce tenant-safe timeline/contact lookup and provider client scope
- `backend/src/db/queries.js` — add tenant-safe timeline/contact helpers as needed
- `backend/src/db/conversationsQueries.js` — ensure conversation/message lookups respect tenant context
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/PulsePage.tsx` — frontend gating comes later
**Acceptance criteria:**
- [ ] `/api/pulse/timeline/:contactId` and `/timeline-by-id/:timelineId` only resolve entities inside the current tenant
- [ ] Providers can open Pulse only for contacts reachable from their visible assigned jobs
- [ ] SMS conversation lookup cannot pull another tenant's data by phone match
- [ ] Financial events are omitted unless the user has `financial_data.view`
- [ ] Foreign-company or non-visible contact/timeline ids return `404`

---

## Phase 3: Backend RBAC Hardening

### TASK-RBAC-008: Route permissions — Jobs and Schedule
**Phase:** 3
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-004, TASK-RBAC-005
**Files to modify:**
- `backend/src/routes/jobs.js` — add granular permission guards per read/write action
- `backend/src/routes/schedule.js` — separate `schedule.view` from `schedule.dispatch`
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/middleware/authorization.js` — reuse existing middleware, do not redesign it here
**Acceptance criteria:**
- [ ] Jobs read routes require `jobs.view`
- [ ] Jobs mutations require the matching permissions (`jobs.edit`, `jobs.assign`, `jobs.close`, `jobs.done_pending_approval`) by action
- [ ] Schedule read routes require `schedule.view`
- [ ] Schedule dispatch/settings/mutation routes require `schedule.dispatch`
- [ ] Hidden UI is no longer a security boundary for jobs/schedule APIs

---

### TASK-RBAC-009: Route permissions — Contacts and Pulse
**Phase:** 3
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-006, TASK-RBAC-007
**Files to modify:**
- `backend/src/routes/contacts.js` — require `contacts.view` / `contacts.edit`
- `backend/src/routes/pulse.js` — require `pulse.view`
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/middleware/keycloakAuth.js` — no auth-model redesign in this task
**Acceptance criteria:**
- [ ] Contact read routes require `contacts.view`
- [ ] Contact update routes require `contacts.edit`
- [ ] Pulse timeline routes require `pulse.view`
- [ ] Permission denial returns `403` before data access; entity non-visibility still returns `404`

---

### TASK-RBAC-010: Finance routes — tenant context fix and granular permission checks
**Phase:** 3
**Status:** done (2026-06-12)
**Dependencies:** none
**Files to modify:**
- `backend/src/routes/estimates.js` — replace `req.companyId` and add per-action permission guards
- `backend/src/routes/invoices.js` — replace `req.companyId` and add per-action permission guards
- `backend/src/routes/payments.js` — replace `req.companyId` and add per-action permission guards
**Files NOT to modify:**
- `src/server.js` (protected)
- DB query files for finance modules — keep this task focused on route/context hardening
**Acceptance criteria:**
- [ ] All finance routes use `req.companyFilter?.company_id` and never read `req.companyId`
- [ ] Read/create/send/collect/refund routes require the matching permission keys
- [ ] Users without finance permissions cannot read totals or invoke payment collection endpoints
- [ ] Entity-by-id routes stay tenant-scoped and return `404` for foreign ids
- [ ] No route falls back to global or undefined company context

---

### TASK-RBAC-011: FSM backend — server-side action filtering and apply authorization
**Phase:** 3
**Status:** done (2026-06-12)
**Dependencies:** none
**Files to modify:**
- `backend/src/routes/fsm.js` — stop trusting client-supplied `roles`, enforce server authz on `/actions` and `/apply`
**Files NOT to modify:**
- `backend/src/services/fsmService.js` — reuse existing graph helpers and contracts
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `/api/fsm/:machineKey/actions` filters actions using `req.authz`, not query-string role hints
- [ ] `/api/fsm/:machineKey/apply` enforces permission checks before mutating entity state
- [ ] Platform-only `super_admin` cannot access tenant FSM routes
- [ ] Fallback behavior when no published graph exists does not widen permissions

---

### TASK-RBAC-012: Tenant access middleware cleanup — remove remaining platform bypass assumptions
**Phase:** 3
**Status:** done (2026-06-12)
**Dependencies:** none
**Files to modify:**
- `backend/src/middleware/keycloakAuth.js` — stop leaking legacy `is_super_admin` assumptions into tenant access
- `backend/src/middleware/authorization.js` — keep tenant/platform denial behavior consistent
- `backend/src/services/authorizationService.js` — keep compatibility mapping without bypassing tenant RBAC
**Files NOT to modify:**
- `src/server.js` (protected)
- frontend auth files — frontend alignment comes later
**Acceptance criteria:**
- [ ] Tenant access is derived from `req.authz`, not from ad-hoc `req.user.is_super_admin` checks
- [ ] Platform-only users consistently receive tenant denial on tenant routes
- [ ] Legacy `company_admin/company_member` mapping remains compatibility-only and does not create new bypass paths
- [ ] Access-denied audit context includes platform role and target route for tenant denials

---

## Phase 4: Frontend Capability Gating

### TASK-RBAC-013: Navigation and route alignment by permissions
**Phase:** 4
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-008, TASK-RBAC-009, TASK-RBAC-012
**Files to modify:**
- `frontend/src/components/layout/appLayoutNavigation.tsx` — build top nav and settings menu from effective permissions
- `frontend/src/App.tsx` — align route guards with canonical permission keys
- `frontend/src/auth/ProtectedRoute.tsx` — remove blanket tenant bypass for legacy `super_admin`
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `frontend/src/auth/AuthProvider.tsx` — no auth-context contract change in this task
**Acceptance criteria:**
- [ ] Navigation only shows workspaces and settings backed by current permissions
- [ ] `/schedule` is guarded by `schedule.view`, not `jobs.view`
- [ ] ProtectedRoute does not grant tenant access only because the token contains legacy `super_admin`
- [ ] Platform-only routes remain available only to platform super admin
- [ ] Direct navigation to hidden pages is blocked by route guards

---

### TASK-RBAC-014: Jobs UI — stop loading forbidden finance and admin data
**Phase:** 4
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-008, TASK-RBAC-010, TASK-RBAC-013
**Files to modify:**
- `frontend/src/hooks/useJobsData.ts` — gate tag/settings preloads by permission
- `frontend/src/components/jobs/JobDetailPanel.tsx` — hide finance surface when not allowed
- `frontend/src/hooks/useJobFinancials.ts` — skip finance fetches without finance visibility
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `frontend/src/pages/JobsPage.tsx` — keep page composition stable in this task
**Acceptance criteria:**
- [ ] Job tags and list-field settings are not fetched for users lacking the required management permissions
- [ ] Finance tab/section renders only when the user has finance visibility
- [ ] Financial hooks do not call estimates/invoices endpoints for unauthorized users
- [ ] Provider job detail shows only actions allowed by effective permissions

---

### TASK-RBAC-015: Schedule UI — provider-safe loading and controls
**Phase:** 4
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-005, TASK-RBAC-013
**Files to modify:**
- `frontend/src/hooks/useScheduleData.ts` — gate provider roster and dispatch settings fetches by permission
- `frontend/src/pages/SchedulePage.tsx` — hide dispatch-only actions for provider users
- `frontend/src/components/schedule/CalendarControls.tsx` — hide or disable dispatch-only controls
**Files NOT to modify:**
- `frontend/src/hooks/useRealtimeEvents.ts` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] Provider users load only the schedule data returned by the scoped backend API
- [ ] Dispatch settings and full provider roster are not fetched without `schedule.dispatch`
- [ ] Reassign, create-from-slot, and other dispatch-only controls are hidden or disabled for provider users
- [ ] Dispatcher and tenant-admin workflows keep current functionality

---

## Phase 5: Verification

### TASK-RBAC-016: Backend automated tests — provider scope and tenant isolation
**Phase:** 5
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-004, TASK-RBAC-005, TASK-RBAC-006, TASK-RBAC-007, TASK-RBAC-008, TASK-RBAC-009
**Files to modify:**
- `tests/jobsProviderScope.test.js` — **NEW**
- `tests/scheduleProviderScope.test.js` — **NEW**
- `tests/contactsPulseTenantIsolation.test.js` — **NEW**
**Files NOT to modify:**
- unrelated Twilio and email tests
**Acceptance criteria:**
- [ ] Tests cover provider assigned-only jobs list/detail/history behavior
- [ ] Tests cover provider schedule visibility, no-leads behavior, and forbidden dispatch mutations
- [ ] Tests cover contacts/pulse own-client-only visibility and `404` for foreign or non-visible ids
- [ ] Tests explicitly verify `company_id` tenant isolation across companies
- [ ] Jest suite passes with the new RBAC hardening tests included

---

### TASK-RBAC-017: Regression verification — finance, FSM, and frontend gating
**Phase:** 5
**Status:** done (2026-06-12)
**Dependencies:** TASK-RBAC-010, TASK-RBAC-011, TASK-RBAC-013, TASK-RBAC-014, TASK-RBAC-015
**Files to modify:**
- `tests/paymentsRoute.test.js` — extend for tenant context and finance permission denials
- `tests/routes/fsm.test.js` — extend for server-side action filtering and unauthorized apply
- `docs/test-cases/PF007-rbac-hardening.md` — **NEW**: manual verification checklist for nav hiding and forbidden preloads
**Files NOT to modify:**
- unrelated schedule layout and telephony tests
**Acceptance criteria:**
- [ ] Finance route tests cover `req.companyFilter?.company_id` usage and permission denials
- [ ] FSM tests cover server-side action filtering and unauthorized transition rejection
- [ ] Manual checklist covers nav hiding, forbidden prefetch prevention, and provider access only to own client timelines
- [ ] Remaining rollout risks and any uncovered automation gaps are explicitly documented

---

## Execution Order

**Wave 1:** TASK-RBAC-001
**Wave 2:** TASK-RBAC-002, TASK-RBAC-003 (serial preferred because sync depends on the new profile mapping)
**Wave 3:** TASK-RBAC-004, TASK-RBAC-005 (parallel once internal assignee mirror exists)
**Wave 4:** TASK-RBAC-006, TASK-RBAC-007
**Wave 5:** TASK-RBAC-008, TASK-RBAC-009, TASK-RBAC-010, TASK-RBAC-011, TASK-RBAC-012
**Wave 6:** TASK-RBAC-013
**Wave 7:** TASK-RBAC-014, TASK-RBAC-015 (parallel once route guards are stable)
**Wave 8:** TASK-RBAC-016, TASK-RBAC-017

---

# F014 — Ads Analytics Microservice

Spec: `docs/specs/F014-ads-analytics-microservice.md`
Test cases: `docs/test-cases/F014-ads-analytics-microservice.md`

### TASK-F014-001: Migration — `analytics:read` scope marker
**Phase:** 1
**Status:** done
**Files to modify:**
- `backend/db/migrations/080_seed_analytics_scope.sql` — **NEW** (no-op DDL, `COMMENT ON COLUMN api_integrations.scopes`)
**Files NOT to modify:**
- any existing migration
**Acceptance criteria:**
- [x] File created under `backend/db/migrations/`
- [x] Only a `COMMENT ON COLUMN` statement (no schema changes)
- [x] Documents both `leads:create` and `analytics:read` as canonical scopes

### TASK-F014-002: `analyticsService.js`
**Phase:** 2
**Status:** done
**Dependencies:** TASK-F014-001
**Files to modify:**
- `backend/src/services/analyticsService.js` — **NEW**
**Files NOT to modify:**
- `backend/src/services/leadsService.js`, `backend/src/services/jobsService.js`, `backend/src/services/callsService.js`
**Acceptance criteria:**
- [x] Exports `getSummary`, `listCalls`, `listLeads`, `listJobs`, `AnalyticsServiceError`
- [x] Shared CTE `tracked_calls → period_leads → attributed_leads`
- [x] TZ pinned to `America/New_York`
- [x] `parsePeriod` enforces max 92-day window
- [x] `normalizePhone` handles 10/11-digit + formatted input
- [x] `companyId` filter applied when non-null
- [x] Pure helpers exported for unit tests as `_normalizePhone`, `_parsePeriod`

### TASK-F014-003: `integrations-analytics.js` router
**Phase:** 2
**Status:** done
**Dependencies:** TASK-F014-002
**Files to modify:**
- `backend/src/routes/integrations-analytics.js` — **NEW**
**Files NOT to modify:**
- `backend/src/routes/integrations-leads.js`, `backend/src/middleware/integrationsAuth.js`, `backend/src/middleware/rateLimiter.js`
**Acceptance criteria:**
- [x] Mirrors `integrations-leads` middleware chain
- [x] `requireScope` guard checks `analytics:read`
- [x] 4 GET endpoints: `/summary`, `/calls`, `/leads`, `/jobs`
- [x] Service errors mapped to HTTP via `err.httpStatus` + `err.code`
- [x] Uncaught errors → 500 `INTERNAL_ERROR` with no secret leak

### TASK-F014-004: Mount router in `src/server.js`
**Phase:** 3
**Status:** done
**Dependencies:** TASK-F014-003
**Files to modify:**
- `src/server.js` — 3 point changes (require, `app.use`, boot log)
**Files NOT to modify:**
- any routing logic not in the mount block
**Acceptance criteria:**
- [x] `require('../backend/src/routes/integrations-analytics')` present
- [x] `app.use('/api/v1/integrations', integrationsAnalyticsRouter)` present, same base as leads router
- [x] Startup log mentions `{leads, analytics/*}`

### TASK-F014-005: Key issuance script
**Phase:** 4
**Status:** done
**Dependencies:** TASK-F014-001
**Files to modify:**
- `backend/scripts/issue-analytics-key.js` — **NEW**
**Files NOT to modify:**
- any production auth path
**Acceptance criteria:**
- [x] `--client` required, `--company-id` and `--expires-days` optional
- [x] Requires `BLANC_SERVER_PEPPER` env var (exits if missing)
- [x] Generates key_id + 32-byte base64url secret
- [x] Hashes with SHA-256 using pepper, matches `integrationsAuth.hashSecret` algorithm
- [x] Inserts row with `scopes=['analytics:read']`
- [x] Prints secret exactly once to stdout

### TASK-F014-006: Router tests
**Phase:** 5
**Status:** done
**Dependencies:** TASK-F014-003
**Files to modify:**
- `tests/routes/integrations-analytics.test.js` — **NEW**
**Files NOT to modify:**
- any other test file
**Acceptance criteria:**
- [x] Mocks `analyticsService`, `integrationsAuth`, `rateLimiter`
- [x] 200 happy path for `/summary`
- [x] 403 on missing scope
- [x] 400 pass-through for `AnalyticsServiceError`
- [x] 500 on unexpected error
- [x] `test.each` covers `/calls`, `/leads`, `/jobs` happy paths with cursor

### TASK-F014-007: Service unit tests
**Phase:** 5
**Status:** done
**Dependencies:** TASK-F014-002
**Files to modify:**
- `tests/services/analyticsService.test.js` — **NEW**
**Files NOT to modify:**
- any other test file
**Acceptance criteria:**
- [x] `parsePeriod` cases: missing, reversed, too-large, 7-day happy
- [x] `normalizePhone` cases: null, 10-digit, 11-digit, formatted
- [x] DB connection mocked

### TASK-F014-008: Green test run
**Phase:** 6
**Status:** done
**Dependencies:** TASK-F014-006, TASK-F014-007
**Files to modify:** none (verification only)
**Acceptance criteria:**
- [x] `npx jest tests/routes/integrations-analytics.test.js tests/services/analyticsService.test.js` exits 0
- [x] No unhandled promise warnings

## Execution Order (F014)

**Wave 1:** TASK-F014-001
**Wave 2:** TASK-F014-002 (service), TASK-F014-005 (key script) — can run in parallel after migration marker exists
**Wave 3:** TASK-F014-003 (router)
**Wave 4:** TASK-F014-004 (server mount)
**Wave 5:** TASK-F014-006, TASK-F014-007 (tests in parallel)
**Wave 6:** TASK-F014-008 (green run)

---

## TWC-001: Twilio API Client Singleton

**Feature:** Eliminate per-function Twilio SDK instantiation; share one REST client per process.
**Status:** in progress
**Spec:** `docs/specs/TWC-001-twilio-client-singleton.md`
**Test cases:** `docs/test-cases/TWC-001-twilio-client-singleton.md`

### TASK-TWC-001-001: New module `twilioClient.js` with lazy singleton
**Phase:** 1
**Status:** done
**Files to modify:**
- `backend/src/services/twilioClient.js` — new file
**Files NOT to modify:**
- Any other Twilio-using module yet
- `backend/src/webhooks/twilioWebhooks.js`, `backend/src/webhooks/conversationsWebhooks.js`, `src/routes/webhooks.js` (only use static `twilio.validateRequest`)
- `backend/src/services/voiceService.js` (only uses `twilio.jwt.AccessToken` factory)
**Acceptance criteria:**
- [x] Exports `getTwilioClient()`
- [x] Lazy: `_client = null` until first call
- [x] Reads `process.env.TWILIO_ACCOUNT_SID` and `process.env.TWILIO_AUTH_TOKEN` on first call
- [x] Throws `Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required')` if either is missing
- [x] Memoises after successful init
- [x] On failure, `_client` stays null so a later call after env is set succeeds
- [x] Module-load (require) does NOT throw when env is missing

### TASK-TWC-001-002: Fix per-call leak in `reconcileStale.js`
**Phase:** 2
**Status:** done
**Dependencies:** TASK-TWC-001-001
**Files to modify:**
- `backend/src/services/reconcileStale.js`
**Acceptance criteria:**
- [x] Add `const { getTwilioClient } = require('./twilioClient')` at top of file
- [x] Remove `const twilio = require('twilio')` and `const client = twilio(...)` from inside `fetchAndUpdateFromTwilio`
- [x] Replace with `const client = getTwilioClient()` inside the function
- [x] All other logic (404 handling, status mapping, SSE publish) unchanged
- [x] No behavior change in success path

### TASK-TWC-001-003: Fix per-call leak in `callAvailability.js`
**Phase:** 2
**Status:** done
**Dependencies:** TASK-TWC-001-001
**Files to modify:**
- `backend/src/services/callAvailability.js`
**Acceptance criteria:**
- [x] Replace per-call `twilio(sid, token)` with `getTwilioClient()`
- [x] No behavior change

### TASK-TWC-001-004: Fix per-event leak in `inboxWorker.js`
**Phase:** 2
**Status:** done
**Dependencies:** TASK-TWC-001-001
**Files to modify:**
- `backend/src/services/inboxWorker.js`
**Acceptance criteria:**
- [x] Replace per-event `twilio(sid, token)` (line ~772) with `getTwilioClient()`
- [x] Worker main loop unchanged
- [x] No behavior change

### TASK-TWC-001-005: Fix per-request leak in `routes/phoneSettings.js`
**Phase:** 2
**Status:** done
**Dependencies:** TASK-TWC-001-001
**Files to modify:**
- `backend/src/routes/phoneSettings.js`
**Acceptance criteria:**
- [x] Replace per-request `twilio(sid, token)` with `getTwilioClient()`
- [x] Auth middleware chain untouched
- [x] Response shape untouched

### TASK-TWC-001-006: Migrate already-singleton modules to use shared getter
**Phase:** 3
**Status:** done
**Dependencies:** TASK-TWC-001-001
**Files to modify:**
- `backend/src/services/conversationsService.js`
- `backend/src/services/twilioSync.js`
- `backend/src/services/reconcileService.js`
**Acceptance criteria:**
- [x] Replace module-level `const client = twilio(sid, token)` with lazy access via `getTwilioClient()` (either inline at call sites or via a `getClient()` local that delegates)
- [x] Public exports (function names, signatures) unchanged
- [x] At module-load time without env, no throw
- [x] Existing tests for these services pass

### TASK-TWC-001-007: Unit tests for `twilioClient.js`
**Phase:** 4
**Status:** done
**Dependencies:** TASK-TWC-001-001
**Files to modify:**
- `tests/services/twilioClient.test.js` — new
**Acceptance criteria:**
- [x] TC-TWC-001-001: identity check (`getTwilioClient() === getTwilioClient()`)
- [x] TC-TWC-001-002: missing SID throws
- [x] TC-TWC-001-003: missing AUTH_TOKEN throws
- [x] TC-TWC-001-004: require without env does not throw
- [x] TC-TWC-001-005: re-init after env becomes available works
- [x] Uses `jest.resetModules()` and mocked `twilio` package

### TASK-TWC-001-008: Regression guard test
**Phase:** 4
**Status:** done
**Dependencies:** TASK-TWC-001-002 ... TASK-TWC-001-005
**Files to modify:**
- `tests/services/twilioClient.regression.test.js` — new
**Acceptance criteria:**
- [x] Reads each of the 4 hot-spot files via `fs.readFileSync`
- [x] Asserts none contain `twilio(process.env.TWILIO_ACCOUNT_SID`
- [x] Asserts each contains `getTwilioClient`

### TASK-TWC-001-009: Bootstrap smoke test
**Phase:** 4
**Status:** done
**Dependencies:** TASK-TWC-001-001 ... TASK-TWC-001-006
**Files to modify:**
- `tests/services/twilioClient.bootstrap.test.js` — new
**Acceptance criteria:**
- [x] Without TWILIO_* env, requiring `conversationsService`, `twilioSync`, `reconcileService`, `reconcileStale`, `callAvailability`, `inboxWorker`, and `routes/phoneSettings` does not throw

### TASK-TWC-001-010: Green test run
**Phase:** 5
**Status:** done
**Dependencies:** TASK-TWC-001-007 ... TASK-TWC-001-009
**Files to modify:** none (verification only)
**Acceptance criteria:**
- [x] `npx jest tests/services/twilioClient.test.js tests/services/twilioClient.regression.test.js tests/services/twilioClient.bootstrap.test.js` exits 0
- [x] No regressions in existing related test suites: `tests/zenbookerSyncService.test.js`, `tests/routes/integrations-analytics.test.js`, `tests/middleware/integrationScopes.test.js`

## Execution Order (TWC-001)

**Wave 1:** TASK-TWC-001-001
**Wave 2:** TASK-TWC-001-002, 003, 004, 005, 006 (in parallel — independent files)
**Wave 3:** TASK-TWC-001-007, 008, 009 (tests in parallel)
**Wave 4:** TASK-TWC-001-010 (green run)


---

## F015: Document Templates Customization

**Feature:** Per-company document templates (estimates first, extensible to invoice/work_order)
**Status:** in_progress
**Related docs:** `docs/requirements.md#F015`, `docs/architecture.md#F015`, `docs/specs/F015-document-templates.md`, `docs/test-cases/F015-document-templates.md`

### TASK-F015-001: Migration — `document_templates` table + factory seed
**Status:** done
**Files to create:**
- `backend/db/migrations/084_create_document_templates.sql`
**Files to modify:** none.
**Expected result:**
- Table exists with `document_type` CHECK currently `('estimate')`, unique partial index for one default per (company, type), trigger for `updated_at`.
- Seed step inserts one factory descriptor row per existing company.
- Idempotent (`IF NOT EXISTS`, `WHERE NOT EXISTS`).
**Acceptance:** TC-F015-040, TC-F015-041, TC-F015-042.

### TASK-F015-002: Schema + factory + renderer registry (no DB yet)
**Status:** done
**Files to create:**
- `backend/src/services/documentTemplates/schema/v1.json`
- `backend/src/services/documentTemplates/factory.js`
- `backend/src/services/documentTemplates/rendererRegistry.js`
- `backend/src/services/documentTemplates/estimateAdapter.js`
**Acceptance:** TC-F015-001..008 pass via Ajv.

### TASK-F015-003: Refactor `estimatePdfService.js` to accept descriptor
**Status:** done
**Files to modify:**
- `backend/src/services/estimatePdfService.js`
**Constraints:** legacy exports `COMPANY_PROFILE`, `DEFAULT_TERMS_AND_WARRANTY` preserved (re-derived from factory) so existing imports keep working.
**Acceptance:** TC-F015-030, TC-F015-031, TC-F015-032, TC-F015-033, TC-F015-060.

### TASK-F015-004: DB queries
**Status:** done
**Files to create:**
- `backend/src/db/documentTemplatesQueries.js`
**Expected result:** parameterized SQL with `company_id` filter on every read/write.

### TASK-F015-005: Service layer (resolve + CRUD orchestration)
**Status:** done
**Dependencies:** TASK-F015-002, TASK-F015-004
**Files to create:**
- `backend/src/services/documentTemplatesService.js`
**Acceptance:** TC-F015-010..016.

### TASK-F015-006: Routes
**Status:** done
**Dependencies:** TASK-F015-005
**Files to create:**
- `backend/src/routes/document-templates.js`
**Files to modify:**
- `src/server.js` — mount only (single line) — protected file: change is mount-only, otherwise no-op.
**Acceptance:** TC-F015-020..028.

### TASK-F015-007: Wire renderer in estimates flow
**Status:** done
**Dependencies:** TASK-F015-003, TASK-F015-005
**Files to modify:**
- `backend/src/services/estimatesService.js` (only `generatePdf` path)
**Expected result:** PDF endpoint resolves the company's default template via `documentTemplatesService.resolveTemplate` and passes it to the renderer.

### TASK-F015-008: Frontend API client + types
**Status:** done
**Files to create:**
- `frontend/src/services/documentTemplatesApi.ts`
- `frontend/src/types/documentTemplates.ts`

### TASK-F015-009: Frontend Settings page (list)
**Status:** done
**Dependencies:** TASK-F015-008
**Files to create:**
- `frontend/src/pages/DocumentTemplatesPage.tsx`
**Files to modify:**
- `frontend/src/App.tsx` (route registration only)
- existing settings nav (link entry)

### TASK-F015-010: Frontend Editor page
**Status:** done
**Dependencies:** TASK-F015-009
**Files to create:**
- `frontend/src/pages/DocumentTemplateEditorPage.tsx`
- `frontend/src/components/documents/TemplateEditorForm.tsx`
- `frontend/src/components/documents/TemplatePreview.tsx`
**Acceptance:** TC-F015-050..057.

### TASK-F015-011: Backend tests
**Status:** done
**Dependencies:** TASK-F015-005, TASK-F015-006
**Files to create:**
- `tests/services/documentTemplatesService.test.js`
- `tests/routes/document-templates.test.js`
- `tests/services/estimatePdfRendererGolden.test.js`

### TASK-F015-012: Documentation + changelog
**Status:** done
**Files to modify:**
- `docs/changelog.md`
- `docs/project-spec.md`
- `docs/feature-backlog.md` (mark F015 P0 done)

**Wave 1:** TASK-F015-001, TASK-F015-002 (parallel)
**Wave 2:** TASK-F015-003, TASK-F015-004 (parallel)
**Wave 3:** TASK-F015-005, TASK-F015-007 (sequential)
**Wave 4:** TASK-F015-006 (depends on 005)
**Wave 5:** TASK-F015-008, TASK-F015-009, TASK-F015-010 (frontend, sequential)
**Wave 6:** TASK-F015-011, TASK-F015-012 (tests + docs)

---

## Фича F016: VAPI AI Marketplace Integration + Call Flow Gating

### TASK-F016-001: DB migration — seed vapi-ai marketplace app

**Цель:** Зарегистрировать VAPI AI как published app в marketplace_apps и подключить миграцию к ensureMarketplaceSchema.

**Файлы, которые можно менять:**
- `backend/db/migrations/088_seed_vapi_ai_marketplace_app.sql` (новый)
- `backend/src/db/marketplaceQueries.js`

**Файлы, которые трогать нельзя:**
- `backend/db/migrations/083_create_marketplace_apps.sql` — существующая схема
- `backend/db/migrations/087_seed_mail_secretary_marketplace_app.sql` — существующий seed
- `src/server.js`

**Ожидаемый результат:** После `ensureMarketplaceSchema()` в marketplace_apps существует запись `app_key='vapi-ai'`, `provisioning_mode='none'`, `status='published'`, `category='telephony'`. Повторный запуск idempotent (ON CONFLICT DO UPDATE).

**Зависимости:** нет

**Статус:** done

---

### TASK-F016-002: Frontend — vapiApi.ts service

**Цель:** Создать типизированный API клиент для `/api/vapi/*` эндпоинтов.

**Файлы, которые можно менять:**
- `frontend/src/services/vapiApi.ts` (новый)

**Файлы, которые трогать нельзя:**
- `frontend/src/lib/authedFetch.ts`
- `frontend/src/services/telephonyApi.ts`

**Ожидаемый результат:** Экспортирует `vapiApi` объект с методами: `getConnections(): Promise<VapiConnection[]>`, `createConnection(body): Promise<VapiConnection>`, `getResources(): Promise<VapiResource[]>`, `createResource(body): Promise<VapiResource>`. Все методы используют `authedFetch`. Типы `VapiConnection` и `VapiResource` экспортируются отдельно.

**Зависимости:** нет

**Статус:** done

---

### TASK-F016-003: Frontend — VapiSettingsPage

**Цель:** Создать страницу настройки VAPI по адресу `/settings/integrations/vapi-ai`.

**Файлы, которые можно менять:**
- `frontend/src/pages/VapiSettingsPage.tsx` (новый)

**Файлы, которые трогать нельзя:**
- `frontend/src/lib/authedFetch.ts`
- `frontend/src/pages/IntegrationsPage.tsx` (изменяется в следующей задаче)

**Ожидаемый результат:**
- При отсутствии connection: Секция "API Connection" с полями API Key (type=password), Display Name, Environment select. Кнопка "Verify & Connect" → `vapiApi.createConnection()`. Inline error при 400.
- После успешного connection: Секция API Connection переходит в view-режим (masked key + display_name + status badge). Секция "SIP Resource" с полями SIP URI, Server URL. Кнопка "Save" → `vapiApi.createResource()`.
- После обоих шагов: кнопка "Finish Setup" → `installMarketplaceApp('vapi-ai')` → `navigate('/settings/integrations')` + toast.success.
- Если всё уже подключено (active installation + connection + resource): режим просмотра с кнопкой "Disconnect" → `disconnectMarketplaceInstallation(id)` + confirm dialog → navigate back.
- Стиль: Blanc design system. Без <hr>. Без пустых полей.
- Uses React Query: `useQuery(['vapi-connections'])`, `useQuery(['vapi-resources'])`, `useQuery(['marketplace-apps'])`.

**Зависимости:** TASK-F016-001 (seed), TASK-F016-002 (vapiApi)

**Статус:** done

---

### TASK-F016-004: Frontend — роут + интеграция с IntegrationsPage

**Цель:** Зарегистрировать `/settings/integrations/vapi-ai` в App.tsx и поменять поведение плитки VAPI в IntegrationsPage (кнопка "Configure"/"Manage" вместо generic dialog).

**Файлы, которые можно менять:**
- `frontend/src/App.tsx`
- `frontend/src/pages/IntegrationsPage.tsx`

**Файлы, которые трогать нельзя:**
- `frontend/src/lib/authedFetch.ts`
- Существующие диалоги `MarketplaceConnectDialog` и `MarketplaceDisconnectDialog`

**Ожидаемый результат:**
- `App.tsx`: новый роут `<Route path="/settings/integrations/vapi-ai" element={<ProtectedRoute permissions={['tenant.integrations.manage']}><VapiSettingsPage /></ProtectedRoute>} />`
- `IntegrationsPage.tsx`: для `app.app_key === 'vapi-ai'` кнопка "Configure" (нет installation) или "Manage" (есть installation) → `navigate('/settings/integrations/vapi-ai')`. Generic `MarketplaceConnectDialog` и `MarketplaceDisconnectDialog` для этой плитки НЕ открываются.

**Зависимости:** TASK-F016-003

**Статус:** done

---

### TASK-F016-005: Frontend — гейтинг vapi_agent в CallFlowBuilderPage

**Цель:** Скрывать ноду `vapi_agent` в insert picker Call Flow Builder если VAPI не подключён.

**Файлы, которые можно менять:**
- `frontend/src/pages/telephony/CallFlowBuilderPage.tsx`

**Файлы, которые трогать нельзя:**
- `frontend/src/types/telephony.ts`
- `frontend/src/services/vapiApi.ts` (только читаем)

**Ожидаемый результат:**
- `useEffect` при монтировании: `vapiApi.getConnections()` → если хотя бы одна запись со `status === 'active'` → `setVapiConnected(true)`, иначе `false`.
- Insert picker фильтрует NODE_KINDS: `vapi_agent` показывается только при `vapiConnected === true`.
- Пока loading → `vapiConnected` равен `null`, нода скрыта.
- Если нода уже добавлена в существующий flow — отображается нормально (фильтр только для вставки новых).

**Зависимости:** TASK-F016-002 (vapiApi)

**Статус:** done

---

### TASK-F016-006: Tests — vapi routes + marketplace seed

**Цель:** Написать Jest-тесты для VAPI routes и проверки seed миграции.

**Файлы, которые можно менять:**
- `tests/routes/vapi.test.js` (новый или существующий)
- `tests/routes/marketplaceMount.test.js` (расширить)

**Файлы, которые трогать нельзя:**
- `backend/src/routes/vapi.js`
- `backend/src/routes/marketplace.js`

**Ожидаемый результат:**
- TC-F016-001 (happy path), TC-F016-002 (invalid key), TC-F016-003 (network error), TC-F016-004 (seed), TC-F016-005 (list includes vapi-ai), TC-F016-006 (install → connected), TC-F016-007 (duplicate install → 409), TC-F016-008 (disconnect), TC-F016-009 (401 unauth), TC-F016-010 (401 unauth POST), TC-F016-011 (missing api_key), TC-F016-012 (missing provider_connection_id), TC-F016-016 (idempotent seed).
- Моки для `node-fetch` при вызове Vapi API.

**Зависимости:** TASK-F016-001

**Статус:** done

---

**Порядок волн:**
- Волна 1: TASK-F016-001 (seed migration)
- Волна 2: TASK-F016-002 (vapiApi.ts) — параллельно с Волной 1
- Волна 3: TASK-F016-003 (VapiSettingsPage)
- Волна 4: TASK-F016-004 (роут + IntegrationsPage), TASK-F016-005 (CallFlowBuilder) — параллельно
- Волна 5: TASK-F016-006 (тесты)

---

## Фича F017: Согласованность Softphone и User Groups

**Спецификация:** `docs/specs/F017-telephony-groups-softphone-consolidation.md`
**Тест-кейсы:** `docs/test-cases/F017-telephony-groups-softphone-consolidation.md`
**Режим:** планирование (Steps 1–5). Реализация — отдельными прогонами по приоритетам.

### TASK-F017-001: DB migration — routing foundation
**Приоритет:** P0 · **Статус:** pending
**Цель:** Заложить схему маршрутизации: привязка номер→группа, состояние исполнения flow, единственная стратегия.
**Файлы (создать/менять):**
- `backend/db/migrations/NNN_f017_telephony_routing.sql` (новый)
- `backend/src/routes/phoneSettings.js` (добавить group_id в ensureTable)
**Трогать нельзя:** существующие миграции 001–088 (только новая)
**Результат:** `phone_number_settings.group_id` (FK user_groups), `call_flow_executions` (таблица), `user_groups.strategy` → DEFAULT 'Simultaneous' + UPDATE всех строк. Все запросы фильтруют company_id.
**Acceptance:** TC-F017-001, TC-F017-023
**Зависимости:** нет

### TASK-F017-002: Backend — groupRouting service
**Приоритет:** P0 · **Статус:** pending
**Цель:** Резолв номер→группа→flow и список доступных агентов группы.
**Файлы:** `backend/src/services/groupRouting.js` (новый)
**Результат:** `resolveGroupForNumber(toNumber, companyId)`, `availableAgentsForGroup(groupId)` (фильтр по agentPresence). SQL по company_id.
**Acceptance:** TC-F017-004, TC-F017-013
**Зависимости:** TASK-F017-001

### TASK-F017-003: Backend — agentPresence service
**Приоритет:** P0 · **Статус:** pending
**Цель:** Реестр статусов агентов (available/on_call/offline) + SSE broadcast.
**Файлы:** `backend/src/services/agentPresence.js` (новый), `backend/src/services/realtimeService.js` (добавить событие agent.status.changed — расширение, не дублирование)
**Результат:** статус по userId, событие `agent.status.changed { userId, groupIds[], status }`.
**Acceptance:** TC-F017-040..043
**Зависимости:** TASK-F017-001

### TASK-F017-004: Backend — callFlowRuntime (SCXML execution engine)
**Приоритет:** P0 · **Статус:** pending
**Цель:** Исполнение flow-графа при звонке: ведение состояния, node→TwiML, advance по событиям.
**Файлы:** `backend/src/services/callFlowRuntime.js` (новый)
**Результат:** `startExecution(callSid, group, companyId)`, `advance(callSid, event)`, `nodeToTwiml(node, context)` для greeting/queue/voicemail/transfer/branch/hangup/vapi_agent. Состояние в call_flow_executions. Reuse buildVapiSipTwiml для vapi_agent.
**Acceptance:** TC-F017-006, TC-F017-010..022, TC-F017-044, TC-F017-061
**Зависимости:** TASK-F017-002, TASK-F017-003

### TASK-F017-005: Backend route — GET /api/user-groups/my
**Приоритет:** P0 · **Статус:** pending
**Цель:** Группы текущего пользователя для гейтинга Softphone.
**Файлы:** `backend/src/routes/userGroups.js`, `src/server.js` (mount-only если нужно)
**Результат:** endpoint с authenticate+requireCompanyAccess, фильтр company_id + membership. Изоляция.
**Acceptance:** TC-F017-030..032
**Зависимости:** TASK-F017-001

### TASK-F017-006: Backend route — PUT /api/phone-numbers/:id/group
**Приоритет:** P1 · **Статус:** pending
**Цель:** Привязка/отвязка номера к группе (1:1), 409 при занятом, синхронизация Twilio webhook.
**Файлы:** `backend/src/routes/phoneNumbers.js` (reuse getTwilioClient из twilioClient service)
**Результат:**
- запись group_id + auto routing_mode='client' (F-INC-02, F-INC-03);
- 409 с именем группы при конфликте (F-ROU-02); доступ к чужому номеру → 404;
- **F-INC-01:** при привязке обновить Twilio incoming-phone-number webhook (voiceUrl) на `{baseUrl}/webhooks/twilio/voice-inbound`. Ошибка Twilio API не должна оставлять рассинхрон БД↔Twilio (откат записи group_id при сбое).
**Acceptance:** TC-F017-001, TC-F017-002, TC-F017-003, TC-F017-038
**Зависимости:** TASK-F017-001

### TASK-F017-007: Backend — blanc-numbers фильтр по группам
**Приоритет:** P1 · **Статус:** pending
**Цель:** Caller ID picker отдаёт только номера групп пользователя + group_name.
**Файлы:** `backend/src/routes/voice.js`
**Результат:** blanc-numbers join по группам пользователя, добавлен group_name. Изоляция.
**Acceptance:** TC-F017-035..037
**Зависимости:** TASK-F017-001, TASK-F017-005

### TASK-F017-008: Backend — handleVoiceInbound → flow execution
**Приоритет:** P0 · **Статус:** pending
**Цель:** Переписать ядро inbound: группа → flow → рингать агентов группы (вместо рассылки всем).
**Файлы:** `backend/src/webhooks/twilioWebhooks.js` (handleVoiceInbound)
**Трогать нельзя:** outbound-ветка (SIP), логика validateTwilioSignature
**Результат:** resolveGroupForNumber → startExecution → первый node TwiML. Номер без группы → voicemail.
**Acceptance:** TC-F017-004, TC-F017-005, TC-F017-013, TC-F017-044
**Зависимости:** TASK-F017-002, TASK-F017-004

### TASK-F017-009: Backend — handleDialAction → advance
**Приоритет:** P0 · **Статус:** pending
**Цель:** Resume flow на Twilio callback'ах.
**Файлы:** `backend/src/webhooks/twilioWebhooks.js` (handleDialAction)
**Результат:** advance(callSid, event) по DialCallStatus; voicemail при no-answer.
**Acceptance:** TC-F017-006, TC-F017-014, TC-F017-016
**Зависимости:** TASK-F017-004, TASK-F017-008

### TASK-F017-010: Frontend — Softphone гейтинг по группам
**Приоритет:** P0 · **Статус:** pending
**Цель:** Кнопка Softphone и Twilio Device только для участников групп.
**Файлы:** `frontend/src/components/layout/SoftPhoneHeaderButton.tsx` + точка инициализации Device (AppLayout/SoftPhoneContext)
**Трогать нельзя:** `useTwilioDevice.ts` (оборачиваем, не переписываем), `authedFetch.ts`
**Результат:** fetch /api/user-groups/my; нет групп → не рендерить, не инициализировать Device, заглушка.
**Acceptance:** TC-F017-033, TC-F017-034
**Зависимости:** TASK-F017-005

### TASK-F017-011: Frontend — Caller ID picker по группам
**Приоритет:** P1 · **Статус:** pending
**Цель:** Picker показывает номера своих групп с подписью.
**Файлы:** `frontend/src/components/softphone/useSoftPhoneWidget.ts`, `frontend/src/components/softphone/SoftPhoneWidget.tsx`
**Результат:** blanc-numbers уже фильтруется бекендом; отобразить group_name; нет номеров → скрыть picker.
**Acceptance:** TC-F017-035..037
**Зависимости:** TASK-F017-007

### TASK-F017-012: Frontend — UserGroupDetailPage на реальное API
**Приоритет:** P0 · **Статус:** pending
**Цель:** Убрать mock, читать GET /api/user-groups/:id.
**Файлы:** `frontend/src/pages/telephony/UserGroupDetailPage.tsx`, удалить/перестать импортировать `frontend/src/data/userGroupsMock.ts`
**Результат:** реальные данные, inline-edit имени, add/remove членов и номеров.
**Acceptance:** TC-F017-050
**Зависимости:** нет (API /api/user-groups/:id существует)

### TASK-F017-013: Frontend — стратегия только Simultaneous
**Приоритет:** P0 · **Статус:** pending
**Цель:** Убрать Round Robin/Most Idle/Sequential/Weighted из UI.
**Файлы:** `frontend/src/pages/telephony/UserGroupsPage.tsx`
**Результат:** RING_STRATEGIES = только Simultaneous (или убрать выбор стратегии).
**Acceptance:** TC-F017-023
**Зависимости:** TASK-F017-001

### TASK-F017-014: Frontend — Phone Numbers: группа + привязка
**Приоритет:** P2 · **Статус:** pending
**Цель:** Колонка группы и привязка/отвязка со страницы номеров.
**Файлы:** `frontend/src/pages/telephony/PhoneNumbersPage.tsx`
**Результат:** badge группы/Unassigned; привязка через PUT /api/phone-numbers/:id/group; диалог "Move it?" при конфликте.
**Acceptance:** TC-F017-052, TC-F017-002
**Зависимости:** TASK-F017-006

### TASK-F017-015: Frontend — real-time статусы агентов в группах
**Приоритет:** P1 · **Статус:** pending
**Цель:** SSE-обновление статусов на странице групп.
**Файлы:** `frontend/src/pages/telephony/UserGroupsPage.tsx`, `frontend/src/pages/telephony/UserGroupDetailPage.tsx`
**Трогать нельзя:** `useRealtimeEvents.ts` (использовать, не менять)
**Результат:** подписка на agent.status.changed; статусы обновляются без reload; индикатор достижимости группы.
**Acceptance:** TC-F017-043, TC-F017-051
**Зависимости:** TASK-F017-003, TASK-F017-012

### TASK-F017-016: Frontend — состояние по расписанию + timezone
**Приоритет:** P2 · **Статус:** pending
**Цель:** "Open now / Closed — opens Mon 9:00" по timezone группы.
**Файлы:** `frontend/src/pages/telephony/UserGroupDetailPage.tsx`, `frontend/src/pages/telephony/UserGroupsPage.tsx`
**Результат:** расчёт по timezone; timezone-fallback на company.
**Acceptance:** TC-F017-053
**Зависимости:** TASK-F017-012

### TASK-F017-017: Frontend — Operations Dashboard по группам
**Приоритет:** P2 · **Статус:** pending
**Цель:** Активные звонки по группам + Transfer.
**Файлы:** `frontend/src/pages/telephony/OperationsDashboardPage.tsx`, backend transfer endpoint (если нужен)
**Acceptance:** TC-F017-070, TC-F017-071
**Зависимости:** TASK-F017-004

### TASK-F017-018: Routing Logs — фильтр по группе + путь flow
**Приоритет:** P3 · **Статус:** pending
**Файлы:** `frontend/src/pages/telephony/RoutingLogsPage.tsx`, `backend/src/routes/*` (routing logs)
**Acceptance:** TC-F017-072, TC-F017-073
**Зависимости:** TASK-F017-004

### TASK-F017-019: Backend tests
**Приоритет:** P0 · **Статус:** pending
**Файлы:** `tests/services/callFlowRuntime.test.js`, `tests/services/agentPresence.test.js`, `tests/routes/userGroups.test.js`, `tests/routes/phoneNumbers.test.js`, `tests/routes/voice.test.js`, `tests/webhooks/voiceInbound.test.js`
**Результат:** покрытие middleware (401/403), изоляции company, всех P0/P1 кейсов.
**Зависимости:** TASK-F017-001..009

### TASK-F017-020: Frontend tests + changelog/docs
**Приоритет:** P1 · **Статус:** pending
**Файлы:** frontend unit-тесты, `docs/changelog.md`, `docs/project-spec.md`
**Зависимости:** TASK-F017-010..016

---

**Волны исполнения F017:**
- **Волна 0:** TASK-F017-001 (миграция — блокирует всё)
- **Волна 1 (parallel):** 002 (groupRouting), 003 (agentPresence)
- **Волна 2:** 004 (callFlowRuntime — зависит от 002,003)
- **Волна 3 (parallel):** 005 (/my), 006 (assign), 007 (blanc-numbers), 013 (strategy UI), 012 (detail no-mock)
- **Волна 4:** 008 (inbound), 009 (dial-action) — ядро маршрутизации
- **Волна 5 (parallel):** 010 (gating), 011 (caller-id), 015 (sse status)
- **Волна 6 (parallel, P2/P3):** 014, 016, 017, 018
- **Волна 7:** 019 (backend tests), 020 (frontend tests + docs)

**P0-срез (минимальный разблокирующий):** 001 → 002,003 → 004 → 005,012,013 → 008,009 → 010 → 019.

---

## CRM-SALES-MCP Cross-stage Audit

**Status:** done

### TASK-CRM-MCP-AUDIT-001: Verify implemented stages are aligned

**Files checked/updated:**
- CRM/MCP backend modules under `backend/src/services`, `backend/src/routes`, `backend/src/db`, and `backend/src/cli`.
- CRM migrations `088`, `089`, `090`.
- CRM/MCP tests under `tests/routes`, `tests/services`, `tests/db`, and `tests/cli`.
- CRM/MCP documentation sections.

**Expected result:**
Stage 0 CRM core, Stage 1 MCP backend adapter, Stage 2 transports, Stage 3 read-only tools, and pipeline/forecast analytics use the same tenant/auth/write/audit/error contracts. Required typed MCP arguments reject `null`; nullable typed write values remain allowed only for explicit field clearing.

**Verification:**
`npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

### TASK-CRM-MCP-005: Stage 4 write MCP tools

**Files checked/updated:**
- `backend/src/services/crmMcpToolRegistry.js`
- `backend/src/services/crmMcpToolExecutor.js`
- `backend/src/services/crmMcpSchemaValidator.js`
- `backend/src/services/crmDealsService.js`
- CRM/MCP route, registry, schema validator, and deal service tests.

**Expected result:**
Field-specific write MCP tools exist for the allowed update surface only: `deal.next_step`, `deal.stage`, `deal.forecast_category`, `deal.close_date`, `deal.amount`, `deal.risk_summary`, `deal.competitor`, and `task.status`. Every write checks tenant context, `sales.crm.write`, explicit confirmation, allowlist, returns before/after, generates or propagates request id, and writes audit. Generic deal write validates `value` against the selected allowlisted field. Create task/note write tools return before/after envelopes. No bulk/delete MCP tools are registered.

**Verification:**
`npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

### TASK-CRM-MCP-006: Stage 5 Sales workflow selections

**Files checked/updated:**
- `backend/src/services/crmListsService.js`
- `backend/src/services/crmMcpToolRegistry.js`
- `backend/src/services/crmMcpToolExecutor.js`
- CRM/MCP route, registry, schema validator, and list service tests.
- `docs/specs/CRM-SALES-MCP-006-sales-workflow-selections.md`
- `docs/test-cases/CRM-SALES-MCP-006-sales-workflow-selections.md`

**Expected result:**
MCP exposes ready-made read-only Sales workflow selections through `crm.list_sales_workflows`, `crm.get_sales_list`, and explicit alias tools for my open deals, closing this month/quarter, deals without activity, deals without next step, risky deals, top accounts by pipeline, accounts needing follow-up, contacts missing role/title/email, and tasks due this week. Workflow defaults and date windows are centralized in `crmListsService`; unsupported keys return allowed values.

**Verification:**
Full run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

### TASK-CRM-MCP-007: Stage 6 testing and rollout

**Files checked/updated:**
- `src/server.js`
- `backend/src/services/crmMcpResponse.js`
- CRM/MCP route, public transport, response sanitizer, query isolation, and server mount tests.
- `docs/specs/CRM-SALES-MCP-007-testing-rollout.md`
- `docs/test-cases/CRM-SALES-MCP-007-testing-rollout.md`

**Expected result:**
CRM REST and authenticated MCP routes are mounted behind auth and tenant middleware; public MCP is token-gated and fail-closed. The minimum rollout suite covers 401/403 behavior, tenant isolation, write allowlist, before/after audit, no delete tools, secret redaction, slippage/history calculations, stale activity queries, and predefined Sales workflow lists.

**Verification:**
Full rollout run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

# ALB-100: Albusto Commercial Platform Program — Task Breakdown

**Migration range:** 097
**Specs:** docs/specs/ALB-100-platform-program.md

### TASK-ALB-001: CI tenant-safety sanitizer (ALB-105)
**Status:** done (2026-06-12, night autorun)
Files: tests/tenantSafetyLint.test.js — NEW

### TASK-ALB-002: Provider bridge UI (ALB-104)
**Status:** done (2026-06-12, night autorun)
Files: frontend/src/components/admin/FieldTechSection.tsx — NEW;
frontend/src/pages/CompanyUsersPage.tsx (+ data hook) — wire section

### TASK-ALB-003: HARDENING-002 — calls (ALB-103)
**Status:** done (2026-06-12, night autorun)
Files: src routes for calls + query modules — permission reports.calls.view,
tenant scope, provider scope

### TASK-ALB-004: HARDENING-002 — messaging/conversations (ALB-103)
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-005: HARDENING-002 — leads (ALB-103)
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-006: HARDENING-002 — email (ALB-103)
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-007: Migration 097 — phone_otp + trusted_devices + companies geo fields (ALB-101)
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-008: otpService + publicAuth router (signup, otp, places proxy) (ALB-101)
**Status:** done (2026-06-12, night autorun)
Files: backend/src/services/otpService.js — NEW;
backend/src/routes/publicAuth.js — NEW; backend/src/services/googlePlacesService.js — NEW;
src/server.js — mount /api/public

### TASK-ALB-009: platformCompanyService.bootstrapCompany + onboarding endpoint (ALB-101/102)
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-010: Platform companies API + SuperAdminPage Companies tab (ALB-102)
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-011: Trusted-device 2FA (authenticate hook + /api/auth/trust-device + frontend OTP modal) (ALB-101)
**Status:** pending — flag FEATURE_SMS_2FA default off

### TASK-ALB-012: Auth pages: /signup /signin /verify-phone /onboarding (ALB-101)
**Status:** partial — signup/onboarding pages done; custom /signin deferred (Keycloak hosted login stays this iteration)
Albusto brand, Blanc design tokens, Google Places autocomplete

### TASK-ALB-013: super_admin migration: /api/admin/* → requirePlatformRole; create-platform-admin script (ALB-106a)
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-014: Albusto rebranding of visible UI strings (ALB-106b)
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-015: Tests per test-cases doc; full suite green
**Status:** done (2026-06-12, night autorun)

### TASK-ALB-016: Multi-tenant telephony — Twilio subaccounts (ALB-107)
**Status:** done (2026-06-12) — core; phase 2 items in requirements roadmap
Files: migration 098, services/telephonyTenantService.js, routes/telephonyNumbers.js,
webhooks signature multi-account, inboxWorker AccountSid attribution,
PhoneNumbersPage (connect/buy/release), tests/telephonyTenantService.test.js

### TASK-ALB-017: ALB-107 phase 2 — A2P 10DLC, softphone per tenant, usage
**Status:** done (2026-06-12)
Files: migration 099, services/a2pService.js, telephonyTenantService (softphone/usage),
voiceService.generateTokenForCompany, routes/telephonyNumbers (usage/softphone/a2p),
PhoneNumbersPage (usage chip, A2P banner+wizard), tests

---
# AUTO-001: Automation/Rules Engine E2E — Tasks
- TASK-AUTO-01: eventCatalog.js + GET /catalog endpoint + is_system column (migration 102)
- TASK-AUTO-02: agentHandlers.js (mcp_tool/summarize_thread/noop) + agentWorker.js + boot wiring
- TASK-AUTO-03: agent-tasks list + retry endpoints
- TASK-AUTO-04: rulesSeed.js + POST /rules/seed-defaults; emit sms.inbound/call.missed; FEATURE_RULES_ENGINE_AR gate
- TASK-AUTO-05: frontend AutomationPage + RuleEditor + RuleRunsPanel + automationApi + route/nav
- TASK-AUTO-06: tests per test-cases; full suite green

---
# BILLING-UI — Tasks
- [x] TASK-BILL-01: migration 103 (billing_plans.included_units) + billingService.getInvoices + GET /api/billing returns invoices + GET /invoices — DONE (migration idempotent on prod-schema copy)
- [x] TASK-BILL-02: routes/billingWebhook.js (raw body, no auth) + mount in src/server.js before json + degraded-mode checkout 422 — DONE (also hardened stripeProvider.parseWebhook against length-mismatch RangeError)
- [x] TASK-BILL-03: bootstrapCompany → startTrial (idempotent, non-blocking) — DONE
- [x] TASK-BILL-04: frontend BillingPage + billingApi + route /settings/billing + nav — DONE (Blanc design system, no technical IDs)
- [x] TASK-BILL-05: tests per test-cases; full suite green — DONE (tests/billingUI.test.js, 8/8; no new regressions vs master)

---
# F018: Stripe Payments Marketplace (STRIPE-PAY-001 Phases 1–2) — Tasks

Spec: docs/specs/STRIPE-PAY-001-IMPL-phases-1-2.md · Tests: docs/test-cases/STRIPE-PAY-001.md
Order = dependency order. Each task ≤3 files, isolated, testable. All new API routes:
`authenticate, requireCompanyAccess`; company_id ← `req.companyFilter?.company_id`; all
SQL filtered by company_id; foreign entity_id → 404.

### TASK-STRIPE-01: DB migrations 107–110 + marketplace seed wiring
**Цель:** Создать `stripe_connected_accounts` (107), `stripe_payment_sessions` (108),
`stripe_webhook_events` (109), seed `stripe-payments` app (110) + ledger idempotency
index. Зарегистрировать 110 seed в ensureMarketplaceSchema.
**Файлы:** backend/db/migrations/107..110_*.sql (NEW); backend/src/db/marketplaceQueries.js (EDIT, +110 seed).
**Нельзя трогать:** существующие миграции, backend/db schema вне новых файлов.
**Результат:** миграции идемпотентны (IF NOT EXISTS / ON CONFLICT), таблицы созданы,
плитка stripe-payments появляется в marketplace. partial unique index на
payment_transactions(company_id, external_id) WHERE external_source='stripe'.
**Зависимости:** —. **Статус:** done

### TASK-STRIPE-02: stripeConnectProvider.js (REST client)
**Цель:** zero-SDK REST: createAccount (v2 direct charges, no app fee), createAccountLink,
getAccount(map flags/requirements/capabilities), createCheckoutSession (Stripe-Account
header, idempotency key), retrieveCheckoutSession, parseConnectWebhook (HMAC verify via
STRIPE_CONNECT_WEBHOOK_SECRET, length-safe).
**Файлы:** backend/src/services/stripeConnectProvider.js (NEW).
**Нельзя трогать:** backend/src/services/billing/stripeProvider.js (платформенный).
**Результат:** изолированный provider; unit-тестируемый парс webhook.
**Зависимости:** —. **Статус:** done

### TASK-STRIPE-03: stripePaymentsQueries.js (DB access)
**Цель:** CRUD по 3 таблицам; lookup connected account по company_id и по
stripe_account_id (с последующей company-scope verify); session upsert/find-open;
webhook event insert ON CONFLICT DO NOTHING.
**Файлы:** backend/src/db/stripePaymentsQueries.js (NEW).
**Результат:** все запросы фильтруют по company_id; данные изолированы.
**Зависимости:** после 01. **Статус:** done

### TASK-STRIPE-04: stripePaymentsService.js — onboarding & status
**Цель:** getStatus/connect/getOnboardingLink/refreshStatus/disconnect + readiness state
machine + gating helper. connect создаёт marketplace installation (provisioning_mode none).
**Файлы:** backend/src/services/stripePaymentsService.js (NEW); может звать marketplaceService.
**Результат:** readiness переходы соответствуют спеке §5; disconnect сохраняет историю.
**Зависимости:** после 02, 03. **Статус:** done

### TASK-STRIPE-05: routes/stripePayments.js + mount (settings API)
**Цель:** GET /status, POST /connect, /onboarding-link, /refresh-status, /disconnect.
Mount в src/server.js: `app.use('/api/stripe-payments', authenticate,
requirePermission('tenant.integrations.manage'), requireCompanyAccess, router)`.
**Файлы:** backend/src/routes/stripePayments.js (NEW); src/server.js (EDIT mount-only).
**Результат:** 401 без auth, 403 без права; tenant-изоляция.
**Зависимости:** после 04. **Статус:** done

### TASK-STRIPE-06: invoice payment-link service + routes
**Цель:** ensurePaymentLink/getPaymentLink/sendPaymentLink в stripePaymentsService;
эндпоинты POST/GET /api/invoices/:id/stripe-payment-link, POST .../send-payment-link в
routes/invoices.js. Reuse валидной open-сессии (FR-004); gating; чужой invoice → 404.
**Файлы:** backend/src/routes/invoices.js (EDIT); backend/src/services/stripePaymentsService.js (EDIT).
**Результат:** ссылка отражает текущий balance; send пишет invoice_event; perms
payments.collect_online (write)/payments.view (read).
**Зависимости:** после 04, 01. **Статус:** done

### TASK-STRIPE-07: webhook route + ledger sync
**Цель:** routes/stripePaymentsWebhook.js (raw body, no auth, signature verify,
idempotent по stripe_event_id); handleWebhook dispatch → paymentsService.createTransaction
(идемпотентно external_source='stripe'); invoice через canonical path; tenant-scope
verify по stripe_account_id. Mount в src/server.js ДО express.json, отдельно от billing.
**Файлы:** backend/src/routes/stripePaymentsWebhook.js (NEW); backend/src/services/stripePaymentsService.js (EDIT); src/server.js (EDIT mount-only); backend/src/services/paymentsService.js (EDIT: stripe-idempotent createTransaction).
**Результат:** один ledger row на платёж; failed → нет completed row; дубли deduped;
чужой account → reject без мутации.
**Зависимости:** после 04, 06. **Статус:** done

### TASK-STRIPE-08: public Pay now endpoints
**Цель:** GET /api/public/invoices/:token/pay-info, POST /api/public/invoices/:token/pay
в public-invoices.js (no auth, token credential, opaque, без internal ids, regex guard).
**Файлы:** backend/src/routes/public-invoices.js (EDIT); backend/src/services/stripePaymentsService.js (EDIT, pay-by-token reuse).
**Результат:** pay-info отдаёт summary+balance; pay создаёт/reuse session → url; paid/
unavailable states.
**Зависимости:** после 06. **Статус:** done

### TASK-STRIPE-09: frontend settings page + API client + marketplace card + route
**Цель:** StripePaymentsSettingsPage.tsx (по VapiSettingsPage), stripePaymentsApi.ts,
плитка stripe-payments в IntegrationsPage (navigate + бейджи), route в App.tsx
(guard tenant.integrations.manage).
**Файлы:** frontend/src/pages/StripePaymentsSettingsPage.tsx (NEW), frontend/src/services/stripePaymentsApi.ts (NEW), frontend/src/pages/IntegrationsPage.tsx (EDIT), frontend/src/App.tsx (EDIT).
**Нельзя трогать:** authedFetch.ts, MarketplaceConnectDialog (не менять).
**Результат:** checklist + readiness panels + actions; Blanc design; TS strict.
**Зависимости:** после 05. **Статус:** done

### TASK-STRIPE-10: frontend invoice surfaces (Collect vs offline, send dialog, public)
**Цель:** InvoiceDetailPanel — split Collect payment / Record offline; readiness banner;
active link + latest attempt; invoice send dialog Include-payment-link toggle; public
Pay now page/redirect.
**Файлы:** frontend/src/components/invoices/InvoiceDetailPanel.tsx (EDIT) + invoice send dialog + public invoice page (≤3 логических узла, разнести при необходимости).
**Результат:** flows из spec §4; deferred actions (card/tap) показаны disabled.
**Зависимости:** после 06, 08, 09. **Статус:** done

### TASK-STRIPE-11: tests per test-cases; full suite green
**Цель:** Jest по docs/test-cases/STRIPE-PAY-001.md — все P0 + посильные P1; включая
RBAC 401/403, изоляцию, webhook signature+idempotency, tenant-scope, session reuse,
balance transitions, degraded mode. Регрессия billing/payments не падает.
**Файлы:** tests/stripePayments*.test.js (NEW).
**Результат:** новые suites зелёные; существующие suites без регрессий.
**Зависимости:** после 05–10. **Статус:** done

---
# F018 Phases 3–5 — Tasks (done 2026-06-14)

- TASK-STRIPE-12: migration 112 (payments.collect_keyed/collect_terminal seed) + dev-mode list — done
- TASK-STRIPE-13: provider methods createPaymentIntent/createConnectionToken/createTerminalLocation/createTerminalPaymentIntent/cancelPaymentIntent/createRefund — done
- TASK-STRIPE-14: migration 111 stripe_terminal_locations + terminal queries — done
- TASK-STRIPE-15 (Phase 3): service createManualCardSession + invoice/job stripe-manual-card-session routes (payments.collect_keyed) — done
- TASK-STRIPE-16 (Phase 4): service getConnectionToken/createTapToPayIntent/cancelTerminalIntent + routes/stripeTerminal.js + invoice/job tap-to-pay routes (payments.collect_terminal); NFC client BLOCKED (mobile shell) — backend done
- TASK-STRIPE-17 (Phase 5): refundStripePayment + applyStripeRefund + webhook charge.refunded/charge.dispute.created + POST /api/payments/:id/stripe-refund — done
- TASK-STRIPE-18 (Phase 5 reporting): listTransactions source filter + payments route + TransactionsPage Source filter + stripe-aware refund routing — done
- TASK-STRIPE-19 (Phase 3 FE): loadStripe util + ManualCardDialog (Payment Element) wired into Collect menu — done
- TASK-STRIPE-20 (follow-ups): public /pay/:token page (PUBLIC_AUTH_PATHS) + InvoiceSendDialog Include-payment-link toggle — done
- TASK-STRIPE-21: tests extended to 26 (manual card, terminal token, refund flow + idempotency) — done
# SCHED-ROUTE-001 — Schedule Routes & Address Management (backend foundation)
Spec: docs/specs/SCHED-ROUTE-001-route-scheduling.md (+ Binding Corrections C-1..C-13).

- [x] SR-01 (Ф1): migration 107 — jobs geocoding cols; schedule_route_segments (technician_id=crm_users.id, company-scoped, partial-unique idempotency idx); route_calculation_cache (GLOBAL). Idempotent, verified on prod-schema copy.
- [x] SR-02 (Ф2/Ф3 core): backend/src/services/routeGeo.js — pure helpers: roundCoord/buildCacheKey (C-4), mapGeocodeConfidence (C-5), googleMapsUrl generated (C-6), companyDay tz-aware (C-3), computeAffectedPairs (insert/remove/reassign/address-change). 16 unit tests green.
- [x] SR-03 (Ф2): googlePlacesService.geocodeAddress() — Geocoding API, confidence signals, env-key only.
- [x] SR-04 (Ф1.5): backend/src/db/routeQueries.js — tenant-safe segment upsert/markStale/read + GLOBAL cache get/put (by cache_key). All SQL company_id-scoped except cache (global by design, C-4).
- [x] SR-05 (Ф3): backend/src/services/routeDistanceService.js — Distance Matrix API (driving, no departure_time), BATCH adjacent pairs per tech/day in one call (C-8), cache-first (cache hit → no Google call). Mockable fetch.
- [x] SR-06 (Ф3): backend/src/services/routeSegmentService.js — recalc orchestration: build per-tech/day sequences from jobs (order start_date ASC, created_at DESC; exclude Canceled/Job is Done; company-tz day; fan-out by assigned_provider_user_ids), computeAffectedPairs, mark stale + upsert pending/missing_address/address_needs_review, enqueue route_calc.
- [x] SR-07 (Ф2/Ф3): agentHandlers — add agent_type 'job_geocode' (geocode → persist on jobs, then trigger recalc) and 'route_calc' (cache-first → Distance Matrix batch → upsert segments). Reuse agentWorker (FOR UPDATE SKIP LOCKED). Idempotent.
- [x] SR-08 (Ф4): jobsService.createJob manual path + PATCH route-affecting edit; scheduleService.createFromSlot(entity_type='job') (currently 501); detect route-affecting change set; enqueue job_geocode (skip if coords supplied & address unchanged) + recalc; ZB best-effort create under FEATURE_ZENBOOKER_SYNC with dedupe guard (store zenbooker_job_id, never rollback local on ZB fail).
- [x] SR-09 (Ф5): scheduleQueries — make day-filter tz-aware (C-3); expose job address fields (lat,lng,normalized_address,geocoding_status,address) + generated google_maps_url. GET /api/schedule/route-segments?from&to&technician_id — authenticate+requireCompanyAccess+requirePermission('schedule.view'), PF007 provider scope (assignedOnly→own crm_user technician_id). NO Google calls on read.
- [x] SR-10 (Ф7): migration/script backfill — geocoding_status='success' where lat/lng present (no paid call) else 'not_geocoded'; seed segments today+future only.
- [x] SR-11 (Ф6 frontend): clickable Google Maps address (job card + details, stopPropagation); route connectors in timeline/timeline-week/list (status→text); pending/error/stale states; AddressAutocomplete in create/edit; no client-side Google route calls.
- [x] SR-12 (Ф7 tests): integration tests — cache hit/miss, Google fail→Route unavailable, address change, reassign, insert/remove, multi-tech, company-tz day, provider-scope, idempotency (no dup active segment), tenant isolation, schedule-read makes no Google calls.
- [x] SR-13 (gap, FR-002): edit job service address/coords in Albusto — `PATCH /api/jobs/:id/location` + `updateJobLocation` (sets geocoding_status, async geocode when no coords, recalc with before-tech-days); `/:id/coords` now recalc-aware. Inline AddressAutocomplete editor in job detail.
- [x] SR-14 (gap, FR-001.4/C-2): assign technician on create-from-lane — NewJobModal passes the lane provider (ZB shape); `createManualJob` resolves the internal crm_users.id mirror so routing + grouping align.
- [x] SR-15 (gap, C-12/FR-001.4): ZenBooker best-effort sync — flag `FEATURE_ZENBOOKER_SYNC` (default ON), async `zb_job_sync` agent (dedupe-guarded, one-shot, saves zenbooker_job_id, never rolls back local job), migration 109 `jobs.zb_sync_status`.
- [x] SR-16 (gap, C-13): route data retention — `purgeStaleSegments(>30d)` + `pruneRouteCache(>180d)` + `scripts/purge-route-data.js` (--dry-run). Units still mi-only (no company unit field yet) — documented follow-up.

## NOTES-001 — Unified Notes (edit / soft-delete / attachment edit / audit) — DONE (2026-06-25)
- [x] T1 Migration 124 — stable note ids + `note_attachments.note_id` (idempotent backfill)
- [x] T2 `notesMutationService` (canMutateNote / editNote / softDeleteNote)
- [x] T3 Stamp `id` + `created_by` on note creation (jobs/leads/contacts)
- [x] T4–T6 PATCH + DELETE note endpoints for jobs/leads/contacts (perm + ownership/admin gate)
- [x] T7 eventService `note_edited`/`note_deleted` + history filters deleted notes
- [x] T8 GET notes exclude soft-deleted; attachments grouped by `note_id`
- [x] T9 `noteAttachmentsService` note_id on create + targeted delete + cap
- [x] ZB merge preserves local edits/deletes/ids
- [x] T10 `NotesSection` kebab + edit mode (text + attachment ✕/add) + delete
- [x] T11 `HistorySection` icons for edited/deleted
- [x] T12 Delete dead `StructuredNotesSection` + `JobNotesSection`; extract `JobDescription`
- [x] T13 Jest suites `notesAuthz` + `notesEditDelete` (13 cases, green)

## SLOT-ENGINE-001 Phase 2+3 — Albusto integration — DONE (2026-06-25)
- [x] T1 Migration 125 technician_base_locations
- [x] T2 Migration 126 seed smart-slot-engine app (+ marketplaceQueries replay list)
- [x] T3 technicianBaseLocationQueries
- [x] T4 technicianBaseLocationsService (roster merge + geocode-on-save)
- [x] T5 base-location routes (GET/PUT/DELETE) + server.js registration
- [x] T6 marketplaceService.isAppConnected gating helper
- [x] T7 slotEngineService (snapshot assembly + engine call + safe-failure)
- [x] T8 proxy POST /api/schedule/slot-recommendations (gated, schedule.dispatch)
- [x] T9-T11 FE slotRecommendationsApi + technicianBaseLocationsApi
- [x] T10 base-location editor on /settings/technicians
- [x] T12/T13 CustomTimeModal cards + apply + timeline highlights
- [x] T14 Jest (34) + schedule regression (48) + FE build

## SLOT-ENGINE-001 — UX polish tasks (2026-06-25)

UX/copy/a11y polish over merged SLOT-ENGINE-001. **HARD scope — exactly three files:**
`slot-engine/src/engine.js`, `frontend/src/components/conversations/CustomTimeModal.tsx`,
`frontend/src/components/conversations/CustomTimeModal.css`.
Spec: `docs/specs/SLOT-ENGINE-001-UX-POLISH.md` · Requirements: SE-UX-1..7 / AC-1..16 ·
Architecture: `docs/architecture.md` → "SLOT-ENGINE-001 UX polish — design notes (2026-06-25)" ·
Test cases: `docs/test-cases/SLOT-ENGINE-001-UX-POLISH.md` (EXP-01..12 automated; MAN-01..16 manual).

**Global constraints (apply to every task below):**
- **No engine/API/DB/route/tenant change.** No new files/components/deps (sole exception: PT-2's new test file). No scoring/ranking/feasibility/config/output-contract change — `explanation` stays a `string`; `score`/`confidence` are read, never written.
- **No protected-file edits:** `src/server.js`, `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, `backend/db/` are untouched (none are in scope anyway).
- **Albusto naming:** no user-facing "Blanc"; do **not** rename `--blanc-*` tokens or `Blanc*`/internal identifiers (`__suggested`, `--suggested`, `isSuggested` stay).
- **Protected invariant — reschedule/edit path byte-for-byte unaffected.** `isNewJob = !initialSlot && !excludeJobId`; when false the recs effect early-returns, `recsEnabled`/`showRecPanel` stay false, no temp-bar/panel/empty-state/overlay render, no fetch fires. Every visible change is reachable only on the new-job path. The single shared change is the preselected-tech pill label "Suggested"→"Preselected" (label-only, no behavioral diff). Verify via MAN-15.

---

### PT-1: Engine `explain(m)` clean English builder (P0)

**Files:** `slot-engine/src/engine.js` (explain only).
**ACs:** AC-1, AC-2 (+ enables AC-3, AC-7).

**Goal:** Rewrite `explain` (engine.js:293) to a terse positives-only English phrase-bank;
simplify the signature `explain(win, date, tech, m)` → `explain(m)` and update the **single** call site
in `recommendSlots` (engine.js:190) to pass only `metrics`. **Add `explain` to `module.exports`**
(engine.js:336) so it is unit-testable.

**Behavior (per spec §1):** build `bits: string[]` in this exact order, mirroring `reasonCodes` thresholds (inclusive):
- `nearest_existing_job_distance_miles != null && <= 5` → `tech already working nearby`
- `extra_travel_minutes <= 15` → `little extra driving`
- `route_slack_minutes >= 30` → `comfortable schedule gap`

Join non-empty bits with `" · "` (space · middot U+00B7 · space). If `bits.length === 0`, return the
constant `Good fit for this route`. Positives only — **no** date/time/window/tech-name prefix, **no**
Russian, **no** snake_case, **no** risk/approx-address text (`geo_confidence` has zero effect on output —
the approx-address signal lives exclusively on the card dispatch flag in PT-3). Never return `''`/null/undefined.

**Constraints:** no other engine function touched; thresholds/boundary directions unchanged; the only
non-explain edit is the `module.exports` line + the one call-site arg change.

**Acceptance check:** call site at :190 passes only `metrics`; `explain` exported; manual phrase-bank
examples match spec §1 ("all three" / "only slack" / "none → fallback"). Green confirmed by PT-2.

**Status:** pending

---

### PT-2: Engine `explain` unit tests (P0)

**Files:** `slot-engine/test/explain.test.js` (NEW — the one allowed new file; `node --test` style, matching `engine.test.js`/`scenarios.test.js`).
**ACs:** AC-3 (shape-only) + verifies AC-1, AC-2.

**Goal:** Implement EXP-01..12 from the test-cases doc as plain `node --test` cases importing `explain`
directly from `engine.js` (relies on PT-1's export). Include the reusable forbidden-content guard
(no Cyrillic `/[Ѐ-ӿ]/`, no snake_case `/[a-z]+_[a-z]/`, no `YYYY-MM-DD`, no `HH:MM`, none of
`технік`/`Риск`/`Плюсы`; ASCII-only except the `·` separator). Cover: all-three join + order (EXP-01),
fallback constant (EXP-02, EXP-08), single-phrase paths (EXP-03/04/05), low-geo positives-only (EXP-07),
inclusive thresholds `=5`/`5.1`, `=15`/`15.1`, `=30`/`29.9` (EXP-09/10), `null` distance (EXP-11), and the
suite-level regression guard EXP-12 (full `node --test` green ≥26 prior cases; every `recommendations[*].explanation`
is a non-empty string; no literal/Russian explanation assertion anywhere).

**Constraints:** do **not** assert literal explanation copy in legacy suites (AC-3 keeps engine assertions
shape-only); do not modify `engine.test.js`/`scenarios.test.js` except as EXP-12 confirms they already pass.

**Acceptance check:** `node --test` in `slot-engine/` green; new file holds EXP-01..12.

**Dependencies:** after PT-1.

**Status:** pending

---

### PT-3: CustomTimeModal.tsx — temp-bar, removals, vocabulary, empty-ladder, arrows, a11y, no-emoji (P1/P2/P3)

**Files:** `frontend/src/components/conversations/CustomTimeModal.tsx`.
**ACs:** AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-13, AC-15, AC-16.

**Goal (per spec §2–§8):**
- **Temp-bar + helper (SE-UX-2/AC-4,5):** add module-local pure `tempFromRec({ score, confidence })` beside
  `parseHHMM`/`recToSlotDates` → `{ fillPct, colorVar, label }`; `fillPct = clamp(round(score),0,100)`;
  color/label by tier: high→`var(--blanc-success, #1b8b63)`/`Best match`, medium→`var(--blanc-job, #2f63d8)`/`Good fit`,
  low(+unknown)→`var(--blanc-warning, #b26a1d)`/`Worth a look`. Render `<span className="ctm-rec-card__temp" aria-hidden>`
  with inner `__temp-fill` (inline `height`/`background`) as the **first** child of the rec card, before `__top`.
  Card `<button>` gets `title` + `aria-label` = `` `${label} · score ${Math.round(rec.score)}` `` (only place the raw score lives).
- **Remove from face (AC-5,6):** delete `<span className="ctm-rec-card__score">` (:787) and
  `<span className="ctm-rec-card__confidence">` (:794). Replace `Dispatch confirm` (:796) with `Approx. address — confirm`
  (en-dash, lowercase "confirm"), kept on `.ctm-rec-card__flag`, rendered **only** when `rec.requires_dispatch_confirmation`
  truthy; render flag conditionally so no empty `__meta` row shows.
- **Sub-text fallback (AC-7):** add module-top `const REC_FALLBACK_REASON = 'Good fit for this route';`; replace
  `rec.explanation || rec.reason_codes?.[0]` (:773) with `rec.explanation || REC_FALLBACK_REASON` (snake_case fallback removed).
- **Vocabulary (AC-8,9):** header "Suggested times" (:759) → "Recommended times"; copied-tech pill "Suggested" (:830) →
  "Preselected"; engine pill "Recommended" (:833) unchanged. Update lane comments to "Preselected"; **do not** rename classes/props.
- **Empty ladder (AC-10,11):** `showRecPanel` (:674) → `isNewJob && (recsLoading || recsEnabled)`. Render an if/else chain in
  order: Loading → Unavailable → **Empty** (`No nearby openings — try another day`, en-dash, when
  `recsEnabled && !recsLoading && !recsUnavailable && recs.length === 0`) → List. Header always on top.
- **Pagination arrows (AC-13):** replace both raw `<button className="ctm-tech-bar__arrow">` (:815, :841) with
  `<Button variant="ghost" size="icon" className="ctm-tech-bar__arrow">` (already imported); keep the class (24px), keep
  ChevronLeft/Right and exact disabled logic (`techPage===0` / `techPage >= totalPages-1`).
- **Overlay band a11y (AC-15):** on `tech-timeline__rec-band` (:289) add `role="button"`, `tabIndex={0}`,
  `onKeyDown` (Enter/Space → preventDefault + stopPropagation + `onApplyRec?.(rec)`), and
  `aria-label={`Recommended ${start}–${end}`}` (en-dash); keep existing onClick + title.
- **No emoji (AC-16):** strip `🕓 ` (:473) and `🔧 ` (:474) prefixes from the map info-window HTML; keep time/service text and the inline `#6b7280` colors (Google InfoWindow scope, not Albusto CSS).

**Constraints:** keep the protected invariant (all visible changes new-job-only; preselected pill is the lone shared
label change). No unused vars after removing score/confidence spans (prod build is strict — `tempFromRec`/`REC_FALLBACK_REASON`
must be referenced). No token renames; CSS class names unchanged.

**Acceptance check:** MAN-01..09, MAN-11, MAN-12, MAN-13 pass; `tsc -b` clean (see PT-5).

**Dependencies:** independent of PT-1/PT-2; pairs with PT-4 (same component). Do PT-3 **then** PT-4 (or one implementer does both — recommended, since they share the `.tsx`/`.css` pair and CSS classes added in PT-4 back the JSX in PT-3).

**Status:** pending

---

### PT-4: CustomTimeModal.css — temp-bar styles, warm tokens, dead-rule deletion (P2/P3)

**Files:** `frontend/src/components/conversations/CustomTimeModal.css`.
**ACs:** AC-12, AC-14 (+ backs AC-4 styling).

**Goal (per spec §2, §6, §8):**
- **Temp-bar styles (backs AC-4):** add `.ctm-rec-card__temp` (track: `position:absolute; left:6px; top:9px; bottom:9px;
  width:5px; border-radius:999px; background:var(--blanc-line, rgba(117,106,89,0.18)); overflow:hidden;`) and
  `.ctm-rec-card__temp-fill` (`position:absolute; left:0; right:0; bottom:0; border-radius:999px;` — height/background inline).
  Give `.ctm-rec-card` `position:relative` (if absent) and left padding for the bar: `padding: 9px 11px 9px 18px;`.
- **Warm-token swaps (AC-12):** apply the spec §6 table — `--muted-foreground`→`--blanc-ink-3`, `--border`→`--blanc-line`,
  overlay/legend backgrounds → `var(--blanc-surface-strong, #fffdf9)`, tech-bar arrow color → `--blanc-ink-2` — across the
  touched rules (date-nav trigger/hint, timelines empty/label, tech-timeline grid/hour-line, map border/overlay/legend, tech-bar arrow).
  **Drop the dead cold-slate hex fallbacks** in those rules: `#27303f`, `#0f172a`, `#1e293b`, `#334155`, `#64748b`, `#94a3b8`, `#e2e8f0`.
  **Keep** functional colors `#16a34a` (hover), `#ef4444` (now-line), `#d97706`/`#b45309` (amber); leave warm literal fallbacks already in place.
- **Delete dead CSS (AC-14):** remove `.ctm-timelines__footer`, `.ctm-timelines__dots`, `.ctm-timelines__dot`,
  `.ctm-timelines__dot--active`, `.ctm-timelines__legend`, `.ctm-timelines__legend-item`, `.ctm-timelines__legend-dot`
  (grep-confirm no JSX reference first). The `.ctm-rec-card__score`/`.ctm-rec-card__confidence` rules may also be deleted (now unreferenced after PT-3).

**Constraints:** no `--blanc-*` renames; only the listed cold-neutral fallbacks dropped; no change to functional colors or warm fallbacks.

**Acceptance check:** MAN-10, MAN-14 pass; temp-bar renders correctly with PT-3; `tsc -b`/build clean.

**Dependencies:** after PT-3 (coupled — same component pair). Recommend a single implementer for PT-3+PT-4.

**Status:** pending

---

### PT-5: Verification gate (P0)

**Files:** none (verification only).
**ACs:** build/regression gate for all of the above (MAN-16, EXP-12).

**Goal:** Confirm `npm run build` (`tsc -b`) is **green** from `frontend/` (prod-strict, noUnusedLocals — removed
score/confidence spans leave no unused vars; `tempFromRec`/`REC_FALLBACK_REASON` referenced) and `node --test` in
`slot-engine/` is **green** (≥26 prior + EXP-01..12). Record the manual checklist MAN-01..16 (incl. MAN-15 reschedule/edit
regression guard) for the orchestrator's live verification on the new-job path with the marketplace slot-engine app enabled.

**Acceptance check:** both build + engine suites green; MAN list handed to orchestrator.

**Dependencies:** after PT-1, PT-2, PT-3, PT-4.

**Status:** pending

---

**Order:** PT-1 → PT-2 → (PT-3 → PT-4, coupled — one implementer recommended) → PT-5.
PT-1/PT-2 (engine) and PT-3/PT-4 (frontend) are independent tracks and may proceed in parallel; PT-5 gates last.

---

## ONWAY-001 — tasks (2026-06-26)

> **Inputs:** `docs/specs/ONWAY-001.md` (authoritative) · `docs/requirements.md` → ONWAY-001 (OW-R1..R7 / AC-1..AC-12 / SC-01..06) · `docs/architecture.md` → "ONWAY-001 — design" · `docs/test-cases/ONWAY-001.md` (38 cases).
> **Feature:** From a Job card in a pre-visit status (`Submitted`/`Rescheduled`), a tech with `messages.send` taps a primary **"On the way"** CTA → modal does one `getCurrentPosition`, optionally computes a Google ETA → **"Notify client"** sends an outbound SMS (tech + company + ETA) into the customer conversation, **then** advances the job to a new **On the way** status. **Hard rule (AC-7): SMS first (primary success), status second (best-effort).**
> **Global constraints (every backend task):** new routes ride the EXISTING jobs router (already mounted in `src/server.js` behind `authenticate` + `requireCompanyAccess` — NO new mount); `requirePermission('messages.send')` on both endpoints; `company_id` ONLY from `req.companyFilter?.company_id` (NEVER `req.companyId`, never the body); job loaded company-scoped via `getJobById(id, companyId)` → cross-tenant/missing → **404**; SQL/data isolated per company. **Additive only** — no existing FSM state/transition removed or altered (protect FSM-001 §8); **no Zenbooker mapping** for the new status (`OUTBOUND_MAP`/ZB block untouched); wallet gate inside `sendMessage` stays the single SMS cost-enforcement point (no second check); English-only copy; do NOT conflate `On the way` (`blanc_status`) with ZB `en-route` (`zb_status`)/`markEnroute`/`/enroute`.

### TASK-ONWAY-1: Add "On the way" job status (FSM — migration + mirrors + color) (P0)

**Цель:** Introduce the new non-terminal `On the way` job status across all four FSM sources + the frontend color, kept convergent. Transitions: `Submitted→On the way`, `Rescheduled→On the way`, `On the way→Visit completed`, `On the way→Canceled`. State id `On_the_way` (SCXML), status name/label `On the way`, color `#0EA5E9`.

**Файлы, которые можно менять:**
- `backend/db/migrations/127_job_fsm_on_the_way.sql` (NEW) — idempotent SCXML injection into each company's active published `machine_key='job'` version, modeled EXACTLY on `095_add_review_lead_status.sql`. Guard `WHERE v.scxml_source NOT LIKE '%id="On_the_way"%'`. Two `replace()` passes: (A) insert the `<state id="On_the_way" blanc:label="On the way" blanc:statusName="On the way">` block (children `TO_VISIT_COMPLETED→Visit_completed`, `TO_CANCELED→Canceled`) immediately BEFORE the `<final id="Canceled" …/>` marker; (B) inject `<transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label="On the way" blanc:order="0" />` as first child of BOTH `<state id="Submitted" blanc:label="Submitted">` and `<state id="Rescheduled" blanc:label="Rescheduled">`. `IF new_scxml = scxml_source → RAISE NOTICE; CONTINUE`. Archive prior published row, INSERT `version_number+1` as `published` (`change_note='Add On the way status (ONWAY-001)'`, created_by/published_by `'system'`), repoint `fsm_machines.active_version_id`. (Optional `rollback_127_*.sql`.)
- `fsm/job.scxml` (EDIT) — add the same `On_the_way` state block + the two inbound `TO_ON_THE_WAY` transitions into `Submitted`/`Rescheduled`.
- `backend/db/migrations/073_seed_fsm_machines.sql` (EDIT) — same state + two inbound transitions inside the `$scxml_job$` heredoc, so a from-scratch DB already includes it (073 ⇄ 127 convergent; both running is safe via the `NOT LIKE` guard).
- `backend/src/services/jobsService.js` (EDIT, fallback map only) — append `'On the way'` to `BLANC_STATUSES`; in `ALLOWED_TRANSITIONS` add key `'On the way': ['Visit completed','Canceled']` and add `'On the way'` to the `'Submitted'` and `'Rescheduled'` arrays.
- `frontend/src/components/jobs/jobHelpers.tsx` (EDIT) — add `'On the way'` to the `BLANC_STATUSES` array (~lines 6–12) and `'On the way': '#0EA5E9'` to `BLANC_STATUS_COLORS` (~lines 16–22).
- A small **pure JS SCXML-transform helper** (per test-cases agent) — EXTRACT the two `replace()` passes into a unit-testable pure function (place beside the migration or a tiny module the migration/test can require, e.g. `backend/db/migrations/lib/injectOnTheWay.js`) so the transform is testable without a DB (consumed by TASK-ONWAY-3). The migration body calls it.

**Файлы, которые трогать нельзя:**
- `OUTBOUND_MAP` / the Zenbooker block in `jobsService.js` — On the way has no ZB mapping (Protected).
- Any existing `BLANC_STATUSES` entry, `ALLOWED_TRANSITIONS` key/target, or existing SCXML state/transition — additive only (FSM-001 §8 completeness).

**Покрывает AC:** AC-10 (new status in fallback map AND FSM seed/migration, non-terminal, sensible onward), AC-11 (rendered like any status; standard transition/audit path). Covers TC-FSM-001..005, the extracted-transform unit, and feeds TC-FE-010 (badge color).

**Ожидаемый результат:** Existing seeded tenants reach `On the way` via the DB graph after `127` runs; unseeded/fallback tenants reach it via the mirrored `ALLOWED_TRANSITIONS`; a from-scratch DB (073) already has it; `127` is idempotent and convergent with 073/`fsm/job.scxml`; the badge renders sky/cyan. No existing status/transition dropped; no ZB call added.

**Зависимости:** none (first).

**Статус:** pending

### TASK-ONWAY-2: Backend endpoints — `/eta/estimate` + `/eta/notify` (+ proxy resolver) (P0)

**Цель:** Add the two POST endpoints on the jobs router plus the server-side proxy-DID resolver. estimate = pure read (no SMS/status); notify = SMS-first then best-effort status.

**Файлы, которые можно менять:**
- `backend/src/routes/jobs.js` (EDIT) — add both routes + the `resolveCompanyProxyE164(companyId)` helper (decide home: route-local vs export from `conversationsService`; whichever ships, TASK-ONWAY-3 mocks that surface).
  - **`POST /api/jobs/:id/eta/estimate`** `requirePermission('messages.send')`: load job company-scoped (null→404); resolve dest = `job.lat`/`job.lng` (optionally geocode `job.address`); if no dest OR origin missing/invalid in body → `200 { eta_minutes:null, status:'unavailable' }`; else `routeDistanceService.computePair(origin, dest, 'driving')` → success→`{ eta_minutes: durationMinutes, status:'success' }` (also null durationMinutes → unavailable), `{status:'failed', errorCode:'NO_KEY'|<google>}`→`{ eta_minutes:null, status:'unavailable' }` (NON-error). `400` ONLY for a body that isn't an object. No SMS, no status change.
  - **`POST /api/jobs/:id/eta/notify`** `requirePermission('messages.send')`: validate `eta_minutes` integer 1–600 else `400 { ok:false, error:'invalid_eta' }`. Step order (§4.3): (1) load job company-scoped → null→404; (2) `customerE164 = job.customer_phone`; absent/blank → **422 NO_PHONE** (no side effects); (3) `techName = job.assigned_techs?.[0]?.name || null`, `companyName = (await companyQueries.getById(companyId))?.name || null`; (4) `proxyE164 = await resolveCompanyProxyE164(companyId)`; null → **422 NO_PROXY** (no side effects); (5) build `body` from the EXACT OW-R5 template (§3.1) — lead-in `` `Your technician ${techName} ` `` when a name exists else `` `Your technician ` `` (word "technician" stays, name omitted → no "your technician your technician"); `{company}` = companyName or literal `your service team`; `{eta}` = chosen integer; first tech only; (6) `conv = await conversationsService.getOrCreateConversation(customerE164, proxyE164, companyId)` + `await conversationsService.sendMessage(conv.id, { body, author:'agent' })` — throw → classify wallet (`code/httpStatus`→`WALLET_BLOCKED`, passthrough 402/403) vs generic (`SMS_FAILED`, 502/500); **status NOT changed**; (7) on send success → `await jobsService.updateBlancStatus(id, 'On the way', companyId)`; throws → catch → `200 { ok:true, warning:'status_not_advanced', conversation_id, eta_minutes }` (NO SMS rollback); succeeds → `200 { ok:true, status:'On the way', conversation_id, eta_minutes }`.
  - **`resolveCompanyProxyE164`** order (§4.5): (1) MRU `SELECT proxy_e164 FROM sms_conversations WHERE proxy_e164 IS NOT NULL AND company_id=$1 ORDER BY last_message_at DESC LIMIT 1`; (2) fallback `process.env.SOFTPHONE_CALLER_ID`; both null → null (route → 422 NO_PROXY). No live Twilio `incomingPhoneNumbers.list` on the hot path.

**Файлы, которые трогать нельзя:**
- `services/conversationsService.js`, `services/routeDistanceService.js`, `db/companyQueries.js` — reused UNCHANGED (except the optional `resolveCompanyProxyE164` export if that home is chosen).
- `walletService` / the wallet gate inside `sendMessage` — single enforcement point; do NOT add a second wallet check (Protected).
- `src/server.js` — jobs router already mounted; NO new mount. Do not touch `OUTBOUND_MAP`/ZB.

**Покрывает AC:** AC-2 (`messages.send` 403), AC-3/AC-4 (estimate ETA / graceful unavailable), AC-6 (SMS via `conversationsService`, outbound to timeline), AC-7 (SMS-first ordering; best-effort status; `status_not_advanced` warning; no rollback; SMS-fail → status unchanged), AC-8 (NO_PHONE before send; `__NOOP__`-safe idempotency server-side), AC-9 (exact SMS template incl. tech/company fallbacks), AC-12 (company_id from `req.companyFilter`; server-derived phone/proxy; cross-tenant→404). Scenarios SC-01..06; edges E1–E16.

**Ожидаемый результат:** Both endpoints respond per §4 contracts; SQL filters by company_id and is isolated between companies; cross-tenant/unknown id → 404; missing `messages.send` → 403; estimate never 5xx on NO_KEY/no-address (returns null/unavailable); notify enforces SMS-before-status with the exact best-effort/warning semantics; proxy resolved server-side (MRU→env→422).

**Зависимости:** after TASK-ONWAY-1 (the `On the way` status/transition must exist before `updateBlancStatus(id,'On the way')` is valid).

**Статус:** pending

### TASK-ONWAY-3: Backend tests — `tests/jobsEta.test.js` (P0)

**Цель:** Cover both endpoints + the fallback-map FSM units + the extracted SCXML-transform idempotency unit, all with mocked services (no live DB/Twilio/Google).

**Файлы, которые можно менять:**
- `tests/jobsEta.test.js` (NEW). Build a bare `express()` app (`express.json()` + a middleware setting `req.user`, `req.authz.permissions`, `req.companyFilter.company_id = COMPANY`, and **poisoning** `req.companyId = 'LEGACY-DO-NOT-USE'`), `app.use('/', jobsRouter)`, drive with `supertest`. Mock `jobsService` (`getJobById`, `updateBlancStatus`), `conversationsService` (`getOrCreateConversation`, `sendMessage`), `companyQueries` (`getById`), `routeDistanceService` (`computePair` — note: returns `{status:'failed',errorCode}`, does NOT throw), and the proxy surface (`db/connection` `query` MRU vs `conversationsService` export — whichever TASK-ONWAY-2 shipped). Stub unrelated jobs-router imports (`zenbookerClient`, `noteAttachmentsService`, `eventService`, `stripePaymentsService`) per `jobsCreate.test.js`.
  - **Estimate:** TC-EST-001..010 (403 gate; 404 cross-tenant w/ COMPANY assertion; happy `eta_minutes:23` + `computePair(origin,dest,'driving')`; no-origin→null + `computePair` not called; no-dest→null; failed/NO_KEY→null non-error incl. OVER_QUERY_LIMIT; null durationMinutes→null; malformed-body→400; `company_id` only from `req.companyFilter`).
  - **Notify:** TC-NOT-001..015 (403; 404; happy EXACT body `"Hi! Your technician Mike from ABC Homes is on the way and should arrive in about 25 minutes."` + `author:'agent'` + `updateBlancStatus(5,'On the way',COMPANY)` + **order assertion sendMessage before updateBlancStatus** via `mock.invocationCallOrder`; NO_PHONE 422 no side effects; NO_PROXY 422; env-fallback proceeds; WALLET_BLOCKED passthrough, status unchanged, no 2nd wallet check; SMS_FAILED, status unchanged; status-throws-after-send → `{ok:true,warning:'status_not_advanced'}` no rollback; multi-tech uses first; no-tech lead-in; company-null→`your service team`; invalid eta parametric→400 `invalid_eta` + boundary 1/600 pass; tenant isolation on all calls; already-On-the-way `__NOOP__`-safe).
  - **FSM fallback units (no DB):** TC-FSM-001 (`BLANC_STATUSES` includes `'On the way'`; `ALLOWED_TRANSITIONS['Submitted']` and `['Rescheduled']` include `'On the way'`), TC-FSM-002 (`ALLOWED_TRANSITIONS['On the way'] === ['Visit completed','Canceled']`; deep-compare the prior map minus additions — nothing dropped; `OUTBOUND_MAP` untouched).
  - **Extracted-transform unit:** feed sample job SCXML through the pure helper from TASK-ONWAY-1 → asserts the `On_the_way` state + both inbound `TO_ON_THE_WAY` transitions are injected, and **idempotency** (re-running / already-present input is a no-op via the `NOT LIKE`/equality guard).

**Файлы, которые трогать нельзя:** production source (tests mock at module boundaries only).

**Покрывает AC:** AC-2, AC-3, AC-4, AC-6, AC-7, AC-8, AC-9, AC-10, AC-12 (automated slice); SC-01..06.

**Ожидаемый результат:** Run via `npx jest --runTestsByPath tests/jobsEta.test.js --testPathIgnorePatterns "/node_modules/"` — **green**. (The repo's `package.json` `testPathIgnorePatterns` includes `/\.claude/worktrees/`, so the worktree path is otherwise ignored — the override flag is REQUIRED.) Asserts company_id always sourced from `req.companyFilter` (never `'OTHER'`/`'LEGACY-DO-NOT-USE'`), SMS-before-status order, and the exact rendered body.

**Зависимости:** after TASK-ONWAY-1 (FSM mirror + transform helper) and TASK-ONWAY-2 (routes + proxy resolver to mock against).

**Статус:** pending

### TASK-ONWAY-4: Frontend — OnTheWayModal + primary CTA + jobsApi (P1)

**Цель:** Ship the modal, the gated primary CTA, and the two API methods.

**Файлы, которые можно менять:**
- `frontend/src/components/jobs/OnTheWayModal.tsx` (NEW) — Shadcn `Dialog` mirroring `components/transactions/RecordPaymentDialog.tsx` (`Dialog open onOpenChange` + `DialogContent variant="panel"` + `DialogPanelHeader/DialogBody/DialogPanelFooter/DialogTitle/DialogDescription`). Props `{ open, onOpenChange, job: LocalJob, onNotified:(id:number)=>void }`. On open: ONE `navigator.geolocation.getCurrentPosition(success, error, { timeout:8000, enableHighAccuracy:false, maximumAge:60000 })` (no `watchPosition`/map). State ladder: (a) "Finding your location…" spinner w/ tiles visible underneath; (b) fix + job has origin/dest + `estimateEta` returns `eta_minutes!=null` → highlighted pre-selected **"Google ETA · ~{N} min"** row; (c) denied/unavailable/timeout/no-`getCurrentPosition`/`estimateEta`→null → muted **"ETA unavailable — location is off."** + hint **"Allow location access to get a live travel-time estimate, or pick a time below."**, NO Google row, nothing pre-selected. Tiles **10/15/20/30/45/60** + **"Set custom time"** in all states; custom = integer **1–600** (hint **"Enter 1–600 minutes."** out of range; cannot be active selection when invalid). Exactly one active selection across {Google | tile | custom}. **"Notify client"** disabled until a value chosen AND while in-flight (label **"Sending…"**, single submission, no auto-retry on timeout) → `jobsApi.notifyOnTheWay(job.id,{eta_minutes})`. Success `{ok:true}` → success toast **"Customer notified — you're marked On the way."** → close → `onNotified(job.id)`; `{ok:true,warning:'status_not_advanced'}` → toast **"SMS sent, but the job status didn't update. You can change it manually."** → still close+refresh; errors keep modal open + re-enable button with the §3/§5.4 toast copy (NO_PHONE/NO_PROXY/WALLET_BLOCKED/SMS_FAILED). All copy EXACT per spec §3, English-only.
- `frontend/src/components/jobs/JobStatusTags.tsx` (EDIT, JobOpsSection — NOT the dead `JobActionBar.tsx` stub) — add the **"On the way"** primary CTA using the SAME full-width orange-gradient slot as "Start Job"/"Complete Job" (`minHeight:40, borderRadius:12, linear-gradient(180deg,#f5874a,#e06020)`, white text, box-shadow). Render ONLY when `job.blanc_status ∈ {Submitted, Rescheduled}` AND user has `messages.send` (hide otherwise). Clicking opens `OnTheWayModal` (not the bare `ActionsBlock` transition). Thread `job` + `onNotified`/`afterMutation` (from `JobDetailPanel`/`useJobDetail`).
- `frontend/src/services/jobsApi.ts` (EDIT) — two methods on the existing client via `jobsRequest<T>()` + `JOBS_BASE`: `estimateEta(id, { origin }): Promise<{ eta_minutes:number|null; status:string }>` → `POST ${JOBS_BASE}/${id}/eta/estimate`; `notifyOnTheWay(id, { eta_minutes }): Promise<{ ok:boolean; status?:string; warning?:string; conversation_id?:string; eta_minutes?:number }>` → `POST ${JOBS_BASE}/${id}/eta/notify`. No `LocalJob` type changes beyond these signatures.

**Файлы, которые трогать нельзя:**
- `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts` (Protected shared infra).
- `JobActionBar.tsx` (dead `export {}` stub — do not use).
- No new SSE event — reuse the existing `job.status_changed` + conversation/timeline write; refresh via existing `useJobDetail.afterMutation`.

**Покрывает AC:** AC-1 (CTA gated on `{Submitted,Rescheduled}`, hidden for terminal/others), AC-2 (CTA hidden without `messages.send`), AC-3/AC-4 (single geolocation; ETA pre-select vs graceful unavailable), AC-5 (one-of {Google|tile|custom}, custom 1–600), AC-6/AC-7 (Notify→SMS, status flips, warning surfaced), AC-8 (disabled until chosen + in-flight, no double-send), AC-11 (badge renders). Manual TC-FE-001..011.

**Ожидаемый результат:** On a Submitted/Rescheduled job with `messages.send`, the orange CTA opens the modal; geolocation→ETA or graceful fallback; choosing a value + Notify sends the SMS (visible in the customer timeline) and flips the card to **On the way** (sky/cyan badge), CTA no longer primary; error/warning toasts map to the exact copy.

**Зависимости:** after TASK-ONWAY-2 (endpoints must exist to call). May proceed in parallel with TASK-ONWAY-3.

**Статус:** pending

### TASK-ONWAY-5: Verification gate (P0)

**Цель:** Prove the build and backend tests are green and the manual FE checklist passes.

**Файлы, которые можно менять:** none (verification only; minor type/lint fixes in the ONWAY files above if the build surfaces them).

**Ожидаемый результат:**
- From `frontend/`: `npm run build` (`tsc -b` + Vite) **green** — no type/lint errors (prod Docker is stricter, `noUnusedLocals`); covers `OnTheWayModal.tsx`, the two `jobsApi.ts` methods, and the `jobHelpers.tsx` status+color additions (TC-FE-012).
- Backend: `npx jest --runTestsByPath tests/jobsEta.test.js --testPathIgnorePatterns "/node_modules/"` **green** (TASK-ONWAY-3); broader jest suite unbroken.
- Manual FE checklist **TC-FE-001..012** noted (CTA gating/permission, single geolocation, ETA-computed vs unavailable states, tiles 10/15/20/30/45/60, custom 1–600, single-select, Notify disabled-until-chosen + in-flight, success/warning/error toasts, badge color) — verify on a mobile PWA viewport for geolocation items.

**Зависимости:** after TASK-ONWAY-1, TASK-ONWAY-2, TASK-ONWAY-3, TASK-ONWAY-4.

**Статус:** pending

---

**Order:** TASK-ONWAY-1 → TASK-ONWAY-2 → TASK-ONWAY-3 (after 1+2) → TASK-ONWAY-4 (after 2) → TASK-ONWAY-5 (gates last).
TASK-ONWAY-3 and TASK-ONWAY-4 are independent and may proceed in parallel once their deps land. PT-1 (status) MUST precede PT-2/PT-3 (status must exist); PT-2 MUST precede PT-3 (routes to mock); PT-4 after PT-2.

---

## REC-SETTINGS-001 — tasks (2026-06-26)

> **STATUS: ✅ DONE (2026-06-26)** — all of TASK-RS-1..6 implemented, tested, and reviewer-**APPROVED**. Backend `tests/slotEngineSettings.test.js` (44) + extended `tests/slotEngineProxy.test.js` (→23) = **67 passing**; frontend `npm run build` green. One implementation refinement vs the first pass: the GET route uses `svc.get` (not `resolve`), so a hard DB error surfaces as **500** (honest "couldn't load" toast + the UI's local DEFAULTS mirror) instead of silently returning defaults — matches the spec's get/resolve split (TC-RS-050). Pending: run migration 128 on prod + deploy.

> Per-company recommendation settings replacing the **hardcoded** `config_override` in `backend/src/services/slotEngineService.js`. Sibling of SLOT-ENGINE-001's `technician_base_locations` — mirror its migration/queries/service/route/api-client patterns exactly. **No engine change, no engine redeploy** (`slot-engine/` `DEFAULT_CONFIG` + `mergeConfig` deep-merge is reused as-is).
> Spec `docs/specs/REC-SETTINGS-001.md` · Requirements `docs/requirements.md` → REC-SETTINGS-001 (RS-R1..R6, AC-1..AC-12) · Architecture `docs/architecture.md` → "REC-SETTINGS-001 — design (2026-06-26)" · Test cases `docs/test-cases/REC-SETTINGS-001.md` (TC-RS-001..081).
>
> **Cross-cutting constraints (every backend task):**
> - `company_id` comes **ONLY** from `req.companyFilter?.company_id` (NOT `req.companyId`, NOT the request body). Routes mount under `authenticate, requireCompanyAccess`; each route additionally enforces `requirePermission('tenant.company.manage')`.
> - All SQL filters/scopes by `company_id` → settings are isolated between companies; no `:id` path exists, so no cross-tenant direct-ID surface.
> - `DEFAULTS = { max_distance_miles:10, overlap_minutes:0, min_buffer_minutes:15, horizon_days:3, recommendations_shown:3 }` is the single source of truth (lives in `slotEngineSettingsService.js`). Backwards-compatible: **no row → DEFAULTS** everywhere.
> - The **2 fixed values** (`geography.allow_empty_day_candidates=true`, `workload.max_day_utilization=0.95`) are ALWAYS injected by `buildConfigOverride` regardless of stored content — never stored, never shown in the UI.
> - Highest existing migration = 127, so 128 is the correct next number. The shared trigger fn `update_updated_at_column()` pre-exists (010/125) — reuse, do not redefine.

### TASK-RS-1: Storage + settings queries + settings service (P0)

**Цель:** Create the table, the company-scoped query layer, and the settings service that owns `DEFAULTS`, `resolve`/`get`, `validate`, `save`, and `buildConfigOverride`.

**Файлы, которые можно менять:**
- `backend/db/migrations/128_create_slot_engine_settings.sql` (NEW) — exact table from architecture/spec: `slot_engine_settings(company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE, config JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`. **Idempotent** (`CREATE TABLE IF NOT EXISTS`) and **re-runnable trigger** (e.g. `DROP TRIGGER IF EXISTS trg_slot_engine_settings_updated_at … ` then `CREATE TRIGGER … BEFORE UPDATE … EXECUTE FUNCTION update_updated_at_column()`) so `ensureSchema()` can replay on every query without error (mirror 125). The 2 fixed values are NOT columns.
- `backend/src/db/slotEngineSettingsQueries.js` (NEW) — mirror `technicianBaseLocationQueries.js`: `ensureSchema()` reads + replays `128_*.sql`; `getByCompany(companyId)` (SELECT `config`/`updated_at` `WHERE company_id = $1`); `upsert(companyId, config)` (`INSERT INTO slot_engine_settings (company_id, config) VALUES ($1,$2) ON CONFLICT (company_id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()` RETURNING config). `company_id` is the first bound param in both; every query calls `ensureSchema()` first.
- `backend/src/services/slotEngineSettingsService.js` (NEW) — owns `DEFAULTS` (the const above) + `VALIDATION` ranges (distance 1–100, overlap 0–240, buffer 0–240, horizon 1–14, shown 1–10). Functions:
  - `get(companyId)` → `getByCompany`; no row → `DEFAULTS`; row present → `{ ...DEFAULTS, ...row.config }` then **re-coerce each key** (missing/malformed individual key falls back to that key's default; result always complete + integer-typed; never partial). A hard DB error here **propagates** (so the GET route can map it to 500).
  - `resolve(companyId)` → same as `get` **but degrades to `DEFAULTS` on any DB error and NEVER throws** (safe-failure parity with `slotEngineService`).
  - `validate(payload)` → reads only the 5 known keys (unknown keys stripped/ignored), coerces (`"15"`→15), each must be an **integer within range**; non-integer / out-of-range / missing → throw `{ httpStatus:422, code:'INVALID_SETTINGS', field, message }`. **All-or-nothing**: validate fully before any return/side-effect; returns the 5 coerced integers on success.
  - `save(companyId, payload)` → `validate(payload)` then `queries.upsert(companyId, validated)`; returns saved 5 values.
  - `buildConfigOverride(settings)` → the EXACT shape from spec §buildConfigOverride: `geography.max_distance_from_existing_job_miles` AND `geography.max_distance_from_base_if_empty_day_miles` both = `settings.max_distance_miles` (one radius → both keys); `geography.allow_empty_day_candidates=true` (fixed); `overlap.max_timeframe_overlap_minutes`, `feasibility.min_required_slack_minutes`, `planning.horizon_days`, `ranking.top_n`; `workload.max_day_utilization=0.95` (fixed). The 2 fixed values emitted unconditionally; top-level keys exactly `{geography,overlap,feasibility,planning,ranking,workload}` (no extra/exposed engine keys).

**Файлы, которые трогать нельзя:**
- `slot-engine/` — `DEFAULT_CONFIG` + `mergeConfig` contract (no engine change/redeploy).
- `technician_base_locations` table/queries — REC-SETTINGS is a sibling; don't alter base-location behavior.
- Other migrations (no renumber/edit of 001..127).

**Покрывает AC:** AC-1, AC-2 (table/PK/FK + fixed-values-always), AC-3 (no-row→DEFAULTS), AC-4 (engine-key mapping in `buildConfigOverride`), AC-5 (`planning.horizon_days` produced), AC-10 (validation ranges/integer/missing), AC-11 (custom picker value still obeys 0–240 in `validate`). Test cases TC-RS-001..006, 010..015, 020..033, 040..041, 060..064.

**Ожидаемый результат:** A company with no row resolves to `{10,0,15,3,3}`; a stored/partial/corrupt row resolves to a complete integer-typed object; `resolve` returns `DEFAULTS` on a DB fault without throwing; `validate` rejects bad input with `422 INVALID_SETTINGS` (no partial save) and coerces good input; `buildConfigOverride(DEFAULTS)` produces the exact 8-path override incl. both radii + the 2 fixed values; SQL is company-scoped (`WHERE company_id = $1`, `ON CONFLICT (company_id)`), settings isolated between companies; `ensureSchema()` replays 128 idempotently.

**Зависимости:** none (first task).

**Статус:** pending

### TASK-RS-2: Wire slotEngineService to resolved settings (P0)

**Цель:** Replace the hardcoded `config_override` and the `HORIZON_DAYS=2` constant in `getRecommendations` with values derived from the resolved per-company settings.

**Файлы, которые можно менять:**
- `backend/src/services/slotEngineService.js` (EDIT) — add `const settingsService = require('./slotEngineSettingsService');`; resolve **once** at the top of `getRecommendations`: `const settings = await settingsService.resolve(companyId);`. **Drop** the module constant `HORIZON_DAYS = 2` (line ~20). Date window now uses `const latest = newJob.latest_allowed_date || addDaysLocal(today, settings.horizon_days);` (line ~162) — so the snapshot window and `planning.horizon_days` agree. **Replace** the hardcoded literal at line ~199 (`config_override: { geography: { allow_empty_day_candidates: true, max_distance_from_base_if_empty_day_miles: 40 } }`) with `config_override: settingsService.buildConfigOverride(settings)`.

**Файлы, которые трогать нельзя:**
- `slot-engine/` (no engine change/redeploy).
- `slotEngineService` safe-failure path (empty/flagged result on engine fault / missing `SLOT_ENGINE_URL`) and snapshot-building logic (techs/base/scheduled jobs/coverage/tz) — preserve unchanged. `resolve` never throwing keeps these intact.

**Покрывает AC:** AC-4 (hardcoded `config_override` removed → built from settings), AC-5 (`HORIZON_DAYS` replaced by `settings.horizon_days` for `latest_allowed_date`), AC-6 (no engine change), AC-3 (DB-fault `resolve`→DEFAULTS keeps recommendations well-defined). Test cases TC-RS-051..054 (asserted in TASK-RS-4).

**Ожидаемый результат:** A new-job recommendation posts `config_override === buildConfigOverride(resolve(companyId))` and `new_request.latest_allowed_date === today + settings.horizon_days` (caller-supplied `latest_allowed_date` still wins). Settings load failure degrades to DEFAULTS — the recommendation still runs; existing engine-fault safe-failure unchanged. No `HORIZON_DAYS` constant remains.

**Зависимости:** after TASK-RS-1 (consumes `resolve` + `buildConfigOverride`).

**Статус:** pending

### TASK-RS-3: GET/PUT routes + server mount (P0)

**Цель:** Expose `GET`/`PUT /api/settings/slot-engine-settings` (permission-gated, company-scoped) and mount the router beside technician-base-locations.

**Файлы, которые можно менять:**
- `backend/src/routes/slotEngineSettings.js` (NEW) — mirror `routes/technicianBaseLocations.js`: `const { requirePermission } = require('../middleware/authorization');`, `const svc = require('../services/slotEngineSettingsService');`, `function companyId(req) { return req.companyFilter?.company_id; }`. `GET '/'`, `requirePermission('tenant.company.manage')` → `{ ok:true, data: await svc.get(companyId(req)) }` (defaults on no-row; a hard DB error surfaces 500). `PUT '/'`, same permission → `const data = await svc.save(companyId(req), req.body)` → `{ ok:true, data }`; on `err.httpStatus` (422) respond `res.status(422).json({ ok:false, error:{ code:'INVALID_SETTINGS', field, message } })`, else 500. **`company_id` is never read from `req.body`.** No `:id` path. `module.exports = router`.
- `src/server.js` (EDIT, PROTECTED — **+1 mount line only**) — beside the base-locations line (~246): `app.use('/api/settings/slot-engine-settings', authenticate, requireCompanyAccess, require('../backend/src/routes/slotEngineSettings'));`. No other change to server core.

**Файлы, которые трогать нельзя:**
- `src/server.js` core middleware (only the one mount line added).
- `technician-base-locations` routes (sibling — don't alter).

**Покрывает AC:** AC-7 (GET returns settings-or-defaults; PUT upserts validated 5), AC-8 (both under `requirePermission('tenant.company.manage')`), AC-9 (`company_id` only from `req.companyFilter`; cross-tenant read/write impossible), AC-10 (PUT 422 on invalid, no save). Test cases TC-RS-042..050. Route mounts with `authenticate, requireCompanyAccess`; SQL filters by `company_id` → data isolated between companies; no `:id` path → no cross-tenant direct-ID access.

**Ожидаемый результат:** `GET` → 200 `{ok:true,data:<5 values>}` (defaults when no row, no row created); `PUT` valid → 200 `{ok:true,data:<saved 5>}` + upsert scoped to `req.companyFilter.company_id` (poisoned `req.companyId`/body `company_id` ignored); `PUT` invalid → 422 `{ok:false,error:{code:'INVALID_SETTINGS',field,message}}` with nothing saved; missing permission → 403; no auth → 401; tenant B's GET is scoped to B (never returns A's row).

**Зависимости:** after TASK-RS-1 (uses `svc.get`/`svc.save`). May proceed in parallel with TASK-RS-2.

**Статус:** pending

### TASK-RS-4: Backend tests — units + slotEngineService integration (P0)

**Цель:** Cover the service / validate / queries / routes / migration units in a new file, AND the `slotEngineService` consumption cases by extending the existing proxy test.

**Файлы, которые можно менять:**
- `tests/slotEngineSettings.test.js` (NEW) — follow `tests/technicianBaseLocations.test.js` harness:
  - **service `buildConfigOverride`** (TC-RS-001..006): DEFAULTS→exact override; custom set→exact; one radius→both geography keys; 2 fixed values always (incl. minimal-input guard); no extra/exposed top-level keys.
  - **service `resolve`/`get`** (TC-RS-010..015): `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))`; no-row→DEFAULTS; full row→its 5; missing key→that key defaulted; corrupt/non-numeric key→defaulted + re-coerced; DB error in `resolve`→`.resolves.toEqual(DEFAULTS)` (never throws); DB error in `get`→**rejects** (get-vs-resolve split).
  - **service `validate`** (TC-RS-020..033): all-valid baseline→coerced ints; `"15"`→15; per-field boundary matrix (distance 1/100 ok, 0/101 reject; overlap & buffer 0/240 ok, −1/241 reject; horizon 1/14 ok, 0/15 reject; shown 1/10 ok, 0/11 reject) each `{422,INVALID_SETTINGS,field:'<key>'}`; float (30.5) reject; `"abc"`/`NaN` reject; missing field reject; all-or-nothing (one bad field → throws, `queries.upsert` NOT reached via `save`); unknown keys stripped; custom value 300 rejected.
  - **queries** (TC-RS-040..041): `getByCompany` SQL `WHERE company_id = $1`, bound `[0]===COMPANY`, reads `config`; `upsert` first bound param===COMPANY, SQL `ON CONFLICT (company_id) DO UPDATE`, writes `config` jsonb, bumps `updated_at`.
  - **routes** (TC-RS-042..050): reuse the `appWith({ permissions, companyId })` factory injecting `req.user`, `req.authz.permissions`, `req.companyFilter={company_id}`; mount `require('../backend/src/routes/slotEngineSettings')` at `/`; supertest. 401 (no user); 403 (`permissions:[]`); GET no-row→defaults; GET row→saved; PUT valid→upsert+returns saved; PUT invalid (`max_distance_miles:250`)→422, no INSERT recorded; `company_id` ONLY from `companyFilter` (poison `req.companyId=COMPANY_B` + body `company_id:COMPANY_B` → upsert param===COMPANY_A); cross-tenant GET scoped to caller; GET hard DB error→500.
  - **migration 128** (TC-RS-060..064): structural assertions by reading `128_*.sql` (+ an `ensureSchema()` replay smoke against mocked `db.query`): `company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE`; `config JSONB NOT NULL` + both timestamps; `update_updated_at_column()` trigger wired; idempotent (`IF NOT EXISTS` + guarded trigger, double-replay no-throw); cascade clause present; 128 is the next free number.
- `tests/slotEngineProxy.test.js` (EDIT) — add the integration cases (TC-RS-051..054) per the test-cases infra note: `jest.mock('../backend/src/services/slotEngineSettingsService', () => ({ resolve: jest.fn(), buildConfigOverride: jest.requireActual('../backend/src/services/slotEngineSettingsService').buildConfigOverride }))` — **mock `resolve`, keep the REAL `buildConfigOverride`**. Per test: `settingsSvc.resolve.mockResolvedValue({…})`, `global.fetch.mockResolvedValue({ ok:true, json: async () => ({ recommendations: [] }) })`, call `getRecommendations(COMPANY, { new_job: { lat, lng } })`, read `JSON.parse(global.fetch.mock.calls[0][1].body)`, assert `body.config_override` deep-equals `buildConfigOverride(resolved)` AND `body.new_request.latest_allowed_date === addDaysLocal(today, settings.horizon_days)` (freeze "today" as the service derives it; pass a `new_job` WITHOUT `latest_allowed_date` to exercise the horizon branch). Cases: config_override == built (guards removal of the `{allow_empty_day_candidates:true, max_distance_from_base_if_empty_day_miles:40}` literal); date window uses `horizon_days` (guards removal of `HORIZON_DAYS=2`); explicit `latest_allowed_date` wins; resolve-degrades-to-DEFAULTS path still recommends. Existing engine-fault safe-failure cases must not regress.

**Файлы, которые трогать нельзя:** production source (tests mock at module boundaries only); `slot-engine/`.

**Покрывает AC:** AC-1..AC-11 (automated slice — every backend AC). Test cases TC-RS-001..064.

**Ожидаемый результат:** Both files green via `npx jest --runTestsByPath tests/slotEngineSettings.test.js --testPathIgnorePatterns "/node_modules/"` and `npx jest --runTestsByPath tests/slotEngineProxy.test.js --testPathIgnorePatterns "/node_modules/"` (the override flag is REQUIRED — repo `testPathIgnorePatterns` ignores `/.claude/worktrees/`). The integration asserts equality against the **real** `buildConfigOverride` (not a copy), proving the hardcode + `HORIZON_DAYS` removal.

**Зависимости:** after TASK-RS-1, TASK-RS-2, TASK-RS-3 (exercises service, the wired `slotEngineService`, and the routes).

**Статус:** pending

### TASK-RS-5: Frontend — API client + RecommendationSettings block + page mount (P1)

**Цель:** Ship the typed API client, the "Recommendation settings" block (5 controls, dirty-gated Save, validation hints, 422 toast), and mount it under `<CompanyBaseAddress>` on the Technicians settings page.

**Файлы, которые можно менять:**
- `frontend/src/services/slotEngineSettingsApi.ts` (NEW) — mirror `technicianBaseLocationsApi.ts`: `import { authedFetch } from './apiClient';`. `interface SlotEngineSettings { max_distance_miles; overlap_minutes; min_buffer_minutes; horizon_days; recommendations_shown }`; `get(): Promise<SlotEngineSettings>` (`GET /api/settings/slot-engine-settings`, unwrap `json.data`); `save(body): Promise<SlotEngineSettings>` (`PUT`, unwrap `json.data`). Export a `DEFAULTS` mirror + the `VALIDATION` ranges for client-side echo.
- `frontend/src/components/settings/RecommendationSettings.tsx` (NEW) — loads on mount via `get()` (falling back to the local `DEFAULTS` mirror if the load fails so the form stays usable; controls disabled/skeleton while pending). 5 controls: **3 number inputs** (Max distance (mi), Planning horizon (days), Recommendations shown) + **2 minute-pickers** (Allow overlapping arrival windows, Min buffer between jobs) as segmented presets `0 / 30 / 60 / Custom` — Custom reveals a number input; a server value not in {0,30,60} pre-selects Custom with that value. **Save** is primary + **disabled until dirty**; in-flight label "Saving…" + disabled; re-enables per dirty on completion. Client validation mirrors server ranges (inline per-field range hints gating Save); on server 422 surface `field`+`message` via `toast` (sonner) e.g. "Max distance must be between 1 and 100"; success toast "Recommendation settings saved". Helper text on Max distance noting it bounds **both** base + nearest-job radii; helpers per spec for the others. Section header `.blanc-eyebrow` ("Recommendation settings"), optional one-line sublabel; **no `<hr>`/separators**; Albusto `--blanc-*` tokens; **English** copy; the 2 fixed values are NOT shown.
- `frontend/src/pages/TechnicianPhotosPage.tsx` (EDIT) — import `RecommendationSettings`; mount `<RecommendationSettings />` in its own `mb-6` wrapper directly under the existing `<CompanyBaseAddress …>` block (immediately after the `</div>` closing line ~145). No other page logic changes.

**Файлы, которые трогать нельзя:**
- `frontend/src/lib/authedFetch.ts` / `frontend/src/services/apiClient.ts` — reused, not rewritten.
- `CompanyBaseAddress` and the technician-photos logic — only add the block beneath it.

**Покрывает AC:** AC-12 (block on Technicians page, exactly 5 controls, 2 fixed hidden, English, Albusto tokens, `.blanc-eyebrow`, no separators), AC-3 (first-run shows 10/0/15/3/3), AC-7 (Save PUTs all 5, reload reflects), AC-10/AC-11 (client range hints + custom obeys 0–240, server authoritative via 422). Manual TC-RS-070..080.

**Ожидаемый результат:** Settings → Technicians shows the "Recommendation settings" block under the base address; first run shows defaults 10/0/15/3/3 (no row created by GET); editing enables Save → "Saving…" → success toast + reload reflects; out-of-range shows the inline hint and (if forced) a 422 toast with nothing saved; Custom picker values obey 0–240; next recommendation fetch reflects saved values (no redeploy).

**Зависимости:** after TASK-RS-3 (endpoints must exist to call).

**Статус:** pending

### TASK-RS-6: Verification gate (P0)

**Цель:** Prove the frontend build and both backend jest files are green, and note the manual FE checklist.

**Файлы, которые можно менять:** none (verification only; minor type/lint fixes in the RS files above if the build surfaces them).

**Ожидаемый результат:**
- From `frontend/`: `npm run build` (`tsc -b` + Vite) **green** — no type/lint errors (prod Docker is stricter, `noUnusedLocals`); covers `RecommendationSettings.tsx` + `slotEngineSettingsApi.ts` (`SlotEngineSettings` interface + `DEFAULTS`/ranges exports resolve) — TC-RS-081.
- Backend: `npx jest --runTestsByPath tests/slotEngineSettings.test.js --testPathIgnorePatterns "/node_modules/"` **green** AND `npx jest --runTestsByPath tests/slotEngineProxy.test.js --testPathIgnorePatterns "/node_modules/"` **green** (no proxy regressions).
- Manual FE checklist **TC-RS-070..081** noted (5 controls only / 2 fixed hidden; first-run 10/0/15/3/3; pickers 0/30/60/Custom + Custom-reveal & pre-select; Save dirty-gated + "Saving…"; save persists + success toast + reload; out-of-range inline hint + 422 toast, nothing saved; custom out-of-range rejected; loading usable / load-failure → DEFAULTS mirror; saved change reflected in next recommendation fetch; reset = saving defaults; English + Albusto tokens + canon).

**Зависимости:** after TASK-RS-1..TASK-RS-5 (gates last).

**Статус:** pending

---

**Order:** TASK-RS-1 → { TASK-RS-2, TASK-RS-3 } (both after RS-1; independent of each other) → TASK-RS-4 (after RS-1+RS-2+RS-3) → TASK-RS-5 (after RS-3) → TASK-RS-6 (gates last).
RS-2 (slotEngineService wiring) and RS-3 (routes) both depend only on RS-1 and may proceed in parallel. RS-5 (frontend) needs RS-3's endpoints. RS-4 (backend tests) needs the wired service + routes; RS-6 gates the whole feature (build + both jest files + manual checklist).
