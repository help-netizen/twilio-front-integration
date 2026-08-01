'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const notificationPolicyService = require('../backend/src/services/notificationPolicyService');

const migration = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '225_notification_security_core.sql'),
    'utf8'
);
const rollback = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_225_notification_security_core.sql'),
    'utf8'
);

jest.setTimeout(60000);

function slug(prefix, id) {
    return `${prefix}-${id.replaceAll('-', '')}`;
}

async function preferenceSnapshot(client, companyId) {
    const { rows } = await client.query(
        `SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.user_id, p.category), '[]'::jsonb) AS snapshot
         FROM user_notification_preferences p
         WHERE p.company_id = $1`,
        [companyId]
    );
    return rows[0].snapshot;
}

describe('migration 225 real PostgreSQL isolation', () => {
    test('double apply preserves category preferences and tenant-pairs natural keys', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        const userA = randomUUID();
        const userB = randomUUID();
        const roleA = randomUUID();
        const roleB = randomUUID();
        const sharedEndpoint = `https://push.example/${randomUUID()}`;
        const sharedIdempotency = `notif-migration:${randomUUID()}`;

        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug, status)
                 VALUES ($1, 'Notif fixture A', $2, 'active'),
                        ($3, 'Notif fixture B', $4, 'active')`,
                [companyA, slug('notif-a', companyA), companyB, slug('notif-b', companyB)]
            );
            await client.query(
                `INSERT INTO crm_users (id, keycloak_sub, email, full_name, role, status, onboarding_status, kind)
                 VALUES ($1, $2, $3, 'Notif user A', 'company_member', 'active', 'active', 'user'),
                        ($4, $5, $6, 'Notif user B', 'company_member', 'active', 'active', 'user')`,
                [
                    userA, `notif-sub-${userA}`, `notif-${userA}@example.test`,
                    userB, `notif-sub-${userB}`, `notif-${userB}@example.test`,
                ]
            );
            await client.query(
                `INSERT INTO company_memberships
                    (user_id, company_id, role, role_key, status, activated_at)
                 VALUES ($1, $2, 'company_member', 'dispatcher', 'active', NOW()),
                        ($3, $4, 'company_member', 'provider', 'active', NOW())`,
                [userA, companyA, userB, companyB]
            );
            await client.query(
                `INSERT INTO company_role_configs
                    (id, company_id, role_key, display_name, description, is_locked)
                 VALUES ($1, $2, 'dispatcher', 'Dispatcher', 'Fixture', false),
                        ($3, $4, 'provider', 'Provider', 'Fixture', false)`,
                [roleA, companyA, roleB, companyB]
            );

            await client.query(migration);
            await client.query(
                `INSERT INTO user_notification_preferences (company_id, user_id, category, enabled)
                 VALUES ($1, $2, 'leads', false), ($3, $4, 'tasks', false)`,
                [companyA, userA, companyB, userB]
            );
            const beforeSecondApply = await preferenceSnapshot(client, companyB);
            await client.query(
                `UPDATE company_role_permissions
                 SET is_allowed = false
                 WHERE role_config_id = $1
                   AND permission_key = 'notifications.financial.receive'`,
                [roleA]
            );
            await client.query(migration);
            expect(await preferenceSnapshot(client, companyB)).toStrictEqual(beforeSecondApply);

            const settings = await notificationPolicyService.getNotificationSettings(
                companyA,
                userA,
                { client }
            );
            expect(settings.categories.find(category => category.key === 'leads').enabled).toBe(false);
            expect(settings.categories.filter(category => category.key !== 'leads')
                .every(category => category.enabled)).toBe(true);

            const grants = await client.query(
                `SELECT rc.role_key, p.permission_key, p.is_allowed
                 FROM company_role_configs rc
                 JOIN company_role_permissions p ON p.role_config_id = rc.id
                 WHERE rc.id = ANY($1::uuid[])
                 ORDER BY rc.role_key, p.permission_key`,
                [[roleA, roleB]]
            );
            expect(grants.rows).toEqual([
                { role_key: 'dispatcher', permission_key: 'notifications.financial.receive', is_allowed: true },
                { role_key: 'provider', permission_key: 'notifications.financial.receive', is_allowed: true },
            ]);

            await notificationPolicyService.updateCurrentUserCategory(
                companyA,
                userA,
                'finance',
                { enabled: false },
                { client }
            );
            expect(await preferenceSnapshot(client, companyB)).toStrictEqual(beforeSecondApply);

            await client.query(
                `INSERT INTO push_subscriptions
                    (company_id, user_id, endpoint, p256dh, auth)
                 VALUES ($1, $2, $5, 'a-key', 'a-auth'),
                        ($3, $4, $5, 'b-key', 'b-auth')`,
                [companyA, userA, companyB, userB, sharedEndpoint]
            );
            const beforeBSubscription = await client.query(
                `SELECT to_jsonb(s) AS snapshot FROM push_subscriptions s
                 WHERE company_id = $1 AND user_id = $2 AND endpoint = $3`,
                [companyB, userB, sharedEndpoint]
            );
            await client.query(
                `UPDATE push_subscriptions SET is_active = false
                 WHERE company_id = $1 AND user_id = $2 AND endpoint = $3`,
                [companyA, userA, sharedEndpoint]
            );
            const afterBSubscription = await client.query(
                `SELECT to_jsonb(s) AS snapshot FROM push_subscriptions s
                 WHERE company_id = $1 AND user_id = $2 AND endpoint = $3`,
                [companyB, userB, sharedEndpoint]
            );
            expect(afterBSubscription.rows[0].snapshot)
                .toStrictEqual(beforeBSubscription.rows[0].snapshot);

            await client.query(
                `INSERT INTO domain_events
                    (company_id, aggregate_type, aggregate_id, event_type, idempotency_key)
                 VALUES ($1, 'fixture', 'one', 'lead.created', $3),
                        ($2, 'fixture', 'two', 'lead.created', $3)`,
                [companyA, companyB, sharedIdempotency]
            );
            await client.query('SAVEPOINT duplicate_domain_event');
            await expect(client.query(
                `INSERT INTO domain_events
                    (company_id, aggregate_type, aggregate_id, event_type, idempotency_key)
                 VALUES ($1, 'fixture', 'duplicate', 'lead.created', $2)`,
                [companyA, sharedIdempotency]
            )).rejects.toMatchObject({ code: '23505' });
            await client.query('ROLLBACK TO SAVEPOINT duplicate_domain_event');

            await client.query('SAVEPOINT rollback_preflight');
            await expect(client.query(rollback)).rejects.toThrow(/ROLLBACK_225_BLOCKED/);
            await client.query('ROLLBACK TO SAVEPOINT rollback_preflight');
            const rollbackSafety = await client.query(
                `SELECT to_regclass('user_notification_preferences') AS preferences,
                        to_regclass('notification_deliveries') AS deliveries`
            );
            expect(rollbackSafety.rows[0]).toEqual({
                preferences: 'user_notification_preferences',
                deliveries: 'notification_deliveries',
            });
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
