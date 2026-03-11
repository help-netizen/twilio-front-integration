-- =============================================================================
-- Migration 039: VAPI AI Agent Integration Tables
-- =============================================================================
-- Adds 5 tables for the Blanc Vapi Agent Node (v3.0 spec):
--   1. provider_connections — tenant-level Vapi integration
--   2. vapi_tenant_resources — SIP ingress per tenant/environment
--   3. vapi_assistant_profiles — reusable assistant config profiles
--   4. call_flow_node_configs — per-node config JSON
--   5. call_ai_runs — AI call execution log / tracing
-- =============================================================================

-- 1. provider_connections
CREATE TABLE IF NOT EXISTS provider_connections (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  provider                  TEXT NOT NULL DEFAULT 'vapi',
  environment               TEXT NOT NULL DEFAULT 'prod',
  status                    TEXT NOT NULL DEFAULT 'connecting',  -- connecting | active | error | disabled
  encrypted_credentials_json TEXT,                               -- encrypted API keys
  display_name              TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_conn_tenant_env
  ON provider_connections(tenant_id, provider, environment);

-- 2. vapi_tenant_resources
CREATE TABLE IF NOT EXISTS vapi_tenant_resources (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  provider_connection_id    TEXT NOT NULL REFERENCES provider_connections(id),
  environment               TEXT NOT NULL DEFAULT 'prod',
  vapi_phone_number_id      TEXT,                                -- Vapi resource ID
  sip_uri                   TEXT,                                -- e.g. sip:tenant-abc-prod@sip.vapi.ai
  server_url                TEXT,                                -- Blanc resolver URL
  assistant_request_secret  TEXT,                                -- signing key
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_resource_tenant_env
  ON vapi_tenant_resources(tenant_id, environment);

-- 3. vapi_assistant_profiles
CREATE TABLE IF NOT EXISTS vapi_assistant_profiles (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  provider_connection_id    TEXT NOT NULL REFERENCES provider_connections(id),
  slug                      TEXT NOT NULL,                       -- e.g. 'greeting_only_v1'
  purpose                   TEXT,                                -- e.g. 'entry_greeting'
  base_config_json          TEXT,                                -- Vapi assistant config as JSON
  vapi_assistant_id         TEXT,                                -- actual Vapi assistant ID
  version                   TEXT NOT NULL DEFAULT '1.0.0',
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_profile_tenant_slug
  ON vapi_assistant_profiles(tenant_id, slug);

-- 4. call_flow_node_configs
CREATE TABLE IF NOT EXISTS call_flow_node_configs (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  flow_id                   TEXT NOT NULL,
  node_id                   TEXT NOT NULL,
  node_kind                 TEXT NOT NULL DEFAULT 'vapi_agent',
  config_json               TEXT NOT NULL DEFAULT '{}',
  version                   TEXT NOT NULL DEFAULT '1',
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_node_config_flow_node
  ON call_flow_node_configs(tenant_id, flow_id, node_id);

-- 5. call_ai_runs
CREATE TABLE IF NOT EXISTS call_ai_runs (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  call_id                   TEXT,                                -- Blanc internal call ID
  call_sid                  TEXT,                                -- Twilio CallSid
  flow_id                   TEXT,
  node_id                   TEXT,
  provider                  TEXT NOT NULL DEFAULT 'vapi',
  provider_connection_id    TEXT REFERENCES provider_connections(id),
  provider_call_id          TEXT,                                -- Vapi call ID
  provider_assistant_id     TEXT,                                -- resolved assistant ID
  status                    TEXT NOT NULL DEFAULT 'pending',     -- pending | started | completed | failed | timeout
  started_at                TIMESTAMPTZ,
  ended_at                  TIMESTAMPTZ,
  duration_sec              INTEGER,
  transcript_ref            TEXT,
  summary_ref               TEXT,
  recording_ref             TEXT,
  dial_call_status          TEXT,                                -- Twilio DialCallStatus
  node_output               TEXT,                                -- completed | transferred | error | timeout | caller_hangup
  metadata_json             TEXT DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_call ON call_ai_runs(call_sid);
CREATE INDEX IF NOT EXISTS idx_ai_runs_tenant ON call_ai_runs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_flow_node ON call_ai_runs(flow_id, node_id);

-- Auto-update triggers
CREATE TRIGGER trg_provider_connections_updated_at BEFORE UPDATE ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_vapi_tenant_resources_updated_at BEFORE UPDATE ON vapi_tenant_resources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_vapi_assistant_profiles_updated_at BEFORE UPDATE ON vapi_assistant_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_call_flow_node_configs_updated_at BEFORE UPDATE ON call_flow_node_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_call_ai_runs_updated_at BEFORE UPDATE ON call_ai_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
