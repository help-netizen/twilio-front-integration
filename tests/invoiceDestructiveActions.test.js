'use strict';

const COMPANY_A = '00000000-0000-4000-8000-0000000000a1';
const COMPANY_B = '00000000-0000-4000-8000-0000000000b2';
const CRM_USER_ID = '00000000-0000-4000-8000-0000000000c3';
const INVOICE_ID = 57;
const TX_CLIENT = { query: jest.fn() };
const ACTOR = { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' };

const mockGetInvoiceById = jest.fn();
const mockDeleteInvoice = jest.fn();
const mockUpdateInvoiceStatus = jest.fn();
const mockCreateEvent = jest.fn();
const mockLogFinancialActivity = jest.fn();
const mockRecordManualPayment = jest.fn();

jest.mock('../backend/src/db/invoicesQueries', () => ({
    getInvoiceById: (...args) => mockGetInvoiceById(...args),
    deleteInvoice: (...args) => mockDeleteInvoice(...args),
    updateInvoiceStatus: (...args) => mockUpdateInvoiceStatus(...args),
    createEvent: (...args) => mockCreateEvent(...args),
}));
jest.mock('../backend/src/db/estimatesQueries', () => ({}));
jest.mock('../backend/src/services/paymentsService', () => ({
    recordManualPayment: (...args) => mockRecordManualPayment(...args),
}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    recordDocumentSendNote: jest.fn(),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: (...args) => mockLogFinancialActivity(...args),
}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn() }));
jest.mock('../backend/src/services/documentEmailBody', () => ({
    buildInvoiceEmailBody: jest.fn(),
}));

const invoicesService = require('../backend/src/services/invoicesService');

function invoice(status, companyId = COMPANY_A) {
    return {
        id: INVOICE_ID,
        company_id: companyId,
        invoice_number: 'INV-1042',
        status,
        balance_due: '188.50',
        job_id: 1658,
        contact_id: 42,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    TX_CLIENT.query.mockResolvedValue({ rows: [{ id: INVOICE_ID }] });
    mockDeleteInvoice.mockResolvedValue(true);
    mockCreateEvent.mockResolvedValue({ id: 1 });
    mockLogFinancialActivity.mockResolvedValue({ id: 2 });
    mockRecordManualPayment.mockResolvedValue({ id: 81, invoice_id: INVOICE_ID });
});

describe('draft-only invoice deletion', () => {
    it('hard-deletes an own-company draft and scopes every query to that company', async () => {
        const draft = invoice('draft');
        mockGetInvoiceById.mockResolvedValue(draft);

        await expect(invoicesService.deleteInvoice(
            COMPANY_A,
            INVOICE_ID,
            CRM_USER_ID,
            TX_CLIENT,
            ACTOR
        )).resolves.toEqual({ deleted: true });

        expect(mockGetInvoiceById).toHaveBeenCalledWith(COMPANY_A, INVOICE_ID, TX_CLIENT);
        expect(mockDeleteInvoice).toHaveBeenCalledWith(INVOICE_ID, COMPANY_A, TX_CLIENT);
        expect(mockUpdateInvoiceStatus).not.toHaveBeenCalled();
        expect(mockLogFinancialActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                companyId: COMPANY_A,
                action: 'invoice.deleted',
                entity: draft,
                actor: ACTOR,
            }),
            { client: TX_CLIENT }
        );
    });

    it('rejects issued records without silently changing them to void', async () => {
        mockGetInvoiceById.mockResolvedValue(invoice('sent'));

        await expect(invoicesService.deleteInvoice(
            COMPANY_A,
            INVOICE_ID,
            CRM_USER_ID,
            TX_CLIENT,
            ACTOR
        )).rejects.toMatchObject({ code: 'INVALID_STATUS', httpStatus: 409 });

        expect(mockDeleteInvoice).not.toHaveBeenCalled();
        expect(mockUpdateInvoiceStatus).not.toHaveBeenCalled();
        expect(mockCreateEvent).not.toHaveBeenCalled();
        expect(mockLogFinancialActivity).not.toHaveBeenCalled();
    });

    it('returns tenant-safe not found for a foreign invoice and leaves both companies unchanged', async () => {
        mockGetInvoiceById.mockImplementation(companyId => (
            companyId === COMPANY_B ? invoice('draft', COMPANY_B) : null
        ));

        await expect(invoicesService.deleteInvoice(
            COMPANY_A,
            INVOICE_ID,
            CRM_USER_ID,
            TX_CLIENT,
            ACTOR
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(mockGetInvoiceById).toHaveBeenCalledWith(COMPANY_A, INVOICE_ID, TX_CLIENT);
        expect(mockDeleteInvoice).not.toHaveBeenCalled();
        expect(mockUpdateInvoiceStatus).not.toHaveBeenCalled();
        expect(mockCreateEvent).not.toHaveBeenCalled();
        expect(mockLogFinancialActivity).not.toHaveBeenCalled();
    });
});

describe('issued-only invoice void', () => {
    it('voids an own-company issued invoice with the crmUser actor', async () => {
        const issued = invoice('sent');
        const voided = { ...issued, status: 'void', voided_at: '2026-08-14T12:00:00Z' };
        mockGetInvoiceById.mockResolvedValue(issued);
        mockUpdateInvoiceStatus.mockResolvedValue(voided);

        await expect(invoicesService.voidInvoice(
            COMPANY_A,
            INVOICE_ID,
            CRM_USER_ID,
            TX_CLIENT,
            ACTOR
        )).resolves.toEqual(voided);

        expect(mockGetInvoiceById).toHaveBeenCalledWith(COMPANY_A, INVOICE_ID, TX_CLIENT);
        expect(mockUpdateInvoiceStatus).toHaveBeenCalledWith(
            INVOICE_ID,
            COMPANY_A,
            'void',
            'voided_at',
            TX_CLIENT
        );
        expect(mockCreateEvent).toHaveBeenCalledWith(
            COMPANY_A,
            INVOICE_ID,
            'voided',
            'user',
            CRM_USER_ID,
            null,
            TX_CLIENT
        );
        expect(mockDeleteInvoice).not.toHaveBeenCalled();
        expect(mockLogFinancialActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                companyId: COMPANY_A,
                action: 'invoice.voided',
                entity: voided,
                actor: ACTOR,
            }),
            { client: TX_CLIENT }
        );
    });

    it.each(['draft', 'void', 'refunded'])(
        'rejects %s records without any destructive write',
        async status => {
            mockGetInvoiceById.mockResolvedValue(invoice(status));

            await expect(invoicesService.voidInvoice(
                COMPANY_A,
                INVOICE_ID,
                CRM_USER_ID,
                TX_CLIENT,
                ACTOR
            )).rejects.toMatchObject({ code: 'INVALID_STATUS', httpStatus: 409 });

            expect(mockDeleteInvoice).not.toHaveBeenCalled();
            expect(mockUpdateInvoiceStatus).not.toHaveBeenCalled();
            expect(mockCreateEvent).not.toHaveBeenCalled();
            expect(mockLogFinancialActivity).not.toHaveBeenCalled();
        }
    );

    it('returns tenant-safe not found for a foreign invoice before any status write', async () => {
        mockGetInvoiceById.mockImplementation(companyId => (
            companyId === COMPANY_B ? invoice('sent', COMPANY_B) : null
        ));

        await expect(invoicesService.voidInvoice(
            COMPANY_A,
            INVOICE_ID,
            CRM_USER_ID,
            TX_CLIENT,
            ACTOR
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(mockGetInvoiceById).toHaveBeenCalledWith(COMPANY_A, INVOICE_ID, TX_CLIENT);
        expect(mockDeleteInvoice).not.toHaveBeenCalled();
        expect(mockUpdateInvoiceStatus).not.toHaveBeenCalled();
        expect(mockCreateEvent).not.toHaveBeenCalled();
        expect(mockLogFinancialActivity).not.toHaveBeenCalled();
    });
});

describe('invoice-bound offline collection', () => {
    it('records an own-company cash payment against the selected invoice and crmUser actor', async () => {
        mockGetInvoiceById.mockResolvedValue(invoice('partial'));

        await expect(invoicesService.recordOfflinePayment(
            COMPANY_A,
            CRM_USER_ID,
            INVOICE_ID,
            { amount: 188.5, payment_method: 'cash', memo: 'Counter payment' },
            TX_CLIENT,
            ACTOR
        )).resolves.toEqual({ id: 81, invoice_id: INVOICE_ID });

        expect(mockGetInvoiceById).toHaveBeenCalledWith(COMPANY_A, INVOICE_ID, TX_CLIENT);
        expect(TX_CLIENT.query).toHaveBeenCalledWith(
            expect.stringContaining('FOR UPDATE'),
            [INVOICE_ID, COMPANY_A]
        );
        expect(mockRecordManualPayment).toHaveBeenCalledWith(
            COMPANY_A,
            CRM_USER_ID,
            expect.objectContaining({
                invoice_id: INVOICE_ID,
                job_id: 1658,
                contact_id: 42,
                amount: 188.5,
                payment_method: 'cash',
                memo: 'Counter payment',
            }),
            TX_CLIENT,
            ACTOR
        );
    });

    it.each([
        ['over the live balance', { amount: 188.51, payment_method: 'cash' }, 'INVALID_AMOUNT'],
        ['sub-cent precision', { amount: 10.005, payment_method: 'cash' }, 'INVALID_AMOUNT'],
        ['unsupported method', { amount: 10, payment_method: 'credit_card' }, 'VALIDATION'],
    ])('rejects %s before the canonical ledger write', async (_label, data, code) => {
        mockGetInvoiceById.mockResolvedValue(invoice('sent'));

        await expect(invoicesService.recordOfflinePayment(
            COMPANY_A,
            CRM_USER_ID,
            INVOICE_ID,
            data,
            TX_CLIENT,
            ACTOR
        )).rejects.toMatchObject({ code });

        expect(mockRecordManualPayment).not.toHaveBeenCalled();
    });

    it.each(['draft', 'paid', 'void', 'refunded'])(
        'rejects %s invoices before a ledger write',
        async status => {
            mockGetInvoiceById.mockResolvedValue(invoice(status));

            await expect(invoicesService.recordOfflinePayment(
                COMPANY_A,
                CRM_USER_ID,
                INVOICE_ID,
                { amount: 10, payment_method: 'check' },
                TX_CLIENT,
                ACTOR
            )).rejects.toMatchObject({ code: 'INVALID_STATUS', httpStatus: 409 });

            expect(mockRecordManualPayment).not.toHaveBeenCalled();
        }
    );

    it('returns tenant-safe not found for a foreign invoice and leaves both ledgers unchanged', async () => {
        TX_CLIENT.query.mockResolvedValueOnce({ rows: [] });

        await expect(invoicesService.recordOfflinePayment(
            COMPANY_A,
            CRM_USER_ID,
            INVOICE_ID,
            { amount: 10, payment_method: 'cash' },
            TX_CLIENT,
            ACTOR
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(TX_CLIENT.query).toHaveBeenCalledWith(
            expect.stringContaining('company_id = $2'),
            [INVOICE_ID, COMPANY_A]
        );
        expect(mockGetInvoiceById).not.toHaveBeenCalled();
        expect(mockRecordManualPayment).not.toHaveBeenCalled();
    });

    it('does not start an un-settleable payment for an invoice without a job', async () => {
        mockGetInvoiceById.mockResolvedValue({ ...invoice('sent'), job_id: null });

        await expect(invoicesService.recordOfflinePayment(
            COMPANY_A,
            CRM_USER_ID,
            INVOICE_ID,
            { amount: 10, payment_method: 'cash' },
            TX_CLIENT,
            ACTOR
        )).rejects.toMatchObject({ code: 'JOB_REQUIRED', httpStatus: 409 });

        expect(mockRecordManualPayment).not.toHaveBeenCalled();
    });
});
