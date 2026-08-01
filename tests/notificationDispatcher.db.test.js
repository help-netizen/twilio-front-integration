'use strict';

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const {
    createNotificationDispatcher,
} = require('../backend/src/services/notificationDispatcher');

jest.setTimeout(60000);

describe('notification dispatcher real PostgreSQL isolation', () => {
    test('T-own/T-foreign/T-blast, active-contact, lead deny, tenant-paired endpoint, and claim dedupe', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        const dispatcherA = randomUUID();
        const providerA = randomUUID();
        const providerB = randomUUID();
        const dispatcherRole = randomUUID();
        const providerRoleA = randomUUID();
        const providerRoleB = randomUUID();
        const sharedEndpoint = `https://push.example/shared-${randomUUID()}`;

        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug, status)
                 VALUES ($1, 'Dispatcher A', $2, 'active'),
                        ($3, 'Dispatcher B', $4, 'active')`,
                [companyA, `dispatcher-a-${companyA}`, companyB, `dispatcher-b-${companyB}`]
            );
            await client.query(
                `INSERT INTO crm_users
                    (id, keycloak_sub, email, full_name, role, status, onboarding_status, kind)
                 VALUES
                    ($1, $2, $3, 'Dispatcher A', 'company_member', 'active', 'active', 'user'),
                    ($4, $5, $6, 'Provider A', 'company_member', 'active', 'active', 'user'),
                    ($7, $8, $9, 'Provider B', 'company_member', 'active', 'active', 'user')`,
                [
                    dispatcherA, `dispatch-${dispatcherA}`, `${dispatcherA}@example.test`,
                    providerA, `dispatch-${providerA}`, `${providerA}@example.test`,
                    providerB, `dispatch-${providerB}`, `${providerB}@example.test`,
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
                    ($1, $2, 'dispatcher', 'Dispatcher', 'Dispatcher fixture', false),
                    ($3, $2, 'provider', 'Provider', 'Dispatcher fixture', false),
                    ($4, $5, 'provider', 'Provider', 'Dispatcher fixture', false)`,
                [dispatcherRole, companyA, providerRoleA, providerRoleB, companyB]
            );
            await client.query(
                `INSERT INTO company_role_permissions
                    (role_config_id, permission_key, is_allowed)
                 VALUES
                    ($1, 'jobs.view', true), ($1, 'leads.view', true),
                    ($1, 'messages.view_client', true),
                    ($2, 'jobs.view', true), ($2, 'leads.view', true),
                    ($2, 'messages.view_client', true),
                    ($3, 'jobs.view', true), ($3, 'leads.view', true),
                    ($3, 'messages.view_client', true)`,
                [dispatcherRole, providerRoleA, providerRoleB]
            );
            const subscriptions = await client.query(
                `INSERT INTO push_subscriptions
                    (company_id, user_id, endpoint, p256dh, auth, is_active)
                 VALUES
                    ($1, $2, $3, 'dispatcher-key', 'dispatcher-auth', true),
                    ($1, $4, $5, 'provider-a-key', 'provider-a-auth', true),
                    ($6, $7, $5, 'provider-b-key', 'provider-b-auth', true)
                 RETURNING id, company_id, user_id, endpoint`,
                [
                    companyA, dispatcherA, `https://push.example/${randomUUID()}`,
                    providerA, sharedEndpoint, companyB, providerB,
                ]
            );
            const providerBSubscription = subscriptions.rows.find(row => row.company_id === companyB);

            const phoneA = `+1508${String(Date.now()).slice(-7)}`;
            const phoneB = `+1617${String(Date.now() + 1).slice(-7)}`;
            const { rows: contacts } = await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164)
                 VALUES ($1, 'Contact A', $2), ($3, 'Contact B', $4)
                 RETURNING id, company_id`,
                [companyA, phoneA, companyB, phoneB]
            );
            const contactA = contacts.find(row => row.company_id === companyA);
            const contactB = contacts.find(row => row.company_id === companyB);
            const jobs = await client.query(
                `INSERT INTO jobs (company_id, contact_id, blanc_status, assigned_provider_user_ids)
                 VALUES ($1, $2, 'Custom active status', $3::jsonb),
                        ($4, $5, 'Custom active status', $6::jsonb)
                 RETURNING id, company_id`,
                [
                    companyA, contactA.id, JSON.stringify([providerA]),
                    companyB, contactB.id, JSON.stringify([providerB]),
                ]
            );
            const ownJob = jobs.rows.find(row => row.company_id === companyA);
            const { rows: conversations } = await client.query(
                `INSERT INTO sms_conversations
                    (company_id, customer_e164, proxy_e164, state)
                 VALUES ($1, $2, $3, 'active')
                 RETURNING id`,
                [companyA, phoneA, `+1202${String(Date.now() + 2).slice(-7)}`]
            );
            const leadUuid = `N${String(Date.now()).slice(-8)}`;
            const { rows: leads } = await client.query(
                `INSERT INTO leads (company_id, uuid, status, first_name)
                 VALUES ($1, $2, 'Submitted', 'Private')
                 RETURNING id`,
                [companyA, leadUuid]
            );

            async function insertEvent(eventType, aggregateType, aggregateId, eventData) {
                const { rows } = await client.query(
                    `INSERT INTO domain_events
                        (company_id, aggregate_type, aggregate_id, event_type, event_data)
                     VALUES ($1, $2, $3, $4, $5::jsonb)
                     RETURNING id, company_id, aggregate_type, aggregate_id,
                               event_type, event_data AS payload`,
                    [companyA, aggregateType, String(aggregateId), eventType, JSON.stringify(eventData)]
                );
                return rows[0];
            }

            const delivered = [];
            const transports = {
                sendWebPushToUser: jest.fn(async (companyId, userId, payload, options) => {
                    delivered.push({ companyId, userId, payload, destinationIds: options.destinationIds });
                    return { targeted: options.destinationIds.length, sent: options.destinationIds.length, failed: 0 };
                }),
                sendNativePushToUser: jest.fn(async () => ({ targeted: 0, sent: 0, failed: 0 })),
            };
            const dispatcher = createNotificationDispatcher({ transports });

            const jobEvent = await insertEvent(
                'job.status_changed',
                'job',
                ownJob.id,
                { to: 'Canceled', record_refs: [{ type: 'job', id: ownJob.id }] }
            );
            await expect(dispatcher.dispatch(jobEvent, { client }))
                .resolves.toEqual({ recipients: 2, deliveries: 2 });
            expect(delivered.map(row => row.userId).sort()).toEqual([dispatcherA, providerA].sort());
            expect(delivered).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ userId: providerB }),
            ]));
            expect(delivered.flatMap(row => row.destinationIds)).not.toContain(providerBSubscription.id);
            expect(delivered.every(row => row.companyId === companyA)).toBe(true);

            await expect(dispatcher.dispatch(jobEvent, { client }))
                .resolves.toEqual({ recipients: 0, deliveries: 0 });
            expect(delivered).toHaveLength(2);

            const leadEvent = await insertEvent(
                'lead.created',
                'lead',
                leads[0].id,
                { record_refs: [{ type: 'lead', id: leads[0].id }] }
            );
            await expect(dispatcher.dispatch(leadEvent, { client }))
                .resolves.toEqual({ recipients: 1, deliveries: 1 });
            expect(delivered.at(-1).userId).toBe(dispatcherA);

            const beforeSms = delivered.length;
            const smsEvent = await insertEvent(
                'sms.inbound',
                'sms',
                conversations[0].id,
                { record_refs: [{ type: 'sms_conversation', id: conversations[0].id }] }
            );
            await expect(dispatcher.dispatch(smsEvent, { client }))
                .resolves.toEqual({ recipients: 2, deliveries: 2 });
            expect(delivered.slice(beforeSms).map(row => row.userId).sort())
                .toEqual([dispatcherA, providerA].sort());
            expect(delivered.slice(beforeSms).some(row => row.userId === providerB)).toBe(false);

            const { rows: deliveryCounts } = await client.query(
                `SELECT company_id, user_id, channel, COUNT(*)::int AS count,
                        BOOL_AND(status = 'sent') AS all_sent
                 FROM notification_deliveries
                 WHERE company_id IN ($1, $2)
                 GROUP BY company_id, user_id, channel`,
                [companyA, companyB]
            );
            expect(deliveryCounts).toEqual(expect.arrayContaining([
                expect.objectContaining({ company_id: companyA, user_id: dispatcherA, channel: 'browser_push', count: 3, all_sent: true }),
                expect.objectContaining({ company_id: companyA, user_id: providerA, channel: 'browser_push', count: 2, all_sent: true }),
            ]));
            expect(deliveryCounts.some(row => row.company_id === companyB || row.user_id === providerB)).toBe(false);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
