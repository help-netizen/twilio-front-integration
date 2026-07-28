'use strict';

const {
    encryptRefreshToken,
} = require('../backend/src/services/googleAdsCredentials');
const {
    buildRanges,
    createGoogleAdsScheduler,
    syncCompany,
} = require('../backend/src/services/googleAdsSyncService');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const CONNECTION_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONNECTION_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NOW = new Date('2026-07-27T16:00:00.000Z');

let savedEnv;

beforeEach(() => {
    savedEnv = {
        GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID,
        GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET,
        GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        GOOGLE_ADS_TOKEN_ENCRYPTION_KEY: process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY,
    };
    process.env.GOOGLE_ADS_CLIENT_ID = 'oauth-client';
    process.env.GOOGLE_ADS_CLIENT_SECRET = 'oauth-secret';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'developer-secret';
    process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
});

afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function claimedConnection(overrides = {}) {
    return {
        id: CONNECTION_A,
        company_id: COMPANY_A,
        channel_id: 'channel-a',
        customer_id: '1234567890',
        refresh_token_encrypted: encryptRefreshToken('refresh-private'),
        status: 'connected',
        account_timezone: 'America/New_York',
        synced_through_date: null,
        ...overrides,
    };
}

function syncDependencies(connection = claimedConnection()) {
    const queries = {
        claimConnection: jest.fn().mockResolvedValue(connection),
        commitPerformanceChunk: jest.fn().mockResolvedValue({}),
        refreshLease: jest.fn().mockResolvedValue(true),
        failSync: jest.fn().mockResolvedValue({}),
    };
    const adapter = {
        refreshAccessToken: jest.fn().mockResolvedValue('access-private'),
        fetchCampaignPerformance: jest.fn().mockResolvedValue([{
            external_campaign_id: '44',
            external_campaign_name: 'Search',
            performance_date: '2026-07-27',
            cost_micros: '1000000',
            impressions: '10',
            clicks: '2',
            conversions: '1',
            conversions_value: '100',
        }]),
    };
    return { queries, adapter, now: () => NOW };
}

describe('Google Ads leased synchronization', () => {
    test('initial sync covers 731 days in bounded 30-day chunks', async () => {
        const deps = syncDependencies();
        const result = await syncCompany(COMPANY_A, CONNECTION_A, deps);

        expect(result).toEqual({ status: 'ok', ranges: 25, rows: 25 });
        expect(deps.adapter.refreshAccessToken).toHaveBeenCalledTimes(1);
        expect(deps.adapter.fetchCampaignPerformance).toHaveBeenCalledTimes(25);
        expect(deps.queries.commitPerformanceChunk).toHaveBeenCalledTimes(25);
        expect(deps.adapter.fetchCampaignPerformance.mock.calls[0][0])
            .toMatchObject({
                customerId: '1234567890',
                startDate: '2024-07-27',
                endDate: '2024-08-25',
            });
        expect(deps.adapter.fetchCampaignPerformance.mock.calls[24][0])
            .toMatchObject({
                startDate: '2026-07-17',
                endDate: '2026-07-27',
            });
        expect(deps.queries.commitPerformanceChunk.mock.calls[24][0].finished)
            .toBe(true);
    });

    test('incremental sync re-queries the rolling 30-day window', async () => {
        const deps = syncDependencies(claimedConnection({
            synced_through_date: '2026-07-26',
        }));

        await expect(syncCompany(COMPANY_A, CONNECTION_A, deps)).resolves.toEqual({
            status: 'ok',
            ranges: 1,
            rows: 1,
        });
        expect(deps.adapter.fetchCampaignPerformance).toHaveBeenCalledWith(
            expect.objectContaining({
                startDate: '2026-06-28',
                endDate: '2026-07-27',
            })
        );
        expect(deps.queries.refreshLease).not.toHaveBeenCalled();
    });

    test('T-foreign: company A cannot claim B connection before any provider call', async () => {
        const deps = syncDependencies();
        deps.queries.claimConnection.mockResolvedValue(null);

        await expect(syncCompany(COMPANY_A, CONNECTION_B, deps)).resolves.toEqual({
            status: 'skipped',
        });
        expect(deps.queries.claimConnection).toHaveBeenCalledWith(
            COMPANY_A,
            CONNECTION_B,
            NOW,
            expect.any(Date)
        );
        expect(deps.adapter.refreshAccessToken).not.toHaveBeenCalled();
        expect(deps.adapter.fetchCampaignPerformance).not.toHaveBeenCalled();
    });

    test('auth failure stores only a sanitized code/message and requires reconnect', async () => {
        const deps = syncDependencies();
        deps.adapter.refreshAccessToken.mockRejectedValue(
            Object.assign(new Error('refresh-private provider response'), {
                code: 'AUTH_REFRESH_FAILED',
            })
        );

        await expect(syncCompany(COMPANY_A, CONNECTION_A, deps)).rejects.toMatchObject({
            code: 'AUTH_REFRESH_FAILED',
        });
        expect(deps.queries.failSync).toHaveBeenCalledWith(
            expect.objectContaining({
                companyId: COMPANY_A,
                connectionId: CONNECTION_A,
                connectionStatus: 'reconnect_required',
                errorCode: 'AUTH_REFRESH_FAILED',
                errorMessage: 'Google Ads authorization must be refreshed.',
            })
        );
        expect(JSON.stringify(deps.queries.failSync.mock.calls[0][0]))
            .not.toContain('refresh-private');
    });

    test('DB lease loser starts no provider work', async () => {
        const runner = jest.fn();
        const queries = {
            listDueConnections: jest.fn().mockResolvedValue([]),
        };
        const scheduler = createGoogleAdsScheduler({ queries, syncCompany: runner });

        await expect(scheduler.tick(NOW)).resolves.toEqual({
            claimed: 0,
            active: 0,
        });
        expect(runner).not.toHaveBeenCalled();
    });

    test('scheduler detaches a due sync and suppresses overlapping local ticks', async () => {
        let resolveRun;
        const run = new Promise(resolve => { resolveRun = resolve; });
        const runner = jest.fn().mockReturnValue(run);
        const queries = {
            listDueConnections: jest.fn().mockResolvedValue([{
                id: CONNECTION_A,
                company_id: COMPANY_A,
            }]),
        };
        const scheduler = createGoogleAdsScheduler({ queries, syncCompany: runner });

        await expect(scheduler.tick(NOW)).resolves.toEqual({
            claimed: 1,
            active: 1,
        });
        await expect(scheduler.tick(NOW)).resolves.toEqual({
            claimed: 0,
            active: 1,
        });
        expect(queries.listDueConnections).toHaveBeenCalledTimes(1);
        resolveRun({ status: 'ok' });
        await scheduler.waitForIdle();
    });
});

describe('Google Ads date ranges', () => {
    test('backfill is exactly 731 inclusive days and incremental is exactly 30', () => {
        const backfill = buildRanges(claimedConnection(), NOW);
        expect(backfill[0].startDate).toBe('2024-07-27');
        expect(backfill.at(-1).endDate).toBe('2026-07-27');

        const incremental = buildRanges(claimedConnection({
            synced_through_date: '2026-07-26',
        }), NOW);
        expect(incremental).toEqual([{
            startDate: '2026-06-28',
            endDate: '2026-07-27',
        }]);
    });
});
