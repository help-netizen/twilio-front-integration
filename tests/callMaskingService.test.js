'use strict';

const mockQuery = jest.fn();
const mockAuditLog = jest.fn(() => Promise.resolve());

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockQuery(...args),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: (...args) => mockAuditLog(...args),
}));

const service = require('../backend/src/services/callMaskingService');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const PROVIDER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('callMaskingService settings', () => {
    test('returns disabled defaults when no company_telephony row exists', async () => {
        mockQuery.mockResolvedValue({ rows: [] });
        await expect(service.getSettings(COMPANY_A)).resolves.toEqual({
            call_masking_enabled: false,
            call_masking_number: '+16174044425',
        });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('WHERE company_id = $1'),
            [COMPANY_A]
        );
    });

    test('save validates ownership in the same company and uses crmUser actor', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
            .mockResolvedValueOnce({
                rows: [{
                    call_masking_enabled: true,
                    call_masking_number: '+16174044425',
                }],
            });

        await expect(service.saveSettings(COMPANY_A, {
            company_id: COMPANY_B,
            call_masking_enabled: true,
            call_masking_number: '+16174044425',
        }, PROVIDER)).resolves.toEqual({
            call_masking_enabled: true,
            call_masking_number: '+16174044425',
        });

        expect(mockQuery.mock.calls[0][0]).toContain('company_id = $1 AND phone_number = $2');
        expect(mockQuery.mock.calls[0][1]).toEqual([COMPANY_A, '+16174044425']);
        expect(mockQuery.mock.calls[1][1]).toEqual([COMPANY_A, true, '+16174044425']);
        expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
            actor_id: PROVIDER,
            company_id: COMPANY_A,
        }));
    });

    test('rejects enabling with a number not owned by the scoped company', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await expect(service.saveSettings(COMPANY_A, {
            call_masking_enabled: true,
            call_masking_number: '+16175559999',
        }, PROVIDER)).rejects.toMatchObject({
            httpStatus: 422,
            code: 'MASKING_NUMBER_NOT_OWNED',
        });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('company_id = $1 AND phone_number = $2'),
            [COMPANY_A, '+16175559999']
        );
        expect(mockAuditLog).not.toHaveBeenCalled();
    });

    test.each([
        [{ call_masking_enabled: 'true', call_masking_number: '+16174044425' }],
        [{ call_masking_enabled: true, call_masking_number: '6174044425' }],
    ])('rejects invalid settings without touching the database', async (payload) => {
        await expect(service.saveSettings(COMPANY_A, payload, PROVIDER))
            .rejects.toMatchObject({ httpStatus: 422, code: 'INVALID_SETTINGS' });
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('callMaskingService resolver', () => {
    test('returns a six-digit direct-dial URI and applies assigned-provider scope', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 42, customer_phone: '+16175550100' }] })
            .mockResolvedValueOnce({ rows: [{ call_masking_number: '+16174044425' }] })
            .mockResolvedValueOnce({ rows: [{ code: 7 }] });

        const result = await service.getMaskedDialForContact(
            COMPANY_A,
            42,
            { assignedOnly: true, userId: PROVIDER }
        );

        expect(result).toEqual({
            enabled: true,
            masking_number: '+16174044425',
            code: '000007',
            display_number: '+16174044425',
            tel_uri: 'tel:+16174044425,,000007',
        });
        expect(mockQuery.mock.calls[0][0]).toContain('visible_job.company_id = c.company_id');
        expect(mockQuery.mock.calls[0][0]).toContain('assigned_provider_user_ids @> $3::jsonb');
        expect(mockQuery.mock.calls[0][1]).toEqual([
            COMPANY_A,
            42,
            JSON.stringify([PROVIDER]),
        ]);
        expect(mockQuery.mock.calls[2][0]).toContain('ON CONFLICT (company_id, contact_id)');
        expect(mockQuery.mock.calls[2][1]).toEqual([COMPANY_A, 42, 999999]);
    });

    test('foreign/missing contact returns null before reading settings or allocating a code', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await expect(service.getMaskedDialForContact(
            COMPANY_A,
            99,
            { assignedOnly: false, userId: null }
        )).resolves.toBeNull();
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0][1]).toEqual([COMPANY_A, 99]);
    });

    test('same provider phone and code are resolved only inside the supplied company', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ call_masking_number: '+16174044425' }] })
            .mockResolvedValueOnce({ rows: [{ user_id: PROVIDER, phone: '(617) 555-0000' }] })
            .mockResolvedValueOnce({ rows: [{ contact_id: 8, customer_phone: '+16175550999' }] });

        const resolved = await service.resolveCustomerForProviderCode(COMPANY_A, {
            maskingNumber: '+16174044425',
            providerPhone: '+16175550000',
            code: '000123',
        });

        expect(resolved).toMatchObject({
            company_id: COMPANY_A,
            provider_user_id: PROVIDER,
            contact_id: 8,
            customer_phone: '+16175550999',
        });
        for (const call of mockQuery.mock.calls) {
            expect(call[1][0]).toBe(COMPANY_A);
        }
        expect(mockQuery.mock.calls[2][0]).toContain('cmc.company_id = $1');
        expect(mockQuery.mock.calls[2][1]).toEqual([COMPANY_A, 123]);
    });

    test('ambiguous registered provider phone fails closed', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ call_masking_number: '+16174044425' }] })
            .mockResolvedValueOnce({
                rows: [
                    { user_id: PROVIDER, phone: '+16175550000' },
                    { user_id: 'other', phone: '617-555-0000' },
                ],
            });
        await expect(service.resolveCustomerForProviderCode(COMPANY_A, {
            maskingNumber: '+16174044425',
            providerPhone: '+16175550000',
            code: '000123',
        })).resolves.toBeNull();
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('job resolver scopes the job before resolving its contact', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ contact_id: 42 }] })
            .mockResolvedValueOnce({ rows: [{ id: 42, customer_phone: '+16175550100' }] })
            .mockResolvedValueOnce({ rows: [] });

        await expect(service.getMaskedDialForJob(
            COMPANY_A,
            77,
            { assignedOnly: true, userId: PROVIDER }
        )).resolves.toEqual({
            enabled: false,
            masking_number: null,
            code: null,
            display_number: null,
            tel_uri: null,
        });
        expect(mockQuery.mock.calls[0][0]).toContain('j.company_id = $1');
        expect(mockQuery.mock.calls[0][0]).toContain('j.assigned_provider_user_ids @> $3::jsonb');
        expect(mockQuery.mock.calls[0][1]).toEqual([
            COMPANY_A,
            77,
            JSON.stringify([PROVIDER]),
        ]);
    });
});
