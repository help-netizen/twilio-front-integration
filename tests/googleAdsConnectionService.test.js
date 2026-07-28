'use strict';

const {
    connectCompany,
} = require('../backend/src/services/googleAdsConnectionService');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const ACTOR = '22222222-2222-2222-2222-222222222222';

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
    process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
});

afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function dependencies(existing = null) {
    const client = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
    };
    const queries = {
        getConnectionByCompany: jest.fn()
            .mockResolvedValueOnce(existing)
            .mockResolvedValueOnce(existing),
        ensureGoogleAdsChannel: jest.fn().mockResolvedValue({ id: 'channel-a' }),
        upsertConnection: jest.fn().mockImplementation(input => ({
            ...input,
            id: 'connection-a',
            customer_id: input.customerId,
            refresh_token_encrypted: input.refreshTokenEncrypted,
            status: 'connected',
            currency_code: input.currencyCode,
            account_timezone: input.accountTimezone,
            last_sync_status: 'pending',
        })),
    };
    const adapter = {
        fetchAccountMetadata: jest.fn().mockResolvedValue({
            currency_code: 'USD',
            account_timezone: 'America/New_York',
        }),
    };
    const db = { pool: { connect: jest.fn().mockResolvedValue(client) } };
    return { queries, adapter, db, client };
}

describe('Google Ads connection lifecycle service', () => {
    test('validates provider account, encrypts token, and creates tenant channel atomically', async () => {
        const deps = dependencies();
        const result = await connectCompany({
            companyId: COMPANY,
            customerId: '123-456-7890',
            refreshToken: 'refresh-private',
            actorId: ACTOR,
        }, deps);

        expect(deps.adapter.fetchAccountMetadata).toHaveBeenCalledWith({
            clientId: 'oauth-client',
            clientSecret: 'oauth-secret',
            developerToken: 'developer-secret',
            customerId: '1234567890',
            refreshToken: 'refresh-private',
        });
        expect(deps.queries.ensureGoogleAdsChannel).toHaveBeenCalledWith(
            COMPANY,
            deps.client
        );
        const persisted = deps.queries.upsertConnection.mock.calls[0][0];
        expect(persisted.companyId).toBe(COMPANY);
        expect(persisted.customerId).toBe('1234567890');
        expect(persisted.refreshTokenEncrypted).toMatch(/^v1:/);
        expect(persisted.refreshTokenEncrypted).not.toContain('refresh-private');
        expect(result.customer_id_masked).toBe('7890');
        expect(JSON.stringify(result)).not.toContain('1234567890');
        expect(deps.client.query.mock.calls.map(call => call[0])).toEqual([
            'BEGIN',
            'COMMIT',
        ]);
        expect(deps.client.release).toHaveBeenCalled();
    });

    test('different-customer reconnect fails before provider or encryption work', async () => {
        const deps = dependencies({ customer_id: '9999999999' });

        await expect(connectCompany({
            companyId: COMPANY,
            customerId: '123-456-7890',
            refreshToken: 'refresh-private',
            actorId: ACTOR,
        }, deps)).rejects.toMatchObject({
            code: 'CUSTOMER_MISMATCH',
            httpStatus: 409,
        });

        expect(deps.adapter.fetchAccountMetadata).not.toHaveBeenCalled();
        expect(deps.db.pool.connect).not.toHaveBeenCalled();
    });

    test('same-customer reconnect is accepted and replaces encrypted credentials', async () => {
        const deps = dependencies({ customer_id: '1234567890' });

        await expect(connectCompany({
            companyId: COMPANY,
            customerId: '123-456-7890',
            refreshToken: 'replacement-refresh',
            actorId: ACTOR,
        }, deps)).resolves.toMatchObject({
            connected: true,
            status: 'connected',
            last_sync_status: 'pending',
        });

        expect(deps.queries.upsertConnection).toHaveBeenCalledTimes(1);
        expect(deps.queries.upsertConnection.mock.calls[0][0].refreshTokenEncrypted)
            .not.toContain('replacement-refresh');
    });
});
