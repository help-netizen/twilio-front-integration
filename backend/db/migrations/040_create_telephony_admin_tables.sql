-- =============================================================================
-- Migration 040: Telephony Admin Tables
-- =============================================================================
-- Tables for User Groups, Business Hours, Number Assignments, and Call Flows
-- =============================================================================

-- 1. user_groups
CREATE TABLE IF NOT EXISTS user_groups (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  strategy      TEXT NOT NULL DEFAULT 'Round Robin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_groups_company ON user_groups(company_id);

-- 2. user_group_members
CREATE TABLE IF NOT EXISTS user_group_members (
  id            BIGSERIAL PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  priority      INT DEFAULT 0,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_group_member ON user_group_members(group_id, user_id);

-- 3. user_group_numbers
CREATE TABLE IF NOT EXISTS user_group_numbers (
  id            BIGSERIAL PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  phone_number  TEXT NOT NULL,
  friendly_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_group_number ON user_group_numbers(group_id, phone_number);

-- 4. user_group_hours (7 rows per group)
CREATE TABLE IF NOT EXISTS user_group_hours (
  id            BIGSERIAL PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  day_of_week   TEXT NOT NULL,
  is_open       BOOLEAN NOT NULL DEFAULT true,
  open_time     TEXT,
  close_time    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_group_hours_day ON user_group_hours(group_id, day_of_week);

-- 5. call_flows
CREATE TABLE IF NOT EXISTS call_flows (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  group_id      TEXT REFERENCES user_groups(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',
  graph_json    TEXT NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_flows_company ON call_flows(company_id);
CREATE INDEX IF NOT EXISTS idx_call_flows_group ON call_flows(group_id);

-- Auto-update triggers
DO $$ BEGIN
  CREATE TRIGGER trg_user_groups_updated_at BEFORE UPDATE ON user_groups
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_call_flows_updated_at BEFORE UPDATE ON call_flows
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
