'use strict';

/** ESTIMATE-REDESIGN-001 P5 — real-SQL public-link lifetime and isolation. */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Load .env BEFORE deciding whether there is a database. This read used to happen
// first, and `db/connection` is what loads dotenv — so DATABASE_URL was always
// empty here and the whole gate skipped itself, silently, on every run. A test
// that skips by default is not a test; sabotaging the expiry predicate left it
// green, which is how the gap was found.
require('dotenv').config();

const TEST_DB_URL = process.env.ESTIMATE_PUBLIC_LINK_TEST_DB_URL || process.env.DATABASE_URL || '';
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;

const db = require('../backend/src/db/connection');
const estimatesQueries = require('../backend/src/db/estimatesQueries');

jest.setTimeout(30000);

const TAG = `EPT-${Date.now().toString(36)}-${process.pid}`;
const databaseTest = TEST_DB_URL ? test : test.skip;

if (!TEST_DB_URL) {
    console.warn('ESTIMATE-REDESIGN-001 token-expiry DB gate SKIPPED-NEEDS-ESTIMATE_PUBLIC_LINK_TEST_DB_URL');
}

databaseTest('T-own/T-foreign/T-blast plus expired, archived, draft, and answered read policy', async () => {
    const client = await db.pool.connect();
    const originalQuery = db.query;
    const companyA = randomUUID();
    const companyB = randomUUID();

    try {
        await client.query('BEGIN');
        db.query = (text, params) => client.query(text, params);

        const migration = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'db', 'migrations', '265_estimate_public_token_expiry.sql'),
            'utf8'
        );
        await client.query(migration);
        await client.query(
            `INSERT INTO companies (id, name, slug)
             VALUES ($1, $2, $3), ($4, $5, $6)`,
            [
                companyA, `${TAG} Company A`, `${TAG}-a`.toLowerCase(),
                companyB, `${TAG} Company B`, `${TAG}-b`.toLowerCase(),
            ]
        );

        const inserted = await client.query(
            `INSERT INTO estimates
                (company_id, estimate_number, status, public_token,
                 public_token_expires_at, valid_until, archived_at)
             VALUES
                ($1, $2, 'sent', $3, NOW() + INTERVAL '1 day', NULL, NULL),
                ($1, $4, 'approved', $5, NOW() + INTERVAL '1 day', NOW() - INTERVAL '1 year', NULL),
                ($1, $6, 'declined', $7, NOW() + INTERVAL '1 day', NULL, NULL),
                ($1, $8, 'sent', $9, NOW() - INTERVAL '1 second', NULL, NULL),
                ($1, $10, 'draft', $11, NOW() + INTERVAL '1 day', NULL, NULL),
                ($1, $12, 'sent', $13, NOW() + INTERVAL '1 day', NULL, NOW()),
                ($14, $15, 'sent', $16, NOW() + INTERVAL '1 day', NULL, NULL)
             RETURNING id, company_id, estimate_number, public_token`,
            [
                companyA,
                `${TAG}-sent`, `${TAG}_sent_token`,
                `${TAG}-approved`, `${TAG}_approved_token`,
                `${TAG}-declined`, `${TAG}_declined_token`,
                `${TAG}-expired`, `${TAG}_expired_token`,
                `${TAG}-draft`, `${TAG}_draft_token`,
                `${TAG}-archived`, `${TAG}_archived_token`,
                companyB,
                `${TAG}-foreign`, `${TAG}_foreign_token`,
            ]
        );
        const byNumber = suffix => inserted.rows.find(row => row.estimate_number === `${TAG}-${suffix}`);
        const sentA = byNumber('sent');

        const foreignBefore = JSON.stringify((await client.query(
            `SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb) AS estimates
             FROM estimates e
             WHERE e.company_id = $1`,
            [companyB]
        )).rows[0].estimates);

        await expect(estimatesQueries.getEstimateByPublicToken(`${TAG}_sent_token`, client))
            .resolves.toMatchObject({ status: 'sent', company_id: companyA });
        await expect(estimatesQueries.getEstimateByPublicToken(`${TAG}_approved_token`, client))
            .resolves.toMatchObject({ status: 'approved', company_id: companyA });
        await expect(estimatesQueries.getEstimateByPublicToken(`${TAG}_declined_token`, client))
            .resolves.toMatchObject({ status: 'declined', company_id: companyA });
        await expect(estimatesQueries.getEstimateByPublicToken(`${TAG}_expired_token`, client))
            .resolves.toBeNull();
        await expect(estimatesQueries.getEstimateByPublicToken(`${TAG}_draft_token`, client))
            .resolves.toBeNull();
        await expect(estimatesQueries.getEstimateByPublicToken(`${TAG}_archived_token`, client))
            .resolves.toBeNull();
        await expect(estimatesQueries.lockEstimateByPublicToken(
            `${TAG}_sent_token`,
            'approve',
            client
        )).resolves.toMatchObject({ status: 'sent', company_id: companyA });
        await expect(estimatesQueries.lockEstimateByPublicToken(
            `${TAG}_expired_token`,
            'approve',
            client
        )).resolves.toBeNull();
        await expect(estimatesQueries.lockEstimateByPublicToken(
            `${TAG}_declined_token`,
            'decline',
            client
        )).resolves.toBeNull();

        // A company cannot rotate another company's estimate even with its ID.
        await expect(estimatesQueries.setPublicToken(
            sentA.id,
            companyB,
            `${TAG}_forged_token`,
            client,
            18
        )).resolves.toBeNull();
        await expect(estimatesQueries.getEstimateByPublicToken(`${TAG}_sent_token`, client))
            .resolves.toMatchObject({ id: sentA.id, company_id: companyA });

        const rotatedToken = `${TAG}_rotated_token`;
        await expect(estimatesQueries.setPublicToken(
            sentA.id,
            companyA,
            rotatedToken,
            client,
            18
        )).resolves.toMatchObject({ id: sentA.id, public_token: rotatedToken });
        await expect(estimatesQueries.getEstimateByPublicToken(`${TAG}_sent_token`, client))
            .resolves.toBeNull();
        await expect(estimatesQueries.getEstimateByPublicToken(rotatedToken, client))
            .resolves.toMatchObject({ id: sentA.id, company_id: companyA });

        const expiry = (await client.query(
            `SELECT public_token_expires_at > NOW() + INTERVAL '17 months' AS sufficiently_future
             FROM estimates
             WHERE id = $1 AND company_id = $2`,
            [sentA.id, companyA]
        )).rows[0];
        expect(expiry.sufficiently_future).toBe(true);

        const foreignAfter = JSON.stringify((await client.query(
            `SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb) AS estimates
             FROM estimates e
             WHERE e.company_id = $1`,
            [companyB]
        )).rows[0].estimates);
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
