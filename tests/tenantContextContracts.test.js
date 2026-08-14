'use strict';

const mockQuery = jest.fn();
const mockGetClient = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: mockQuery,
    getClient: mockGetClient,
}));

const contactsQueries = require('../backend/src/db/contactsQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const { runCleanup } = require('../backend/scripts/yelp_timeline_dedup_cleanup');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('TENANT-ISO-002 fail-closed DB/service contracts', () => {
    test.each([
        ['findContactByPhone', () => contactsQueries.findContactByPhone('+15085550100')],
        ['createContact', () => contactsQueries.createContact('+15085550100', 'No Tenant')],
        ['findOrCreateContact', () => contactsQueries.findOrCreateContact('+15085550100')],
        ['findContactByPhoneOrSecondary', () => contactsQueries.findContactByPhoneOrSecondary('+15085550100')],
        ['findOrCreateAnonymousTimeline', () => timelinesQueries.findOrCreateAnonymousTimeline()],
        ['findOrCreateTimeline', () => timelinesQueries.findOrCreateTimeline('+15085550100')],
        ['findOrCreateTimelineByContact', () => timelinesQueries.findOrCreateTimelineByContact(42)],
        ['resolveYelpTimeline', () => timelinesQueries.resolveYelpTimeline(null, 'conv-1', {})],
        ['yelp cleanup', () => runCleanup()],
    ])('%s throws the shared error before first DB query', async (_name, act) => {
        await expect(act()).rejects.toMatchObject({
            name: 'TenantContextRequiredError',
            code: 'TENANT_CONTEXT_REQUIRED',
            httpStatus: 403,
        });
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockGetClient).not.toHaveBeenCalled();
    });

    it('the legacy migrate-timelines one-off is retired before loading DB', () => {
        let thrown;
        try {
            jest.isolateModules(() => require('../scripts/migrate-timelines'));
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toMatchObject({ code: 'RETIRED_ONE_TIME_SCRIPT' });
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockGetClient).not.toHaveBeenCalled();
    });

    it('T-blast phone: same digits resolve only inside the requested company', async () => {
        const rows = [
            { id: 10, company_id: COMPANY_A, phone_e164: '+15085550111', full_name: 'A' },
            { id: 20, company_id: COMPANY_B, phone_e164: '+15085550111', full_name: 'B' },
        ];
        const beforeB = JSON.parse(JSON.stringify(rows[1]));
        mockQuery.mockImplementation(async (_sql, params) => ({
            rows: rows.filter(row => row.company_id === params[1]
                && row.phone_e164.replace(/\D/g, '') === params[0]),
        }));

        await expect(contactsQueries.findContactByPhone('+1 (508) 555-0111', COMPANY_A))
            .resolves.toMatchObject({ id: 10, company_id: COMPANY_A });
        expect(rows[1]).toStrictEqual(beforeB);
        expect(mockQuery.mock.calls[0][1]).toEqual(['15085550111', COMPANY_A]);
    });

    it('T-foreign contact id: foreign contact returns null and performs no write', async () => {
        mockQuery.mockResolvedValue({ rows: [] });

        await expect(timelinesQueries.findOrCreateTimelineByContact(700, COMPANY_A))
            .resolves.toBeNull();
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0][0]).toContain('id = $1 AND company_id = $2');
        expect(mockQuery.mock.calls[0][1]).toEqual([700, COMPANY_A]);
    });

    it('anonymous and ordinary orphan upserts target the composite tenant key', async () => {
        mockQuery.mockResolvedValue({ rows: [{ id: 1, company_id: COMPANY_A }] });

        await timelinesQueries.findOrCreateAnonymousTimeline(COMPANY_A);
        const [anonymousSql, anonymousParams] = mockQuery.mock.calls[0];
        expect(anonymousSql).toContain('ON CONFLICT (company_id, phone_e164)');
        expect(anonymousParams).toEqual(['ANONYMOUS', COMPANY_A]);

        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 2, company_id: COMPANY_A }] });
        await timelinesQueries.findOrCreateTimeline('+15085550123', COMPANY_A);
        const [orphanSql, orphanParams] = mockQuery.mock.calls[3];
        expect(orphanSql).toContain('ON CONFLICT (company_id, phone_e164)');
        expect(orphanParams[1]).toBe(COMPANY_A);
    });
});
