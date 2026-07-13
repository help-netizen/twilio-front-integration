# ASSISTANT-BOT-001 — CRM-expert assistant (Gemini) inside the feedback widget

> Status: Spec (Claude-authored). Supersedes the deterministic stub bot of
> CLIENT-FEEDBACK-WIDGET-001 as the *first line* of the feedback widget.
> The human-escalation path (form → support@albusto.com + DB) is UNCHANGED.

## 1. Goal

Replace the stub bot with a real **Gemini-powered advisor** that is a genuine
expert on the Albusto CRM: it tells a CRM user **which marketplace services to
connect and how to configure them** to reach a desired outcome, tailored to what
that company already has connected. It resolves how-to / setup questions inline;
anything it can't resolve escalates to the existing human feedback form.

## 2. Hard boundary — NO business data (this is the whole design)

The assistant MUST NOT be able to read any business record — not leads, jobs,
contacts, calls, payments, estimates, invoices, timelines, users, or any PII —
neither the user's nor the company's. This is enforced **structurally**, not by
prompt text:

- The assistant backend module imports ONLY (a) a static capability catalog and
  (b) a read-only *service-config* projection. It does **not** import
  `agentSkills`, any `*Queries` module that returns records, or any credential.
- There is no tool, route, or function reachable from the loop that returns a
  record. "The model can't exfiltrate what there is no function to fetch."
- The only company-scoped read is `get_service_config` (§5.2), which returns a
  **whitelisted config DTO** — never a row, count of rows, or free-form blob.

Prompt-level rules (§7) are a second belt, not the primary control.

## 3. Locked decisions (owner interview, 2026-07-13)

1. **Knowledge source v1 = the marketplace catalog itself, standardized.** Each
   marketplace app carries TWO description layers (see §4a — the app standard):
   the existing user-facing `short_/long_description`, PLUS a new bot-facing
   `metadata.assistant` block (what it does under the hood, prerequisites, setup
   steps, outcome, when to recommend, gotchas). The assistant's knowledge is
   **derived from the live `marketplace_apps` rows** — not a separate hand-kept
   file that drifts. Claude authors the `metadata.assistant` content for all
   existing apps (backfill migration). No vector DB in v1; RAG over `docs/specs`
   is a deferred v2.
2. **Config depth = status + settings VALUES**, exposed through a per-app
   allowlist of keys (NOT a raw `metadata` dump). See §5.2.
3. **Transcripts = stored ANONYMIZED** (no `company_id`, no `user_id`, no email)
   for bot/catalog improvement. See §8.
4. **Reply UX = simple full reply + client "Thinking…" indicator** (non-streaming).
   The pending-state label is the literal English word **"Thinking…"** (NOT
   "typing"). Gemini REST `generateContent` is already non-streaming in this repo.
   SSE token streaming is a deferred v2.

Provider: Gemini primary via a `ASSISTANT_PROVIDER` env switch (mirrors
`MAIL_AGENT_PROVIDER`), default `gemini`, model `ASSISTANT_MODEL`
(default `gemini-2.5-flash`), one fallback model, `AbortController` timeout —
same shape as `yelpConvoAgentService.js` / `callSummaryService.js`.

## 4. Architecture

```
FeedbackWidget (Messenger)
  → POST /api/assistant/chat   (authenticate + requireCompanyAccess)
     → assistantService.reply({ companyId, history, userMessage })
        ├─ build system prompt = persona + capability catalog + guardrails
        ├─ bounded JSON tool-loop (mirror yelpConvoAgentService):
        │    tools = { get_capability_catalog, get_service_config }   ← ONLY these
        │    off-whitelist tool → rejected; call-cap + repeat-signature break
        ├─ Gemini generateContent (primary → fallback)
        └─ return { reply, escalate?:bool }
     → persist anonymized transcript (best-effort, non-blocking)
```

New files (implementation): `backend/src/services/assistantService.js`,
`backend/src/services/assistant/capabilityCatalog.js` (reads published apps +
`metadata.assistant` from the DB and projects the bot-facing catalog),
`backend/src/services/assistant/serviceConfig.js` (the config projection),
`backend/src/routes/assistant.js`, a **backfill migration**
`NNN_seed_assistant_app_descriptions.sql` (Claude-authored `metadata.assistant`
for all 12 apps, §4a), and migration `NNN_assistant_transcripts.sql`. Mount in
`src/server.js`:
`app.use('/api/assistant', authenticate, requireCompanyAccess, require('../backend/src/routes/assistant'))`.
**Renumber the migration to the next free number vs origin/master at commit time
([[parallel-migration-collision]]).**

The loop template is `backend/src/services/yelpConvoAgentService.js`
(strict-JSON action, `TOOL_WHITELIST`, `STRIPPED_ARG_KEYS`, call caps,
`tolerantParseAction`, DATA-fenced untrusted input). Reuse the SHAPE; do NOT
route through `agentSkills.runSkill` (that choke-point exposes data/write tools).

## 4a. Marketplace app standard — the two-layer description (NEW, project-wide)

Every marketplace app MUST carry two description layers. This is now part of the
app definition standard — a new app (or a change to an existing one) is not
"done" until both are present:

1. **User-facing** (already standard): `short_description`, `long_description` on
   the `marketplace_apps` row — what the user reads in the catalog card.
2. **Bot-facing (`metadata.assistant`)** — the under-the-hood knowledge the
   assistant uses to advise. Structured JSON on the app's `metadata`:
   ```json
   "assistant": {
     "what_it_does": "1–2 sentences, plain, outcome-oriented",
     "prerequisites": ["e.g. a connected Google mailbox"],
     "setup_steps": ["Integrations → … → Connect", "…"],
     "outcome": "what the user gets once configured",
     "recommend_when": ["user wants to take card payments", "…"],
     "gotchas": ["live vs test mode", "…"]
   }
   ```
   Keys are English, product-level, and contain **no company data**. Seeded in the
   SAME migration that seeds/updates the app (co-located → cannot drift).

**Enforcement:** the app-catalog contribution guide and `AGENTS.md` must state
that any marketplace-app migration includes/updates `metadata.assistant`. The
capability-catalog tool reads this field; a missing block degrades to
user-facing text but is flagged in review.

## 5. Tools (the entire tool surface — exactly two, both read-only)

### 5.1 `get_capability_catalog()`
- Input: none (optionally `{ appKey?: string }` to focus one app).
- Returns the catalog derived from published `marketplace_apps` rows
  (company-agnostic, product-level): array of `{ app_key, name, category,
  short_description, ...metadata.assistant }` (what_it_does, prerequisites[],
  setup_steps[], outcome, recommend_when[], gotchas[]). Source = a read of
  published apps + their `metadata.assistant` (§4a). No installation / no company
  data. Cacheable (catalog changes only on app migrations).

### 5.2 `get_service_config()`  — company-scoped, whitelisted
- Input: none. Uses `companyId` from the request (never from model args).
- Source reads (read-only): `marketplaceQueries.listPublishedAppsWithInstallation(companyId)`,
  and for connected apps that carry settings: `installation.metadata.settings`
  and `slotEngineSettingsQueries.getByCompany(companyId)`.
- Returns per app: `{ app_key, name, category, status, configured }` where
  `status ∈ {connected, not_connected, provisioning, error}`, plus a `settings`
  object containing **only the keys in the per-app ALLOWLIST** below. Any key not
  listed is dropped. Never returns records, counts of records, credentials, tokens,
  webhook secrets, or raw `metadata`.

  Per-app settings allowlist (initial; extend deliberately, never wildcard):
  - `stripe-payments`: `{ live_mode, connected_ready }`
  - `telephony` / `telephony-twilio`: `{ autonomous_mode, has_numbers }`
  - `rely-leads`: `{ zone_mode, zip_count, unit_types, brands }`
  - `slot-engine` (from slot_engine_settings): `{ rec_window_days, max_radius_mi, per_day_cap, nearest_fallback_enabled }`
  - `mail-secretary`: `{ provider, enabled }`
  - `vapi-ai`: `{ assistant_configured }`
  - default for any other app: `{}` (status/configured only).

  Rationale: the owner chose "settings values", so we surface config that helps
  the advisor be specific — but via an explicit key allowlist so a future
  sensitive key can never leak by default. `zip_count` is a count of configured
  ZIPs (config sizing), NOT lead/job data.

## 6. Endpoint contract — `POST /api/assistant/chat`
- Auth: `authenticate` + `requireCompanyAccess` (same as feedback).
- Request: `{ history: {role:'user'|'assistant', text:string}[], message: string }`.
  `history` capped (e.g. last 12 turns) server-side; `message` length-limited.
- Response 200: `{ reply: string, escalate: boolean }`. `escalate=true` signals
  the widget to reveal the human feedback form (bot decided it can't help / user
  asked for a human).
- Errors: 400 validation; 429 rate-limit (§9); 503 provider unavailable →
  widget shows a graceful "let me hand you to a human" + form.
- `companyId = req.companyFilter.company_id`; model NEVER receives it as text.

## 7. Guardrails (system-prompt belt + code belt)
- Persona: Albusto onboarding/config expert. Scope = features, connections,
  configuration, outcomes. Tone per CLAUDE.md (warm, direct, no fluff).
- Rules: never ask for or reveal business data; on "how many leads / show my
  jobs" → explain it has no data access and point to the relevant screen.
  Prefer concrete next steps ("Integrations → Stripe → Connect"). If unsure or
  the request is a bug/complaint/billing issue → set `escalate=true`.
- Injection: user text fenced as DATA-not-instructions (yelpConvoAgent
  convention); tool args from the model are ignored for `companyId` and any
  server-owned key (`STRIPPED_ARG_KEYS`).
- Loop safety: max N tool calls/turn, repeat-signature break, hard timeout.

## 8. Anonymized transcripts (owner: store for improvement)
- New table `assistant_transcripts` — deliberately **company-agnostic**:
  `id, turn_index, role, text, tools_used jsonb, model, latency_ms,
  token_usage jsonb, created_at`. **No `company_id`, no `user_id`, no email
  column.** A per-conversation opaque `session_key` (random, client-generated,
  NOT tied to identity) groups turns.
- Written best-effort, non-blocking (never delays the reply; failure ignored).
- PII caveat: `text` is user-typed and may contain data the user pasted. v1
  stores as-is under the anonymization above; a light PII scrub (emails/phones)
  is a documented follow-up. Surface this caveat to the owner in the final report.
- Retention: add a note for a future TTL/cleanup job (out of scope v1).

## 9. Cost & abuse controls (mandatory — prior Gemini spend-cap outage)
- Per-company rate limit (e.g. sliding window N msgs / minute) and a per-company
  daily token budget; over budget → 429 with a friendly message + escalation.
- Global provider timeout; on repeated provider failure, degrade to escalation.

## 10. Acceptance criteria / test focus
- **Isolation (P0):** static analysis/test proving `assistantService` +
  `assistant/*` do NOT import `agentSkills` or record-returning `*Queries`; the
  only company read is `get_service_config` and it returns solely allowlisted keys
  (sabotage: add a non-allowlisted key to metadata → assert it's absent from DTO).
- **Refuse-data (P0):** prompted "show me my leads / how many jobs today" → reply
  contains no data and no fabricated numbers; points to the UI.
- **Injection (P1):** user message trying to make the bot call a data tool or
  reveal companyId → no off-whitelist tool call; companyId never echoed.
- **Advisory correctness (P1):** "I want to take online payments" with Stripe
  not connected → recommends connecting Stripe + correct steps from catalog;
  with Stripe connected-not-live → advises switching to live.
- **Escalation (P1):** "this is broken / I want a human" → `escalate=true`;
  widget reveals form; form still posts to support@albusto.com + DB.
- **Cost cap (P2):** over rate/budget → 429 + graceful message.

## 11. Task breakdown (orchestration)
- **A1 (Claude):** this spec + the app standard (§4a) + a backfill migration
  seeding `metadata.assistant` for all 12 apps (Claude-authored descriptions) +
  the `AGENTS.md`/contribution-guide rule + test-cases doc.
  The 12 apps: `lead-generator` (Website Leads), `pro-referral-leads`,
  `rely-leads`, `nsa-leads`, `lhg-leads`, `mail-secretary`, `vapi-ai`,
  `stripe-payments`, `smart-slot-engine`, `google-email`, `telephony-twilio`,
  `ai-repair-advisor`.
- **A2 (GPT):** `assistant/serviceConfig.js` (allowlisted DTO) + isolation unit
  tests (import-graph assertion + allowlist sabotage). Security core — plan-first.
- **A3 (GPT):** `assistantService.js` (Gemini loop, provider switch, caps,
  guardrails) + `routes/assistant.js` + rate-limit/budget + migration
  `assistant_transcripts` + tests (refuse-data, injection, escalation mocked).
- **A4 (GPT):** frontend — wire `FeedbackWidget` chat to `/api/assistant/chat`
  (replace stub advance), a **"Thinking…"** pending indicator (literal English,
  animated dots ok), keep escalation form + file upload; behind existing
  `VITE_FEATURE_FEEDBACK_WIDGET` (+ optional sub-flag).
- **A5 (Claude):** verify (isolation proof, injection/refuse-data run
  independently), docs/changelog, final report, deploy-ask.

## 12. Non-goals (v1)
- No business-data tools (by design, permanent for this bot).
- No RAG/vector index (curated catalog only).
- No SSE token streaming (full reply).
- No "back side" (owner reply UI) — still deferred from CFW-001.
