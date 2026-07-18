/** STRIPE-PAYFORM-UX-001 — company-scoped manual-card session lookup contract. */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../backend/src/db/connection');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');
const queries = require('../backend/src/db/stripePaymentsQueries');

const COMPANY = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
    jest.clearAllMocks();
    marketplaceQueries.ensureMarketplaceSchema.mockResolvedValue(undefined);
});

describe('stripePaymentsQueries.getSessionById', () => {
    it('CTRL-RESULT-TENANT-SHAPE: filters by company_id and id with bound parameters', async () => {
        const row = { id: 11, company_id: COMPANY, surface: 'manual_card' };
        db.query.mockResolvedValue({ rows: [row] });

        await expect(queries.getSessionById(COMPANY, 11)).resolves.toEqual(row);

        expect(marketplaceQueries.ensureMarketplaceSchema).toHaveBeenCalledTimes(1);
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('WHERE company_id = $1 AND id = $2');
        expect(params).toEqual([COMPANY, 11]);
    });

    it('returns null when no row exists in the requested company', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await expect(queries.getSessionById(COMPANY, 99)).resolves.toBeNull();
    });
});
