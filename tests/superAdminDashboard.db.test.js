'use strict';

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const platformUserService = require('../backend/src/services/platformUserService');
const platformStatsService = require('../backend/src/services/platformStatsService');

jest.setTimeout(30000);

const TAG = `superadmin-dash-${Date.now()}-${process.pid}`;

async function withTxn(work) {
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

async function insertCompany(client, label, createdAt = new Date()) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, created_at)
         VALUES ($1, $2, $3, $4)`,
        [id, `${TAG} ${label}`, `${TAG}-${label}`.toLowerCase(), createdAt]
    );
    return id;
}

async function insertUser(client, label, createdAt = new Date(), lastLoginAt = null) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO crm_users (id, keycloak_sub, email, full_name, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, `${TAG}-${label}`, `${TAG}-${label}@example.test`, `${TAG} ${label}`, createdAt, lastLoginAt]
    );
    return id;
}

beforeAll(async () => {
    await db.query('SELECT 1 FROM companies, crm_users, company_memberships LIMIT 1');
});

afterAll(async () => {
    await db.pool.end();
});

describe('SUPERADMIN-DASH-BE real PostgreSQL queries', () => {
    test('SAB-SA-CROSS-TENANT · list returns one row per membership across multiple companies', async () => {
        await withTxn(async client => {
            const companyA = await insertCompany(client, 'cross-a');
            const companyB = await insertCompany(client, 'cross-b');
            const activeUser = await insertUser(
                client,
                'active',
                new Date(),
                new Date(Date.now() - 60 * 1000)
            );
            const staleUser = await insertUser(
                client,
                'stale',
                new Date(),
                new Date(Date.now() - 10 * 60 * 1000)
            );

            await client.query(
                `INSERT INTO company_memberships
                    (user_id, company_id, role, role_key, status, is_primary)
                 VALUES
                    ($1, $2, 'company_admin', 'tenant_admin', 'active', true),
                    ($1, $3, 'company_member', 'manager', 'active', false),
                    ($4, $3, 'company_member', 'dispatcher', 'active', true)`,
                [activeUser, companyA, companyB, staleUser]
            );

            const result = await platformUserService.listUsers({
                search: TAG,
                page: 1,
                limit: 25,
            });

            expect(result.total).toBe(3);
            expect(result.users).toHaveLength(3);
            expect(new Set(result.users.map(row => row.company_id)).size).toBe(2);
            expect(result.users.filter(row => row.id === activeUser)).toHaveLength(2);
            expect(result.users.map(row => row.id)).toEqual([activeUser, activeUser, staleUser]);
            expect(result.users.every(row => Object.hasOwn(row, 'last_login_at'))).toBe(true);
            expect(result.users.every(row => !Object.hasOwn(row, 'online'))).toBe(true);
        });
    });

    test('SAB-SA-STATS-TODAY · UTC today excludes yesterday and feeds the final growth bucket', async () => {
        await withTxn(async client => {
            const baseline = await platformStatsService.getStats();
            const utcToday = new Date();
            utcToday.setUTCHours(0, 0, 0, 0);
            const utcYesterday = new Date(utcToday.getTime() - 1);

            await insertCompany(client, 'stats-today', utcToday);
            await insertCompany(client, 'stats-yesterday', utcYesterday);
            await insertUser(client, 'stats-today', utcToday);
            await insertUser(client, 'stats-yesterday', utcYesterday);

            const stats = await platformStatsService.getStats();
            const expectedToday = utcToday.toISOString().slice(0, 10);
            const baselineToday = baseline.growth[baseline.growth.length - 1];
            const today = stats.growth[stats.growth.length - 1];

            expect(stats.growth).toHaveLength(30);
            expect(stats.companies.total - baseline.companies.total).toBe(2);
            expect(stats.users.total - baseline.users.total).toBe(2);
            expect(stats.companies.today - baseline.companies.today).toBe(1);
            expect(stats.users.today - baseline.users.today).toBe(1);
            expect(today.date).toBe(expectedToday);
            expect(today.companies - baselineToday.companies).toBe(1);
            expect(today.users - baselineToday.users).toBe(1);
        });
    });
});
