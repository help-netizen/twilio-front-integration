'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const contactsService = require('../backend/src/services/contactsService');

describe('contactsService.upsertFromZenbooker tenant safety', () => {
    const companyA = '00000000-0000-0000-0000-0000000000aa';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('requires explicit company context before any write', async () => {
        await expect(contactsService.upsertFromZenbooker({ id: 'zb-1' }))
            .rejects.toMatchObject({
                code: 'TENANT_CONTEXT_REQUIRED',
                httpStatus: 403,
            });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('a foreign natural-key collision fails closed without updating that row', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        await expect(contactsService.upsertFromZenbooker({
            id: 'shared-zb-id',
            first_name: 'Safe',
        }, companyA)).rejects.toMatchObject({
            code: 'ZENBOOKER_ID_CONFLICT',
            httpStatus: 409,
        });

        expect(db.query).toHaveBeenCalledTimes(2);
        expect(db.query.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');
        expect(db.query.mock.calls[1][0]).toContain(
            'WHERE company_id = $1 AND zenbooker_customer_id = $8'
        );
        expect(db.query.mock.calls[1][1][0]).toBe(companyA);
    });

    test('an existing owned contact is updated with both company and external id', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({
                rows: [{
                    id: 7,
                    company_id: companyA,
                    zenbooker_customer_id: 'zb-7',
                    full_name: 'Safe Contact',
                }],
            });

        await expect(contactsService.upsertFromZenbooker({
            id: 'zb-7',
            first_name: 'Safe',
            last_name: 'Contact',
        }, companyA)).resolves.toMatchObject({
            id: 7,
            company_id: companyA,
            zenbooker_customer_id: 'zb-7',
        });
    });
});

