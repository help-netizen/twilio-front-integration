const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const portalQueries = require('../backend/src/db/portalQueries');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const CONTACT = 42;

beforeEach(() => jest.clearAllMocks());

describe('portal document scope fails closed', () => {
    test.each([
        ['missing', null, 'estimate', 7],
        ['unknown', 'document', 'estimate', 7],
        ['incomplete', 'estimate', 'estimate', null],
        ['mismatched', 'estimate', 'invoice', 7],
    ])('%s scope tuple returns no documents without querying', async (_label, scope, documentType, documentId) => {
        await expect(portalQueries.getContactDocuments(
            COMPANY, CONTACT, scope, documentType, documentId,
        )).resolves.toEqual([]);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('explicit full scope remains company/contact scoped', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await portalQueries.getContactDocuments(COMPANY, CONTACT, 'full');
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('WHERE company_id = $1 AND contact_id = $2');
        expect(params).toEqual([COMPANY, CONTACT]);
    });

    test('matching estimate scope remains single-document scoped', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await portalQueries.getContactDocuments(COMPANY, CONTACT, 'estimate', 'estimate', 7);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('WHERE id = $1 AND company_id = $2 AND contact_id = $3');
        expect(params).toEqual([7, COMPANY, CONTACT]);
    });
});
