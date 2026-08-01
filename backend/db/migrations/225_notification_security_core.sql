-- =============================================================================
-- 225: NOTIF-REWORK-001 M1 security core
-- Tenant-paired natural keys, per-user category preferences, the delivery
-- ledger, and the financial-alert permission backfill.
-- Idempotent / re-runnable.
-- =============================================================================

-- domain_events idempotency is tenant-local. The context index also supports
-- tenant-bound foreign keys from notification delivery rows.
DROP INDEX IF EXISTS idx_domain_events_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_events_company_idempotency
    ON domain_events(company_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_events_company_id
    ON domain_events(company_id, id);

-- A browser endpoint may legitimately be registered for multiple tenant
-- memberships. No mutation is allowed to move a row to a different owner.
ALTER TABLE push_subscriptions
    DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_push_subscriptions_company_user_endpoint
    ON push_subscriptions(company_id, user_id, endpoint);

-- Keep both identities: the full owner key supports an idempotent heartbeat,
-- while global token uniqueness guarantees one current physical-device owner.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_tokens_company_user_apns_token
    ON device_tokens(company_id, crm_user_id, apns_token);

-- Converge databases that ran an earlier unreleased 225 revision. The most
-- recently seen binding is the best available current-owner signal.
WITH ranked_device_tokens AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY apns_token
               ORDER BY last_seen_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
           ) AS owner_rank
    FROM device_tokens
)
DELETE FROM device_tokens d
USING ranked_device_tokens ranked
WHERE d.id = ranked.id
  AND ranked.owner_rank > 1;

DO $migration$
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
$migration$;

-- These two T1/T2 policy tables existed only on the unreleased local version of
-- migration 225. Remove them so an already-run development database converges
-- to the simplified model when this migration is reapplied.
DROP TABLE IF EXISTS role_notification_delivery CASCADE;
DROP TABLE IF EXISTS company_notification_policies CASCADE;

-- Replace only the unreleased event/channel preference shape. A second run of
-- this migration leaves the category table and its data intact.
DO $migration$
BEGIN
    IF to_regclass('user_notification_preferences') IS NOT NULL
       AND EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'user_notification_preferences'
             AND column_name IN ('event_type', 'channel', 'preference')
       ) THEN
        DROP TABLE user_notification_preferences;
    END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS user_notification_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    category TEXT NOT NULL CHECK (category IN (
        'job_schedule', 'leads', 'calls_messages', 'finance', 'tasks'
    )),
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_user_notification_preference_membership
        FOREIGN KEY (user_id, company_id)
        REFERENCES company_memberships(user_id, company_id) ON DELETE CASCADE,
    CONSTRAINT uq_user_notification_preference
        UNIQUE (company_id, user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_company_user
    ON user_notification_preferences(company_id, user_id);

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    domain_event_id BIGINT NOT NULL,
    user_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('browser_push', 'native_push', 'in_app', 'email', 'sms')),
    record_type TEXT,
    record_id TEXT,
    is_pre_change_recipient BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'unknown')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    last_error_at TIMESTAMPTZ,
    provider_message_id TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_notification_delivery_event
        FOREIGN KEY (company_id, domain_event_id)
        REFERENCES domain_events(company_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_notification_delivery_membership
        FOREIGN KEY (user_id, company_id)
        REFERENCES company_memberships(user_id, company_id) ON DELETE CASCADE,
    CONSTRAINT uq_notification_delivery
        UNIQUE (company_id, domain_event_id, user_id, channel)
);

-- Reapplying migration 225 must also upgrade databases that created the table
-- before pre-change recipient payload isolation was added.
ALTER TABLE notification_deliveries
    ADD COLUMN IF NOT EXISTS is_pre_change_recipient BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_company_status
    ON notification_deliveries(company_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_company_user
    ON notification_deliveries(company_id, user_id, created_at DESC);

-- New permission keys do not become effective merely by appearing in the code
-- catalog. Backfill every existing fixed role explicitly; record scope remains
-- the provider security boundary.
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, 'notifications.financial.receive', true
FROM company_role_configs rc
WHERE rc.role_key IN ('tenant_admin', 'manager', 'dispatcher', 'provider')
ON CONFLICT (role_config_id, permission_key) DO UPDATE
SET is_allowed = true;
