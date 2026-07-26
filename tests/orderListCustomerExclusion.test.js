'use strict';

const COMPANY_ID = '00000000-0000-0000-0000-0000000000a1';
const CONTACT_ID = 17;
const SECRET_PART = 'ORDER-LIST-SECRET-PART';
const ORDER_LIST = [{
    part_number: SECRET_PART,
    part_name: 'Internal pump',
    quantity: 2,
}];

const mockGetEstimateById = jest.fn();
const mockGetEstimateByPublicToken = jest.fn();
const mockGetEstimateItems = jest.fn();
jest.mock('../backend/src/db/estimatesQueries', () => ({
    getEstimateById: (...args) => mockGetEstimateById(...args),
    getEstimateByPublicToken: (...args) => mockGetEstimateByPublicToken(...args),
    getEstimateItems: (...args) => mockGetEstimateItems(...args),
}));

const mockGetInvoiceById = jest.fn();
const mockGetInvoiceByPublicToken = jest.fn();
const mockGetInvoiceItems = jest.fn();
jest.mock('../backend/src/db/invoicesQueries', () => ({
    getInvoiceById: (...args) => mockGetInvoiceById(...args),
    getInvoiceByPublicToken: (...args) => mockGetInvoiceByPublicToken(...args),
    getInvoiceItems: (...args) => mockGetInvoiceItems(...args),
}));

const mockRenderEstimatePdf = jest.fn();
jest.mock('../backend/src/services/estimatePdfService', () => ({
    renderEstimatePdf: (...args) => mockRenderEstimatePdf(...args),
}));

const mockRenderInvoicePdf = jest.fn();
jest.mock('../backend/src/services/documentTemplatesService', () => ({
    resolveTemplate: jest.fn().mockResolvedValue({ key: 'test-template' }),
}));
jest.mock('../backend/src/services/documentTemplates', () => ({
    get: type => (type === 'invoice'
        ? { render: (...args) => mockRenderInvoicePdf(...args) }
        : null),
}));

const mockPortalQueries = {
    getSessionById: jest.fn(),
    touchSession: jest.fn(),
    logEvent: jest.fn(),
};
jest.mock('../backend/src/db/portalQueries', () => mockPortalQueries);
jest.mock('../backend/src/db/paymentsQueries', () => ({}));
jest.mock('../backend/src/services/paymentsService', () => ({}));

const estimatesService = require('../backend/src/services/estimatesService');
const invoicesService = require('../backend/src/services/invoicesService');
const portalService = require('../backend/src/services/portalService');
const estimateAdapter = require('../backend/src/services/documentTemplates/estimateAdapter');
const invoiceAdapter = require('../backend/src/services/documentTemplates/invoiceAdapter');

function estimateRow() {
    return {
        id: 71,
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        estimate_number: 'ESTIMATE 71',
        status: 'approved',
        currency: 'USD',
        subtotal: '100',
        discount_amount: '0',
        tax_amount: '0',
        total: '100',
        order_list: ORDER_LIST,
        approved_snapshot: {
            status: 'approved',
            order_list: ORDER_LIST,
        },
    };
}

function invoiceRow() {
    return {
        id: 81,
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        invoice_number: 'INVOICE 81',
        status: 'sent',
        currency: 'USD',
        total: '100',
        order_list: ORDER_LIST,
        metadata: {
            order_list: ORDER_LIST,
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetEstimateById.mockResolvedValue(estimateRow());
    mockGetEstimateByPublicToken.mockResolvedValue(estimateRow());
    mockGetEstimateItems.mockResolvedValue([]);
    mockGetInvoiceById.mockResolvedValue(invoiceRow());
    mockGetInvoiceByPublicToken.mockResolvedValue(invoiceRow());
    mockGetInvoiceItems.mockResolvedValue([]);
    mockRenderEstimatePdf.mockResolvedValue(Buffer.from('%PDF estimate'));
    mockRenderInvoicePdf.mockResolvedValue(Buffer.from('%PDF invoice'));
    mockPortalQueries.getSessionById.mockResolvedValue({
        id: 'session-1',
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        scope: 'full',
    });
    mockPortalQueries.touchSession.mockResolvedValue({});
    mockPortalQueries.logEvent.mockResolvedValue({});
});

describe('ORDER-LIST-001 customer-facing PDF payloads', () => {
    test('estimate PDF renderer and returned payload receive no order_list at any depth', async () => {
        const result = await estimatesService.generatePdf(COMPANY_ID, 71);

        expect(mockRenderEstimatePdf).toHaveBeenCalledTimes(1);
        const rendererEstimate = mockRenderEstimatePdf.mock.calls[0][0];
        expect(rendererEstimate).not.toHaveProperty('order_list');
        expect(rendererEstimate.approved_snapshot).not.toHaveProperty('order_list');
        expect(JSON.stringify(rendererEstimate)).not.toContain(SECRET_PART);
        expect(JSON.stringify(result.estimate)).not.toContain(SECRET_PART);
    });

    test('public-token estimate PDF path excludes order_list before rendering', async () => {
        const result = await estimatesService.generatePdfByPublicToken('estimate_token_123');

        expect(mockRenderEstimatePdf).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(mockRenderEstimatePdf.mock.calls[0][0]))
            .not.toContain(SECRET_PART);
        expect(JSON.stringify(result.estimate)).not.toContain(SECRET_PART);
    });

    test('invoice PDF renderer and returned payload receive no order_list at any depth', async () => {
        const result = await invoicesService.generatePdf(COMPANY_ID, 81);

        expect(mockRenderInvoicePdf).toHaveBeenCalledTimes(1);
        const rendererInvoice = mockRenderInvoicePdf.mock.calls[0][0];
        expect(rendererInvoice).not.toHaveProperty('order_list');
        expect(rendererInvoice.metadata).not.toHaveProperty('order_list');
        expect(JSON.stringify(rendererInvoice)).not.toContain(SECRET_PART);
        expect(JSON.stringify(result.invoice)).not.toContain(SECRET_PART);
    });

    test('public-token invoice PDF path excludes order_list before rendering', async () => {
        const result = await invoicesService.generatePdfByPublicToken('invoice_token_123');

        expect(mockRenderInvoicePdf).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(mockRenderInvoicePdf.mock.calls[0][0]))
            .not.toContain(SECRET_PART);
        expect(JSON.stringify(result.invoice)).not.toContain(SECRET_PART);
    });
});

describe('ORDER-LIST-001 public and portal JSON payloads', () => {
    test('public tokenized estimate view excludes order_list', async () => {
        const result = await estimatesService.getPublicEstimate('token_123456');

        expect(result).not.toHaveProperty('order_list');
        expect(JSON.stringify(result)).not.toContain(SECRET_PART);
    });

    test('portal estimate detail excludes top-level and approved-snapshot order_list', async () => {
        const result = await portalService.getDocument('session-1', 'estimate', 71);

        expect(result).not.toHaveProperty('order_list');
        expect(result.approved_snapshot).not.toHaveProperty('order_list');
        expect(JSON.stringify(result)).not.toContain(SECRET_PART);
    });

    test('portal invoice detail excludes order_list at every depth', async () => {
        const result = await portalService.getDocument('session-1', 'invoice', 81);

        expect(result).not.toHaveProperty('order_list');
        expect(result.metadata).not.toHaveProperty('order_list');
        expect(JSON.stringify(result)).not.toContain(SECRET_PART);
    });

    test.each([
        ['acceptDocument', 'approveEstimate', { signature_name: 'Customer', signature_consent: true }],
        ['declineDocument', 'declineEstimate', { reason: 'Not proceeding' }],
    ])('portal %s response excludes order_list', async (portalMethod, serviceMethod, options) => {
        const spy = jest.spyOn(estimatesService, serviceMethod).mockResolvedValue(estimateRow());
        try {
            const result = await portalService[portalMethod](
                'session-1',
                'estimate',
                71,
                options
            );

            expect(result).not.toHaveProperty('order_list');
            expect(JSON.stringify(result)).not.toContain(SECRET_PART);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('ORDER-LIST-001 document-template preview serializers', () => {
    test('estimate HTML preview model excludes order_list', () => {
        const result = estimateAdapter.renderHtml(estimateRow(), { key: 'estimate' });

        expect(result.estimate).not.toHaveProperty('order_list');
        expect(JSON.stringify(result)).not.toContain(SECRET_PART);
    });

    test('invoice HTML preview model excludes order_list', () => {
        const result = invoiceAdapter.renderHtml(invoiceRow(), { key: 'invoice' });

        expect(result.invoice).not.toHaveProperty('order_list');
        expect(JSON.stringify(result)).not.toContain(SECRET_PART);
    });
});
