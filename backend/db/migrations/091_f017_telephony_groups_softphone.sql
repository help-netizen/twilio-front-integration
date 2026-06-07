-- Migration 091: F017 Telephony Groups + Softphone consolidation
-- Group becomes the routing unit: phone_number_settings.group_id is the
-- authoritative number -> group link and call_flow_executions stores runtime state.

ALTER TABLE phone_number_settings
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

ALTER TABLE phone_number_settings
  ADD COLUMN IF NOT EXISTS group_id TEXT REFERENCES user_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_phone_number_settings_company
  ON phone_number_settings(company_id);

CREATE INDEX IF NOT EXISTS idx_phone_number_settings_group
  ON phone_number_settings(group_id);

UPDATE phone_number_settings pns
SET company_id = ug.company_id::uuid,
    group_id = COALESCE(pns.group_id, ugn.group_id),
    routing_mode = CASE WHEN COALESCE(pns.group_id, ugn.group_id) IS NULL THEN pns.routing_mode ELSE 'client' END
FROM user_group_numbers ugn
JOIN user_groups ug ON ug.id = ugn.group_id
WHERE pns.phone_number = ugn.phone_number
  AND (pns.company_id IS NULL OR pns.group_id IS NULL);

-- Do not auto-assign orphan phone_number_settings rows to an arbitrary company.
-- Rows without an explicit user_group_numbers mapping stay unassigned until
-- Twilio sync or an admin action sets company_id in the current tenant context.

ALTER TABLE user_groups
  ALTER COLUMN strategy SET DEFAULT 'Simultaneous';

UPDATE user_groups
SET strategy = 'Simultaneous'
WHERE strategy IS DISTINCT FROM 'Simultaneous';

CREATE TABLE IF NOT EXISTS call_flow_executions (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  call_sid        TEXT NOT NULL,
  group_id        TEXT REFERENCES user_groups(id) ON DELETE SET NULL,
  flow_id         TEXT,
  current_node_id TEXT,
  context_json    TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_flow_executions_call_sid
  ON call_flow_executions(call_sid);

CREATE INDEX IF NOT EXISTS idx_call_flow_executions_company
  ON call_flow_executions(company_id);

CREATE INDEX IF NOT EXISTS idx_call_flow_executions_group
  ON call_flow_executions(group_id);

ALTER TABLE call_events
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'webhook';

CREATE INDEX IF NOT EXISTS idx_events_source
  ON call_events(source, created_at DESC);

DO $$ BEGIN
  CREATE TRIGGER trg_call_flow_executions_updated_at
    BEFORE UPDATE ON call_flow_executions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
