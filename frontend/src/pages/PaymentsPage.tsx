/**
 * PaymentsPage — Zenbooker Payments (Split-View)
 * Settings sub-page at /settings/payments
 *
 * Left:  filterable, sortable, searchable payments table
 * Right: PaymentDetailPanel with invoice, job, providers, attachments gallery
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
    Loader2, Download, Search, DollarSign, X,
    CreditCard, ChevronLeft, ChevronRight, FileText,
    User2, MapPin, Receipt, ChevronDown, ImageIcon, ExternalLink,
} from 'lucide-react';
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

interface PaymentDetail extends PaymentRow {
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

type SortField = 'payment_date' | 'amount_paid' | 'job_number' | 'client' | 'payment_methods';
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
    { key: 'payment_methods', label: 'Method', sortable: true },
    { key: 'job_number', label: 'Job #', sortable: true },
    { key: 'client', label: 'Customer', sortable: true },
];

// ── Main Component ────────────────────────────────────────────────────────────

export default function PaymentsPage() {
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
    const [selectedTxnId, setSelectedTxnId] = useState<string | null>(null);
    const [detail, setDetail] = useState<PaymentDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);

    // Search debounce
    const searchTimer = useRef<ReturnType<typeof setTimeout>>();
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

    // ── Fetch detail ──────────────────────────────────────────────────────────

    const fetchDetail = useCallback(async (txnId: string) => {
        setDetailLoading(true);
        try {
            const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
            const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/${txnId}?${qs.toString()}`);
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
    }, [dateFrom, dateTo]);

    const handleSelectRow = (txnId: string) => {
        setSelectedTxnId(txnId);
        fetchDetail(txnId);
    };

    const handleCloseDetail = () => {
        setSelectedTxnId(null);
        setDetail(null);
    };

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
                va = (va as string || '').toLowerCase();
                vb = (vb as string || '').toLowerCase();
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
            <div className={`payments-list-panel ${selectedTxnId ? 'has-detail' : ''}`}>
                {/* Header */}
                <div className="payments-list-header">
                    <div className="payments-list-title-row">
                        <h1>Payments</h1>
                        <button
                            className="payments-btn payments-btn-secondary"
                            onClick={handleExportCSV}
                            disabled={sortedRows.length === 0}
                        >
                            <Download size={14} /> Export
                        </button>
                    </div>

                    {/* Filters */}
                    <div className="payments-filters-bar">
                        <div className="payments-search-wrap">
                            <Search size={14} className="payments-search-icon" />
                            <input
                                type="text"
                                placeholder="Search customer, job #, memo…"
                                value={searchInput}
                                onChange={e => setSearchInput(e.target.value)}
                                className="payments-search-input"
                            />
                            {searchInput && (
                                <button
                                    className="payments-search-clear"
                                    onClick={() => { setSearchInput(''); setSearchQuery(''); }}
                                >
                                    <X size={12} />
                                </button>
                            )}
                        </div>

                        <div className="payments-filter-row">
                            <input
                                type="date"
                                value={dateFrom}
                                onChange={e => setDateFrom(e.target.value)}
                                className="payments-date-input"
                            />
                            <span className="payments-date-sep">→</span>
                            <input
                                type="date"
                                value={dateTo}
                                onChange={e => setDateTo(e.target.value)}
                                className="payments-date-input"
                            />
                            <select
                                value={methodFilter}
                                onChange={e => setMethodFilter(e.target.value)}
                                className="payments-method-select"
                            >
                                <option value="">All Methods</option>
                                <option value="stripe">Stripe</option>
                                <option value="cash">Cash</option>
                                <option value="check">Check</option>
                                <option value="credit_card">Credit Card</option>
                                <option value="custom">Custom</option>
                            </select>
                        </div>
                    </div>

                    {/* Summary bar */}
                    {rows.length > 0 && (
                        <div className="payments-summary-bar">
                            <span>{sortedRows.length} transactions</span>
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
                                        key={row.transaction_id}
                                        className={selectedTxnId === row.transaction_id ? 'selected' : ''}
                                        onClick={() => handleSelectRow(row.transaction_id)}
                                    >
                                        <td>{formatPaymentDate(row.payment_date)}</td>
                                        <td className="amount-cell">{formatCurrency(row.amount_paid)}</td>
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
            {selectedTxnId && (
                <PaymentDetailPanel
                    detail={detail}
                    loading={detailLoading}
                    onClose={handleCloseDetail}
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
}: {
    detail: PaymentDetail | null;
    loading: boolean;
    onClose: () => void;
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
                <div className="payment-detail-loading">
                    <Loader2 size={24} className="animate-spin" style={{ color: '#9ca3af' }} />
                </div>
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="payment-detail-panel">
                <div className="payment-detail-empty">
                    <Receipt size={40} style={{ color: '#d1d5db' }} />
                    <p>Unable to load payment details.</p>
                </div>
            </div>
        );
    }

    const images = detail.attachments.filter(a => a.kind === 'image');
    const files = detail.attachments.filter(a => a.kind === 'file');
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
