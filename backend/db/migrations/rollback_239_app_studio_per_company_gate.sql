-- Roll back migration 239 (APP-STUDIO-GATE-002). Safe to run repeatedly.

ALTER TABLE companies
    DROP COLUMN IF EXISTS app_studio_enabled;
