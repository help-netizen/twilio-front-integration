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

describe('stripePaymentsQueries.getSessionReceiptContact', () => {
    it('resolves session/invoice/job contact linkage with every table tenant-scoped', async () => {
        const contact = { id: 5, email: null };
        db.query.mockResolvedValue({ rows: [contact] });

        await expect(queries.getSessionReceiptContact(COMPANY, 11)).resolves.toEqual(contact);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('i.company_id = s.company_id');
        expect(sql).toContain('j.company_id = s.company_id');
        expect(sql).toContain('c.company_id = s.company_id');
        expect(sql).toContain('WHERE s.company_id = $1 AND s.id = $2');
        expect(sql).toContain('COALESCE(s.contact_id, i.contact_id, j.contact_id)');
        expect(params).toEqual([COMPANY, 11]);
    });

    it('returns null when the session has no bound contact in the requested company', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await expect(queries.getSessionReceiptContact(COMPANY, 11)).resolves.toBeNull();
    });
});
