# Тест-кейсы: MAIL-LOCAL-LLM-001 — swap email-triage classifier from Gemini to local Ollama (qwen2.5:14b)

**Source:** orchestrator brief MAIL-LOCAL-LLM-001 + `Docs/specs/MAIL-AGENT-001.md` (§"LLM call", the strict verdict schema) + caller `backend/src/services/mailAgentService.js` (l.148–166, l.288–307) + memory `local-llm-mini` (mini = Tailscale `100.78.119.41:11434`, qwen2.5:14b, 16 GB → swaps, warm ~0.8 s / cold ~18 s).

**Single file under test:** `backend/src/services/mailAgentClassifier.js` (this doc is written **BEFORE** the swap — today the file is Gemini-only).

**Design under test (change points):**
- `classifyEmail(input)` becomes a **dispatcher**: `MAIL_AGENT_PROVIDER` (default `ollama`) → `classifyViaOllama`; `'gemini'` → the existing Gemini path. Return contract **unchanged**: `{ verdict, model, latency_ms }` or **throws** after retries.
- `classifyViaOllama(input)` POSTs to **`${OLLAMA_URL}/api/generate`**, body =
  `{ model: OLLAMA_MODEL, prompt: SYSTEM_PROMPT + "\n\n" + buildUserPrompt(input), system: "", format: "json", stream: false, keep_alive: "10m", options: { temperature: 0.1, num_ctx: 4096, num_predict: 512 } }`.
  Reads `data.response` (**a STRING**) and passes it **directly** to the existing `parseVerdict` (which does its own `JSON.parse` + fence-strip — **do NOT pre-parse**). Returns `{ verdict, model: OLLAMA_MODEL, latency_ms }` or throws.
- **Config:** `OLLAMA_URL` (trailing slash trimmed), `OLLAMA_MODEL` default `qwen2.5:14b` (**independent of** `MAIL_AGENT_MODEL`, which stays the Gemini model), `TIMEOUT_MS` default **60000** (local is slow; cold start ~18 s), bounded retries via `MAX_RETRIES`.
- **UNCHANGED (asserted):** `parseVerdict` (fence-strip + clamps + `CATEGORIES` guard), `buildUserPrompt`, `SYSTEM_PROMPT`, the `{verdict,model,latency_ms}` return shape, the caller `mailAgentService.js` (still `try/catch → verdict='error'`), migration/DB/routes — **NONE** in this change.

---

## ⚠️ TEST VEHICLE — READ FIRST

| Fact | Consequence |
|------|-------------|
| **No jest suite is wired for mailAgent** (`grep` finds no `mailAgent*.test.js`; classifier has zero existing tests) | Coverage = **ONE runnable Node script** `scripts/verify-mail-local-llm-001.js`, run from repo root: `node scripts/verify-mail-local-llm-001.js [--section=shape\|parse\|error\|switch\|config\|sabotage\|live\|all]`. Exit non-zero on any FAIL. |
| **Classifier is backend CJS** (`module.exports`) | The script `require('../backend/src/services/mailAgentClassifier')` **directly** — no TS port, no parity guard needed (unlike the FE EMAIL-QUOTE-STRIP script). |
| **Node 18+ has a global `fetch`** | Stub `global.fetch` with a recorder that captures `(url, opts)` and returns a WHATWG-`Response`-shaped object: `{ ok, status, async json(), async text() }`. The Ollama success path awaits `response.json()` → `{ response: '<json-string>' }` and reads `.response`. |
| **Config consts are captured at MODULE-LOAD time** (`const OLLAMA_URL = …` runs on first `require`) | **LOAD-BEARING:** set `process.env` **before** `require`, and to test a different config **`delete require.cache[require.resolve(...)]` and re-require**. A helper `freshLoad(env)` = merge env → bust cache → re-require is mandatory; every config/switch case uses it. |
| **Retries use real `setTimeout` backoff** | For the all-fail error case set `MAIL_AGENT_RETRY_MAX=0` (or small) so the run stays fast; a separate assertion checks the fetch **call count == retries+1** when the error is retryable. |
| **P2 live needs the mini reachable** (tailnet `OLLAMA_HOST=0.0.0.0`, or `ssh -L 11434:localhost:11434 mini`) | `--section=live` is **opt-in / manual**, SKIPPED in the default headless run; never blocks CI. |

**N/A here (deliberate — do not flag as a gap):** the role's mandatory auth/`401`/`403`/company-isolation/`404`-cross-tenant checks. This file is a **pure transport function** with no HTTP surface, no `company_id`, no DB. Auth + isolation live in the unchanged `/api/mail-agent` routes, covered by MAIL-AGENT-001.

**Shared fixture** — `SAMPLE = { fromName:'Jane Doe', fromEmail:'jane@acme.com', subject:'Reschedule Tuesday visit', bodyText:'Hi, can we move my appointment to Thursday morning?', knownContact:true, contactName:'Jane Doe' }`. **Valid model output string** — `VALID = '{"needs_attention":true,"category":"scheduling","confidence":0.9,"priority":"p2","reason":"Customer wants to reschedule.","task_title":"Reply to reschedule request from Jane"}'`.

---

## Scenario map

| Brief item | Meaning | Priority | Section |
|---|---|---|---|
| 1 | Request-shape: correct URL + body to Ollama | **P0** | `shape` |
| 2 | Parse/verdict: valid + code-fenced 200 → schema-valid verdict | **P0** | `parse` |
| 3 | Error path: all-fail throws; empty `response` throws | **P0** | `error` |
| 6 | Negative control / sabotage: harness FAILs when feature is broken | **P0** | `sabotage` |
| 4 | Provider switch: `gemini` vs default `ollama` routing | **P1** | `switch` |
| 5 | Config defaults: URL trim, TIMEOUT 60000, OLLAMA_MODEL independence | **P1** | `config` |
| 7 | Live integration on real mini (parity, sequential) | **P2** | `live` |

**Coverage:** 9 cases — **P0:** 5 · **P1:** 2 · **P2:** 2. **Unit (headless, stubbed fetch):** 7 · **Integration (live mini):** 2.

---

### TC-MLL-001 — Request-shape: POST to Ollama `/api/generate` with the exact body
- **Priority:** P0 · **Type:** Unit (stubbed fetch)
- **Precondition:** `freshLoad({ MAIL_AGENT_PROVIDER:'ollama', OLLAMA_URL:'http://mini:11434', OLLAMA_MODEL:'qwen2.5:14b' })`; `global.fetch` = recorder returning `200 { response: VALID }`.
- **Steps:** `await classifyEmail(SAMPLE)`; inspect the single captured request.
- **Expected:**
  1. URL === `http://mini:11434/api/generate`; method `POST`; header `Content-Type: application/json`.
  2. `body = JSON.parse(opts.body)` with: `body.model === 'qwen2.5:14b'`, `body.format === 'json'`, `body.system === ''`, `body.stream === false`, `body.keep_alive === '10m'`.
  3. `body.options.temperature === 0.1`, `body.options.num_ctx === 4096`, `body.options.num_predict === 512`.
  4. `body.prompt` **contains the whole `SYSTEM_PROMPT`** (assert an anchor substring, e.g. `"You triage inbound email"`) **AND** the `buildUserPrompt` fields: `"Jane Doe"`, `"jane@acme.com"`, `"Reschedule Tuesday visit"`, and the body text `"move my appointment to Thursday"`, and the `KNOWN CONTACT` marker.
  5. No request went to `generativelanguage.googleapis.com`.

### TC-MLL-002 — Parse/verdict: valid 200 → schema-valid verdict (parseVerdict guarantees)
- **Priority:** P0 · **Type:** Unit (stubbed fetch)
- **Precondition:** ollama provider; `fetch` → `200 { response: VALID }`.
- **Steps:** `const r = await classifyEmail(SAMPLE)`.
- **Expected:** `r` = `{ verdict, model, latency_ms }` with `r.model === 'qwen2.5:14b'`, `typeof r.latency_ms === 'number'` (≥ 0); and `r.verdict` passes every parseVerdict guarantee:
  - `verdict.needs_attention === true` (strict bool);
  - `CATEGORIES.has(verdict.category)` (here `'scheduling'`);
  - `0 ≤ verdict.confidence ≤ 1` (here `0.9`);
  - `verdict.priority` ∈ `{'p1','p2'}` (here `'p2'`);
  - `typeof verdict.reason === 'string'` && non-empty; `typeof verdict.task_title === 'string'` && `length ≤ 60`.
  - **Clamp probe (same section):** feed `response` with `confidence:1.7, priority:"p3", category:"bogus"` → verdict clamps to `confidence:1`, `priority:'p2'`, `category:'other'` (proves `parseVerdict` still runs on the Ollama string).

### TC-MLL-003 — Parse/verdict: code-fence-wrapped output still parses
- **Priority:** P0 · **Type:** Unit (stubbed fetch)
- **Precondition:** ollama provider; `fetch` → `200 { response: '```json\n' + VALID + '\n```' }`.
- **Steps:** `await classifyEmail(SAMPLE)`.
- **Expected:** returns a valid verdict identical to TC-MLL-002 (parseVerdict strips the ```` ```json ```` fence). **Load-bearing double duty:** this case throws if anyone reintroduces pre-parsing (`JSON.parse(data.response)` before `parseVerdict`), because `JSON.parse` cannot parse a fenced string — so it also guards the "pass the STRING directly" contract.

### TC-MLL-004 — Error path: transport fails on every attempt → throws after retries
- **Priority:** P0 · **Type:** Unit (stubbed fetch)
- **Precondition:** ollama provider, `MAIL_AGENT_RETRY_MAX=1` (keep fast). Two variants:
  - (a) `fetch` **rejects** every call (`throw new Error('ECONNREFUSED')`);
  - (b) `fetch` resolves `503` (retryable) every call.
- **Steps:** `await expect(classifyEmail(SAMPLE)).rejects` — wrap in try/catch, assert it threw.
- **Expected:** `classifyEmail` **throws** (does NOT return `{verdict:'error'}` — the caller in `mailAgentService.js` relies on the throw to write `verdict='error'`). Fetch was called `MAX_RETRIES + 1` times (== 2). Thrown error message references Ollama/the model (not a Gemini string).
- **Regression anchor:** confirms the caller contract at `mailAgentService.js:159–165`.

### TC-MLL-005 — Error path: 200 but empty/missing `response` field → throws
- **Priority:** P0 · **Type:** Unit (stubbed fetch)
- **Precondition:** ollama provider, low retries. Variants: `200 {}` (no `response`); `200 { response:'' }`; `200 { response:'   ' }`; `200 { response:'not json' }`.
- **Steps:** `await classifyEmail(SAMPLE)` inside try/catch.
- **Expected:** every variant **throws** (empty guard, or `parseVerdict`'s `JSON.parse` throwing) → propagates so caller records `verdict='error'`. It must NOT return a fabricated/empty verdict.

### TC-MLL-006 — Provider switch: `gemini` vs default `ollama` routing
- **Priority:** P1 · **Type:** Unit (stubbed fetch)
- **Precondition:** stub `fetch` recorder returning provider-appropriate 200 bodies (Gemini: `{candidates:[{content:{parts:[{text:VALID}]}}]}`; Ollama: `{response:VALID}`). Requires `GEMINI_API_KEY` set for the gemini leg.
- **Steps:**
  1. `freshLoad({ MAIL_AGENT_PROVIDER:'gemini', GEMINI_API_KEY:'k' })` → `classifyEmail(SAMPLE)`; capture URL.
  2. `freshLoad({ MAIL_AGENT_PROVIDER:'ollama', OLLAMA_URL:'http://mini:11434' })` → `classifyEmail(SAMPLE)`; capture URL.
  3. `freshLoad({ /* MAIL_AGENT_PROVIDER unset */ OLLAMA_URL:'http://mini:11434' })` → default.
- **Expected:**
  1. Gemini leg hits `https://generativelanguage.googleapis.com/...:generateContent` and **never** `/api/generate`.
  2. Ollama leg hits `.../api/generate` and **never** `generativelanguage.googleapis.com`.
  3. Unset provider === ollama (default) — hits `/api/generate`.

### TC-MLL-007 — Config defaults: URL trim, TIMEOUT 60000, OLLAMA_MODEL independence
- **Priority:** P1 · **Type:** Unit (stubbed fetch + introspection)
- **Steps / Expected:**
  1. **Trailing-slash trim:** `freshLoad({ OLLAMA_URL:'http://mini:11434/' })` → posted URL === `http://mini:11434/api/generate` (exactly one slash, no `//api`).
  2. **TIMEOUT default:** with no `MAIL_AGENT_TIMEOUT_MS`/`OLLAMA_TIMEOUT_MS`, effective timeout === **60000**. Assert via a fetch stub that records `opts.signal` and checks the AbortController fires only at 60 s (or, simpler, expose/inspect the constant); do NOT hardcode the old Gemini `15000`.
  3. **Model independence:** `freshLoad({ MAIL_AGENT_MODEL:'gemini-2.5-flash', /* no OLLAMA_MODEL */ })` on the ollama path → `body.model === 'qwen2.5:14b'` (Ollama model is NOT read from `MAIL_AGENT_MODEL`). Then `freshLoad({ OLLAMA_MODEL:'qwen2.5:7b' })` → `body.model === 'qwen2.5:7b'`.

### TC-MLL-008 — Negative control / sabotage (harness must FAIL when broken)
- **Priority:** P0 · **Type:** Meta / self-test of the checks
- **Rationale:** proves TC-MLL-001…005 are load-bearing, not vacuous — a green run on a correct impl AND a red run on a sabotaged impl.
- **Steps:** run `--section=sabotage`, which loads a **mutated copy** of the classifier (temp file / monkeypatch) under each sabotage and re-runs the relevant assertions:
  - (a) `temperature` → `0.7` ⇒ **TC-MLL-001.3 FAILs**.
  - (b) `format` omitted from body ⇒ **TC-MLL-001.2 FAILs**.
  - (c) pre-parse reintroduced (`parseVerdict(JSON.parse(data.response))`) ⇒ **TC-MLL-003 FAILs** (fence throws) and TC-MLL-002 FAILs.
  - (d) provider dispatch inverted (ollama → Gemini URL) ⇒ **TC-MLL-001.5 / TC-MLL-006 FAIL**.
  - (e) error path softened (`return {verdict:'error'}` instead of throw) ⇒ **TC-MLL-004 FAILs**.
- **Expected:** each sabotage yields at least one **FAIL** from the exact case named; the un-sabotaged baseline is all-green. Section exit is non-zero unless every sabotage was detected.

### TC-MLL-009 — Live integration on the real mini (parity, sequential)
- **Priority:** P2 · **Type:** Integration (live) — **manual / opt-in, `--section=live`, SKIPPED by default**
- **Precondition:** mini reachable — `OLLAMA_URL=http://100.78.119.41:11434` over tailnet (`OLLAMA_HOST=0.0.0.0`) **or** `ssh -L 11434:localhost:11434 mini` then `OLLAMA_URL=http://localhost:11434`; `qwen2.5:14b` pulled; **no** fetch stub (real network); `TIMEOUT_MS` default 60000 covers cold start (~18 s).
- **Fixtures:** ~5 real inbound emails (e.g. from `mail_agent_reviews` history, or a small curated JSON), spanning categories (scheduling, complaint, newsletter/spam, invoice, unknown-lead).
- **Steps:** for each email, `await classifyEmail({...})` **sequentially** (never in parallel — 16 GB shared box swaps; no overload); collect verdicts + latencies.
- **Expected:**
  1. Every call returns a **schema-valid** verdict (same guarantees as TC-MLL-002) with `model==='qwen2.5:14b'`; no throw.
  2. **Parity spot-check** vs the benchmark (prior Gemini verdicts / labels for the same emails): `needs_attention` and coarse `category` agree on the clear cases (allow drift on ambiguous ones — this is a smoke/parity gate, not an accuracy gate).
  3. Latencies logged (warm ≪ 60 s); a cold first call may approach ~18 s but must not time out.

---

## Coverage gaps / notes

- **Classification QUALITY (accuracy of qwen2.5:14b vs Gemini) is NOT covered here.** Unit cases assert schema-validity + request/parse plumbing; TC-MLL-009 is a manual parity **smoke**, non-deterministic. A real accuracy/regression A/B (labeled set, precision) is the separate `local-llm-quality-plan` track — out of scope for this swap.
- **No auth/isolation/`401`/`403`/cross-tenant cases** — intentional: the classifier has no HTTP/`company_id`/DB surface (see Vehicle N/A note). Those remain covered by MAIL-AGENT-001 on the unchanged routes.
- **Timeout/AbortController** is exercised indirectly (TC-MLL-004 transport failure, TC-MLL-007.2 timeout constant); a dedicated "abort at 60 s → throws" case is deliberately omitted to avoid a 60 s wall-clock test — fold into TC-MLL-004 with an immediately-aborting stub if a direct abort assertion is wanted.
- **Ship bar:** green headless run (`--section=all` minus `live`) **plus** one green manual `--section=live` on the reachable mini before deploy (prod deploy is owner-consent-gated).
