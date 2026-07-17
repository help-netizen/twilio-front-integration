/**
 * PaymentsPage — Zenbooker Payments (Split-View)
 * Page at /payments
 */

import {
    Loader2, Download, DollarSign, X,
    ChevronLeft, ChevronRight, RefreshCw, CalendarIcon,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Calendar } from '../components/ui/calendar';
import { format } from 'date-fns';
import { usePaymentsPage } from '../hooks/usePaymentsPage';
import { PaymentDetailPanel } from '../components/payments/PaymentDetailPanel';
import {
    COLUMNS, formatPaymentDate, formatCurrency, paymentMethodIcon,
    type SortField,
} from '../components/payments/paymentTypes';
import './PaymentsPage.css';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';
import { isMobileViewport } from '../hooks/useViewportSafePosition';

// ── Main Component ────────────────────────────────────────────────────────────

export default function PaymentsPage() {
    const pm = usePaymentsPage();

    return (
        <div className="blanc-page-wrapper">
            {/* ── Unified Header ──────────────────────────────────────── */}
            <div className="blanc-unified-header">
                <h1 className="blanc-header-title">Payments</h1>

                <div className="blanc-search-wrapper" ref={pm.filterRef}>
                    <input
                        type="text"
                        placeholder="type to find anything..."
                        value={pm.searchInput}
                        onChange={e => pm.setSearchInput(e.target.value)}
                        onFocus={() => pm.setFiltersOpen(true)}
                        className="blanc-search-input"
                    />
                    {pm.filtersOpen && (() => {
                        const filterContent = (
                            <>
                                {pm.activeFilterCount > 0 && (
                                    <div className="flex flex-wrap gap-1.5 p-3 pb-0 items-center">
                                        {pm.methodFilter && (<Badge variant="secondary" className="gap-1 text-xs">{pm.methodFilter}<X className="size-3 cursor-pointer" onClick={() => pm.setMethodFilter('')} /></Badge>)}
                                        {pm.providerFilter && (<Badge variant="outline" className="gap-1 text-xs">{pm.providerFilter}<X className="size-3 cursor-pointer" onClick={() => pm.setProviderFilter('')} /></Badge>)}
                                        {pm.paidFilter && (<Badge variant="default" className="gap-1 text-xs">{pm.paidFilter === 'paid' ? 'Paid in Full' : 'Has Balance Due'}<X className="size-3 cursor-pointer" onClick={() => pm.setPaidFilter('')} /></Badge>)}
                                        <button onClick={pm.clearAllFilters} className="text-xs text-muted-foreground hover:text-foreground ml-1">Clear all</button>
                                    </div>
                                )}
                                <div className="grid grid-cols-1 sm:grid-cols-3 sm:divide-x p-3 gap-3 sm:gap-0">
                                    <div className="sm:px-3">
                                        <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">PAYMENT METHOD</div>
                                        <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                                            {pm.uniqueMethods.length === 0 && (<div className="text-xs text-muted-foreground italic py-1">None available</div>)}
                                            {pm.uniqueMethods.map(m => {
                                                const sel = pm.methodFilter === m; return (
                                                    <button key={m} type="button" onClick={() => pm.setMethodFilter(sel ? '' : m)} className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${sel ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-foreground'}`}>
                                                        <div className={`size-4 border rounded flex items-center justify-center shrink-0 ${sel ? 'bg-primary border-primary' : 'border-input'}`}>{sel && <span className="text-[10px] text-primary-foreground">✓</span>}</div>{m}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    <div className="sm:px-3">
                                        <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">PROVIDER</div>
                                        <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                                            {pm.uniqueProviders.length === 0 && (<div className="text-xs text-muted-foreground italic py-1">None available</div>)}
                                            {pm.uniqueProviders.map(p => {
                                                const sel = pm.providerFilter === p; return (
                                                    <button key={p} type="button" onClick={() => pm.setProviderFilter(sel ? '' : p)} className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${sel ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-foreground'}`}>
                                                        <div className={`size-4 border rounded flex items-center justify-center shrink-0 ${sel ? 'bg-primary border-primary' : 'border-input'}`}>{sel && <span className="text-[10px] text-primary-foreground">✓</span>}</div>{p}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    <div className="sm:px-3">
                                        <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">INVOICE STATUS</div>
                                        <div className="space-y-0.5">
                                            {(['paid', 'due'] as const).map(val => {
                                                const sel = pm.paidFilter === val; const label = val === 'paid' ? 'Paid in Full' : 'Has Balance Due'; return (
                                                    <button key={val} type="button" onClick={() => pm.setPaidFilter(sel ? '' : val)} className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${sel ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-foreground'}`}>
                                                        <div className={`size-4 border rounded flex items-center justify-center shrink-0 ${sel ? 'bg-primary border-primary' : 'border-input'}`}>{sel && <span className="text-[10px] text-primary-foreground">✓</span>}</div>{label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            </>
                        );

                        if (isMobileViewport()) {
                            return (
                                <>
                                    <div className="blanc-mobile-sheet-backdrop" onClick={() => pm.setFiltersOpen(false)} />
                                    <div className="blanc-mobile-sheet" style={{ maxHeight: '70vh' }}>
                                        <div className="blanc-mobile-sheet-header">
                                            <span style={{ fontWeight: 600 }}>Filters</span>
                                            <button onClick={() => pm.setFiltersOpen(false)}><X className="size-5" /></button>
                                        </div>
                                        <div style={{ overflowY: 'auto', flex: 1 }}>{filterContent}</div>
                                    </div>
                                </>
                            );
                        }

                        return (
                            <div className="absolute top-full left-0 right-0 mt-1 rounded-xl overflow-hidden z-50" style={{ background: 'var(--blanc-surface-strong)', border: '1px solid var(--blanc-line)', boxShadow: 'var(--blanc-shadow-main)' }}>
                                {filterContent}
                            </div>
                        );
                    })()}
                </div>

                <div className="blanc-controls-group">
                    <button
                        className={`blanc-control-chip ${pm.quickFilter === 'all' ? 'active' : ''}`}
                        onClick={() => { pm.setQuickFilter('all'); pm.setPage(0); }}
                    >All</button>
                    <button
                        className={`blanc-control-chip ${pm.quickFilter === 'new_checks' ? 'active' : ''}`}
                        onClick={() => { pm.setQuickFilter('new_checks'); pm.setPage(0); }}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                        New checks
                        {pm.undepositedCheckCount > 0 && (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0 min-w-[18px] h-[18px] justify-center">{pm.undepositedCheckCount}</Badge>
                        )}
                    </button>
                    {pm.activeFilterCount > 0 && (<Badge variant="secondary" className="gap-1">{pm.activeFilterCount} filter{pm.activeFilterCount > 1 ? 's' : ''}<X className="size-3 cursor-pointer" onClick={pm.clearAllFilters} /></Badge>)}
                    {(() => {
                        const dateLabel = pm.dateFrom && pm.dateTo
                            ? `${format(new Date(pm.dateFrom + 'T00:00:00'), 'MMM dd')} – ${format(new Date(pm.dateTo + 'T00:00:00'), 'MMM dd, yyyy')}`
                            : pm.dateFrom ? `From ${format(new Date(pm.dateFrom + 'T00:00:00'), 'MMM dd, yyyy')}` : 'Date Range';

                        const presets = (
                            <>
                                <div className="text-sm font-medium mb-2">Presets</div>
                                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { const t = new Date(); pm.setDateFrom(format(t, 'yyyy-MM-dd')); pm.setDateTo(format(t, 'yyyy-MM-dd')); pm.setDatePickerOpen(false); }}>Today</Button>
                                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { const d = new Date(); d.setDate(d.getDate() - 7); pm.setDateFrom(format(d, 'yyyy-MM-dd')); pm.setDateTo(format(new Date(), 'yyyy-MM-dd')); pm.setDatePickerOpen(false); }}>Last 7 days</Button>
                                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { const d = new Date(); d.setDate(d.getDate() - 30); pm.setDateFrom(format(d, 'yyyy-MM-dd')); pm.setDateTo(format(new Date(), 'yyyy-MM-dd')); pm.setDatePickerOpen(false); }}>Last 30 days</Button>
                                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { const n = new Date(); pm.setDateFrom(format(new Date(n.getFullYear(), n.getMonth(), 1), 'yyyy-MM-dd')); pm.setDateTo(format(n, 'yyyy-MM-dd')); pm.setDatePickerOpen(false); }}>This Month</Button>
                                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { const n = new Date(); const p = new Date(n.getFullYear(), n.getMonth() - 1, 1); const l = new Date(n.getFullYear(), n.getMonth(), 0); pm.setDateFrom(format(p, 'yyyy-MM-dd')); pm.setDateTo(format(l, 'yyyy-MM-dd')); pm.setDatePickerOpen(false); }}>Last Month</Button>
                            </>
                        );
                        const calendars = (
                            <>
                                <div className="text-xs text-muted-foreground mb-1">From</div>
                                <Calendar mode="single" selected={pm.dateFrom ? new Date(pm.dateFrom + 'T00:00:00') : undefined} onSelect={(date) => { if (date) pm.setDateFrom(format(date, 'yyyy-MM-dd')); }} />
                                <div className="text-xs text-muted-foreground mb-1 mt-2">To</div>
                                <Calendar mode="single" selected={pm.dateTo ? new Date(pm.dateTo + 'T00:00:00') : undefined} onSelect={(date) => { if (date) pm.setDateTo(format(date, 'yyyy-MM-dd')); }} />
                            </>
                        );

                        if (isMobileViewport()) {
                            return (
                                <>
                                    <button className="blanc-control-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => pm.setDatePickerOpen(true)}>
                                        <CalendarIcon className="size-3.5" />{dateLabel}
                                    </button>
                                    {pm.datePickerOpen && (
                                        <>
                                            <div className="blanc-mobile-sheet-backdrop" onClick={() => pm.setDatePickerOpen(false)} />
                                            <div className="blanc-mobile-sheet" style={{ maxHeight: '85vh' }}>
                                                <div className="blanc-mobile-sheet-header">
                                                    <span style={{ fontWeight: 600 }}>Date Range</span>
                                                    <button onClick={() => pm.setDatePickerOpen(false)}><X className="size-5" /></button>
                                                </div>
                                                <div style={{ overflowY: 'auto', flex: 1, padding: '0 16px 16px' }}>
                                                    <div className="flex flex-wrap gap-1.5 mb-4">{presets}</div>
                                                    <div className="flex flex-col items-center">{calendars}</div>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </>
                            );
                        }

                        return (
                            <Popover open={pm.datePickerOpen} onOpenChange={pm.setDatePickerOpen}>
                                <PopoverTrigger asChild>
                                    <button className="blanc-control-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                        <CalendarIcon className="size-3.5" />{dateLabel}
                                    </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-0" align="end">
                                    <div className="flex">
                                        <div className="border-r p-3 space-y-1">{presets}</div>
                                        <div className="p-3">{calendars}</div>
                                    </div>
                                </PopoverContent>
                            </Popover>
                        );
                    })()}
                    {pm.syncResult && (<span style={{ fontSize: '12px', color: pm.syncResult.startsWith('Sync error') ? '#ef4444' : '#22c55e' }}>{pm.syncResult}</span>)}
                    <button className="blanc-control-chip" onClick={pm.handleSync} disabled={pm.syncing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: pm.syncing ? 0.5 : 1 }}>
                        <RefreshCw className={`size-3.5 ${pm.syncing ? 'animate-spin' : ''}`} />
                        {pm.syncing ? 'Syncing…' : 'Sync'}
                    </button>
                    <button className="blanc-control-chip" onClick={pm.handleExportCSV} disabled={pm.sortedRows.length === 0 || pm.exporting} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (pm.sortedRows.length === 0 || pm.exporting) ? 0.5 : 1 }}>
                        {pm.exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                        {pm.exporting ? 'Exporting…' : 'Export'}
                    </button>
                </div>
            </div>

            {pm.rows.length > 0 && (
                <div className="payments-summary-bar" style={{ padding: '0 4px 12px' }}>
                    <span>{pm.sortedRows.length} transactions</span><span>·</span>
                    <span className="payments-summary-amount">{formatCurrency(pm.totalAmount.toFixed(2))}</span>
                </div>
            )}

            {/* ── Content Card ───────────────────────────────────────── */}
            <div className="blanc-page-card">
                <div className="payments-list-panel">
                {/* Error */}
                {pm.error && <div className="payments-error">⚠️ {pm.error}</div>}

                {/* Table */}
                <div className="payments-table-scroll">
                    {pm.loading ? (
                        <div className="payments-loading"><Loader2 size={20} className="animate-spin" style={{ color: '#9ca3af' }} /><span>Loading payments…</span></div>
                    ) : pm.rows.length === 0 ? (
                        <div className="payments-empty"><DollarSign className="payments-empty-icon" /><div className="payments-empty-title">No payments found</div><div className="payments-empty-sub">Try adjusting the date range or filters.</div></div>
                    ) : (
                        <table className="payments-table">
                            <thead><tr>
                                {COLUMNS.map(col => {
                                    const isSorted = pm.sortField === col.key; return (
                                        <th key={col.key} className={[col.sortable ? 'sortable' : '', isSorted ? 'sorted' : '', col.className || ''].join(' ')} onClick={() => col.sortable && pm.handleSort(col.key as SortField)}>
                                            {col.label}{col.sortable && (<span className="sort-arrow">{isSorted ? (pm.sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>)}
                                        </th>
                                    );
                                })}
                            </tr></thead>
                            <tbody>
                                {pm.pagedRows.map(row => (
                                    <tr key={row.id} className={pm.selectedId === row.id ? 'selected' : ''} onClick={() => pm.handleSelectRow(row.id)}>
                                        <td>{formatPaymentDate(row.payment_date)}</td>
                                        <td className="amount-cell">{formatCurrency(row.amount_paid)}</td>
                                        <td className={`due-cell${row.invoice_amount_due && parseFloat(row.invoice_amount_due) > 0 ? ' due-outstanding' : ''}`}>{row.invoice_amount_due ? formatCurrency(row.invoice_amount_due) : '—'}</td>
                                        <td><span className="payments-method-badge">{paymentMethodIcon(row.payment_methods)} {row.display_payment_method || row.payment_methods}</span></td>
                                        <td className={row.missing_job_link ? 'missing' : ''}>{row.job_number}</td>
                                        <td className={row.missing_job_link ? 'missing' : ''}>{row.client}</td>
                                        <td>{row.tech || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Pagination */}
                {pm.rows.length > 0 && (
                    <div className="payments-pagination">
                        <span className="payments-pagination-info">{pm.page * pm.perPage + 1}–{Math.min((pm.page + 1) * pm.perPage, pm.sortedRows.length)} of {pm.sortedRows.length}</span>
                        <div className="payments-pagination-btns">
                            <button disabled={pm.page === 0} onClick={() => pm.setPage(p => p - 1)}><ChevronLeft size={14} /></button>
                            <button disabled={pm.page >= pm.totalPages - 1} onClick={() => pm.setPage(p => p + 1)}><ChevronRight size={14} /></button>
                        </div>
                    </div>
                )}
                </div>

            </div>
            <FloatingDetailPanel open={!!pm.selectedId} onClose={pm.handleCloseDetail} wide>
                <PaymentDetailPanel detail={pm.detail} loading={pm.detailLoading} onClose={pm.handleCloseDetail} onToggleDeposited={pm.handleToggleDeposited} />
            </FloatingDetailPanel>
        </div>
    );
}
