/**
 * Tests for PF100-S4T1-BE: estimatesService.convertToInvoice()
 */

const COMPANY_ID = 'company-uuid-001';
const USER_ID = 'user-sub-001';
const EST_ID = 42;

// ─── Mock DB query modules ────────────────────────────────────────────────────

const mockGetEstimateById = jest.fn();
const mockGetEstimateItems = jest.fn();
const mockCreateEvent_est = jest.fn();

jest.mock('../backend/src/db/estimatesQueries', () => ({
    getEstimateById: (...args) => mockGetEstimateById(...args),
    getEstimateItems: (...args) => mockGetEstimateItems(...args),
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

jest.mock('../backend/src/db/invoicesQueries', () => ({
    createInvoice: (...args) => mockCreateInvoice(...args),
    addInvoiceItem: (...args) => mockAddInvoiceItem(...args),
    recalculateInvoiceTotals: (...args) => mockRecalculateTotals(...args),
    createEvent: (...args) => mockCreateEvent_inv(...args),
}));

const mockGetInvoice = jest.fn();
jest.mock('../backend/src/services/invoicesService', () => ({
    getInvoice: (...args) => mockGetInvoice(...args),
}));

// ─── Load service after mocks ─────────────────────────────────────────────────

const { convertToInvoice, EstimatesServiceError } = require('../backend/src/services/estimatesService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEstimate(overrides = {}) {
    return {
        id: EST_ID,
        status: 'accepted',
        invoice_id: null,
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
        mockCreateInvoice.mockResolvedValue({ id: 99 });
        mockAddInvoiceItem.mockResolvedValue({});
        mockRecalculateTotals.mockResolvedValue({});
        mockCreateEvent_est.mockResolvedValue({});
        mockCreateEvent_inv.mockResolvedValue({});
        mockGetInvoice.mockResolvedValue({ id: 99, status: 'draft' });
    });

    it('TC-S4T1-01: creates invoice and copies line items from accepted estimate', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate());
        mockGetEstimateItems.mockResolvedValue([makeItem(1), makeItem(2)]);

        const result = await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

        expect(mockCreateInvoice).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({
            contact_id: 7,
            estimate_id: EST_ID,
            title: 'Roof Repair',
        }));
        expect(mockAddInvoiceItem).toHaveBeenCalledTimes(2);
        expect(mockRecalculateTotals).toHaveBeenCalledWith(99);
        expect(result).toMatchObject({ id: 99 });
    });

    it('TC-S4T1-02: logs events on both estimate and invoice', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate());
        mockGetEstimateItems.mockResolvedValue([]);

        await convertToInvoice(COMPANY_ID, USER_ID, EST_ID);

        expect(mockCreateEvent_inv).toHaveBeenCalledWith(99, 'created_from_estimate', 'user', USER_ID, { estimate_id: EST_ID });
        expect(mockCreateEvent_est).toHaveBeenCalledWith(EST_ID, 'converted_to_invoice', 'user', USER_ID, { invoice_id: 99 });
    });

    it('TC-S4T1-03: returns 404 when estimate not found', async () => {
        mockGetEstimateById.mockResolvedValue(null);

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    it('TC-S4T1-04: returns 400 when estimate is not accepted (status=draft)', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate({ status: 'draft' }));

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'INVALID_STATUS', httpStatus: 400 });
    });

    it('TC-S4T1-05: returns 409 when estimate already has an invoice', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate({ invoice_id: 55 }));

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'ALREADY_CONVERTED', httpStatus: 409 });
    });

    it('TC-S4T1-06: company isolation — only fetches estimate by companyId', async () => {
        mockGetEstimateById.mockResolvedValue(null); // different company → not found
        mockGetEstimateItems.mockResolvedValue([]);

        await expect(convertToInvoice('other-company', USER_ID, EST_ID))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });

        expect(mockGetEstimateById).toHaveBeenCalledWith('other-company', EST_ID);
        expect(mockCreateInvoice).not.toHaveBeenCalled();
    });

    it('TC-S4T1-07: works when estimate has no items (empty invoice created)', async () => {
        mockGetEstimateById.mockResolvedValue(makeEstimate());
        mockGetEstimateItems.mockResolvedValue([]);

        await expect(convertToInvoice(COMPANY_ID, USER_ID, EST_ID)).resolves.toBeDefined();
        expect(mockAddInvoiceItem).not.toHaveBeenCalled();
        expect(mockRecalculateTotals).toHaveBeenCalledWith(99);
    });
});
