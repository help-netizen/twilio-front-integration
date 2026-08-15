/**
 * PF002-R2 Estimates lifecycle/service rules.
 */

const COMPANY_ID = 'company-uuid-001';
const USER_ID = 'user-sub-001';
const EST_ID = 42;
const TX_CLIENT = { query: jest.fn() };
const HUMAN_ACTOR = {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'user',
    label: null,
    source: 'crm',
};
const mockLogFinancialActivity = jest.fn();
const mockEmit = jest.fn();
const mockCreateTask = jest.fn();

const mockQueries = {
    listEstimates: jest.fn(),
    getEstimateById: jest.fn(),
    getJobContext: jest.fn(),
    getLeadContext: jest.fn(),
    getContactContext: jest.fn(),
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
    getDeclineTaskContext: jest.fn(),
};

jest.mock('../backend/src/db/estimatesQueries', () => mockQueries);
jest.mock('../backend/src/db/tasksQueries', () => ({
    createTask: (...args) => mockCreateTask(...args),
}));
jest.mock('../backend/src/db/connection', () => ({
    getClient: jest.fn(),
    query: jest.fn(),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: (...args) => mockLogFinancialActivity(...args),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: (...args) => mockEmit(...args),
}));

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
        mockQueries.addEstimateItem.mockResolvedValue(item());
        mockQueries.updateEstimateItem.mockResolvedValue(item());
        mockQueries.deleteEstimateItem.mockResolvedValue(true);
        mockQueries.updateEstimateStatus.mockResolvedValue(estimate({ status: 'declined' }));
        mockLogFinancialActivity.mockResolvedValue({ ok: true });
        mockEmit.mockResolvedValue({ id: 1 });
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
        }), null);
        expect(mockQueries.replaceEstimateItems).toHaveBeenCalledWith(COMPANY_ID, EST_ID, [
            expect.objectContaining({ name: 'Labor', quantity: 1, taxable: false }),
        ], null);
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
        mockQueries.getEstimateById.mockResolvedValue(estimate({
            status: 'sent',
            summary: 'Findings...',
        }));
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

        expect(mockQueries.createRevision).toHaveBeenCalledWith(COMPANY_ID, EST_ID, expect.objectContaining({
            status: 'approved',
            items: [expect.objectContaining({ name: 'Labor' })],
        }), USER_ID, null);
        expect(mockQueries.updateEstimate).toHaveBeenCalledWith(EST_ID, COMPANY_ID, expect.objectContaining({
            status: 'approved',
            approved_snapshot: expect.objectContaining({ items: expect.any(Array) }),
        }), null);
        expect(mockEmit).toHaveBeenCalledWith(
            COMPANY_ID,
            'estimate.approved',
            expect.objectContaining({
                estimate_id: EST_ID,
                estimate_number: 'ESTIMATE L-18-1',
                job_id: null,
                contact_id: null,
                order_list_count: 0,
            }),
            expect.objectContaining({
                aggregateType: 'estimate',
                aggregateId: EST_ID,
                client: null,
            })
        );
    });

    it('approve is idempotent and rejects draft/declined transitions before side effects', async () => {
        mockQueries.getEstimateById.mockResolvedValue(estimate({ status: 'approved' }));

        await expect(service.approveEstimate(COMPANY_ID, EST_ID, 'user', USER_ID))
            .resolves.toMatchObject({ status: 'approved' });
        expect(mockQueries.createRevision).not.toHaveBeenCalled();
        expect(mockQueries.updateEstimate).not.toHaveBeenCalled();
        expect(mockQueries.createEvent).not.toHaveBeenCalled();

        for (const status of ['draft', 'declined']) {
            jest.clearAllMocks();
            mockQueries.getEstimateById.mockResolvedValue(estimate({ status }));
            await expect(service.approveEstimate(COMPANY_ID, EST_ID, 'user', USER_ID))
                .rejects.toMatchObject({ code: 'INVALID_TRANSITION', httpStatus: 409 });
            expect(mockQueries.getEstimateItems).not.toHaveBeenCalled();
            expect(mockQueries.updateEstimate).not.toHaveBeenCalled();
        }
    });

    it('decline allows sent/viewed, is idempotent, and rejects draft/approved transitions', async () => {
        mockQueries.getEstimateById.mockResolvedValue(estimate({ status: 'sent' }));

        await service.declineEstimate(COMPANY_ID, EST_ID, 'user', USER_ID, {
            reason: 'Customer called to decline',
        });
        expect(mockQueries.updateEstimateStatus).toHaveBeenCalledWith(
            EST_ID,
            COMPANY_ID,
            'declined',
            'declined_at',
            null
        );
        expect(mockCreateTask).not.toHaveBeenCalled();

        jest.clearAllMocks();
        mockQueries.getEstimateById.mockResolvedValue(estimate({ status: 'declined' }));
        await expect(service.declineEstimate(COMPANY_ID, EST_ID, 'user', USER_ID, {}))
            .resolves.toMatchObject({ status: 'declined' });
        expect(mockQueries.updateEstimateStatus).not.toHaveBeenCalled();

        for (const status of ['draft', 'approved']) {
            jest.clearAllMocks();
            mockQueries.getEstimateById.mockResolvedValue(estimate({ status }));
            await expect(service.declineEstimate(COMPANY_ID, EST_ID, 'user', USER_ID, {
                reason: 'No',
            })).rejects.toMatchObject({ code: 'INVALID_TRANSITION', httpStatus: 409 });
            expect(mockQueries.updateEstimateStatus).not.toHaveBeenCalled();
        }
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

        expect(mockQueries.createRevision).toHaveBeenCalledWith(
            COMPANY_ID,
            EST_ID,
            expect.objectContaining({ status: 'approved' }),
            USER_ID,
            null
        );
        expect(mockQueries.updateEstimate).toHaveBeenCalledWith(EST_ID, COMPANY_ID, expect.objectContaining({
            status: 'draft',
            accepted_at: null,
        }), null);
    });

    it('ESTIMATE-REDESIGN-001 regression: edit-from-list save without items does not eat line items', async () => {
        const persistedItems = [item({ name: 'Customer-approved scope' })];
        mockQueries.getEstimateById.mockResolvedValue(estimate({ summary: 'Existing scope' }));
        mockQueries.getEstimateItems.mockResolvedValue(persistedItems);
        mockQueries.updateEstimate.mockResolvedValue(estimate({
            summary: 'Existing scope',
            tax_rate: '8.25',
        }));

        const updated = await service.updateEstimate(COMPANY_ID, USER_ID, EST_ID, {
            tax_rate: '8.25',
        });

        expect(updated.items).toEqual(persistedItems);
        expect(mockQueries.replaceEstimateItems).not.toHaveBeenCalled();
    });

    it('an explicit empty items array clears every line item', async () => {
        mockQueries.getEstimateById.mockResolvedValue(estimate({ summary: 'Summary-only scope' }));
        mockQueries.getEstimateItems.mockResolvedValue([]);
        mockQueries.updateEstimate.mockResolvedValue(estimate({ summary: 'Summary-only scope' }));

        await service.updateEstimate(COMPANY_ID, USER_ID, EST_ID, { items: [] });

        expect(mockQueries.replaceEstimateItems).toHaveBeenCalledWith(
            COMPANY_ID,
            EST_ID,
            [],
            null
        );
    });

    it('rejects a present non-array items value instead of treating it as omission', async () => {
        mockQueries.getEstimateById.mockResolvedValue(estimate({ summary: 'Existing scope' }));

        await expect(service.updateEstimate(COMPANY_ID, USER_ID, EST_ID, {
            items: null,
        })).rejects.toMatchObject({
            code: 'VALIDATION',
            httpStatus: 400,
            message: 'items must be an array',
        });
        expect(mockQueries.updateEstimate).not.toHaveBeenCalled();
        expect(mockQueries.replaceEstimateItems).not.toHaveBeenCalled();
    });

    it('a summary-only partial update never replaces line items', async () => {
        const persistedItems = [item()];
        mockQueries.getEstimateById.mockResolvedValue(estimate({ summary: 'Old summary' }));
        mockQueries.getEstimateItems.mockResolvedValue(persistedItems);
        mockQueries.updateEstimate.mockResolvedValue(estimate({ summary: 'New summary' }));

        await service.updateEstimate(COMPANY_ID, USER_ID, EST_ID, {
            summary: 'New summary',
        });

        expect(mockQueries.updateEstimate).toHaveBeenCalledWith(
            EST_ID,
            COMPANY_ID,
            expect.not.objectContaining({ items: expect.anything() }),
            null
        );
        expect(mockQueries.replaceEstimateItems).not.toHaveBeenCalled();
    });

    it('normalizes numeric item strings and treats only boolean true as taxable', async () => {
        mockQueries.getEstimateById.mockResolvedValue(estimate());

        await service.addItem(COMPANY_ID, EST_ID, USER_ID, {
            name: 'Capacitor',
            quantity: '2.5',
            unit_price: '19.95',
            taxable: 'true',
        });

        expect(mockQueries.addEstimateItem).toHaveBeenCalledWith(
            COMPANY_ID,
            EST_ID,
            expect.objectContaining({
                quantity: 2.5,
                unit_price: 19.95,
                taxable: false,
            }),
            null
        );
    });

    it('emits one coarse updated event for the whole-document Save and none for item sub-endpoints', async () => {
        mockQueries.getEstimateById.mockResolvedValue(estimate({ job_id: 519, contact_id: 9 }));
        mockQueries.getEstimateItems.mockResolvedValue([item()]);
        mockQueries.updateEstimate.mockResolvedValue(estimate({ job_id: 519, contact_id: 9 }));

        await service.updateEstimate(
            COMPANY_ID,
            USER_ID,
            EST_ID,
            { summary: 'Saved once', items: [item()] },
            TX_CLIENT,
            HUMAN_ACTOR
        );

        expect(mockLogFinancialActivity).toHaveBeenCalledTimes(1);
        expect(mockLogFinancialActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'estimate.updated',
                entityType: 'estimate',
                actor: HUMAN_ACTOR,
            }),
            { client: TX_CLIENT }
        );

        mockLogFinancialActivity.mockClear();
        await service.addItem(
            COMPANY_ID,
            EST_ID,
            USER_ID,
            { name: 'Added', quantity: 1, unit_price: 10 },
            TX_CLIENT
        );
        await service.updateItem(
            COMPANY_ID,
            EST_ID,
            USER_ID,
            item().id,
            { unit_price: 11 },
            TX_CLIENT
        );
        await service.removeItem(
            COMPANY_ID,
            EST_ID,
            USER_ID,
            item().id,
            TX_CLIENT
        );

        expect(mockLogFinancialActivity).not.toHaveBeenCalled();
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

        expect(mockQueries.archiveEstimate).toHaveBeenCalledWith(
            EST_ID,
            COMPANY_ID,
            USER_ID,
            null
        );
        expect(mockQueries.restoreEstimate).toHaveBeenCalledWith(
            EST_ID,
            COMPANY_ID,
            USER_ID,
            null
        );
    });
});
