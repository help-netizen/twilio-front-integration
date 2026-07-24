'use strict';

const { randomUUID } = require('crypto');

const TEST_DB_URL = process.env.MOBILE_CATCHUP_TEST_DB_URL || process.env.DATABASE_URL || '';
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;

const db = require('../backend/src/db/connection');
const otpService = require('../backend/src/services/otpService');
const contactsService = require('../backend/src/services/contactsService');
const jobsService = require('../backend/src/services/jobsService');
const syncQueries = require('../backend/src/db/syncQueries');

jest.setTimeout(30000);

const TAG = `MCB-${Date.now()}-${process.pid}`;
const databaseTest = TEST_DB_URL ? test : test.skip;

if (!TEST_DB_URL) {
    console.warn('MOBILE-CATCHUP-BE real-DB gate SKIPPED-NEEDS-MOBILE_CATCHUP_TEST_DB_URL');
}

async function withTransaction(work) {
    const client = await db.pool.connect();
    const originalQuery = db.query;
    try {
        await client.query('BEGIN');
        db.query = (text, params) => client.query(text, params);
        return await work(client);
    } finally {
        db.query = originalQuery;
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
}

describe('MOBILE-CATCHUP-BE real PostgreSQL contracts', () => {
    databaseTest('native credential is hashed at rest and bound to its crm_user row', async () => {
        await withTransaction(async (client) => {
            const userId = randomUUID();
            await client.query(
                `INSERT INTO crm_users (id, keycloak_sub, email, full_name)
                 VALUES ($1, $2, $3, $4)`,
                [userId, `${TAG}-native-sub`, `${TAG}@example.test`, `${TAG} Native User`],
            );

            const minted = await otpService.trustDevice(userId, {
                ip: '127.0.0.1',
                label: 'native:test-binding:iPhone',
            });
            const stored = (await client.query(
                `SELECT user_id, device_id_hash, label, revoked_at, expires_at
                 FROM trusted_devices
                 WHERE user_id = $1`,
                [userId],
            )).rows[0];

            expect(stored.user_id).toBe(userId);
            expect(stored.device_id_hash).toMatch(/^[a-f0-9]{64}$/);
            expect(stored.device_id_hash).not.toBe(minted.deviceId);
            expect(stored.label).toBe('native:test-binding:iPhone');
            expect(stored.revoked_at).toBeNull();
            await expect(otpService.isDeviceTrusted(userId, minted.deviceId)).resolves.toBe(true);
            await expect(otpService.isDeviceTrusted(randomUUID(), minted.deviceId)).resolves.toBe(false);
        });
    });

    databaseTest('T-own/T-foreign/T-blast plus contact-rename delta and live job names', async () => {
        await withTransaction(async (client) => {
            const companyA = randomUUID();
            const companyB = randomUUID();
            const providerUserId = randomUUID();
            const sharedPhone = `+1617${String(Date.now()).slice(-7)}`;

            await client.query(
                `INSERT INTO companies (id, name, slug)
                 VALUES ($1, $2, $3), ($4, $5, $6)`,
                [
                    companyA, `${TAG} Company A`, `${TAG.toLowerCase()}-a`,
                    companyB, `${TAG} Company B`, `${TAG.toLowerCase()}-b`,
                ],
            );
            const contacts = await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164, email, updated_at)
                 VALUES
                    ($1, $2, $3, $4, '2026-07-20T10:00:00Z'),
                    ($1, $5, $6, $7, '2026-07-20T10:00:00Z'),
                    ($8, $9, $3, $10, '2026-07-20T10:00:00Z')
                 RETURNING id, company_id, full_name`,
                [
                    companyA,
                    `${TAG} Assigned`,
                    sharedPhone,
                    `${TAG}-assigned@example.test`,
                    `${TAG} Unassigned`,
                    '+16175550002',
                    `${TAG}-unassigned@example.test`,
                    companyB,
                    `${TAG} Foreign secret`,
                    `${TAG}-foreign@example.test`,
                ],
            );
            const contactA = contacts.rows.find(row => row.full_name === `${TAG} Assigned`);
            const contactB = contacts.rows.find(row => row.company_id === companyB);

            const jobs = await client.query(
                `INSERT INTO jobs
                    (company_id, contact_id, job_number, customer_name, blanc_status,
                     assigned_provider_user_ids, updated_at)
                 VALUES
                    ($1, $2, $3, $4, 'Submitted', $5::jsonb, '2026-07-20T10:00:00Z'),
                    ($6, $7, $8, $9, 'Submitted', $5::jsonb, '2026-07-20T10:00:00Z')
                 RETURNING id, company_id`,
                [
                    companyA,
                    contactA.id,
                    `${TAG}-A`,
                    `${TAG} Stale A`,
                    JSON.stringify([providerUserId]),
                    companyB,
                    contactB.id,
                    `${TAG}-B`,
                    `${TAG} Stale B`,
                ],
            );
            const jobA = jobs.rows.find(row => row.company_id === companyA);
            const jobB = jobs.rows.find(row => row.company_id === companyB);

            const foreignBefore = JSON.stringify((await client.query(
                `SELECT jsonb_build_object(
                    'contacts', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
                                         FROM contacts c WHERE c.company_id = $1), '[]'::jsonb),
                    'jobs', COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id)
                                     FROM jobs j WHERE j.company_id = $1), '[]'::jsonb)
                 ) AS snapshot`,
                [companyB],
            )).rows[0].snapshot);

            const ownContacts = await contactsService.listContacts({
                companyId: companyA,
                providerScope: { assignedOnly: true, userId: providerUserId },
                search: TAG,
                limit: 20,
            });
            expect(ownContacts.results.map(contact => contact.id)).toEqual([contactA.id]);
            expect(JSON.stringify(ownContacts.results)).not.toContain('Foreign secret');

            const foreignContacts = await contactsService.listContacts({
                companyId: companyA,
                providerScope: { assignedOnly: true, userId: providerUserId },
                search: 'Foreign secret',
                limit: 20,
            });
            expect(foreignContacts.results).toEqual([]);
            await expect(jobsService.getJobById(
                jobB.id,
                companyA,
                { assignedOnly: true, userId: providerUserId },
            )).resolves.toBeNull();

            const firstSync = await syncQueries.getChangedJobs({
                companyId: companyA,
                crmUserId: providerUserId,
                cursor: null,
                limit: 20,
                windowDays: 30,
            });
            expect(firstSync.jobs).toHaveLength(1);
            expect(firstSync.jobs[0].customer_name).toBe(`${TAG} Assigned`);
            expect(firstSync.jobs[0].updated_at).toBe('2026-07-20T10:00:00.000Z');
            const firstCursor = syncQueries.parseCursor(firstSync.nextCursor);

            await client.query(
                'UPDATE contacts SET full_name = $1 WHERE id = $2 AND company_id = $3',
                [`${TAG} Renamed live`, contactA.id, companyA],
            );
            const jobUpdatedAfterRename = (await client.query(
                'SELECT updated_at FROM jobs WHERE id = $1 AND company_id = $2',
                [jobA.id, companyA],
            )).rows[0].updated_at.toISOString();
            const contactUpdatedAfterRename = (await client.query(
                'SELECT updated_at FROM contacts WHERE id = $1 AND company_id = $2',
                [contactA.id, companyA],
            )).rows[0].updated_at.toISOString();
            expect(jobUpdatedAfterRename).toBe('2026-07-20T10:00:00.000Z');

            const renamedDelta = await syncQueries.getChangedJobs({
                companyId: companyA,
                crmUserId: providerUserId,
                cursor: firstCursor,
                limit: 20,
                windowDays: 30,
            });
            expect(renamedDelta.jobs).toHaveLength(1);
            expect(renamedDelta.jobs[0]).toEqual(expect.objectContaining({
                id: jobA.id,
                customer_name: `${TAG} Renamed live`,
                updated_at: '2026-07-20T10:00:00.000Z',
            }));
            expect(renamedDelta.jobs[0]).not.toHaveProperty('sync_changed_at');
            expect(renamedDelta.nextCursor).toBe(`${contactUpdatedAfterRename}|${jobA.id}`);

            const detail = await jobsService.getJobById(
                jobA.id,
                companyA,
                { assignedOnly: true, userId: providerUserId },
            );
            expect(detail.customer_name).toBe(`${TAG} Renamed live`);
            expect(detail.updated_at).toBe('2026-07-20T10:00:00.000Z');

            const search = await jobsService.listJobs({
                companyId: companyA,
                providerScope: { assignedOnly: true, userId: providerUserId },
                search: 'Renamed live',
                limit: 20,
                offset: 0,
            });
            expect(search.results.map(job => job.id)).toEqual([jobA.id]);
            expect(search.results[0].customer_name).toBe(`${TAG} Renamed live`);

            const foreignAfter = JSON.stringify((await client.query(
                `SELECT jsonb_build_object(
                    'contacts', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
                                         FROM contacts c WHERE c.company_id = $1), '[]'::jsonb),
                    'jobs', COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id)
                                     FROM jobs j WHERE j.company_id = $1), '[]'::jsonb)
                 ) AS snapshot`,
                [companyB],
            )).rows[0].snapshot);
            expect(foreignAfter).toBe(foreignBefore);
        });
    });
});

afterAll(async () => {
    await db.pool.end();
});
