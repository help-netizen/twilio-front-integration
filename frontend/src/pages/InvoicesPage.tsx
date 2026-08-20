import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useInvoices } from '../hooks/useInvoices';
import { InvoiceDetailPanel } from '../components/invoices/InvoiceDetailPanel';
import { InvoiceEditorDialog } from '../components/invoices/InvoiceEditorDialog';
import { InvoiceSendDialog } from '../components/invoices/InvoiceSendDialog';
import { InvoiceRemoveDialog } from '../components/invoices/InvoiceRemoveDialog';
import { InvoiceMobileRow } from '../components/invoices/InvoiceMobileRow';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Plus, MoreHorizontal, Loader2, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { HydratedInvoice, Invoice, InvoiceCreateData } from '../services/invoicesApi';
import { getInvoiceByCode } from '../services/invoicesApi';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';
import { getInvoiceCapabilities } from '../hooks/useInvoice';
import { useAuthz } from '../hooks/useAuthz';
import { formatCompanyTime, useCompanyTime } from '../lib/companyTime';

// ── Status helpers ───────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
    { value: '', label: 'All Statuses' },
    { value: 'unpaid', label: 'Unpaid' },
    { value: 'draft', label: 'Draft' },
    { value: 'sent', label: 'Sent' },
    { value: 'viewed', label: 'Viewed' },
    { value: 'partial', label: 'Partial' },
    { value: 'paid', label: 'Paid' },
    { value: 'overdue', label: 'Overdue' },
    { value: 'void', label: 'Void' },
    { value: 'refunded', label: 'Refunded' },
];

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary',
    sent: 'outline',
    viewed: 'outline',
    partial: 'outline',
    paid: 'default',
    overdue: 'destructive',
    void: 'secondary',
    refunded: 'secondary',
};

function formatMoney(value: string | number): string {
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(value: string | null, timeZone: string): string {
    if (!value) return '-';
    return formatCompanyTime(value, { month: 'short', day: 'numeric', year: 'numeric' }, timeZone);
}

// ── Component ────────────────────────────────────────────────────────────────

export function InvoicesPage() {
    const { timeZone } = useCompanyTime();
    const page = useInvoices();
    const { permissions = [] } = useAuthz();
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingInvoice, setEditingInvoice] = useState<HydratedInvoice | null>(null);
    const [sendInvoice, setSendInvoice] = useState<Invoice | null>(null);
    // OB-70: one removal, and the dialog itself asks the server what it would cost.
    const [removing, setRemoving] = useState<Invoice | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const { code } = useParams<{ code?: string }>();

    // Canonical deep link: /invoices/:code resolves the durable code and opens the panel
    // (INVOICE-ESTIMATE-NUMBERING-001). The global id never appears in the URL.
    useEffect(() => {
        if (!code) return;
        let cancelled = false;
        (async () => {
            try {
                const inv = await getInvoiceByCode(code);
                if (!cancelled) page.selectInvoice(inv.id);
            } catch { /* not found / cross-tenant → stay on the list */ }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code]);

    // Legacy: auto-open invoice when navigated with ?openId=<id> (old links/conversion).
    useEffect(() => {
        const openId = searchParams.get('openId');
        if (!openId) return;
        const idNum = Number(openId);
        if (Number.isFinite(idNum)) page.selectInvoice(idNum);
        // Clear the query param so refreshing doesn't keep re-opening it.
        searchParams.delete('openId');
        setSearchParams(searchParams, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    const handleCreate = () => {
        setEditingInvoice(null);
        setEditorOpen(true);
    };

    const handleEdit = async (invoice: Invoice) => {
        try {
            const hydrated = await page.hydrateInvoice(invoice);
            setEditingInvoice(hydrated);
            setEditorOpen(true);
        } catch {
            // Never open an edit form whose item contract failed to hydrate.
        }
    };

    const handleEditorSave = async (data: InvoiceCreateData) => {
        if (editingInvoice) {
            await page.handleUpdateInvoice(editingInvoice.id, data, editingInvoice);
        } else {
            await page.handleCreateInvoice(data);
        }
        setEditorOpen(false);
        setEditingInvoice(null);
    };

    const handleSend = (invoice: Invoice) => {
        setSendInvoice(invoice);
    };

    const canCreateInvoice = permissions.includes('invoices.create');

    return (
        <div className="blanc-page-wrapper">
            {/* ── Desktop header ──────────────────────────────────────── */}
            <div className="hidden md:block">
                <div className="blanc-unified-header">
                    <h1 className="blanc-header-title">Invoices</h1>

                    <div className="blanc-search-wrapper">
                        <input
                            type="text"
                            placeholder="type to find anything..."
                            value={page.filters.search}
                            onChange={e => page.setSearch(e.target.value)}
                            className="blanc-search-input"
                        />
                    </div>

                    <div className="blanc-controls-group">
                        <Select
                            value={page.filters.status || '_all'}
                            onValueChange={v => page.setStatus(v === '_all' ? '' : v)}
                        >
                            <SelectTrigger className="w-[160px]">
                                <SelectValue placeholder="All Statuses" />
                            </SelectTrigger>
                            <SelectContent>
                                {STATUS_OPTIONS.map(opt => (
                                    <SelectItem key={opt.value || '_all'} value={opt.value || '_all'}>{opt.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {canCreateInvoice ? (
                            <button onClick={handleCreate} className="blanc-control-chip-primary">
                                <Plus className="size-4" />New Invoice
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>

            {/* Аквариум снесён (правило 7): невидимый layout-контейнер */}
            <div className="flex flex-1 flex-col min-h-0">
            {/* ── Left: Invoices List ──────────────────────────────────── */}
            <div className="flex flex-1 flex-col overflow-hidden">

                {/* Mobile list: one scroll surface; desktop retains the table. */}
                <div className="flex-1 overflow-auto">
                    <div className="-mx-2 px-[18px] pb-6 md:hidden">
                        <h1
                            className="px-0.5 pt-2.5 text-[26px] font-bold tracking-[-0.01em] text-[var(--blanc-ink-1)]"
                            style={{ fontFamily: 'var(--blanc-font-heading)' }}
                        >
                            Invoices
                        </h1>

                        <label className="mt-2.5 flex h-[44px] items-center gap-2 rounded-xl bg-[var(--blanc-field)] px-[13px] text-[var(--blanc-ink-3)]">
                            <Search className="size-[15px] shrink-0" aria-hidden />
                            <span className="sr-only">Search invoices</span>
                            <input
                                type="search"
                                placeholder="Search invoices…"
                                value={page.filters.search}
                                onChange={event => page.setSearch(event.target.value)}
                                className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--blanc-ink-1)] outline-none placeholder:text-[var(--blanc-ink-3)]"
                                data-testid="invoice-search"
                            />
                        </label>

                        <div className="mt-3 flex flex-wrap gap-2 px-0.5" aria-label="Invoice filters">
                            {[
                                { value: '', label: 'All' },
                                { value: 'unpaid', label: 'Unpaid' },
                                { value: 'overdue', label: 'Overdue' },
                                { value: 'draft', label: 'Draft' },
                                { value: 'paid', label: 'Paid' },
                            ].map(filter => {
                                const active = page.filters.status === filter.value;
                                return (
                                    <button
                                        key={filter.value || 'all'}
                                        type="button"
                                        className={`min-h-[32px] rounded-full border px-3 text-[12px] font-semibold ${active
                                            ? 'border-[var(--blanc-ink-1)] bg-[var(--blanc-ink-1)] text-[var(--blanc-panel-surface)]'
                                            : 'border-[var(--blanc-line)] bg-[var(--blanc-panel-surface)] text-[var(--blanc-ink-2)]'}`}
                                        onClick={() => page.setStatus(filter.value)}
                                        aria-pressed={active}
                                        data-testid={`invoice-filter-${filter.value || 'all'}`}
                                    >
                                        {filter.label}
                                    </button>
                                );
                            })}
                        </div>

                        <div className="mt-1">
                            {page.loading ? (
                                <div className="flex h-28 items-center justify-center">
                                    <Loader2 className="size-6 animate-spin text-[var(--blanc-ink-3)]" />
                                </div>
                            ) : page.invoices.length === 0 ? (
                                <div className="flex h-28 items-center justify-center text-sm text-[var(--blanc-ink-3)]">
                                    No invoices found
                                </div>
                            ) : page.invoices.map(invoice => (
                                <InvoiceMobileRow
                                    key={invoice.id}
                                    invoice={invoice}
                                    onOpen={() => page.selectInvoice(invoice.id)}
                                />
                            ))}
                        </div>

                        {page.hasMore && !page.loading ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="action" className="mt-4 h-[46px] w-full rounded-[13px] text-[15px]"
                                onClick={page.loadMore}
                                disabled={page.loadingMore}
                                data-testid="invoice-load-more"
                            >
                                {page.loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
                                {page.loadingMore ? 'Loading…' : 'Load more'}
                            </Button>
                        ) : null}
                    </div>

                    {page.loading ? (
                        <div className="hidden h-32 items-center justify-center md:flex">
                            <Loader2 className="size-6 animate-spin text-[var(--blanc-ink-3)]" />
                        </div>
                    ) : page.invoices.length === 0 ? (
                        <div className="hidden h-32 items-center justify-center text-sm text-[var(--blanc-ink-3)] md:flex">
                            No invoices found
                        </div>
                    ) : (
                        <table className="hidden w-full text-sm blanc-table-tiles md:table">
                            <thead>
                                <tr>
                                    <th className="text-left px-4 py-1">#</th>
                                    <th className="text-left px-4 py-1">Customer</th>
                                    <th className="text-left px-4 py-1">Status</th>
                                    <th className="text-right px-4 py-1">Total</th>
                                    <th className="text-right px-4 py-1">Balance</th>
                                    <th className="text-left px-4 py-1">Due Date</th>
                                    <th className="text-right px-4 py-1 w-10"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {page.invoices.map(inv => {
                                    const capabilities = getInvoiceCapabilities(permissions, inv);
                                    const hasActions = capabilities.canEdit || capabilities.canSend || capabilities.canRemove;
                                    return (
                                        <tr
                                            key={inv.id}
                                            className={`cursor-pointer ${page.selectedInvoice?.id === inv.id ? 'blanc-tile-row-selected' : ''}`}
                                            onClick={() => page.selectInvoice(inv.id)}
                                            data-testid="invoice-list-row"
                                        >
                                            <td className="px-4 py-2 font-mono text-xs">{inv.invoice_number}</td>
                                            <td className="px-4 py-2 truncate max-w-[180px]">{inv.contact_name || inv.title || '-'}</td>
                                            <td className="px-4 py-2">
                                                <Badge variant={STATUS_VARIANT[inv.status] || 'secondary'} className="capitalize">
                                                    {inv.status}
                                                </Badge>
                                            </td>
                                            <td className="px-4 py-2 text-right font-mono">${formatMoney(inv.total)}</td>
                                            <td className="px-4 py-2 text-right font-mono">${formatMoney(inv.balance_due)}</td>
                                            <td className="px-4 py-2 text-muted-foreground">{formatDate(inv.due_date, timeZone)}</td>
                                            <td className="px-4 py-2 text-right">
                                                {hasActions ? <DropdownMenu>
                                                    <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                                                        <Button variant="ghost" size="sm" className="size-7 p-0" data-testid="invoice-row-actions">
                                                            <MoreHorizontal className="size-4" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
                                                        {capabilities.canEdit ? <DropdownMenuItem onClick={() => void handleEdit(inv)}>Edit</DropdownMenuItem> : null}
                                                        {capabilities.canSend ? <DropdownMenuItem onClick={() => handleSend(inv)}>{inv.status === 'draft' ? 'Send' : 'Resend'}</DropdownMenuItem> : null}
                                                        {capabilities.canRemove ? <DropdownMenuItem className="text-[var(--blanc-danger)]" onClick={() => setRemoving(inv)}>Remove invoice</DropdownMenuItem> : null}
                                                    </DropdownMenuContent>
                                                </DropdownMenu> : null}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Pagination */}
                {page.totalPages > 1 && (
                    <div className="hidden px-4 py-2 text-sm text-[var(--blanc-ink-3)] md:flex md:items-center md:justify-between">
                        <span>{page.total} invoice{page.total !== 1 ? 's' : ''}</span>
                        <div className="flex items-center gap-1">
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={page.filters.page <= 1}
                                onClick={() => page.setPage(page.filters.page - 1)}
                            >
                                <ChevronLeft className="size-4" />
                            </Button>
                            <span className="px-2">Page {page.filters.page} of {page.totalPages}</span>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={page.filters.page >= page.totalPages}
                                onClick={() => page.setPage(page.filters.page + 1)}
                            >
                                <ChevronRight className="size-4" />
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Dialogs ─────────────────────────────────────────────── */}
            <InvoiceEditorDialog
                open={editorOpen}
                onOpenChange={setEditorOpen}
                invoice={editingInvoice}
                onSave={handleEditorSave}
            />

            {sendInvoice && (
                <InvoiceSendDialog
                    open
                    onOpenChange={open => { if (!open) setSendInvoice(null); }}
                    invoice={sendInvoice}
                    onSend={(invoiceId, data) => page.handleSendInvoice(invoiceId, data)}
                />
            )}
            </div>

            <FloatingDetailPanel open={!!page.selectedInvoice} onClose={page.closeDetail} wide>
                {page.selectedInvoice && (
                    <InvoiceDetailPanel
                        invoice={page.selectedInvoice}
                        events={page.events}
                        loading={page.detailLoading}
                        onClose={page.closeDetail}
                        onSend={() => handleSend(page.selectedInvoice!)}
                        onSyncEstimate={() => page.handleSyncItems(page.selectedInvoice!.id)}
                        onRemoved={() => { page.closeDetail(); void page.loadInvoices(); }}
                        onChanged={() => page.loadInvoices()}
                    />
                )}
            </FloatingDetailPanel>

            {removing ? (
                <InvoiceRemoveDialog
                    invoice={removing}
                    open
                    onOpenChange={open => { if (!open) setRemoving(null); }}
                    onRemoved={() => { setRemoving(null); void page.loadInvoices(); }}
                />
            ) : null}
        </div>
    );
}

export default InvoicesPage;
