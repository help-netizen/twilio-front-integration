# MAIL-AGENT-001 — Mail Secretary: AI triage of inbound email

**Status:** in development (2026-07-03)
**Owner ask:** an AI agent that reads every inbound email on the connected mailbox (Gmail for now),
decides whether a dispatcher needs to look at it, and creates a task when it does. Manual exclusion
rules (senders / subjects / free query syntax) can only *exclude* mail from review — everything not
excluded is always reviewed. The task must link back to the email (opening the task shows the
letter) and carry an agent comment explaining *why* it was flagged.

## What already exists (reuse, don't rebuild)

| Piece | Where | Why it matters |
|---|---|---|
| Marketplace app `mail-secretary` | seeded in mig 087, `requires_connected_gmail`, UI gate in IntegrationsPage | The app shell already exists; this spec fills it with behaviour |
| Inbound email choke point | `emailTimelineService.linkInboundMessage(companyId, msg)` | ALL inbound mail (push + poll) flows through it; returns `{linked, contactId, timelineId}` or `{skipped:'no_contact'}` |
| Dumb AR trigger | same file, `getTriggerConfig(companyId,'inbound_email')` → task on EVERY email | The agent replaces it (suppressed while agent is active) |
| Task agent columns | mig 100: `tasks.kind/agent_type/agent_input/agent_output/agent_status` — never written until now | Agent verdict storage; UI badge discriminator |
| One-open-task-per-thread upsert | `timelinesQueries.createTask` (auto provenance updates the open task) | Repeat emails update the task instead of spamming |
| Gemini client pattern | `textPolishService.js` (v1beta generateContent, model fallback, retries, timeouts) | Copy the transport; classification uses flash-lite |
| AR = open task on thread | AR-TASK-UNIFY-001 | Creating the task automatically surfaces Action Required in Pulse |

## Pipeline

Hook lives INSIDE `linkInboundMessage` (covers push + poll):

1. **Linked path** (contact found): after unread/SSE side-effects →
   `mailAgentService.reviewInboundEmail(companyId, msg, { contactId, timelineId })` (safe-fail, awaited).
2. **`no_contact` path**: before returning the skip →
   `mailAgentService.reviewInboundEmail(companyId, msg, { noContact: true })`.
   If the verdict is "needs attention" and `create_contact_for_unknown` is on, the agent creates the
   contact (name from `from_name`, email), then re-runs `linkInboundMessage(companyId, msg, { skipAgent: true })`
   to get the timeline (idempotent; also fires unread + SSE), then creates the task on it.
3. **Dumb trigger suppression:** the `inbound_email` AR trigger block is skipped when the agent is
   active for the company (`mailAgentService.isActive`, 60s cache).

`reviewInboundEmail` steps:
- gate: marketplace `mail-secretary` connected AND `mail_agent_settings.enabled` (default row = enabled)
- direction guard (inbound only), dedup via `mail_agent_reviews (company_id, email_message_id)` unique
- **exclusion rules** (cheap, before LLM) — match → review row `skipped_excluded` (+ rule id), stop
- **LLM classify** (Gemini) → `{needs_attention, category, confidence, priority, reason, task_title}`
- decision: `needs_attention && confidence >= threshold` (default 0.6) → create/upsert task
  - `createTask({ ..., createdBy: 'agent', kind:'agent', agentType:'mail_secretary', agentOutput:{reason,category,confidence,email_message_id}, agentStatus:'succeeded' })`
  - title = LLM `task_title`; description = reason + `From:`/`Subject:` footer; priority p1|p2 from LLM;
    due = now+60m (p1) / now+4h (p2); owner = `assign_owner_user_id` setting (nullable)
  - `setActionRequired(timelineId,'new_message','system')` + `thread.action_required` broadcast (parity with the dumb trigger)
- always write a `mail_agent_reviews` row (verdict, category, confidence, reason, task_id, model, latency)
- LLM error → verdict `error`, NO task (fail-quiet; error counter visible on the settings page)

## Exclusion rules — one rule per line, mini-query syntax

A line matches ⇒ the email is EXCLUDED (lines are OR; tokens within a line are AND).

```
token      := [-]field:pattern | [-]pattern
field      := from | subject | body | any        (bare pattern = any → from+subject)
pattern    := /regex/[i] | "quoted string" | bareword   (plain = case-insensitive contains)
'-' prefix := token must NOT match
```

Examples:
```
from:@newsletters.        subject:unsubscribe
subject:/^(promo|sale)/i
from:notifications@github.com -subject:"security alert"
```
Parser: `mailAgentRules.js` (~80 lines), regex compiled via try/catch, pattern length ≤ 300,
invalid line → PUT /settings returns 400 with the line number. Same module powers the settings-page
tester and the runtime filter.

## Data (migration 152)

```sql
CREATE TABLE mail_agent_settings (
    company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    confidence_threshold REAL NOT NULL DEFAULT 0.6,
    create_contact_for_unknown BOOLEAN NOT NULL DEFAULT TRUE,
    assign_owner_user_id UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    exclusion_rules TEXT NOT NULL DEFAULT '',          -- raw lines, parsed on read
    updated_by UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE mail_agent_reviews (
    id BIGSERIAL PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email_message_id BIGINT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL CHECK (verdict IN
        ('task_created','skipped_excluded','skipped_no_attention','skipped_low_confidence','error')),
    category TEXT, confidence REAL, reason TEXT, rule_line INT,
    task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
    model TEXT, latency_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, email_message_id)
);
-- + marketplace_apps.metadata: setup_path=/settings/integrations/mail-secretary
```
`createTask` gains optional `kind/agentType/agentInput/agentOutput/agentStatus` (writes the mig-100
columns; user path unchanged). `SELECT_TASK` adds `kind`, `agent_output` for the AI badge.

## LLM call

`mailAgentClassifier.js`, transport copied from textPolishService: primary
`MAIL_AGENT_MODEL` (default `gemini-2.5-flash-lite`), fallback `MAIL_AGENT_FALLBACK_MODEL`
(default `gemini-2.5-flash`), key `GEMINI_API_KEY`, timeout 15s, 2 retries. Input: from name/email,
subject, body_text (first 5000 chars), known-contact flag + name. Output JSON (strict parse):
`needs_attention` bool, `category` ∈ {customer_request, potential_lead, scheduling, invoice_billing,
complaint, spam, newsletter, automated_notification, other}, `confidence` 0..1, `priority` p1|p2,
`reason` (≤ 2 sentences, dispatcher-facing), `task_title` (≤ 60 chars).

## API (`/api/mail-agent`, permission `tenant.integrations.manage`)

- `GET /settings` → `{ settings, stats: {reviewed_30d, tasks_30d, excluded_30d, errors_30d, last_review_at}, installed, gmail_connected }`
- `PUT /settings` → validate rules; 400 with `{line, error}` on bad syntax
- `POST /test-rules` `{from, subject, body}` → `{excluded, rule_line}` (no LLM)
- `POST /dry-run` `{limit≤20}` → last N inbound emails through exclusions + LLM WITHOUT creating
  tasks/reviews → `[{from, subject, verdict, category, confidence, reason}]`
- `GET /reviews?limit=50` → recent decisions feed (joined with email from/subject)

## Frontend

1. **IntegrationsPage**: `mail-secretary` joins the setup-path button list (Setup/Manage →
   `/settings/integrations/mail-secretary`), Gmail gate already in place.
2. **Setup page** (SettingsPageShell + SettingsSection, route under SettingsLayout):
   - status header: installed / Gmail state, Enable-Disable (marketplace install/disconnect + settings.enabled)
   - Behaviour: sensitivity (threshold select: Flag more 0.45 / Balanced 0.6 / Strict 0.75),
     create-contact-for-unknown checkbox, assign-owner select (company users)
   - Exclusion rules: textarea (one rule per line) + syntax hint + inline tester (from/subject/body → excluded?)
   - Activity: stats chips + recent-decisions table + Dry run button (modal with results)
3. **Task surfaces**: `Task` type gains `kind`/`agent_output`; TaskCard + TasksPage rows show a
   violet `AI` chip; agent `reason` renders as the description (it already is the description) with
   the reason also available in `agent_output`. Opening the task navigates to the timeline where the
   email bubble lives (existing `parentPath` behaviour).
4. **Pulse timeline**: TaskStack already renders open tasks on the thread — the agent's task shows
   there with the AI chip + reason (the "agent comment in the header" the owner asked for).

## v1 capabilities recap + v2 candidates (owner asked "what else should it do")

**In v1:** category + confidence + priority; reason comment; auto-create contact for unknown senders
(potential leads!) behind a setting; exclusion mini-query DSL + tester; dry-run on recent mail;
decisions feed + 30-day stats; task assignee setting; repeat emails upsert the same open task;
suppression of the dumb every-email trigger; fail-quiet on LLM errors with visible error counter.

**v2 candidates (not in this change):** suggested reply draft on the task; daily digest mode
(one summary task instead of per-email); one-click "Not useful → add sender to exclusions" feedback
on agent tasks; auto-link to job/estimate/invoice when the subject carries a document number;
attachment awareness (invoices/photos); multi-mailbox support when more providers land; per-user
push notifications for p1 flags; language auto-detection for the reason text.
