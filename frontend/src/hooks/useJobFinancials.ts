/**
 * useJobFinancials
 * Fetches estimates and invoices linked to a specific job.
 */

import { useState, useEffect, useCallback } from 'react';
import { fetchEstimates, createEstimate, type Estimate, type EstimateCreateData } from '../services/estimatesApi';
import { fetchInvoices, createInvoice, type Invoice, type InvoiceCreateData } from '../services/invoicesApi';
import { toast } from 'sonner';

interface UseJobFinancialsReturn {
    estimates: Estimate[];
    invoices: Invoice[];
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
    const [estimates, setEstimates] = useState<Estimate[]>([]);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedEstimate, setSelectedEstimate] = useState<Estimate | null>(null);
    const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
    const [rev, setRev] = useState(0);

    const refresh = useCallback(() => setRev(r => r + 1), []);

    useEffect(() => {
        if (!jobId) return;
        let cancelled = false;
        setLoading(true);
        Promise.all([
            fetchEstimates({ job_id: jobId, limit: 100 }),
            fetchInvoices({ job_id: jobId, limit: 100 }),
        ])
            .then(([eRes, iRes]) => {
                if (cancelled) return;
                setEstimates(eRes.estimates);
                setInvoices(iRes.invoices);
            })
            .catch(() => {
                if (cancelled) return;
                toast.error('Failed to load estimates/invoices');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [jobId, rev]);

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
