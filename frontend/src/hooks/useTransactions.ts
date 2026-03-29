/**
 * useTransactions — state management hook for the Transactions page (PF004).
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import * as paymentsApi from '../services/paymentsCanonicalApi';
import type {
    PaymentTransaction,
    TransactionsListParams,
    TransactionsListResult,
    CreateTransactionData,
    RefundData,
    SendReceiptData,
    PaymentSummary,
    PaymentReceipt,
} from '../services/paymentsCanonicalApi';

export interface TransactionFilters {
    search: string;
    status: string;
    transaction_type: string;
    page: number;
    limit: number;
}

const DEFAULT_FILTERS: TransactionFilters = {
    search: '',
    status: '',
    transaction_type: '',
    page: 1,
    limit: 25,
};

export function useTransactions() {
    const [transactions, setTransactions] = useState<PaymentTransaction[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedTransaction, setSelectedTransaction] = useState<PaymentTransaction | null>(null);
    const [filters, setFilters] = useState<TransactionFilters>(DEFAULT_FILTERS);
    const [total, setTotal] = useState(0);
    const [summary, setSummary] = useState<PaymentSummary | null>(null);
    const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);

    // -- Load list ------------------------------------------------------------
    const loadTransactions = useCallback(async (overrideFilters?: Partial<TransactionFilters>) => {
        setLoading(true);
        setError(null);
        try {
            const f = { ...filters, ...overrideFilters };
            const params: TransactionsListParams = {
                page: f.page,
                limit: f.limit,
            };
            if (f.status) params.status = f.status;
            if (f.transaction_type) params.transaction_type = f.transaction_type;
            if (f.search) params.search = f.search;

            const result: TransactionsListResult = await paymentsApi.fetchTransactions(params);
            setTransactions(result.transactions);
            setTotal(result.total);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to load transactions';
            setError(msg);
            toast.error('Failed to load transactions', { description: msg });
        } finally {
            setLoading(false);
        }
    }, [filters]);

    const loadSummary = useCallback(async () => {
        try {
            const s = await paymentsApi.fetchPaymentSummary();
            setSummary(s);
        } catch {
            // non-critical — don't block the page
        }
    }, []);

    useEffect(() => {
        loadTransactions();
    }, [filters.status, filters.transaction_type, filters.search, filters.page, filters.limit]);

    useEffect(() => {
        loadSummary();
    }, []);

    // -- Select / detail ------------------------------------------------------
    const selectTransaction = useCallback(async (id: number) => {
        try {
            const txn = await paymentsApi.fetchTransaction(id);
            setSelectedTransaction(txn);
            // try to load receipt
            try {
                const r = await paymentsApi.fetchReceipt(id);
                setReceipt(r);
            } catch {
                setReceipt(null);
            }
        } catch {
            toast.error('Failed to load transaction details');
        }
    }, []);

    const closeDetail = useCallback(() => {
        setSelectedTransaction(null);
        setReceipt(null);
    }, []);

    // -- Actions --------------------------------------------------------------
    const handleCreateTransaction = useCallback(async (data: CreateTransactionData) => {
        const txn = await paymentsApi.createTransaction(data);
        toast.success('Transaction created');
        await loadTransactions();
        await loadSummary();
        return txn;
    }, [loadTransactions, loadSummary]);

    const handleRecordManual = useCallback(async (data: CreateTransactionData) => {
        const txn = await paymentsApi.recordManualPayment(data);
        toast.success('Payment recorded');
        await loadTransactions();
        await loadSummary();
        return txn;
    }, [loadTransactions, loadSummary]);

    const handleRefund = useCallback(async (id: number, data: RefundData) => {
        const txn = await paymentsApi.refundTransaction(id, data);
        toast.success('Refund initiated');
        await loadTransactions();
        await loadSummary();
        if (selectedTransaction?.id === id) {
            setSelectedTransaction(txn);
        }
        return txn;
    }, [loadTransactions, loadSummary, selectedTransaction]);

    const handleVoid = useCallback(async (id: number) => {
        const txn = await paymentsApi.voidTransaction(id);
        toast.success('Transaction voided');
        await loadTransactions();
        await loadSummary();
        if (selectedTransaction?.id === id) {
            setSelectedTransaction(txn);
        }
        return txn;
    }, [loadTransactions, loadSummary, selectedTransaction]);

    const handleSendReceipt = useCallback(async (id: number, data: SendReceiptData) => {
        const r = await paymentsApi.sendReceipt(id, data);
        toast.success('Receipt sent');
        if (selectedTransaction?.id === id) {
            setReceipt(r);
        }
        return r;
    }, [selectedTransaction]);

    // -- Filter helpers -------------------------------------------------------
    const setSearch = useCallback((search: string) => {
        setFilters(f => ({ ...f, search, page: 1 }));
    }, []);

    const setStatus = useCallback((status: string) => {
        setFilters(f => ({ ...f, status, page: 1 }));
    }, []);

    const setType = useCallback((transaction_type: string) => {
        setFilters(f => ({ ...f, transaction_type, page: 1 }));
    }, []);

    const setPage = useCallback((page: number) => {
        setFilters(f => ({ ...f, page }));
    }, []);

    // -- Pagination -----------------------------------------------------------
    const totalPages = Math.ceil(total / filters.limit) || 1;

    return {
        transactions,
        loading,
        error,
        selectedTransaction,
        filters,
        total,
        totalPages,
        summary,
        receipt,
        loadTransactions,
        selectTransaction,
        closeDetail,
        handleCreateTransaction,
        handleRecordManual,
        handleRefund,
        handleVoid,
        handleSendReceipt,
        setSearch,
        setStatus,
        setType,
        setPage,
    };
}
