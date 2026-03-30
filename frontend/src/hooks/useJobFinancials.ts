import { useState, useEffect, useCallback } from 'react';
import { fetchEstimates, fetchEstimate, createEstimate, updateEstimate, deleteEstimate, approveEstimate, declineEstimate, fetchEstimateEvents } from '../services/estimatesApi';
import { fetchInvoices, fetchInvoice, createInvoice, updateInvoice, deleteInvoice, sendInvoice, voidInvoice, recordPayment, syncItemsFromEstimate, fetchInvoiceEvents } from '../services/invoicesApi';
import type { Estimate, EstimateCreateData, EstimateEvent } from '../services/estimatesApi';
import type { Invoice, InvoiceCreateData, InvoiceEvent, RecordPaymentData } from '../services/invoicesApi';

interface JobFinancialState {
    estimates: Estimate[];
    invoices: Invoice[];
    loading: boolean;
    error: string | null;
    selectedEstimate: Estimate | null;
    selectedEstimateEvents: EstimateEvent[];
    selectedEstimateLoading: boolean;
    selectedInvoice: Invoice | null;
    selectedInvoiceEvents: InvoiceEvent[];
    selectedInvoiceLoading: boolean;
}

export function useJobFinancials(jobId: number) {
    const [state, setState] = useState<JobFinancialState>({
        estimates: [],
        invoices: [],
        loading: false,
        error: null,
        selectedEstimate: null,
        selectedEstimateEvents: [],
        selectedEstimateLoading: false,
        selectedInvoice: null,
        selectedInvoiceEvents: [],
        selectedInvoiceLoading: false,
    });

    const load = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const [estResult, invResult] = await Promise.all([
                fetchEstimates({ job_id: jobId, limit: 100 }),
                fetchInvoices({ job_id: jobId, limit: 100 }),
            ]);
            setState(s => ({
                ...s,
                estimates: estResult.estimates,
                invoices: invResult.invoices,
                loading: false,
            }));
        } catch (e: any) {
            setState(s => ({ ...s, loading: false, error: e.message }));
        }
    }, [jobId]);

    useEffect(() => {
        load();
    }, [load]);

    // ── Estimate selection ────────────────────────────────────────────────────

    const selectEstimate = useCallback(async (id: number) => {
        setState(s => ({ ...s, selectedEstimateLoading: true, selectedInvoice: null }));
        try {
            const [est, events] = await Promise.all([
                fetchEstimate(id),
                fetchEstimateEvents(id),
            ]);
            setState(s => ({ ...s, selectedEstimate: est, selectedEstimateEvents: events, selectedEstimateLoading: false }));
        } catch {
            setState(s => ({ ...s, selectedEstimateLoading: false }));
        }
    }, []);

    const clearSelectedEstimate = useCallback(() => {
        setState(s => ({ ...s, selectedEstimate: null, selectedEstimateEvents: [] }));
    }, []);

    // ── Invoice selection ─────────────────────────────────────────────────────

    const selectInvoice = useCallback(async (id: number) => {
        setState(s => ({ ...s, selectedInvoiceLoading: true, selectedEstimate: null }));
        try {
            const [inv, events] = await Promise.all([
                fetchInvoice(id),
                fetchInvoiceEvents(id),
            ]);
            setState(s => ({ ...s, selectedInvoice: inv, selectedInvoiceEvents: events, selectedInvoiceLoading: false }));
        } catch {
            setState(s => ({ ...s, selectedInvoiceLoading: false }));
        }
    }, []);

    const clearSelectedInvoice = useCallback(() => {
        setState(s => ({ ...s, selectedInvoice: null, selectedInvoiceEvents: [] }));
    }, []);

    // ── Estimate mutations ────────────────────────────────────────────────────

    const handleCreateEstimate = useCallback(async (data: EstimateCreateData) => {
        const est = await createEstimate({ ...data, job_id: jobId });
        await load();
        return est;
    }, [jobId, load]);

    const handleUpdateEstimate = useCallback(async (id: number, data: Partial<EstimateCreateData>) => {
        const est = await updateEstimate(id, data);
        setState(s => ({
            ...s,
            estimates: s.estimates.map(e => e.id === id ? est : e),
            selectedEstimate: s.selectedEstimate?.id === id ? est : s.selectedEstimate,
        }));
        return est;
    }, []);

    const handleDeleteEstimate = useCallback(async (id: number) => {
        await deleteEstimate(id);
        setState(s => ({
            ...s,
            estimates: s.estimates.filter(e => e.id !== id),
            selectedEstimate: s.selectedEstimate?.id === id ? null : s.selectedEstimate,
        }));
    }, []);

    const handleApproveEstimate = useCallback(async (id: number) => {
        const est = await approveEstimate(id);
        setState(s => ({
            ...s,
            estimates: s.estimates.map(e => e.id === id ? est : e),
            selectedEstimate: s.selectedEstimate?.id === id ? est : s.selectedEstimate,
        }));
    }, []);

    const handleDeclineEstimate = useCallback(async (id: number) => {
        const est = await declineEstimate(id);
        setState(s => ({
            ...s,
            estimates: s.estimates.map(e => e.id === id ? est : e),
            selectedEstimate: s.selectedEstimate?.id === id ? est : s.selectedEstimate,
        }));
    }, []);

    // ── Invoice mutations ─────────────────────────────────────────────────────

    const handleCreateInvoice = useCallback(async (data: InvoiceCreateData) => {
        const inv = await createInvoice({ ...data, job_id: jobId });
        await load();
        return inv;
    }, [jobId, load]);

    const handleUpdateInvoice = useCallback(async (id: number, data: Partial<InvoiceCreateData>) => {
        const inv = await updateInvoice(id, data);
        setState(s => ({
            ...s,
            invoices: s.invoices.map(i => i.id === id ? inv : i),
            selectedInvoice: s.selectedInvoice?.id === id ? inv : s.selectedInvoice,
        }));
        return inv;
    }, []);

    const handleDeleteInvoice = useCallback(async (id: number) => {
        await deleteInvoice(id);
        setState(s => ({
            ...s,
            invoices: s.invoices.filter(i => i.id !== id),
            selectedInvoice: s.selectedInvoice?.id === id ? null : s.selectedInvoice,
        }));
    }, []);

    const handleSendInvoice = useCallback(async (id: number, data: Parameters<typeof sendInvoice>[1]) => {
        const inv = await sendInvoice(id, data);
        setState(s => ({
            ...s,
            invoices: s.invoices.map(i => i.id === id ? inv : i),
            selectedInvoice: s.selectedInvoice?.id === id ? inv : s.selectedInvoice,
        }));
    }, []);

    const handleVoidInvoice = useCallback(async (id: number) => {
        const inv = await voidInvoice(id);
        setState(s => ({
            ...s,
            invoices: s.invoices.map(i => i.id === id ? inv : i),
            selectedInvoice: s.selectedInvoice?.id === id ? inv : s.selectedInvoice,
        }));
    }, []);

    const handleRecordPayment = useCallback(async (id: number, data: RecordPaymentData) => {
        const inv = await recordPayment(id, data);
        setState(s => ({
            ...s,
            invoices: s.invoices.map(i => i.id === id ? inv : i),
            selectedInvoice: s.selectedInvoice?.id === id ? inv : s.selectedInvoice,
        }));
    }, []);

    const handleSyncEstimate = useCallback(async (id: number) => {
        const inv = await syncItemsFromEstimate(id);
        setState(s => ({
            ...s,
            invoices: s.invoices.map(i => i.id === id ? inv : i),
            selectedInvoice: s.selectedInvoice?.id === id ? inv : s.selectedInvoice,
        }));
    }, []);

    // ── Create invoice from estimate ──────────────────────────────────────────

    const createInvoiceFromEstimate = useCallback(async (estimate: Estimate) => {
        const inv = await createInvoice({
            job_id: jobId,
            estimate_id: estimate.id,
            contact_id: estimate.contact_id,
            lead_id: estimate.lead_id,
            title: estimate.title || undefined,
            notes: estimate.notes || undefined,
            internal_note: estimate.internal_note || undefined,
            tax_rate: estimate.tax_rate,
            discount_amount: estimate.discount_amount,
            items: estimate.items?.map(it => ({
                sort_order: it.sort_order,
                name: it.name,
                description: it.description,
                quantity: it.quantity,
                unit: it.unit,
                unit_price: it.unit_price,
                amount: it.amount,
                taxable: it.taxable,
                metadata: it.metadata,
            })),
        });
        await load();
        return inv;
    }, [jobId, load]);

    return {
        ...state,
        refresh: load,
        selectEstimate,
        clearSelectedEstimate,
        selectInvoice,
        clearSelectedInvoice,
        createEstimate: handleCreateEstimate,
        updateEstimate: handleUpdateEstimate,
        deleteEstimate: handleDeleteEstimate,
        approveEstimate: handleApproveEstimate,
        declineEstimate: handleDeclineEstimate,
        createInvoice: handleCreateInvoice,
        updateInvoice: handleUpdateInvoice,
        deleteInvoice: handleDeleteInvoice,
        sendInvoice: handleSendInvoice,
        voidInvoice: handleVoidInvoice,
        recordPayment: handleRecordPayment,
        syncEstimate: handleSyncEstimate,
        createInvoiceFromEstimate,
    };
}
