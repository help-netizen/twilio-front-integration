-- Rollback 152: MAIL-AGENT-001
DROP TABLE IF EXISTS mail_agent_reviews;
DROP TABLE IF EXISTS mail_agent_settings;
UPDATE marketplace_apps SET metadata = metadata - 'setup_path' WHERE app_key = 'mail-secretary';
