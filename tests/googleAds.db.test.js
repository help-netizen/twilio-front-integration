'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const googleAdsQueries = require('../backend/src/db/googleAdsQueries');
const connectionService = require('../backend/src/services/googleAdsConnectionService');
const syncService = require('../backend/src/services/googleAdsSyncService');
const bootstrap = require('../backend/src/cli/bootstrapGoogleAds');

jest.setTimeout(120000);

const MIGRATION = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/214_google_ads_connector.sql'),
    'utf8'
);
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const TAG = `google-ads-${Date.now()}-${process.pid}`;
const SHARED_CUSTOMER = '1234567890';
const SHARED_CAMPAIGN = '998877';
const SHARED_DATE = '2026-07-27';
const NOW = new Date('2026-07-27T16:00:00.000Z');

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            connectionTimeoutMillis: 2000,
        });
        (async () => {
            try {
                await client.connect();
                await client.query('SELECT 1');
                await client.end();
                process.exit(0);
            } catch (error) {
                process.stderr.write(String(error.message || error));
                try { await client.end(); } catch {}
                process.exit(2);
            }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return {
        ready: result.status === 0,
        reason: String(
            result.stderr || result.error?.message || `probe exit ${result.status}`
        ).trim(),
    };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('GOOGLE-ADS DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`Google Ads DB tests are pending: ${DATABASE.reason}`);
    });
}

function accountAdapter() {
    return {
        fetchAccountMetadata: jest.fn().mockResolvedValue({
            currency_code: 'USD',
            account_timezone: 'America/New_York',
        }),
    };
}

function performanceRow({
    date = SHARED_DATE,
    costMicros = '1000000',
    campaignId = SHARED_CAMPAIGN,
} = {}) {
    return {
        external_campaign_id: campaignId,
        external_campaign_name: 'Shared Campaign Label',
        performance_date: date,
        cost_micros: costMicros,
        impressions: '100',
        clicks: '10',
        conversions: '2',
        conversions_value: '250',
    };
}

function syncAdapter(implementation = null) {
    return {
        refreshAccessToken: jest.fn().mockResolvedValue('access-private'),
        fetchCampaignPerformance: jest.fn().mockImplementation(
            implementation || (async ({ endDate }) => [
                performanceRow({ date: endDate }),
            ])
        ),
    };
}

async function connect(companyId, customerId = SHARED_CUSTOMER) {
    return connectionService.connectCompany({
        companyId,
        customerId,
        refreshToken: `refresh-${companyId}`,
        actorId: null,
    }, { adapter: accountAdapter() });
}

async function rawConnection(companyId) {
    const { rows } = await db.query(
        `SELECT *
         FROM google_ads_connections
         WHERE company_id = $1`,
        [companyId]
    );
    return rows[0] || null;
}

async function performanceSnapshot(companyId) {
    const { rows } = await db.query(
        `SELECT COALESCE(
            JSONB_AGG(TO_JSONB(performance) ORDER BY performance.id),
            '[]'::JSONB
         ) AS snapshot
         FROM lead_source_performance_daily performance
         WHERE performance.company_id = $1`,
        [companyId]
    );
    return JSON.stringify(rows[0].snapshot);
}

function pgDateString(value) {
    if (!(value instanceof Date)) return String(value).slice(0, 10);
    return [
        value.getFullYear(),
        String(value.getMonth() + 1).padStart(2, '0'),
        String(value.getDate()).padStart(2, '0'),
    ].join('-');
}

async function clearConnectorFixtures() {
    await db.query(
        `DELETE FROM lead_source_performance_daily
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM google_ads_connections
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM lead_source_channels
         WHERE company_id IN ($1, $2)
           AND channel_key = 'google_ads'`,
        [COMPANY_A, COMPANY_B]
    );
}

let savedEnv;

beforeAll(async () => {
    if (!DATABASE.ready) return;
    savedEnv = {
        GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID,
        GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET,
        GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        GOOGLE_ADS_TOKEN_ENCRYPTION_KEY: process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY,
    };
    process.env.GOOGLE_ADS_CLIENT_ID = 'oauth-client';
    process.env.GOOGLE_ADS_CLIENT_SECRET = 'oauth-secret';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'developer-secret';
    process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY = 'd'.repeat(64);

    await db.query(MIGRATION);
    await db.query(
        `INSERT INTO companies (id, name, slug, timezone)
         VALUES
            ($1, $2, $3, 'America/New_York'),
            ($4, $5, $6, 'America/New_York')`,
        [
            COMPANY_A,
            `${TAG} Company A`,
            `${TAG}-a`,
            COMPANY_B,
            `${TAG} Company B`,
            `${TAG}-b`,
        ]
    );
});

beforeEach(async () => {
    if (!DATABASE.ready) return;
    await clearConnectorFixtures();
});

afterAll(async () => {
    if (!DATABASE.ready) return;
    await db.query(
        `DELETE FROM companies
         WHERE id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('Google Ads real-PostgreSQL lifecycle and tenancy', () => {
    databaseTest('bootstrap is idempotent, validates before persistence, and creates the channel only on connect', async () => {
        const before = await db.query(
            `SELECT COUNT(*)::INT AS count
             FROM lead_source_channels
             WHERE company_id = $1
               AND channel_key = 'google_ads'`,
            [COMPANY_A]
        );
        expect(before.rows[0].count).toBe(0);

        const adapter = accountAdapter();
        const service = {
            connectCompany: args => connectionService.connectCompany(
                args,
                { adapter }
            ),
        };
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const environment = {
            GOOGLE_ADS_BOOTSTRAP_COMPANY_ID: COMPANY_A,
            GOOGLE_ADS_BOOTSTRAP_CUSTOMER_ID: '123-456-7890',
            GOOGLE_ADS_BOOTSTRAP_REFRESH_TOKEN: 'bootstrap-refresh-private',
        };
        try {
            await bootstrap.run(environment, { service });
            await bootstrap.run(environment, { service });
        } finally {
            log.mockRestore();
        }

        const connection = await rawConnection(COMPANY_A);
        expect(connection).toMatchObject({
            customer_id: SHARED_CUSTOMER,
            status: 'connected',
            last_sync_status: 'pending',
            currency_code: 'USD',
            account_timezone: 'America/New_York',
        });
        expect(connection.refresh_token_encrypted).toMatch(/^v1:/);
        expect(connection.refresh_token_encrypted)
            .not.toContain('bootstrap-refresh-private');

        const counts = await db.query(
            `SELECT
                (SELECT COUNT(*)::INT
                 FROM google_ads_connections
                 WHERE company_id = $1) AS connections,
                (SELECT COUNT(*)::INT
                 FROM lead_source_channels
                 WHERE company_id = $1
                   AND channel_key = 'google_ads') AS channels`,
            [COMPANY_A]
        );
        expect(counts.rows[0]).toEqual({ connections: 1, channels: 1 });
        expect(adapter.fetchAccountMetadata).toHaveBeenCalledTimes(2);
    });

    databaseTest('same-customer reconnect replaces token; different-customer rejects before provider', async () => {
        await connect(COMPANY_A);
        const oldCiphertext = (await rawConnection(COMPANY_A))
            .refresh_token_encrypted;

        await connectionService.connectCompany({
            companyId: COMPANY_A,
            customerId: SHARED_CUSTOMER,
            refreshToken: 'replacement-refresh-private',
            actorId: null,
        }, { adapter: accountAdapter() });
        const replaced = await rawConnection(COMPANY_A);
        expect(replaced.refresh_token_encrypted).not.toBe(oldCiphertext);
        expect(replaced.refresh_token_encrypted)
            .not.toContain('replacement-refresh-private');
        expect(replaced.synced_through_date).toBeNull();
        expect(replaced.last_sync_status).toBe('pending');

        const adapter = accountAdapter();
        await expect(connectionService.connectCompany({
            companyId: COMPANY_A,
            customerId: '9999999999',
            refreshToken: 'different-private',
            actorId: null,
        }, { adapter })).rejects.toMatchObject({
            code: 'CUSTOMER_MISMATCH',
        });
        expect(adapter.fetchAccountMetadata).not.toHaveBeenCalled();
        expect((await rawConnection(COMPANY_A)).customer_id)
            .toBe(SHARED_CUSTOMER);
    });

    databaseTest('disconnect nulls token and retains spend rows', async () => {
        await connect(COMPANY_A);
        const connection = await rawConnection(COMPANY_A);
        await db.query(
            `INSERT INTO lead_source_performance_daily (
                company_id,
                external_account_id,
                external_campaign_id,
                external_campaign_name,
                channel_id,
                performance_date,
                cost_micros
             )
             VALUES ($1, $2, $3, 'Shared Campaign Label', $4, $5, 1000000)`,
            [
                COMPANY_A,
                SHARED_CUSTOMER,
                SHARED_CAMPAIGN,
                connection.channel_id,
                SHARED_DATE,
            ]
        );
        const beforeSpend = await performanceSnapshot(COMPANY_A);

        await expect(connectionService.disconnectCompany(COMPANY_A))
            .resolves.toEqual({ status: 'disconnected' });

        const disconnected = await rawConnection(COMPANY_A);
        expect(disconnected.status).toBe('disconnected');
        expect(disconnected.refresh_token_encrypted).toBeNull();
        expect(await performanceSnapshot(COMPANY_A)).toBe(beforeSpend);
    });

    databaseTest('SAB-GADS-CONNECTION-COMPANY: T-foreign fails closed before provider call', async () => {
        await connect(COMPANY_B);
        const bConnection = await rawConnection(COMPANY_B);
        const adapter = syncAdapter();

        await expect(syncService.syncCompany(
            COMPANY_A,
            bConnection.id,
            { adapter, now: () => NOW }
        )).resolves.toEqual({ status: 'skipped' });
        expect(adapter.refreshAccessToken).not.toHaveBeenCalled();
        expect(adapter.fetchCampaignPerformance).not.toHaveBeenCalled();
        expect((await rawConnection(COMPANY_B)).last_sync_status)
            .toBe('pending');
    });

    databaseTest('SAB-GADS-PERFORMANCE-COMPANY: T-blast shared account/campaign/date leaves B byte-unchanged', async () => {
        await connect(COMPANY_A);
        await connect(COMPANY_B);
        const aConnection = await rawConnection(COMPANY_A);
        const bConnection = await rawConnection(COMPANY_B);
        await db.query(
            `UPDATE google_ads_connections
             SET synced_from_date = '2026-06-28',
                 synced_through_date = '2026-07-26',
                 last_sync_status = 'ok'
             WHERE company_id = $1`,
            [COMPANY_A]
        );
        await db.query(
            `INSERT INTO lead_source_performance_daily (
                company_id,
                external_account_id,
                external_campaign_id,
                external_campaign_name,
                channel_id,
                performance_date,
                cost_micros,
                impressions,
                clicks,
                conversions,
                conversions_value
             )
             VALUES (
                $1, $2, $3, 'Shared Campaign Label', $4, $5,
                9999999, 999, 99, 9, 999
             )`,
            [
                COMPANY_B,
                SHARED_CUSTOMER,
                SHARED_CAMPAIGN,
                bConnection.channel_id,
                SHARED_DATE,
            ]
        );
        const beforeB = await performanceSnapshot(COMPANY_B);
        const adapter = syncAdapter(async () => [
            performanceRow({ costMicros: '2222222' }),
        ]);

        await expect(syncService.syncCompany(
            COMPANY_A,
            aConnection.id,
            { adapter, now: () => NOW }
        )).resolves.toMatchObject({ status: 'ok', ranges: 1 });

        expect(await performanceSnapshot(COMPANY_B)).toBe(beforeB);
        const own = await db.query(
            `SELECT cost_micros::TEXT AS cost_micros
             FROM lead_source_performance_daily
             WHERE company_id = $1
               AND external_account_id = $2
               AND external_campaign_id = $3
               AND performance_date = $4::DATE`,
            [COMPANY_A, SHARED_CUSTOMER, SHARED_CAMPAIGN, SHARED_DATE]
        );
        expect(own.rows[0].cost_micros).toBe('2222222');
    });
});

describe('Google Ads real-PostgreSQL synchronization', () => {
    databaseTest('T-own: connect, backfill 731 days in chunks, and read only masked status', async () => {
        await connect(COMPANY_A);
        const connection = await rawConnection(COMPANY_A);
        const adapter = syncAdapter();

        await expect(syncService.syncCompany(
            COMPANY_A,
            connection.id,
            { adapter, now: () => NOW }
        )).resolves.toEqual({
            status: 'ok',
            ranges: 25,
            rows: 25,
        });

        const synced = await rawConnection(COMPANY_A);
        expect(pgDateString(synced.synced_from_date)).toBe('2024-07-27');
        expect(pgDateString(synced.synced_through_date)).toBe('2026-07-27');
        expect(synced.last_sync_status).toBe('ok');
        expect(synced.sync_lease_expires_at).toBeNull();
        expect(adapter.fetchCampaignPerformance).toHaveBeenCalledTimes(25);
        await expect(connectionService.getConnectionStatus(COMPANY_A))
            .resolves.toMatchObject({
                connected: true,
                customer_id_masked: '7890',
                synced_from_date: expect.anything(),
                synced_through_date: expect.anything(),
                last_sync_status: 'ok',
            });
        expect(JSON.stringify(await connectionService.getConnectionStatus(COMPANY_A)))
            .not.toContain(SHARED_CUSTOMER);
    });

    databaseTest('rolling 30-day sync is idempotent and updates the natural-key row', async () => {
        await connect(COMPANY_A);
        const connection = await rawConnection(COMPANY_A);
        await db.query(
            `UPDATE google_ads_connections
             SET synced_from_date = '2024-07-27',
                 synced_through_date = '2026-07-26',
                 last_sync_status = 'ok'
             WHERE company_id = $1`,
            [COMPANY_A]
        );
        const adapter = syncAdapter(async () => [
            performanceRow({ costMicros: '1000000' }),
        ]);
        await syncService.syncCompany(
            COMPANY_A,
            connection.id,
            { adapter, now: () => NOW }
        );
        adapter.fetchCampaignPerformance.mockImplementation(async () => [
            performanceRow({ costMicros: '3000000' }),
        ]);
        await syncService.syncCompany(
            COMPANY_A,
            connection.id,
            { adapter, now: () => NOW }
        );

        expect(adapter.fetchCampaignPerformance).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                startDate: '2026-06-28',
                endDate: '2026-07-27',
            })
        );
        const facts = await db.query(
            `SELECT COUNT(*)::INT AS count, MAX(cost_micros)::TEXT AS cost_micros
             FROM lead_source_performance_daily
             WHERE company_id = $1
               AND provider_key = 'google_ads'
               AND external_account_id = $2
               AND external_campaign_id = $3
               AND performance_date = $4::DATE`,
            [COMPANY_A, SHARED_CUSTOMER, SHARED_CAMPAIGN, SHARED_DATE]
        );
        expect(facts.rows[0]).toEqual({ count: 1, cost_micros: '3000000' });
    });

    databaseTest('failed page collection commits neither facts nor coverage', async () => {
        await connect(COMPANY_A);
        const connection = await rawConnection(COMPANY_A);
        await db.query(
            `UPDATE google_ads_connections
             SET synced_from_date = '2024-07-27',
                 synced_through_date = '2026-07-26',
                 last_sync_status = 'ok'
             WHERE company_id = $1`,
            [COMPANY_A]
        );
        const beforeFacts = await performanceSnapshot(COMPANY_A);
        const beforeCoverage = await rawConnection(COMPANY_A);
        const adapter = syncAdapter(async () => {
            const error = new Error('provider response must not persist');
            error.code = 'GOOGLE_ADS_QUERY_FAILED';
            throw error;
        });

        await expect(syncService.syncCompany(
            COMPANY_A,
            connection.id,
            { adapter, now: () => NOW }
        )).rejects.toMatchObject({ code: 'GOOGLE_ADS_QUERY_FAILED' });

        const afterCoverage = await rawConnection(COMPANY_A);
        expect(await performanceSnapshot(COMPANY_A)).toBe(beforeFacts);
        expect(String(afterCoverage.synced_from_date))
            .toBe(String(beforeCoverage.synced_from_date));
        expect(String(afterCoverage.synced_through_date))
            .toBe(String(beforeCoverage.synced_through_date));
        expect(afterCoverage.last_sync_status).toBe('error');
    });

    databaseTest('active DB lease prevents a duplicate provider pull', async () => {
        await connect(COMPANY_A);
        const connection = await rawConnection(COMPANY_A);
        const lease = new Date(NOW.getTime() + syncService.LEASE_MS);
        const firstClaim = await googleAdsQueries.claimConnection(
            COMPANY_A,
            connection.id,
            NOW,
            lease
        );
        expect(firstClaim).toBeTruthy();
        const adapter = syncAdapter();

        await expect(syncService.syncCompany(
            COMPANY_A,
            connection.id,
            { adapter, now: () => NOW }
        )).resolves.toEqual({ status: 'skipped' });
        expect(adapter.refreshAccessToken).not.toHaveBeenCalled();
        expect(adapter.fetchCampaignPerformance).not.toHaveBeenCalled();
    });
});

/*
 * Required destructive controls for the owner-run release gate:
 *
 * SAB-GADS-CONNECTION-COMPANY:
 *   cp backend/src/db/googleAdsQueries.js /tmp/googleAdsQueries.js.sab
 *   remove "company_id = $1 AND" from claimConnection only
 *   run this suite -> T-foreign MUST turn RED because provider work starts for B
 *   cp /tmp/googleAdsQueries.js.sab backend/src/db/googleAdsQueries.js
 *
 * SAB-GADS-PERFORMANCE-COMPANY:
 *   cp backend/src/db/googleAdsQueries.js /tmp/googleAdsQueries.js.sab
 *   remove company_id from commitPerformanceChunk's ON CONFLICT identity
 *   run this suite -> T-blast MUST turn RED (sync cannot satisfy the tenant-safe upsert)
 *   cp /tmp/googleAdsQueries.js.sab backend/src/db/googleAdsQueries.js
 */
