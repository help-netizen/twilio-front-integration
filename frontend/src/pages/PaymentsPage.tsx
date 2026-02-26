/**
 * PaymentsPage — Zenbooker Payments (Split-View)
 * Page at /payments
 *
 * Left:  filterable, sortable, searchable payments table
 * Right: PaymentDetailPanel with invoice, job, providers, attachments gallery
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Loader2, Download, Search, DollarSign, X,
    ChevronLeft, ChevronRight, FileText,
    User2, MapPin, Receipt, ChevronDown, ImageIcon, ExternalLink,
    RefreshCw, CalendarIcon,
} from 'lucide-react';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Calendar } from '../components/ui/calendar';
import { format } from 'date-fns';
import { authedFetch } from '../services/apiClient';
import './PaymentsPage.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaymentRow {
    id: number;
    job_number: string;
    client: string;
    job_type: string;
    status: string;
    payment_methods: string;
    display_payment_method: string;
    amount_paid: string;
    tags: string;
    payment_date: string;
    source: string;
    tech: string;
    transaction_id: string;
    invoice_id: string;
    job_id: string;
    transaction_status: string;
    missing_job_link: boolean;
    invoice_status: string | null;
    invoice_total: string | null;
    invoice_amount_paid: string | null;
    invoice_amount_due: string | null;
    invoice_paid_in_full: boolean;
    check_deposited: boolean;
}

interface Attachment {
    url: string;
    kind: 'image' | 'file';
    source: string;
    note_id: string | null;
    filename: string;
}

interface Provider {
    id: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
}

interface PaymentDetail extends Omit<PaymentRow, 'check_deposited'> {
    id: number;
    check_deposited: boolean;
    invoice: {
        status: string;
        total: string;
        amount_paid: string;
        amount_due: string;
        paid_in_full: boolean;
    } | null;
    job: {
        job_number: string | null;
        service_name: string | null;
        service_address: string | null;
        providers: Provider[];
    } | null;
    attachments: Attachment[];
    metadata: {
        transaction_id: string;
        invoice_id: string | null;
        customer_id: string | null;
        territory_id: string | null;
        initiated_by: string | null;
        team_member_id: string | null;
        memo: string | null;
    };
    _warning: string | null;
}

type SortField = 'payment_date' | 'amount_paid' | 'invoice_amount_due' | 'job_number' | 'client' | 'payment_methods' | 'tech';
type SortDir = 'asc' | 'desc';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPaymentDate(iso: string): string {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });
    } catch {
        return iso;
    }
}

function defaultDateFrom(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function defaultDateTo(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatCurrency(amount: string): string {
    const n = parseFloat(amount);
    if (isNaN(n)) return '$0.00';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function paymentMethodIcon(method: string): string {
    const m = method.toLowerCase();
    if (m.includes('stripe') || m.includes('card') || m.includes('credit')) return '💳';
    if (m.includes('cash')) return '💵';
    if (m.includes('check')) return '📝';
    if (m.includes('venmo')) return '📱';
    if (m.includes('zelle')) return '⚡';
    return '💰';
}

// ── Columns definition ───────────────────────────────────────────────────────

const COLUMNS: { key: keyof PaymentRow; label: string; sortable?: boolean; className?: string }[] = [
    { key: 'payment_date', label: 'Date', sortable: true },
    { key: 'amount_paid', label: 'Amount', sortable: true, className: 'amount-cell' },
    { key: 'invoice_amount_due', label: 'Due', sortable: true, className: 'due-cell' },
    { key: 'payment_methods', label: 'Method', sortable: true },
    { key: 'job_number', label: 'Job #', sortable: true },
    { key: 'client', label: 'Customer', sortable: true },
    { key: 'tech', label: 'Provider', sortable: true },
];

// ── Main Component ────────────────────────────────────────────────────────────

export default function PaymentsPage() {
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
            const qs = new URLSearchParams({
                date_from: dateFrom,
                date_to: dateTo,
            });
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

    // Auto-load on filter change
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
            if (!res.ok || !json.ok) {
                throw new Error(json.error || 'Sync failed');
            }
            setSyncResult(`Synced ${json.data.synced} payments`);
            // Reload list after sync
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
            if (!res.ok || !json.ok) {
                throw new Error(json.error || 'Failed to load detail');
            }
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

    // Toggle check_deposited flag
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
            // Update detail
            setDetail(prev => prev ? { ...prev, check_deposited: deposited } : prev);
            // Update rows list
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

    // ── Sorting + client-side filter ────────────────────────────────────────

    // Count of undeposited checks (respects date range via rows which are already date-filtered)
    const undepositedCheckCount = useMemo(() =>
        rows.filter(r => (r.display_payment_method || '').toLowerCase() === 'check' && !r.check_deposited).length,
        [rows]
    );

    const sortedRows = useMemo(() => {
        let filtered = [...rows];

        // Quick filter
        if (quickFilter === 'new_checks') {
            filtered = filtered.filter(r =>
                (r.display_payment_method || '').toLowerCase() === 'check' && !r.check_deposited
            );
        }

        // Client-side paid filter
        if (paidFilter === 'paid') {
            filtered = filtered.filter(r => r.invoice_paid_in_full === true);
        } else if (paidFilter === 'due') {
            filtered = filtered.filter(r => r.invoice_paid_in_full !== true);
        }

        // Client-side provider filter
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

    // ── CSV Export ─────────────────────────────────────────────────────────────

    const handleExportCSV = () => {
        if (sortedRows.length === 0) return;

        const headers = [
            'Date', 'Amount', 'Method', 'Job #', 'Customer', 'Job Type',
            'Status', 'Tags', 'Source', 'Tech', 'Invoice Status', 'Paid in Full',
            'Transaction ID', 'Invoice ID', 'Job ID',
        ];

        const csvRows = sortedRows.map(r => [
            r.payment_date,
            r.amount_paid,
            r.payment_methods,
            r.job_number,
            r.client,
            r.job_type,
            r.status,
            r.tags,
            r.source,
            r.tech,
            r.invoice_status || '',
            r.invoice_paid_in_full ? 'Yes' : 'No',
            r.transaction_id,
            r.invoice_id,
            r.job_id,
        ]);

        const escape = (val: string) => {
            if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
        };

        const csv = [
            headers.map(escape).join(','),
            ...csvRows.map(row => row.map(escape).join(',')),
        ].join('\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `payments_${dateFrom}_${dateTo}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <div className="payments-split-container">
            {/* ── Left: List Panel ─────────────────────────────────── */}
            <div className={`payments-list-panel ${selectedId ? 'has-detail' : ''}`}>
                {/* Header */}
                <div className="border-b p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <h2 className="text-xl font-semibold">Payments</h2>
                            <div className="flex gap-1">
                                <Button
                                    variant={quickFilter === 'all' ? 'default' : 'ghost'}
                                    size="sm"
                                    onClick={() => { setQuickFilter('all'); setPage(0); }}
                                >
                                    All
                                </Button>
                                <Button
                                    variant={quickFilter === 'new_checks' ? 'default' : 'ghost'}
                                    size="sm"
                                    onClick={() => { setQuickFilter('new_checks'); setPage(0); }}
                                    className="gap-1.5"
                                >
                                    New checks
                                    {undepositedCheckCount > 0 && (
                                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0 min-w-[18px] h-[18px] justify-center">
                                            {undepositedCheckCount}
                                        </Badge>
                                    )}
                                </Button>
                            </div>
                        </div>
                        <div className="flex items-center gap-1">
                            {syncResult && (
                                <span style={{ fontSize: '12px', color: syncResult.startsWith('Sync error') ? '#ef4444' : '#22c55e' }}>
                                    {syncResult}
                                </span>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleSync}
                                disabled={syncing}
                            >
                                <RefreshCw className={`size-4 mr-1 ${syncing ? 'animate-spin' : ''}`} />
                                {syncing ? 'Syncing…' : 'Sync'}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleExportCSV}
                                disabled={sortedRows.length === 0}
                            >
                                <Download className="size-4 mr-1" /> Export
                            </Button>
                        </div>
                    </div>

                    {/* Filters — Jobs-style */}
                    <div className="flex flex-wrap gap-3 items-center">
                        {/* Search + Filter Dropdown */}
                        <div className="relative flex-1 min-w-[200px]" ref={filterRef}>
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground z-10" />
                            <Input
                                placeholder="Search customer, job #, provider…"
                                value={searchInput}
                                onChange={e => setSearchInput(e.target.value)}
                                onFocus={() => setFiltersOpen(true)}
                                className="pl-9"
                            />

                            {/* Filter Dropdown Panel */}
                            {filtersOpen && (
                                <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-lg shadow-lg z-50 p-0 overflow-hidden">
                                    {/* Active filter badges */}
                                    {activeFilterCount > 0 && (
                                        <div className="flex flex-wrap gap-1.5 p-3 pb-0 items-center">
                                            {methodFilter && (
                                                <Badge variant="secondary" className="gap-1 text-xs">
                                                    {methodFilter}
                                                    <X className="size-3 cursor-pointer" onClick={() => setMethodFilter('')} />
                                                </Badge>
                                            )}
                                            {providerFilter && (
                                                <Badge variant="outline" className="gap-1 text-xs">
                                                    {providerFilter}
                                                    <X className="size-3 cursor-pointer" onClick={() => setProviderFilter('')} />
                                                </Badge>
                                            )}
                                            {paidFilter && (
                                                <Badge variant="default" className="gap-1 text-xs">
                                                    {paidFilter === 'paid' ? 'Paid in Full' : 'Has Balance Due'}
                                                    <X className="size-3 cursor-pointer" onClick={() => setPaidFilter('')} />
                                                </Badge>
                                            )}
                                            <button
                                                onClick={clearAllFilters}
                                                className="text-xs text-muted-foreground hover:text-foreground ml-1"
                                            >
                                                Clear all
                                            </button>
                                        </div>
                                    )}

                                    {/* Columns */}
                                    <div className="grid grid-cols-3 divide-x p-3 gap-0">
                                        {/* Payment Method */}
                                        <div className="px-3">
                                            <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">PAYMENT METHOD</div>
                                            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                                                {uniqueMethods.length === 0 && (
                                                    <div className="text-xs text-muted-foreground italic py-1">None available</div>
                                                )}
                                                {uniqueMethods.map(m => {
                                                    const isSelected = methodFilter === m;
                                                    return (
                                                        <button
                                                            key={m}
                                                            type="button"
                                                            onClick={() => setMethodFilter(isSelected ? '' : m)}
                                                            className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${isSelected
                                                                ? 'bg-primary/10 text-primary font-medium'
                                                                : 'hover:bg-muted text-foreground'
                                                                }`}
                                                        >
                                                            <div className={`size-4 border rounded flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary border-primary' : 'border-input'}`}>
                                                                {isSelected && <span className="text-[10px] text-primary-foreground">✓</span>}
                                                            </div>
                                                            {m}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        {/* Provider */}
                                        <div className="px-3">
                                            <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">PROVIDER</div>
                                            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                                                {uniqueProviders.length === 0 && (
                                                    <div className="text-xs text-muted-foreground italic py-1">None available</div>
                                                )}
                                                {uniqueProviders.map(p => {
                                                    const isSelected = providerFilter === p;
                                                    return (
                                                        <button
                                                            key={p}
                                                            type="button"
                                                            onClick={() => setProviderFilter(isSelected ? '' : p)}
                                                            className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${isSelected
                                                                ? 'bg-primary/10 text-primary font-medium'
                                                                : 'hover:bg-muted text-foreground'
                                                                }`}
                                                        >
                                                            <div className={`size-4 border rounded flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary border-primary' : 'border-input'}`}>
                                                                {isSelected && <span className="text-[10px] text-primary-foreground">✓</span>}
                                                            </div>
                                                            {p}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        {/* Invoice Status */}
                                        <div className="px-3">
                                            <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">INVOICE STATUS</div>
                                            <div className="space-y-0.5">
                                                {(['paid', 'due'] as const).map(val => {
                                                    const isSelected = paidFilter === val;
                                                    const label = val === 'paid' ? 'Paid in Full' : 'Has Balance Due';
                                                    return (
                                                        <button
                                                            key={val}
                                                            type="button"
                                                            onClick={() => setPaidFilter(isSelected ? '' : val)}
                                                            className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${isSelected
                                                                ? 'bg-primary/10 text-primary font-medium'
                                                                : 'hover:bg-muted text-foreground'
                                                                }`}
                                                        >
                                                            <div className={`size-4 border rounded flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary border-primary' : 'border-input'}`}>
                                                                {isSelected && <span className="text-[10px] text-primary-foreground">✓</span>}
                                                            </div>
                                                            {label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Active filter count badge */}
                        {activeFilterCount > 0 && (
                            <Badge variant="secondary" className="gap-1">
                                {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''}
                                <X className="size-3 cursor-pointer" onClick={clearAllFilters} />
                            </Badge>
                        )}

                        {/* Date Range Picker */}
                        <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className="gap-2">
                                    <CalendarIcon className="size-4" />
                                    {dateFrom && dateTo
                                        ? `${format(new Date(dateFrom + 'T00:00:00'), 'MMM dd')} – ${format(new Date(dateTo + 'T00:00:00'), 'MMM dd, yyyy')}`
                                        : dateFrom
                                            ? `From ${format(new Date(dateFrom + 'T00:00:00'), 'MMM dd, yyyy')}`
                                            : 'Date Range'
                                    }
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="end">
                                <div className="flex">
                                    <div className="border-r p-3 space-y-1">
                                        <div className="text-sm font-medium mb-2">Presets</div>
                                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                                            const today = new Date();
                                            setDateFrom(format(today, 'yyyy-MM-dd'));
                                            setDateTo(format(today, 'yyyy-MM-dd'));
                                            setDatePickerOpen(false);
                                        }}>Today</Button>
                                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                                            const d = new Date(); d.setDate(d.getDate() - 7);
                                            setDateFrom(format(d, 'yyyy-MM-dd'));
                                            setDateTo(format(new Date(), 'yyyy-MM-dd'));
                                            setDatePickerOpen(false);
                                        }}>Last 7 days</Button>
                                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                                            const d = new Date(); d.setDate(d.getDate() - 30);
                                            setDateFrom(format(d, 'yyyy-MM-dd'));
                                            setDateTo(format(new Date(), 'yyyy-MM-dd'));
                                            setDatePickerOpen(false);
                                        }}>Last 30 days</Button>
                                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                                            const now = new Date();
                                            setDateFrom(format(new Date(now.getFullYear(), now.getMonth(), 1), 'yyyy-MM-dd'));
                                            setDateTo(format(now, 'yyyy-MM-dd'));
                                            setDatePickerOpen(false);
                                        }}>This Month</Button>
                                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                                            const now = new Date();
                                            const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                                            const last = new Date(now.getFullYear(), now.getMonth(), 0);
                                            setDateFrom(format(prev, 'yyyy-MM-dd'));
                                            setDateTo(format(last, 'yyyy-MM-dd'));
                                            setDatePickerOpen(false);
                                        }}>Last Month</Button>
                                    </div>
                                    <div className="p-3">
                                        <div className="text-xs text-muted-foreground mb-1">From</div>
                                        <Calendar
                                            mode="single"
                                            selected={dateFrom ? new Date(dateFrom + 'T00:00:00') : undefined}
                                            onSelect={(date) => { if (date) setDateFrom(format(date, 'yyyy-MM-dd')); }}
                                        />
                                        <div className="text-xs text-muted-foreground mb-1 mt-2">To</div>
                                        <Calendar
                                            mode="single"
                                            selected={dateTo ? new Date(dateTo + 'T00:00:00') : undefined}
                                            onSelect={(date) => { if (date) setDateTo(format(date, 'yyyy-MM-dd')); }}
                                        />
                                    </div>
                                </div>
                            </PopoverContent>
                        </Popover>
                    </div>

                    {/* Summary bar */}
                    {rows.length > 0 && (
                        <div className="payments-summary-bar">
                            <span>{sortedRows.length} transactions</span>
                            <span>·</span>
                            <span className="payments-summary-amount">{formatCurrency(totalAmount.toFixed(2))}</span>
                        </div>
                    )}
                </div>

                {/* Error */}
                {error && <div className="payments-error">⚠️ {error}</div>}

                {/* Table */}
                <div className="payments-table-scroll">
                    {loading ? (
                        <div className="payments-loading">
                            <Loader2 size={20} className="animate-spin" style={{ color: '#9ca3af' }} />
                            <span>Loading payments…</span>
                        </div>
                    ) : rows.length === 0 ? (
                        <div className="payments-empty">
                            <DollarSign className="payments-empty-icon" />
                            <div className="payments-empty-title">No payments found</div>
                            <div className="payments-empty-sub">Try adjusting the date range or filters.</div>
                        </div>
                    ) : (
                        <table className="payments-table">
                            <thead>
                                <tr>
                                    {COLUMNS.map(col => {
                                        const isSorted = sortField === col.key;
                                        return (
                                            <th
                                                key={col.key}
                                                className={[
                                                    col.sortable ? 'sortable' : '',
                                                    isSorted ? 'sorted' : '',
                                                    col.className || '',
                                                ].join(' ')}
                                                onClick={() => col.sortable && handleSort(col.key as SortField)}
                                            >
                                                {col.label}
                                                {col.sortable && (
                                                    <span className="sort-arrow">
                                                        {isSorted ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                                                    </span>
                                                )}
                                            </th>
                                        );
                                    })}
                                </tr>
                            </thead>
                            <tbody>
                                {pagedRows.map(row => (
                                    <tr
                                        key={row.id}
                                        className={selectedId === row.id ? 'selected' : ''}
                                        onClick={() => handleSelectRow(row.id)}
                                    >
                                        <td>{formatPaymentDate(row.payment_date)}</td>
                                        <td className="amount-cell">{formatCurrency(row.amount_paid)}</td>
                                        <td className={`due-cell${row.invoice_amount_due && parseFloat(row.invoice_amount_due) > 0 ? ' due-outstanding' : ''}`}>
                                            {row.invoice_amount_due ? formatCurrency(row.invoice_amount_due) : '—'}
                                        </td>
                                        <td>
                                            <span className="payments-method-badge">
                                                {paymentMethodIcon(row.payment_methods)} {row.display_payment_method || row.payment_methods}
                                            </span>
                                        </td>
                                        <td className={row.missing_job_link ? 'missing' : ''}>
                                            {row.job_number}
                                        </td>
                                        <td className={row.missing_job_link ? 'missing' : ''}>
                                            {row.client}
                                        </td>
                                        <td>{row.tech || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Pagination */}
                {rows.length > 0 && (
                    <div className="payments-pagination">
                        <span className="payments-pagination-info">
                            {page * perPage + 1}–{Math.min((page + 1) * perPage, sortedRows.length)} of {sortedRows.length}
                        </span>
                        <div className="payments-pagination-btns">
                            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                                <ChevronLeft size={14} />
                            </button>
                            <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                                <ChevronRight size={14} />
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Right: Detail Panel ──────────────────────────────── */}
            {selectedId && (
                <PaymentDetailPanel
                    detail={detail}
                    loading={detailLoading}
                    onClose={handleCloseDetail}
                    onToggleDeposited={handleToggleDeposited}
                />
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Payment Detail Panel
// ═══════════════════════════════════════════════════════════════════════════════

function PaymentDetailPanel({
    detail,
    loading,
    onClose,
    onToggleDeposited,
}: {
    detail: PaymentDetail | null;
    loading: boolean;
    onClose: () => void;
    onToggleDeposited: (deposited: boolean) => void;
}) {
    const [showMetadata, setShowMetadata] = useState(false);
    const [galleryIndex, setGalleryIndex] = useState(0);
    const [showLargePreview, setShowLargePreview] = useState(false);

    // Reset gallery when detail changes
    useEffect(() => {
        setGalleryIndex(0);
        setShowLargePreview(false);
        setShowMetadata(false);
    }, [detail?.transaction_id]);

    if (loading) {
        return (
            <div className="payment-detail-panel">
                <button className="payment-detail-close" onClick={onClose}>
                    <X size={18} />
                </button>
                <div className="payment-detail-loading">
                    <Loader2 size={24} className="animate-spin" style={{ color: '#9ca3af' }} />
                </div>
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="payment-detail-panel">
                <button className="payment-detail-close" onClick={onClose}>
                    <X size={18} />
                </button>
                <div className="payment-detail-empty">
                    <Receipt size={40} style={{ color: '#d1d5db' }} />
                    <p>Unable to load payment details.</p>
                </div>
            </div>
        );
    }

    const allAttachments = detail.attachments;

    return (
        <div className="payment-detail-panel">
            {/* Header */}
            <div className="payment-detail-header">
                <button className="payment-detail-close" onClick={onClose}>
                    <X size={18} />
                </button>

                <div className="payment-detail-header-content">
                    <div className="payment-detail-method-label">
                        <span className="payment-detail-method-icon">
                            {paymentMethodIcon(detail.payment_methods)}
                        </span>
                        {detail.display_payment_method || detail.payment_methods}
                    </div>

                    <div className="payment-detail-amount">
                        {formatCurrency(detail.amount_paid)}
                    </div>

                    <div className="payment-detail-subtitle">
                        Paid by <strong>{detail.client}</strong> for <strong>#{detail.job_number}</strong>
                    </div>

                    <div className="payment-detail-date">
                        {formatPaymentDate(detail.payment_date)}
                    </div>

                    <div className="payment-detail-badges">
                        <span className={`payment-badge ${detail.transaction_status === 'succeeded' ? 'badge-success' : 'badge-neutral'}`}>
                            {detail.transaction_status}
                        </span>
                        {detail.invoice && (
                            <span className={`payment-badge ${detail.invoice.paid_in_full ? 'badge-success' : 'badge-warning'}`}>
                                {detail.invoice.paid_in_full ? '✓ Paid in Full' : `Invoice: ${detail.invoice.status}`}
                            </span>
                        )}
                        {(detail.display_payment_method || '').toLowerCase() === 'check' && (
                            <Popover>
                                <PopoverTrigger asChild>
                                    <button
                                        className={`payment-badge cursor-pointer border-0 ${detail.check_deposited ? 'badge-success' : 'badge-danger'}`}
                                    >
                                        {detail.check_deposited ? 'Deposited' : 'Not Deposited'}
                                    </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-1" align="start">
                                    <button
                                        className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm hover:bg-muted"
                                        onClick={() => onToggleDeposited(true)}
                                    >
                                        <span className="size-2 rounded-full bg-green-500" />
                                        Deposited
                                    </button>
                                    <button
                                        className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm hover:bg-muted"
                                        onClick={() => onToggleDeposited(false)}
                                    >
                                        <span className="size-2 rounded-full bg-red-500" />
                                        Not Deposited
                                    </button>
                                </PopoverContent>
                            </Popover>
                        )}
                    </div>
                </div>
            </div>

            {/* Body */}
            <div className="payment-detail-body">
                {/* Warning */}
                {detail._warning && (
                    <div className="payment-detail-warning">
                        ⚠️ {detail._warning}
                    </div>
                )}

                {/* Invoice Summary */}
                {detail.invoice && (
                    <div className="payment-detail-section">
                        <h3><Receipt size={14} /> Invoice Summary</h3>
                        <div className="payment-detail-invoice-grid">
                            <div className="invoice-stat">
                                <span className="invoice-stat-label">Total</span>
                                <span className="invoice-stat-value">{formatCurrency(detail.invoice.total)}</span>
                            </div>
                            <div className="invoice-stat">
                                <span className="invoice-stat-label">Paid</span>
                                <span className="invoice-stat-value paid">{formatCurrency(detail.invoice.amount_paid)}</span>
                            </div>
                            <div className="invoice-stat">
                                <span className="invoice-stat-label">Due</span>
                                <span className={`invoice-stat-value ${parseFloat(detail.invoice.amount_due) > 0 ? 'due' : ''}`}>
                                    {formatCurrency(detail.invoice.amount_due)}
                                </span>
                            </div>
                            <div className="invoice-stat">
                                <span className="invoice-stat-label">Status</span>
                                <span className="invoice-stat-value">{detail.invoice.status}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Job */}
                {detail.job && (
                    <div className="payment-detail-section">
                        <h3><FileText size={14} /> Job</h3>
                        <div className="payment-detail-job-info">
                            {detail.job.job_number && (
                                <div className="job-info-row">
                                    <span className="job-info-label">Job #</span>
                                    <span className="job-info-value">{detail.job.job_number}</span>
                                </div>
                            )}
                            {detail.job.service_name && (
                                <div className="job-info-row">
                                    <span className="job-info-label">Service</span>
                                    <span className="job-info-value">{detail.job.service_name}</span>
                                </div>
                            )}
                            {detail.job.service_address && (
                                <div className="job-info-row">
                                    <MapPin size={12} className="job-info-icon" />
                                    <span className="job-info-value">{detail.job.service_address}</span>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Providers */}
                {detail.job && detail.job.providers.length > 0 && (
                    <div className="payment-detail-section">
                        <h3><User2 size={14} /> Provider{detail.job.providers.length > 1 ? 's' : ''}</h3>
                        <div className="payment-detail-providers">
                            {detail.job.providers.map((p, i) => (
                                <div key={i} className="provider-card">
                                    <div className="provider-avatar">
                                        {(p.name || '?')[0].toUpperCase()}
                                    </div>
                                    <div className="provider-info">
                                        <div className="provider-name">{p.name || '—'}</div>
                                        {p.email && <div className="provider-contact">{p.email}</div>}
                                        {p.phone && <div className="provider-contact">{p.phone}</div>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Attachments Gallery */}
                <div className="payment-detail-section">
                    <h3><ImageIcon size={14} /> Attachments ({allAttachments.length})</h3>
                    {allAttachments.length === 0 ? (
                        <div className="attachments-empty">No attachments found</div>
                    ) : (
                        <div className="attachments-gallery">
                            {/* Thumbnails row */}
                            <div className="attachments-thumbs">
                                {allAttachments.map((att, i) => (
                                    <button
                                        key={i}
                                        className={`attachment-thumb ${galleryIndex === i ? 'active' : ''}`}
                                        onClick={() => { setGalleryIndex(i); setShowLargePreview(true); }}
                                    >
                                        {att.kind === 'image' ? (
                                            <img src={att.url} alt={att.filename} />
                                        ) : (
                                            <div className="attachment-file-thumb">
                                                <FileText size={18} />
                                                <span>{att.filename.split('.').pop()?.toUpperCase() || 'FILE'}</span>
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>

                            {/* Large preview */}
                            {showLargePreview && allAttachments[galleryIndex] && (
                                <div className="attachments-preview">
                                    <div className="attachments-preview-controls">
                                        <button
                                            disabled={galleryIndex === 0}
                                            onClick={() => setGalleryIndex(i => i - 1)}
                                        >
                                            <ChevronLeft size={16} />
                                        </button>
                                        <span className="attachments-counter">
                                            {galleryIndex + 1} / {allAttachments.length}
                                        </span>
                                        <button
                                            disabled={galleryIndex >= allAttachments.length - 1}
                                            onClick={() => setGalleryIndex(i => i + 1)}
                                        >
                                            <ChevronRight size={16} />
                                        </button>
                                        <a
                                            href={allAttachments[galleryIndex].url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="attachments-open-link"
                                        >
                                            <ExternalLink size={14} />
                                        </a>
                                    </div>
                                    <div className="attachments-preview-content">
                                        {allAttachments[galleryIndex].kind === 'image' ? (
                                            <img
                                                src={allAttachments[galleryIndex].url}
                                                alt={allAttachments[galleryIndex].filename}
                                            />
                                        ) : (
                                            <div className="attachment-file-preview">
                                                <FileText size={40} />
                                                <span>{allAttachments[galleryIndex].filename}</span>
                                                <a
                                                    href={allAttachments[galleryIndex].url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="payments-btn payments-btn-secondary"
                                                >
                                                    Open File
                                                </a>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Transaction Metadata (collapsible) */}
                <div className="payment-detail-section">
                    <button
                        className="payment-metadata-toggle"
                        onClick={() => setShowMetadata(!showMetadata)}
                    >
                        <ChevronDown
                            size={14}
                            className={`metadata-chevron ${showMetadata ? 'open' : ''}`}
                        />
                        Transaction Metadata
                    </button>
                    {showMetadata && detail.metadata && (
                        <div className="payment-metadata-content">
                            {Object.entries(detail.metadata).map(([key, val]) => (
                                val ? (
                                    <div key={key} className="metadata-row">
                                        <span className="metadata-key">{key.replace(/_/g, ' ')}</span>
                                        <span className="metadata-val">{val}</span>
                                    </div>
                                ) : null
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
