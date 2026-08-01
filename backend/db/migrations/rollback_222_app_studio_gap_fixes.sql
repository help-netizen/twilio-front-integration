-- Roll back migration 222 (APP-GAP-FIX-001). Safe to run repeatedly.

DROP INDEX IF EXISTS idx_app_build_messages_retention;
ALTER TABLE app_build_messages
    DROP COLUMN IF EXISTS retention_expires_at;

DROP TRIGGER IF EXISTS trg_app_runtime_create_installation_control
    ON app_installation_principals;
DROP FUNCTION IF EXISTS app_runtime_create_installation_control();
DROP TABLE IF EXISTS app_runtime_usage;
DROP TABLE IF EXISTS app_runtime_installation_controls;

UPDATE app_runs
SET status = CASE WHEN status = 'completed' THEN 'exhausted' ELSE 'revoked' END,
    revoked_at = CASE WHEN status = 'failed' THEN COALESCE(revoked_at, NOW()) ELSE revoked_at END
WHERE status IN ('completed', 'failed');

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS app_runs_status_check;

ALTER TABLE app_runs
    ADD CONSTRAINT app_runs_status_check
        CHECK (status IN ('issued', 'exhausted', 'revoked')),
    DROP COLUMN IF EXISTS completed_at,
    DROP COLUMN IF EXISTS error_code,
    DROP COLUMN IF EXISTS result_bytes,
    DROP COLUMN IF EXISTS gateway_calls_made,
    DROP COLUMN IF EXISTS wall_ms;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_app_runtime_principal_delegator_membership'
          AND conrelid = 'app_installation_principals'::regclass
    ) THEN
        ALTER TABLE app_installation_principals
            ADD CONSTRAINT fk_app_runtime_principal_delegator_membership
                FOREIGN KEY (delegated_by_user_id, company_id)
                REFERENCES company_memberships(user_id, company_id) ON DELETE RESTRICT
                NOT VALID;
    END IF;
END $$;
