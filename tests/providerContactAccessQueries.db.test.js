'use strict';

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const {
    providerHasActiveJobForContact,
    listProvidersWithActiveJobForContact,
} = require('../backend/src/db/providerContactAccessQueries');

jest.setTimeout(30000);

describe('shared active assigned-contact query real PostgreSQL isolation', () => {
    test('T-own/T-foreign/T-blast and deny-list semantics', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        const providerA = randomUUID();
        const providerB = randomUUID();

        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug, status)
                 VALUES ($1, 'Contact scope A', $2, 'active'),
                        ($3, 'Contact scope B', $4, 'active')`,
                [companyA, `contact-scope-a-${companyA}`, companyB, `contact-scope-b-${companyB}`]
            );
            await client.query(
                `INSERT INTO crm_users
                    (id, keycloak_sub, email, full_name, role, status, onboarding_status, kind)
                 VALUES ($1, $2, $3, 'Provider A', 'company_member', 'active', 'active', 'user'),
                        ($4, $5, $6, 'Provider B', 'company_member', 'active', 'active', 'user')`,
                [
                    providerA, `contact-scope-${providerA}`, `${providerA}@example.test`,
                    providerB, `contact-scope-${providerB}`, `${providerB}@example.test`,
                ]
            );
            await client.query(
                `INSERT INTO company_memberships
                    (user_id, company_id, role, role_key, status, activated_at)
                 VALUES ($1, $2, 'company_member', 'provider', 'active', NOW()),
                        ($3, $4, 'company_member', 'provider', 'active', NOW())`,
                [providerA, companyA, providerB, companyB]
            );
            const contacts = await client.query(
                `INSERT INTO contacts (company_id, full_name)
                 VALUES ($1, 'Custom active'), ($1, 'Canceled'), ($1, 'Done'),
                        ($2, 'Foreign')
                 RETURNING id, company_id, full_name`,
                [companyA, companyB]
            );
            const byName = new Map(contacts.rows.map(row => [row.full_name, row]));
            const insertJob = (companyId, contactId, status, providerId) => client.query(
                `INSERT INTO jobs
                    (company_id, contact_id, blanc_status, assigned_provider_user_ids)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [companyId, contactId, status, JSON.stringify([providerId])]
            );
            await insertJob(companyA, byName.get('Custom active').id, 'Custom status', providerA);
            await insertJob(companyA, byName.get('Canceled').id, 'Canceled', providerA);
            await insertJob(companyA, byName.get('Done').id, 'Job is Done', providerA);
            await insertJob(companyB, byName.get('Foreign').id, 'Custom status', providerB);

            await expect(providerHasActiveJobForContact(
                companyA, providerA, byName.get('Custom active').id, { client }
            )).resolves.toBe(true);
            await expect(providerHasActiveJobForContact(
                companyA, providerA, byName.get('Canceled').id, { client }
            )).resolves.toBe(false);
            await expect(providerHasActiveJobForContact(
                companyA, providerA, byName.get('Done').id, { client }
            )).resolves.toBe(false);
            await expect(providerHasActiveJobForContact(
                companyA, providerB, byName.get('Custom active').id, { client }
            )).resolves.toBe(false);
            await expect(providerHasActiveJobForContact(
                companyA, providerA, byName.get('Foreign').id, { client }
            )).resolves.toBe(false);

            await expect(listProvidersWithActiveJobForContact(
                companyA, byName.get('Custom active').id, { client }
            )).resolves.toEqual([providerA]);
            await expect(listProvidersWithActiveJobForContact(
                companyA, byName.get('Canceled').id, { client }
            )).resolves.toEqual([]);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
