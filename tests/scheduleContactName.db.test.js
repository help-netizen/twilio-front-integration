'use strict';

/**
 * SCHEDULE-CONTACT-NAME-001 / OB-20 — the Schedule job tile reads the linked
 * contact's live name, with a denormalized fallback for jobs without a valid
 * same-company contact link.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const TEST_DB_URL = process.env.JOB_EMAIL_SOT_TEST_DB_URL
    || process.env.SCHEDULE_CONTACT_NAME_TEST_DB_URL
    || '';
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;

const db = require('../backend/src/db/connection');
const scheduleService = require('../backend/src/services/scheduleService');
const jobsService = require('../backend/src/services/jobsService');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const estimatesQueries = require('../backend/src/db/estimatesQueries');

jest.setTimeout(30000);

const QUERIES_FILE = path.join(__dirname, '..', 'backend', 'src', 'db', 'scheduleQueries.js');
const TAG = `SCN-${Date.now()}-${process.pid}`;
const databaseTest = TEST_DB_URL ? test : test.skip;

if (!TEST_DB_URL) {
    console.warn('JOB-EMAIL-SOT-001 real-DB gate SKIPPED-NEEDS-JOB_EMAIL_SOT_TEST_DB_URL');
}

describe('Job-linked live contact identity', () => {
    test('Schedule uses one same-company contact join for name, email, and phone', () => {
        const source = fs.readFileSync(QUERIES_FILE, 'utf8');
        const jobsBranch = source.slice(source.indexOf('// ── Jobs'), source.indexOf('// ── Leads'));

        expect(jobsBranch).toContain('COALESCE(c.full_name, j.customer_name) AS subtitle');
        expect(jobsBranch).toContain('COALESCE(c.full_name, j.customer_name) AS customer_name');
        expect(jobsBranch).toContain("COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS customer_email");
        expect(jobsBranch).toContain("COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS customer_phone");
        expect(jobsBranch).toContain("COALESCE(c.full_name, j.customer_name, '')");
        expect(jobsBranch).toMatch(/LEFT JOIN contacts c\s+ON c\.id = j\.contact_id\s+AND c\.company_id = j\.company_id/);
        expect(jobsBranch).toContain('j.company_id = $1');
    });

    databaseTest('T-own/T-foreign/T-blast: job, Schedule, invoice, and estimate reads use same-company contact details with legacy fallback', async () => {
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
                `INSERT INTO contacts (company_id, full_name, email, phone_e164)
                 VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)
                 RETURNING id, company_id`,
                [
                    companyA, `${TAG} Live A`, `${TAG.toLowerCase()}-live-a@example.com`, '+16175550101',
                    companyB, `${TAG} SECRET B`, `${TAG.toLowerCase()}-secret-b@example.com`, '+16175550999',
                ],
            );
            const contactA = contacts.rows.find(row => row.company_id === companyA).id;
            const contactB = contacts.rows.find(row => row.company_id === companyB).id;

            const insertedJobs = await client.query(
                `INSERT INTO jobs
                    (company_id, contact_id, job_number, service_name, customer_name,
                     customer_email, customer_phone, blanc_status, start_date)
                 VALUES
                    ($1, $2, $3, 'Linked repair', $4, '', '', 'Submitted', '2026-07-21T13:00:00Z'),
                    ($1, NULL, $5, 'Orphan repair', $6, $7, $8, 'Submitted', '2026-07-21T14:00:00Z'),
                    ($1, $9, $10, 'Cross-linked repair', $11, $12, $13, 'Submitted', '2026-07-21T15:00:00Z'),
                    ($14, $9, $15, 'Foreign repair', $16, '', '', 'Submitted', '2026-07-21T16:00:00Z')
                 RETURNING id, job_number`,
                [
                    companyA,
                    contactA,
                    `${TAG}-linked`,
                    `${TAG} Stale A`,
                    `${TAG}-orphan`,
                    `${TAG} Orphan fallback`,
                    `${TAG.toLowerCase()}-legacy@example.com`,
                    '+16175550202',
                    contactB,
                    `${TAG}-cross-linked`,
                    `${TAG} Safe A fallback`,
                    `${TAG.toLowerCase()}-safe-a@example.com`,
                    '+16175550303',
                    companyB,
                    `${TAG}-foreign`,
                    `${TAG} Stale B`,
                ],
            );
            const jobId = suffix => insertedJobs.rows.find(row => row.job_number === `${TAG}-${suffix}`).id;
            const linkedJobId = jobId('linked');
            const orphanJobId = jobId('orphan');
            const crossLinkedJobId = jobId('cross-linked');

            const invoice = (await client.query(
                `INSERT INTO invoices (company_id, invoice_number, job_id, contact_id)
                 VALUES ($1, $2, $3, NULL) RETURNING id`,
                [companyA, `${TAG}-invoice`, linkedJobId],
            )).rows[0];
            const estimate = (await client.query(
                `INSERT INTO estimates (company_id, estimate_number, job_id, contact_id)
                 VALUES ($1, $2, $3, NULL) RETURNING id`,
                [companyA, `${TAG}-estimate`, linkedJobId],
            )).rows[0];

            const foreignBefore = JSON.stringify((await client.query(
                `SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb) AS jobs
                 FROM jobs j WHERE j.company_id = $1`,
                [companyB],
            )).rows[0].jobs);

            const linkedJob = await jobsService.getJobById(linkedJobId, companyA);
            const orphanJob = await jobsService.getJobById(orphanJobId, companyA);
            const crossLinkedJob = await jobsService.getJobById(crossLinkedJobId, companyA);
            expect(linkedJob).toMatchObject({
                customer_email: `${TAG.toLowerCase()}-live-a@example.com`,
                customer_phone: '+16175550101',
            });
            expect(Boolean(linkedJob.customer_email)).toBe(true); // Rate Me eligibility input.
            expect(orphanJob).toMatchObject({
                customer_email: `${TAG.toLowerCase()}-legacy@example.com`,
                customer_phone: '+16175550202',
            });
            expect(crossLinkedJob).toMatchObject({
                customer_email: `${TAG.toLowerCase()}-safe-a@example.com`,
                customer_phone: '+16175550303',
            });
            expect(JSON.stringify(crossLinkedJob)).not.toContain(`${TAG} SECRET B`);
            expect(JSON.stringify(crossLinkedJob)).not.toContain(`${TAG.toLowerCase()}-secret-b@example.com`);

            const listed = await jobsService.listJobs({ companyId: companyA, limit: 20 });
            expect(listed.results.find(job => job.id === linkedJobId)).toMatchObject({
                customer_email: `${TAG.toLowerCase()}-live-a@example.com`,
                customer_phone: '+16175550101',
            });

            await expect(invoicesQueries.getInvoiceById(companyA, invoice.id, client)).resolves.toMatchObject({
                contact_email: `${TAG.toLowerCase()}-live-a@example.com`,
                contact_phone: '+16175550101',
            });
            await expect(estimatesQueries.getEstimateById(companyA, estimate.id, client)).resolves.toMatchObject({
                contact_email: `${TAG.toLowerCase()}-live-a@example.com`,
                contact_phone: '+16175550101',
            });

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
            expect(result.items.map(item => item.customer_email)).toEqual([
                `${TAG.toLowerCase()}-live-a@example.com`,
                `${TAG.toLowerCase()}-legacy@example.com`,
                `${TAG.toLowerCase()}-safe-a@example.com`,
            ]);
            expect(result.items.map(item => item.customer_phone)).toEqual([
                '+16175550101',
                '+16175550202',
                '+16175550303',
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
