import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentTransaction } from '../services/paymentsCanonicalApi';

const api = vi.hoisted(() => ({
    fetchEstimates: vi.fn(),
    createEstimate: vi.fn(),
    fetchInvoices: vi.fn(),
    createInvoice: vi.fn(),
    fetchTransactions: vi.fn(),
}));

vi.mock('../services/estimatesApi', () => ({
    fetchEstimates: api.fetchEstimates,
    createEstimate: api.createEstimate,
}));
vi.mock('../services/invoicesApi', () => ({
    fetchInvoices: api.fetchInvoices,
    createInvoice: api.createInvoice,
}));
vi.mock('../services/paymentsCanonicalApi', () => ({
    fetchTransactions: api.fetchTransactions,
}));
vi.mock('./useAuthz', () => ({
    useAuthz: () => ({ hasAnyPermission: () => true }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import {
    FINANCE_REVALIDATION_DELAYS_MS,
    fetchJobFinanceSnapshot,
    pollJobFinanceAfterPayment,
} from './useJobFinancials';

function payment(overrides: Partial<PaymentTransaction> = {}): PaymentTransaction {
    return {
        id: 1,
        company_id: 'company-a',
        contact_id: null,
        estimate_id: null,
        invoice_id: null,
        job_id: 7,
        transaction_type: 'payment',
        payment_method: 'credit_card',
        status: 'completed',
        amount: '95.00',
        currency: 'usd',
        reference_number: null,
        external_id: null,
        external_source: 'stripe',
        memo: null,
        metadata: {},
        processed_at: null,
        recorded_by: null,
        created_at: '2026-07-18T12:00:00Z',
        updated_at: '2026-07-18T12:00:00Z',
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('fetchJobFinanceSnapshot', () => {
    it('refreshes invoices and only canonical completed job payments', async () => {
        const invoices = [{ id: 3 }];
        const payments = [payment()];
        api.fetchInvoices.mockResolvedValueOnce({ invoices, total: 1, page: 1, limit: 100 });
        api.fetchTransactions.mockResolvedValueOnce({ transactions: payments, total: 1, page: 1, limit: 100 });

        await expect(fetchJobFinanceSnapshot(7)).resolves.toEqual({ invoices, jobPayments: payments });
        expect(api.fetchInvoices).toHaveBeenCalledWith({ job_id: 7, limit: 100 });
        expect(api.fetchTransactions).toHaveBeenCalledWith({
            job_id: 7,
            transaction_type: 'payment',
            status: 'completed',
            limit: 100,
        });
    });
});

describe('pollJobFinanceAfterPayment', () => {
    it('observes the standalone ledger amount and stops early', async () => {
        const emptySnapshot = { invoices: [], jobPayments: [] };
        const paidSnapshot = { invoices: [], jobPayments: [payment()] };
        const fetchSnapshot = vi.fn()
            .mockResolvedValueOnce(emptySnapshot)
            .mockResolvedValueOnce(paidSnapshot);
        const onSnapshot = vi.fn();
        const wait = vi.fn(async () => {});

        await expect(pollJobFinanceAfterPayment({
            jobId: 7,
            baselineStandalonePaid: 0,
            paymentAmount: 95,
            fetchSnapshot,
            onSnapshot,
            wait,
            delays: [0, 1000, 2000],
        })).resolves.toBe(true);

        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        expect(wait).toHaveBeenCalledWith(1000);
        expect(onSnapshot).toHaveBeenLastCalledWith(paidSnapshot);
    });

    it('is bounded to 15 seconds and returns false without downgrading payment success', async () => {
        const fetchSnapshot = vi.fn().mockResolvedValue({ invoices: [], jobPayments: [] });
        const wait = vi.fn(async () => {});

        await expect(pollJobFinanceAfterPayment({
            jobId: 7,
            baselineStandalonePaid: 0,
            paymentAmount: 95,
            fetchSnapshot,
            wait,
        })).resolves.toBe(false);

        expect(FINANCE_REVALIDATION_DELAYS_MS.reduce<number>((sum, delay) => sum + delay, 0)).toBe(15000);
        expect(fetchSnapshot).toHaveBeenCalledTimes(FINANCE_REVALIDATION_DELAYS_MS.length);
        expect(wait).toHaveBeenCalledTimes(FINANCE_REVALIDATION_DELAYS_MS.length - 1);
    });

    it('cancels before applying an in-flight snapshot or scheduling another request', async () => {
        let cancelled = false;
        const fetchSnapshot = vi.fn(async () => {
            cancelled = true;
            return { invoices: [], jobPayments: [payment()] };
        });
        const onSnapshot = vi.fn();

        await expect(pollJobFinanceAfterPayment({
            jobId: 7,
            baselineStandalonePaid: 0,
            paymentAmount: 95,
            fetchSnapshot,
            onSnapshot,
            wait: async () => {},
            isCancelled: () => cancelled,
            delays: [0, 1000],
        })).resolves.toBe(false);

        expect(fetchSnapshot).toHaveBeenCalledOnce();
        expect(onSnapshot).not.toHaveBeenCalled();
    });
});
