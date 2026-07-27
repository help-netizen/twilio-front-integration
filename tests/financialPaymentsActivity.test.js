'use strict';

const mockPayments = {
    createTransaction: jest.fn(),
    getTransactionById: jest.fn(),
    createRefundTransaction: jest.fn(),
    voidPayment: jest.fn(),
    voidTransaction: jest.fn(),
};
const mockInvoices = {
    getInvoiceById: jest.fn(),
    recordPayment: jest.fn(),
};
const mockEstimates = {
    getContactContext: jest.fn(),
    getEstimateById: jest.fn(),
    getJobContext: jest.fn(),
};
const mockLogFinancialActivity = jest.fn();

jest.mock('../backend/src/db/paymentsQueries', () => mockPayments);
jest.mock('../backend/src/db/invoicesQueries', () => mockInvoices);
jest.mock('../backend/src/db/estimatesQueries', () => mockEstimates);
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: (...args) => mockLogFinancialActivity(...args),
}));

const paymentsService = require('../backend/src/services/paymentsService');

const COMPANY = '00000000-0000-4000-8000-000000000001';
const FOREIGN_COMPANY = '00000000-0000-4000-8000-000000000002';
const CRM_USER = '10000000-0000-4000-8000-000000000001';
const CLIENT = { query: jest.fn() };
const HUMAN_ACTOR = {
    id: CRM_USER, type: 'user', label: null, source: 'crm',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockLogFinancialActivity.mockResolvedValue({ ok: true });
    mockEstimates.getContactContext.mockImplementation(
        async (companyId, id) => (
            companyId === COMPANY ? { id, company_id: companyId } : null
        )
    );
    mockEstimates.getEstimateById.mockImplementation(
        async (companyId, id) => (
            companyId === COMPANY ? { id, company_id: companyId, contact_id: 5 } : null
        )
    );
    mockEstimates.getJobContext.mockImplementation(
        async (companyId, id) => (
            companyId === COMPANY ? { id, company_id: companyId, contact_id: 5 } : null
        )
    );
    mockInvoices.getInvoiceById.mockImplementation(
        async (companyId, id) => (
            companyId === COMPANY
                ? {
                    id,
                    company_id: companyId,
                    contact_id: 5,
                    job_id: 7,
                    estimate_id: null,
                }
                : null
        )
    );
    mockInvoices.recordPayment.mockResolvedValue({ id: 41 });
    mockPayments.createTransaction.mockResolvedValue({
        id: 51,
        company_id: COMPANY,
        invoice_id: 41,
        contact_id: 5,
        job_id: 7,
        status: 'completed',
        currency: 'USD',
    });
});

test('recording an Invoice payment emits Payment and Invoice actions on the same client', async () => {
    await paymentsService.createTransaction(
        COMPANY,
        CRM_USER,
        {
            transaction_type: 'payment',
            payment_method: 'cash',
            invoice_id: 41,
            contact_id: 5,
            job_id: 7,
            amount: 95,
            currency: 'USD',
        },
        CLIENT,
        HUMAN_ACTOR
    );

    expect(mockLogFinancialActivity).toHaveBeenCalledTimes(2);
    expect(mockLogFinancialActivity.mock.calls.map(([event]) => event.action))
        .toEqual(['payment.recorded', 'invoice.payment_recorded']);
    expect(mockLogFinancialActivity.mock.calls.every(([, options]) => (
        options.client === CLIENT
    ))).toBe(true);
});

test('a foreign related entity returns 404 before ledger or activity mutation', async () => {
    mockEstimates.getContactContext.mockImplementation(
        async (companyId, id) => (
            companyId === FOREIGN_COMPANY ? { id, company_id: companyId } : null
        )
    );

    await expect(paymentsService.createTransaction(
        COMPANY,
        CRM_USER,
        {
            transaction_type: 'payment',
            payment_method: 'cash',
            contact_id: 999,
            amount: 20,
        },
        CLIENT,
        HUMAN_ACTOR
    )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

    expect(mockPayments.createTransaction).not.toHaveBeenCalled();
    expect(mockLogFinancialActivity).not.toHaveBeenCalled();
});

test('refund and void use their canonical Payment actions and share the mutation client', async () => {
    const original = {
        id: 61,
        company_id: COMPANY,
        invoice_id: null,
        contact_id: 5,
        job_id: null,
        transaction_type: 'payment',
        payment_method: 'cash',
        external_source: 'manual',
        status: 'completed',
        amount: 40,
        currency: 'USD',
    };
    mockPayments.getTransactionById.mockResolvedValue(original);
    mockPayments.createRefundTransaction.mockResolvedValue({
        ...original,
        id: 62,
        transaction_type: 'refund',
        amount: -10,
    });
    const voided = {
        ...original,
        status: 'voided',
        void_reason: 'Bounced check',
    };
    mockPayments.voidPayment.mockResolvedValue({
        candidate_id: original.id,
        candidate_transaction_type: 'payment',
        candidate_status: 'completed',
        candidate_external_source: 'manual',
        candidate_invoice_id: null,
        candidate_voided_at: null,
        linked_invoice_owned: true,
        did_void: true,
        invoice_updated: true,
    });

    await paymentsService.refundTransaction(
        COMPANY,
        CRM_USER,
        original.id,
        { amount: 10 },
        CLIENT,
        HUMAN_ACTOR
    );
    mockPayments.getTransactionById.mockResolvedValueOnce(voided);
    await paymentsService.voidPayment(
        COMPANY,
        CRM_USER,
        original.id,
        { reason: '  Bounced check  ' },
        CLIENT,
        HUMAN_ACTOR
    );

    expect(mockLogFinancialActivity.mock.calls.map(([event]) => event.action))
        .toEqual(['payment.refunded', 'payment.voided']);
    const voidEvent = mockLogFinancialActivity.mock.calls[1][0];
    expect(voidEvent.summary).toEqual({
        status: 'voided',
        amount: 40,
        currency: 'USD',
    });
    expect(voidEvent.summary).not.toHaveProperty('reason');
    expect(mockPayments.voidPayment).toHaveBeenCalledWith(
        COMPANY,
        original.id,
        CRM_USER,
        'Bounced check',
        null,
        CLIENT
    );
    expect(mockLogFinancialActivity.mock.calls.every(([, options]) => (
        options.client === CLIENT
    ))).toBe(true);
});
