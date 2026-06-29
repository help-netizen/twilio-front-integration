/**
 * ZIP-fix consistency (0a3830c follow-up): the leading-zero normalization now
 * lives in the shared service-territory query layer, so EVERY caller (vapi-tools,
 * zip-check, search) recovers a dropped leading zero — not just vapi-tools.
 */
const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery, pool: { connect: jest.fn() } }));

const st = require('../backend/src/db/serviceTerritoryQueries');
const { normalizeZip } = require('../backend/src/utils/zip');

beforeEach(() => { jest.clearAllMocks(); mockQuery.mockResolvedValue({ rows: [] }); });

describe('normalizeZip', () => {
    test('pads a dropped leading zero, trims ZIP+4, rejects junk', () => {
        expect(normalizeZip('1721')).toBe('01721');
        expect(normalizeZip('01721')).toBe('01721');
        expect(normalizeZip(1721)).toBe('01721');          // numeric (model dropped zero)
        expect(normalizeZip('02101-1234')).toBe('02101');  // ZIP+4 → first 5
        expect(normalizeZip(null)).toBe('');
        expect(normalizeZip('abc')).toBe('');
    });
});

describe('serviceTerritoryQueries normalizes on lookup + store', () => {
    test('findByZip pads "1721" → "01721" before the exact-match lookup', async () => {
        await st.findByZip('co-1', '1721');
        expect(mockQuery.mock.calls[0][1]).toEqual(['co-1', '01721']);
    });

    test('search (pure-zip branch) routes through the normalized findByZip', async () => {
        await st.search('co-1', '1721');                   // what GET /api/zip-check passes
        expect(mockQuery.mock.calls[0][1]).toEqual(['co-1', '01721']);
    });

    test('5-digit zip is unchanged', async () => {
        await st.findByZip('co-1', '02101');
        expect(mockQuery.mock.calls[0][1]).toEqual(['co-1', '02101']);
    });

    test('create stores the normalized zip', async () => {
        mockQuery.mockResolvedValue({ rows: [{ zip: '01721' }] });
        await st.create('co-1', { zip: '1721', area: 'Metrowest' });
        expect(mockQuery.mock.calls[0][1][1]).toBe('01721');
    });
});
