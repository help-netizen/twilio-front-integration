/**
 * useJobFinancials
 * Fetches estimates and invoices linked to a specific job.
 */

import { useState, useEffect, useCallback } from 'react';
import { fetchEstimates, createEstimate, type Estimate, type EstimateCreateData } from '../services/estimatesApi';
import { fetchInvoices, createInvoice, type Invoice, type InvoiceCreateData } from '../services/invoicesApi';
import { fetchTransactions, type PaymentTransaction } from '../services/paymentsCanonicalApi';
import { toast } from 'sonner';
import { useAuthz } from './useAuthz';

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

    const refresh = useCallback(() => setRev(r => r + 1), []);

    useEffect(() => {
        if (!jobId || !canViewFinancials) return;
        let cancelled = false;
        setLoading(true);
        Promise.all([
            fetchEstimates({ job_id: jobId, limit: 100 }),
            fetchInvoices({ job_id: jobId, limit: 100 }),
            fetchTransactions({ job_id: jobId, transaction_type: 'payment', status: 'completed' })
                .catch(() => ({ transactions: [], total: 0, page: 1, limit: 25 })),
        ])
            .then(([eRes, iRes, pRes]) => {
                if (cancelled) return;
                setEstimates(eRes.estimates);
                setInvoices(iRes.invoices);
                setJobPayments(pRes.transactions);
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
        handleCreateEstimate,
        handleCreateInvoice,
    };
}
