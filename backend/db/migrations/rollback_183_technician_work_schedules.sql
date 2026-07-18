-- Rollback 183: remove recurring per-technician work schedules.
DROP TABLE IF EXISTS technician_work_schedule_days;
DROP TABLE IF EXISTS technician_work_schedules;
