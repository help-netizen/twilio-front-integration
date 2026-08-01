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
const actionRequiredRoute = fs.readFileSync(path.join(root, 'backend/src/routes/action-required-settings.js'), 'utf8');
const pushRoute = fs.readFileSync(path.join(root, 'backend/src/routes/push-subscriptions.js'), 'utf8');
const pushService = fs.readFileSync(path.join(root, 'backend/src/services/pushService.js'), 'utf8');
const platformCompanyService = fs.readFileSync(path.join(root, 'backend/src/services/platformCompanyService.js'), 'utf8');
const companyQueries = fs.readFileSync(path.join(root, 'backend/src/db/companyQueries.js'), 'utf8');
const roleQueries = fs.readFileSync(path.join(root, 'backend/src/db/roleQueries.js'), 'utf8');

describe('NOTIF-REWORK-001 migration 221 contract', () => {
    test('uses tenant-paired idempotency and endpoint identities', () => {
        expect(migration).toContain('ON domain_events(company_id, idempotency_key)');
        expect(migration).toContain('ON push_subscriptions(company_id, user_id, endpoint)');
        expect(migration).toContain('UNIQUE (company_id, domain_event_id, user_id, channel)');
        expect(rollback).toContain('ROLLBACK_221_BLOCKED: cross-company domain_events');
        expect(rollback).toContain('ROLLBACK_221_BLOCKED: cross-company push endpoints');
    });

    test('creates all M1 policy and delivery tables with tenant-bound FKs', () => {
        for (const table of [
            'company_notification_policies',
            'role_notification_delivery',
            'user_notification_preferences',
            'notification_deliveries',
        ]) {
            expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
            expect(rollback).toContain(`DROP TABLE IF EXISTS ${table}`);
        }
        expect(migration).toContain('REFERENCES company_memberships(user_id, company_id)');
        expect(migration).toContain('REFERENCES domain_events(company_id, id)');
        expect(migration).toContain('REFERENCES company_role_configs(company_id, id)');
    });

    test('catalog seed covers every V1 event and existing-company fallback is false', () => {
        for (const entry of NOTIFICATION_EVENT_CATALOG) {
            expect(migration).toContain(`('${entry.event_type}', ${entry.default_enabled}`);
        }
        expect(migration).toContain('SELECT c.id, catalog.event_type, false');
        expect(migration).toContain("('lead.created', 'browser_push_new_lead_enabled')");
        expect(migration).toContain("('sms.inbound', 'browser_push_new_text_message_enabled')");
        expect(migration).toContain('ON CONFLICT (company_id, event_type) DO NOTHING');
    });

    test('financial notification permission is cataloged, seeded, and backfilled only as its own key', () => {
        expect(ALL_PERMISSION_KEYS).toContain('notifications.financial.receive');
        expect(roleSeed.match(/\('notifications\.financial\.receive'\)/g)).toHaveLength(4);
        expect(migration).toContain("WHERE rc.role_key IN ('tenant_admin', 'manager', 'dispatcher', 'provider')");
        const backfill = migration.slice(
            migration.indexOf('-- New permission keys'),
            migration.indexOf('-- Keep the SQL bootstrap defaults')
        );
        expect(backfill).not.toContain('financial_data.view');
    });

    test('all three legacy settings routes fail closed without first-company lookup', () => {
        for (const source of [notificationRoute, actionRequiredRoute, pushRoute]) {
            expect(source).not.toMatch(/SELECT id FROM companies ORDER BY id LIMIT 1/i);
            expect(source).toContain('TENANT_CONTEXT_REQUIRED');
        }
    });

    test('subscription mutations and stale cleanup retain the full tenant/user identity', () => {
        expect(pushRoute).toContain('ON CONFLICT (company_id, user_id, endpoint)');
        expect(pushRoute).toMatch(/WHERE company_id = \$1 AND user_id = \$2 AND endpoint = \$3/);
        expect(pushRoute).toMatch(/WHERE id = \$1 AND company_id = \$2 AND user_id = \$3/);
        expect(pushService).toMatch(/WHERE company_id = \$1 AND id = ANY\(\$2::uuid\[\]\)/);
    });

    test('new-company bootstrap explicitly seeds catalog defaults', () => {
        expect(platformCompanyService).toContain('seedNotificationDefaultsForCompany');
        expect(companyQueries).toContain('seedNotificationDefaultsForCompany');
        expect(roleQueries).toContain('seedNotificationRoleDefaultsForCompany');
    });
});
