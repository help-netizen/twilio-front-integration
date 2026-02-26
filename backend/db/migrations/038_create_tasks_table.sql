-- =============================================================================
-- 038: Create tasks table
-- Minimal task model linked to Pulse threads (timelines).
-- A thread can have 0..N tasks, but v1 enforces max 1 open task per thread.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tasks (
    id            BIGSERIAL PRIMARY KEY,
    company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,
    thread_id     BIGINT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
    subject_type  TEXT NOT NULL DEFAULT 'contact',
    subject_id    BIGINT,
    title         TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'done')),
    priority      TEXT NOT NULL DEFAULT 'p2'
                  CHECK (priority IN ('p1', 'p2', 'p3')),
    due_at        TIMESTAMPTZ,
    owner_user_id UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    TEXT NOT NULL DEFAULT 'user'
                  CHECK (created_by IN ('system', 'user')),
    completed_at  TIMESTAMPTZ
);

-- Lookup by thread (most common query)
CREATE INDEX IF NOT EXISTS idx_tasks_thread_status
  ON tasks(thread_id, status);

-- Company-wide task list
CREATE INDEX IF NOT EXISTS idx_tasks_company_status
  ON tasks(company_id, status, due_at);

-- Unique: at most one open task per thread (v1 constraint)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_one_open_per_thread
  ON tasks(thread_id) WHERE status = 'open';

COMMENT ON TABLE tasks IS 'Dispatcher tasks linked to Pulse timeline threads';
