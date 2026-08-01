'use strict';

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const {
    resolveNotificationRecipients,
} = require('../backend/src/services/notificationRecipientResolver');

jest.setTimeout(60000);

function sortedUserIds(recipients) {
    return recipients.map(recipient => recipient.user_id).sort();
}

describe('notification recipient resolver real PostgreSQL isolation', () => {
    test('T-own/T-foreign/T-blast, active-contact, live-RBAC, and delivery dedupe', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        const dispatcherA = randomUUID();
        const providerA = randomUUID();
        const providerB = randomUUID();
        const dispatcherRole = randomUUID();
        const providerRoleA = randomUUID();
        const providerRoleB = randomUUID();

        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug, status)
                 VALUES ($1, 'Resolver A', $2, 'active'),
                        ($3, 'Resolver B', $4, 'active')`,
                [companyA, `resolver-a-${companyA}`, companyB, `resolver-b-${companyB}`]
            );
            await client.query(
                `INSERT INTO crm_users
                    (id, keycloak_sub, email, full_name, role, status, onboarding_status, kind)
                 VALUES
                    ($1, $2, $3, 'Dispatcher A', 'company_member', 'active', 'active', 'user'),
                    ($4, $5, $6, 'Provider A', 'company_member', 'active', 'active', 'user'),
                    ($7, $8, $9, 'Provider B', 'company_member', 'active', 'active', 'user')`,
                [
                    dispatcherA, `resolver-${dispatcherA}`, `${dispatcherA}@example.test`,
                    providerA, `resolver-${providerA}`, `${providerA}@example.test`,
                    providerB, `resolver-${providerB}`, `${providerB}@example.test`,
                ]
            );
            await client.query(
                `INSERT INTO company_memberships
                    (user_id, company_id, role, role_key, status, activated_at)
                 VALUES
                    ($1, $2, 'company_member', 'dispatcher', 'active', NOW()),
                    ($3, $2, 'company_member', 'provider', 'active', NOW()),
                    ($4, $5, 'company_member', 'provider', 'active', NOW())`,
                [dispatcherA, companyA, providerA, providerB, companyB]
            );
            await client.query(
                `INSERT INTO company_role_configs
                    (id, company_id, role_key, display_name, description, is_locked)
                 VALUES
                    ($1, $2, 'dispatcher', 'Dispatcher', 'Resolver fixture', false),
                    ($3, $2, 'provider', 'Provider', 'Resolver fixture', false),
                    ($4, $5, 'provider', 'Provider', 'Resolver fixture', false)`,
                [dispatcherRole, companyA, providerRoleA, providerRoleB, companyB]
            );
            await client.query(
                `INSERT INTO company_role_permissions
                    (role_config_id, permission_key, is_allowed)
                 VALUES
                    ($1, 'jobs.view', true),
                    ($1, 'messages.view_client', true),
                    ($2, 'jobs.view', true),
                    ($2, 'messages.view_client', true),
                    ($3, 'jobs.view', true),
                    ($3, 'messages.view_client', true)`,
                [dispatcherRole, providerRoleA, providerRoleB]
            );
            await client.query(
                `INSERT INTO push_subscriptions
                    (company_id, user_id, endpoint, p256dh, auth, is_active)
                 VALUES
                    ($1, $2, $3, 'dispatcher-key', 'dispatcher-auth', true),
                    ($1, $4, $5, 'provider-a-key', 'provider-a-auth', true),
                    ($6, $7, $8, 'provider-b-key', 'provider-b-auth', true)`,
                [
                    companyA, dispatcherA, `https://push.example/${randomUUID()}`,
                    providerA, `https://push.example/${randomUUID()}`,
                    companyB, providerB, `https://push.example/${randomUUID()}`,
                ]
            );

            const contacts = await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164)
                 VALUES
                    ($1, 'Active custom', $2),
                    ($1, 'Inactive canceled', $3),
                    ($4, 'Foreign contact', $5)
                 RETURNING id, company_id, full_name, phone_e164`,
                [
                    companyA, `+1508${String(Date.now()).slice(-7)}`,
                    `+1617${String(Date.now() + 1).slice(-7)}`,
                    companyB, `+1781${String(Date.now() + 2).slice(-7)}`,
                ]
            );
            const byName = new Map(contacts.rows.map(row => [row.full_name, row]));
            const jobs = await client.query(
                `INSERT INTO jobs
                    (company_id, contact_id, blanc_status, assigned_provider_user_ids)
                 VALUES
                    ($1, $2, 'Custom active status', $3::jsonb),
                    ($1, $4, 'Canceled', $3::jsonb),
                    ($5, $6, 'Custom active status', $7::jsonb)
                 RETURNING id, company_id, contact_id`,
                [
                    companyA,
                    byName.get('Active custom').id,
                    JSON.stringify([providerA]),
                    byName.get('Inactive canceled').id,
                    companyB,
                    byName.get('Foreign contact').id,
                    JSON.stringify([providerB]),
                ]
            );
            const ownJob = jobs.rows.find(row => row.company_id === companyA
                && row.contact_id === byName.get('Active custom').id);
            const foreignJob = jobs.rows.find(row => row.company_id === companyB);

            const conversations = await client.query(
                `INSERT INTO sms_conversations
                    (company_id, customer_e164, proxy_e164, state)
                 VALUES ($1, $2, $4, 'active'), ($1, $3, $5, 'active')
                 RETURNING id, customer_e164`,
                [
                    companyA,
                    byName.get('Active custom').phone_e164,
                    byName.get('Inactive canceled').phone_e164,
                    `+1202${String(Date.now() + 3).slice(-7)}`,
                    `+1202${String(Date.now() + 4).slice(-7)}`,
                ]
            );
            const activeConversation = conversations.rows.find(row => (
                row.customer_e164 === byName.get('Active custom').phone_e164
            ));
            const inactiveConversation = conversations.rows.find(row => (
                row.customer_e164 === byName.get('Inactive canceled').phone_e164
            ));

            async function insertEvent(eventType, aggregateType, aggregateId, payload) {
                const { rows } = await client.query(
                    `INSERT INTO domain_events
                        (company_id, aggregate_type, aggregate_id, event_type, event_data)
                     VALUES ($1, $2, $3, $4, $5::jsonb)
                     RETURNING id, company_id, aggregate_type, aggregate_id, event_type,
                               event_data AS payload`,
                    [companyA, aggregateType, String(aggregateId), eventType, JSON.stringify(payload)]
                );
                return rows[0];
            }

            const ownJobEvent = await insertEvent(
                'job.status_changed', 'job', ownJob.id, { to: 'Canceled' }
            );
            const ownRecipients = await resolveNotificationRecipients(
                companyA,
                ownJobEvent,
                { client }
            );
            expect(sortedUserIds(ownRecipients)).toEqual([dispatcherA, providerA].sort());
            expect(ownRecipients).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ user_id: providerB }),
            ]));
            await expect(resolveNotificationRecipients(
                companyA,
                ownJobEvent,
                { client }
            )).resolves.toEqual([]);

            const foreignAggregateEvent = await insertEvent(
                'job.status_changed', 'job', foreignJob.id, { to: 'Canceled' }
            );
            await expect(resolveNotificationRecipients(
                companyA,
                foreignAggregateEvent,
                { client }
            )).resolves.toEqual([]);

            const activeSmsEvent = await insertEvent(
                'sms.inbound', 'sms', activeConversation.id, {}
            );
            expect(sortedUserIds(await resolveNotificationRecipients(
                companyA,
                activeSmsEvent,
                { client }
            ))).toEqual([dispatcherA, providerA].sort());

            const inactiveSmsEvent = await insertEvent(
                'sms.inbound', 'sms', inactiveConversation.id, {}
            );
            expect(sortedUserIds(await resolveNotificationRecipients(
                companyA,
                inactiveSmsEvent,
                { client }
            ))).toEqual([dispatcherA]);

            await client.query(
                `UPDATE company_role_permissions
                 SET is_allowed = false
                 WHERE role_config_id = $1 AND permission_key = 'jobs.view'`,
                [providerRoleA]
            );
            const afterRevocationEvent = await insertEvent(
                'job.status_changed', 'job', ownJob.id, { to: 'Canceled' }
            );
            expect(sortedUserIds(await resolveNotificationRecipients(
                companyA,
                afterRevocationEvent,
                { client }
            ))).toEqual([dispatcherA]);

            const foreignDeliveryCount = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM notification_deliveries
                 WHERE company_id = $1 OR user_id = $2`,
                [companyB, providerB]
            );
            expect(foreignDeliveryCount.rows[0].count).toBe(0);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
