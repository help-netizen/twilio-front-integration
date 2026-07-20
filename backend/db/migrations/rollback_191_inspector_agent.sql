-- Rollback INSPECTOR-AGENT-001 schema. Safe to run repeatedly.

DROP INDEX IF EXISTS uq_tasks_open_inspector_lead;
DROP INDEX IF EXISTS uq_tasks_open_inspector_job;
DROP TABLE IF EXISTS inspector_reviews;
DROP TABLE IF EXISTS inspector_daily_runs;
DROP TABLE IF EXISTS inspector_settings;
