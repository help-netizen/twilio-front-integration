-- =============================================================================
-- Rollback 221: NOTIF-REWORK-001 M1 security core
-- Refuses to restore former global uniqueness when tenant-local duplicates now
-- exist. It never deletes or merges subscription/event data to make rollback fit.
-- =============================================================================

-- Run every incompatibility check before the first destructive statement.
-- This remains fail-safe even when psql applies the file in autocommit mode.
DO $rollback$
BEGIN
    IF EXISTS (
        SELECT idempotency_key
        FROM domain_events
        WHERE idempotency_key IS NOT NULL
        GROUP BY idempotency_key
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'ROLLBACK_221_BLOCKED: cross-company domain_events idempotency keys prevent restoring global uniqueness';
    END IF;
    IF EXISTS (
        SELECT endpoint
        FROM push_subscriptions
        GROUP BY endpoint
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'ROLLBACK_221_BLOCKED: cross-company push endpoints prevent restoring global uniqueness';
    END IF;
END
$rollback$;

DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS user_notification_preferences;
DROP TABLE IF EXISTS role_notification_delivery;
DROP TABLE IF EXISTS company_notification_policies;

DELETE FROM company_role_permissions
WHERE permission_key = 'notifications.financial.receive';

DROP INDEX IF EXISTS uq_domain_events_company_idempotency;
DROP INDEX IF EXISTS uq_domain_events_company_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_events_idempotency
    ON domain_events(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS uq_push_subscriptions_company_user_endpoint;
DO $rollback$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'push_subscriptions'::regclass
          AND conname = 'push_subscriptions_endpoint_key'
    ) THEN
        ALTER TABLE push_subscriptions
            ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);
    END IF;
END
$rollback$;

DROP INDEX IF EXISTS uq_company_role_configs_company_id_id;
