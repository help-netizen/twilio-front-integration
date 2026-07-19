const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: mockDbQuery,
    pool: { connect: jest.fn() },
}));

const express = require('express');
const request = require('supertest');
const stQueries = require('../backend/src/db/serviceTerritoryQueries');
const radiusQueries = require('../backend/src/db/territoryRadiusQueries');
const territoryGeoService = require('../backend/src/services/territoryGeoService');
const territoryService = require('../backend/src/services/territoryService');
const { haversineMiles } = require('../backend/src/utils/geo');
const zipCheckRouter = require('../backend/src/routes/zip-check');
const checkServiceArea = require('../backend/src/services/agentSkills/skills/checkServiceArea');

const originalFetch = global.fetch;
const originalGeocodingKey = process.env.GOOGLE_GEOCODING_KEY;
const originalPlacesKey = process.env.GOOGLE_PLACES_KEY;

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function googleResult({
    lat = 42.3467,
    lng = -71.1627,
    city = 'Brighton',
    state = 'MA',
    zip = '02135',
    placeId = 'postal-place-02135',
} = {}) {
    return {
        status: 'OK',
        results: [{
            place_id: placeId,
            types: ['postal_code'],
            geometry: { location: { lat, lng } },
            address_components: [
                { long_name: zip, short_name: zip, types: ['postal_code'] },
                { long_name: city, short_name: city, types: ['locality'] },
                { long_name: 'Massachusetts', short_name: state, types: ['administrative_area_level_1'] },
            ],
        }],
    };
}

function mockGoogle(payload = googleResult()) {
    global.fetch.mockResolvedValue({ json: jest.fn().mockResolvedValue(payload) });
}

function mockMode(mode) {
    return jest.spyOn(radiusQueries, 'getSettings').mockResolvedValue({ active_mode: mode });
}

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockDbQuery.mockReset();
    global.fetch = jest.fn();
    delete process.env.GOOGLE_GEOCODING_KEY;
    delete process.env.GOOGLE_PLACES_KEY;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    global.fetch = originalFetch;
    restoreEnv('GOOGLE_GEOCODING_KEY', originalGeocodingKey);
    restoreEnv('GOOGLE_PLACES_KEY', originalPlacesKey);
});

afterAll(() => {
    jest.restoreAllMocks();
});

describe('haversineMiles (TC-TERR2-001)', () => {
    test('returns zero for one point and the known Boston-to-NYC distance', () => {
        expect(haversineMiles(42.3601, -71.0589, 42.3601, -71.0589)).toBe(0);
        const bostonToNyc = haversineMiles(42.3601, -71.0589, 40.7128, -74.0060);
        expect(bostonToNyc).toBeGreaterThan(188);
        expect(bostonToNyc).toBeLessThan(192);
    });
});

describe('territoryGeoService.geocodeZip', () => {
    test('TC-TERR2-002: cache hit returns public geography without calling Google or INSERT', async () => {
        mockDbQuery.mockResolvedValue({
            rows: [{ lat: '42.346700', lon: '-71.162700', city: 'Brighton', state: 'MA' }],
        });

        await expect(territoryGeoService.geocodeZip('02135')).resolves.toEqual({
            zip: '02135',
            lat: '42.346700',
            lon: '-71.162700',
            city: 'Brighton',
            state: 'MA',
        });
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
        expect(mockDbQuery.mock.calls[0][0]).toContain('FROM zip_geocache');
        expect(mockDbQuery.mock.calls[0][1]).toEqual(['02135']);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('TC-TERR2-003: cache miss calls component-filtered Google and caches the result', async () => {
        process.env.GOOGLE_GEOCODING_KEY = 'geocoding-key';
        process.env.GOOGLE_PLACES_KEY = 'places-key';
        mockDbQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        mockGoogle();

        await expect(territoryGeoService.geocodeZip('02135')).resolves.toEqual({
            zip: '02135',
            lat: 42.3467,
            lon: -71.1627,
            city: 'Brighton',
            state: 'MA',
        });

        const calledUrl = new URL(String(global.fetch.mock.calls[0][0]));
        expect(calledUrl.searchParams.get('components')).toBe('postal_code:02135|country:US');
        expect(calledUrl.searchParams.get('key')).toBe('geocoding-key');
        expect(mockDbQuery.mock.calls[1][0]).toContain('ON CONFLICT (zip) DO UPDATE');
        expect(mockDbQuery.mock.calls[1][1]).toEqual([
            '02135', 42.3467, -71.1627, 'Brighton', 'MA', 'postal-place-02135',
        ]);
    });

    test('uses GOOGLE_PLACES_KEY when GOOGLE_GEOCODING_KEY is absent', async () => {
        process.env.GOOGLE_PLACES_KEY = 'places-key';
        mockDbQuery.mockResolvedValue({ rows: [] });
        mockGoogle({ status: 'ZERO_RESULTS', results: [] });

        await expect(territoryGeoService.geocodeZip('02135')).resolves.toBeNull();
        const calledUrl = new URL(String(global.fetch.mock.calls[0][0]));
        expect(calledUrl.searchParams.get('key')).toBe('places-key');
    });

    test.each([
        ['ZERO_RESULTS', { status: 'ZERO_RESULTS', results: [] }],
        ['non-OK', { status: 'OVER_QUERY_LIMIT', error_message: 'quota', results: [] }],
    ])('TC-TERR2-004: %s is not cached and returns null', async (_label, payload) => {
        process.env.GOOGLE_GEOCODING_KEY = 'key';
        mockDbQuery.mockResolvedValue({ rows: [] });
        mockGoogle(payload);

        await expect(territoryGeoService.geocodeZip('02135')).resolves.toBeNull();
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
    });

    test('TC-TERR2-004: missing key returns null without calling Google or INSERT', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });

        await expect(territoryGeoService.geocodeZip('02135')).resolves.toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
    });

    test('TC-TERR2-004: fetch rejection returns null without INSERT', async () => {
        process.env.GOOGLE_GEOCODING_KEY = 'key';
        mockDbQuery.mockResolvedValue({ rows: [] });
        global.fetch.mockRejectedValue(new Error('network down'));

        await expect(territoryGeoService.geocodeZip('02135')).resolves.toBeNull();
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
    });

    test('missing coordinates return null without INSERT', async () => {
        process.env.GOOGLE_GEOCODING_KEY = 'key';
        mockDbQuery.mockResolvedValue({ rows: [] });
        mockGoogle({ status: 'OK', results: [{ geometry: {}, address_components: [] }] });

        await expect(territoryGeoService.geocodeZip('02135')).resolves.toBeNull();
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
    });

    test('database exceptions also return null rather than escaping', async () => {
        mockDbQuery.mockRejectedValue(new Error('database down'));
        await expect(territoryGeoService.geocodeZip('02135')).resolves.toBeNull();
    });

    test.each([
        ['2135', '02135'],
        [2135, '02135'],
    ])('TC-TERR2-005: normalizes %p before cache and Google lookup', async (input, expectedZip) => {
        process.env.GOOGLE_GEOCODING_KEY = 'key';
        mockDbQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        mockGoogle();

        await territoryGeoService.geocodeZip(input);
        expect(mockDbQuery.mock.calls[0][1]).toEqual([expectedZip]);
        const calledUrl = new URL(String(global.fetch.mock.calls[0][0]));
        expect(calledUrl.searchParams.get('components')).toBe(`postal_code:${expectedZip}|country:US`);
    });

    test('empty normalized ZIP returns null before cache lookup', async () => {
        await expect(territoryGeoService.geocodeZip('not-a-zip')).resolves.toBeNull();
        expect(mockDbQuery).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('TC-TERR2-026: cached null coordinates remain misses and retry Google', async () => {
        process.env.GOOGLE_GEOCODING_KEY = 'key';
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ lat: null, lon: null, city: null, state: null }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ lat: null, lon: null, city: null, state: null }] })
            .mockResolvedValueOnce({ rows: [] });
        mockGoogle();

        await territoryGeoService.geocodeZip('02135');
        await territoryGeoService.geocodeZip('02135');

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(mockDbQuery.mock.calls[1][0]).toContain('ON CONFLICT (zip) DO UPDATE');
        expect(mockDbQuery.mock.calls[3][0]).toContain('ON CONFLICT (zip) DO UPDATE');
    });
});

describe('territoryGeoService.resolveZipPlaceId', () => {
    test('returns a fresh cached place ID without a Google request', async () => {
        mockDbQuery.mockResolvedValue({
            rows: [{
                google_place_id: 'postal-place-02135',
                place_id_resolved_at: new Date().toISOString(),
            }],
        });

        await expect(territoryGeoService.resolveZipPlaceId('02135'))
            .resolves.toBe('postal-place-02135');
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('resolves and persistently caches an exact ZIP place ID on a cache miss', async () => {
        process.env.GOOGLE_GEOCODING_KEY = 'geocoding-key';
        mockDbQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        mockGoogle();

        await expect(territoryGeoService.resolveZipPlaceId('02135'))
            .resolves.toBe('postal-place-02135');
        expect(mockDbQuery).toHaveBeenCalledTimes(2);
        expect(mockDbQuery.mock.calls[1][0]).toContain('google_place_id');
        expect(mockDbQuery.mock.calls[1][1]).toEqual([
            '02135', 42.3467, -71.1627, 'Brighton', 'MA', 'postal-place-02135',
        ]);
    });

    test('rejects a mismatched postal-code result instead of caching the wrong boundary', async () => {
        process.env.GOOGLE_GEOCODING_KEY = 'geocoding-key';
        mockDbQuery.mockResolvedValue({ rows: [] });
        mockGoogle(googleResult({ zip: '99999', placeId: 'wrong-place' }));

        await expect(territoryGeoService.resolveZipPlaceId('02135')).resolves.toBeNull();
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
    });

    test('keeps a stale cached ID available when its refresh fails', async () => {
        process.env.GOOGLE_GEOCODING_KEY = 'geocoding-key';
        mockDbQuery.mockResolvedValue({
            rows: [{
                google_place_id: 'stale-place-id',
                place_id_resolved_at: '2020-01-01T00:00:00.000Z',
            }],
        });
        global.fetch.mockRejectedValue(new Error('network down'));

        await expect(territoryGeoService.resolveZipPlaceId('02135'))
            .resolves.toBe('stale-place-id');
    });
});

describe('territoryService.isZipInTerritory', () => {
    test('TC-TERR2-006: default list mode delegates the original query unchanged', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });
        const rawQuery = '  123 Main St, Boston, MA 02108  ';
        const search = jest.spyOn(stQueries, 'search').mockResolvedValue({
            zip: '02108', area: 'Boston', city: 'Boston', state: 'MA', county: 'Suffolk',
        });
        const geocode = jest.spyOn(territoryGeoService, 'geocodeZip');
        const listRadii = jest.spyOn(radiusQueries, 'listRadii');

        await expect(territoryService.isZipInTerritory('company-1', rawQuery)).resolves.toEqual({
            inside: true,
            area: 'Boston',
            city: 'Boston',
            state: 'MA',
            zip: '02108',
            mode: 'list',
        });
        expect(search).toHaveBeenCalledWith('company-1', rawQuery);
        expect(geocode).not.toHaveBeenCalled();
        expect(listRadii).not.toHaveBeenCalled();
    });

    test('TC-TERR2-007: list miss returns the complete empty-string shape', async () => {
        mockMode('list');
        jest.spyOn(stQueries, 'search').mockResolvedValue(null);

        await expect(territoryService.isZipInTerritory('company-1', 'Boston')).resolves.toEqual({
            inside: false,
            area: '',
            city: '',
            state: '',
            zip: '',
            mode: 'list',
        });
    });

    test('TC-TERR2-008: radius mode finds a ZIP inside one circle', async () => {
        mockMode('radius');
        jest.spyOn(stQueries, 'search');
        jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '02461', lat: 42.32, lon: -71.21, city: 'Newton', state: 'MA',
        });
        jest.spyOn(radiusQueries, 'listRadii').mockResolvedValue([
            { zip: '02135', lat: '42.350000', lon: '-71.160000', radius_miles: '25.0' },
        ]);

        await expect(territoryService.isZipInTerritory('company-1', '02461')).resolves.toEqual({
            inside: true,
            area: '02135',
            city: 'Newton',
            state: 'MA',
            zip: '02461',
            mode: 'radius',
        });
        expect(stQueries.search).not.toHaveBeenCalled();
    });

    test('TC-TERR2-009: uncovered ZIP keeps geocoded city and state', async () => {
        mockMode('radius');
        jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '10001', lat: 40.7506, lon: -73.9972, city: 'New York', state: 'NY',
        });
        jest.spyOn(radiusQueries, 'listRadii').mockResolvedValue([
            { zip: '02135', lat: 42.3467, lon: -71.1627, radius_miles: 25 },
        ]);

        await expect(territoryService.isZipInTerritory('company-1', '10001')).resolves.toEqual({
            inside: false,
            area: '',
            city: 'New York',
            state: 'NY',
            zip: '10001',
            mode: 'radius',
        });
    });

    test('TC-TERR2-010: nearest covering center supplies area when two circles cover', async () => {
        mockMode('radius');
        jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '00001', lat: 0, lon: 0, city: 'Point', state: 'AA',
        });
        jest.spyOn(radiusQueries, 'listRadii').mockResolvedValue([
            { zip: 'FAR', lat: 0, lon: 0.2, radius_miles: 30 },
            { zip: 'NEAR', lat: 0, lon: 0.05, radius_miles: 30 },
        ]);

        const result = await territoryService.isZipInTerritory('company-1', '00001');
        expect(result.area).toBe('NEAR');
        expect(result.inside).toBe(true);
    });

    test('TC-TERR2-011: extracts the first ZIP from a full address', async () => {
        mockMode('radius');
        const geocode = jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '02301', lat: 42.08, lon: -71.02, city: 'Brockton', state: 'MA',
        });
        jest.spyOn(radiusQueries, 'listRadii').mockResolvedValue([]);

        await territoryService.isZipInTerritory(
            'company-1',
            '123 Main St, Brockton, MA 02301-1234, USA'
        );
        expect(geocode).toHaveBeenCalledWith('02301');
    });

    test('TC-TERR2-011: city-only radius query returns false without geocoding', async () => {
        mockMode('radius');
        const geocode = jest.spyOn(territoryGeoService, 'geocodeZip');
        const listRadii = jest.spyOn(radiusQueries, 'listRadii');

        await expect(territoryService.isZipInTerritory('company-1', 'Boston')).resolves.toEqual({
            inside: false,
            area: '',
            city: '',
            state: '',
            zip: '',
            mode: 'radius',
        });
        expect(geocode).not.toHaveBeenCalled();
        expect(listRadii).not.toHaveBeenCalled();
    });

    test('radius pure-digit parsing recovers a dropped leading zero', async () => {
        mockMode('radius');
        const geocode = jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue(null);

        await territoryService.isZipInTerritory('company-1', '2135');
        expect(geocode).toHaveBeenCalledWith('02135');
    });

    test('TC-TERR2-012: geocode failure safe-fails without loading circles', async () => {
        mockMode('radius');
        jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue(null);
        const listRadii = jest.spyOn(radiusQueries, 'listRadii');

        await expect(territoryService.isZipInTerritory('company-1', '00000')).resolves.toEqual({
            inside: false,
            area: '',
            city: '',
            state: '',
            zip: '00000',
            mode: 'radius',
        });
        expect(listRadii).not.toHaveBeenCalled();
    });

    test('TC-TERR2-012: empty radius set safely returns outside with geocoded metadata', async () => {
        mockMode('radius');
        jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '02135', lat: 42.3467, lon: -71.1627, city: 'Brighton', state: 'MA',
        });
        jest.spyOn(radiusQueries, 'listRadii').mockResolvedValue([]);

        await expect(territoryService.isZipInTerritory('company-1', '02135')).resolves.toEqual({
            inside: false,
            area: '',
            city: 'Brighton',
            state: 'MA',
            zip: '02135',
            mode: 'radius',
        });
    });
});

describe('seam consumer frozen shapes', () => {
    function makeZipCheckApp() {
        const app = express();
        app.use((req, _res, next) => {
            req.companyFilter = { company_id: 'company-1' };
            next();
        });
        app.use('/api/zip-check', zipCheckRouter);
        return app;
    }

    test('TC-TERR2-022: zip-check found response is byte-identical', async () => {
        const seam = jest.spyOn(territoryService, 'isZipInTerritory').mockResolvedValue({
            inside: true,
            area: 'Boston',
            city: 'Boston',
            state: 'MA',
            zip: '02101',
            mode: 'list',
        });

        const res = await request(makeZipCheckApp()).get('/api/zip-check').query({ q: 'Boston' });

        expect(res.status).toBe(200);
        expect(res.text).toBe('{"ok":true,"data":{"success":true,"exists":true,"area":"Boston","city":"Boston","state":"MA","zip":"02101"}}');
        expect(seam).toHaveBeenCalledWith('company-1', 'Boston');
    });

    test('TC-TERR2-022: zip-check miss keeps empty strings and exact bytes', async () => {
        jest.spyOn(territoryService, 'isZipInTerritory').mockResolvedValue({
            inside: false,
            area: '',
            city: '',
            state: '',
            zip: '',
            mode: 'list',
        });

        const res = await request(makeZipCheckApp()).get('/api/zip-check').query({ q: 'Nowhere' });
        expect(res.text).toBe('{"ok":true,"data":{"success":true,"exists":false,"area":"","city":"","state":"","zip":""}}');
    });

    test('TC-TERR2-023: skill in-area branch keeps exact frozen bytes', async () => {
        const seam = jest.spyOn(territoryService, 'isZipInTerritory').mockResolvedValue({
            inside: true,
            area: '02135',
            city: 'Newton',
            state: 'MA',
            zip: '02461',
            mode: 'radius',
        });

        const result = await checkServiceArea.run('company-1', {}, { zip: '02461' });
        expect(JSON.stringify(result)).toBe('{"inServiceArea":true,"area":"02135","city":"Newton","state":"MA","zip":"02461"}');
        expect(seam).toHaveBeenCalledWith('company-1', '02461');
    });

    test('TC-TERR2-023: skill out-area branch strips all non-frozen metadata', async () => {
        jest.spyOn(territoryService, 'isZipInTerritory').mockResolvedValue({
            inside: false,
            area: '',
            city: 'Peabody',
            state: 'MA',
            zip: '01960',
            mode: 'radius',
        });

        const result = await checkServiceArea.run('company-1', {}, { zip: '01960' });
        expect(JSON.stringify(result)).toBe('{"inServiceArea":false,"zip":"01960"}');
    });

    test('TC-TERR2-023: skill missing-ZIP branch bypasses the seam', async () => {
        const seam = jest.spyOn(territoryService, 'isZipInTerritory');

        const result = await checkServiceArea.run('company-1', {}, {});
        expect(JSON.stringify(result)).toBe('{"inServiceArea":false,"error":"zip is required"}');
        expect(seam).not.toHaveBeenCalled();
    });
});
