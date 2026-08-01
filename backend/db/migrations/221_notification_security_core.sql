-- =============================================================================
-- 221: NOTIF-REWORK-001 M1 security core
-- Tenant-paired natural keys, notification policy/ledger tables, role defaults,
-- the financial-alert permission backfill, and the two-setting legacy bridge.
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

-- Required by the composite role FK below.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_role_configs_company_id_id
    ON company_role_configs(company_id, id);

CREATE TABLE IF NOT EXISTS company_notification_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    updated_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_company_notification_policy UNIQUE (company_id, event_type),
    CONSTRAINT fk_company_notification_policy_updater
        FOREIGN KEY (updated_by_user_id, company_id)
        REFERENCES company_memberships(user_id, company_id)
);

CREATE TABLE IF NOT EXISTS role_notification_delivery (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role_config_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('browser_push', 'native_push', 'in_app', 'email', 'sms')),
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_role_notification_delivery_role
        FOREIGN KEY (company_id, role_config_id)
        REFERENCES company_role_configs(company_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_role_notification_delivery
        UNIQUE (company_id, role_config_id, event_type, channel)
);

CREATE INDEX IF NOT EXISTS idx_role_notification_delivery_company_event
    ON role_notification_delivery(company_id, event_type);

CREATE TABLE IF NOT EXISTS user_notification_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('browser_push', 'native_push', 'in_app', 'email', 'sms')),
    preference TEXT NOT NULL CHECK (preference IN ('inherit', 'enabled', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_user_notification_preference_membership
        FOREIGN KEY (user_id, company_id)
        REFERENCES company_memberships(user_id, company_id) ON DELETE CASCADE,
    CONSTRAINT uq_user_notification_preference
        UNIQUE (company_id, user_id, event_type, channel)
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
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- Keep the SQL bootstrap defaults aligned with the versioned code catalog. The
-- temporary relation is only migration scaffolding; runtime allowlisting lives
-- in notificationEventCatalog.js.
DROP TABLE IF EXISTS notification_m1_catalog_seed;
CREATE TEMP TABLE notification_m1_catalog_seed (
    event_type TEXT PRIMARY KEY,
    default_enabled BOOLEAN NOT NULL,
    role_keys TEXT[] NOT NULL,
    channels TEXT[] NOT NULL
);

INSERT INTO notification_m1_catalog_seed (event_type, default_enabled, role_keys, channels) VALUES
    ('lead.created', true, ARRAY['tenant_admin','manager','dispatcher'], ARRAY['browser_push']),
    ('lead.assigned', true, ARRAY['tenant_admin','manager','dispatcher'], ARRAY['browser_push']),
    ('lead.unassigned', true, ARRAY['tenant_admin','manager','dispatcher'], ARRAY['browser_push']),
    ('lead.review_required', true, ARRAY['tenant_admin','manager','dispatcher'], ARRAY['browser_push']),
    ('lead.converted', true, ARRAY['tenant_admin','manager','dispatcher'], ARRAY['browser_push']),
    ('lead.status_changed', false, ARRAY['tenant_admin','manager','dispatcher'], ARRAY['browser_push']),
    ('lead.updated', false, ARRAY['tenant_admin','manager','dispatcher'], ARRAY['browser_push']),
    ('job.created', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('job.assigned', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('job.unassigned', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('job.rescheduled', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('job.status_changed', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('job.updated', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('job.sync_completed', false, ARRAY['tenant_admin','manager'], ARRAY['browser_push']),
    ('sms.inbound', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('email.inbound', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('yelp.message_received', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('call.inbound_started', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('call.missed', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('call.voicemail_received', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('call.completed', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('sms.outbound', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('message.delivery_failed', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('ai_call.booked', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('ai_call.declined', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('ai_call.exhausted', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('ai_call.failed', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('ai_call.retry_scheduled', false, ARRAY['tenant_admin','manager','dispatcher'], ARRAY['browser_push']),
    ('estimate.client_accepted', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('estimate.client_declined', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('estimate.send_failed', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('estimate.sent', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('estimate.viewed', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('invoice.send_failed', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('invoice.sent', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('invoice.viewed', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('invoice.voided', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('payment.succeeded', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('payment.failed', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('payment.disputed', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('payment.refunded', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('payment.voided', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('task.assigned', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('task.reassigned', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('task.due', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('task.overdue', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('task.completed', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('review.received', true, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']),
    ('agent_task.failed', true, ARRAY['tenant_admin'], ARRAY['browser_push']),
    ('integration.delivery_failed', true, ARRAY['tenant_admin'], ARRAY['browser_push']),
    ('sync.completed', false, ARRAY['tenant_admin'], ARRAY['browser_push']),
    ('billing.subscription_past_due', true, ARRAY['tenant_admin'], ARRAY['browser_push']),
    ('billing.invoice_payment_failed', true, ARRAY['tenant_admin'], ARRAY['browser_push']),
    ('contact.updated', false, ARRAY['tenant_admin','manager','dispatcher','provider'], ARRAY['browser_push','native_push']);

-- Preserve only the two legacy booleans. ON CONFLICT DO NOTHING is important:
-- re-running this migration must never reset a policy changed after deployment.
DO $migration$
BEGIN
    IF to_regclass('company_settings') IS NOT NULL THEN
        EXECUTE $legacy$
            INSERT INTO company_notification_policies (company_id, event_type, enabled)
            SELECT c.id,
                   legacy.event_type,
                   CASE
                       WHEN jsonb_typeof(cs.setting_value -> legacy.setting_key) = 'boolean'
                       THEN (cs.setting_value ->> legacy.setting_key)::boolean
                       ELSE false
                   END
            FROM companies c
            CROSS JOIN (VALUES
                ('lead.created', 'browser_push_new_lead_enabled'),
                ('sms.inbound', 'browser_push_new_text_message_enabled')
            ) AS legacy(event_type, setting_key)
            LEFT JOIN company_settings cs
              ON cs.company_id = c.id::text
             AND cs.setting_key = 'browser_push_config'
            ON CONFLICT (company_id, event_type) DO NOTHING
        $legacy$;
    END IF;
END
$migration$;

-- Every other event is explicitly false for companies that exist at migration
-- time. Catalog defaults are used only by the post-M1 company bootstrap.
INSERT INTO company_notification_policies (company_id, event_type, enabled)
SELECT c.id, catalog.event_type, false
FROM companies c
CROSS JOIN notification_m1_catalog_seed catalog
ON CONFLICT (company_id, event_type) DO NOTHING;

-- Store explicit true/false role defaults for every deployed M1 channel.
INSERT INTO role_notification_delivery
    (company_id, role_config_id, event_type, channel, enabled)
SELECT rc.company_id,
       rc.id,
       catalog.event_type,
       channel.name,
       rc.role_key = ANY(catalog.role_keys)
FROM company_role_configs rc
CROSS JOIN notification_m1_catalog_seed catalog
CROSS JOIN LATERAL unnest(catalog.channels) AS channel(name)
ON CONFLICT (company_id, role_config_id, event_type, channel) DO NOTHING;

DROP TABLE notification_m1_catalog_seed;
