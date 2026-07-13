---
id: OUTBOUND-LEAD-CALL-001
title: "Outbound Lead Caller — Sara auto-calls every NEW lead from configured sources (launch: Pro Referral) within business hours, offers engine slots, books a schedule-hold on the lead; 3-attempt ladder; dispatcher task on exhaustion/decline; marketplace app + settings page"
status: final_for_implementation
priority: P1
created_at: "2026-07-13"
language: en
owner: voice_crm_leads
requirements: "docs/requirements.md § OUTBOUND-LEAD-CALL-001 (:6383, FR-1..FR-15, N-1..N-7, D1-D5)"
architecture: "docs/architecture.md § OUTBOUND-LEAD-CALL-001 (:7218, binding — ONE dialer TWO scenarios, D-A..D-G)"
implementer: Claude (full codebase access; this spec is self-sufficient — file paths, signatures, SQL, payloads are exact)
constraints:
  - "Parts-robot chain BYTE-IDENTICAL: `processAttempt`/`scheduleRetryOrExhaust`/`retryBlockReason`/Guard-1 in `backend/src/services/outboundCallWorker.js`, `uq_outbound_call_attempts_active_job`, `outbound_call_settings` + `outboundCallSettingsService.js`, `partsCallService.js` (CANCEL-001 stays parts-only) — none modified"
  - "Inbound Sara (assistant 30e85a87), `backend/src/routes/vapi-tools.js` dispatch + `buildSkillInput` spread order, `vapiCallTimelineService.js`, `groupRouting.js`, Pulse CTEs, `IntegrationsPage.tsx`, `integrations-leads.js`, `authedFetch.ts`, `useRealtimeEvents.ts` — untouched"
  - "`leadsService.createLead(fields, companyId)` signature and the SSE `emitLeadChange` broadcasts — byte-identical; the ONLY addition is one fire-and-forget `eventBus.emit('lead.created', …)`"
  - "Lead business-hours source = `scheduleService.getDispatchSettings` (dispatch_settings), NEVER `groupRouting.isBusinessHours` (that stays parts-only) — D2/G6"
  - "No CANCEL-001-style human-takeover guards for lead chains (owner decision D3); only goal-achieved + eligibility skips"
  - "Booking = schedule-hold on the TRIGGERING lead only (LeadDateTime/LeadEndDateTime); no job, no new lead, no Zenbooker write, no FSM flip"
  - "`bookOnLead` is NOT used in-call (L1 contact-gated + newest-open-lead-of-contact targeting — wrong on both axes); NEW L0 `confirmLeadBooking` scoped to the injected leadUuid"
  - "Migration numbers 172/173 — RECHECK against origin/master at build time (parallel-worktree rule; `git fetch origin && git ls-tree origin/master backend/db/migrations | grep -E '17[0-9]_'`); local master of the main checkout is known-stale (SCHED-ROUTE-VIS gotcha)"
  - UI copy English; product = Albusto (never "Blanc" in UI strings); FORM-CANON + design tokens only
  - "Prod deploy + the VAPI assistant PATCH ONLY on the owner's explicit «да» (standing deploy-consent rule) — out of scope for the implementer"
---

# OUTBOUND-LEAD-CALL-001 — Implementation Spec

## 1. Overview

When a new lead is created whose `job_source` matches a company-configured list (launch: Pro Referral) and the company has the **Outbound Lead Caller** marketplace app connected, the system automatically dials the lead with the SAME outbound VAPI assistant the parts robot uses (Sara persona, `VAPI_OUTBOUND_ASSISTANT_ID`), inside the company's dispatch business hours. Sara greets with the lead's context, offers a pre-computed engine slot, books the pick as a schedule-hold on **that lead** via a new L0 skill `confirmLeadBooking`, and closes the chain. Unreached leads retry on an **immediate / +30 min / +2 h** ladder (scenario-scoped config, independent of the parts ladder); a final failure or a human "no" creates ONE dispatcher task on the lead. Every dialed attempt mirrors into the Pulse timeline through the existing `vapiCallTimelineService` seam with zero timeline changes.

One dialer, two scenarios (architecture verdict): `outbound_call_attempts` gains a `scenario` discriminator + nullable `lead_uuid`; the worker's tick loop and the `vapiCallStatus` webhook each gain a one-branch scenario dispatch into a NEW `outboundLeadCallService.js`. The parts path stays byte-identical.

```
POST /leads (integrations-leads) ─┐
UI create / Yelp / Sara createLead┴→ leadsService.createLead ──INSERT──→ eventBus.emit('lead.created')   [NEW §4]
    → eventSubscribers 'outbound-lead-caller' → setImmediate → outboundLeadCallService.onLeadCreated     [NEW §5.2]
        gates: app connected → source enabled (normalized) → dialable phone (else Comments trace)
               → no hold / not closed → no prior chain (lifetime-once)
        → INSERT outbound_call_attempts (scenario='lead_call', lead_uuid, attempt_no=1, 'pending',
                 scheduled_at = clampIntoWorkWindow(now, dispatchSettings))
outboundCallWorker.tick (60s, FEATURE_OUTBOUND_CALL_WORKER) — claim is scenario-agnostic; per-row dispatch [§6]
    → processLeadAttempt: lead re-read → goal-achieved skip → eligibility re-check → work-window carry
        → recommendSlots pre-compute (no slots ⇒ technical failure → ladder)
        → placeCall(scenario lead args + assistantOverrides.firstMessage) → stamp vapi_call_id+slot_json
        → vapiCallTimelineService.recordPlacement (Pulse live row, non-fatal)                             [§7]
in-call (same assistant, prompt branch on {{scenario}}=='lead_booking'):
    recommendSlots (alternatives) · checkServiceArea (zip doubts) · confirmLeadBooking → hold on THE lead
        (LeadDateTime/LeadEndDateTime) + own attempt row → 'booked' (webhook becomes idempotent no-op)    [§9]
POST /api/vapi/call-status: status-update → live pill (unchanged) · end-of-call-report →
    timeline finalize (unchanged) → terminal-idempotence no-op (unchanged) → scenario branch [NEW §8]
    → handleLeadEndOfCall: booked-belt | declined(+analysis outcome) → task | transient → ladder |
      exhausted → marker row + dispatcher task                                                            [§5.5]
```

---

## 2. Migrations

### 2.1 Numbering discipline

Current tree tops out at `171_timeline_revpage_call_page_index.sql` → this feature takes **172** (DDL) and **173** (marketplace seed). **At implementation time re-check against `origin/master`** (not the local master of the main checkout — it is known-stale): `git fetch origin && git ls-tree --name-only origin/master backend/db/migrations/ | sort | tail -5`. If a parallel worktree landed 172/173 first, renumber BOTH files, the boot-registration line (§2.3), and every in-file header reference.

### 2.2 `backend/db/migrations/172_outbound_lead_call.sql`

```sql
-- =============================================================================
-- Migration 172: OUTBOUND-LEAD-CALL-001 — lead-scoped outbound call chains on the
-- shared dialer table + per-company scenario-scoped settings.
--
-- 1) outbound_call_attempts gains a `scenario` discriminator ('parts_visit' for
--    every existing row) and a nullable lead key; job_id becomes per-scenario-
--    required (CHECK). The parts concurrency guard uq_outbound_call_attempts_
--    active_job is a partial unique on (job_id) — Postgres unique indexes ignore
--    NULL rows, so lead rows (job_id IS NULL) are invisible to it by construction.
-- 2) FR-14(a): mirror partial-unique on (lead_uuid) = at most ONE active chain
--    per lead.
-- 3) outbound_lead_call_settings: one row per company; enabled sources (FR-2) +
--    the lead ladder (FR-5) — fully independent of the parts outbound_call_settings.
-- NOT registered in ensureMarketplaceSchema (DDL, not a seed) — run via the
-- normal migration path (psql before code deploy, prod procedure unchanged).
-- =============================================================================

ALTER TABLE outbound_call_attempts ALTER COLUMN job_id DROP NOT NULL;

ALTER TABLE outbound_call_attempts
    ADD COLUMN IF NOT EXISTS scenario  TEXT NOT NULL DEFAULT 'parts_visit',
    ADD COLUMN IF NOT EXISTS lead_uuid VARCHAR(20) REFERENCES leads(uuid) ON DELETE CASCADE;

-- Shape honesty: lead rows must carry a lead, everything else must carry a job.
-- Existing rows are scenario='parts_visit' with job_id NOT NULL → valid.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_outbound_call_attempts_scope'
          AND conrelid = 'outbound_call_attempts'::regclass
    ) THEN
        ALTER TABLE outbound_call_attempts ADD CONSTRAINT chk_outbound_call_attempts_scope
            CHECK ((scenario = 'lead_call' AND lead_uuid IS NOT NULL)
                OR (scenario <> 'lead_call' AND job_id IS NOT NULL));
    END IF;
END $$;

-- FR-14(a): at most ONE active/queued attempt per lead (mirror of the job guard).
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_call_attempts_active_lead
    ON outbound_call_attempts (lead_uuid)
    WHERE status IN ('pending', 'dialing') AND lead_uuid IS NOT NULL;

-- FR-14(c) lifetime-once lookup + worker/webhook reads by lead.
CREATE INDEX IF NOT EXISTS idx_outbound_call_attempts_lead
    ON outbound_call_attempts (lead_uuid) WHERE lead_uuid IS NOT NULL;

-- Scenario-scoped settings (architecture D-B): sources + lead ladder in one row.
CREATE TABLE IF NOT EXISTS outbound_lead_call_settings (
    company_id       UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    enabled_sources  JSONB       NOT NULL DEFAULT '["ProReferral"]'::jsonb,
    max_attempts     INTEGER     NOT NULL DEFAULT 3,
    backoff_schedule JSONB       NOT NULL DEFAULT '["immediate","+30m","+2h"]'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_outbound_lead_call_settings_updated_at ON outbound_lead_call_settings;
CREATE TRIGGER trg_outbound_lead_call_settings_updated_at
    BEFORE UPDATE ON outbound_lead_call_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON COLUMN outbound_call_attempts.scenario  IS 'OUTBOUND-LEAD-CALL-001: parts_visit (job-scoped, default) | lead_call (lead-scoped).';
COMMENT ON COLUMN outbound_call_attempts.lead_uuid IS 'OUTBOUND-LEAD-CALL-001: triggering lead for scenario=lead_call; NULL on parts rows.';
COMMENT ON TABLE  outbound_lead_call_settings      IS 'OUTBOUND-LEAD-CALL-001: per-company enabled lead sources + scenario-scoped retry ladder (independent of outbound_call_settings).';
```

`backend/db/migrations/rollback_172_outbound_lead_call.sql` (order matters — lead rows must go BEFORE `SET NOT NULL`):

```sql
-- OUTBOUND-LEAD-CALL-001 rollback
DELETE FROM outbound_call_attempts WHERE scenario = 'lead_call';
DROP INDEX IF EXISTS uq_outbound_call_attempts_active_lead;
DROP INDEX IF EXISTS idx_outbound_call_attempts_lead;
ALTER TABLE outbound_call_attempts DROP CONSTRAINT IF EXISTS chk_outbound_call_attempts_scope;
ALTER TABLE outbound_call_attempts DROP COLUMN IF EXISTS lead_uuid;
ALTER TABLE outbound_call_attempts DROP COLUMN IF EXISTS scenario;
ALTER TABLE outbound_call_attempts ALTER COLUMN job_id SET NOT NULL;
DROP TABLE IF EXISTS outbound_lead_call_settings;
```

Notes: `ALTER COLUMN job_id DROP NOT NULL` is metadata-only (instant on a live table). The existing claim index `(company_id, status, scheduled_at)` and the `vapi_call_id` partial index serve both scenarios unchanged — no new claim/correlation indexes.

### 2.3 `backend/db/migrations/173_seed_outbound_lead_caller_marketplace_app.sql`

Seed shape mirrors mig 161 (`ON CONFLICT (app_key) DO UPDATE` over every seeded column, exactly the 170 column list). **No default-company auto-install** (connect is an owner action — unlike 170's installation backfill, this file seeds the catalog row ONLY).

```sql
-- =============================================================================
-- Migration 173: Seed the "Outbound Lead Caller" marketplace app
-- (OUTBOUND-LEAD-CALL-001). provisioning_mode='none' — pure gate (VAPI config is
-- server-env); connecting enables the lead.created auto-call trigger. Registered
-- in ensureMarketplaceSchema AFTER the 170 line (boot-reseed; 083's ON CONFLICT
-- DO UPDATE ordering rule). NO installation seed — connect is an owner action.
-- =============================================================================

INSERT INTO marketplace_apps (
    app_key, name, provider_name, category, app_type,
    short_description, long_description,
    requested_scopes, provisioning_mode, status, support_email, metadata
) VALUES (
    'outbound-lead-caller',
    'Outbound Lead Caller',
    'Albusto',
    'lead_generation',
    'internal',
    'Sara calls new leads from your chosen sources within a minute and books them into the schedule.',
    'When connected, every new lead from an enabled source (for example Pro Referral) gets an automatic phone call from Sara, the AI scheduling assistant — immediately during business hours, or at the next business-day start. Sara references the customer''s request, offers real appointment windows ranked by the scheduling engine, and books the customer''s pick as a schedule hold on the lead. Unanswered calls retry up to three times; if the customer can''t be reached or declines, a dispatcher task is created on the lead. Every call appears live in the Pulse timeline with recording, transcript, and summary.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "access_summary": ["Call new leads from enabled sources and offer appointment windows", "Write a schedule hold on the lead when the customer books", "Create a dispatcher task when the lead can''t be reached"],
        "requires_credential_input": false,
        "setup_path": "/settings/integrations/outbound-lead-caller"
    }'::jsonb
)
ON CONFLICT (app_key) DO UPDATE SET
    name = EXCLUDED.name,
    provider_name = EXCLUDED.provider_name,
    category = EXCLUDED.category,
    app_type = EXCLUDED.app_type,
    short_description = EXCLUDED.short_description,
    long_description = EXCLUDED.long_description,
    requested_scopes = EXCLUDED.requested_scopes,
    provisioning_mode = EXCLUDED.provisioning_mode,
    status = EXCLUDED.status,
    support_email = EXCLUDED.support_email,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();
```

`backend/db/migrations/rollback_173_seed_outbound_lead_caller_marketplace_app.sql` (mirror of rollback_161 — presumes the app is disconnected first; `marketplace_installations.app_id` is ON DELETE RESTRICT):

```sql
-- OUTBOUND-LEAD-CALL-001 rollback: remove the catalog tile (idempotent).
DELETE FROM marketplace_apps WHERE app_key = 'outbound-lead-caller';
```

### 2.4 Boot-registration edit — `backend/src/db/marketplaceQueries.js`

Inside `ensureMarketplaceSchema`, add ONE line directly after the `170_split_lead_generator_marketplace_apps.sql` line (currently :54):

```js
        // OUTBOUND-LEAD-CALL-001: Outbound Lead Caller tile (gate-only, no
        // credential; setup page via metadata.setup_path). Boot-replayed AFTER
        // 083 per the ordering rule. The 172 DDL migration is deliberately NOT
        // in this list (schema migration, not a seed).
        await query(readMigration('173_seed_outbound_lead_caller_marketplace_app.sql'));
```

---

## 3. Settings service — NEW `backend/src/services/outboundLeadCallSettingsService.js`

Mirrors `outboundCallSettingsService.js` exactly (`DEFAULTS` / `coerceStored` / `get` / `resolve`-never-throws) and additionally owns source normalization. The parts table/PK/defaults are untouched — two independent ladders, one resolve seam each (FR-5).

```js
const DEFAULTS = {
    enabled_sources: ['ProReferral'],
    max_attempts: 3,
    backoff_schedule: ['immediate', '+30m', '+2h'],
};
```

Exported surface (exact):

| export | contract |
|---|---|
| `DEFAULTS` | frozen shape above |
| `normalizeSource(s)` | `String(s ?? '').trim().replace(/\s+/g, '').toLowerCase()` → `"Pro Referral" ≡ "ProReferral" ≡ "  pro referral "`. Pure. |
| `isSourceEnabled(settings, rawSource)` | `false` when `rawSource` normalizes to `''`; else `settings.enabled_sources.some(s => normalizeSource(s) === normalizeSource(rawSource))`. Pure. |
| `coerceStored(row)` | per-key overlay onto DEFAULTS: `enabled_sources` kept only when an array of strings (each entry coerced `String(x)`, empties dropped); `max_attempts` only when a positive integer; `backoff_schedule` only when a non-empty array. Always returns a complete typed object. Pure. |
| `get(companyId)` | `SELECT enabled_sources, max_attempts, backoff_schedule, updated_at FROM outbound_lead_call_settings WHERE company_id = $1` → no row → `{ ...DEFAULTS }`; else `coerceStored(row)` (+ pass through `updated_at`). Hard DB error propagates. |
| `resolve(companyId)` | `get` wrapped in try/catch → on ANY error logs `[OutboundLeadCallSettings] resolve failed, using DEFAULTS:` and returns `{ ...DEFAULTS }`. NEVER throws. |
| `saveSources(companyId, enabledSources)` | upsert used by the PUT route (§10.3): `INSERT INTO outbound_lead_call_settings (company_id, enabled_sources) VALUES ($1, $2::jsonb) ON CONFLICT (company_id) DO UPDATE SET enabled_sources = EXCLUDED.enabled_sources, updated_at = NOW() RETURNING *` → `coerceStored(row)`. Ladder columns (`max_attempts`, `backoff_schedule`) are DB-editable only in v1 (no UI — parts precedent). |

---

## 4. Trigger — `lead.created` on the event bus

### 4.1 Emit site — `backend/src/services/leadsService.js` `createLead`

`const eventBus = require('./eventBus');` already exists at the top of the file (:11, used by `convertLead`) — **no new require**. Insert the emit in `createLead`, immediately AFTER the existing SSE line `emitLeadChange('lead.created', columns.company_id, columns.status || 'Submitted', rows[0].id);` (currently :358) and BEFORE the `return`:

```js
    // OUTBOUND-LEAD-CALL-001: post-insert domain event (REPAIR-ADVISOR pattern,
    // jobsService convertLead precedent). Fire-and-forget: a failing bus never
    // breaks the create. This single emit site covers ALL ingestion paths — UI
    // routes/leads.js:432, external integrations-leads.js:67, Yelp
    // yelpLeadService.js:278, Sara agentSkills/skills/createLead.js:123 — they
    // all funnel through this function. The SSE emitLeadChange above is untouched.
    eventBus.emit(
        columns.company_id,
        'lead.created',
        {
            id: rows[0].id,
            uuid: rows[0].uuid,
            first_name: columns.first_name || null,
            last_name: columns.last_name || null,
            phone: columns.phone || null,
            job_type: columns.job_type || null,
            job_source: columns.job_source || null,
            status: columns.status || 'Submitted',
        },
        { actorType: 'system', aggregateType: 'lead', aggregateId: rows[0].id }
    ).catch(() => {});
```

Payload is catalog-conformant (`eventCatalog.js:14` declares `lead.created` with sample fields `id, first_name, last_name, phone, job_type`; extra keys `uuid/job_source/status` are additive — the catalog lists samples, not a closed schema). No catalog edit required.

**Deliberate, documented side effect:** the rules-engine `'*'` subscriber (`eventSubscribers.js:18`) now receives `lead.created`. Deploy checklist (§17) includes auditing prod `automation_rules` for `lead.created` triggers before enabling.

### 4.2 Subscriber — `backend/src/services/eventSubscribers.js`

Append inside `registerSubscribers()`, after the `kb-diagnostics` block (:33-42), same shape (lazy require, guard, `setImmediate`, return immediately so siblings never stall):

```js
    // Outbound Lead Caller (OUTBOUND-LEAD-CALL-001): on lead.created, run the
    // eligibility gauntlet and enqueue the first call attempt. Handler returns
    // immediately (setImmediate) — dispatchToSubscribers awaits sequentially.
    eventBus.subscribe('outbound-lead-caller', 'lead.created', (event) => {
        const companyId = event.company_id;
        const leadId = event.payload && event.payload.id;
        if (!leadId || !companyId) return;
        const outboundLeadCallService = require('./outboundLeadCallService');
        setImmediate(() => {
            outboundLeadCallService.onLeadCreated({ leadId, companyId })
                .catch((err) => console.warn('[outbound-lead-caller] onLeadCreated failed:', err && err.message));
        });
    });
```

No `src/server.js` boot change: `registerSubscribers()` is already called at boot (repo-root `src/server.js:436`).

---

## 5. NEW `backend/src/services/outboundLeadCallService.js`

Everything lead-specific lives here. Requires (top-level or lazy per existing style): `db` (`../db/connection`), `leadsService`, `marketplaceService`, `outboundLeadCallSettingsService`, `scheduleService`, `outboundCallService`, `vapiCallTimelineService`, `eventService`, `recommendSlots` (`./agentSkills/skills/recommendSlots`), `timelinesQueries` (`../db/timelinesQueries`), and `getTimezoneOffsetMs` from `./outboundCallWorker` (**lazy require inside the window helpers** — the worker requires this module back in its tick branch; top-level cross-require would cycle. `outboundCallWorker` may be required lazily here OR this module required lazily there — the architecture pins: worker lazy-requires this service (§6), and this service lazy-requires `getTimezoneOffsetMs`).

Log prefix everywhere: `[outboundLeadCall]`. Every decision (skip/carry/cancel) logs a machine-readable reason (N-6).

### 5.1 Pure helpers (exported for jest — no DB, injectable `now`)

Dispatch-settings shape consumed (from `scheduleService.getDispatchSettings(companyId)` → `dispatch_settings` row or `DEFAULT_DISPATCH_SETTINGS`): `{ timezone: 'America/New_York', work_start_time: 'HH:MM', work_end_time: 'HH:MM', work_days: [0=Sun…6=Sat] }`.

**Sanitization (applies inside every helper below):** `work_days` not a non-empty array of integers 0–6 → use `[1,2,3,4,5]`; `work_start_time`/`work_end_time` failing `/^\d{1,2}:\d{2}$/` or `end ≤ start` (windows never cross midnight in v1) → use `'08:00'`/`'18:00'`; `timezone` falsy → `'America/New_York'`. Never throw, never loop.

| export | contract |
|---|---|
| `normalizeDialablePhone(raw)` | → E.164 string or `null`. `digits = String(raw ?? '').replace(/\D/g,'')`. `digits.length === 10` → `'+1'+digits`; `length === 11 && starts '1'` → `'+'+digits`; `String(raw).trim().startsWith('+') && digits.length >= 10 && digits.length <= 15` → `'+'+digits`; else `null`. (Mirrors `createLead`'s normalization :320-330 plus a validity gate; a foreign E.164 number IS dialable — placement failures feed the ladder, E-2.) |
| `isWithinWorkWindow(now, ds)` | → boolean. Company-local wall clock of `now` via an `Intl.DateTimeFormat(…, { timeZone })` `formatToParts` probe (weekday + HH:MM). True iff local day-of-week ∈ `work_days` AND `startMinutes ≤ localMinutes < endMinutes` (dial must START strictly before `work_end_time`; exactly at end = outside). |
| `nextWindowStart(from, ds)` | → `Date`, the earliest work-window START strictly AFTER `from` — including "today at work_start" when `from` is a workday before opening. Algorithm: for `dayOffset` 0…13, take the company-local calendar date of `from` advanced by `dayOffset` days (UTC-midday date math, `nextBusinessMorning` precedent), skip if its weekday ∉ `work_days`, build the UTC instant of that date's `work_start_time` via `getTimezoneOffsetMs(tz, y, m, d, hour)` (+ minutes), return the first instant `> from`. No candidate in 14 days (pathological config) → `console.warn` + return `from + 24h` (hard fallback — never loops, never throws). DST-safe by construction: the offset is probed per target day. |
| `clampIntoWorkWindow(date, ds)` | `isWithinWorkWindow(date, ds) ? date : nextWindowStart(date, ds)`. |
| `computeLeadNextDueAt(justFailedNo, settings, ds, now)` | Ladder math, mirroring the parts convention (`computeNextScheduledAt` :144 — `backoff_schedule[justFailedNo]` is the NEXT attempt's token, 0-based). Token grammar: `'immediate'` → `now`; generic `/^\+(\d+)(m|h)$/i` → `now + N minutes|hours`; unknown/absent → `now` (conservative — claim-time clamp still protects). Result ALWAYS passed through `clampIntoWorkWindow(result, ds)` (FR-5: an offset past `work_end_time` lands at the next business-day start). |

(Naming note: the requirements prompt's `computeNextWindowStart`/`ladderNext` are these `nextWindowStart`/`computeLeadNextDueAt` — architecture names win.)

### 5.2 `onLeadCreated({ leadId, companyId })` — the eligibility gauntlet

Whole body wrapped in try/catch (N-2 — a throw is logged, never propagates). Cheapest-first; every stop logs `[outboundLeadCall] skip lead=<id> company=<cid> reason=<reason>`:

1. **Connected gate.** `await marketplaceService.isAppConnected(companyId, 'outbound-lead-caller')` — false → stop, reason `app_not_connected`, NO trace. (Connect-time gate = no backfill by construction, FR-14b — only events observed while connected proceed; no activation-date column needed.)
2. **Lead re-read (row is the truth, the bus payload is a hint).** `lead = await leadsService.getLeadById(leadId, companyId)` — throws `LEAD_NOT_FOUND` → stop, reason `lead_not_found`. NOTE: `getLeadById` returns the PascalCase `rowToLead` shape (`UUID`, `ClientId`, `Phone`, `JobSource`, `Status`, `LeadDateTime`, `PostalCode`, `Latitude`, `Longitude`, `Description` (= `lead_notes`), `Comments`, `ContactId`, `FirstName`, `LastName`).
3. **Source gate.** `settings = await outboundLeadCallSettingsService.resolve(companyId)`; `isSourceEnabled(settings, lead.JobSource)` — false → stop, reason `source_not_enabled`, NO trace (SC-06).
4. **Dialable phone.** `phone = normalizeDialablePhone(lead.Phone)` — `null` → append the FR-3 trace to the lead's Comments and stop, reason `no_phone` (SC-05). Trace write (append-only, company-scoped, non-fatal — a comments hiccup logs and still stops):

```sql
UPDATE leads
SET comments = COALESCE(NULLIF(comments, '') || E'\n\n', '') || $2
WHERE uuid = $1 AND company_id = $3
```
with `$2 = '[AI Phone] ' + new Date().toISOString() + ' — Outbound call skipped — no phone number on the lead.'`

5. **Goal-achieved at birth.** `lead.LeadDateTime` set OR `String(lead.Status).toUpperCase() ∈ {'LOST','CONVERTED'}` → stop, reason `goal_achieved_at_birth` (a lead created WITH a hold — e.g. Sara's own `createLead` booking — needs no call).
6. **Lifetime-once (FR-14c).** `SELECT 1 FROM outbound_call_attempts WHERE lead_uuid = $1 LIMIT 1` (ANY status; `idx_outbound_call_attempts_lead`) — exists → stop, reason `chain_exists`.
7. **Enqueue.** Compute `ds = await scheduleService.getDispatchSettings(companyId)` (wrapped; on throw use `DEFAULT_DISPATCH_SETTINGS` clone), `dueAt = clampIntoWorkWindow(new Date(), ds)`, then:

```sql
INSERT INTO outbound_call_attempts
    (company_id, lead_uuid, scenario, contact_id, phone, attempt_no, status, scheduled_at)
VALUES ($1, $2, 'lead_call', $3, $4, 1, 'pending', $5)
ON CONFLICT (lead_uuid) WHERE status IN ('pending', 'dialing') DO NOTHING
```
params: `[companyId, lead.UUID, lead.ContactId || null, phone, dueAt]`. `job_id` stays NULL; `slot_json` stays NULL (slot is computed at claim time — out-of-hours carries stay fresh). The `ON CONFLICT` (partial-index inference on `uq_outbound_call_attempts_active_lead`) makes duplicate concurrent `lead.created` deliveries a no-op (FR-14a); step 6 already handles the lifetime case. Log `enqueued lead=<uuid> due_at=<iso>`.

### 5.3 `processLeadAttempt(attempt)` — claim-time processing (called by the worker, §6)

`attempt` is the full claimed row (claim `RETURNING *` — includes `scenario`, `lead_uuid`, `company_id`, `contact_id`, `phone`, `attempt_no`, `slot_json`). All company scope from the row. Steps in EXACT order:

1. **Lead re-read.** `lead = await leadsService.getLeadByUUID(attempt.lead_uuid, companyId)` in try/catch — `LEAD_NOT_FOUND` (or any throw with `.code === 'LEAD_NOT_FOUND'`) → `terminateLead(attempt.id, 'canceled', 'lead_not_found')` → return. (FK CASCADE usually deletes attempt rows with the lead first; this is the belt.)
2. **Goal-achieved skip (FR-6, the D3 exception — NOT a takeover guard).** `lead.LeadDateTime` set → terminate `canceled` / `goal_achieved:hold_set`; `Status` ∈ {LOST, CONVERTED} (case-insensitive) → terminate `canceled` / `goal_achieved:closed_<status>`. NO task, NO note, log reason. Return.
3. **Eligibility re-check (FR-15).** `isAppConnected(companyId, 'outbound-lead-caller')` false → terminate `canceled` / `app_disconnected`; else `resolve(companyId)` + `isSourceEnabled(settings, lead.JobSource)` false → terminate `canceled` / `source_disabled`. Return. (Disconnect therefore stops queued work at the next tick without any queue-purge code.)
4. **Business window (FR-4/D2).** `ds = await scheduleService.getDispatchSettings(companyId)` (wrapped → defaults). Honor the existing test toggle first: `const ignore = /^(1|true|yes|on)$/i.test(process.env.OUTBOUND_CALL_IGNORE_BUSINESS_HOURS || '')` (same regex as the worker :301-303). When `!ignore && !isWithinWorkWindow(now, ds)` → carry, never drop:

```sql
UPDATE outbound_call_attempts
SET status = 'pending', scheduled_at = $2, updated_at = now()
WHERE id = $1
```
with `$2 = nextWindowStart(now, ds)`; log `carried attempt=<id> to=<iso>`; return.

5. **Slot pre-compute (FR-9 — never dial empty-handed).** Build the location trio from the lead:
   - `zip = lead.PostalCode || undefined`
   - `lat/lng = Number(lead.Latitude)/Number(lead.Longitude)` only when BOTH are present and finite (both-or-nothing)
   - `address = lead.Address ? [lead.Address, lead.City, lead.State].filter(Boolean).join(', ') : undefined`

   `recs = await recommendSlots.run(companyId, {}, { zip, lat, lng, address })` wrapped in try/catch (throw ⇒ same as fallback). `recommendSlots` itself gates on the `smart-slot-engine` app and safe-fails to `{available:false, slots:[], fallback:true}` — the gate is never bypassed. `topSlot = recs && recs.available && !recs.fallback && Array.isArray(recs.slots) ? recs.slots[0] : null`. No `topSlot` → do NOT dial: `await scheduleLeadRetryOrExhaust(attempt, 'no_slots', 'failed')` → return (technical failure feeds the ladder; a lead with no zip/coords/address ends here too, E-1).
6. **Place the call.** Compose:
   - `customerName = [lead.FirstName, lead.LastName].filter(Boolean).join(' ') || 'there'`
   - `problemDescription = String(lead.Description || lead.Comments || '').trim().slice(0, 300) || undefined`
   - `firstMessage` — server-composed greeting (§7.3), company display name via `companyProfileService.getProfile(companyId).name` in try/catch (fault → `null` → the no-company-name variant).
   - `slot = { ...topSlot, ...(coords ? { lat, lng } : {}) }` — riding lat/lng on the slot object reuses `placeCall`'s existing TECHSLOT spread verbatim (zero new lat/lng code in `placeCall`).

```js
const result = await outboundCallService.placeCall({
    companyId,
    scenario: 'lead_call',
    leadUuid: attempt.lead_uuid,
    contactId: attempt.contact_id || undefined,
    customerName,
    customerNumber: attempt.phone,
    slot,
    zip,
    problemDescription,
    source: lead.JobSource || undefined,
    firstMessage,
});
```

   - `result.ok` → stamp correlation + audit slot, then mirror to Pulse (non-fatal, parts pattern :374-385):

```sql
UPDATE outbound_call_attempts
SET vapi_call_id = $2, slot_json = $3, updated_at = now()
WHERE id = $1
```
(`$3 = JSON.stringify(topSlot)`), then `try { await vapiCallTimelineService.recordPlacement({ attempt, vapiCallId: result.vapiCallId, dialedNumber: attempt.phone, callerId: process.env.VAPI_OUTBOUND_TWILIO_NUMBER || process.env.OUTBOUND_CALLER_ID || null }); } catch (e) { warn }`. The row stays `dialing` until the end-of-call webhook classifies it. FR-13 holds with ZERO timeline changes: `recordPlacement` resolves the Pulse thread **by dialed phone** (`findOrCreateTimeline(dialedNumber, cid)`, `vapiCallTimelineService.js:251-254`); `job_id: null` in the raw payload is audit-only.
   - `!result.ok` → `await scheduleLeadRetryOrExhaust(attempt, result.error || 'place_call_failed', 'failed')` (covers `vapi_config_missing`, `missing_customer_number`, `vapi_http_4xx/5xx`, timeouts — E-9/E-14).

`terminateLead(attemptId, status, reason)` = the same 3-line UPDATE as the worker's `terminate` (status+reason+updated_at); local to this module (do not import the worker's private one).

### 5.4 `scheduleLeadRetryOrExhaust(attempt, reason, klass = 'failed')` — the ONE ladder site

Shared by the worker path (placement failure / `no_slots`) and the webhook transient branch — ladder math lives in exactly one module. The parts `scheduleRetryOrExhaust` / `retryBlockReason` are NOT touched or reused (D3: no human-takeover guard here; the lead flavor re-checks ONLY goal/eligibility).

1. **Mark this attempt honest-terminal:** `UPDATE outbound_call_attempts SET status = $2, reason = $3, updated_at = now() WHERE id = $1` with `[attempt.id, klass, String(reason).slice(0, 120)]` (frees the `(lead_uuid)` active guard for the next INSERT).
2. **No-resurrection re-check (goal + eligibility ONLY; fail-open, never throws).** Re-read the lead (missing → blocked `lead_not_found`); `LeadDateTime` set / closed → blocked `goal_achieved`; app disconnected → blocked `app_disconnected`; source disabled → blocked `source_disabled`. When blocked: `eventService.logEvent(companyId, 'lead', attempt.lead_uuid, 'outbound_lead_call_retry_skipped', { attemptNo: attempt.attempt_no, outcome: klass, blockedBy }, 'system')` (non-fatal) → return. NO next row, NO task.
3. `settings = await outboundLeadCallSettingsService.resolve(companyId)`; `maxAttempts = settings.max_attempts || 3`.
4. **`attempt.attempt_no < maxAttempts` → next rung:** `ds = getDispatchSettings` (wrapped→defaults); `nextAt = computeLeadNextDueAt(attempt.attempt_no, settings, ds, now)`;

```sql
INSERT INTO outbound_call_attempts
    (company_id, lead_uuid, scenario, contact_id, phone, attempt_no, status, scheduled_at)
VALUES ($1, $2, 'lead_call', $3, $4, $5, 'pending', $6)
```
identity copied from the attempt row; `attempt_no + 1`; `slot_json` deliberately NOT copied (fresh engine compute at claim — deliberate divergence from parts). Then `logEvent(companyId, 'lead', attempt.lead_uuid, 'outbound_lead_call_retry', { attemptNo: attempt.attempt_no, nextScheduledAt: nextAt.toISOString(), outcome: klass }, 'system')`.
5. **Else → exhaustion (FR-12):** INSERT the terminal marker row (parts precedent, webhook :357-365):

```sql
INSERT INTO outbound_call_attempts
    (company_id, lead_uuid, scenario, contact_id, phone, attempt_no, status, scheduled_at, reason)
VALUES ($1, $2, 'lead_call', $3, $4, $5, 'exhausted', now(), 'max_attempts_reached')
```
then `createLeadCallTask(companyId, lead, attempt, 'exhausted')` (§5.6) and `logEvent(…, 'outbound_lead_call_exhausted', { attempts: maxAttempts }, 'system')`.

### 5.5 `handleLeadEndOfCall(attempt, klass, endedReason, message)` — webhook classification (called from §8)

Internally safe-fail (whole body try/catch → warn). Runs only for `attempt.status === 'dialing'` rows (the route's terminal-idempotence no-op fires first — CC-07 analog: a `confirmLeadBooking` mid-call already flipped the attempt to `booked`, so the report webhook never reaches this function on a booked call; the timeline still finalizes because that runs before the check).

1. **Booked belt.** Re-read the lead; `LeadDateTime` set → `UPDATE outbound_call_attempts SET status='booked', updated_at=now() WHERE id=$1` → return. (Covers a hold that landed without the attempt flip — e.g. flip UPDATE failed non-fatally in the skill.) Chain closes, no task (FR-11).
2. **Declined (SC-08 / FR-11).** `outcome = message && message.analysis && message.analysis.structuredData && message.analysis.structuredData.outcome` (string, added to the assistant's analysisPlan in the VAPI PATCH §17 — `endedReason` alone rarely says "declined"). When `klass === 'declined'` OR `outcome ∈ {'declined','callback'}`: `UPDATE … SET status='declined', reason=$2` (`String(endedReason || outcome || 'declined').slice(0,120)`) → `createLeadCallTask(companyId, lead, attempt, 'declined', { summary: message?.analysis?.summary })` → `logEvent(…, 'outbound_lead_call_declined', { attemptNo, outcome }, 'system')` → return. Terminal — NO further auto-redial (a human said no).
3. **Transient** (`no_answer` / `voicemail` / `failed`) → `await scheduleLeadRetryOrExhaust(attempt, String(endedReason || klass), klass)`. Voicemail counts as unreached; leaving a message is out of scope v1.

### 5.6 `createLeadCallTask(companyId, lead, attempt, kind, extra = {})` — dispatcher task (FR-12 / SC-08)

Yelp precedent (`yelpLeadService.createYelpCallTask` :456-484): lead-bound AND Pulse-AR-visible via `timelinesQueries.createTask` with `createdBy:'agent'` and NO `agentStatus` (the agentWorker claims only `agent_status='queued'` — it never picks this up). Non-fatal by contract (a task hiccup logs, never breaks the chain transition).

1. **Idempotency belt (exactly-once per chain):**

```sql
SELECT 1 FROM tasks
WHERE company_id = $1 AND subject_type = 'lead' AND subject_id = $2
  AND agent_type = 'outbound_lead_call' AND status = 'open'
LIMIT 1
```
`$2 = lead.ClientId` (the numeric `leads.id`). Exists → skip (log `task_exists`). **NOTE — deviation from the architecture text, flagged:** the architecture's belt referenced `tasks.lead_id`, but `timelinesQueries.createTask` (the creation path it prescribes) populates `subject_type/subject_id`, NOT `lead_id` (mig-136's `lead_id` is written only by the `/api/tasks` `createTaskForParent` path). The belt above matches what actually gets written.
2. **Thread resolve:** `timeline = await timelinesQueries.findOrCreateTimeline(attempt.phone, companyId)` — same phone-keyed thread `recordPlacement` used, so the task lands on the conversation the calls live in. `attempt.phone` is always set on dialed chains.
3. **Create:**

```js
await timelinesQueries.createTask({
    companyId,
    threadId: timeline.id,
    subjectType: 'lead',
    subjectId: lead.ClientId,
    title,                       // per-kind below
    description,                 // per-kind below
    priority: 'p1',
    createdBy: 'agent',
    agentType: 'outbound_lead_call',
});
```

Per-kind copy (`name = [lead.FirstName, lead.LastName].filter(Boolean).join(' ') || 'the lead'`, `N = attempt.attempt_no`):

| kind | title | description |
|---|---|---|
| `exhausted`, final attempt reason ≠ `no_slots` | `Couldn't reach ${name} — ${N} automated call attempts` | Header line `Sara tried to call this ${lead.JobSource || ''} lead but couldn't reach them.` + per-attempt lines from `SELECT attempt_no, status, reason, updated_at FROM outbound_call_attempts WHERE lead_uuid = $1 AND company_id = $2 AND status NOT IN ('pending','dialing','exhausted') ORDER BY attempt_no, id` formatted `Attempt ${attempt_no}: ${status}${reason ? ` (${reason})` : ''} — ${updated_at ISO}` + closing `Please follow up and book the appointment.` |
| `exhausted`, final attempt reason = `no_slots` | `Couldn't offer ${name} a time — appointment slots unavailable (${N} attempts)` | `Sara couldn't compute appointment slots for this lead (slot engine unavailable or no windows for the lead's location), so no call could offer a time.` + the same per-attempt lines + `Please schedule manually.` (FR-9: the task states the real reason.) |
| `declined` | `${name} answered but didn't book — follow up` | `Sara reached the customer on this ${lead.JobSource || ''} lead but they didn't pick a time.` + (`extra.summary` ? `\n\nCall summary: ${extra.summary}` : '') + `\n\nPlease follow up personally.` |

**Accepted platform behavior (AR-TASK-UNIFY, documented — do not "fix"):** for AUTO provenance (`agent`), `timelinesQueries.createTask` UPSERTS the single open AUTO task on the thread (`:847` — updates title/description of an existing open system/automation/agent task instead of inserting a second). One phone thread therefore carries at most one open auto task; the belt in step 1 additionally prevents re-creating after a dispatcher closes it and a late duplicate webhook fires.

---

## 6. Worker dispatch — `backend/src/services/outboundCallWorker.js` (two additive touches, nothing else)

**Touch 1 — scenario dispatch in `tick()`.** The claim UPDATE (:468-480) is untouched — it is scenario-agnostic and `RETURNING *` already carries the new `scenario`/`lead_uuid` columns. In the per-attempt loop (:487-503), replace the single `await processAttempt(attempt);` line with:

```js
            // OUTBOUND-LEAD-CALL-001: per-row scenario dispatch. Lead chains are
            // processed by outboundLeadCallService (lazy require — no cycle);
            // every other row takes the parts path byte-identically.
            if (attempt.scenario === 'lead_call') {
                await require('./outboundLeadCallService').processLeadAttempt(attempt);
            } else {
                await processAttempt(attempt);
            }
```

The surrounding try/catch stays byte-identical — an UNEXPECTED throw from either branch still lands in `terminate(attempt.id, 'failed', 'worker_error:…')` (silently-but-audited chain end; expected failures are handled INSIDE `processLeadAttempt` via the ladder — deliberate: the crash path stays task-spam-free). Note the catch's log line prints `job ${attempt.job_id}` — leave as-is (prints `null` for lead rows; changing the parts log line is out of scope).

**Touch 2 — one additive export.** Add `getTimezoneOffsetMs,` to `module.exports` (:527-539), with a comment `// OUTBOUND-LEAD-CALL-001: shared DST-safe tz probe for the lead window math.` (CANCEL-001 `retryBlockReason` precedent for cross-module additive exports.)

Nothing else in this file changes: `processAttempt`, Guard-1, `resolveBusinessHoursGroup`, `nextBusinessMorning`, `computeNextScheduledAt`, `scheduleRetryOrExhaust`, `retryBlockReason`, `BATCH=10`, the claim SQL, lifecycle — all byte-identical. Lead chains share the BATCH=10/tick dial budget with parts (accepted; single-digit daily volumes).

---

## 7. Call placement — `backend/src/services/outboundCallService.js` + variableValues contract

### 7.1 `placeCall` signature (additive, conditional spreads — parts request body byte-identical)

```js
async function placeCall({
    companyId, jobId, contactId, customerName, customerNumber, slot, balanceDue,
    // OUTBOUND-LEAD-CALL-001 (all optional; absent on parts calls):
    scenario, leadUuid, zip, problemDescription, source, firstMessage,
} = {}) {
```

Body changes (the established balanceDue/techId conditional-spread pattern :121-131):

- In `assistantOverrides.variableValues`, make the two identity keys conditional and append the lead keys:

```js
        variableValues: {
            ...(jobId != null ? { jobId } : {}),
            ...(contactId != null ? { contactId } : {}),
            companyId,
            customerName,
            slotLabel: s.label,
            slotDate: s.date,
            slotStart: s.start,
            slotEnd: s.end,
            slotKey: s.key,
            ...(balanceDue !== undefined ? { balanceDue } : {}),
            ...(s.techId ? { technicianId: s.techId } : {}),
            ...(s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : {}),
            // OUTBOUND-LEAD-CALL-001 — absent keys keep the parts body byte-identical:
            ...(scenario === 'lead_call' ? { scenario: 'lead_booking' } : {}),
            ...(leadUuid ? { leadUuid } : {}),
            ...(zip ? { zip } : {}),
            ...(problemDescription ? { problemDescription } : {}),
            ...(source ? { source } : {}),
        },
```

  Parts calls always pass non-null `jobId`/`contactId`, so making them conditional changes nothing on the parts wire body (pin with the §18.2 snapshot test). **Discriminator naming (exact, per architecture — do not conflate):** the DB column value is `scenario='lead_call'`; the PROMPT variable is `scenario: 'lead_booking'`.

- In `assistantOverrides` (sibling of `variableValues`), add the per-call greeting override:

```js
        assistantOverrides: {
            ...(firstMessage ? { firstMessage } : {}),
            variableValues: { … },
        },
```

  Required because the assistant's static `firstMessage` is parts-specific ("your part has arrived", hardcoded company name — repo mirror `voice-agent/assistants/parts-visit-scheduler.json:135`). Parts calls don't send the key → their greeting untouched.

- JSDoc: extend the param block; everything else in the file (config guards, transient-Twilio caller-ID, error mapping, no-secret-logging) byte-identical.

### 7.2 variableValues contract — scenario `lead_call` (authoritative table)

`vapi-tools.buildSkillInput` (`backend/src/routes/vapi-tools.js:90-107`) spreads `variableValues` LAST over model args — every key below is injected, model-unspoofable, and arrives in every in-call skill's `input`. Zero changes to `vapi-tools.js`.

| key | value/source | consumed by |
|---|---|---|
| `scenario` | constant `'lead_booking'` | assistant prompt dispatch (absent on parts calls → parts script) |
| `leadUuid` | `attempt.lead_uuid` | `confirmLeadBooking` identity (authoritative) |
| `companyId` | `attempt.company_id` | skill tenant scope (`confirmLeadBooking` uses THIS, not the transport's DEFAULT_COMPANY_ID arg) |
| `contactId` | `attempt.contact_id` (omitted when null) | audit only |
| `customerName` | lead First+Last ∥ `'there'` | greeting/prompt |
| `zip` | `leads.postal_code` (omitted when absent) | `checkServiceArea`, in-call `recommendSlots` location, `confirmLeadBooking` re-validation |
| `lat`/`lng` | lead geocode, both-or-nothing (ride on the slot object → existing TECHSLOT spread) | in-call `recommendSlots` location |
| `problemDescription` | `lead_notes ∥ comments`, trimmed ≤300 chars (omitted when empty) | prompt context (FR-7) |
| `source` | `leads.job_source` display label | prompt ("you reached out on Pro Referral…") |
| `slotLabel/slotDate/slotStart/slotEnd/slotKey` | claim-time pre-computed top slot | SAME keys as parts → the prompt's opening offer + `confirmLeadBooking` offered-guard |

### 7.3 Server-composed `firstMessage` (exact strings)

`companyName = profile.name` via `companyProfileService.getProfile(companyId)` in try/catch (fault/empty → variant B):

- **A (with company):** `Hi {{customerName}}, this is Sara with <companyName> — you reached out on <source label> about your appliance. I can get you on the schedule right now: we have {{slotLabel}} available — would that work?`
- **B (no company name):** `Hi {{customerName}}, this is Sara — you reached out on <source label> about your appliance. I can get you on the schedule right now: we have {{slotLabel}} available — would that work?`

`<source label>` = `lead.JobSource` verbatim (e.g. "Pro Referral"); when absent use `online`. `{{customerName}}`/`{{slotLabel}}` are left as VAPI template tokens (resolved from the injected variableValues at call open) — the composed string is passed as `assistantOverrides.firstMessage`. Verify template-token substitution inside a per-call `firstMessage` override on the first owner-observed test call (architecture risk 2); if VAPI does not substitute there, fall back to interpolating the literal name/label server-side (same sentence, no tokens) — a one-line change in §5.3 step 6.

---

## 8. Webhook — `backend/src/routes/vapiCallStatus.js` (two additive touches)

**Touch 1 — correlate SELECT gains the scenario columns** (:148-153):

```sql
SELECT id, company_id, job_id, task_id, attempt_no, status, phone, contact_id, slot_json,
       scenario, lead_uuid
FROM outbound_call_attempts
WHERE vapi_call_id = $1
LIMIT 1
```

**Touch 2 — the lead branch.** Inserted AFTER the terminal-idempotence no-op (`if (attempt.status !== 'dialing') return res.json({ ok: true });`, :236-238) and BEFORE the parts booked-detection block (`let booked = false;`, :245):

```js
        // ── OUTBOUND-LEAD-CALL-001: lead-scenario classification ──────────────
        // Shared plumbing above already ran for this row: timeline finalize
        // (CT-05b) and the terminal-idempotence no-op (a confirmLeadBooking
        // mid-call flip lands there — CC-07 analog). Everything parts-specific
        // stays below and is untouched.
        if (attempt.scenario === 'lead_call') {
            const klass = classifyEndedReason(endedReason);
            try {
                await require('../services/outboundLeadCallService')
                    .handleLeadEndOfCall(attempt, klass, endedReason, message);
            } catch (leadErr) {
                console.warn('[vapiCallStatus] lead end-of-call failed (safe-fail):', leadErr && leadErr.message);
            }
            return res.json({ ok: true });
        }
```

The `status-update` branch (:176-190) needs NO change — it is scenario-agnostic (correlate → `applyStatusUpdate` → 200), so lead calls get the live pill + early re-key for free. `classifyEndedReason` (:112-127) stays route-owned and shared — its vocabulary (`no_answer`/`voicemail`/`declined`/`failed`) is FR-10's. Everything from :245 down (parts booked-detection, declined, transient retry with `retryBlockReason`) is byte-identical.

**Idempotence recap (CC-07 analog):** `confirmLeadBooking` flips the dialing row to `booked` mid-call → the end-of-call report for that call hits the :236 no-op (timeline still finalized above it); a REPEAT webhook for any terminal row is the same no-op; an unknown `call.id` stays a 200 no-op. `handleLeadEndOfCall` only ever sees a `dialing` row.

---

## 9. NEW L0 skill — `backend/src/services/agentSkills/skills/confirmLeadBooking.js`

The in-call booking write for the lead scenario (confirmPartsVisit "Deviation 1" pattern: outbound calls have no caller-claimed identity to verify → L0, isolation fully in-skill). `bookOnLead` is NOT used (L1 contact-gated; targets "newest open lead of the verified contact" — wrong for contactless Pro Referral leads and multi-lead contacts).

### 9.1 Registry + exposure

- `backend/src/services/agentSkills/registry.js` — ONE additive entry, placed directly under the `confirmPartsVisit` entry (:77):

```js
    // OUTBOUND-LEAD-CALL-001: in-call booking write for the OUTBOUND lead-call
    // scenario. L0 on the outbound surface (Deviation 1) — identity (leadUuid/
    // companyId) is server-injected via variableValues, never a caller claim;
    // isolation is fully in-skill. Inbound Sara's tool-set is unchanged.
    { name: 'confirmLeadBooking', kind: 'write', requiredLevel: 'L0', run: lazyRun('confirmLeadBooking') },
```

- The generic `vapi-tools` dispatch needs ZERO changes — a registry entry + the assistant PATCH (§17) is full exposure.
- **NOT** added to `backend/src/services/agentSkillsMcpRegistry.js` (explicit list; voice-only by default — architecture D-F).

### 9.2 `run(companyId, _verifiedContext, input)` — exact algorithm (no false success; refusal shapes from `resultShapes`)

Reuse verbatim: `isConfirmedSlot`, `windowPhrase` from `./rescheduleAppointment`; `slotSpanIsPositive` from `./confirmPartsVisit`; lazy-require `leadsService`, `slotEngineService`, `eventService`, `recommendSlots`, `db`.

```
src = input && typeof input === 'object' ? input : {}
```

1. **Identity (server-injected wins).** `leadUuid = src.leadUuid`; `cid = src.companyId` — BOTH come from the injected variableValues (spread LAST in `buildSkillInput` → the model cannot override them). The transport `companyId` ARGUMENT (DEFAULT_COMPANY_ID on the VAPI seam) is NOT used for scoping. Either missing → `resultShapes.refusal("I couldn't pull up your request to book — let me have a teammate follow up with you.")`.
2. **Slot guards.** `slot = src.chosenSlot` (the model's ONLY parameter). `!isConfirmedSlot(slot) || !slotSpanIsPositive(slot)` → `resultShapes.refusal("Let's lock in a time first — which window works best for you?", { needsConfirmation: true })`. Derive `derivedKey = `${slot.date}|${slot.start}|${slot.end}``.
3. **Offered-guard (FR-8 injection-hardening, fail-closed).** `src.slotKey` is ALWAYS the server-injected pre-dial engine key — the variableValues spread clobbers any model-sent `slotKey`, which is exactly why the tool schema (§17) declares NO `slotKey` parameter; the key is derived from `chosenSlot` and compared against the injected one:
   - `derivedKey === src.slotKey` → the customer picked the pre-dial engine slot → accept, go to 4.
   - Else (an in-call `recommendSlots` alternative) → **re-validate against the ENGINE:** `recs = await recommendSlots.run(cid, {}, { zip: src.zip, lat: src.lat, lng: src.lng, targetDay: slot.date })` (TECHSLOT targetDay path — that day only). Accept ONLY when `recs.available === true` and some `recs.slots[i].key === derivedKey`. `SLOT_FALLBACK` / empty / no key match / throw → `resultShapes.refusal("Let me have a teammate confirm that time and follow up with you shortly.")` — fail-closed for non-offered slots, and stronger than a stored offered-list (it also re-checks live availability).
4. **Ownership.** `lead = await leadsService.getLeadByUUID(leadUuid, cid)` in try/catch → not found / throw → `resultShapes.refusal("I couldn't find that request on file — let me have a teammate follow up with you.")` (cross-company indistinguishable from missing). Closed lead (`Status` ∈ {LOST, CONVERTED}, case-insensitive) → `resultShapes.refusal("That request is already closed — let me have a teammate follow up with you.")`.
5. **Hold write (byte-same shape as `bookOnLead`/VAPI-SLOT-ENGINE — `bookOnLead.js:96-103`):**

```js
const tz = await slotEngineService.resolveTimezone(cid);
const hold = {
    LeadDateTime: slotEngineService.tzCombine(slot.date, slot.start, tz),
    LeadEndDateTime: slotEngineService.tzCombine(slot.date, slot.end, tz),
    ...(Number.isFinite(src.lat) && Number.isFinite(src.lng) ? { Latitude: src.lat, Longitude: src.lng } : {}),
};
await leadsService.updateLead(leadUuid, hold, cid);
```
   tz-compose fault or `updateLead` throw → `resultShapes.refusal("I had trouble locking that time in — let me have a teammate confirm it with you.")` — no write, no false success. No new lead, no job, no Zenbooker, no FSM flip.
6. **Own-attempt flip (CC-07 analog, NON-FATAL):**

```sql
UPDATE outbound_call_attempts
SET status = 'booked', updated_at = now()
WHERE company_id = $1 AND lead_uuid = $2 AND status = 'dialing'
```
   Records the outcome AND turns the end-of-call webhook into the :236 idempotent no-op. Try/catch → `console.error` only (the hold already landed).
7. **Audit + speak.** `eventService.logEvent(cid, 'lead', leadUuid, 'lead_slot_held', { window: windowPhrase(slot), actor: 'AI Phone', scenario: 'lead_call' }, 'system')` (non-fatal). Return:

```js
resultShapes.ok(
    `You're all set — I've got you down for ${windowPhrase(slot)}. A dispatcher will confirm shortly.`,
    { success: true, booked: true, bookedWindow: windowPhrase(slot), leadId: leadUuid },
);
```

Export `{ run }`.

---

## 10. Settings API — NEW `backend/src/routes/outboundLeadCall.js`

### 10.1 Mount — repo-root `src/server.js`

One line directly after the mail-agent mount (:270-271), IDENTICAL middleware chain (N-4: same gate as every marketplace settings page; no new permission catalog entries):

```js
// OUTBOUND-LEAD-CALL-001: Outbound Lead Caller settings (same gate as marketplace).
app.use('/api/outbound-lead-caller', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess,
    require('../backend/src/routes/outboundLeadCall'));
```

(Route prefix `outbound-lead-caller` per the architecture D-G — matches the `app_key` and the frontend api client.) `company_id` ONLY via `const cid = req.companyFilter?.company_id;` — every SQL leg filters by it. Errors never leak other tenants' data.

### 10.2 `GET /api/outbound-lead-caller/settings`

mailAgent GET shape (:35-58): one handler, `Promise.all` of four legs, 500 → `{ ok:false, error:{ code:'INTERNAL', message:'Failed to load settings' } }`.

```js
const APP_KEY = 'outbound-lead-caller';
```

Legs (all company-filtered):
1. `settings = await outboundLeadCallSettingsService.get(cid)` (route may throw → 500; resolve() is for the worker only).
2. `installStatus` — the mailAgent `getInstallState` query verbatim with this APP_KEY (`marketplace_installations JOIN marketplace_apps … status IN ('connected','provisioning_failed') ORDER BY created_at DESC LIMIT 1`).
3. `company_sources` — observed reality for the multi-select union (FR-2; prod has `"Pro Referral"` with a space):

```sql
SELECT DISTINCT job_source FROM leads
WHERE company_id = $1 AND job_source IS NOT NULL AND btrim(job_source) <> ''
ORDER BY job_source
LIMIT 100
```
4. `recent` — 30-day observability rollup (N-6), one GROUP BY:

```sql
SELECT status, COUNT(*)::int AS count
FROM outbound_call_attempts
WHERE company_id = $1 AND scenario = 'lead_call'
  AND created_at >= now() - interval '30 days'
GROUP BY status
```

Response `200`:

```json
{ "ok": true, "data": {
    "settings": { "enabled_sources": ["ProReferral"], "max_attempts": 3,
                  "backoff_schedule": ["immediate", "+30m", "+2h"], "updated_at": null },
    "installed": true, "install_status": "connected",
    "company_sources": ["Pro Referral", "Google", "Yelp"],
    "recent": [ { "status": "booked", "count": 4 }, { "status": "no_answer", "count": 7 } ]
} }
```

### 10.3 `PUT /api/outbound-lead-caller/settings`

v1 body: `{ enabled_sources: string[] }` (ladder columns DB-editable only). Validation BEFORE any write — failures → `400 { ok:false, error:{ code:'VALIDATION', message } }`:

- `enabled_sources` must be an array (`Array.isArray`), ≤ 50 items;
- each item: a string whose `trim()` is non-empty and ≤ 80 chars;
- normalized dedup server-side: keep the FIRST display label per `normalizeSource` key (stored values are the picked display labels; matching normalizes both sides at read — `isSourceEnabled`).
- An EMPTY array is valid (app connected, zero sources enabled → no chains start; claim-time re-check cancels queued ones, FR-15).

Then `settings = await outboundLeadCallSettingsService.saveSources(cid, deduped)` → `200 { ok: true, data: { settings } }`. 500 shape as GET. Changes take effect for events processed AFTER the write (FR-2) — pending attempts re-check at claim (FR-15); no retro-processing.

### 10.4 Error table (both endpoints)

| Condition | Response |
|---|---|
| No/invalid auth | `401` (existing `authenticate`) |
| Missing `tenant.integrations.manage` | `403` (existing `requirePermission`) |
| PUT body fails §10.3 validation | `400 { ok:false, error:{ code:'VALIDATION', … } }` |
| Unexpected error | `500 { ok:false, error:{ code:'INTERNAL', … } }` |
| Foreign-company data | unreachable — every query keyed by `req.companyFilter.company_id` |

---

## 11. Frontend

### 11.1 NEW `frontend/src/services/outboundLeadCallerApi.ts`

Mirror `mailAgentApi.ts` byte-for-byte in structure (authedFetch + the same `unwrap<T>` helper):

```ts
import { authedFetch } from './apiClient';

export interface OutboundLeadCallerSettings {
    enabled_sources: string[];
    max_attempts: number;
    backoff_schedule: string[];
    updated_at?: string | null;
}
export interface OutboundLeadCallerOverview {
    settings: OutboundLeadCallerSettings;
    installed: boolean;
    install_status: string | null;
    company_sources: string[];
    recent: { status: string; count: number }[];
}

const BASE = '/api/outbound-lead-caller';

export async function getOutboundLeadCallerOverview(): Promise<OutboundLeadCallerOverview> { /* GET `${BASE}/settings` → unwrap */ }
export async function saveOutboundLeadCallerSettings(enabledSources: string[]): Promise<OutboundLeadCallerSettings> {
    /* PUT `${BASE}/settings` body { enabled_sources: enabledSources } → unwrap().settings */
}
```

### 11.2 NEW `frontend/src/pages/OutboundLeadCallerSettingsPage.tsx`

Mirror `MailSecretarySettingsPage.tsx` (SettingsPageShell + SettingsSection + sonner toasts + draft state with explicit Save). N-7: English, Albusto, tokens only, FORM-CANON.

- `const APP_KEY = 'outbound-lead-caller';`
- **Not-installed state:** when `!overview.installed` → a connect CTA card (`handleInstall` verbatim from MailSecretary :116-130: `fetchMarketplaceApps` → find by APP_KEY → `installMarketplaceApp(APP_KEY)` → toast `'Outbound Lead Caller enabled'` → reload). Settings sections render only when installed.
- **Section "Lead sources"** — the FR-2 multi-select as a `Checkbox` list (design canon: toggles/checkboxes use `Checkbox`, label beside, NOT floated):
  - Options = union of canonical `JOB_SOURCES` (import `{ JOB_SOURCES } from '../components/leads/editLeadHelpers'` — `['eLocals','Inquirly','Servicedirect','ProReferral','Google','Thumbtack','Yelp']`; import, do not copy) and `overview.company_sources`, deduped by the same normalization as the backend (`s.trim().replace(/\s+/g,'').toLowerCase()`), canonical label preferred when normalized-equal (so prod's `"Pro Referral"` and canon `"ProReferral"` render as ONE row). Filter out any option normalizing to `'aiphone'` (never offer Sara's own `'AI Phone'` label — architecture risk 5).
  - Checked state: option is checked iff its normalized key ∈ normalized `settings.enabled_sources`.
  - The Yelp row renders an inline hint (`text-xs`, `var(--blanc-ink-3)`): `Yelp leads are already handled by the email booking agent — enabling calls runs both.`
  - Local draft `Set<string>` of normalized keys + a label map; Save button (primary) → `saveOutboundLeadCallerSettings(selectedDisplayLabels)` → `toast.success('Settings saved')` / `toast.error`.
- **Section "How it works"** — static copy (plain paragraphs, `.blanc-eyebrow` header, no decorative icons): `Sara calls each new lead from an enabled source within about a minute — during your business hours (from Dispatch settings). Out-of-hours leads are called at the next business-day start. Unanswered calls retry up to 3 times (immediately, +30 minutes, +2 hours). If the customer books, the appointment hold appears on the lead; if not, a dispatcher task is created. Every call shows up in Pulse with recording and transcript.`
- **Section "Last 30 days"** — `StatChip` row from `overview.recent` (label = humanized status: Booked / No answer / Voicemail / Declined / Failed / Canceled / Exhausted; render only statuses present — no empty states).
- No enable/disable toggle on this page — connect/disconnect IS the switch (the generic tile). No ladder editing v1.

### 11.3 `frontend/src/App.tsx` — one import + one route

Next to the mail-secretary route (:163):

```tsx
import OutboundLeadCallerSettingsPage from './pages/OutboundLeadCallerSettingsPage';
…
<Route path="/settings/integrations/outbound-lead-caller"
       element={<ProtectedRoute permissions={['tenant.integrations.manage']}><OutboundLeadCallerSettingsPage /></ProtectedRoute>} />
```

### 11.4 Marketplace tile — ZERO code

`IntegrationsPage.tsx` untouched: the tile renders from the catalog row; the Configure button renders generically for connected apps with `metadata.setup_path` (:301-302, verified pattern). Connect/disconnect = existing generic install/uninstall flow (`provisioning_mode='none'` skips credential minting — `marketplaceService.installApp` :346).

---

## 12. Behavior scenarios (SC-map through the components)

| # | Scenario | Path through this spec | Terminal state |
|---|---|---|---|
| SC-01 | In-hours Pro Referral lead, customer books | §4 emit → §5.2 enqueue (due=now) → §6 dispatch ≤ ~60s → §5.3 dial with slot+firstMessage → in-call §9 hold + attempt→`booked` → §8 webhook = idempotent no-op (timeline finalized) | chain `booked`; lead has LeadDateTime/LeadEndDateTime; Pulse row w/ recording/transcript/summary; no task |
| SC-02 | No answer ×3 | each report → §8 → §5.5(3) → §5.4: `no_answer` + next rung (+30m, +2h clamped) → after 3rd: `exhausted` marker + §5.6 task | attempts `no_answer,no_answer,no_answer` + `exhausted` row; ONE p1 task on the lead |
| SC-03 | Lead created Sat 22:40 (Mon–Sat 08–18) | §5.2 step 7 `clampIntoWorkWindow` → due Mon 08:00 company tz (Sat is a workday but 22:40 ≥ end; Sun ∉ work_days) | first dial Monday 08:00 |
| SC-04 | Booked between retries (callback to Sara inbound / dispatcher) | pending row claimed → §5.3 step 2 goal-achieved → terminate `canceled`/`goal_achieved:hold_set` | no dial, no task |
| SC-05 | No phone | §5.2 step 4 → Comments trace `[AI Phone] <ISO> — Outbound call skipped — no phone number on the lead.` | no chain; trace visible on the Lead card |
| SC-06 | Thumbtack lead, only ProReferral enabled | §5.2 step 3 → stop | nothing (no chain, no trace) |
| SC-07 | Connect → settings → disconnect | tile connect → page preselects ProReferral (DB default) → disconnect → §5.3 step 3 cancels queued (`app_disconnected`); §5.2 step 1 blocks new; reconnect never backfills (FR-14b/c) | queued attempts `canceled`; old leads never dialed |
| SC-08 | Answered, didn't book | report klass `declined` OR analysis outcome `declined`/`callback` → §5.5(2) | attempt `declined`; follow-up task w/ call summary; NO redial |
| SC-09 | Dispatcher watches live | §5.3 recordPlacement live row → status-update pill (§8 unchanged branch) → finalize on report | identical UX to parts calls (OUTBOUND-CALL-TIMELINE-001) |

---

## 13. Edge cases

1. **E-1 lead without zip/coords/address** → `recommendSlots` gets no location → engine fallback → `no_slots` → ladder as technical failure; if it persists, the exhaustion task uses the "slots unavailable" copy (§5.6). Never dialed empty-handed.
2. **E-2 foreign/odd phone** → `normalizeDialablePhone`: `+`-prefixed 10–15-digit numbers ARE dialable (chain starts; VAPI/Twilio placement failure → ladder). 7-digit / garbage → `null` → SC-05 trace. E.164-ambiguous 11-digit not starting with 1 without `+` → `null` (trace).
3. **E-3 disconnect mid-ladder** → §5.3 step 3 / §5.4 step 2 → `canceled`/`app_disconnected`, no task, no dial.
4. **E-4 reconnect** → no backfill: enqueue happens only in the `lead.created` subscriber (§5.2 step 1 gate); reconnect emits no lead events.
5. **E-5 duplicate `lead.created` deliveries / subscriber re-entry** → lifetime-once SELECT + `ON CONFLICT (lead_uuid) WHERE status IN ('pending','dialing') DO NOTHING` → exactly one chain.
6. **E-6 two DIFFERENT leads, same phone** → chains are per-lead (guard keys `lead_uuid`) — BOTH run; the same person may get two calls (accepted v1; sources rarely duplicate inside one window). Their Pulse rows land on the same phone-keyed timeline; their tasks upsert into that thread's single open auto task (§5.6 note).
7. **E-7 window across midnight / weekend / malformed hours** → windows never cross midnight v1: `work_end ≤ work_start` or unparseable times → default 08:00–18:00 (§5.1 sanitization); empty/malformed `work_days` → Mon–Fri; `nextWindowStart` 14-day scan + hard +24h fallback never loops.
8. **E-8 slots exhausted at claim** (engine ok but zero windows) → same as E-1: technical failure → ladder, NOT an indefinite park (FR-9).
9. **E-9 VAPI 4xx/5xx/timeout at placement** → `placeCall` resolves `{ok:false, error:'vapi_http_<status>'|code}` → `scheduleLeadRetryOrExhaust(attempt, error, 'failed')`.
10. **E-10 webhook after disable/disconnect** → the in-flight call still finalizes its timeline; transient path re-checks eligibility in §5.4 step 2 → retry skipped (`outbound_lead_call_retry_skipped`), current attempt keeps its honest terminal status, no task. A booked outcome still records `booked` (the hold landed — honest).
11. **E-11 lead deleted mid-ladder** → FK `ON DELETE CASCADE` removes chain rows; a surviving claimed row hits §5.3 step 1 → `canceled`/`lead_not_found`. `getLeadByUUID` throw ≠ crash (caught).
12. **E-12 DST boundary** → `getTimezoneOffsetMs` probes the offset AT the target wall-time (worker :120-134, DST-safe) — spring-forward 02:30 resolves to the real UTC instant; jest pins it (§18.1).
13. **E-13 lead created already booked/closed** (Sara `createLead` with a hold; imported Lost) → §5.2 step 5 → no chain.
14. **E-14 missing VAPI env** → `placeCall` → `vapi_config_missing` → ladder → exhaustion task (N-5: fails technically and visibly, never silently disappears).
15. **E-15 no `dispatch_settings` row** → `getDispatchSettings` returns `DEFAULT_DISPATCH_SETTINGS` (America/New_York, Mon–Fri 08:00–18:00) — deterministic default window.
16. **E-16 analysisPlan not yet PATCHed** → a human "no" classifies as `failed` → at most `max_attempts-1` extra polite retries (bounded; same semantics the parts robot ships today). Fixed by the §17 PATCH.
17. **E-17 `getDispatchSettings` throws at enqueue/claim** → wrapped → defaults clone; never blocks the chain.
18. **E-18 comments-append fails (SC-05)** → logged, lead still skipped; no chain (the trace is best-effort, the skip decision is not).

---

## 14. Error handling summary

| Failure | Reaction |
|---|---|
| Bus emit fails in `createLead` | `.catch(() => {})` — lead create unaffected |
| Subscriber handler throws | caught in `setImmediate` wrapper → warn; siblings (rules-engine, billing) unaffected |
| Any `onLeadCreated` step throws | whole-body catch → warn `[outboundLeadCall] onLeadCreated error` — no partial chain (INSERT is the last step) |
| `processLeadAttempt` unexpected throw | worker's shared per-attempt catch → `terminate('failed','worker_error:…')` — tick survives, parts rows unaffected |
| `recommendSlots` fault | in-skill SLOT_FALLBACK (never throws) → `no_slots` → ladder |
| `placeCall` fault | resolves `{ok:false}` (never rejects) → ladder |
| `recordPlacement` / `logEvent` / task create / comments append | non-fatal try/catch + warn — never reclassifies an attempt |
| Webhook handler throw | route-level catch → 200 (never a 500-storm); lead branch additionally self-caught |
| Settings table unreadable | worker path: `resolve()` → DEFAULTS (ProReferral-only, 3 attempts); route path: 500 |
| Frontend API errors | sonner `toast.error`; page keeps last-loaded state |

---

## 15. Security & tenancy invariants

- **company_id on every leg:** enqueue reads (`getLeadById(leadId, companyId)`), lifetime-once + all attempt writes (scoped by row identity), lead re-reads (`getLeadByUUID(uuid, companyId)`), comments append (`WHERE uuid AND company_id`), settings (`company_id` PK), tasks belt+create (companyId), timeline resolve (`findOrCreateTimeline(phone, companyId)`), both routes (`req.companyFilter?.company_id` only). No cross-company dialing under any misconfiguration (N-1).
- **Webhook anti-spoof (unchanged discipline):** the only trusted body value is `message.call.id`; company/lead flow from the correlated attempt ROW. Secret auth `x-vapi-secret` = `VAPI_WEBHOOK_SECRET ∥ VAPI_TOOLS_SECRET`, fail-closed 503/401 (existing middleware, untouched).
- **In-call identity:** `leadUuid`/`companyId`/`slotKey` are server-injected via `assistantOverrides.variableValues` and spread LAST in `buildSkillInput` (vapi-tools.js:104-106) — the model can never override them; `confirmLeadBooking` scopes ONLY by injected values and refuses when absent. Cross-company lead = "not found" refusal (no oracle).
- **Booking guard:** only `derivedKey === injected slotKey` OR a live engine re-validation match books; engine fallback during re-validation → refusal (fail-closed). No arbitrary-window writes.
- **Secrets:** VAPI Bearer never logged (existing `placeCall` discipline); tool `server.secret` re-injected on model PATCHes (§17); no client-provided VAPI config anywhere.
- **RBAC:** settings routes behind `tenant.integrations.manage` (+ `authenticate` + `requireCompanyAccess`); timeline rows follow existing `pulse.view`; tasks follow existing tasks RBAC. No new permission keys.

---

## 16. Observability

- **Log prefixes (grep-able):** `[outboundLeadCall]` (service), plus existing `[outboundCallWorker]`, `[vapiCallStatus]`, `[outboundCallService]`, `[OutboundLeadCallSettings]`. Every skip/carry/cancel logs `reason=<machine-readable>` (`app_not_connected`, `source_not_enabled`, `no_phone`, `goal_achieved_at_birth`, `chain_exists`, `lead_not_found`, `goal_achieved:*`, `app_disconnected`, `source_disabled`, `carried`, `no_slots`, `task_exists`).
- **Domain events (`eventService.logEvent`, entity `'lead'`, id = lead uuid):** `outbound_lead_call_retry`, `outbound_lead_call_retry_skipped`, `outbound_lead_call_exhausted`, `outbound_lead_call_declined`, `lead_slot_held` (from the skill).
- **DB truth:** per-attempt rows queryable — `SELECT attempt_no, status, reason, scheduled_at, updated_at FROM outbound_call_attempts WHERE lead_uuid = $1 ORDER BY id;` the GET route's `recent` rollup gives the 30-day per-status counts on the settings page.
- **From the UI:** every dialed attempt is a Pulse call row (live → finalized w/ recording/transcript/summary); SC-05 skips are visible in the lead's Comments; exhaustion/decline surfaces as the p1 task (AR bar + Tasks). No new dashboard v1 (N-6).

---

## 17. VAPI deploy-time PATCH — checklist appendix (owner-gated; NOT code)

`PATCH https://api.vapi.ai/assistant/{VAPI_OUTBOUND_ASSISTANT_ID}` via REST (the CLI panics). **Discipline:** live config DRIFTS — **GET first, merge locally, PATCH the merged doc**; **re-inject the real `x-vapi-secret` into EVERY tool `server` block on any model write** (known gotcha — the GET may mask it, the repo mirror holds `REPLACE_WITH_VAPI_TOOLS_SECRET`).

1. **Prompt** — append a `## Scenario dispatch` section to `model.messages[0].content`: when `{{scenario}}` == `'lead_booking'` → the lead script: the greeting ALREADY happened via the per-call firstMessage — do not re-greet; confirm interest referencing `{{source}}` and `{{problemDescription}}` (do NOT re-verify data already on file — no name/address confirmation); offer `{{slotLabel}}` first and drive to a booking; alternatives via `recommendSlots` (pass lat/lng from context when present, else `{{zip}}`; excludeSlots/daysAhead deeper-search + targetDay/targetTime rules exactly as the parts section); service-area doubt → `checkServiceArea` with `{{zip}}`; on a confirmed pick call `confirmLeadBooking` with `chosenSlot {date,start,end}` (never pass a lead/company id — server-side); refusal/`needsConfirmation` → re-offer, never claim success; explicit decline / "call me later" / "send a human" → polite close, NEVER promise a robo-callback. Any other/absent `{{scenario}}` → the existing parts script, verbatim (paste unchanged).
2. **Tools** — `model.tools` += two entries with `server.url = https://api.albusto.com/api/vapi-tools` + the real secret: `checkServiceArea` (existing registry L0; params `{ zip: string (required) }`) and `confirmLeadBooking` — parameters EXACTLY confirmPartsVisit's shape: `{ chosenSlot: { type:'object', required:['date','start','end'], properties: { date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM' } } }` (NO slotKey/leadUuid/companyId params — §9.2 note), description: "OUTBOUND lead-booking skill. Books the customer's confirmed window as a schedule hold on their request. Call ONCE, only after the customer agreed to a concrete window, passing it as chosenSlot {date,start,end}. Never pass ids — the account is resolved server-side. On a refusal, offer another window via recommendSlots."
3. **analysisPlan** — `analysisPlan.structuredDataPlan` += property `outcome: { type:'string', enum:['booked','declined','callback','no_answer','voicemail','other'] }` (+ keep/enable `summaryPlan` — §5.5 uses `message.analysis.summary` best-effort). Additive; the parts webhook branch ignores analysis.
4. **serverMessages** — list unchanged (`end-of-call-report`, `status-update` already live). **VERIFY on the GET:** the destination that actually receives serverMessages must be `https://api.albusto.com/api/vapi/call-status` — note the repo mirror's top-level `server.url` reads `…/api/vapi-tools` (which swallows non-tool messages); live is known to work, so trust + confirm the live value and mirror it faithfully. `firstMessage` default — unchanged (parts greeting; lead calls override per-call).
5. **First owner-observed test call:** confirm (a) `assistantOverrides.firstMessage` is accepted and `{{customerName}}`/`{{slotLabel}}` substitute inside it (fallback: server-side interpolation, §7.3), (b) `structuredData.outcome` arrives in the end-of-call report.
6. **Mirror** the final live doc into `voice-agent/assistants/parts-visit-scheduler.json` (repo-truth discipline, commit 75bf624 precedent).
7. **Pre-enable audit:** `SELECT id, name, trigger_event FROM automation_rules WHERE trigger_event = 'lead.created';` on prod — any pre-configured rules go live the moment the emit ships (§4.1 side effect); review with the owner.

---

## 18. Verification

### 18.1 Jest (backend; worktree runs need `--testPathIgnorePatterns` per project gotcha)

**`backend/tests/outboundLeadCallSettingsService.test.js`** — pure + DB-mocked:
- `normalizeSource`: `'Pro Referral' ≡ 'ProReferral' ≡ '  pro   referral '`; empty/null → `''`.
- `isSourceEnabled`: match across display variants; empty source → false; empty list → false.
- `coerceStored`: per-key fallbacks (bad max_attempts / non-array sources / junk entries dropped).
- `resolve`: DB throw → DEFAULTS, never throws.

**`backend/tests/outboundLeadCallWindow.test.js`** — pure window math, injected `now` (fake clock), tz `America/New_York`:
- SC-03: Sat 22:40 (workdays Mon–Sat 08–18) → `nextWindowStart` = Mon 08:00 EDT.
- Workday 06:12 → today 08:00; workday 12:00 → `isWithinWorkWindow` true; exactly 18:00 → false (start-strictly-before-end rule).
- `computeLeadNextDueAt`: token table (`immediate`→now, `+30m`, `+2h`, `+45m` generic, unknown→now) + clamp: failure at 17:45 with `+30m` → next business-day 08:00.
- DST: spring-forward day (2026-03-08) — `+2h` across the gap resolves to the correct UTC instant; `nextWindowStart` on the transition day pins 08:00 wall-clock.
- Sanitization: empty `work_days` → Mon–Fri; `end ≤ start` → default hours; pathological all-empty → +24h hard fallback (no infinite loop).
- `normalizeDialablePhone`: 10-digit, 1+10, `+E164`, 7-digit→null, garbage→null, `+44…`→dialable.

**`backend/tests/outboundLeadCallEnqueue.test.js`** — mock `db`/`marketplaceService`/`leadsService`/`scheduleService`:
- Eligibility matrix (connected × source-enabled × dialable × hold/closed × prior-chain) — exactly the passing cell INSERTs; every failing cell inserts nothing and logs its reason.
- SC-05: comments-append SQL called with the exact trace copy + `uuid+company_id` params; INSERT not called.
- Emit-payload contract test (unit over §4.1): `eventBus.emit` called with `('lead.created', { id, uuid, first_name, last_name, phone, job_type, job_source, status })` + opts `{ actorType:'system', aggregateType:'lead' }`; `.catch` attached; `createLead` return value unchanged.
- ON CONFLICT no-op: duplicate call → second INSERT resolves without throwing.

**`backend/tests/outboundLeadCallWorker.test.js`** — mock `recommendSlots`/`outboundCallService`/`vapiCallTimelineService`/`leadsService`:
- Goal-achieved skip (hold set / Lost / Converted / lead missing) → terminate `canceled` with the right reason, no placeCall.
- FR-15 cancels (disconnected / source off) → `canceled`, no dial.
- Window carry: out-of-hours claimed row → UPDATE back to `pending` at `nextWindowStart`, no dial; `OUTBOUND_CALL_IGNORE_BUSINESS_HOURS=true` bypasses.
- `no_slots` → no placeCall, ladder invoked with `('no_slots','failed')`.
- placeCall variableValues SNAPSHOT (lead): scenario `'lead_booking'`, leadUuid, companyId, zip, source, problemDescription trimmed to 300, slot keys, lat/lng riding the slot, `assistantOverrides.firstMessage` present; NO `jobId` key on the wire body.
- **Parts regression pin + scenario isolation (CRITICAL, sabotage control):** seed the mocked claim with TWO rows — one `scenario:'parts_visit'` (job fields), one `scenario:'lead_call'` — run `tick()`: the parts row must flow through the REAL `processAttempt` producing a placeCall body byte-identical to a pre-change golden snapshot (assert deep-equal against a fixture captured from the current code BEFORE this feature's changes), and the lead row must invoke `processLeadAttempt` exactly once. Sabotage control: temporarily flipping the dispatch condition (`!==` for `===`) must fail BOTH assertions — proving the test actually discriminates.
- Ladder: placement failure at attempt 1 → next row `attempt_no=2` scheduled per `computeLeadNextDueAt`, `slot_json` NOT copied; attempt 3 failure → `exhausted` marker + task create called once.

**`backend/tests/outboundLeadCallWebhook.test.js`** — the route via supertest with `x-vapi-secret` (existing vapiCallStatus test pattern):
- Scenario branch routing: a `lead_call`-correlated end-of-call report NEVER touches jobsService booked-detection; a parts report (existing fixtures) is byte-identical in behavior (regression: run the pre-existing parts webhook tests unchanged — they must still pass green).
- Terminal idempotence: `booked` attempt + repeat report → 200 no-op, no lead-branch call, timeline finalize still invoked.
- Booked belt: dialing attempt + lead re-read with LeadDateTime → attempt → `booked`, no task.
- Declined via klass; declined via `analysis.structuredData.outcome='callback'` with klass `failed` → `declined` + task with summary; NO retry insert.
- Transient `no_answer` → ladder insert `attempt_no+1`; exhaustion on the last rung → marker + one task; second identical report → no duplicate (idempotence: row no longer `dialing`).
- Eligibility-blocked retry (app disconnected between dial and report) → `outbound_lead_call_retry_skipped` event, no insert, no task.
- status-update for a lead attempt → `applyStatusUpdate` invoked, no attempt writes (unchanged branch serves both scenarios).

**`backend/tests/confirmLeadBooking.test.js`** — mock `leadsService`/`slotEngineService`/`recommendSlots`/`db`:
- Missing injected leadUuid/companyId → refusal, no reads/writes.
- Malformed/inverted chosenSlot → `needsConfirmation` refusal.
- Offered-guard: derivedKey === injected slotKey → books WITHOUT engine call; different window + engine returns matching key → books; engine SLOT_FALLBACK / no match / throw → refusal, NO updateLead (fail-closed).
- Ownership: `getLeadByUUID` throws / foreign company (mock returns not-found) / closed lead → refusal, no write.
- Hold write shape: `updateLead(leadUuid, { LeadDateTime, LeadEndDateTime, (Latitude/Longitude both-or-nothing) }, companyId)` with tzCombine values; updateLead throw → refusal (no false success).
- Attempt flip: UPDATE `…status='booked'…WHERE company_id AND lead_uuid AND status='dialing'`; flip throw → still `success:true` (non-fatal).
- Anti-spoof: model-style input `{ chosenSlot, leadUuid:'EVIL', companyId:'EVIL' }` merged UNDER injected values (simulate buildSkillInput order) → books against the injected lead only.

**`backend/tests/outboundLeadCallRoutes.test.js`** — mailAgent route-test pattern (express app with stubbed middleware):
- 401 without auth stub; 403 without `tenant.integrations.manage`.
- GET: assembled shape (settings defaults when no row; company_sources distinct; recent rollup); tenant isolation — every db.query call receives the stubbed `company_id`.
- PUT: non-array → 400; >50 items → 400; empty-string item → 400; >80 chars → 400; `['Pro Referral','ProReferral']` → deduped to one stored label; `[]` accepted; response `{ ok:true, data:{ settings } }`.

### 18.2 Frontend

`npm run build` (tsc -b — prod Docker is stricter re noUnusedLocals). No new jest FE runner expected; the page is verified on the stand (below).

### 18.3 Manual stand checklist (dev)

1. Run migrations 172+173 (then `SELECT` the new columns/table); boot the app — marketplace shows the "Outbound Lead Caller" tile; connect it; Configure opens `/settings/integrations/outbound-lead-caller`; "Pro Referral"/"ProReferral" render as ONE preselected row.
2. `FEATURE_OUTBOUND_CALL_WORKER=true` (+ optionally `OUTBOUND_CALL_IGNORE_BUSINESS_HOURS=true`), stub/point VAPI env at a mock: create a lead with `JobSource:'Pro Referral'` + a 10-digit phone → within ~60s the attempt row flips `pending→dialing`, `vapi_call_id`+`slot_json` stamped (mock placement), a live "Ringing" row appears in Pulse on that phone's thread.
3. POST a forged end-of-call report (`x-vapi-secret`) with `endedReason:'customer-did-not-answer'` → attempt `no_answer`, next `pending` row at +30m-clamped; repeat to exhaustion → `exhausted` marker + ONE p1 task on the lead (opens the lead card from Tasks/AR).
4. Create a Thumbtack lead → nothing; a phoneless ProReferral lead → Comments trace; a lead while disconnected → nothing, and reconnecting does NOT dial it.
5. Set the lead's LeadDateTime manually between retries → next claim terminates `canceled`/`goal_achieved:hold_set`.
6. Settings PUT round-trip: uncheck all → queued attempt cancels at next tick (`source_disabled`).
7. Jest suites green (`npx jest tests/outboundLeadCall* tests/confirmLeadBooking* --testPathIgnorePatterns=…`) AND the pre-existing `outboundCall*`/`vapiCallStatus*`/parts suites green unchanged.
8. **VAPI live test = owner smoke post-deploy** (deploy + PATCH are owner-gated «да»; §17 items 5/7 run then).

---

## 19. Explicitly untouched / out of scope

Untouched (protected): `processAttempt`/`scheduleRetryOrExhaust`/`retryBlockReason`/Guard-1, `uq_outbound_call_attempts_active_job`, `outbound_call_settings` + its service, `partsCallService.js` (CANCEL-001 stays parts-only), inbound assistant 30e85a87 + `/api/vapi-tools` contract (`buildSkillInput` spread order is load-bearing), `vapiCallTimelineService.js` re-key/finalize, `groupRouting.js`, Pulse CTEs, `IntegrationsPage.tsx`, `leadsService.createLead` signature + SSE emits, `integrations-leads.js`, `agentSkillsMcpRegistry.js`, `authedFetch.ts`, `useRealtimeEvents.ts`.

Out of scope v1 (per requirements §6): SMS fallback/drip, human-takeover cancellation, voicemail messages, DNC/quiet-hours beyond the business window, a "re-run the robot" button, coupling with per-source ingestion apps, backfill dialing, any parts-scenario change, ladder-editing UI.

## 20. Files (complete)

**NEW:** `backend/db/migrations/172_outbound_lead_call.sql` + `rollback_172_outbound_lead_call.sql` · `backend/db/migrations/173_seed_outbound_lead_caller_marketplace_app.sql` + `rollback_173_seed_outbound_lead_caller_marketplace_app.sql` · `backend/src/services/outboundLeadCallService.js` · `backend/src/services/outboundLeadCallSettingsService.js` · `backend/src/services/agentSkills/skills/confirmLeadBooking.js` · `backend/src/routes/outboundLeadCall.js` · `frontend/src/services/outboundLeadCallerApi.ts` · `frontend/src/pages/OutboundLeadCallerSettingsPage.tsx` · tests: `backend/tests/outboundLeadCallSettingsService.test.js`, `outboundLeadCallWindow.test.js`, `outboundLeadCallEnqueue.test.js`, `outboundLeadCallWorker.test.js`, `outboundLeadCallWebhook.test.js`, `confirmLeadBooking.test.js`, `outboundLeadCallRoutes.test.js`.

**MODIFIED (all additive):** `backend/src/services/leadsService.js` (§4.1 emit only — eventBus require already exists at :11) · `backend/src/services/eventSubscribers.js` (§4.2 one subscriber) · `backend/src/services/outboundCallWorker.js` (§6 dispatch branch + `getTimezoneOffsetMs` export) · `backend/src/routes/vapiCallStatus.js` (§8 two touches) · `backend/src/services/outboundCallService.js` (§7.1 optional args + conditional spreads) · `backend/src/services/agentSkills/registry.js` (§9.1 one entry) · `backend/src/db/marketplaceQueries.js` (§2.4 one boot line) · `src/server.js` (§10.1 one mount line) · `frontend/src/App.tsx` (§11.3 one import + one route) · `voice-agent/assistants/parts-visit-scheduler.json` (deploy-time mirror only, §17.6).
