'use strict';

const mockQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockQuery(...args),
}));

const contactAddressService = require('../backend/src/services/contactAddressService');

const COMPANY = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

test('setDefaultAddress carries company_id on both address UPDATEs', async () => {
    await contactAddressService.setDefaultAddress(5, 9, COMPANY);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    for (const [sql, params] of mockQuery.mock.calls) {
        expect(sql).toContain('c.company_id');
        expect(params).toContain(COMPANY);
    }
});

test('resolveAddress refuses a foreign Contact before any address write', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await contactAddressService.resolveAddress(
        5,
        { street: '1 Main', city: 'Boston', state: 'MA', zip: '02110' },
        COMPANY
    );

    expect(result).toEqual({ contact_address_id: null, status: 'none' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('company_id = $2');
    expect(mockQuery.mock.calls[0][1]).toEqual([5, COMPANY]);
});

test('mutable-field address UPDATE is bounded by Contact and company', async () => {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 5 }] })
        .mockResolvedValueOnce({ rows: [{ id: 9 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await contactAddressService.resolveAddress(
        5,
        {
            street: '1 Main',
            apt: '2',
            city: 'Boston',
            state: 'MA',
            zip: '02110',
            placeId: 'place-1',
        },
        COMPANY
    );

    const [sql, params] = mockQuery.mock.calls[2];
    expect(sql).toContain('ca.contact_id = $5');
    expect(sql).toContain('c.company_id = $6');
    expect(params).toEqual(expect.arrayContaining([9, 5, COMPANY]));
});
