/**
 * useJobFinancials
 * Fetches estimates and invoices linked to a specific job.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchEstimates, createEstimate, type Estimate, type EstimateCreateData } from '../services/estimatesApi';
import { fetchInvoices, createInvoice, type Invoice, type InvoiceCreateData } from '../services/invoicesApi';
import { fetchTransactions, type PaymentTransaction } from '../services/paymentsCanonicalApi';
import type { ManualCardSessionResult } from '../services/stripePaymentsApi';
import { toast } from 'sonner';
import { useAuthz } from './useAuthz';
import { completedStandalonePaid } from '../components/jobs/jobFinanceMath';

export const FINANCE_REVALIDATION_DELAYS_MS = [0, 1000, 2000, 4000, 8000] as const;

export interface JobFinanceSnapshot {
    invoices: Invoice[];
    jobPayments: PaymentTransaction[];
}

export async function fetchJobFinanceSnapshot(jobId: number, toleratePaymentFailure = false): Promise<JobFinanceSnapshot> {
    const [invoiceResult, paymentResult] = await Promise.all([
        fetchInvoices({ job_id: jobId, limit: 100 }),
        fetchTransactions({
            job_id: jobId,
            transaction_type: 'payment',
            status: 'completed',
            limit: 100,
        }).catch(error => {
            if (!toleratePaymentFailure) throw error;
            return { transactions: [], total: 0, page: 1, limit: 100 };
        }),
    ]);
    return {
        invoices: invoiceResult.invoices,
        jobPayments: paymentResult.transactions,
    };
}

interface PollJobFinanceOptions {
    jobId: number;
    baselineStandalonePaid: number;
    paymentAmount: number;
    fetchSnapshot?: (jobId: number) => Promise<JobFinanceSnapshot>;
    onSnapshot?: (snapshot: JobFinanceSnapshot) => void;
    wait?: (milliseconds: number) => Promise<void>;
    isCancelled?: () => boolean;
    delays?: readonly number[];
}

export async function pollJobFinanceAfterPayment({
    jobId,
    baselineStandalonePaid,
    paymentAmount,
    fetchSnapshot = fetchJobFinanceSnapshot,
    onSnapshot,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    isCancelled = () => false,
    delays = FINANCE_REVALIDATION_DELAYS_MS,
}: PollJobFinanceOptions): Promise<boolean> {
    const expectedPaidCents = Math.round((baselineStandalonePaid + paymentAmount) * 100);
    for (const delay of delays) {
        if (delay > 0) await wait(delay);
        if (isCancelled()) return false;
        try {
            const snapshot = await fetchSnapshot(jobId);
            if (isCancelled()) return false;
            onSnapshot?.(snapshot);
            const observedPaidCents = Math.round(completedStandalonePaid(snapshot.jobPayments) * 100);
            if (observedPaidCents >= expectedPaidCents) return true;
        } catch {
            // Webhook-backed finance may lag or a poll may fail; continue within the bound.
        }
    }
    return false;
}

interface UseJobFinancialsReturn {
    estimates: Estimate[];
    invoices: Invoice[];
    jobPayments: PaymentTransaction[];
    loading: boolean;
    selectedEstimate: Estimate | null;
    selectedInvoice: Invoice | null;
    setSelectedEstimate: (e: Estimate | null) => void;
    setSelectedInvoice: (i: Invoice | null) => void;
    refresh: () => void;
    revalidateAfterPayment: (payment: ManualCardSessionResult) => Promise<boolean>;
    handleCreateEstimate: (data: EstimateCreateData) => Promise<void>;
    handleCreateInvoice: (data: InvoiceCreateData) => Promise<void>;
}

export function useJobFinancials(jobId: number): UseJobFinancialsReturn {
    const { hasAnyPermission } = useAuthz();
    // No finance visibility → no estimates/invoices requests at all (PF007)
    const canViewFinancials = hasAnyPermission('financial_data.view', 'estimates.view', 'invoices.view');
    const [estimates, setEstimates] = useState<Estimate[]>([]);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [jobPayments, setJobPayments] = useState<PaymentTransaction[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedEstimate, setSelectedEstimate] = useState<Estimate | null>(null);
    const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
    const [rev, setRev] = useState(0);
    const jobPaymentsRef = useRef<PaymentTransaction[]>([]);
    const pollGenerationRef = useRef(0);
    const pollWaitersRef = useRef(new Map<number, () => void>());

    const refresh = useCallback(() => setRev(r => r + 1), []);

    const cancelPaymentRevalidation = useCallback(() => {
        pollGenerationRef.current += 1;
        for (const cancel of pollWaitersRef.current.values()) cancel();
        pollWaitersRef.current.clear();
    }, []);

    const waitForPoll = useCallback((milliseconds: number) => new Promise<void>(resolve => {
        const id = window.setTimeout(() => {
            pollWaitersRef.current.delete(id);
            resolve();
        }, milliseconds);
        pollWaitersRef.current.set(id, () => {
            window.clearTimeout(id);
            resolve();
        });
    }), []);

    useEffect(() => {
        jobPaymentsRef.current = jobPayments;
    }, [jobPayments]);

    useEffect(() => () => cancelPaymentRevalidation(), [jobId, cancelPaymentRevalidation]);

    useEffect(() => {
        if (!jobId || !canViewFinancials) return;
        let cancelled = false;
        setLoading(true);
        Promise.all([
            fetchEstimates({ job_id: jobId, limit: 100 }),
            fetchJobFinanceSnapshot(jobId, true),
        ])
            .then(([eRes, snapshot]) => {
                if (cancelled) return;
                setEstimates(eRes.estimates);
                setInvoices(snapshot.invoices);
                setJobPayments(snapshot.jobPayments);
                jobPaymentsRef.current = snapshot.jobPayments;
            })
            .catch(() => {
                if (cancelled) return;
                toast.error('Failed to load estimates/invoices');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [jobId, rev, canViewFinancials]);

    const revalidateAfterPayment = useCallback(async (payment: ManualCardSessionResult): Promise<boolean> => {
        if (!jobId || !canViewFinancials || payment.status !== 'succeeded') return false;
        cancelPaymentRevalidation();
        const generation = pollGenerationRef.current;
        const baselineStandalonePaid = completedStandalonePaid(jobPaymentsRef.current);

        return pollJobFinanceAfterPayment({
            jobId,
            baselineStandalonePaid,
            paymentAmount: payment.amount,
            wait: waitForPoll,
            isCancelled: () => generation !== pollGenerationRef.current,
            onSnapshot: snapshot => {
                setInvoices(snapshot.invoices);
                setJobPayments(snapshot.jobPayments);
                jobPaymentsRef.current = snapshot.jobPayments;
            },
        });
    }, [jobId, canViewFinancials, cancelPaymentRevalidation, waitForPoll]);

    const handleCreateEstimate = useCallback(async (data: EstimateCreateData) => {
        await createEstimate({ ...data, job_id: jobId });
        refresh();
    }, [jobId, refresh]);

    const handleCreateInvoice = useCallback(async (data: InvoiceCreateData) => {
        await createInvoice({ ...data, job_id: jobId });
        refresh();
    }, [jobId, refresh]);

    return {
        estimates,
        invoices,
        jobPayments,
        loading,
        selectedEstimate,
        selectedInvoice,
        setSelectedEstimate,
        setSelectedInvoice,
        refresh,
        revalidateAfterPayment,
        handleCreateEstimate,
        handleCreateInvoice,
    };
}
