-- Rollback AI-GEN-LOG-001
DROP INDEX IF EXISTS idx_ai_generation_log_company_created;
DROP TABLE IF EXISTS ai_generation_log;
