-- Rollback 153: MAIL-AGENT-002
ALTER TABLE mail_agent_settings DROP COLUMN IF EXISTS activated_at;
