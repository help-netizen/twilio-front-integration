/**
 * ADDR-UX-001 — structured base address.
 *
 * The base-address editors store the address as structured fields (street/apt/city/
 * state/zip) in addition to lat/lng/label/composed-address, so the edit form can
 * pre-fill exactly. These tests cover the service + query layer:
 *  - upsert persists the 5 structured fields (they reach the query, last 5 params).
 *  - explicit lat/lng → stored directly, no geocode call.
 *  - no lat/lng but an address → geocodes and stores the returned coords.
 *  - geocode resolves nothing → 422 GEOCODE_FAILED, no write.
 *  - list() returns the structured fields for each row.
 *
 * Mirrors the mocking in tests/technicianBaseLocations.test.js.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));
jest.mock('../backend/src/db/technicianDirectoryQueries', () => ({
    resolveTechnicianUuid: jest.fn(),
    listActiveTechnicians: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const googlePlacesService = require('../backend/src/services/googlePlacesService');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const queries = require('../backend/src/db/technicianBaseLocationQueries');
const svc = require('../backend/src/services/technicianBaseLocationsService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const TECH_UUID = '11111111-1111-4111-8111-111111111111';

// The structured-address upsert binds, in order:
//   $1 company_id, $2 is_company_default, $3 technician_uuid, $4 lat, $5 lng,
//   $6 label, $7 address, $8 street, $9 apt, $10 city, $11 state, $12 zip
function findInsert() {
    return db.query.mock.calls.find(c => /INSERT INTO technician_base_locations/.test(String(c[0])));
}

beforeEach(() => {
    db.query.mockReset();
    googlePlacesService.geocodeAddress.mockReset();
    directoryQueries.resolveTechnicianUuid.mockReset().mockResolvedValue(TECH_UUID);
    directoryQueries.listActiveTechnicians.mockReset().mockResolvedValue([]);
    // schema bootstrap (125 + 135) + default empty result
    db.query.mockResolvedValue({ rows: [] });
});

describe('upsert persists structured fields', () => {
    it('passes street/apt/city/state/zip through to the query (with explicit coords)', async () => {
        db.query.mockResolvedValue({ rows: [{ tech_id: 't' }] });
        await svc.upsert(COMPANY_A, 't', {
            lat: 42.36, lng: -71.06, label: 'Home',
            address: '1 Main St, Apt 4, Boston, MA 02118',
            street: '1 Main St', apt: 'Apt 4', city: 'Boston', state: 'MA', zip: '02118',
        });

        const ins = findInsert();
        expect(ins).toBeTruthy();
        // structured columns are present in the SQL
        expect(String(ins[0])).toMatch(/street/);
        expect(String(ins[0])).toMatch(/apt/);
        expect(String(ins[0])).toMatch(/city/);
        expect(String(ins[0])).toMatch(/state/);
        expect(String(ins[0])).toMatch(/zip/);
        // ...and the last 5 bound params are the structured values, in order
        expect(ins[1].slice(7, 12)).toEqual(['1 Main St', 'Apt 4', 'Boston', 'MA', '02118']);
    });

    it('trims and nulls blank/whitespace structured fields', async () => {
        db.query.mockResolvedValue({ rows: [{ tech_id: 't' }] });
        await svc.upsert(COMPANY_A, 't', {
            lat: 1, lng: 2,
            street: '  12 Elm  ', apt: '   ', city: 'Cambridge', state: '', zip: undefined,
        });
        const ins = findInsert();
        expect(ins[1].slice(7, 12)).toEqual(['12 Elm', null, 'Cambridge', null, null]);
    });
});

describe('upsert coordinate handling', () => {
    it('with lat/lng provided stores directly (no geocode call)', async () => {
        db.query.mockResolvedValue({ rows: [{ tech_id: 't', lat: 42.1, lng: -71.2 }] });
        await svc.upsert(COMPANY_A, 't', {
            lat: 42.1, lng: -71.2, label: 'Home', street: '1 Main St', city: 'Boston',
        });
        expect(googlePlacesService.geocodeAddress).not.toHaveBeenCalled();
        const ins = findInsert();
        expect(ins[1].slice(0, 5)).toEqual([COMPANY_A, false, TECH_UUID, 42.1, -71.2]);
    });

    it('without lat/lng but with an address → geocodes and stores returned coords', async () => {
        googlePlacesService.geocodeAddress.mockResolvedValue({
            status: 'success', lat: 42.36, lng: -71.06, normalized_address: '1 Main St, Boston, MA 02118',
        });
        db.query.mockResolvedValue({ rows: [{ tech_id: 't' }] });

        await svc.upsert(COMPANY_A, 't', {
            address: '1 main st boston',
            street: '1 Main St', city: 'Boston', state: 'MA', zip: '02118',
        });

        expect(googlePlacesService.geocodeAddress).toHaveBeenCalledWith('1 main st boston');
        const ins = findInsert();
        expect(ins[1][3]).toBe(42.36);          // lat from geocoder
        expect(ins[1][4]).toBe(-71.06);         // lng from geocoder
        expect(ins[1][6]).toBe('1 Main St, Boston, MA 02118'); // normalized address
        // structured fields still persisted alongside
        expect(ins[1].slice(7, 12)).toEqual(['1 Main St', null, 'Boston', 'MA', '02118']);
    });

    it('composes an address from structured fields when no address string is given', async () => {
        googlePlacesService.geocodeAddress.mockResolvedValue({
            status: 'success', lat: 1, lng: 2, normalized_address: 'norm',
        });
        db.query.mockResolvedValue({ rows: [{ tech_id: 't' }] });

        await svc.upsert(COMPANY_A, 't', {
            street: '5 Oak Ave', apt: 'Unit 2', city: 'Newton', state: 'MA', zip: '02458',
        });

        expect(googlePlacesService.geocodeAddress).toHaveBeenCalledWith('5 Oak Ave Unit 2, Newton, MA 02458');
    });

    it('geocode returns nothing → throws httpStatus 422 GEOCODE_FAILED, no write', async () => {
        googlePlacesService.geocodeAddress.mockResolvedValue({ status: 'failed', error_message: 'No geocode result' });
        await expect(
            svc.upsert(COMPANY_A, 't', { address: 'nowhere', street: 'nowhere' })
        ).rejects.toMatchObject({ httpStatus: 422, code: 'GEOCODE_FAILED' });
        expect(findInsert()).toBeUndefined();
    });

    it('geocode returns no coordinates → 422 GEOCODE_FAILED even when status is not "failed"', async () => {
        googlePlacesService.geocodeAddress.mockResolvedValue({ status: 'success', lat: null, lng: null });
        await expect(
            svc.upsert(COMPANY_A, 't', { address: 'partial' })
        ).rejects.toMatchObject({ httpStatus: 422, code: 'GEOCODE_FAILED' });
        expect(findInsert()).toBeUndefined();
    });
});

describe('query layer round-trips structured fields', () => {
    it('queries.upsert binds the 5 structured params and SELECT returns them', async () => {
        db.query.mockResolvedValue({ rows: [{ tech_id: 't' }] });
        await queries.upsert(COMPANY_A, 't', {
            lat: 1, lng: 2, label: 'L', address: 'A',
            street: 'S', apt: 'AP', city: 'C', state: 'ST', zip: 'Z',
        });
        const ins = findInsert();
        expect(ins[1]).toEqual([
            COMPANY_A, false, TECH_UUID, 1, 2, 'L', 'A', 'S', 'AP', 'C', 'ST', 'Z',
        ]);
    });

    it('listByCompany SELECT includes the structured columns', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await queries.listByCompany(COMPANY_A);
        const sel = db.query.mock.calls.find(
            c => /FROM technician_base_locations/.test(String(c[0])) && /SELECT/.test(String(c[0]))
        );
        expect(sel).toBeTruthy();
        for (const col of ['street', 'apt', 'city', 'state', 'zip']) {
            expect(String(sel[0])).toMatch(new RegExp(col));
        }
    });
});

describe('list() surfaces structured fields', () => {
    it('returns street/apt/city/state/zip for each stored row', async () => {
        db.query.mockImplementation(async (sql) => {
            if (/FROM technician_base_locations/.test(String(sql)) && /SELECT/.test(String(sql))) {
                return {
                    rows: [{
                        tech_id: 'tech_1', lat: 42.36, lng: -71.06, label: 'Home',
                        address: '1 Main St, Boston, MA 02118',
                        street: '1 Main St', apt: 'Apt 4', city: 'Boston', state: 'MA', zip: '02118',
                    }],
                };
            }
            return { rows: [] };
        });
        const out = await svc.list(COMPANY_A);
        const row = out.find(r => r.tech_id === 'tech_1');
        expect(row).toMatchObject({
            tech_id: 'tech_1',
            street: '1 Main St', apt: 'Apt 4', city: 'Boston', state: 'MA', zip: '02118',
            has_base: true,
        });
    });

    it('emits null structured fields for roster techs without a stored base', async () => {
        db.query.mockResolvedValue({ rows: [] }); // no stored bases
        directoryQueries.listActiveTechnicians.mockResolvedValue([{
            id: TECH_UUID,
            display_name: 'Sam P',
            zenbooker_external_id: 'tech_9',
        }]);

        const out = await svc.list(COMPANY_A);
        const row = out.find(r => r.tech_id === TECH_UUID);
        expect(row).toMatchObject({
            tech_id: TECH_UUID, has_base: false,
            street: null, apt: null, city: null, state: null, zip: null,
        });
    });
});
