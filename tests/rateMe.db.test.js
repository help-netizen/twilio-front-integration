'use strict';

/**
 * RATE-ME-CRM-001 T1 — real-PostgreSQL migration/query coverage.
 *
 * SELF-SKIPS database legs when PostgreSQL is unavailable. Structural halves
 * always run, and committed fixtures have tagged afterAll cleanup fallbacks.
 */

const fs = require('fs');
const path = require('path');
const { randomBytes, randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const rateMeQueries = require('../backend/src/db/rateMeQueries');

jest.setTimeout(30000);

const TAG = `RM-${Date.now()}-${process.pid}`;
const MIGRATIONS_DIR = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const MIGRATION_FILE = '177_rate_me.sql';
const ROLLBACK_FILE = 'rollback_177_rate_me.sql';
const QUERY_FILE = path.join(__dirname, '..', 'backend', 'src', 'db', 'rateMeQueries.js');

const fixtureCompanyIds = new Set();
let dbReady = false;

function readMigration(filename) {
    return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

function fixtureSlug(label) {
    return `${TAG}-${label}`.toLowerCase();
}

function fixtureDomain(label) {
    return `${label}-${TAG}`.toLowerCase() + '.example.com';
}

function fixtureToken() {
    return randomBytes(24).toString('base64url');
}

function skipNeedsDb(testCase) {
    console.warn(`${testCase} SKIPPED-NEEDS-DB`);
}

async function captureError(work) {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error('Expected database operation to fail');
}

async function withTxn(work) {
    const client = await db.pool.connect();
    let began = false;
    try {
        await client.query('BEGIN');
        began = true;
        return await work(client);
    } finally {
        try {
            if (began) await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
}

async function insertCompany(queryable, label) {
    const companyId = randomUUID();
    fixtureCompanyIds.add(companyId);
    await queryable.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3)`,
        [companyId, `Rate Me ${TAG} ${label}`, fixtureSlug(label)]
    );
    return companyId;
}

async function cleanupFixtures() {
    const companyIds = [...fixtureCompanyIds];
    if (companyIds.length === 0) return;

    await db.query(
        `DELETE FROM jobs
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM companies
         WHERE id = ANY($1::uuid[])`,
        [companyIds]
    );
}

beforeAll(async () => {
    try {
        await db.query('SELECT 1 FROM companies LIMIT 1');
        const migration = readMigration(MIGRATION_FILE);
        await db.query(migration);
        await db.query(migration);
        dbReady = true;
    } catch (error) {
        console.warn('\n[rateMe.db] SKIPPED-NEEDS-DB —', error.message, '\n');
        dbReady = false;
    }
});

afterAll(async () => {
    if (dbReady) {
        try {
            await cleanupFixtures();
        } catch (error) {
            console.warn('[rateMe.db] cleanup failed:', error.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('RATE-ME-CRM-001 migration 177 · real PostgreSQL', () => {
    test('TC-T10-DB-01 · objects, double-apply, seed upsert, checks, and trigger', async () => {
        const migration = readMigration(MIGRATION_FILE);
        expect(path.basename(path.join(MIGRATIONS_DIR, MIGRATION_FILE))).toBe('177_rate_me.sql');
        expect(migration).toMatch(/Migration 177/);

        if (!dbReady) return skipNeedsDb('TC-T10-DB-01');

        const objects = await db.query(
            `SELECT to_regclass('public.rate_tokens') IS NOT NULL AS rate_tokens,
                    to_regclass('public.technician_ratings') IS NOT NULL AS technician_ratings,
                    to_regclass('public.rate_me_domains') IS NOT NULL AS rate_me_domains`
        );
        expect(objects.rows[0]).toEqual({
            rate_tokens: true,
            technician_ratings: true,
            rate_me_domains: true,
        });

        const columnsResult = await db.query(
            `SELECT table_name, column_name, data_type, udt_name, is_nullable
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = ANY($1::text[])`,
            [['rate_tokens', 'technician_ratings', 'rate_me_domains']]
        );
        const columns = new Map(
            columnsResult.rows.map(row => [`${row.table_name}.${row.column_name}`, row])
        );
        expect(columns.get('rate_tokens.job_id')).toMatchObject({ udt_name: 'int8', is_nullable: 'YES' });
        expect(columns.get('rate_tokens.tech_id')).toMatchObject({ udt_name: 'text', is_nullable: 'NO' });
        expect(columns.get('rate_tokens.expires_at')).toMatchObject({
            data_type: 'timestamp with time zone',
            is_nullable: 'YES',
        });
        expect(columns.get('rate_tokens.used_at')).toMatchObject({
            data_type: 'timestamp with time zone',
            is_nullable: 'YES',
        });
        expect(columns.get('technician_ratings.rate_token_id')).toMatchObject({
            udt_name: 'int8',
            is_nullable: 'NO',
        });
        expect(columns.get('technician_ratings.stars')).toMatchObject({ udt_name: 'int2' });

        const constraintsResult = await db.query(
            `SELECT c.relname AS table_name,
                    pc.contype,
                    pg_get_constraintdef(pc.oid) AS definition
             FROM pg_constraint pc
             JOIN pg_class c ON c.oid = pc.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relname = ANY($1::text[])`,
            [['rate_tokens', 'technician_ratings', 'rate_me_domains']]
        );
        const constraintsFor = table => constraintsResult.rows
            .filter(row => row.table_name === table)
            .map(row => row.definition);
        expect(constraintsFor('rate_tokens')).toContain('UNIQUE (token)');
        expect(constraintsFor('technician_ratings')).toContain('UNIQUE (rate_token_id)');
        expect(constraintsFor('rate_me_domains')).toEqual(expect.arrayContaining([
            'UNIQUE (company_id)',
            'UNIQUE (domain)',
        ]));
        expect(constraintsFor('technician_ratings').join(' ')).toMatch(/stars.*1.*5/i);
        const domainChecks = constraintsFor('rate_me_domains').join(' ');
        for (const status of ['pending', 'verified', 'active', 'failed']) {
            expect(domainChecks).toContain(status);
        }

        const indexes = await db.query(
            `SELECT indexname, indexdef
             FROM pg_indexes
             WHERE schemaname = 'public'
               AND indexname = ANY($1::text[])`,
            [[
                'idx_rate_tokens_company',
                'idx_technician_ratings_company_tech',
            ]]
        );
        expect(indexes.rows.map(row => row.indexname).sort()).toEqual([
            'idx_rate_tokens_company',
            'idx_technician_ratings_company_tech',
        ]);

        const trigger = await db.query(
            `SELECT tgname, pg_get_triggerdef(oid) AS definition
             FROM pg_trigger
             WHERE tgrelid = 'public.rate_me_domains'::regclass
               AND NOT tgisinternal
               AND tgname = 'trg_rate_me_domains_updated_at'`
        );
        expect(trigger.rows).toHaveLength(1);
        expect(trigger.rows[0].definition).toContain('update_updated_at_column');

        const seed = await db.query(
            `SELECT name, provider_name, app_type, provisioning_mode, status,
                    requested_scopes, metadata
             FROM marketplace_apps
             WHERE app_key = 'rate-me'`
        );
        expect(seed.rows[0]).toMatchObject({
            name: 'Rate Me',
            provider_name: 'Albusto',
            app_type: 'internal',
            provisioning_mode: 'none',
            status: 'published',
            requested_scopes: [],
        });
        expect(seed.rows[0].metadata.requires_credential_input).toBe(false);

        await withTxn(async client => {
            await client.query(
                `UPDATE marketplace_apps
                 SET name = 'X'
                 WHERE app_key = 'rate-me'`
            );
            await client.query(migration);
            const restored = await client.query(
                `SELECT name
                 FROM marketplace_apps
                 WHERE app_key = 'rate-me'`
            );
            expect(restored.rows[0].name).toBe('Rate Me');

            const companyId = await insertCompany(client, 'objects');
            const tokenResult = await client.query(
                `INSERT INTO rate_tokens (company_id, token, tech_id)
                 VALUES ($1, $2, 'zb-objects')
                 RETURNING id`,
                [companyId, fixtureToken()]
            );
            await client.query(
                `INSERT INTO rate_me_domains (company_id, domain, updated_at)
                 VALUES ($1, $2, '2020-01-01T00:00:00.000Z')`,
                [companyId, fixtureDomain('objects')]
            );
            await client.query(
                `UPDATE rate_me_domains
                 SET status = 'verified'
                 WHERE company_id = $1`,
                [companyId]
            );
            const updatedDomain = await client.query(
                `SELECT updated_at
                 FROM rate_me_domains
                 WHERE company_id = $1`,
                [companyId]
            );
            expect(updatedDomain.rows[0].updated_at.getTime())
                .toBeGreaterThan(new Date('2020-01-01T00:00:00.000Z').getTime());

            const checkError = await captureError(() => client.query(
                `INSERT INTO technician_ratings
                    (company_id, rate_token_id, tech_id, stars)
                 VALUES ($1, $2, 'zb-objects', 6)`,
                [companyId, tokenResult.rows[0].id]
            ));
            expect(checkError.code).toBe('23514');
        });
    });

    test('TC-T10-DB-02 · job SET NULL and company CASCADE behavior', async () => {
        if (!dbReady) return skipNeedsDb('TC-T10-DB-02');

        await withTxn(async client => {
            const companyA = await insertCompany(client, 'fk-job');
            const jobA = await client.query(
                `INSERT INTO jobs (company_id, zenbooker_job_id)
                 VALUES ($1, $2)
                 RETURNING id`,
                [companyA, `${TAG}-fk-job`]
            );
            const tokenA = await client.query(
                `INSERT INTO rate_tokens
                    (company_id, token, job_id, tech_id, tech_name)
                 VALUES ($1, $2, $3, 'zb-fk', 'Alex Snapshot')
                 RETURNING id`,
                [companyA, fixtureToken(), jobA.rows[0].id]
            );
            await client.query(
                `INSERT INTO technician_ratings
                    (company_id, rate_token_id, job_id, tech_id, stars)
                 VALUES ($1, $2, $3, 'zb-fk', 5)`,
                [companyA, tokenA.rows[0].id, jobA.rows[0].id]
            );

            await client.query('DELETE FROM jobs WHERE id = $1', [jobA.rows[0].id]);
            const survivors = await client.query(
                `SELECT t.job_id AS token_job_id, t.tech_name,
                        r.job_id AS rating_job_id
                 FROM rate_tokens t
                 JOIN technician_ratings r ON r.rate_token_id = t.id
                 WHERE t.id = $1
                   AND t.company_id = $2`,
                [tokenA.rows[0].id, companyA]
            );
            expect(survivors.rows[0]).toMatchObject({
                token_job_id: null,
                rating_job_id: null,
                tech_name: 'Alex Snapshot',
            });

            const companyB = await insertCompany(client, 'fk-company');
            const jobB = await client.query(
                `INSERT INTO jobs (company_id, zenbooker_job_id)
                 VALUES ($1, $2)
                 RETURNING id`,
                [companyB, `${TAG}-fk-company`]
            );
            const tokenB = await client.query(
                `INSERT INTO rate_tokens
                    (company_id, token, job_id, tech_id, tech_name)
                 VALUES ($1, $2, $3, 'zb-cascade', 'Cascade Snapshot')
                 RETURNING id`,
                [companyB, fixtureToken(), jobB.rows[0].id]
            );
            await client.query(
                `INSERT INTO technician_ratings
                    (company_id, rate_token_id, job_id, tech_id, stars)
                 VALUES ($1, $2, $3, 'zb-cascade', 4)`,
                [companyB, tokenB.rows[0].id, jobB.rows[0].id]
            );
            await client.query(
                `INSERT INTO rate_me_domains (company_id, domain)
                 VALUES ($1, $2)`,
                [companyB, fixtureDomain('fk-company')]
            );

            await client.query('DELETE FROM companies WHERE id = $1', [companyB]);
            const remaining = await client.query(
                `SELECT
                    (SELECT COUNT(*)::int FROM rate_tokens WHERE company_id = $1)
                        AS rate_tokens,
                    (SELECT COUNT(*)::int FROM technician_ratings WHERE company_id = $1)
                        AS technician_ratings,
                    (SELECT COUNT(*)::int FROM rate_me_domains WHERE company_id = $1)
                        AS rate_me_domains`,
                [companyB]
            );
            expect(remaining.rows[0]).toEqual({
                rate_tokens: 0,
                technician_ratings: 0,
                rate_me_domains: 0,
            });
        });
    });

    test('TC-T10-DB-03 · rollback order, app removal, and re-apply', async () => {
        const rollback = readMigration(ROLLBACK_FILE);
        const ratingsDrop = rollback.indexOf('DROP TABLE IF EXISTS technician_ratings');
        const tokensDrop = rollback.indexOf('DROP TABLE IF EXISTS rate_tokens');
        const domainsDrop = rollback.indexOf('DROP TABLE IF EXISTS rate_me_domains');
        const appDelete = rollback.indexOf("DELETE FROM marketplace_apps WHERE app_key = 'rate-me'");
        expect(ratingsDrop).toBeGreaterThanOrEqual(0);
        expect(ratingsDrop).toBeLessThan(tokensDrop);
        expect(tokensDrop).toBeLessThan(domainsDrop);
        expect(domainsDrop).toBeLessThan(appDelete);

        if (!dbReady) return skipNeedsDb('TC-T10-DB-03');

        await withTxn(async client => {
            await client.query(
                `DELETE FROM marketplace_installations
                 WHERE app_id = (
                    SELECT id FROM marketplace_apps WHERE app_key = 'rate-me'
                 )`
            );
            await client.query(rollback);

            const absentObjects = await client.query(
                `SELECT to_regclass('public.rate_tokens') IS NOT NULL AS rate_tokens,
                        to_regclass('public.technician_ratings') IS NOT NULL AS technician_ratings,
                        to_regclass('public.rate_me_domains') IS NOT NULL AS rate_me_domains`
            );
            expect(absentObjects.rows[0]).toEqual({
                rate_tokens: false,
                technician_ratings: false,
                rate_me_domains: false,
            });
            const absentApp = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM marketplace_apps
                 WHERE app_key = 'rate-me'`
            );
            expect(absentApp.rows[0].count).toBe(0);

            await client.query(readMigration(MIGRATION_FILE));
            const restoredObjects = await client.query(
                `SELECT to_regclass('public.rate_tokens') IS NOT NULL AS rate_tokens,
                        to_regclass('public.technician_ratings') IS NOT NULL AS technician_ratings,
                        to_regclass('public.rate_me_domains') IS NOT NULL AS rate_me_domains`
            );
            expect(restoredObjects.rows[0]).toEqual({
                rate_tokens: true,
                technician_ratings: true,
                rate_me_domains: true,
            });
            const restoredApp = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM marketplace_apps
                 WHERE app_key = 'rate-me'`
            );
            expect(restoredApp.rows[0].count).toBe(1);
        });
    });
});

describe('RATE-ME-CRM-001 rating/domain query anchors · real PostgreSQL', () => {
    test('TC-T8-DB-01 · one rating per token and used stamp idempotency', async () => {
        const source = fs.readFileSync(QUERY_FILE, 'utf8');
        expect(source).toMatch(/ON CONFLICT \(rate_token_id\) DO NOTHING/);
        expect(source).toMatch(/used_at IS NULL/);

        if (!dbReady) return skipNeedsDb('TC-T8-DB-01');

        await withTxn(async client => {
            const companyId = await insertCompany(client, 'rating-anchor');
            const token = await client.query(
                `INSERT INTO rate_tokens
                    (company_id, token, tech_id, tech_name)
                 VALUES ($1, $2, 'zb-rating', 'Rating Snapshot')
                 RETURNING id`,
                [companyId, fixtureToken()]
            );
            const payload = {
                companyId,
                rateTokenId: token.rows[0].id,
                jobId: null,
                techId: 'zb-rating',
                stars: 5,
                feedback: 'excellent',
            };

            const first = await rateMeQueries.insertRating(payload, client);
            expect(first.id).toBeDefined();
            const beforeConflict = await client.query(
                `SELECT to_jsonb(r) AS snapshot
                 FROM technician_ratings r
                 WHERE rate_token_id = $1`,
                [token.rows[0].id]
            );

            const second = await rateMeQueries.insertRating({
                ...payload,
                stars: 1,
                feedback: 'overwrite attempt',
            }, client);
            expect(second).toBeUndefined();
            const afterConflict = await client.query(
                `SELECT to_jsonb(r) AS snapshot
                 FROM technician_ratings r
                 WHERE rate_token_id = $1`,
                [token.rows[0].id]
            );
            expect(afterConflict.rows[0].snapshot).toEqual(beforeConflict.rows[0].snapshot);

            const firstStamp = await rateMeQueries.stampTokenUsed(token.rows[0].id, client);
            expect(firstStamp.used_at).not.toBeNull();
            const secondStamp = await rateMeQueries.stampTokenUsed(token.rows[0].id, client);
            expect(secondStamp).toBeUndefined();
            const stamped = await client.query(
                `SELECT used_at
                 FROM rate_tokens
                 WHERE id = $1`,
                [token.rows[0].id]
            );
            expect(stamped.rows[0].used_at.getTime()).toBe(firstStamp.used_at.getTime());

            const uniqueError = await captureError(() => client.query(
                `INSERT INTO technician_ratings
                    (company_id, rate_token_id, tech_id, stars)
                 VALUES ($1, $2, 'zb-rating', 3)`,
                [companyId, token.rows[0].id]
            ));
            expect(uniqueError.code).toBe('23505');
        });
    });

    test('TC-D5-DB-01 · domain uniqueness, in-place reset, and serving statuses', async () => {
        const source = fs.readFileSync(QUERY_FILE, 'utf8');
        expect(source).toMatch(/status IN \('verified',\s*'active'\)/);

        if (!dbReady) return skipNeedsDb('TC-D5-DB-01');

        const companyA = await insertCompany(db, 'domain-a');
        const companyB = await insertCompany(db, 'domain-b');
        const domainA = fixtureDomain('domain-a');
        const domainB = fixtureDomain('domain-b');

        try {
            const original = await db.query(
                `INSERT INTO rate_me_domains (company_id, domain)
                 VALUES ($1, $2)
                 RETURNING id`,
                [companyA, domainA]
            );

            const domainUniqueError = await captureError(() => db.query(
                `INSERT INTO rate_me_domains (company_id, domain)
                 VALUES ($1, $2)`,
                [companyB, domainA]
            ));
            expect(domainUniqueError.code).toBe('23505');

            const companyUniqueError = await captureError(() => db.query(
                `INSERT INTO rate_me_domains (company_id, domain)
                 VALUES ($1, $2)`,
                [companyA, fixtureDomain('domain-second')]
            ));
            expect(companyUniqueError.code).toBe('23505');

            await db.query(
                `UPDATE rate_me_domains
                 SET status = 'active',
                     verified_at = NOW(),
                     activated_at = NOW(),
                     last_checked_at = NOW(),
                     last_error = 'old error'
                 WHERE company_id = $1`,
                [companyA]
            );
            const replacement = await rateMeQueries.upsertDomainForCompany(companyA, domainB);
            expect(replacement).toMatchObject({
                domain: domainB,
                status: 'pending',
                verified_at: null,
                activated_at: null,
                last_checked_at: null,
                last_error: null,
            });
            const replacedRow = await db.query(
                `SELECT id
                 FROM rate_me_domains
                 WHERE company_id = $1`,
                [companyA]
            );
            expect(replacedRow.rows[0].id).toBe(original.rows[0].id);

            expect(await rateMeQueries.getServableDomain(domainB)).toBeUndefined();
            await db.query(
                `UPDATE rate_me_domains SET status = 'verified'
                 WHERE company_id = $1`,
                [companyA]
            );
            expect(await rateMeQueries.getServableDomain(domainB)).toMatchObject({
                company_id: companyA,
                domain: domainB,
                status: 'verified',
            });
            await db.query(
                `UPDATE rate_me_domains SET status = 'active'
                 WHERE company_id = $1`,
                [companyA]
            );
            expect((await rateMeQueries.getServableDomain(domainB)).status).toBe('active');
            await db.query(
                `UPDATE rate_me_domains SET status = 'failed'
                 WHERE company_id = $1`,
                [companyA]
            );
            expect(await rateMeQueries.getServableDomain(domainB)).toBeUndefined();
        } finally {
            await db.query(
                `DELETE FROM companies
                 WHERE id = ANY($1::uuid[])`,
                [[companyA, companyB]]
            );
        }
    });
});

describe('RATE-ME-CRM-001 real-SQL isolation', () => {
    test('TC-ISO-DB-01 · host bind, expiry, rating truth, and profile COALESCE', async () => {
        const source = fs.readFileSync(QUERY_FILE, 'utf8');
        expect(source).toMatch(/\$2::uuid IS NULL OR t\.company_id = \$2/);
        expect(source).toMatch(/expires_at IS NULL OR t\.expires_at > NOW\(\)/);
        expect(source).toMatch(/LEFT JOIN technician_ratings\s+r ON r\.rate_token_id = t\.id/);

        if (!dbReady) return skipNeedsDb('TC-ISO-DB-01');

        const companyA = await insertCompany(db, 'iso-a');
        const companyB = await insertCompany(db, 'iso-b');
        const tokenA = fixtureToken();
        const expiredToken = fixtureToken();
        const ratedToken = fixtureToken();

        try {
            await db.query(
                `INSERT INTO technician_profiles (company_id, tech_id, name)
                 VALUES ($1, 'zb-profile', 'Alexander P.')`,
                [companyA]
            );
            await db.query(
                `INSERT INTO rate_tokens
                    (company_id, token, tech_id, tech_name)
                 VALUES ($1, $2, 'zb-profile', 'Alex Petrov')`,
                [companyA, tokenA]
            );
            await db.query(
                `INSERT INTO rate_tokens
                    (company_id, token, tech_id, tech_name, expires_at)
                 VALUES ($1, $2, 'zb-expired', 'Expired Tech', NOW() - INTERVAL '1 hour')`,
                [companyA, expiredToken]
            );
            const rated = await db.query(
                `INSERT INTO rate_tokens
                    (company_id, token, tech_id, tech_name)
                 VALUES ($1, $2, 'zb-rated', 'Rated Tech')
                 RETURNING id`,
                [companyA, ratedToken]
            );
            await db.query(
                `INSERT INTO technician_ratings
                    (company_id, rate_token_id, tech_id, stars)
                 VALUES ($1, $2, 'zb-rated', 5)`,
                [companyA, rated.rows[0].id]
            );

            const shared = await rateMeQueries.getTokenContext(tokenA, null);
            expect(shared).toMatchObject({
                company_id: companyA,
                technician_name: 'Alexander P.',
                already_rated: false,
            });
            expect(await rateMeQueries.getTokenContext(tokenA, companyA)).toMatchObject({
                company_id: companyA,
            });
            expect(await rateMeQueries.getTokenContext(tokenA, companyB)).toBeUndefined();
            expect(await rateMeQueries.getTokenContext(expiredToken, null)).toBeUndefined();

            const ratedContext = await rateMeQueries.getTokenContext(ratedToken, null);
            expect(ratedContext).toMatchObject({
                already_rated: true,
                used_at: null,
            });
        } finally {
            await db.query(
                `DELETE FROM companies
                 WHERE id = ANY($1::uuid[])`,
                [[companyA, companyB]]
            );
        }
    });
});
