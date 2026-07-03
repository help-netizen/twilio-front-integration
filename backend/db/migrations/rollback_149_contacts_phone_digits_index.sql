-- Rollback 149 (PULSE-PERF-001): вернёт ~8.5s страницу Pulse.
DROP INDEX IF EXISTS idx_contacts_phone_digits;
DROP INDEX IF EXISTS idx_contacts_secondary_phone_digits;
