'use strict';

const mockDbQuery = jest.fn();
const mockResolveZipPlaceId = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: mockDbQuery,
    pool: { end: jest.fn() },
}));
jest.mock('../backend/src/services/territoryGeoService', () => ({
    resolveZipPlaceId: mockResolveZipPlaceId,
}));

const {
    candidateQuery,
    parseOptions,
    run,
} = require('../scripts/backfill-zip-place-ids');

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const ORIGINAL_ENV = {
    ZIP_PLACE_ID_BACKFILL_LIMIT: process.env.ZIP_PLACE_ID_BACKFILL_LIMIT,
    ZIP_PLACE_ID_BACKFILL_CONCURRENCY: process.env.ZIP_PLACE_ID_BACKFILL_CONCURRENCY,
};

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

beforeEach(() => {
    jest.restoreAllMocks();
    mockDbQuery.mockReset();
    mockResolveZipPlaceId.mockReset();
    delete process.env.ZIP_PLACE_ID_BACKFILL_LIMIT;
    delete process.env.ZIP_PLACE_ID_BACKFILL_CONCURRENCY;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    jest.restoreAllMocks();
    restoreEnv('ZIP_PLACE_ID_BACKFILL_LIMIT', ORIGINAL_ENV.ZIP_PLACE_ID_BACKFILL_LIMIT);
    restoreEnv(
        'ZIP_PLACE_ID_BACKFILL_CONCURRENCY',
        ORIGINAL_ENV.ZIP_PLACE_ID_BACKFILL_CONCURRENCY
    );
});

describe('ZIP Place ID backfill scope', () => {
    test('defaults to one company\'s configured service territory ZIPs only', async () => {
        const options = parseOptions([`--company-id=${COMPANY_ID}`]);
        expect(options).toMatchObject({
            scope: 'served',
            companyId: COMPANY_ID,
            limit: 500,
            concurrency: 5,
        });
        const candidates = candidateQuery(options);
        expect(candidates.sql).toContain('FROM service_territories st');
        expect(candidates.sql).toContain('st.company_id = $1');
        expect(candidates.params).toEqual([COMPANY_ID, 500]);

        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ count: 2 }] })
            .mockResolvedValueOnce({ rows: [{ zip: '02135' }, { zip: '02445' }] })
            .mockResolvedValueOnce({ rows: [{ count: 0 }] });
        mockResolveZipPlaceId.mockResolvedValue('postal-place-id');

        await expect(run(options)).resolves.toMatchObject({
            scope: 'served',
            company_id: COMPANY_ID,
            attempted: 2,
            resolved: 2,
            remaining: 0,
            complete: true,
        });
        expect(mockResolveZipPlaceId.mock.calls.map(([zip]) => zip)).toEqual([
            '02135', '02445',
        ]);
        expect(mockDbQuery.mock.calls.every(([, params]) => params.includes(COMPANY_ID)))
            .toBe(true);
    });

    test('requires an explicit flag before scanning the global US ZIP cache', () => {
        expect(() => parseOptions([])).toThrow('--company-id=<uuid> is required');

        const options = parseOptions(['--all-us']);
        expect(options).toMatchObject({ scope: 'all-us', companyId: null });
        const candidates = candidateQuery(options);
        expect(candidates.sql).toContain('FROM zip_geocache z');
        expect(candidates.sql).not.toContain('service_territories');
        expect(candidates.params).toEqual([500]);
    });

    test('reports unresolved and remaining counts when a run does not converge', async () => {
        const options = parseOptions([`--company-id=${COMPANY_ID}`, '--limit=2']);
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ count: 2 }] })
            .mockResolvedValueOnce({ rows: [{ zip: '02135' }, { zip: '02445' }] })
            .mockResolvedValueOnce({ rows: [{ count: 1 }] });
        mockResolveZipPlaceId
            .mockResolvedValueOnce('postal-place-02135')
            .mockResolvedValueOnce(null);

        await expect(run(options)).resolves.toMatchObject({
            eligible_before: 2,
            attempted: 2,
            resolved: 1,
            unresolved_attempts: 1,
            remaining: 1,
            complete: false,
            minimum_additional_runs_at_limit: 1,
        });
    });
});
