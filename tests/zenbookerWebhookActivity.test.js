'use strict';

const mockDbQuery = jest.fn();
const mockHandleContactWebhook = jest.fn();
const mockLogZenbookerEntity = jest.fn();
const mockGetClientForCompany = jest.fn();
const mockSyncFromZenbooker = jest.fn();
const mockHandleJobWebhook = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));
jest.mock('../backend/src/services/zenbookerSyncService', () => ({
    FEATURE_ENABLED: true,
    handleWebhookPayload: (...args) => mockHandleContactWebhook(...args),
}));
jest.mock('../backend/src/services/zenbookerActivityService', () => ({
    logZenbookerEntity: (...args) => mockLogZenbookerEntity(...args),
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({
    ZENBOOKER_DEFAULT_COMPANY_ID: 'default-company',
    getClientForCompany: (...args) => mockGetClientForCompany(...args),
}));
jest.mock('../backend/src/services/jobsService', () => ({
    syncFromZenbooker: (...args) => mockSyncFromZenbooker(...args),
}));
jest.mock('../backend/src/services/jobSyncService', () => ({
    handleJobWebhook: (...args) => mockHandleJobWebhook(...args),
}));
jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (_req, _res, next) => next(),
    requireCompanyAccess: (_req, _res, next) => next(),
}));

const { processWebhookPayload } = require(
    '../backend/src/routes/integrations-zenbooker'
);

describe('Zenbooker webhook activity coalescing', () => {
    const companyId = '00000000-0000-0000-0000-0000000000aa';

    beforeEach(() => {
        jest.clearAllMocks();
        mockDbQuery.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
        mockLogZenbookerEntity.mockResolvedValue({ ok: true });
        mockHandleJobWebhook.mockResolvedValue({ updated: false });
        mockGetClientForCompany.mockResolvedValue({
            get: jest.fn(async () => ({
                data: { id: 'zb-job-1', status: 'scheduled' },
            })),
        });
    });

    test('customer webhook emits one Contact event with Zenbooker attribution', async () => {
        const payload = {
            event: 'customer.edited',
            data: { id: 'zb-contact-1' },
        };
        mockHandleContactWebhook.mockResolvedValue({
            contact_id: 81,
            created: false,
        });

        await processWebhookPayload('request-1', payload, {}, companyId);

        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('ON CONFLICT (company_id, event_key)'),
            expect.arrayContaining([companyId])
        );
        expect(mockHandleContactWebhook).toHaveBeenCalledWith(payload, companyId);
        expect(mockLogZenbookerEntity).toHaveBeenCalledTimes(1);
        expect(mockLogZenbookerEntity).toHaveBeenCalledWith({
            companyId,
            entityType: 'contact',
            entityId: 81,
            summary: { status: 'updated' },
        });
        const processedUpdate = mockDbQuery.mock.calls.find(
            ([sql]) => String(sql).includes("SET status = 'processed'")
        );
        expect(processedUpdate[0]).toContain('company_id = $2');
        expect(processedUpdate[1][1]).toBe(companyId);
    });

    test('missing webhook company fails closed before inbox persistence', async () => {
        await expect(processWebhookPayload(
            'request-unscoped',
            { event: 'customer.edited', data: { id: 'zb-contact-1' } },
            {},
            null
        )).rejects.toMatchObject({ code: 'ZENBOOKER_TENANT_UNRESOLVED' });

        expect(mockDbQuery).not.toHaveBeenCalled();
        expect(mockHandleContactWebhook).not.toHaveBeenCalled();
    });

    test('job webhook emits one Job event after the entity sync', async () => {
        const payload = {
            event: 'job.updated',
            data: { id: 'zb-job-1' },
        };
        mockSyncFromZenbooker.mockResolvedValue({
            job_id: 42,
            blanc_status: 'Submitted',
        });

        await processWebhookPayload('request-2', payload, {}, companyId);

        expect(mockSyncFromZenbooker).toHaveBeenCalledWith(
            'zb-job-1',
            { id: 'zb-job-1', status: 'scheduled' },
            companyId,
            'job.updated'
        );
        expect(mockHandleJobWebhook).toHaveBeenCalledWith(payload, companyId);
        expect(mockLogZenbookerEntity).toHaveBeenCalledTimes(1);
        expect(mockLogZenbookerEntity).toHaveBeenCalledWith({
            companyId,
            entityType: 'job',
            entityId: 42,
            summary: { status: 'Submitted' },
        });
    });
});
