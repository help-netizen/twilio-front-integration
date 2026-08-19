'use strict';

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID = 501;
const TX_CLIENT = { query: jest.fn() };

const mockQueries = {
    getInvoiceById: jest.fn(),
    getInvoiceItems: jest.fn(),
    getContactContext: jest.fn(),
    createInvoice: jest.fn(),
    updateInvoice: jest.fn(),
    addInvoiceItem: jest.fn(),
    recalculateInvoiceTotals: jest.fn(),
    createRevision: jest.fn(),
    createEvent: jest.fn(),
};

jest.mock('../backend/src/db/invoicesQueries', () => ({
    getInvoiceById: (...args) => mockQueries.getInvoiceById(...args),
    getInvoiceItems: (...args) => mockQueries.getInvoiceItems(...args),
    createInvoice: (...args) => mockQueries.createInvoice(...args),
    updateInvoice: (...args) => mockQueries.updateInvoice(...args),
    addInvoiceItem: (...args) => mockQueries.addInvoiceItem(...args),
    recalculateInvoiceTotals: (...args) => mockQueries.recalculateInvoiceTotals(...args),
    createRevision: (...args) => mockQueries.createRevision(...args),
    createEvent: (...args) => mockQueries.createEvent(...args),
}));
jest.mock('../backend/src/db/estimatesQueries', () => ({
    getContactContext: (...args) => mockQueries.getContactContext(...args),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: jest.fn(),
}));

const invoicesService = require('../backend/src/services/invoicesService');

function invoice(overrides = {}) {
    return {
        id: INVOICE_ID,
        company_id: COMPANY_A,
        invoice_number: 'INVOICE 42-1',
        contact_id: 7,
        status: 'draft',
        tax_rate: '0',
        discount_type: null,
        discount_value: '0',
        discount_amount: '0',
        ...overrides,
    };
}

const ITEMS = [
    { name: 'Labor', quantity: 2, unit_price: 50, taxable: true },
    { name: 'Part', quantity: 1, unit_price: 25, taxable: false },
];

beforeEach(() => {
    jest.clearAllMocks();
    mockQueries.getInvoiceById.mockResolvedValue(invoice());
    mockQueries.getInvoiceItems.mockResolvedValue(ITEMS);
    mockQueries.getContactContext.mockResolvedValue({ id: 7, company_id: COMPANY_A });
    mockQueries.createInvoice.mockResolvedValue(invoice());
    mockQueries.updateInvoice.mockResolvedValue(invoice());
    mockQueries.addInvoiceItem.mockResolvedValue({ id: 1 });
    mockQueries.recalculateInvoiceTotals.mockResolvedValue(invoice());
    mockQueries.createRevision.mockResolvedValue({ id: 1 });
    mockQueries.createEvent.mockResolvedValue({ id: 1 });
});

describe('invoice discount create contract', () => {
    test.each([
        ['fixed', '25', 25],
        ['percentage', '12.5', 12.5],
    ])('accepts and normalizes a %s discount', async (discountType, inputValue, storedValue) => {
        await invoicesService.createInvoice(COMPANY_A, USER_ID, {
            contact_id: 7,
            invoice_number: 'INVOICE 42-1',
            due_date: '2026-08-31',
            discount_type: discountType,
            discount_value: inputValue,
            discount_amount: 999,
            items: ITEMS,
        }, TX_CLIENT);

        expect(mockQueries.createInvoice).toHaveBeenCalledWith(
            COMPANY_A,
            expect.objectContaining({
                discount_type: discountType,
                discount_value: storedValue,
                discount_amount: 0,
                created_by: USER_ID,
            }),
            TX_CLIENT
        );
        expect(mockQueries.recalculateInvoiceTotals).toHaveBeenCalledWith(
            COMPANY_A,
            INVOICE_ID,
            TX_CLIENT
        );
    });

    test('rejects a percentage over 100 before any write', async () => {
        await expect(invoicesService.createInvoice(COMPANY_A, USER_ID, {
            contact_id: 7,
            discount_type: 'percentage',
            discount_value: 100.01,
            items: ITEMS,
        }, TX_CLIENT)).rejects.toMatchObject({
            code: 'VALIDATION',
            httpStatus: 400,
            message: 'Discount percentage cannot exceed 100',
        });

        expect(mockQueries.createInvoice).not.toHaveBeenCalled();
        expect(mockQueries.addInvoiceItem).not.toHaveBeenCalled();
    });

    test('rejects a fixed discount over the submitted item subtotal', async () => {
        await expect(invoicesService.createInvoice(COMPANY_A, USER_ID, {
            contact_id: 7,
            discount_type: 'fixed',
            discount_value: 125.01,
            items: ITEMS,
        }, TX_CLIENT)).rejects.toMatchObject({
            code: 'VALIDATION',
            httpStatus: 400,
            message: 'Discount cannot exceed subtotal',
        });

        expect(mockQueries.createInvoice).not.toHaveBeenCalled();
    });
});

describe('invoice discount edit contract', () => {
    test('accepts type/value, validates against persisted items, and recalculates', async () => {
        await invoicesService.updateInvoice(COMPANY_A, USER_ID, INVOICE_ID, {
            discount_type: 'percentage',
            discount_value: '10',
            discount_amount: 999,
        }, TX_CLIENT);

        expect(mockQueries.getInvoiceItems).toHaveBeenCalledWith(
            COMPANY_A,
            INVOICE_ID,
            TX_CLIENT
        );
        expect(mockQueries.updateInvoice).toHaveBeenCalledWith(
            INVOICE_ID,
            COMPANY_A,
            expect.objectContaining({
                discount_type: 'percentage',
                discount_value: 10,
                discount_amount: 0,
            }),
            TX_CLIENT
        );
        expect(mockQueries.recalculateInvoiceTotals).toHaveBeenCalledWith(
            COMPANY_A,
            INVOICE_ID,
            TX_CLIENT
        );
    });

    test('accepts null as the no-discount representation and clears the derived amount', async () => {
        await invoicesService.updateInvoice(COMPANY_A, USER_ID, INVOICE_ID, {
            discount_type: null,
            discount_value: 0,
            discount_amount: 999,
        }, TX_CLIENT);

        expect(mockQueries.updateInvoice).toHaveBeenCalledWith(
            INVOICE_ID,
            COMPANY_A,
            expect.objectContaining({
                discount_type: null,
                discount_value: 0,
                discount_amount: 0,
            }),
            TX_CLIENT
        );
        expect(mockQueries.recalculateInvoiceTotals).toHaveBeenCalledWith(
            COMPANY_A,
            INVOICE_ID,
            TX_CLIENT
        );
    });

    test.each([
        ['percentage over 100', { discount_type: 'percentage', discount_value: 100.01 }],
        ['fixed value over subtotal', { discount_type: 'fixed', discount_value: 125.01 }],
    ])('rejects %s before any edit write', async (_label, patch) => {
        await expect(invoicesService.updateInvoice(
            COMPANY_A,
            USER_ID,
            INVOICE_ID,
            patch,
            TX_CLIENT
        )).rejects.toMatchObject({ code: 'VALIDATION', httpStatus: 400 });

        expect(mockQueries.updateInvoice).not.toHaveBeenCalled();
        expect(mockQueries.recalculateInvoiceTotals).not.toHaveBeenCalled();
    });

    test('keeps discount_amount-only callers working when type/value are absent', async () => {
        await invoicesService.updateInvoice(COMPANY_A, USER_ID, INVOICE_ID, {
            discount_amount: 20,
        }, TX_CLIENT);

        expect(mockQueries.updateInvoice).toHaveBeenCalledWith(
            INVOICE_ID,
            COMPANY_A,
            expect.objectContaining({ discount_amount: 20 }),
            TX_CLIENT
        );
        expect(mockQueries.recalculateInvoiceTotals).toHaveBeenCalledWith(
            COMPANY_A,
            INVOICE_ID,
            TX_CLIENT
        );
    });

    test('rejects an invalid discount without mutating a foreign or missing invoice', async () => {
        mockQueries.getInvoiceById.mockResolvedValue(null);

        await expect(invoicesService.updateInvoice(COMPANY_A, USER_ID, INVOICE_ID, {
            discount_type: 'percentage',
            discount_value: 101,
        }, TX_CLIENT)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(mockQueries.getInvoiceItems).not.toHaveBeenCalled();
        expect(mockQueries.updateInvoice).not.toHaveBeenCalled();
        expect(mockQueries.recalculateInvoiceTotals).not.toHaveBeenCalled();
    });
});
