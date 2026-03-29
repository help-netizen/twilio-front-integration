import { useState } from 'react';
import { useInvoices } from '../hooks/useInvoices';
import { InvoiceDetailPanel } from '../components/invoices/InvoiceDetailPanel';
import { InvoiceEditorDialog } from '../components/invoices/InvoiceEditorDialog';
import { InvoiceSendDialog } from '../components/invoices/InvoiceSendDialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Plus, Search, MoreHorizontal, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Invoice, InvoiceCreateData } from '../services/invoicesApi';

// ── Status helpers ───────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
    { value: '', label: 'All Statuses' },
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

function formatDate(value: string | null): string {
    if (!value) return '-';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Component ────────────────────────────────────────────────────────────────

export function InvoicesPage() {
    const page = useInvoices();
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
    const [sendDialogOpen, setSendDialogOpen] = useState(false);
    const [sendInvoiceId, setSendInvoiceId] = useState<number | null>(null);

    const handleCreate = () => {
        setEditingInvoice(null);
        setEditorOpen(true);
    };

    const handleEdit = (invoice: Invoice) => {
        setEditingInvoice(invoice);
        setEditorOpen(true);
    };

    const handleEditorSave = async (data: InvoiceCreateData) => {
        if (editingInvoice) {
            await page.handleUpdateInvoice(editingInvoice.id, data);
        } else {
            await page.handleCreateInvoice(data);
        }
        setEditorOpen(false);
        setEditingInvoice(null);
    };

    const handleSend = (id: number) => {
        setSendInvoiceId(id);
        setSendDialogOpen(true);
    };

    return (
        <div className="flex h-full overflow-hidden">
            {/* ── Left: Invoices List ──────────────────────────────────── */}
            <div className={`flex flex-col overflow-hidden ${page.selectedInvoice ? 'hidden md:flex md:w-[400px] md:flex-shrink-0 border-r' : 'flex flex-1'}`}>
                {/* Toolbar */}
                <div className="border-b p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold">Invoices</h2>
                        <Button size="sm" onClick={handleCreate}>
                            <Plus className="size-4 mr-1" />New Invoice
                        </Button>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                            <Input
                                placeholder="Search invoices..."
                                className="pl-8"
                                value={page.filters.search}
                                onChange={e => page.setSearch(e.target.value)}
                            />
                        </div>
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
                    </div>
                </div>

                {/* Table */}
                <div className="flex-1 overflow-auto">
                    {page.loading ? (
                        <div className="flex items-center justify-center h-32">
                            <Loader2 className="size-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : page.invoices.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm">
                            No invoices found
                        </div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-background border-b">
                                <tr>
                                    <th className="text-left px-4 py-2 font-medium">#</th>
                                    <th className="text-left px-4 py-2 font-medium">Customer</th>
                                    <th className="text-left px-4 py-2 font-medium">Status</th>
                                    <th className="text-right px-4 py-2 font-medium">Total</th>
                                    <th className="text-right px-4 py-2 font-medium">Balance</th>
                                    <th className="text-left px-4 py-2 font-medium">Due Date</th>
                                    <th className="text-right px-4 py-2 font-medium w-10"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {page.invoices.map(inv => (
                                    <tr
                                        key={inv.id}
                                        className={`border-b cursor-pointer hover:bg-muted/50 transition-colors ${page.selectedInvoice?.id === inv.id ? 'bg-muted' : ''}`}
                                        onClick={() => page.selectInvoice(inv.id)}
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
                                        <td className="px-4 py-2 text-muted-foreground">{formatDate(inv.due_date)}</td>
                                        <td className="px-4 py-2 text-right">
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                                                    <Button variant="ghost" size="sm" className="size-7 p-0">
                                                        <MoreHorizontal className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
                                                    <DropdownMenuItem onClick={() => handleEdit(inv)}>Edit</DropdownMenuItem>
                                                    {inv.status === 'draft' && (
                                                        <DropdownMenuItem onClick={() => handleSend(inv.id)}>Send</DropdownMenuItem>
                                                    )}
                                                    {(inv.status === 'sent' || inv.status === 'partial' || inv.status === 'overdue') && (
                                                        <DropdownMenuItem onClick={() => {
                                                            const amount = prompt('Enter payment amount:');
                                                            if (amount && !isNaN(Number(amount))) {
                                                                page.handleRecordPayment(inv.id, { amount });
                                                            }
                                                        }}>Record Payment</DropdownMenuItem>
                                                    )}
                                                    {inv.status !== 'void' && inv.status !== 'refunded' && (
                                                        <DropdownMenuItem onClick={() => page.handleVoidInvoice(inv.id)}>Void</DropdownMenuItem>
                                                    )}
                                                    <DropdownMenuItem className="text-red-600" onClick={() => page.handleDeleteInvoice(inv.id)}>Delete</DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Pagination */}
                {page.totalPages > 1 && (
                    <div className="border-t px-4 py-2 flex items-center justify-between text-sm text-muted-foreground">
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

            {/* ── Right: Detail Panel ──────────────────────────────────── */}
            {page.selectedInvoice && (
                <InvoiceDetailPanel
                    invoice={page.selectedInvoice}
                    events={page.events}
                    loading={page.detailLoading}
                    onClose={page.closeDetail}
                    onEdit={() => handleEdit(page.selectedInvoice!)}
                    onSend={() => handleSend(page.selectedInvoice!.id)}
                    onVoid={() => page.handleVoidInvoice(page.selectedInvoice!.id)}
                    onRecordPayment={(data) => page.handleRecordPayment(page.selectedInvoice!.id, data)}
                    onSyncEstimate={() => page.handleSyncItems(page.selectedInvoice!.id)}
                    onDelete={() => page.handleDeleteInvoice(page.selectedInvoice!.id)}
                />
            )}

            {/* ── Dialogs ─────────────────────────────────────────────── */}
            <InvoiceEditorDialog
                open={editorOpen}
                onOpenChange={setEditorOpen}
                invoice={editingInvoice}
                onSave={handleEditorSave}
            />

            {sendInvoiceId != null && (
                <InvoiceSendDialog
                    open={sendDialogOpen}
                    onOpenChange={open => { setSendDialogOpen(open); if (!open) setSendInvoiceId(null); }}
                    invoiceId={sendInvoiceId}
                    contactEmail={page.selectedInvoice?.contact_name || ''}
                    onSend={data => page.handleSendInvoice(sendInvoiceId, data)}
                />
            )}
        </div>
    );
}

export default InvoicesPage;
