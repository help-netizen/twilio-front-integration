/**
 * Tests for PF100-S4T1-BE: estimatesService.convertToInvoice()
 */

const COMPANY_ID = 'company-uuid-001';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EST_ID = 42;
const INVOICE_ID = 99;

// ─── Mock DB query modules ────────────────────────────────────────────────────

const mockTxQuery = jest.fn();
const mockRelease = jest.fn();
const mockClient = { query: mockTxQuery, release: mockRelease };

jest.mock('../backend/src/db/connection', () => ({
    pool: { connect: jest.fn(async () => mockClient) },
    query: jest.fn(),
}));

const mockLockEstimateForConversion = jest.fn();
const mockGetEstimateById = jest.fn();
const mockGetEstimateItems = jest.fn();
const mockCreateEvent_est = jest.fn();
const mockCreateRevision = jest.fn();
const mockUpdateEstimate = jest.fn();
const mockGetConversionEventForUndo = jest.fn();

jest.mock('../backend/src/db/estimatesQueries', () => ({
    lockEstimateForConversion: (...args) => mockLockEstimateForConversion(...args),
    getEstimateById: (...args) => mockGetEstimateById(...args),
    getEstimateItems: (...args) => mockGetEstimateItems(...args),
    getConversionEventForUndo: (...args) => mockGetConversionEventForUndo(...args),
    getJobContext: jest.fn(),
    getLeadContext: jest.fn(),
    createRevision: (...args) => mockCreateRevision(...args),
    createEvent: (...args) => mockCreateEvent_est(...args),
    listEstimates: jest.fn(),
    createEstimate: jest.fn(),
    updateEstimate: (...args) => mockUpdateEstimate(...args),
    deleteEstimate: jest.fn(),
}));

const mockCreateInvoice = jest.fn();
const mockAddInvoiceItem = jest.fn();
const mockRecalculateTotals = jest.fn();
const mockCreateEvent_inv = jest.fn();
const mockNextInvoiceSequence = jest.fn();
const mockLockInvoiceById = jest.fn();
const mockGetConversionUndoBlockers = jest.fn();
const mockDeleteConvertedInvoice = jest.fn();

jest.mock('../backend/src/db/invoicesQueries', () => ({
    nextInvoiceSequence: (...args) => mockNextInvoiceSequence(...args),
    buildInvoiceNumber: jest.fn(() => 'INVOICE 1'),
    createInvoice: (...args) => mockCreateInvoice(...args),
    addInvoiceItem: (...args) => mockAddInvoiceItem(...args),
    recalculateInvoiceTotals: (...args) => mockRecalculateTotals(...args),
    createEvent: (...args) => mockCreateEvent_inv(...args),
    lockInvoiceById: (...args) => mockLockInvoiceById(...args),
    getConversionUndoBlockers: (...args) => mockGetConversionUndoBlockers(...args),
    deleteConvertedInvoice: (...args) => mockDeleteConvertedInvoice(...args),
}));

const mockGetInvoice = jest.fn();
jest.mock('../backend/src/services/invoicesService', () => ({
    getInvoice: (...args) => mockGetInvoice(...args),
}));
jest.mock('../backend/src/services/documentTemplatesService', () => ({
    resolveTemplate: jest.fn(async () => ({
        invoice_settings: { default_due_days: 14 },
    })),
}));
const mockLogFinancialActivity = jest.fn();
const mockEmit = jest.fn();
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: (...args) => mockLogFinancialActivity(...args),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: (...args) => mockEmit(...args),
}));

// ─── Load service after mocks ─────────────────────────────────────────────────

const {
    convertToInvoice,
    undoInvoiceConversion,
} = require('../backend/src/services/estimatesService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEstimate(overrides = {}) {
    return {
        id: EST_ID,
        estimate_number: 'ESTIMATE 519-1',
        status: 'approved',
        invoice_id: null,
        archived_at: null,
        accepted_at: null,
        approved_snapshot: null,
        signature_name: null,
        signature_consented_at: null,
        signature_required: false,
        updated_at: '2026-08-15T12:00:00.000Z',
        contact_id: 7,
        lead_id: null,
        job_id: null,
        title: 'Roof Repair',
        notes: '',
        internal_note: '',
        tax_rate: '0.00',
        discount_type: null,
        discount_value: '0.00',
        discount_amount: '0.00',
        currency: 'USD',
        order_list: [{
            part_number: 'P-42',
            part_name: 'Roof bracket',
            quantity: 2,
        }],
        ...overrides,
    };
}

function makeItem(n = 1) {
    return {
        name: `Item ${n}`,
        description: `Desc ${n}`,
        quantity: '1',
        unit: 'hr',
        unit_price: '100.00',
        amount: '100.00',
        taxable: false,
        sort_order: n,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('estimatesService.convertToInvoice', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTxQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        mockLockEstimateForConversion.mockResolvedValue({ id: EST_ID });
        mockNextInvoiceSequence.mockResolvedValue(1);
        mockCreateInvoice.mockResolvedValue({ id: INVOICE_ID });
        mockAddInvoiceItem.mockResolvedValue({});
        mockRecalculateTotals.mockResolvedValue({});
        mockCreateEvent_est.mockResolvedValue({
            id: 701,
            created_at: '2026-08-15T12:00:01.000Z',
        });
        mockCreateEvent_inv.mockResolvedValue({});
        mockCreateRevision.mockResolvedValue({ id: 702 });
        mockUpdateEstimate.mockImplementation(async (_id, _companyId, patch) => makeEstimate({
            ...patch,
            invoice_id: patch.status ? null : undefined,
            updated_at: '2026-08-15T12:00:00.000Z',
        }));
        mockGetInvoice.mockResolvedValue({
            id: INVOICE_ID,
            estimate_id: EST_ID,
            status: 'draft',
            amount_paid: '0.00',
            job_payment_allocated: '0.00',
            sent_at: null,
            updated_at: '2026-08-15T12:00:00.000Z',
        });
        mockLockInvoiceById.mockResolvedValue({ id: INVOICE_ID, status: 'draft' });
        mockGetConversionEventForUndo.mockResolvedValue({
            id: 701,
            created_at: '2026-08-15T12:00:01.000Z',
            undo_expired: false,
            metadata: {
                invoice_id: INVOICE_ID,
                previous_status: 'sent',
                previous_accepted_at: null,
                previous_approved_snapshot: null,
                previous_signature_name: null,
                previous_signature_consented_at: null,
                estimate_updated_at: '2026-08-15T12:00:00.000Z',
                invoice_updated_at: '2026-08-15T12:00:00.000Z',
            },
        });
        mockGetConversionUndoBlockers.mockResolvedValue({
            linked_invoice_count: 1,
            has_payment_activity: false,
            has_payment_session: false,
            has_revision: false,
            has_task: false,
            has_generation_link: false,
            has_unexpected_event: false,
        });
        mockDeleteConvertedInvoice.mockResolvedValue({ id: INVOICE_ID });
        mockLogFinancialActivity.mockResolvedValue({ ok: true });
        mockEmit.mockResolvedValue({ id: 703 });
    });

    it('TC-S4T1-01: creates invoice and copies line items from approved estimate', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate({
            discount_type: 'percentage',
            discount_value: '10.00',
            discount_amount: '20.00',
        }));
        mockGetEstimateItems.mockResolvedValue([makeItem(1), makeItem(2)]);

        const result = await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

        expect(mockCreateInvoice).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({
            contact_id: 7,
            estimate_id: EST_ID,
            invoice_number: 'INVOICE 519-1',
            title: 'ESTIMATE 519-1',
            discount_type: 'percentage',
            discount_value: '10.00',
            discount_amount: '20.00',
            order_list: [{
                part_number: 'P-42',
                part_name: 'Roof bracket',
                quantity: 2,
            }],
        }), mockClient);
        expect(mockAddInvoiceItem).toHaveBeenCalledTimes(2);
        expect(mockRecalculateTotals).toHaveBeenCalledWith(COMPANY_ID, INVOICE_ID, mockClient);
        expect(result).toMatchObject({
            id: INVOICE_ID,
            already_converted: false,
            marked_approved: false,
        });
        // Only optional template enrichment needs a savepoint; conversion copies
        // the source estimate number directly.
        expect(mockTxQuery.mock.calls.map(([sql]) => sql)).toEqual([
            'BEGIN',
            'SAVEPOINT conversion_due_date',
            'RELEASE SAVEPOINT conversion_due_date',
            'COMMIT',
        ]);
    });

    it('preserves the visible document number across Estimate to Invoice conversion', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate({
            estimate_number: 'ESTIMATE L1234-2',
        }));
        mockGetEstimateItems.mockResolvedValue([]);

        await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

        expect(mockCreateInvoice).toHaveBeenCalledWith(
            COMPANY_ID,
            expect.objectContaining({ invoice_number: 'INVOICE L1234-2' }),
            mockClient
        );
        expect(mockNextInvoiceSequence).not.toHaveBeenCalled();
    });

    it('TC-S4T1-02: logs events on both estimate and invoice', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate());
        mockGetEstimateItems.mockResolvedValue([]);

        await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

        expect(mockCreateEvent_inv).toHaveBeenCalledWith(COMPANY_ID, INVOICE_ID, 'created_from_estimate', 'user', USER_ID, { estimate_id: EST_ID }, mockClient);
        expect(mockCreateEvent_est).toHaveBeenCalledWith(
            COMPANY_ID,
            EST_ID,
            'converted_to_invoice',
            'user',
            USER_ID,
            expect.objectContaining({
                invoice_id: INVOICE_ID,
                previous_status: 'approved',
                approval_recorded: false,
                undo_window_seconds: 300,
            }),
            mockClient
        );
    });

    it('TC-S4T1-03: returns 404 when estimate not found', async () => {
        mockLockEstimateForConversion.mockResolvedValue(null);

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    it.each(['draft', 'sent', 'viewed', 'approved'])(
        'converts from live status %s and records internal approval only when needed',
        async status => {
            mockGetEstimateById.mockResolvedValue(makeEstimate({ status }));
            mockGetEstimateItems.mockResolvedValue([makeItem()]);

            const result = await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

            expect(result.marked_approved).toBe(status !== 'approved');
            expect(mockCreateInvoice).toHaveBeenCalledTimes(1);
            if (status === 'approved') {
                expect(mockCreateRevision).not.toHaveBeenCalled();
                expect(mockUpdateEstimate).not.toHaveBeenCalled();
                expect(mockCreateEvent_est).not.toHaveBeenCalledWith(
                    COMPANY_ID,
                    EST_ID,
                    'approved',
                    expect.anything(),
                    expect.anything(),
                    expect.anything(),
                    expect.anything()
                );
            } else {
                expect(mockCreateRevision).toHaveBeenCalledWith(
                    COMPANY_ID,
                    EST_ID,
                    expect.objectContaining({ status: 'approved', items: [makeItem()] }),
                    USER_ID,
                    mockClient
                );
                expect(mockUpdateEstimate).toHaveBeenCalledWith(
                    EST_ID,
                    COMPANY_ID,
                    expect.objectContaining({ status: 'approved', updated_by: USER_ID }),
                    mockClient
                );
                expect(mockCreateEvent_est).toHaveBeenCalledWith(
                    COMPANY_ID,
                    EST_ID,
                    'approved',
                    'user',
                    USER_ID,
                    expect.objectContaining({
                        source: 'internal_conversion',
                        recorded_internally: true,
                    }),
                    mockClient
                );
            }
        }
    );

    it('refuses declined conversion without approval or invoice side effects', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate({ status: 'declined' }));

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'INVALID_STATUS', httpStatus: 409 });
        expect(mockCreateRevision).not.toHaveBeenCalled();
        expect(mockUpdateEstimate).not.toHaveBeenCalled();
        expect(mockCreateInvoice).not.toHaveBeenCalled();
    });

    it('TC-S4T1-05: returns the existing invoice idempotently when already converted', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate({ invoice_id: 55 }));
        mockGetInvoice.mockResolvedValue({ id: 55, status: 'draft' });

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID))
            .resolves.toMatchObject({
                id: 55,
                status: 'draft',
                already_converted: true,
            });
        expect(mockGetInvoice).toHaveBeenCalledWith(COMPANY_ID, 55, mockClient);
        expect(mockCreateInvoice).not.toHaveBeenCalled();
    });

    it('TC-S4T1-06: company isolation — only fetches estimate by companyId', async () => {
        mockLockEstimateForConversion.mockResolvedValue(null); // different company → not found
        mockGetEstimateItems.mockResolvedValue([]);

        await expect(convertToInvoice('other-company', USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });

        expect(mockLockEstimateForConversion).toHaveBeenCalledWith(
            'other-company',
            EST_ID,
            mockClient
        );
        expect(mockCreateInvoice).not.toHaveBeenCalled();
    });

    it('TC-S4T1-07: works when estimate has no items (empty invoice created)', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate());
        mockGetEstimateItems.mockResolvedValue([]);

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID)).resolves.toBeDefined();
        expect(mockAddInvoiceItem).not.toHaveBeenCalled();
        expect(mockRecalculateTotals).toHaveBeenCalledWith(COMPANY_ID, INVOICE_ID, mockClient);
    });

    it('returns the live serialized invoice after totals without claiming Job payments', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate({ job_id: 73 }));
        mockGetEstimateItems.mockResolvedValue([makeItem()]);
        mockCreateInvoice.mockResolvedValue({ id: INVOICE_ID, job_id: 73 });

        await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

        expect(mockRecalculateTotals).toHaveBeenCalledWith(
            COMPANY_ID,
            INVOICE_ID,
            mockClient
        );
        expect(mockRecalculateTotals.mock.invocationCallOrder[0]).toBeLessThan(
            mockGetInvoice.mock.invocationCallOrder[0]
        );
    });
});

describe('estimatesService.undoInvoiceConversion', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTxQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        mockLockEstimateForConversion.mockResolvedValue({ id: EST_ID });
        mockLockInvoiceById.mockResolvedValue({ id: INVOICE_ID, status: 'draft' });
        mockGetEstimateItems.mockResolvedValue([makeItem()]);
        mockGetInvoice.mockResolvedValue({
            id: INVOICE_ID,
            estimate_id: EST_ID,
            status: 'draft',
            amount_paid: '0.00',
            job_payment_allocated: '0.00',
            sent_at: null,
            updated_at: '2026-08-15T12:00:00.000Z',
        });
        mockGetConversionEventForUndo.mockResolvedValue({
            id: 701,
            created_at: '2026-08-15T12:00:01.000Z',
            undo_expired: false,
            metadata: {
                invoice_id: INVOICE_ID,
                previous_status: 'sent',
                previous_accepted_at: null,
                previous_approved_snapshot: null,
                previous_signature_name: null,
                previous_signature_consented_at: null,
                estimate_updated_at: '2026-08-15T12:00:00.000Z',
                invoice_updated_at: '2026-08-15T12:00:00.000Z',
            },
        });
        mockGetConversionUndoBlockers.mockResolvedValue({
            linked_invoice_count: 1,
            has_payment_activity: false,
            has_payment_session: false,
            has_revision: false,
            has_task: false,
            has_generation_link: false,
            has_unexpected_event: false,
        });
        mockDeleteConvertedInvoice.mockResolvedValue({ id: INVOICE_ID });
        mockUpdateEstimate.mockResolvedValue(makeEstimate({
            status: 'sent',
            invoice_id: null,
            updated_at: '2026-08-15T12:00:02.000Z',
        }));
        mockCreateEvent_est.mockResolvedValue({ id: 704 });
        mockLogFinancialActivity.mockResolvedValue({ ok: true });
    });

    function currentEstimate(overrides = {}) {
        return makeEstimate({
            status: 'approved',
            invoice_id: INVOICE_ID,
            accepted_at: '2026-08-15T12:00:00.000Z',
            updated_at: '2026-08-15T12:00:00.000Z',
            ...overrides,
        });
    }

    it('deletes the untouched invoice, restores the exact prior approval fields, and records the actor', async () => {
        mockGetEstimateById
            .mockResolvedValueOnce(currentEstimate())
            .mockResolvedValueOnce(makeEstimate({ status: 'sent', invoice_id: null }));

        const result = await undoInvoiceConversion(
            COMPANY_ID,
            USER_ID,
            EST_ID,
            INVOICE_ID,
            mockClient
        );

        expect(mockDeleteConvertedInvoice).toHaveBeenCalledWith(
            COMPANY_ID,
            INVOICE_ID,
            EST_ID,
            mockClient
        );
        expect(mockUpdateEstimate).toHaveBeenCalledWith(
            EST_ID,
            COMPANY_ID,
            {
                status: 'sent',
                accepted_at: null,
                approved_snapshot: null,
                signature_name: null,
                signature_consented_at: null,
                updated_by: USER_ID,
            },
            mockClient
        );
        expect(mockCreateEvent_est).toHaveBeenCalledWith(
            COMPANY_ID,
            EST_ID,
            'conversion_undone',
            'user',
            USER_ID,
            expect.objectContaining({
                invoice_id: INVOICE_ID,
                restored_status: 'sent',
                source: 'internal_undo',
                conversion_event_id: 701,
            }),
            mockClient
        );
        expect(result).toMatchObject({
            invoice_id: INVOICE_ID,
            undone: true,
            estimate: { status: 'sent', invoice_id: null },
        });
    });

    it('refuses when any payment activity is allocated', async () => {
        mockGetEstimateById.mockResolvedValue(currentEstimate());
        mockGetConversionUndoBlockers.mockResolvedValue({
            linked_invoice_count: 1,
            has_payment_activity: true,
        });

        await expect(undoInvoiceConversion(
            COMPANY_ID, USER_ID, EST_ID, INVOICE_ID, mockClient
        )).rejects.toMatchObject({
            code: 'CONVERSION_UNDO_PAYMENT_ALLOCATED',
            httpStatus: 409,
        });
        expect(mockDeleteConvertedInvoice).not.toHaveBeenCalled();
        expect(mockUpdateEstimate).not.toHaveBeenCalled();
    });

    it('refuses when a Job payment pool is allocated without a direct invoice payment row', async () => {
        mockGetEstimateById.mockResolvedValue(currentEstimate());
        mockGetInvoice.mockResolvedValue({
            id: INVOICE_ID,
            estimate_id: EST_ID,
            status: 'partial',
            amount_paid: '25.00',
            job_payment_allocated: '25.00',
            sent_at: null,
            updated_at: '2026-08-15T12:00:00.000Z',
        });

        await expect(undoInvoiceConversion(
            COMPANY_ID, USER_ID, EST_ID, INVOICE_ID, mockClient
        )).rejects.toMatchObject({ code: 'CONVERSION_UNDO_PAYMENT_ALLOCATED' });
        expect(mockDeleteConvertedInvoice).not.toHaveBeenCalled();
    });

    it('refuses a sent invoice', async () => {
        mockGetEstimateById.mockResolvedValue(currentEstimate());
        mockLockInvoiceById.mockResolvedValue({ id: INVOICE_ID, status: 'sent' });

        await expect(undoInvoiceConversion(
            COMPANY_ID, USER_ID, EST_ID, INVOICE_ID, mockClient
        )).rejects.toMatchObject({
            code: 'CONVERSION_UNDO_INVOICE_SENT',
            httpStatus: 409,
        });
        expect(mockDeleteConvertedInvoice).not.toHaveBeenCalled();
    });

    it('refuses a voided invoice', async () => {
        mockGetEstimateById.mockResolvedValue(currentEstimate());
        mockLockInvoiceById.mockResolvedValue({ id: INVOICE_ID, status: 'void' });

        await expect(undoInvoiceConversion(
            COMPANY_ID, USER_ID, EST_ID, INVOICE_ID, mockClient
        )).rejects.toMatchObject({
            code: 'CONVERSION_UNDO_INVOICE_VOIDED',
            httpStatus: 409,
        });
        expect(mockDeleteConvertedInvoice).not.toHaveBeenCalled();
    });

    it.each([
        ['invoice timestamp changed', () => mockGetInvoice.mockResolvedValue({
            id: INVOICE_ID,
            estimate_id: EST_ID,
            status: 'draft',
            amount_paid: 0,
            sent_at: null,
            updated_at: '2026-08-15T12:00:03.000Z',
        })],
        ['invoice update event exists', () => mockGetConversionUndoBlockers.mockResolvedValue({
            linked_invoice_count: 1,
            has_unexpected_event: true,
        })],
    ])('refuses an edited invoice when %s', async (_label, arrange) => {
        mockGetEstimateById.mockResolvedValue(currentEstimate());
        arrange();

        await expect(undoInvoiceConversion(
            COMPANY_ID, USER_ID, EST_ID, INVOICE_ID, mockClient
        )).rejects.toMatchObject({
            code: 'CONVERSION_UNDO_INVOICE_CHANGED',
            httpStatus: 409,
        });
        expect(mockDeleteConvertedInvoice).not.toHaveBeenCalled();
    });

    it('refuses a stale toast that names the wrong invoice', async () => {
        mockGetEstimateById.mockResolvedValue(currentEstimate({ invoice_id: 100 }));

        await expect(undoInvoiceConversion(
            COMPANY_ID, USER_ID, EST_ID, INVOICE_ID, mockClient
        )).rejects.toMatchObject({
            code: 'CONVERSION_UNDO_MISMATCH',
            httpStatus: 409,
        });
        expect(mockLockInvoiceById).not.toHaveBeenCalled();
        expect(mockDeleteConvertedInvoice).not.toHaveBeenCalled();
    });

    it('refuses after the database-enforced five-minute window expires', async () => {
        mockGetEstimateById.mockResolvedValue(currentEstimate());
        mockGetConversionEventForUndo.mockResolvedValue({
            id: 701,
            undo_expired: true,
            metadata: { previous_status: 'sent' },
        });

        await expect(undoInvoiceConversion(
            COMPANY_ID, USER_ID, EST_ID, INVOICE_ID, mockClient
        )).rejects.toMatchObject({
            code: 'CONVERSION_UNDO_EXPIRED',
            httpStatus: 409,
        });
        expect(mockGetInvoice).not.toHaveBeenCalled();
        expect(mockDeleteConvertedInvoice).not.toHaveBeenCalled();
    });

    it('returns 404 for a foreign estimate without locking or changing its invoice', async () => {
        mockLockEstimateForConversion.mockResolvedValue(null);

        await expect(undoInvoiceConversion(
            'foreign-company', USER_ID, EST_ID, INVOICE_ID, mockClient
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(mockLockEstimateForConversion).toHaveBeenCalledWith(
            'foreign-company',
            EST_ID,
            mockClient
        );
        expect(mockLockInvoiceById).not.toHaveBeenCalled();
        expect(mockDeleteConvertedInvoice).not.toHaveBeenCalled();
    });
});
