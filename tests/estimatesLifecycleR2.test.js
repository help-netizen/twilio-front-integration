/**
 * PF002-R2 Estimates lifecycle/service rules.
 */

const COMPANY_ID = 'company-uuid-001';
const USER_ID = 'user-sub-001';
const EST_ID = 42;

const mockQueries = {
    listEstimates: jest.fn(),
    getEstimateById: jest.fn(),
    getJobContext: jest.fn(),
    getLeadContext: jest.fn(),
    nextEstimateSequence: jest.fn(),
    buildEstimateNumber: jest.fn(({ leadSerialId, sequence }) => `ESTIMATE L-${leadSerialId}-${sequence}`),
    createEstimate: jest.fn(),
    updateEstimate: jest.fn(),
    archiveEstimate: jest.fn(),
    restoreEstimate: jest.fn(),
    updateEstimateStatus: jest.fn(),
    getEstimateItems: jest.fn(),
    addEstimateItem: jest.fn(),
    updateEstimateItem: jest.fn(),
    deleteEstimateItem: jest.fn(),
    replaceEstimateItems: jest.fn(),
    recalculateEstimateTotals: jest.fn(),
    createRevision: jest.fn(),
    listRevisions: jest.fn(),
    createEvent: jest.fn(),
    listEvents: jest.fn(),
};

jest.mock('../backend/src/db/estimatesQueries', () => mockQueries);

const service = require('../backend/src/services/estimatesService');

function estimate(overrides = {}) {
    return {
        id: EST_ID,
        company_id: COMPANY_ID,
        estimate_number: 'ESTIMATE L-18-1',
        status: 'draft',
        archived_at: null,
        approved_snapshot: null,
        summary: null,
        tax_rate: '0',
        discount_type: null,
        discount_value: '0',
        ...overrides,
    };
}

function item(overrides = {}) {
    return {
        id: 7,
        estimate_id: EST_ID,
        name: 'Labor',
        quantity: '1',
        unit_price: '95.00',
        amount: '95.00',
        taxable: false,
        ...overrides,
    };
}

describe('estimatesService PF002-R2 lifecycle', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQueries.createEvent.mockResolvedValue({});
        mockQueries.createRevision.mockResolvedValue({});
        mockQueries.replaceEstimateItems.mockResolvedValue([]);
        mockQueries.recalculateEstimateTotals.mockResolvedValue({});
    });

    it('creates a job estimate with ESTIMATE L-{leadNumber}-1 and default item rules', async () => {
        mockQueries.getJobContext.mockResolvedValue({ id: 519, job_number: '519', lead_id: 18, contact_id: 9 });
        mockQueries.nextEstimateSequence.mockResolvedValue(1);
        mockQueries.createEstimate.mockResolvedValue({ id: EST_ID });
        mockQueries.getEstimateById.mockResolvedValue(estimate());
        mockQueries.getEstimateItems.mockResolvedValue([item()]);

        await service.createEstimate(COMPANY_ID, USER_ID, {
            job_id: 519,
            items: [{ name: 'Labor', unit_price: 95 }],
        });

        expect(mockQueries.createEstimate).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({
            estimate_number: 'ESTIMATE L-18-1',
            estimate_sequence: 1,
            contact_id: 9,
            lead_id: 18,
            job_id: 519,
        }));
        expect(mockQueries.replaceEstimateItems).toHaveBeenCalledWith(EST_ID, [
            expect.objectContaining({ name: 'Labor', quantity: 1, taxable: false }),
        ]);
    });

    it('allows saving summary-only draft but blocks send/approve without items', async () => {
        mockQueries.getLeadContext.mockResolvedValue({ id: 12, serial_id: 700, contact_id: 5 });
        mockQueries.nextEstimateSequence.mockResolvedValue(1);
        mockQueries.createEstimate.mockResolvedValue({ id: EST_ID });
        mockQueries.getEstimateById.mockResolvedValue(estimate({ summary: 'Findings...' }));
        mockQueries.getEstimateItems.mockResolvedValue([]);

        await expect(service.createEstimate(COMPANY_ID, USER_ID, {
            lead_id: 12,
            summary: 'Findings...',
        })).resolves.toMatchObject({ id: EST_ID });

        await expect(service.sendEstimate(COMPANY_ID, USER_ID, EST_ID, { channel: 'email' }))
            .rejects.toMatchObject({ code: 'VALIDATION', message: 'В эстимейте нет items' });
        await expect(service.approveEstimate(COMPANY_ID, EST_ID, 'user', USER_ID))
            .rejects.toMatchObject({ code: 'VALIDATION', message: 'В эстимейте нет items' });
    });

    // NOTE: the old 'send is a workflow stub' case was removed — SEND-DOC-001 made
    // sendEstimate a real dispatcher (requires a recipient; emits 'sent', flips status).
    // Real send behavior is covered comprehensively in tests/sendDocEstimate.test.js.

    it('approve stores an approved snapshot and uses approved status', async () => {
        mockQueries.getEstimateById.mockResolvedValue(estimate({ status: 'viewed' }));
        mockQueries.getEstimateItems.mockResolvedValue([item()]);
        mockQueries.updateEstimate.mockResolvedValue(estimate({ status: 'approved' }));

        await service.approveEstimate(COMPANY_ID, EST_ID, 'user', USER_ID);

        expect(mockQueries.createRevision).toHaveBeenCalledWith(EST_ID, expect.objectContaining({
            status: 'approved',
            items: [expect.objectContaining({ name: 'Labor' })],
        }), USER_ID);
        expect(mockQueries.updateEstimate).toHaveBeenCalledWith(EST_ID, COMPANY_ID, expect.objectContaining({
            status: 'approved',
            approved_snapshot: expect.objectContaining({ items: expect.any(Array) }),
        }));
    });

    it('editing an approved estimate preserves approved version and resets to draft', async () => {
        mockQueries.getEstimateById
            .mockResolvedValueOnce(estimate({ status: 'approved', approved_snapshot: { status: 'approved', items: [item()] } }))
            .mockResolvedValue(estimate({ status: 'draft' }));
        mockQueries.getEstimateItems.mockResolvedValue([item()]);
        mockQueries.updateEstimate.mockResolvedValue(estimate({ status: 'draft' }));

        await service.updateEstimate(COMPANY_ID, USER_ID, EST_ID, {
            items: [{ name: 'Labor with discount', unit_price: 90 }],
        });

        expect(mockQueries.createRevision).toHaveBeenCalledWith(EST_ID, expect.objectContaining({ status: 'approved' }), USER_ID);
        expect(mockQueries.updateEstimate).toHaveBeenCalledWith(EST_ID, COMPANY_ID, expect.objectContaining({
            status: 'draft',
            accepted_at: null,
        }));
    });

    it('archives without changing status and restore delegates draft reset to query', async () => {
        mockQueries.getEstimateById
            .mockResolvedValueOnce(estimate({ status: 'approved' }))
            .mockResolvedValueOnce(estimate({ status: 'approved', archived_at: '2026-04-27T00:00:00Z' }))
            .mockResolvedValueOnce(estimate({ status: 'approved', archived_at: '2026-04-27T00:00:00Z' }))
            .mockResolvedValueOnce(estimate({ status: 'draft', archived_at: null }));
        mockQueries.archiveEstimate.mockResolvedValue(estimate({ status: 'approved', archived_at: '2026-04-27T00:00:00Z' }));
        mockQueries.restoreEstimate.mockResolvedValue(estimate({ status: 'draft', archived_at: null }));
        mockQueries.getEstimateItems.mockResolvedValue([item()]);

        await service.archiveEstimate(COMPANY_ID, USER_ID, EST_ID);
        await service.restoreEstimate(COMPANY_ID, USER_ID, EST_ID);

        expect(mockQueries.archiveEstimate).toHaveBeenCalledWith(EST_ID, COMPANY_ID, USER_ID);
        expect(mockQueries.restoreEstimate).toHaveBeenCalledWith(EST_ID, COMPANY_ID, USER_ID);
    });
});
