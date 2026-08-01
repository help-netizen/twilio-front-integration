'use strict';

const fs = require('fs');
const path = require('path');
const {
    NOTIFICATION_EVENT_CATALOG,
} = require('../backend/src/services/notificationEventCatalog');
const { ALL_PERMISSION_KEYS } = require('../backend/src/services/permissionCatalog');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'backend/db/migrations/221_notification_security_core.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'backend/db/migrations/rollback_221_notification_security_core.sql'), 'utf8');
const roleSeed = fs.readFileSync(path.join(root, 'backend/db/migrations/050_seed_role_configs.sql'), 'utf8');
const notificationRoute = fs.readFileSync(path.join(root, 'backend/src/routes/notification-settings.js'), 'utf8');
const notificationPoliciesRoute = fs.readFileSync(path.join(root, 'backend/src/routes/notification-policies.js'), 'utf8');
const actionRequiredRoute = fs.readFileSync(path.join(root, 'backend/src/routes/action-required-settings.js'), 'utf8');
const pushRoute = fs.readFileSync(path.join(root, 'backend/src/routes/push-subscriptions.js'), 'utf8');
const pushService = fs.readFileSync(path.join(root, 'backend/src/services/pushService.js'), 'utf8');
const notificationPolicyService = fs.readFileSync(path.join(root, 'backend/src/services/notificationPolicyService.js'), 'utf8');

describe('NOTIF-REWORK-001 migration 221 contract', () => {
    test('uses tenant-paired idempotency and endpoint identities', () => {
        expect(migration).toContain('ON domain_events(company_id, idempotency_key)');
        expect(migration).toContain('ON push_subscriptions(company_id, user_id, endpoint)');
        expect(migration).toContain('UNIQUE (company_id, domain_event_id, user_id, channel)');
        expect(rollback).toContain('ROLLBACK_221_BLOCKED: cross-company domain_events');
        expect(rollback).toContain('ROLLBACK_221_BLOCKED: cross-company push endpoints');
    });

    test('creates only per-user category preferences and the delivery ledger', () => {
        for (const table of ['user_notification_preferences', 'notification_deliveries']) {
            expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
            expect(rollback).toContain(`DROP TABLE IF EXISTS ${table}`);
        }
        expect(migration).not.toContain('CREATE TABLE IF NOT EXISTS company_notification_policies');
        expect(migration).not.toContain('CREATE TABLE IF NOT EXISTS role_notification_delivery');
        expect(migration).toContain('DROP TABLE IF EXISTS company_notification_policies CASCADE');
        expect(migration).toContain('DROP TABLE IF EXISTS role_notification_delivery CASCADE');
        expect(migration).toContain('category TEXT NOT NULL CHECK');
        expect(migration).toContain('enabled BOOLEAN NOT NULL');
        expect(migration).toContain('UNIQUE (company_id, user_id, category)');
        expect(migration).toContain('REFERENCES company_memberships(user_id, company_id)');
        expect(migration).toContain('REFERENCES domain_events(company_id, id)');
    });

    test('does not seed company, role, event, or channel preferences', () => {
        expect(NOTIFICATION_EVENT_CATALOG).toHaveLength(54);
        expect(migration).not.toContain('browser_push_config');
        expect(migration).not.toContain('notification_m1_catalog_seed');
        const preferenceTable = migration.slice(
            migration.indexOf('CREATE TABLE IF NOT EXISTS user_notification_preferences'),
            migration.indexOf('CREATE INDEX IF NOT EXISTS idx_user_notification_preferences')
        );
        expect(preferenceTable).not.toMatch(/event_type|channel|preference TEXT/);
    });

    test('financial notification permission is cataloged, seeded, and backfilled only as its own key', () => {
        expect(ALL_PERMISSION_KEYS).toContain('notifications.financial.receive');
        expect(roleSeed.match(/\('notifications\.financial\.receive'\)/g)).toHaveLength(4);
        expect(migration).toContain("WHERE rc.role_key IN ('tenant_admin', 'manager', 'dispatcher', 'provider')");
        expect(migration).not.toContain('financial_data.view');
    });

    test('all three settings routes fail closed without first-company lookup', () => {
        for (const source of [notificationRoute, actionRequiredRoute, pushRoute]) {
            expect(source).not.toMatch(/SELECT id FROM companies ORDER BY id LIMIT 1/i);
        }
        expect(notificationPoliciesRoute).toContain('req.companyFilter?.company_id');
        expect(notificationRoute).not.toMatch(/router\.(get|put|patch|post|delete)/);
        expect(notificationPolicyService).toContain('TENANT_CONTEXT_REQUIRED');
        expect(actionRequiredRoute).toContain('TENANT_CONTEXT_REQUIRED');
        expect(pushRoute).toContain('TENANT_CONTEXT_REQUIRED');
    });

    test('subscription mutations and stale cleanup retain the full tenant/user identity', () => {
        expect(pushRoute).toContain('ON CONFLICT (company_id, user_id, endpoint)');
        expect(pushRoute).toMatch(/WHERE company_id = \$1 AND user_id = \$2 AND endpoint = \$3/);
        expect(pushRoute).toMatch(/WHERE id = \$1 AND company_id = \$2 AND user_id = \$3/);
        expect(pushService).toMatch(/WHERE company_id = \$1 AND id = ANY\(\$2::uuid\[\]\)/);
    });

    test('legacy company push config is no longer an authorization source', () => {
        expect(pushService).not.toContain('browser_push_config');
        expect(pushService).not.toContain('company_settings WHERE company_id');
        expect(pushService).toMatch(/async function isEventEnabled\(\) \{\s+return false;/);
    });
});
