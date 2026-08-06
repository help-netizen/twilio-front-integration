'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/contactResolverService', () => ({
    resolveOrCreateContact: jest.fn(),
}));
jest.mock('../backend/src/services/contactPropagationService', () => ({
    propagateContactDetails: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const { resolveOrCreateContact } = require('../backend/src/services/contactResolverService');
const { propagateContactDetails } = require('../backend/src/services/contactPropagationService');
const contactsService = require('../backend/src/services/contactsService');

describe('contactsService.upsertFromZenbooker tenant safety', () => {
    const companyA = '00000000-0000-0000-0000-0000000000aa';

    beforeEach(() => {
        jest.clearAllMocks();
        resolveOrCreateContact.mockResolvedValue({
            contact_id: 7,
            created: false,
            matched_by: 'phone',
        });
        propagateContactDetails.mockResolvedValue({ phone: 'already', email: 'no_slot' });
    });

    test('requires explicit company context before any write', async () => {
        await expect(contactsService.upsertFromZenbooker({ id: 'zb-1' }))
            .rejects.toMatchObject({
                code: 'TENANT_CONTEXT_REQUIRED',
                httpStatus: 403,
            });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('delegates identity selection to the company-scoped resolver', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 7, company_id: companyA }] });

        await contactsService.upsertFromZenbooker({
            id: 'shared-zb-id',
            first_name: 'Safe',
            phone: '6175550101',
        }, companyA);

        expect(resolveOrCreateContact).toHaveBeenCalledWith({
            companyId: companyA,
            externalId: 'shared-zb-id',
            contact: expect.objectContaining({ phone: '6175550101' }),
        });
        expect(db.query).toHaveBeenCalledTimes(2);
        expect(db.query.mock.calls[0][0]).toContain('WHERE target.company_id = $1 AND target.id = $7');
        expect(db.query.mock.calls[1][1][0]).toBe(companyA);
    });

    test('fill-empty update never overwrites non-blank contact identity fields', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
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

        const [sql] = db.query.mock.calls[0];
        expect(sql).toMatch(/full_name = COALESCE\(NULLIF\(BTRIM\(target\.full_name\), ''\), \$2\)/);
        expect(sql).toMatch(/first_name = COALESCE\(NULLIF\(BTRIM\(target\.first_name\), ''\), \$3\)/);
        expect(sql).toMatch(/last_name = COALESCE\(NULLIF\(BTRIM\(target\.last_name\), ''\), \$4\)/);
        expect(sql).not.toMatch(/phone_e164\s*=/);
        expect(sql).not.toMatch(/email\s*=/);
        expect(propagateContactDetails).toHaveBeenCalledWith(
            companyA,
            7,
            { phone: null, email: null },
            { source: 'zb_contact_sync' }
        );
    });
});
