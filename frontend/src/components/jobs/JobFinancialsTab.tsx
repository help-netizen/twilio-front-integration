import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Separator } from '../ui/separator';
import { Loader2, Plus, FileText, Receipt, ArrowRight } from 'lucide-react';
import { useJobFinancials } from '../../hooks/useJobFinancials';
import { EstimateDetailPanel } from '../estimates/EstimateDetailPanel';
import { EstimateEditorDialog } from '../estimates/EstimateEditorDialog';
import { EstimateSendDialog } from '../estimates/EstimateSendDialog';
import { InvoiceDetailPanel } from '../invoices/InvoiceDetailPanel';
import { InvoiceEditorDialog } from '../invoices/InvoiceEditorDialog';
import { InvoiceSendDialog } from '../invoices/InvoiceSendDialog';
import type { Estimate } from '../../services/estimatesApi';
import type { EstimateCreateData } from '../../services/estimatesApi';
import type { InvoiceCreateData } from '../../services/invoicesApi';
import { sendEstimate } from '../../services/estimatesApi';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ESTIMATE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary',
    sent: 'outline',
    viewed: 'outline',
    accepted: 'default',
    declined: 'destructive',
    expired: 'secondary',
    converted: 'default',
};

const INVOICE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary',
    sent: 'outline',
    viewed: 'outline',
    partial: 'outline',
    paid: 'default',
    overdue: 'destructive',
    void: 'secondary',
    refunded: 'secondary',
};

function money(value: string | number | null | undefined): string {
    if (value == null) return '$0.00';
    return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(value: string | null | undefined): string {
    if (!value) return '—';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
    jobId: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function JobFinancialsTab({ jobId }: Props) {
    const financials = useJobFinancials(jobId);

    // Editor dialogs
    const [showEstimateEditor, setShowEstimateEditor] = useState(false);
    const [editingEstimate, setEditingEstimate] = useState<Estimate | null>(null);
    const [showInvoiceEditor, setShowInvoiceEditor] = useState(false);
    const [editingInvoiceId, setEditingInvoiceId] = useState<number | null>(null);

    // Send dialogs
    const [showEstimateSend, setShowEstimateSend] = useState(false);
    const [showInvoiceSend, setShowInvoiceSend] = useState(false);

    // Detail dialogs
    const [showEstimateDetail, setShowEstimateDetail] = useState(false);
    const [showInvoiceDetail, setShowInvoiceDetail] = useState(false);

    // ── Summary ───────────────────────────────────────────────────────────────

    const totalEstimated = financials.estimates.reduce((sum, e) => sum + Number(e.total || 0), 0);
    const totalInvoiced = financials.invoices.reduce((sum, i) => sum + Number(i.total || 0), 0);
    const totalPaid = financials.invoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0);

    // ── Handlers: Estimates ───────────────────────────────────────────────────

    const openNewEstimate = () => {
        setEditingEstimate(null);
        setShowEstimateEditor(true);
    };

    const openEditEstimate = (est: Estimate) => {
        setEditingEstimate(est);
        setShowEstimateEditor(true);
        setShowEstimateDetail(false);
    };

    const handleSaveEstimate = async (data: EstimateCreateData) => {
        if (editingEstimate) {
            await financials.updateEstimate(editingEstimate.id, data);
        } else {
            await financials.createEstimate(data);
        }
        setShowEstimateEditor(false);
    };

    const openEstimateDetail = async (id: number) => {
        await financials.selectEstimate(id);
        setShowEstimateDetail(true);
    };

    const closeEstimateDetail = () => {
        setShowEstimateDetail(false);
        financials.clearSelectedEstimate();
    };

    // ── Handlers: Invoices ────────────────────────────────────────────────────

    const openNewInvoice = () => {
        setEditingInvoiceId(null);
        setShowInvoiceEditor(true);
    };

    const openEditInvoice = (id: number) => {
        setEditingInvoiceId(id);
        setShowInvoiceEditor(true);
        setShowInvoiceDetail(false);
    };

    const handleSaveInvoice = async (data: InvoiceCreateData) => {
        if (editingInvoiceId) {
            await financials.updateInvoice(editingInvoiceId, data);
        } else {
            await financials.createInvoice(data);
        }
        setShowInvoiceEditor(false);
    };

    const openInvoiceDetail = async (id: number) => {
        await financials.selectInvoice(id);
        setShowInvoiceDetail(true);
    };

    const closeInvoiceDetail = () => {
        setShowInvoiceDetail(false);
        financials.clearSelectedInvoice();
    };

    // ── Derived state for editing invoice ────────────────────────────────────

    const editingInvoice = editingInvoiceId
        ? financials.invoices.find(i => i.id === editingInvoiceId) ?? financials.selectedInvoice
        : null;

    // ── Render ────────────────────────────────────────────────────────────────

    if (financials.loading) {
        return (
            <div className="flex-1 flex items-center justify-center p-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">

            {/* ── Summary ── */}
            <div className="grid grid-cols-3 gap-3">
                <div className="bg-muted/40 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Estimated</p>
                    <p className="font-semibold font-mono text-sm">{money(totalEstimated)}</p>
                </div>
                <div className="bg-muted/40 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Invoiced</p>
                    <p className="font-semibold font-mono text-sm">{money(totalInvoiced)}</p>
                </div>
                <div className="bg-muted/40 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Paid</p>
                    <p className="font-semibold font-mono text-sm text-green-600">{money(totalPaid)}</p>
                </div>
            </div>

            <Separator />

            {/* ── Estimates ── */}
            <div>
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <FileText className="size-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">Estimates</span>
                        {financials.estimates.length > 0 && (
                            <span className="text-xs text-muted-foreground">({financials.estimates.length})</span>
                        )}
                    </div>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openNewEstimate}>
                        <Plus className="size-3 mr-1" />New Estimate
                    </Button>
                </div>

                {financials.estimates.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">No estimates yet</p>
                ) : (
                    <div className="space-y-1.5">
                        {financials.estimates.map(est => (
                            <div
                                key={est.id}
                                className="flex items-center justify-between p-2.5 rounded-md border bg-background hover:bg-muted/30 cursor-pointer group"
                                onClick={() => openEstimateDetail(est.id)}
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-mono text-xs text-muted-foreground shrink-0">{est.estimate_number}</span>
                                    <Badge variant={ESTIMATE_STATUS_VARIANT[est.status] || 'secondary'} className="capitalize text-xs shrink-0">
                                        {est.status}
                                    </Badge>
                                    {est.title && (
                                        <span className="text-sm truncate text-muted-foreground">{est.title}</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-3 shrink-0 ml-2">
                                    <span className="font-mono text-sm font-medium">{money(est.total)}</span>
                                    <span className="text-xs text-muted-foreground hidden group-hover:block">{fmtDate(est.created_at)}</span>
                                    <ArrowRight className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <Separator />

            {/* ── Invoices ── */}
            <div>
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Receipt className="size-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">Invoices</span>
                        {financials.invoices.length > 0 && (
                            <span className="text-xs text-muted-foreground">({financials.invoices.length})</span>
                        )}
                    </div>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openNewInvoice}>
                        <Plus className="size-3 mr-1" />New Invoice
                    </Button>
                </div>

                {financials.invoices.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">No invoices yet</p>
                ) : (
                    <div className="space-y-1.5">
                        {financials.invoices.map(inv => {
                            const paid = Number(inv.amount_paid || 0);
                            const total = Number(inv.total || 0);
                            const pct = total > 0 ? Math.min((paid / total) * 100, 100) : 0;
                            return (
                                <div
                                    key={inv.id}
                                    className="flex items-center justify-between p-2.5 rounded-md border bg-background hover:bg-muted/30 cursor-pointer group"
                                    onClick={() => openInvoiceDetail(inv.id)}
                                >
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="font-mono text-xs text-muted-foreground shrink-0">{inv.invoice_number}</span>
                                        <Badge variant={INVOICE_STATUS_VARIANT[inv.status] || 'secondary'} className="capitalize text-xs shrink-0">
                                            {inv.status}
                                        </Badge>
                                        {inv.title && (
                                            <span className="text-sm truncate text-muted-foreground">{inv.title}</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0 ml-2">
                                        <div className="text-right hidden group-hover:block">
                                            <div className="w-16 bg-muted rounded-full h-1.5">
                                                <div className="bg-green-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                                            </div>
                                        </div>
                                        <span className="font-mono text-sm font-medium">{money(inv.total)}</span>
                                        <ArrowRight className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── Dialogs ── */}

            {/* Estimate detail dialog */}
            <Dialog open={showEstimateDetail} onOpenChange={open => !open && closeEstimateDetail()}>
                <DialogContent className="max-w-lg p-0 overflow-hidden">
                    {financials.selectedEstimate ? (
                        <EstimateDetailPanel
                            estimate={financials.selectedEstimate}
                            events={financials.selectedEstimateEvents}
                            loading={financials.selectedEstimateLoading}
                            onClose={closeEstimateDetail}
                            onEdit={() => openEditEstimate(financials.selectedEstimate!)}
                            onSend={() => setShowEstimateSend(true)}
                            onApprove={async () => {
                                await financials.approveEstimate(financials.selectedEstimate!.id);
                                await financials.selectEstimate(financials.selectedEstimate!.id);
                            }}
                            onDecline={async () => {
                                await financials.declineEstimate(financials.selectedEstimate!.id);
                                await financials.selectEstimate(financials.selectedEstimate!.id);
                            }}
                            onDelete={async () => {
                                await financials.deleteEstimate(financials.selectedEstimate!.id);
                                closeEstimateDetail();
                            }}
                            onLinkJob={() => {/* already linked to this job */}}
                        />
                    ) : (
                        <div className="flex items-center justify-center p-12">
                            <Loader2 className="size-6 animate-spin text-muted-foreground" />
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Estimate send dialog */}
            {financials.selectedEstimate && (
                <EstimateSendDialog
                    open={showEstimateSend}
                    onOpenChange={setShowEstimateSend}
                    estimateId={financials.selectedEstimate.id}
                    onSend={async (data) => {
                        await sendEstimate(financials.selectedEstimate!.id, data);
                        await financials.selectEstimate(financials.selectedEstimate!.id);
                        await financials.refresh();
                    }}
                />
            )}

            {/* Estimate editor dialog */}
            <EstimateEditorDialog
                open={showEstimateEditor}
                onOpenChange={setShowEstimateEditor}
                estimate={editingEstimate}
                defaultJobId={jobId}
                onSave={handleSaveEstimate}
            />

            {/* Invoice detail dialog */}
            <Dialog open={showInvoiceDetail} onOpenChange={open => !open && closeInvoiceDetail()}>
                <DialogContent className="max-w-lg p-0 overflow-hidden">
                    {financials.selectedInvoice ? (
                        <InvoiceDetailPanel
                            invoice={financials.selectedInvoice}
                            events={financials.selectedInvoiceEvents}
                            loading={financials.selectedInvoiceLoading}
                            onClose={closeInvoiceDetail}
                            onEdit={() => openEditInvoice(financials.selectedInvoice!.id)}
                            onSend={() => setShowInvoiceSend(true)}
                            onVoid={async () => {
                                await financials.voidInvoice(financials.selectedInvoice!.id);
                                await financials.selectInvoice(financials.selectedInvoice!.id);
                            }}
                            onRecordPayment={async (data) => {
                                await financials.recordPayment(financials.selectedInvoice!.id, data);
                                await financials.selectInvoice(financials.selectedInvoice!.id);
                            }}
                            onSyncEstimate={async () => {
                                await financials.syncEstimate(financials.selectedInvoice!.id);
                                await financials.selectInvoice(financials.selectedInvoice!.id);
                            }}
                            onDelete={async () => {
                                await financials.deleteInvoice(financials.selectedInvoice!.id);
                                closeInvoiceDetail();
                            }}
                        />
                    ) : (
                        <div className="flex items-center justify-center p-12">
                            <Loader2 className="size-6 animate-spin text-muted-foreground" />
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Invoice send dialog */}
            {financials.selectedInvoice && (
                <InvoiceSendDialog
                    open={showInvoiceSend}
                    onOpenChange={setShowInvoiceSend}
                    invoiceId={financials.selectedInvoice.id}
                    onSend={async (data) => {
                        await financials.sendInvoice(financials.selectedInvoice!.id, data);
                        await financials.selectInvoice(financials.selectedInvoice!.id);
                    }}
                />
            )}

            {/* Invoice editor dialog */}
            <InvoiceEditorDialog
                open={showInvoiceEditor}
                onOpenChange={setShowInvoiceEditor}
                invoice={editingInvoice ?? null}
                defaultJobId={jobId}
                onSave={handleSaveInvoice}
            />
        </div>
    );
}

// Re-export for use as "create invoice from estimate" trigger on the accepted estimate row
export function CreateInvoiceFromEstimateButton({ estimate, onCreated }: { estimate: Estimate; onCreated: () => void }) {
    const [loading, setLoading] = useState(false);

    const handleClick = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setLoading(true);
        try {
            const { createInvoice: apiCreate } = await import('../../services/invoicesApi');
            await apiCreate({
                job_id: estimate.job_id,
                estimate_id: estimate.id,
                contact_id: estimate.contact_id,
                lead_id: estimate.lead_id,
                title: estimate.title || undefined,
                notes: estimate.notes || undefined,
                internal_note: estimate.internal_note || undefined,
                tax_rate: estimate.tax_rate,
                discount_amount: estimate.discount_amount,
                items: estimate.items?.map(it => ({
                    sort_order: it.sort_order,
                    name: it.name,
                    description: it.description,
                    quantity: it.quantity,
                    unit: it.unit,
                    unit_price: it.unit_price,
                    amount: it.amount,
                    taxable: it.taxable,
                    metadata: it.metadata,
                })),
            });
            onCreated();
        } finally {
            setLoading(false);
        }
    };

    return (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleClick} disabled={loading}>
            {loading ? <Loader2 className="size-3 animate-spin mr-1" /> : <ArrowRight className="size-3 mr-1" />}
            Create Invoice
        </Button>
    );
}
