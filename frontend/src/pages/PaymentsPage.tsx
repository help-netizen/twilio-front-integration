/**
 * PaymentsPage — Zenbooker Payments Export (Workiz-like)
 * Settings sub-page at /settings/payments
 *
 * Fetches transactions from Zenbooker via the backend proxy,
 * displays in a sortable/paginated table, exports to CSV.
 */

import { useState, useMemo, useCallback } from 'react';
import { Loader2, Download, Search, DollarSign } from 'lucide-react';
import { authedFetch } from '../services/apiClient';
import './PaymentsPage.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaymentRow {
    job_number: string;
    client: string;
    job_type: string;
    status: string;
    payment_methods: string;
    amount_paid: string;
    tags: string;
    payment_date: string;
    source: string;
    tech: string;
    // audit
    transaction_id: string;
    invoice_id: string;
    job_id: string;
    transaction_status: string;
    missing_job_link: boolean;
}

type SortField = 'payment_date' | 'amount_paid' | 'job_number';
type SortDir = 'asc' | 'desc';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format ISO date to MM/DD/YYYY HH:mm in America/New_York */
function formatPaymentDate(iso: string): string {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: '2-digit',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    } catch {
        return iso;
    }
}

/** Get first day of current month as YYYY-MM-DD */
function defaultDateFrom(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Get today as YYYY-MM-DD */
function defaultDateTo(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// ── Columns definition ───────────────────────────────────────────────────────

const COLUMNS: { key: keyof PaymentRow; label: string; sortable?: boolean; className?: string }[] = [
    { key: 'job_number', label: 'Job #', sortable: true },
    { key: 'client', label: 'Client' },
    { key: 'job_type', label: 'Job Type' },
    { key: 'status', label: 'Status' },
    { key: 'payment_methods', label: 'Payment Methods' },
    { key: 'amount_paid', label: 'Amount Paid', sortable: true, className: 'amount-cell' },
    { key: 'tags', label: 'Tags' },
    { key: 'payment_date', label: 'Payment Date', sortable: true },
    { key: 'source', label: 'Source' },
    { key: 'tech', label: 'Tech' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
    // Filter state
    const [dateFrom, setDateFrom] = useState(defaultDateFrom);
    const [dateTo, setDateTo] = useState(defaultDateTo);
    const [statusFilter, setStatusFilter] = useState('succeeded');
    const [methodFilter, setMethodFilter] = useState('');

    // Data state
    const [rows, setRows] = useState<PaymentRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [hasLoaded, setHasLoaded] = useState(false);

    // Sort state
    const [sortField, setSortField] = useState<SortField>('payment_date');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    // Pagination state
    const [page, setPage] = useState(0);
    const [perPage, setPerPage] = useState(50);

    // ── Fetch data ────────────────────────────────────────────────────────────

    const handleGenerate = useCallback(async () => {
        setLoading(true);
        setError('');
        setPage(0);
        try {
            const qs = new URLSearchParams({
                date_from: dateFrom,
                date_to: dateTo,
            });
            if (statusFilter) qs.set('status', statusFilter);
            if (methodFilter) qs.set('payment_method', methodFilter);

            const res = await authedFetch(`${API_BASE}/api/zenbooker/payments?${qs.toString()}`);
            const json = await res.json();

            if (!res.ok || !json.ok) {
                throw new Error(json.error || `Request failed (${res.status})`);
            }

            setRows(json.data.rows || []);
            setHasLoaded(true);
        } catch (err: any) {
            setError(err.message || 'Failed to fetch payments');
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [dateFrom, dateTo, statusFilter, methodFilter]);

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

    const sortedRows = useMemo(() => {
        const sorted = [...rows];
        sorted.sort((a, b) => {
            let va: string | number = a[sortField];
            let vb: string | number = b[sortField];

            if (sortField === 'amount_paid') {
                va = parseFloat(va as string) || 0;
                vb = parseFloat(vb as string) || 0;
            } else if (sortField === 'payment_date') {
                va = new Date(va as string).getTime() || 0;
                vb = new Date(vb as string).getTime() || 0;
            } else {
                va = (va as string).toLowerCase();
                vb = (vb as string).toLowerCase();
            }

            if (va < vb) return sortDir === 'asc' ? -1 : 1;
            if (va > vb) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });
        return sorted;
    }, [rows, sortField, sortDir]);

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
            'Job #', 'Client', 'Job Type', 'Status', 'Payment Methods',
            'Amount Paid', 'Tags', 'Payment Date', 'Source', 'Tech',
            'Transaction ID', 'Invoice ID', 'Job ID', 'Transaction Status',
        ];

        const csvRows = sortedRows.map(r => [
            r.job_number,
            r.client,
            r.job_type,
            r.status,
            r.payment_methods,
            r.amount_paid,
            r.tags,
            r.payment_date, // ISO for CSV
            r.source,
            r.tech,
            r.transaction_id,
            r.invoice_id,
            r.job_id,
            r.transaction_status,
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
        <div className="payments-page">
            <div className="payments-header">
                <h1>Payments</h1>
                <p>Export payments from Zenbooker for a selected date range.</p>
            </div>

            {/* Filter bar */}
            <div className="payments-filters">
                <div className="payments-filter-group">
                    <label>Date From</label>
                    <input
                        type="date"
                        value={dateFrom}
                        onChange={e => setDateFrom(e.target.value)}
                    />
                </div>
                <div className="payments-filter-group">
                    <label>Date To</label>
                    <input
                        type="date"
                        value={dateTo}
                        onChange={e => setDateTo(e.target.value)}
                    />
                </div>
                <div className="payments-filter-group">
                    <label>Status</label>
                    <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                        <option value="succeeded">Succeeded</option>
                        <option value="failed">Failed</option>
                        <option value="voided">Voided</option>
                        <option value="">All</option>
                    </select>
                </div>
                <div className="payments-filter-group">
                    <label>Payment Method</label>
                    <select value={methodFilter} onChange={e => setMethodFilter(e.target.value)}>
                        <option value="">All</option>
                        <option value="stripe">Stripe</option>
                        <option value="cash">Cash</option>
                        <option value="check">Check</option>
                        <option value="credit_card">Credit Card</option>
                        <option value="custom">Custom</option>
                    </select>
                </div>

                <button
                    className="payments-btn payments-btn-primary"
                    onClick={handleGenerate}
                    disabled={loading}
                >
                    {loading ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Loading…</>
                    ) : (
                        <><Search className="w-4 h-4" /> Generate</>
                    )}
                </button>

                <button
                    className="payments-btn payments-btn-secondary"
                    onClick={handleExportCSV}
                    disabled={sortedRows.length === 0}
                >
                    <Download className="w-4 h-4" /> Export CSV
                </button>
            </div>

            {/* Error */}
            {error && <div className="payments-error">⚠️ {error}</div>}

            {/* Loading */}
            {loading && (
                <div className="payments-loading">
                    <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#9ca3af' }} />
                </div>
            )}

            {/* Empty state */}
            {!loading && hasLoaded && rows.length === 0 && (
                <div className="payments-empty">
                    <DollarSign className="payments-empty-icon" />
                    <div style={{ fontSize: 15, fontWeight: 500 }}>No payments found</div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                        Try adjusting the date range or filters.
                    </div>
                </div>
            )}

            {/* Table */}
            {!loading && rows.length > 0 && (
                <>
                    {/* Summary */}
                    <div className="payments-summary">
                        <span>
                            Showing {page * perPage + 1}–{Math.min((page + 1) * perPage, sortedRows.length)} of{' '}
                            <span className="payments-summary-total">{sortedRows.length}</span> transactions
                        </span>
                        <span>
                            Total: <span className="payments-summary-total">${totalAmount.toFixed(2)}</span>
                        </span>
                    </div>

                    <div className="payments-table-wrapper">
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
                                    <tr key={row.transaction_id}>
                                        <td className={row.missing_job_link ? 'missing' : ''}>
                                            {row.job_number}
                                        </td>
                                        <td className={row.missing_job_link ? 'missing' : ''}>
                                            {row.client}
                                        </td>
                                        <td className={row.missing_job_link ? 'missing' : ''}>
                                            {row.job_type}
                                        </td>
                                        <td className={row.missing_job_link ? 'missing' : ''}>
                                            {row.status}
                                        </td>
                                        <td>{row.payment_methods}</td>
                                        <td className="amount-cell">{row.amount_paid}</td>
                                        <td>{row.tags || ''}</td>
                                        <td>{formatPaymentDate(row.payment_date)}</td>
                                        <td>{row.source || ''}</td>
                                        <td className={row.missing_job_link ? 'missing' : ''}>
                                            {row.tech}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    <div className="payments-pagination">
                        <div className="payments-pagination-controls">
                            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                                ← Prev
                            </button>
                            <span>
                                Page {page + 1} of {totalPages || 1}
                            </span>
                            <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                                Next →
                            </button>
                        </div>
                        <div>
                            <select
                                value={perPage}
                                onChange={e => {
                                    setPerPage(Number(e.target.value));
                                    setPage(0);
                                }}
                            >
                                <option value={50}>50 per page</option>
                                <option value={100}>100 per page</option>
                                <option value={200}>200 per page</option>
                            </select>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
