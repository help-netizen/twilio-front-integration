-- =============================================================================
-- Rollback 225: NOTIF-REWORK-001 M1 security core
-- Refuses to restore former global uniqueness when tenant-local duplicates now
-- exist. It never deletes or merges subscription/event data to make rollback fit.
-- =============================================================================

BEGIN;

-- Hold writers out from the global-key checks through index restoration. The
-- transaction makes every later destructive statement atomic with the checks.
LOCK TABLE domain_events, push_subscriptions, device_tokens
    IN SHARE ROW EXCLUSIVE MODE;

-- Run every incompatibility check before the first destructive statement.
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
            'ROLLBACK_225_BLOCKED: cross-company domain_events idempotency keys prevent restoring global uniqueness';
    END IF;
    IF EXISTS (
        SELECT endpoint
        FROM push_subscriptions
        GROUP BY endpoint
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'ROLLBACK_225_BLOCKED: cross-company push endpoints prevent restoring global uniqueness';
    END IF;
    IF EXISTS (
        SELECT apns_token
        FROM device_tokens
        GROUP BY apns_token
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'ROLLBACK_225_BLOCKED: cross-company APNs tokens prevent restoring global uniqueness';
    END IF;
END
$rollback$;

DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS user_notification_preferences;

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

DROP INDEX IF EXISTS uq_device_tokens_company_user_apns_token;
DO $rollback$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'device_tokens'::regclass
          AND conname = 'device_tokens_apns_token_key'
    ) THEN
        ALTER TABLE device_tokens
            ADD CONSTRAINT device_tokens_apns_token_key UNIQUE (apns_token);
    END IF;
END
$rollback$;

COMMIT;
