# REPAIR-ADVISOR-001 — AI Repair Advisor (marketplace), Stage 1

**Status:** Spec · **Stage:** 1 · **Owner:** CRM / Integrations
**Requirements:** `Docs/requirements.md` → REPAIR-ADVISOR-001 · **Architecture:** `Docs/architecture.md` → REPAIR-ADVISOR-001
**Related:** F016/F018 (marketplace canon), SLOT-ENGINE-001 (seed 126 gate-only mirror), EMAIL-TIMELINE-001 (`jobsService.addNote` seam)

---

## 1. Summary

A gate-only marketplace app `ai-repair-advisor`. When a company has it **connected**, every **human-path** job creation
(`createDirectJob` = `POST /api/jobs`, and `convertLead`) fires a domain event `job.created`. A fast-returning subscriber
`kb-diagnostics` offloads a **detached, best-effort** task that: re-checks the gate, reads the job, queries the KB RAG service,
and appends **exactly one** three-section diagnostic note authored `AI Repair Advisor` (`created_by='system'`). Backend-only;
no frontend work (the tile renders from the seed). Any failure ⇒ no note, logged, job untouched.

**Component interaction map**

```
POST /api/jobs → jobsService.createDirectJob      (job row committed, metadata merged)
convertLead   → leadsService.convertLead (if localJobCreated===true)
     │  (post-commit, additive, non-blocking)
     └─ eventBus.emit(companyId,'job.created',{id:jobId,jobId,companyId})   → writes domain_events, returns fast
          └─ setImmediate → dispatchToSubscribers (sequential await)   [eventBus internal]
               └─ subscriber 'kb-diagnostics'.handle(event)   ← RETURNS FAST, does not await RAG
                    └─ setImmediate(() => kbDiagnosticsService.runForJob({jobId, companyId}).catch(()=>{}))   [detached]
                         ├─ marketplaceService.isAppConnected(companyId,'ai-repair-advisor')  → false → STOP
                         ├─ jobsService.getJobById(jobId, companyId)  → null → STOP
                         ├─ idempotency: job.notes has author==='AI Repair Advisor' → STOP
                         ├─ buildQuestion(job) → ragClient.ask({question, filters}) → null → STOP
                         └─ formatNote(result) → text (null → STOP)
                              └─ jobsService.addNote(jobId, text, [], 'AI Repair Advisor', 'system')
```

Anchors verified in code: `jobsService.createDirectJob` returns at `jobsService.js:567`; `convertLead` returns at
`leadsService.js:1028` (guard `localJobCreated` set at `leadsService.js:792`); `getJobById(id, companyId, providerScope)`
`jobsService.js:589`; `addNote(jobId, text, attachments=[], author=null, createdBy=null, noteId=null)` `jobsService.js:1157`;
`marketplaceService.isAppConnected` (generic install-row path) `marketplaceService.js`; `eventBus.emit(companyId, eventType,
payload, opts)` `eventBus.js:44`; `retryRequest(fn, maxRetries)` (4xx short-circuit except 429) `zenbookerClient.js:540`.

---

## 2. Behavior scenarios

### UC-01 — Connect the app
- **Pre:** user holds `tenant.integrations.manage`.
- **Steps:** Settings → Integrations → "AI Repair Advisor" tile (rendered from seed 161, status *Available*) → Connect.
- **Result:** `marketplace_installations` row for the company reaches `status='connected'` (existing lifecycle, no new route).
- **Effects:** from now on, human-path job creation for this company triggers `job.created` → advisor note.

### UC-02 — Disconnect the app
- **Steps:** Settings → Integrations → Disconnect.
- **Result:** installation leaves `connected`. Subsequent human-path creations produce **no** advisor note. Existing notes on past jobs are untouched (no deletion, no back-fill).

### UC-03 — Job created manually → note appears
- **Pre:** app connected.
- **Steps:** `POST /api/jobs` (`createDirectJob`) with a problem description → response returns success immediately (unchanged latency/txn).
- **Result:** post-commit `emit('job.created')`; the detached `runForJob` appends **one** note (up to 3 sections) authored `AI Repair Advisor`, `created_by='system'`. Note appears in the job card, non-editable by regular users.

### UC-04 — Job created via lead conversion → note appears
- **Pre:** app connected.
- **Steps:** `convertLead` produces a job with `localJobCreated===true`.
- **Result:** identical one-note behavior to UC-03. When an existing local job is **reused** (`localJobCreated===false`), **no** `job.created` is emitted (no duplicate note).

### UC-05 — App NOT connected → no note
- **Pre:** app not installed or disconnected for the company.
- **Result:** the event still emits, but `runForJob`'s first step `isAppConnected` returns `false` **before** any job read or RAG call → **no** RAG call, **no** note. Job creation unaffected.

### UC-06 — RAG service down → no note, job unaffected
- **Pre:** app connected, RAG unreachable / timing out / non-2xx (e.g. 502 tunnel).
- **Result:** `ragClient.ask` returns `null` (transport failure caught internally); `runForJob` appends no note. Error logged via `console.warn('[RAG] …')` / `console.warn('[kb-diagnostics] …')`. Job creation already returned success; nothing propagates back to the user.

### UC-07 — Job with no / thin description → graceful attempt
- **Pre:** app connected; empty/thin `description`.
- **Result:** `buildQuestion` falls back `description → comments`, plus `job_type`/`service_name`. RAG is queried with whatever text exists. If the answer is unusable, `ask`/`formatNote` yield `null` ⇒ **no note or a note with only the grounded sections**. Never a crash, never a malformed/partial note.

### Edge cases

| ID | Condition | Expected behavior |
|----|-----------|-------------------|
| E-01 | **App connected at emit, disconnected before `runForJob` runs** (detached task lag) | Gate is **re-checked at `runForJob` start** (`isAppConnected` is the first step, not cached at emit). Returns `false` ⇒ **no note**. |
| E-02 | **Two rapid creates of the same job / event redelivered** (`redispatch`, retry) | Idempotency guard: `getJobById` shows a note with `author==='AI Repair Advisor'` already present ⇒ **STOP, no second note**. One advisor note per job, ever. |
| E-03 | **RAG returns 200 but `likely_causes` empty AND `diagnosis_steps` empty** (no diagnostic mode either) | `ask` applies the *empty ⇒ null* rule (no groundable content) ⇒ returns `null` ⇒ **no note**. |
| E-04 | **RAG returns causes + steps but no diagnostic mode** | `ask` returns object with `diagnosticMode:null`; `formatNote` renders **2 sections** (Probable causes, Diagnosis steps). The **"Diagnostic mode" header is omitted entirely** — no empty section, no placeholder. |
| E-05 | **RAG timeout at `RAG_TIMEOUT_MS`** | axios aborts; `retryRequest(fn,1)` = single attempt (no retry); `ask` catches, logs, returns `null` ⇒ **no note, logged**. |
| E-06 | **Malformed / non-JSON RAG body** (no fenced block, no `{…}`) | Tolerant parse fails to extract any structured content; `ask` returns `null` ⇒ **no note**. Never throws out of the detached task. |
| E-07 | **Job deleted before `setImmediate` runs** | `getJobById(jobId, companyId)` returns `null` ⇒ **STOP, no note** (no RAG call, no throw). |
| E-08 | **Job with `brand`/`model`/`unit_type` in `metadata`** | Extracted case-insensitively and passed as `filters.brand` / `filters.unitType`; `model` (no filter slot) is folded into the question text. |
| E-09 | **Job WITHOUT any brand/unit metadata** | `filters` omits absent keys (never sends empty strings); RAG is called **without** brand/unit filters and still answers. |
| E-10 | **`RAG_API_URL` unset/blank** | `ragClient.ask` is **inert**: returns `null` with **no HTTP** ⇒ no note. Advisor globally disabled by config. |
| E-11 | **Out-of-scope create paths** (Zenbooker webhook sync, scheduler/`agentWorker`) | These paths do not call `createDirectJob`/`convertLead`, emit no `job.created` ⇒ **note-free** (AC-06). No coupling added. |

---

## 3. Contracts (exact)

### 3.1 `ragClient.ask({ question, filters })` — outbound RAG client

**Module:** `backend/src/services/ragClient.js` (mirror of `zenbookerClient.js`: lazy axios singleton via `getClient()`, `retryRequest`).

**Config**
- `RAG_API_URL` — base URL. **No code default — blank/unset ⇒ inert** (no HTTP; `ask` returns `null`). The prod RAG URL (`https://app.albusto.com/aihelper/api`) lives only as a commented hint in `.env.example`; an operator sets it to enable the advisor. (Code uses `process.env.RAG_API_URL || ''` with no hardcoded fallback.)
- `RAG_TIMEOUT_MS` — axios `timeout`. Default `40000` (must exceed the ~35s RAG budget).

**Input**
```
ask({
  question: string,                    // required, from buildQuestion
  filters?: { brand?: string, unitType?: string }   // keys present only when known
})
```

**HTTP**: `POST {RAG_API_URL}/ask` with JSON body `{ question, filters: { brand, unitType } }` (filters object omitted or partial per availability), wrapped in `retryRequest(fn, 1)` → **single attempt**; a 4xx short-circuits immediately (except 429), matching `zenbookerClient.js:540`.

**Return: a normalized object OR `null`.**
```
{
  summary: string | null,             // top-level "summary" (one-liner), trimmed; null if absent
  causes: [ { cause: string, likelihood: number | null } ],   // [] if none
  steps:  [ { step: string, expected?: string } ],            // [] if none
  diagnosticMode: string | null,      // entry instructions for the model's diag/service mode; null if none
  confidence: number | null,          // 0..1 if provided
  grounded: boolean | null            // RAG's grounded flag if provided
}
```

**Returns `null` when (any of):**
- `RAG_API_URL` is blank/unset → **no HTTP performed** (inert).
- Transport failure: network error, timeout, or non-2xx response (caught internally; logged `console.warn('[RAG] …', err.message)`; never re-thrown).
- Body cannot be parsed into any structured content (see tolerant parse) — malformed / non-JSON.
- **Empty ⇒ null:** after a successful parse, `causes.length === 0` **AND** `steps.length === 0` **AND** `!diagnosticMode`. (A `summary` alone is **not** enough to warrant a note.)

`ask` is best-effort and **does not throw**; the only escaping errors would be unexpected programming faults, which `runForJob`'s outer guard swallows (defense-in-depth; net behavior identical — no note, logged). This reconciles architecture §4's "throws → caught in runForJob" flow: the observable outcome (no note, logged) is the same either way.

**Parsing the RAG `/ask` response (tolerant)**

The RAG returns a JSON envelope whose *answer text* embeds a fenced ```json block with the structured fields. Parse order:

1. **Top-level fields** (read directly from the response JSON):
   - `summary` → `summary` (string, trimmed).
   - `likely_causes: [{ cause, probability }]` → `causes: [{ cause, likelihood: probability }]`. Drop entries without a non-empty `cause`. `likelihood` = `probability` if numeric, else `null`.
   - `confidence`, `grounded` → passed through if present at top level (may instead appear in the fenced block — take whichever is present, fenced-block wins on conflict).
2. **Structured block** — locate the fenced block inside the answer text (top-level `answer` / `text` / `message` string, whichever holds the model output):
   - **Fence extraction:** first ```` ```json … ``` ```` (case-insensitive language tag; also accept a bare ```` ``` … ``` ````) — take its inner body.
   - **Fallback:** if no fence, take the substring from the **first `{`** to the **last `}`** of the answer text.
   - `JSON.parse` the extracted candidate inside a `try/catch`. On parse failure, treat the structured block as absent (do not throw) and rely on top-level fields only.
   - From the parsed block read: `diagnosis_steps: []` (or `repair_instructions[]` as an alias) → `steps`. Each step: a string ⇒ `{ step }`; an object ⇒ `{ step: <text|step|instruction field>, expected: <expected|expected_result> if present }`. Drop empty steps.
   - `diagnostic_mode` **or** `diagnostic_mode_entry` **or** `service_mode` (first non-empty string) → `diagnosticMode`. Absent/empty ⇒ `null`.
   - `confidence`, `grounded`, `scope_label` read here if present (override top-level).
3. Build the normalized object; apply the *empty ⇒ null* rule.

> The RAG `/ask` schema is greenfield in this repo (no existing reference). The parse is deliberately **tolerant**: missing top-level fields, a missing/mis-tagged fence, or a partially-malformed block degrade to "use what parsed" rather than throwing. The unit test pins one canned happy-path payload (summary + `likely_causes` + fenced block with `diagnosis_steps`/`diagnostic_mode`/`confidence`/`grounded`) → normalized object.

### 3.2 `job.created` domain event

Emitted post-commit at both human create sites via `eventBus.emit` (`eventBus.js:44`). Additive only — existing success/latency/transaction behavior byte-for-byte unchanged; `emit` writes `domain_events` synchronously then `setImmediate`-dispatches (never blocks or throws into the producer).

**Signature used:**
```
eventBus.emit(
  companyId,                 // 1st positional — from req.companyFilter?.company_id; becomes event.company_id (authoritative)
  'job.created',
  { id: jobId, jobId: jobId, companyId },      // payload — `id` is the field the subscriber reads
  { actorType: 'user', aggregateType: 'job', aggregateId: jobId }   // opts
)
```
- **`opts` semantics:** `actorType:'user'` marks the human path (a technician/dispatcher initiated the create). If the create service does not thread the acting user, `actorType` defaults to `'system'` — **the subscriber does not depend on `actorType`**. `aggregateType:'job'` and `aggregateId:jobId` are explicit for clarity but equal `eventBus.emit`'s own defaults (`eventType.split('.')[0]` = `'job'`, `payload.id`), so passing them is optional.
- **Load-bearing fields only:** the subscriber reads `event.company_id` (companyId) and `event.payload.id` (jobId). Extra payload keys (`contact_id`, `service_name`, `customer_phone`) are allowed for observability but unused by `kb-diagnostics`.
- **Emit sites:**
  - `createDirectJob` — **always** emits, immediately before `return { job_id: localJob.id, … }` (`jobsService.js:567`), after the metadata merge, using `localJob.id`.
  - `convertLead` — emits **only when `localJobCreated===true`**, before `return { … job_id: localJobId … }` (`leadsService.js:1028`), using `localJobId`. The guard prevents a duplicate note when an existing local job is reused.
- **Redelivery:** `redispatch(eventId)` replays with `payload = event_data` (still carries `id`) and `company_id` — the idempotency guard (§3.6) makes replays note-safe.

### 3.3 `kbDiagnosticsService.runForJob({ jobId, companyId })`

**Module:** `backend/src/services/kbDiagnosticsService.js`. Detached, best-effort. The **entire body is wrapped** so any throw ⇒ `console.warn('[kb-diagnostics] …', err.message)` + **no note** (never re-thrown; the `.catch(()=>{})` at the call site is belt-and-suspenders).

**Step contract (ordered; each early-return ⇒ no note):**

| # | Step | Early-return condition |
|---|------|------------------------|
| 1 | `const connected = await marketplaceService.isAppConnected(companyId, AI_REPAIR_ADVISOR_APP_KEY)` | `!connected` ⇒ **STOP** (no job read, no RAG). Re-checked here so mid-flight disconnect (E-01) is honored. |
| 2 | `const job = await getJobById(jobId, companyId)` | `!job` ⇒ **STOP** (deleted/foreign — company-scoped read, E-07, §5). |
| 3 | **Idempotency guard** — `(job.notes || []).some(n => n && n.author === 'AI Repair Advisor')` | truthy ⇒ **STOP** (E-02). |
| 4 | `const question = buildQuestion(job)` (§3.4) | `question` empty/whitespace ⇒ **STOP** (nothing to ask). |
| 5 | `const result = await ragClient.ask({ question, filters })` | `result === null` ⇒ **STOP** (down/blank/empty, UC-06/E-03/E-05/E-06/E-10). |
| 6 | `const text = formatNote(result)` (§3.5) | `text === null` ⇒ **STOP** (nothing groundable). |
| 7 | `await jobsService.addNote(jobId, text, [], 'AI Repair Advisor', 'system')` | — writes the single note. |

- **Inputs:** `jobId` (from `event.payload.id`), `companyId` (from `event.company_id`). No client-supplied ids.
- `AI_REPAIR_ADVISOR_APP_KEY = 'ai-repair-advisor'` — a module constant (mirrors `marketplaceService.SMART_SLOT_ENGINE_APP_KEY`; the gate resolves via the **generic** `marketplace_installations status='connected'` path — **no** `isAppConnected` special-case, unlike `google-email`/`telephony-twilio`).
- Lazy `require('./ragClient')` / `require('./jobsService')` / `require('./marketplaceService')` inside the function to avoid boot-order cycles (same idiom the subscriber uses).

### 3.4 `buildQuestion(job)` — question assembly

Pure function over the job object (fields from `rowToJob`, `jobsService.js`: `description`, `comments`, `job_type`, `service_name`, `metadata`).

- **Problem text (primary → fallback):** `problem = trim(job.description) || trim(job.comments) || ''`.
- **Service context:** `svc = job.job_type || job.service_name || null`.
- **Assembled string** (example shape):
  ```
  Customer-reported problem: <problem>. Service type: <svc>.[ Model: <model>.]
  ```
  - If `problem` is empty and `svc` present, the question still forms from `svc` (thin-description path, UC-07). If both empty ⇒ return `''` ⇒ step 4 stops.
- **Filters (from `job.metadata`, case-insensitive key match; omit any not found — never send empty strings):**
  - `filters.brand` ← first non-empty of metadata keys `brand`, `make`.
  - `filters.unitType` ← first non-empty of metadata keys `unit_type`, `unitType`, `appliance`.
  - `model` ← metadata key `model` — **no RAG filter slot exists for model**, so it is appended to the question text (`Model: <model>.`), not to `filters`.
  - Metadata custom-field keys are user-defined; matching normalizes on lowercased/trimmed key names against the candidate lists above. Result: `filters` may be `{}` (E-09) — RAG works without it.
- Returns `{ question, filters }` (or the service composes `filters` alongside — either shaping is acceptable so long as `ragClient.ask` receives `{ question, filters }`).

### 3.5 `formatNote(result)` — the 3-section note (+ note object)

Input: the normalized object from §3.1 (guaranteed to have ≥1 groundable field, since `ask` already applied *empty ⇒ null*). Output: a **markdown string**, or `null` (defensive: if, despite the guarantee, no section renders).

**Rendering rules (sections in fixed order; a section is emitted only if it has content):**
- **Title line** (always, when a note is produced): `**AI Repair Advisor — diagnostic starting point**`.
- **Summary line** (only if `summary`): the summary text on its own line.
- **(a) Probable causes** — only if `causes.length > 0`. Header `**Probable causes**`, then one bullet per cause:
  - `- <cause> — ~<pct>% likely`, where `pct` = `Math.round(likelihood * 100)` if `likelihood <= 1`, else `Math.round(likelihood)` if `likelihood > 1`.
  - If `likelihood` is `null`/NaN, omit the `— ~…% likely` suffix (bullet is just `- <cause>`).
- **(b) Diagnosis steps** — only if `steps.length > 0`. Header `**Diagnosis steps**`, ordered list:
  - `N. <step>`; if `expected` present, append ` (expected: <expected>)`.
- **(c) Diagnostic mode** — **only if `diagnosticMode` non-empty**. Header `**Diagnostic mode**`, then the entry instructions. **Omitted header-and-all when absent (E-04).**
- **Footer disclaimer** (always, when a note is produced): `_AI-generated from service-manual knowledge base — verify on-site before acting._`
- No other sections in Stage 1 (no parts, no dispatcher-questions, no safety — those are Stage 2).

**3-section fill-in example:**
```markdown
**AI Repair Advisor — diagnostic starting point**
Front-load washer won't drain — most consistent with a blocked pump or clogged filter.

**Probable causes**
- Clogged drain pump filter — ~55% likely
- Failed drain pump motor — ~30% likely
- Kinked or blocked drain hose — ~15% likely

**Diagnosis steps**
1. Power off and unplug the unit before servicing.
2. Open the pump filter access panel; inspect for debris (expected: coins/lint/hair).
3. Check the drain hose for kinks and clogs at the standpipe.
4. Run a spin-only cycle and listen for the pump energizing.

**Diagnostic mode**
Hold Spin + Soil for 3 seconds within 10 seconds of powering on to enter service test mode; press Start to run the drain test.

_AI-generated from service-manual knowledge base — verify on-site before acting._
```

**2-section variant (no diagnostic mode, E-04):** identical, with the entire **Diagnostic mode** block removed — Probable causes and Diagnosis steps only, followed by the disclaimer.

**Note object stored** (produced by `addNote(jobId, text, [], 'AI Repair Advisor', 'system')`, per `jobsService.js:1157`):
```json
{
  "id": "<uuid>",
  "text": "<the markdown above>",
  "created": "<ISO-8601>",
  "created_by": "system",
  "author": "AI Repair Advisor"
}
```
Appended to `jobs.notes` JSONB; renders automatically in the job card; `created_by='system'` ⇒ non-editable by regular users.

> **Reuse note:** `addNote` also mirrors the note text to Zenbooker when `job.zenbooker_job_id` is set (`jobsService.js:1179`). This is the existing seam behavior and is acceptable (the note is genuine job content). No change to `addNote`.

### 3.6 Idempotency guard (detail)

- **Detection:** in `runForJob` step 3, `(job.notes || []).some(n => n && n.author === 'AI Repair Advisor')`. The advisor is the sole writer of that exact `author` string, so its presence proves a prior successful append.
- **Guarantees at most one advisor note per job:** normal dispatch runs once; `redispatch`/manual retry re-reads `job.notes` and short-circuits; two rapid creations of the *same* job resolve to the same `jobId` and the second sees the first's note. (A theoretical exact-simultaneous double-detached-run is out of scope for Stage 1 — best-effort; the guard covers all realistic redelivery.)

### 3.7 Marketplace seed (migration 161) + gate

- **New:** `backend/db/migrations/161_seed_ai_repair_advisor_marketplace_app.sql` — `INSERT INTO marketplace_apps (...) VALUES ('ai-repair-advisor', 'AI Repair Advisor', 'Albusto', <category e.g. 'operations'>, 'internal', <short/long desc>, '[]'::jsonb, 'none', 'published', 'support@albusto.com', '{ "access_summary": [...], "requires_credential_input": false }'::jsonb) ON CONFLICT (app_key) DO UPDATE SET ... updated_at = NOW();` — **exact structural copy of seed 126** (`126_seed_smart_slot_engine_marketplace_app.sql`): `provisioning_mode='none'`, `status='published'`, `app_type='internal'`, `requires_credential_input:false`, **no `setup_path`** (pure gate). Gate-only.
- **New:** `backend/db/migrations/rollback_161_seed_ai_repair_advisor_marketplace_app.sql` — `DELETE FROM marketplace_apps WHERE app_key='ai-repair-advisor';` (mirrors `rollback_145`; idempotent, FK-safe by construction).
- **Modified:** `backend/src/db/marketplaceQueries.js` → register `await query(readMigration('161_seed_ai_repair_advisor_marketplace_app.sql'));` in `ensureMarketplaceSchema()`, alongside seeds 126/132/145 (idempotent).
- **Migration number:** architecture chose **161** (master max 155; all-refs max 160, shipped prod 2026-07-10; worktree local max 151). **Re-verify the true max immediately before creating the file** — parallel branches drift.
- **Gate:** `marketplaceService.isAppConnected(companyId, 'ai-repair-advisor')` resolves through the generic path — `getPublishedAppByKey` → `findActiveInstallation` → `installation.status === 'connected'`. No new HTTP route; connect/disconnect reuses the already-guarded `/api/marketplace/*` (`authenticate` + `requirePermission('tenant.integrations.manage')` + `requireCompanyAccess`).

### 3.8 Subscriber `kb-diagnostics`

Registered in `backend/src/services/eventSubscribers.js`:
```
eventBus.subscribe('kb-diagnostics', 'job.created', (event) => {
  const jobId = event.payload?.id;
  const companyId = event.company_id;
  if (!jobId || !companyId) return;
  setImmediate(() => require('./kbDiagnosticsService')
    .runForJob({ jobId, companyId }).catch(() => {}));
});
```
- **Matches `'job.created'` only.** Handler **returns immediately** after scheduling `setImmediate` — it MUST NOT `await` `runForJob`, because `dispatchToSubscribers` runs subscribers **sequentially with `await`** (`eventBus.js:84-105`); awaiting the ~30s RAG call would stall siblings (`rules-engine`, `billing-meter`) for the whole company. Lazy `require` avoids boot-order cycles.

---

## 4. Error-handling matrix

| Condition | `ragClient.ask` | `runForJob` | Note? | Log | Job status / user impact |
|-----------|-----------------|-------------|-------|-----|--------------------------|
| App not connected (UC-05) | not called | STOP @ step 1 | none | — | unaffected |
| App disconnected mid-flight (E-01) | not called | STOP @ step 1 (re-check) | none | — | unaffected |
| Job deleted before run (E-07) | not called | STOP @ step 2 (`getJobById`→null) | none | — | unaffected |
| Advisor note already present (E-02) | not called | STOP @ step 3 | none (no 2nd) | — | unaffected |
| Empty/whitespace question | not called | STOP @ step 4 | none | — | unaffected |
| `RAG_API_URL` blank (E-10/FR-12) | returns `null`, no HTTP | STOP @ step 5 | none | (inert; quiet) | unaffected |
| RAG unreachable / timeout / non-2xx (UC-06/E-05) | returns `null` (caught) | STOP @ step 5 | none | `console.warn('[RAG] …')` | **success**; nothing surfaced |
| Malformed / non-JSON body (E-06) | returns `null` (parse fail) | STOP @ step 5 | none | `console.warn('[RAG] …')` | unaffected |
| 200 but empty causes AND steps (E-03) | returns `null` (empty⇒null) | STOP @ step 5 | none | (quiet) | unaffected |
| 200, causes+steps, no diag-mode (E-04) | returns object, `diagnosticMode:null` | proceeds | **1 note, 2 sections** | — | note in card |
| 200, all three present | returns full object | proceeds | **1 note, 3 sections** | — | note in card |
| Unexpected throw anywhere in detached path | — | outer `try/catch` swallows | none | `console.warn('[kb-diagnostics] …')` | unaffected |
| `addNote` throws (e.g. DB) | — | outer guard swallows | none/partial-safe | logged | job-create already returned; not surfaced |

**Invariant:** the advisor is **strictly post-commit, detached, and best-effort** — no failure mode delays or fails the `POST /api/jobs` / `convertLead` response, and none writes a malformed/partial note.

---

## 5. Security & isolation contract

- **`companyId` provenance:** taken **only** from `req.companyFilter?.company_id` at the create site, passed as the 1st positional arg to `eventBus.emit`, stored as `event.company_id`, and read by the subscriber. **No client-supplied company id anywhere** in the flow.
- **Company-scoped reads/writes:** `getJobById(jobId, companyId)` filters `WHERE j.id = $1 AND j.company_id = $2` (`jobsService.js:589`) — a foreign or non-existent job returns `null` (404-equivalent), so the advisor never reads or annotates another company's job. `isAppConnected(companyId, …)` is company-scoped. `addNote` targets only that `jobId`.
- **Gate uses the event's `companyId`** (not a re-derived/ambient value), so tenant A's connection state cannot trigger notes on tenant B's jobs.
- **No new HTTP route** is introduced — connect/disconnect reuses the already-guarded `/api/marketplace/*` (401 unauthenticated / 403 without `tenant.integrations.manage`, covered by existing marketplace tests). The new surface is entirely event-internal.
- **Mandatory tenant-isolation test:** assert a `job.created` for company A's job attaches the note only to A's job, and that the gate/read use A's `companyId` (a connected-A / not-connected-B pair proves no cross-tenant note).
- **RAG payload** is built solely from the originating job's own fields — no cross-job/cross-tenant data leaves in the question.

---

## 6. Non-goals (Stage 1 — restated)

- **No additional note sections** — parts recommendations, dispatcher clarifying-questions, safety warnings are **Stage 2** and MUST NOT appear (three sections max, diagnostic-mode conditional).
- **No non-human triggers** — Zenbooker webhook-sync jobs and scheduler/`agentWorker` jobs do **not** trigger the advisor (they don't call `createDirectJob`/`convertLead`).
- **No structured brand/model modeling** — no new columns, no NLP brand/unit extraction; only existing `jobs.metadata` custom fields are read opportunistically.
- **No re-generation / refresh** — no re-run on job edit, no manual "ask again", no multiple notes per job.
- **No bespoke settings UI** — only the auto-rendered marketplace tile (connect/disconnect); no dedicated page, no per-company RAG tuning.
- **No persistence of raw RAG payloads, no streaming, no feedback loop, no advisor-quality analytics.**
- **No deployment/network-path work** — the real Vultr→mini RAG route is decided at deploy time, out of code scope.
- **No frontend work** — the tile + connect/disconnect UI render from the seed.

---

## 7. Test seams (for the Test-Cases agent)

- **`ragClient`:** canned happy `/ask` payload → normalized object (summary + causes + steps + diagnosticMode + confidence/grounded); blank `RAG_API_URL` → `null`, **no HTTP**; non-2xx → `null` (single attempt; 4xx not retried); empty causes+steps → `null`; malformed body → `null`; fence-missing but `{…}` present → parsed via first-`{`/last-`}` fallback.
- **`kbDiagnosticsService.runForJob`** with mocked `ragClient` + `jobsService` + `marketplaceService`: connected + good payload → `addNote` called **once** with `(jobId, <3-section text>, [], 'AI Repair Advisor', 'system')`; not-connected → no `ragClient` call, no `addNote`; `ask`→null → no `addNote`; job already carries advisor note → no `addNote` (idempotency); diagnostic-mode absent → 2-section text (no "Diagnostic mode" header); `getJobById`→null → no `addNote`, no throw.
- **`buildQuestion`:** description-primary; comments-fallback when description empty; both empty → `''`; brand/unitType extracted from metadata (brand/make, unit_type/appliance) and omitted when absent; model folded into text.
- **Subscriber:** `kb-diagnostics` matches `'job.created'` only and returns fast (schedules `setImmediate`, does not await RAG).
- **Emit sites (spy `eventBus.emit`):** `createDirectJob` always emits `job.created` with `{id: jobId}` + `companyId`; `convertLead` emits only when `localJobCreated===true`.
- **Gate:** `isAppConnected` generic path → `true` iff a `connected` installation exists for the company; company-scoped.
- **Security/isolation:** tenant-isolation test (A-connected / B-not) — note attaches only to A's job; gate/read use the event's `companyId`. (401/403 for connect/disconnect covered by existing marketplace tests — no new route.)

---

## 8. Traceability

| Requirement | Covered by |
|-------------|-----------|
| FR-01 seed + `ensureMarketplaceSchema` | §3.7 |
| FR-02 `isAppConnected` gate | §3.3 step 1, §3.7 |
| FR-03 `job.created` at both sites | §3.2 |
| FR-04 `kb-diagnostics` subscriber + `setImmediate` | §3.8 |
| FR-05 `ragClient` POST `/ask` + parse | §3.1 |
| FR-06 question build + optional filters | §3.4 |
| FR-07 exactly one note, 3 sections, (c) conditional | §3.5 |
| FR-08 `addNote(… 'AI Repair Advisor','system')` | §3.5 |
| FR-09 idempotency | §3.6, E-02 |
| FR-10 best-effort isolation from create | §1, §3.3, §4 |
| FR-11 company scoping | §5 |
| FR-12 config `RAG_API_URL`/`RAG_TIMEOUT_MS`, inert if blank | §3.1, E-10 |
| AC-01..AC-10 | UC-03/04 (§2), §3.5, UC-05/E-03/E-04, UC-06/§4, UC-07, E-11, E-02, §5, §3.5, §7 |
