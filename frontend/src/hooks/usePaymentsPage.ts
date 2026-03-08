import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { authedFetch } from '../services/apiClient';
import type { PaymentRow, PaymentDetail, SortField, SortDir } from '../components/payments/paymentTypes';
import { defaultDateFrom, defaultDateTo } from '../components/payments/paymentTypes';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function usePaymentsPage() {
    const { paymentId: urlPaymentId } = useParams<{ paymentId?: string }>();
    const navigate = useNavigate();

    // Filter state
    const [dateFrom, setDateFrom] = useState(defaultDateFrom);
    const [dateTo, setDateTo] = useState(defaultDateTo);
    const [methodFilter, setMethodFilter] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');

    // Data state
    const [rows, setRows] = useState<PaymentRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Sort state
    const [sortField, setSortField] = useState<SortField>('payment_date');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    // Pagination
    const [page, setPage] = useState(0);
    const perPage = 50;

    // Detail panel
    const [selectedId, setSelectedId] = useState<number | null>(urlPaymentId ? parseInt(urlPaymentId, 10) || null : null);
    const [detail, setDetail] = useState<PaymentDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);

    // Sync state
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<string | null>(null);

    // Advanced filters
    const [providerFilter, setProviderFilter] = useState('');
    const [paidFilter, setPaidFilter] = useState<'' | 'paid' | 'due'>('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [datePickerOpen, setDatePickerOpen] = useState(false);
    const [quickFilter, setQuickFilter] = useState<'all' | 'new_checks'>('all');
    const filterRef = useRef<HTMLDivElement>(null);

    const [exporting, setExporting] = useState(false);

    // Close filters dropdown on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
                setFiltersOpen(false);
            }
        };
        if (filtersOpen) document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [filtersOpen]);

    // Search debounce
    const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => {
        searchTimer.current = setTimeout(() => setSearchQuery(searchInput), 400);
        return () => clearTimeout(searchTimer.current);
    }, [searchInput]);

    // ── Fetch list ────────────────────────────────────────────────────────────

    const fetchPayments = useCallback(async () => {
        setLoading(true);
        setError('');
        setPage(0);
        try {
            const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
            if (methodFilter) qs.set('payment_method', methodFilter);
            if (searchQuery) qs.set('search', searchQuery);

            const res = await authedFetch(`${API_BASE}/api/zenbooker/payments?${qs.toString()}`);
            const json = await res.json();

            if (!res.ok || !json.ok) {
                throw new Error(json.error || `Request failed (${res.status})`);
            }
            setRows(json.data.rows || []);
        } catch (err: any) {
            setError(err.message || 'Failed to fetch payments');
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [dateFrom, dateTo, methodFilter, searchQuery]);

    useEffect(() => { fetchPayments(); }, [fetchPayments]);

    // ── Sync payments ─────────────────────────────────────────────────────────

    const handleSync = useCallback(async () => {
        setSyncing(true);
        setSyncResult(null);
        try {
            const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date_from: dateFrom, date_to: dateTo }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Sync failed');
            setSyncResult(`Synced ${json.data.synced} payments`);
            fetchPayments();
        } catch (err: any) {
            setSyncResult(`Sync error: ${err.message}`);
        } finally {
            setSyncing(false);
            setTimeout(() => setSyncResult(null), 5000);
        }
    }, [dateFrom, dateTo, fetchPayments]);

    // ── Fetch detail ──────────────────────────────────────────────────────────

    const fetchDetail = useCallback(async (paymentId: number) => {
        setDetailLoading(true);
        try {
            const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/${paymentId}`);
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load detail');
            setDetail(json.data);
        } catch (err: any) {
            console.error('Detail fetch error:', err);
            setDetail(null);
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const handleSelectRow = (paymentId: number) => {
        setSelectedId(paymentId);
        navigate(`/payments/${paymentId}`, { replace: true });
        fetchDetail(paymentId);
    };

    const handleCloseDetail = () => {
        setSelectedId(null);
        setDetail(null);
        navigate('/payments', { replace: true });
    };

    const handleToggleDeposited = useCallback(async (deposited: boolean) => {
        if (!detail || !selectedId) return;
        try {
            const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/${selectedId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ check_deposited: deposited }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed');
            setDetail(prev => prev ? { ...prev, check_deposited: deposited } : prev);
            setRows(prev => prev.map(r =>
                r.id === selectedId ? { ...r, check_deposited: deposited } : r
            ));
        } catch (err: any) {
            console.error('Toggle deposited error:', err);
        }
    }, [detail, selectedId]);

    useEffect(() => {
        const parsedId = urlPaymentId ? parseInt(urlPaymentId, 10) : null;
        if (parsedId && parsedId !== selectedId) {
            setSelectedId(parsedId);
            fetchDetail(parsedId);
        }
    }, [urlPaymentId]);

    // ── Sorting ───────────────────────────────────────────────────────────────

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortField(field);
            setSortDir('desc');
        }
        setPage(0);
    };

    // ── Client-side filter helpers ────────────────────────────────────────────

    const uniqueMethods = useMemo(() => {
        const set = new Set<string>();
        rows.forEach(r => { if (r.display_payment_method) set.add(r.display_payment_method); });
        return [...set].sort();
    }, [rows]);

    const uniqueProviders = useMemo(() => {
        const set = new Set<string>();
        rows.forEach(r => {
            if (r.tech && r.tech !== '—') {
                r.tech.split(',').forEach((t: string) => { const name = t.trim(); if (name) set.add(name); });
            }
        });
        return [...set].sort();
    }, [rows]);

    const activeFilterCount = (methodFilter ? 1 : 0) + (providerFilter ? 1 : 0) + (paidFilter ? 1 : 0);

    const clearAllFilters = () => {
        setMethodFilter('');
        setProviderFilter('');
        setPaidFilter('');
    };

    const undepositedCheckCount = useMemo(() =>
        rows.filter(r => (r.display_payment_method || '').toLowerCase() === 'check' && !r.check_deposited).length,
        [rows]
    );

    const sortedRows = useMemo(() => {
        let filtered = [...rows];
        if (quickFilter === 'new_checks') {
            filtered = filtered.filter(r =>
                (r.display_payment_method || '').toLowerCase() === 'check' && !r.check_deposited
            );
        }
        if (paidFilter === 'paid') {
            filtered = filtered.filter(r => r.invoice_paid_in_full === true);
        } else if (paidFilter === 'due') {
            filtered = filtered.filter(r => r.invoice_paid_in_full !== true);
        }
        if (providerFilter) {
            filtered = filtered.filter(r => r.tech && r.tech.includes(providerFilter));
        }
        filtered.sort((a, b) => {
            let va: string | number = (a[sortField] ?? '') as string;
            let vb: string | number = (b[sortField] ?? '') as string;
            if (sortField === 'amount_paid' || sortField === 'invoice_amount_due') {
                va = parseFloat(va as string) || 0;
                vb = parseFloat(vb as string) || 0;
            } else if (sortField === 'payment_date') {
                va = new Date(va as string).getTime() || 0;
                vb = new Date(vb as string).getTime() || 0;
            } else {
                va = (va as string || '').toLowerCase();
                vb = (vb as string || '').toLowerCase();
            }
            if (va < vb) return sortDir === 'asc' ? -1 : 1;
            if (va > vb) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });
        return filtered;
    }, [rows, sortField, sortDir, paidFilter, providerFilter, quickFilter]);

    // ── Pagination ────────────────────────────────────────────────────────────

    const totalPages = Math.ceil(sortedRows.length / perPage);
    const pagedRows = sortedRows.slice(page * perPage, (page + 1) * perPage);

    const totalAmount = useMemo(
        () => rows.reduce((sum, r) => sum + (parseFloat(r.amount_paid) || 0), 0),
        [rows]
    );

    // ── Export ────────────────────────────────────────────────────────────

    const handleExportCSV = async () => {
        if (sortedRows.length === 0) return;
        setExporting(true);
        try {
            const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
            if (methodFilter) qs.set('payment_method', methodFilter);
            if (searchQuery) qs.set('search', searchQuery);

            const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/export?${qs.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Export failed');

            const exportRows: Record<string, string>[] = json.data;
            const headers = ['Job #', 'Client', 'Job Type', 'Status', 'Payment Methods', 'Amount Paid', 'Tags', 'Date', 'Source', 'Tech', 'Claim ID and Other'];
            const csvRows = exportRows.map(r => [
                r.job_number || '', r.client || '', r.job_type || '', r.status || '',
                r.payment_methods || '', r.amount_paid || '', r.tags || '',
                r.payment_date || '', r.source || '', r.tech || '', r.custom_fields || '',
            ]);
            const escape = (val: string) => {
                if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            };
            const csv = [headers.map(escape).join(','), ...csvRows.map(row => row.map(escape).join(','))].join('\n');

            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `payments_${dateFrom}_${dateTo}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err: any) {
            console.error('Export error:', err);
        } finally {
            setExporting(false);
        }
    };

    return {
        // Data
        rows, loading, error,
        sortedRows, pagedRows,
        totalPages, page, setPage, perPage,
        totalAmount,
        // Filters
        dateFrom, setDateFrom, dateTo, setDateTo,
        methodFilter, setMethodFilter,
        searchInput, setSearchInput,
        providerFilter, setProviderFilter,
        paidFilter, setPaidFilter,
        filtersOpen, setFiltersOpen,
        datePickerOpen, setDatePickerOpen,
        quickFilter, setQuickFilter,
        filterRef,
        uniqueMethods, uniqueProviders,
        activeFilterCount, clearAllFilters,
        undepositedCheckCount,
        // Sort
        sortField, sortDir, handleSort,
        // Detail
        selectedId, detail, detailLoading,
        handleSelectRow, handleCloseDetail, handleToggleDeposited,
        // Sync
        syncing, syncResult, handleSync,
        // Export
        exporting, handleExportCSV,
    };
}
