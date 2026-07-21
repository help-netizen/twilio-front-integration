'use strict';

/**
 * SCHEDULE-CONTACT-NAME-001 / OB-20 — the Schedule job tile reads the linked
 * contact's live name, with a denormalized fallback for jobs without a valid
 * same-company contact link.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const TEST_DB_URL = process.env.SCHEDULE_CONTACT_NAME_TEST_DB_URL || '';
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;

const db = require('../backend/src/db/connection');
const scheduleService = require('../backend/src/services/scheduleService');

jest.setTimeout(30000);

const QUERIES_FILE = path.join(__dirname, '..', 'backend', 'src', 'db', 'scheduleQueries.js');
const TAG = `SCN-${Date.now()}-${process.pid}`;
const databaseTest = TEST_DB_URL ? test : test.skip;

if (!TEST_DB_URL) {
    console.warn('SCHEDULE-CONTACT-NAME-001 real-DB gate SKIPPED-NEEDS-SCHEDULE_CONTACT_NAME_TEST_DB_URL');
}

describe('Schedule live contact name', () => {
    test('query uses one same-company contact join for search, subtitle, and customer_name', () => {
        const source = fs.readFileSync(QUERIES_FILE, 'utf8');
        const jobsBranch = source.slice(source.indexOf('// ── Jobs'), source.indexOf('// ── Leads'));

        expect(jobsBranch).toContain('COALESCE(c.full_name, j.customer_name) AS subtitle');
        expect(jobsBranch).toContain('COALESCE(c.full_name, j.customer_name) AS customer_name');
        expect(jobsBranch).toContain("COALESCE(c.full_name, j.customer_name, '')");
        expect(jobsBranch).toMatch(/LEFT JOIN contacts c\s+ON c\.id = j\.contact_id\s+AND c\.company_id = j\.company_id/);
        expect(jobsBranch).toContain('j.company_id = $1');
    });

    databaseTest('T-own/T-foreign/T-blast: live name wins only inside the job company and orphan jobs fall back', async () => {
        const client = await db.pool.connect();
        const originalQuery = db.query;
        const companyA = randomUUID();
        const companyB = randomUUID();

        try {
            await client.query('BEGIN');
            db.query = (text, params) => client.query(text, params);

            await client.query(
                `INSERT INTO companies (id, name, slug)
                 VALUES ($1, $2, $3), ($4, $5, $6)`,
                [
                    companyA, `${TAG} Company A`, `${TAG.toLowerCase()}-a`,
                    companyB, `${TAG} Company B`, `${TAG.toLowerCase()}-b`,
                ],
            );
            const contacts = await client.query(
                `INSERT INTO contacts (company_id, full_name)
                 VALUES ($1, $2), ($3, $4)
                 RETURNING id, company_id`,
                [companyA, `${TAG} Live A`, companyB, `${TAG} SECRET B`],
            );
            const contactA = contacts.rows.find(row => row.company_id === companyA).id;
            const contactB = contacts.rows.find(row => row.company_id === companyB).id;

            await client.query(
                `INSERT INTO jobs
                    (company_id, contact_id, job_number, service_name, customer_name, blanc_status, start_date)
                 VALUES
                    ($1, $2, $3, 'Linked repair', $4, 'Submitted', '2026-07-21T13:00:00Z'),
                    ($1, NULL, $5, 'Orphan repair', $6, 'Submitted', '2026-07-21T14:00:00Z'),
                    ($1, $7, $8, 'Cross-linked repair', $9, 'Submitted', '2026-07-21T15:00:00Z'),
                    ($10, $7, $11, 'Foreign repair', $12, 'Submitted', '2026-07-21T16:00:00Z')`,
                [
                    companyA,
                    contactA,
                    `${TAG}-linked`,
                    `${TAG} Stale A`,
                    `${TAG}-orphan`,
                    `${TAG} Orphan fallback`,
                    contactB,
                    `${TAG}-cross-linked`,
                    `${TAG} Safe A fallback`,
                    companyB,
                    `${TAG}-foreign`,
                    `${TAG} Stale B`,
                ],
            );

            const foreignBefore = JSON.stringify((await client.query(
                `SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb) AS jobs
                 FROM jobs j WHERE j.company_id = $1`,
                [companyB],
            )).rows[0].jobs);

            const result = await scheduleService.getScheduleItems(companyA, {
                entityTypes: ['job'],
                startDate: '2026-07-21',
                endDate: '2026-07-21',
                limit: 20,
            });

            expect(result.total).toBe(3);
            expect(result.items.map(item => item.customer_name)).toEqual([
                `${TAG} Live A`,
                `${TAG} Orphan fallback`,
                `${TAG} Safe A fallback`,
            ]);
            expect(result.items.map(item => item.subtitle)).toEqual(result.items.map(item => item.customer_name));
            expect(result.items.every(item => item.company_id === companyA)).toBe(true);
            expect(JSON.stringify(result.items)).not.toContain(`${TAG} SECRET B`);

            const foreignAfter = JSON.stringify((await client.query(
                `SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb) AS jobs
                 FROM jobs j WHERE j.company_id = $1`,
                [companyB],
            )).rows[0].jobs);
            expect(foreignAfter).toBe(foreignBefore);
        } finally {
            db.query = originalQuery;
            try { await client.query('ROLLBACK'); } finally { client.release(); }
        }
    });
});

afterAll(async () => {
    await db.pool.end();
});
