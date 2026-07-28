'use strict';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() },
}));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/googleAdsQueries');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const CONNECTION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Google Ads tenant-scoped query layer', () => {
    test('connection resolution always pairs id with company_id', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await queries.getConnectionById(COMPANY, CONNECTION);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('WHERE company_id = $1');
        expect(sql).toContain('AND id = $2');
        expect(params).toEqual([COMPANY, CONNECTION]);
    });

    test('atomic performance chunk uses tenant-inclusive natural identity and coverage transaction', async () => {
        const client = {
            query: jest.fn().mockImplementation(async (sql) => {
                if (sql.includes('SELECT id')) return { rows: [{ id: CONNECTION }] };
                if (sql.includes('UPDATE google_ads_connections')) {
                    return { rows: [{ id: CONNECTION }] };
                }
                return { rows: [], rowCount: 1 };
            }),
            release: jest.fn(),
        };
        db.pool.connect.mockResolvedValue(client);
        const expectedLeaseExpiresAt = new Date('2026-07-27T16:15:00.000Z');

        await queries.commitPerformanceChunk({
            companyId: COMPANY,
            connectionId: CONNECTION,
            channelId: 'channel-a',
            customerId: '1234567890',
            rows: [{
                external_campaign_id: '44',
                external_campaign_name: 'Search',
                performance_date: '2026-07-27',
                cost_micros: '1000000',
                impressions: '10',
                clicks: '2',
                conversions: '1',
                conversions_value: '100',
            }],
            chunkStart: '2026-07-27',
            chunkEnd: '2026-07-27',
            finished: true,
            now: new Date('2026-07-27T16:00:00.000Z'),
            expectedLeaseExpiresAt,
        });

        const calls = client.query.mock.calls;
        expect(calls[0][0]).toBe('BEGIN');
        const lock = calls.find(call => call[0].includes('SELECT id'))[0];
        expect(lock).toContain('WHERE company_id = $1');
        expect(lock).toContain('AND id = $2');
        expect(lock).toContain('sync_lease_expires_at = $3::TIMESTAMPTZ');

        const upsert = calls.find(call => (
            call[0].includes('INSERT INTO lead_source_performance_daily')
        ))[0];
        expect(upsert).toContain(`ON CONFLICT (
                    company_id,
                    provider_key,
                    external_account_id,
                    external_campaign_id,
                    performance_date
                 )`);
        expect(upsert).toContain("VALUES (\n                    $1, 'google_ads'");
        expect(calls.at(-1)[0]).toBe('COMMIT');
        expect(client.release).toHaveBeenCalled();
    });

    test('every company-scoped operation rejects missing trusted company context', async () => {
        await expect(queries.getConnectionByCompany(null)).rejects.toMatchObject({
            code: 'COMPANY_ID_REQUIRED',
        });
        await expect(queries.disconnectConnection(null)).rejects.toMatchObject({
            code: 'COMPANY_ID_REQUIRED',
        });
        expect(db.query).not.toHaveBeenCalled();
    });
});
