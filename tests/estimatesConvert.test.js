/**
 * Tests for PF100-S4T1-BE: estimatesService.convertToInvoice()
 */

const COMPANY_ID = 'company-uuid-001';
const USER_ID = 'user-sub-001';
const EST_ID = 42;

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

jest.mock('../backend/src/db/estimatesQueries', () => ({
    lockEstimateForConversion: (...args) => mockLockEstimateForConversion(...args),
    getEstimateById: (...args) => mockGetEstimateById(...args),
    getEstimateItems: (...args) => mockGetEstimateItems(...args),
    getJobContext: jest.fn(),
    getLeadContext: jest.fn(),
    createEvent: (...args) => mockCreateEvent_est(...args),
    listEstimates: jest.fn(),
    createEstimate: jest.fn(),
    updateEstimate: jest.fn(),
    deleteEstimate: jest.fn(),
}));

const mockCreateInvoice = jest.fn();
const mockAddInvoiceItem = jest.fn();
const mockRecalculateTotals = jest.fn();
const mockCreateEvent_inv = jest.fn();
const mockNextInvoiceSequence = jest.fn();

jest.mock('../backend/src/db/invoicesQueries', () => ({
    nextInvoiceSequence: (...args) => mockNextInvoiceSequence(...args),
    buildInvoiceNumber: jest.fn(() => 'INVOICE 1'),
    createInvoice: (...args) => mockCreateInvoice(...args),
    addInvoiceItem: (...args) => mockAddInvoiceItem(...args),
    recalculateInvoiceTotals: (...args) => mockRecalculateTotals(...args),
    createEvent: (...args) => mockCreateEvent_inv(...args),
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

// ─── Load service after mocks ─────────────────────────────────────────────────

const { convertToInvoice, EstimatesServiceError } = require('../backend/src/services/estimatesService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEstimate(overrides = {}) {
    return {
        id: EST_ID,
        estimate_number: 'ESTIMATE 519-1',
        status: 'approved',
        invoice_id: null,
        archived_at: null,
        contact_id: 7,
        lead_id: null,
        job_id: null,
        title: 'Roof Repair',
        notes: '',
        internal_note: '',
        tax_rate: '0.00',
        discount_amount: '0.00',
        currency: 'USD',
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
        mockCreateInvoice.mockResolvedValue({ id: 99 });
        mockAddInvoiceItem.mockResolvedValue({});
        mockRecalculateTotals.mockResolvedValue({});
        mockCreateEvent_est.mockResolvedValue({});
        mockCreateEvent_inv.mockResolvedValue({});
        mockGetInvoice.mockResolvedValue({ id: 99, status: 'draft' });
    });

    it('TC-S4T1-01: creates invoice and copies line items from approved estimate', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate());
        mockGetEstimateItems.mockResolvedValue([makeItem(1), makeItem(2)]);

        const result = await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

        expect(mockCreateInvoice).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({
            contact_id: 7,
            estimate_id: EST_ID,
            title: 'ESTIMATE 519-1',
        }), mockClient);
        expect(mockAddInvoiceItem).toHaveBeenCalledTimes(2);
        expect(mockRecalculateTotals).toHaveBeenCalledWith(COMPANY_ID, 99, mockClient);
        expect(result).toMatchObject({ id: 99, already_converted: false });
        // The optional enrichment blocks (template due-date, invoice number) are
        // savepoint-protected so their failure can never poison the transaction.
        expect(mockTxQuery.mock.calls.map(([sql]) => sql)).toEqual([
            'BEGIN',
            'SAVEPOINT conversion_due_date',
            'RELEASE SAVEPOINT conversion_due_date',
            'SAVEPOINT conversion_invoice_number',
            'RELEASE SAVEPOINT conversion_invoice_number',
            'COMMIT',
        ]);
    });

    it('TC-S4T1-02: logs events on both estimate and invoice', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate());
        mockGetEstimateItems.mockResolvedValue([]);

        await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

        expect(mockCreateEvent_inv).toHaveBeenCalledWith(COMPANY_ID, 99, 'created_from_estimate', 'user', USER_ID, { estimate_id: EST_ID }, mockClient);
        expect(mockCreateEvent_est).toHaveBeenCalledWith(COMPANY_ID, EST_ID, 'converted_to_invoice', 'user', USER_ID, { invoice_id: 99 }, mockClient);
    });

    it('TC-S4T1-03: returns 404 when estimate not found', async () => {
        mockLockEstimateForConversion.mockResolvedValue(null);

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    it('TC-S4T1-04: returns 400 when estimate is not approved (status=draft)', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate({ status: 'draft' }));

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'INVALID_STATUS', httpStatus: 400 });
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
        expect(mockRecalculateTotals).toHaveBeenCalledWith(COMPANY_ID, 99, mockClient);
    });
});
