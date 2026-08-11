'use strict';

const {
    buildRanges,
    createElocalScheduler,
    syncCompany,
} = require('../backend/src/services/elocalSyncService');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const CONNECTION_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONNECTION_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NOW = new Date('2026-08-11T16:00:00.000Z');

let savedApiKey;

beforeEach(() => {
    savedApiKey = process.env.ELOCAL_API_KEY;
    process.env.ELOCAL_API_KEY = 'private-api-key';
});

afterEach(() => {
    if (savedApiKey === undefined) delete process.env.ELOCAL_API_KEY;
    else process.env.ELOCAL_API_KEY = savedApiKey;
});

function connection(overrides = {}) {
    return {
        id: CONNECTION_A,
        company_id: COMPANY_A,
        campaign_ids: ['campaign-a', 'campaign-b'],
        api_key_reference: 'ELOCAL_API_KEY',
        company_timezone: 'America/New_York',
        synced_through_date: null,
        ...overrides,
    };
}

function dependencies(claimed = connection()) {
    const queries = {
        claimConnection: jest.fn().mockResolvedValue(claimed),
        commitCallsChunk: jest.fn().mockResolvedValue(),
        refreshLease: jest.fn().mockResolvedValue(true),
        completeSync: jest.fn().mockResolvedValue({}),
        failSync: jest.fn().mockResolvedValue({}),
    };
    const adapter = {
        fetchCampaignResults: jest.fn().mockResolvedValue({
            calls: [{ external_call_id: 'deduped-call' }],
            webLeads: [],
        }),
    };
    const attribution = {
        matchCompany: jest.fn().mockResolvedValue({
            matchedLeads: 1,
            attributedJobs: 2,
        }),
    };
    return { queries, adapter, attribution, now: () => NOW };
}

describe('eLocal leased synchronization', () => {
    test('initial sync uses explicit 30-day chunks inside one lease path', async () => {
        const deps = dependencies();

        await expect(syncCompany(COMPANY_A, CONNECTION_A, deps)).resolves.toEqual({
            status: 'ok',
            ranges: 25,
            calls: 25,
            webLeads: 0,
            matchedLeads: 1,
            attributedJobs: 2,
        });
        expect(deps.adapter.fetchCampaignResults).toHaveBeenCalledTimes(25);
        expect(deps.adapter.fetchCampaignResults.mock.calls[0][0]).toEqual({
            campaignIds: ['campaign-a', 'campaign-b'],
            apiKey: 'private-api-key',
            startDate: '2024-08-11',
            endDate: '2024-09-09',
        });
        expect(deps.adapter.fetchCampaignResults.mock.calls.at(-1)[0])
            .toMatchObject({
                startDate: '2026-08-01',
                endDate: '2026-08-11',
            });
        expect(deps.queries.commitCallsChunk).toHaveBeenCalledTimes(25);
        expect(deps.queries.refreshLease).toHaveBeenCalledTimes(25);
        expect(deps.attribution.matchCompany).toHaveBeenCalledTimes(1);
        expect(deps.queries.completeSync).toHaveBeenCalledWith(
            expect.objectContaining({
                companyId: COMPANY_A,
                connectionId: CONNECTION_A,
                callCount: 25,
                webLeadCount: 0,
            })
        );
    });

    test('incremental sync re-queries exactly 30 days', async () => {
        const deps = dependencies(connection({
            synced_through_date: '2026-08-10',
        }));

        const result = await syncCompany(COMPANY_A, CONNECTION_A, deps);

        expect(result.ranges).toBe(1);
        expect(deps.adapter.fetchCampaignResults).toHaveBeenCalledWith(
            expect.objectContaining({
                startDate: '2026-07-13',
                endDate: '2026-08-11',
            })
        );
    });

    test('T-foreign lease loser starts no provider work', async () => {
        const deps = dependencies(null);

        await expect(syncCompany(COMPANY_A, CONNECTION_B, deps)).resolves.toEqual({
            status: 'skipped',
        });
        expect(deps.adapter.fetchCampaignResults).not.toHaveBeenCalled();
        expect(deps.attribution.matchCompany).not.toHaveBeenCalled();
    });

    test('missing API key stores only a sanitized error', async () => {
        delete process.env.ELOCAL_API_KEY;
        const deps = dependencies();

        await expect(syncCompany(COMPANY_A, CONNECTION_A, deps))
            .rejects.toMatchObject({ code: 'ELOCAL_CONFIGURATION_MISSING' });
        expect(deps.queries.failSync).toHaveBeenCalledWith(
            expect.objectContaining({
                errorCode: 'ELOCAL_CONFIGURATION_MISSING',
                errorMessage: 'eLocal API access is not configured.',
            })
        );
        expect(JSON.stringify(deps.queries.failSync.mock.calls[0][0]))
            .not.toContain('private-api-key');
    });

    test('scheduler suppresses overlapping local runs', async () => {
        let resolveRun;
        const run = new Promise(resolve => { resolveRun = resolve; });
        const runner = jest.fn().mockReturnValue(run);
        const queries = {
            listDueConnections: jest.fn().mockResolvedValue([{
                id: CONNECTION_A,
                company_id: COMPANY_A,
            }]),
        };
        const scheduler = createElocalScheduler({ queries, syncCompany: runner });

        await expect(scheduler.tick(NOW)).resolves.toEqual({ claimed: 1, active: 1 });
        await expect(scheduler.tick(NOW)).resolves.toEqual({ claimed: 0, active: 1 });
        resolveRun({ status: 'ok' });
        await scheduler.waitForIdle();
    });
});

describe('eLocal ranges', () => {
    test('backfill is 731 inclusive days and rolling is 30', () => {
        const backfill = buildRanges(connection(), NOW);
        expect(backfill[0].startDate).toBe('2024-08-11');
        expect(backfill.at(-1).endDate).toBe('2026-08-11');
        expect(buildRanges(connection({ synced_through_date: '2026-08-10' }), NOW))
            .toEqual([{ startDate: '2026-07-13', endDate: '2026-08-11' }]);
    });
});
