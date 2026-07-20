'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery, getClient: jest.fn() }));
const queries = require('../backend/src/db/priceBookQueries');

beforeEach(() => mockQuery.mockReset().mockResolvedValue({ rows: [] }));

describe('PRICEBOOK-NESTED-001 query scoping', () => {
    test('T-blast / SAB-PB-TREE-BLAST: flat source for tree always predicates and binds company_id', async () => {
        await queries.listCategories('company-a');
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/WHERE company_id = \$1/);
        expect(params).toEqual(['company-a']);
    });

    test('group aggregate and category join are company-paired', async () => {
        await queries.listGroups('company-a');
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/c\.company_id = g\.company_id/);
        expect(sql).toMatch(/i\.company_id = gi\.company_id/);
        expect(sql).toMatch(/WHERE gi\.company_id = \$1/);
        expect(params[0]).toBe('company-a');
    });
});
