-- ============================================================================
-- 100: Platform core — event dispatch, rules engine, agent tasks, cleanup
-- ADR-001. Idempotent.
-- ============================================================================

-- ── Event Bus dispatch journal ──────────────────────────────────────────────
-- domain_events stays the append-only source of truth (unchanged). This table
-- records subscriber dispatch outcomes for observability / at-least-once retry.
CREATE TABLE IF NOT EXISTS event_dispatch_log (
    id              BIGSERIAL PRIMARY KEY,
    event_id        BIGINT REFERENCES domain_events(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL,
    event_type      VARCHAR(100) NOT NULL,
    subscriber      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'skipped')),
    error_text      TEXT,
    duration_ms     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_dispatch_company_created
    ON event_dispatch_log (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatch_event ON event_dispatch_log (event_id);

-- ── Rules Engine ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automation_rules (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    -- trigger
    trigger_kind    TEXT NOT NULL CHECK (trigger_kind IN ('event', 'schedule')),
    event_type      VARCHAR(100),            -- when trigger_kind='event'
    schedule_cron   TEXT,                    -- when trigger_kind='schedule' (cron) …
    delay_after_event_type VARCHAR(100),     -- … or "N seconds after <event>"
    delay_seconds   INTEGER,
    -- conditions: JSON logic {all|any:[{field,op,value}]}
    conditions      JSONB NOT NULL DEFAULT '{}',
    -- actions: ordered [{type, params}], type ∈ send_sms|send_email|create_task|
    --   assign_task|set_action_required|webhook|run_agent_task|fsm_transition
    actions         JSONB NOT NULL DEFAULT '[]',
    created_by      UUID REFERENCES crm_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (trigger_kind <> 'event' OR event_type IS NOT NULL),
    CHECK (trigger_kind <> 'schedule' OR (schedule_cron IS NOT NULL OR delay_after_event_type IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_automation_rules_company_enabled
    ON automation_rules (company_id, enabled);
CREATE INDEX IF NOT EXISTS idx_automation_rules_event
    ON automation_rules (event_type) WHERE enabled AND trigger_kind = 'event';

CREATE TABLE IF NOT EXISTS automation_rule_runs (
    id              BIGSERIAL PRIMARY KEY,
    rule_id         BIGINT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL,
    event_id        BIGINT REFERENCES domain_events(id) ON DELETE SET NULL,
    dedupe_key      TEXT,                    -- event_id × rule_id, prevents double-fire
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'succeeded', 'failed', 'skipped')),
    actions_result  JSONB NOT NULL DEFAULT '[]',
    error_text      TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_run_dedupe
    ON automation_rule_runs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rule_runs_company_created
    ON automation_rule_runs (company_id, created_at DESC);

-- Scheduled rule firing (timer triggers) — when a rule must fire later
CREATE TABLE IF NOT EXISTS automation_scheduled_jobs (
    id              BIGSERIAL PRIMARY KEY,
    rule_id         BIGINT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL,
    fire_at         TIMESTAMPTZ NOT NULL,
    context         JSONB NOT NULL DEFAULT '{}',  -- originating event payload
    dedupe_key      TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'fired', 'cancelled')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sched_jobs_due
    ON automation_scheduled_jobs (fire_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sched_jobs_dedupe
    ON automation_scheduled_jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ── Task Engine: user + agent tasks (extend existing tasks) ──────────────────
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'agent')),
    ADD COLUMN IF NOT EXISTS agent_type TEXT,
    ADD COLUMN IF NOT EXISTS agent_input JSONB,
    ADD COLUMN IF NOT EXISTS agent_output JSONB,
    ADD COLUMN IF NOT EXISTS agent_status TEXT
        CHECK (agent_status IS NULL OR agent_status IN ('queued', 'running', 'succeeded', 'failed')),
    ADD COLUMN IF NOT EXISTS source_rule_id BIGINT REFERENCES automation_rules(id) ON DELETE SET NULL;

-- Agent tasks may not be attached to a conversation thread
ALTER TABLE tasks ALTER COLUMN thread_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_agent_queue
    ON tasks (company_id, agent_status) WHERE kind = 'agent' AND status = 'open';

-- ── Cleanup: drop the dead `payments` table (0 rows, 0 code refs, no view
-- dependencies — see ADR-001). NOTE: `fact_payments` is intentionally KEPT —
-- analytics views (mart_profit_mtd, vw_job_metrics, …) depend on it; the QA/
-- code analysis missed those SQL-level consumers.
DROP TABLE IF EXISTS payments;

-- ── Integrity fixes from QA review of 096 / 098 ─────────────────────────────
-- QA-MIG-002: one Zenbooker team member must map to at most ONE active user
-- per company, otherwise provider visibility silently broadens.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_bridge_per_company
    ON company_user_profiles (zenbooker_team_member_id)
    WHERE zenbooker_team_member_id IS NOT NULL;

COMMENT ON INDEX uq_provider_bridge_per_company IS
    'A Zenbooker team member id is globally unique to one membership/profile (provider visibility integrity).';
