/**
 * useInvoices — state management hook for the Invoices page.
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import * as invoicesApi from '../services/invoicesApi';
import type {
    Invoice,
    InvoicesListParams,
    InvoicesListResult,
    InvoiceCreateData,
    InvoiceSendData,
    RecordPaymentData,
    InvoiceEvent,
} from '../services/invoicesApi';

export interface InvoiceFilters {
    status: string;
    search: string;
    page: number;
    limit: number;
}

const DEFAULT_FILTERS: InvoiceFilters = {
    status: '',
    search: '',
    page: 1,
    limit: 50,
};

export function useInvoices() {
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [filters, setFilters] = useState<InvoiceFilters>(DEFAULT_FILTERS);
    const [total, setTotal] = useState(0);
    const [events, setEvents] = useState<InvoiceEvent[]>([]);

    // ── Load list ────────────────────────────────────────────────────────────
    const loadInvoices = useCallback(async (overrideFilters?: Partial<InvoiceFilters>) => {
        setLoading(true);
        setError(null);
        try {
            const f = { ...filters, ...overrideFilters };
            const params: InvoicesListParams = {
                page: f.page,
                limit: f.limit,
            };
            if (f.status) params.status = f.status;
            if (f.search) params.search = f.search;

            const result: InvoicesListResult = await invoicesApi.fetchInvoices(params);
            setInvoices(result.invoices);
            setTotal(result.total);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to load invoices';
            setError(msg);
            toast.error('Failed to load invoices', { description: msg });
        } finally {
            setLoading(false);
        }
    }, [filters]);

    useEffect(() => {
        loadInvoices();
    }, [filters.status, filters.search, filters.page, filters.limit]);

    // ── Select / detail ──────────────────────────────────────────────────────
    const selectInvoice = useCallback(async (id: number) => {
        setDetailLoading(true);
        try {
            const invoice = await invoicesApi.fetchInvoice(id);
            setSelectedInvoice(invoice);
            // load events
            const evts = await invoicesApi.fetchInvoiceEvents(id);
            setEvents(evts);
        } catch (err) {
            toast.error('Failed to load invoice details');
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const closeDetail = useCallback(() => {
        setSelectedInvoice(null);
        setEvents([]);
    }, []);

    // ── CRUD ─────────────────────────────────────────────────────────────────
    const handleCreateInvoice = useCallback(async (data: InvoiceCreateData) => {
        const invoice = await invoicesApi.createInvoice(data);
        toast.success('Invoice created');
        await loadInvoices();
        return invoice;
    }, [loadInvoices]);

    const handleUpdateInvoice = useCallback(async (id: number, data: Partial<InvoiceCreateData>) => {
        const invoice = await invoicesApi.updateInvoice(id, data);
        toast.success('Invoice updated');
        await loadInvoices();
        if (selectedInvoice?.id === id) {
            setSelectedInvoice(invoice);
        }
        return invoice;
    }, [loadInvoices, selectedInvoice]);

    const handleDeleteInvoice = useCallback(async (id: number) => {
        await invoicesApi.deleteInvoice(id);
        toast.success('Invoice deleted');
        if (selectedInvoice?.id === id) {
            setSelectedInvoice(null);
            setEvents([]);
        }
        await loadInvoices();
    }, [loadInvoices, selectedInvoice]);

    // ── Actions ──────────────────────────────────────────────────────────────
    const handleSendInvoice = useCallback(async (id: number, data: InvoiceSendData) => {
        const invoice = await invoicesApi.sendInvoice(id, data);
        toast.success('Invoice sent');
        await loadInvoices();
        if (selectedInvoice?.id === id) {
            setSelectedInvoice(invoice);
        }
        return invoice;
    }, [loadInvoices, selectedInvoice]);

    const handleVoidInvoice = useCallback(async (id: number) => {
        const invoice = await invoicesApi.voidInvoice(id);
        toast.success('Invoice voided');
        await loadInvoices();
        if (selectedInvoice?.id === id) {
            setSelectedInvoice(invoice);
        }
    }, [loadInvoices, selectedInvoice]);

    const handleRecordPayment = useCallback(async (id: number, data: RecordPaymentData) => {
        const invoice = await invoicesApi.recordPayment(id, data);
        toast.success('Payment recorded');
        await loadInvoices();
        if (selectedInvoice?.id === id) {
            setSelectedInvoice(invoice);
        }
        return invoice;
    }, [loadInvoices, selectedInvoice]);

    const handleSyncItems = useCallback(async (id: number) => {
        const invoice = await invoicesApi.syncItemsFromEstimate(id);
        toast.success('Items synced from estimate');
        await loadInvoices();
        if (selectedInvoice?.id === id) {
            setSelectedInvoice(invoice);
        }
    }, [loadInvoices, selectedInvoice]);

    // ── Filter helpers ───────────────────────────────────────────────────────
    const setStatus = useCallback((status: string) => {
        setFilters(f => ({ ...f, status, page: 1 }));
    }, []);

    const setSearch = useCallback((search: string) => {
        setFilters(f => ({ ...f, search, page: 1 }));
    }, []);

    const setPage = useCallback((page: number) => {
        setFilters(f => ({ ...f, page }));
    }, []);

    // ── Pagination ───────────────────────────────────────────────────────────
    const totalPages = Math.ceil(total / filters.limit) || 1;

    return {
        invoices,
        loading,
        error,
        selectedInvoice,
        detailLoading,
        filters,
        total,
        totalPages,
        events,
        loadInvoices,
        selectInvoice,
        closeDetail,
        handleCreateInvoice,
        handleUpdateInvoice,
        handleDeleteInvoice,
        handleSendInvoice,
        handleVoidInvoice,
        handleRecordPayment,
        handleSyncItems,
        setStatus,
        setSearch,
        setPage,
    };
}
