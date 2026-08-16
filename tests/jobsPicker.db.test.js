'use strict';

/** ESTIMATE-REDESIGN-001 P5 — real-SQL tenancy proof for the Link Job picker. */

const { randomUUID } = require('crypto');

// dotenv first — see the note in estimatePublicTokenExpiry.db.test.js. Reading
// DATABASE_URL before `db/connection` loads it made this gate skip itself on
// every run, which is the same as not having written it.
require('dotenv').config();

const TEST_DB_URL = process.env.JOBS_PICKER_TEST_DB_URL || process.env.DATABASE_URL || '';
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;

const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');

jest.setTimeout(30000);

const TAG = `JPK-${Date.now().toString(36)}-${process.pid}`;
const databaseTest = TEST_DB_URL ? test : test.skip;

if (!TEST_DB_URL) {
    console.warn('ESTIMATE-REDESIGN-001 job-picker DB gate SKIPPED-NEEDS-JOBS_PICKER_TEST_DB_URL');
}

databaseTest('T-own/T-foreign/T-blast: picker search returns only visible company jobs and changes nothing', async () => {
    const client = await db.pool.connect();
    const originalQuery = db.query;
    const companyA = randomUUID();
    const companyB = randomUUID();
    const providerA = randomUUID();

    try {
        await client.query('BEGIN');
        db.query = (text, params) => client.query(text, params);

        // Keep the test runnable against a shared DB that trails migration 096.
        await client.query(
            `ALTER TABLE jobs
             ADD COLUMN IF NOT EXISTS assigned_provider_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb`
        );
        await client.query(
            `INSERT INTO companies (id, name, slug)
             VALUES ($1, $2, $3), ($4, $5, $6)`,
            [
                companyA, `${TAG} Company A`, `${TAG}-a`.toLowerCase(),
                companyB, `${TAG} Company B`, `${TAG}-b`.toLowerCase(),
            ]
        );
        const contacts = await client.query(
            `INSERT INTO contacts (company_id, full_name)
             VALUES ($1, $2), ($3, $4)
             RETURNING id, company_id`,
            [companyA, `${TAG} Shared Customer`, companyB, `${TAG} Foreign Secret`]
        );
        const contactA = contacts.rows.find(row => row.company_id === companyA).id;
        const contactB = contacts.rows.find(row => row.company_id === companyB).id;
        const jobs = await client.query(
            `INSERT INTO jobs
                (company_id, contact_id, job_number, service_name, address,
                 blanc_status, start_date, assigned_provider_user_ids)
             VALUES
                ($1, $2, $3, 'Repair', $4, 'Submitted', '2026-08-15T12:00:00Z', $5::jsonb),
                ($1, $2, $6, 'Install', $7, 'Submitted', '2026-08-14T12:00:00Z', '[]'::jsonb),
                ($8, $9, $3, 'Foreign repair', $4, 'Submitted', '2026-08-16T12:00:00Z', $5::jsonb)
             RETURNING id, company_id, job_number`,
            [
                companyA,
                contactA,
                `${TAG}-SHARED`,
                `${TAG} Main Street`,
                JSON.stringify([providerA]),
                `${TAG}-UNASSIGNED`,
                `${TAG} Side Street`,
                companyB,
                contactB,
            ]
        );
        const ownAssigned = jobs.rows.find(row => (
            row.company_id === companyA && row.job_number === `${TAG}-SHARED`
        ));

        const foreignBefore = JSON.stringify((await client.query(
            `SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb) AS jobs
             FROM jobs j
             WHERE j.company_id = $1`,
            [companyB]
        )).rows[0].jobs);

        const own = await jobsService.searchJobsForPicker({
            companyId: companyA,
            search: TAG,
            limit: 20,
        });
        expect(own.results.map(row => row.id).sort()).toEqual(
            jobs.rows.filter(row => row.company_id === companyA).map(row => row.id).sort()
        );
        expect(JSON.stringify(own)).not.toContain('Foreign Secret');
        expect(own.results.every(row => !Object.prototype.hasOwnProperty.call(row, 'company_id'))).toBe(true);

        const assignedOnly = await jobsService.searchJobsForPicker({
            companyId: companyA,
            search: TAG,
            limit: 20,
            providerScope: { assignedOnly: true, userId: providerA },
        });
        expect(assignedOnly.results.map(row => row.id)).toEqual([ownAssigned.id]);

        const foreignProbe = await jobsService.searchJobsForPicker({
            companyId: companyA,
            search: 'Foreign Secret',
            limit: 20,
        });
        expect(foreignProbe.results).toEqual([]);

        const foreignAfter = JSON.stringify((await client.query(
            `SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb) AS jobs
             FROM jobs j
             WHERE j.company_id = $1`,
            [companyB]
        )).rows[0].jobs);
        expect(foreignAfter).toBe(foreignBefore);
    } finally {
        db.query = originalQuery;
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
});

afterAll(async () => {
    await db.pool.end();
});
