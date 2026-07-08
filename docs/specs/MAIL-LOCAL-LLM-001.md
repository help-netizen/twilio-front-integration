# MAIL-LOCAL-LLM-001 — Route Mail Secretary triage to a local Ollama LLM

**Status:** spec (2026-07-08). **Type:** backend behavior-change, one file.
**Builds on** `Docs/specs/MAIL-AGENT-001.md` — the surrounding pipeline (exclusion DSL, gate,
`needs_attention`/confidence decision, task upsert, `mail_agent_reviews` logging, fail-quiet) is
**UNCHANGED**. This spec covers only the classifier's LLM transport.

## Общее описание

`backend/src/services/mailAgentClassifier.js` `classifyEmail(input)` becomes a thin dispatcher that
routes to a local **Ollama** transport by default, keeping the existing **Gemini** transport intact
but dormant as a one-env-var revert valve. Prompt text, `input` shape, verdict shape, and the
`{ verdict, model, latency_ms }` success contract are byte-identical to today. No migration, no route,
no frontend, no new npm dep. The `POST /dry-run` path inherits the swap automatically (it also calls
`classifyEmail`). Call summaries (`callSummaryService.js`) stay on Gemini.

## Contracts

**Dispatcher.** `classifyEmail(input)` → `PROVIDER === 'gemini' ? classifyViaGemini(input) : classifyViaOllama(input)`. Default = ollama.

**Request (ollama).** `POST ${OLLAMA_URL}/api/generate`, `Content-Type: application/json`, per-attempt
`AbortController` wired to `TIMEOUT_MS`. Body — exact:
```json
{
  "model": "<MAIL_AGENT_OLLAMA_MODEL>",
  "prompt": "<SYSTEM_PROMPT>\n\n<buildUserPrompt(input)>",
  "system": "",
  "format": "json",
  "stream": false,
  "keep_alive": "10m",
  "options": { "temperature": 0.1, "num_ctx": 4096, "num_predict": 512 }
}
```
`SYSTEM_PROMPT`, `buildUserPrompt`, `parseVerdict`, `CATEGORIES`, `MAX_BODY_CHARS`,
`module.exports = { classifyEmail }` are untouched.

**Response / parse — CRITICAL contract.** On HTTP 200: `const data = await response.json()` yields the
Ollama envelope; the model output lives in `data.response` as a **JSON string**. Feed that **raw
string directly** into the existing `parseVerdict(data.response)`. Do **NOT** `JSON.parse` it first —
`parseVerdict` already `JSON.parse`s its argument, so pre-parsing yields an object that `String()`-ifies
to `"[object Object]"` and throws. The ```` ``` ````-fence stripping in `parseVerdict` stays harmless.

**Success return.** `{ verdict, model: MAIL_AGENT_OLLAMA_MODEL, latency_ms }`, where `latency_ms` is
wall-clock (`Date.now() - startTime`). The recorded `model` is the Ollama model actually used.

## Сценарии поведения

- **S1 — Ollama classify (default).** `provider=ollama`, HTTP 200, valid model JSON → `parseVerdict`
  produces the verdict → return `{ verdict, model: OLLAMA_MODEL, latency_ms }`. Caller applies the
  `needs_attention` + `confidence_threshold` (0.6) gates and task upsert exactly as in MAIL-AGENT-001.
- **S2 — Provider valve → gemini.** `MAIL_AGENT_PROVIDER=gemini` → `classifyViaGemini` runs the
  existing two-model-fallback body verbatim (incl. `GEMINI_API_KEY` guard). Behavior byte-equivalent
  to today. Instant revert for the spend-cap regression.
- **S3 — Failure parity.** Any transport/parse failure after retries → `classifyEmail` **throws** →
  `mailAgentService.reviewInboundEmail` (l.159–166) writes `verdict='error'` (reason = `e.message`,
  sliced 500), creates **no** task, returns `{verdict:'error'}`, pipeline continues. No new crash path.

## Граничные случаи / обработка ошибок

Retry loop = attempts `0..MAX_RETRIES` (single model, no fallback), reusing `BACKOFF_MS` `[250,600]`
+ jitter before attempts > 0.

1. **Non-200 retryable (429 / 5xx):** set `lastError`; if `attempt < MAX_RETRIES` → `continue`; else
   `break` → throw.
2. **Non-200 non-retryable (other 4xx):** set `lastError`; `break` immediately → throw (no next model).
3. **Timeout:** `AbortController` fires at `TIMEOUT_MS` → `AbortError` caught → `lastError` = timeout;
   retry while `attempt < MAX_RETRIES`, else throw.
4. **Network unreachable (ECONNREFUSED — the prod→mini gap):** `fetch` rejects → caught → retry then
   throw. Failure parity (S3) holds; every triage yields `verdict='error'` until reachability is fixed.
5. **Empty / missing `data.response`:** mirror the Gemini empty-response branch → set `lastError`,
   `break` → throw (do not treat empty string as a valid verdict).
6. **Malformed model JSON (`parseVerdict` throws):** mirror the Gemini bad-JSON branch → retry while
   `attempt < MAX_RETRIES`, else `break` → throw. See open item below.
7. **Retries exhausted:** loop ends → `throw lastError || new Error('mail agent classification failed')`.

## Env-config

| Var | Default | Notes |
|---|---|---|
| `MAIL_AGENT_PROVIDER` | `ollama` | `ollama` \| `gemini`; picks transport at call time |
| `MAIL_AGENT_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama base; **trailing slash trimmed** |
| `MAIL_AGENT_OLLAMA_MODEL` | `qwen2.5:14b` | **NEW var** — do NOT reuse `MAIL_AGENT_MODEL` (holds a Gemini id in prod) |
| `MAIL_AGENT_TIMEOUT_MS` | `60000` | raised from 15000 for local 14B / cold-load; per-attempt abort |
| `MAIL_AGENT_RETRY_MAX` | `2` | reused; attempts = `0..MAX` |
| `GEMINI_API_KEY`, `MAIL_AGENT_MODEL`, `MAIL_AGENT_FALLBACK_MODEL` | (existing) | dormant Gemini path only |

## Constraints & non-goals

- **C1** — no Google-LSA / sender special-casing, no per-category branches, no prompt tweaks.
- **C2** — no enhancements beyond the transport swap + provider valve.
- **NFR-2** — `mailAgentService` orchestration, the 0.6 confidence gate (in the service, not the
  classifier), task creation, `mail_agent_reviews`, and `mailAgentRules.js` are untouched.
- **C3 — deploy blocker (do NOT deploy):** prod (Vultr) can't reach mini's localhost-only Ollama today.
  Commit to master is OK; going live needs `OLLAMA_HOST=0.0.0.0` on mini, `MAIL_AGENT_OLLAMA_URL` →
  mini's Tailscale addr, and `qwen2.5:14b` pulled. Config/network prerequisite, not code.
