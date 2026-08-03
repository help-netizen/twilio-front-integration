-- Roll back migration 232 (APP-DATA-001 Phase F). Safe to run repeatedly.

DROP INDEX IF EXISTS uq_app_event_deliveries_active;
DROP INDEX IF EXISTS idx_app_event_deliveries_due;
DROP TABLE IF EXISTS app_event_deliveries;
