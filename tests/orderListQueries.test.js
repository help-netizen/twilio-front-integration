'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockQuery(...args),
}));

const estimatesQueries = require('../backend/src/db/estimatesQueries');
const invoicesQueries = require('../backend/src/db/invoicesQueries');

const COMPANY_ID = '00000000-0000-0000-0000-0000000000a1';
const USER_ID = '10000000-0000-0000-0000-0000000000a1';
const ORDER_LIST = [{
    part_number: 'P-100',
    part_name: 'Drain pump',
    quantity: 2,
}];

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [{ id: 1, order_list: ORDER_LIST }] });
});

describe('ORDER-LIST-001 query persistence', () => {
    test('estimate INSERT and tenant-scoped UPDATE bind order_list as JSONB', async () => {
        await estimatesQueries.createEstimate(COMPANY_ID, {
            contact_id: 1,
            lead_id: 2,
            job_id: 3,
            estimate_number: 'ESTIMATE 1',
            estimate_sequence: 1,
            summary: 'Summary',
            order_list: ORDER_LIST,
            created_by: USER_ID,
        });

        let [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('order_list, created_by, updated_by');
        expect(sql).toContain("COALESCE($15::jsonb, '[]'::jsonb)");
        expect(params[14]).toBe(JSON.stringify(ORDER_LIST));
        expect(params[15]).toBe(USER_ID);

        mockQuery.mockClear();
        await estimatesQueries.updateEstimate(1, COMPANY_ID, { order_list: ORDER_LIST });
        [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('order_list = $3::jsonb');
        expect(sql).toContain('WHERE id = $1 AND company_id = $2');
        expect(params).toEqual([1, COMPANY_ID, JSON.stringify(ORDER_LIST)]);
    });

    test('invoice INSERT and tenant-scoped UPDATE bind order_list as JSONB', async () => {
        await invoicesQueries.createInvoice(COMPANY_ID, {
            contact_id: 1,
            invoice_number: 'INVOICE 1',
            order_list: ORDER_LIST,
            created_by: USER_ID,
        });

        let [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('order_list, created_by');
        expect(sql).toContain("COALESCE($16::jsonb, '[]'::jsonb)");
        expect(sql).toContain('$18');
        expect(params[15]).toBe(JSON.stringify(ORDER_LIST));
        expect(params[16]).toBe(USER_ID);
        expect(params[17]).toBe('INVOICE 1');

        mockQuery.mockClear();
        await invoicesQueries.updateInvoice(1, COMPANY_ID, { order_list: ORDER_LIST });
        [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('order_list = $3::jsonb');
        expect(sql).toContain('WHERE id = $1 AND company_id = $2');
        expect(params).toEqual([1, COMPANY_ID, JSON.stringify(ORDER_LIST)]);
    });
});
