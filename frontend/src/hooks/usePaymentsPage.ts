import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { authedFetch } from '../services/apiClient';
import type { PaymentRow, PaymentDetail, SortField, SortDir } from '../components/payments/paymentTypes';
import { defaultDateFrom, defaultDateTo } from '../components/payments/paymentTypes';
import { exportPaymentsCSV } from './paymentExport';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function usePaymentsPage() {
    const { paymentId: urlPaymentId } = useParams<{ paymentId?: string }>();
    const navigate = useNavigate();
    const [dateFrom, setDateFrom] = useState(defaultDateFrom);
    const [dateTo, setDateTo] = useState(defaultDateTo);
    const [methodFilter, setMethodFilter] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [rows, setRows] = useState<PaymentRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [sortField, setSortField] = useState<SortField>('payment_date');
    const [sortDir, setSortDir] = useState<SortDir>('desc');
    const [page, setPage] = useState(0);
    const perPage = 50;
    const [selectedId, setSelectedId] = useState<number | null>(urlPaymentId ? parseInt(urlPaymentId, 10) || null : null);
    const [detail, setDetail] = useState<PaymentDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<string | null>(null);
    const [providerFilter, setProviderFilter] = useState('');
    const [paidFilter, setPaidFilter] = useState<'' | 'paid' | 'due'>('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [datePickerOpen, setDatePickerOpen] = useState(false);
    const [quickFilter, setQuickFilter] = useState<'all' | 'new_checks'>('all');
    const filterRef = useRef<HTMLDivElement>(null);
    const [exporting, setExporting] = useState(false);

    useEffect(() => { const handler = (e: MouseEvent) => { if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFiltersOpen(false); }; if (filtersOpen) document.addEventListener('mousedown', handler); return () => document.removeEventListener('mousedown', handler); }, [filtersOpen]);

    const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => { searchTimer.current = setTimeout(() => setSearchQuery(searchInput), 400); return () => clearTimeout(searchTimer.current); }, [searchInput]);

    const fetchPayments = useCallback(async () => {
        setLoading(true); setError(''); setPage(0);
        try { const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo }); if (methodFilter) qs.set('payment_method', methodFilter); if (searchQuery) qs.set('search', searchQuery); const res = await authedFetch(`${API_BASE}/api/zenbooker/payments?${qs.toString()}`); const json = await res.json(); if (!res.ok || !json.ok) throw new Error(json.error || `Request failed (${res.status})`); setRows(json.data.rows || []); }
        catch (err: any) { setError(err.message || 'Failed to fetch payments'); setRows([]); } finally { setLoading(false); }
    }, [dateFrom, dateTo, methodFilter, searchQuery]);

    useEffect(() => { fetchPayments(); }, [fetchPayments]);

    const handleSync = useCallback(async () => {
        setSyncing(true); setSyncResult(null);
        try { const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date_from: dateFrom, date_to: dateTo }) }); let json; try { json = await res.json(); } catch { throw new Error(res.status === 502 ? 'Sync timed out — try a shorter date range' : `Server error (${res.status})`); } if (!res.ok || !json.ok) throw new Error(json.error || 'Sync failed'); setSyncResult(`Synced ${json.data.synced} payments`); fetchPayments(); }
        catch (err: any) { setSyncResult(`Sync error: ${err.message}`); } finally { setSyncing(false); setTimeout(() => setSyncResult(null), 5000); }
    }, [dateFrom, dateTo, fetchPayments]);

    const fetchDetail = useCallback(async (paymentId: number) => {
        setDetailLoading(true);
        try { const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/${paymentId}`); const json = await res.json(); if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load detail'); setDetail(json.data); }
        catch { setDetail(null); } finally { setDetailLoading(false); }
    }, []);

    const handleSelectRow = (paymentId: number) => { setSelectedId(paymentId); navigate(`/payments/${paymentId}`, { replace: true }); fetchDetail(paymentId); };
    const handleCloseDetail = () => { setSelectedId(null); setDetail(null); navigate('/payments', { replace: true }); };

    const handleToggleDeposited = useCallback(async (deposited: boolean) => {
        if (!detail || !selectedId) return;
        try { const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/${selectedId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ check_deposited: deposited }) }); const json = await res.json(); if (!res.ok || !json.ok) throw new Error(json.error || 'Failed'); setDetail(prev => prev ? { ...prev, check_deposited: deposited } : prev); setRows(prev => prev.map(r => r.id === selectedId ? { ...r, check_deposited: deposited } : r)); }
        catch (err: any) { console.error('Toggle deposited error:', err); }
    }, [detail, selectedId]);

    useEffect(() => { const parsedId = urlPaymentId ? parseInt(urlPaymentId, 10) : null; if (parsedId && parsedId !== selectedId) { setSelectedId(parsedId); fetchDetail(parsedId); } }, [urlPaymentId]);

    const handleSort = (field: SortField) => { if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortField(field); setSortDir('desc'); } setPage(0); };

    const uniqueMethods = useMemo(() => { const set = new Set<string>(); rows.forEach(r => { if (r.display_payment_method) set.add(r.display_payment_method); }); return [...set].sort(); }, [rows]);
    const uniqueProviders = useMemo(() => { const set = new Set<string>(); rows.forEach(r => { if (r.tech && r.tech !== '—') r.tech.split(',').forEach((t: string) => { const n = t.trim(); if (n) set.add(n); }); }); return [...set].sort(); }, [rows]);
    const activeFilterCount = (methodFilter ? 1 : 0) + (providerFilter ? 1 : 0) + (paidFilter ? 1 : 0);
    const clearAllFilters = () => { setMethodFilter(''); setProviderFilter(''); setPaidFilter(''); };
    const undepositedCheckCount = useMemo(() => rows.filter(r => (r.display_payment_method || '').toLowerCase() === 'check' && !r.check_deposited).length, [rows]);

    const sortedRows = useMemo(() => {
        let filtered = [...rows];
        if (quickFilter === 'new_checks') filtered = filtered.filter(r => (r.display_payment_method || '').toLowerCase() === 'check' && !r.check_deposited);
        if (paidFilter === 'paid') filtered = filtered.filter(r => r.invoice_paid_in_full === true); else if (paidFilter === 'due') filtered = filtered.filter(r => r.invoice_paid_in_full !== true);
        if (providerFilter) filtered = filtered.filter(r => r.tech && r.tech.includes(providerFilter));
        filtered.sort((a, b) => { let va: string | number = (a[sortField] ?? '') as string; let vb: string | number = (b[sortField] ?? '') as string; if (sortField === 'amount_paid' || sortField === 'invoice_amount_due') { va = parseFloat(va as string) || 0; vb = parseFloat(vb as string) || 0; } else if (sortField === 'payment_date') { va = new Date(va as string).getTime() || 0; vb = new Date(vb as string).getTime() || 0; } else { va = (va as string || '').toLowerCase(); vb = (vb as string || '').toLowerCase(); } if (va < vb) return sortDir === 'asc' ? -1 : 1; if (va > vb) return sortDir === 'asc' ? 1 : -1; return 0; });
        return filtered;
    }, [rows, sortField, sortDir, paidFilter, providerFilter, quickFilter]);

    const totalPages = Math.ceil(sortedRows.length / perPage);
    const pagedRows = sortedRows.slice(page * perPage, (page + 1) * perPage);
    const totalAmount = useMemo(() => rows.reduce((sum, r) => sum + (parseFloat(r.amount_paid) || 0), 0), [rows]);

    const handleExportCSV = async () => { if (sortedRows.length === 0) return; setExporting(true); try { await exportPaymentsCSV(dateFrom, dateTo, methodFilter, searchQuery); } catch (err: any) { console.error('Export error:', err); } finally { setExporting(false); } };

    return {
        rows, loading, error, sortedRows, pagedRows, totalPages, page, setPage, perPage, totalAmount,
        dateFrom, setDateFrom, dateTo, setDateTo, methodFilter, setMethodFilter, searchInput, setSearchInput,
        providerFilter, setProviderFilter, paidFilter, setPaidFilter, filtersOpen, setFiltersOpen,
        datePickerOpen, setDatePickerOpen, quickFilter, setQuickFilter, filterRef,
        uniqueMethods, uniqueProviders, activeFilterCount, clearAllFilters, undepositedCheckCount,
        sortField, sortDir, handleSort, selectedId, detail, detailLoading,
        handleSelectRow, handleCloseDetail, handleToggleDeposited, syncing, syncResult, handleSync,
        exporting, handleExportCSV,
    };
}
