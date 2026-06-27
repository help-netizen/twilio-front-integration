import { useState } from 'react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Separator } from '../ui/separator';
import { Dialog, DialogContent } from '../ui/dialog';
import { FloatingDetailPanel } from '../ui/FloatingDetailPanel';
import { Plus, Loader2 } from 'lucide-react';
import { useLeadFinancials } from '../../hooks/useLeadFinancials';
import { EstimateEditorDialog } from '../estimates/EstimateEditorDialog';
import { InvoiceEditorDialog } from '../invoices/InvoiceEditorDialog';
import { EstimateDetailPanel } from '../estimates/EstimateDetailPanel';
import { InvoiceDetailPanel } from '../invoices/InvoiceDetailPanel';
import { InvoiceSendDialog } from '../invoices/InvoiceSendDialog';
import { archiveEstimate, fetchEstimate, fetchEstimateEvents, approveEstimate, declineEstimate, sendEstimate, restoreEstimate, linkJobToEstimate, updateEstimate } from '../../services/estimatesApi';
import { fetchInvoiceEvents, recordPayment, voidInvoice, deleteInvoice, sendInvoice } from '../../services/invoicesApi';
import type { EstimateEvent } from '../../services/estimatesApi';
import type { InvoiceEvent, RecordPaymentData } from '../../services/invoicesApi';
import { toast } from 'sonner';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ESTIMATE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary', sent: 'outline', viewed: 'outline',
    approved: 'default', declined: 'destructive',
};
const INVOICE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary', sent: 'outline', viewed: 'outline',
    partial: 'outline', paid: 'default', overdue: 'destructive', void: 'secondary',
};

function money(v: string | number | null | undefined): string {
    if (v == null) return '$0.00';
    return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props { leadId: number; }

// ── Component ─────────────────────────────────────────────────────────────────

export function LeadFinancialsTab({ leadId }: Props) {
    const {
        estimates, invoices, loading,
        selectedEstimate, selectedInvoice,
        setSelectedEstimate, setSelectedInvoice,
        refresh, handleCreateEstimate, handleCreateInvoice,
    } = useLeadFinancials(leadId);

    const [showEstimateEditor, setShowEstimateEditor] = useState(false);
    const [editingEstimate, setEditingEstimate] = useState<typeof selectedEstimate>(null);
    const [showInvoiceEditor, setShowInvoiceEditor] = useState(false);
    const [estimateEvents, setEstimateEvents] = useState<EstimateEvent[]>([]);
    const [invoiceEvents, setInvoiceEvents] = useState<InvoiceEvent[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [showInvoiceSend, setShowInvoiceSend] = useState(false);

    const openEstimate = async (e: (typeof estimates)[0]) => {
        setDetailLoading(true);
        try {
            const [fullEstimate, evts] = await Promise.all([
                fetchEstimate(e.id),
                fetchEstimateEvents(e.id),
            ]);
            setEstimateEvents(evts);
            setSelectedEstimate(fullEstimate);
            setSelectedInvoice(null);
        } finally {
            setDetailLoading(false);
        }
    };

    const openInvoice = async (i: (typeof invoices)[0]) => {
        setDetailLoading(true);
        try {
            const evts = await fetchInvoiceEvents(i.id);
            setInvoiceEvents(evts);
            setSelectedInvoice(i);
            setSelectedEstimate(null);
        } finally {
            setDetailLoading(false);
        }
    };

    const totalEstimated = estimates.reduce((s, e) => s + Number(e.total || 0), 0);
    const totalInvoiced = invoices.reduce((s, i) => s + Number(i.total || 0), 0);
    const totalPaid = invoices.reduce((s, i) => s + Number(i.amount_paid || 0), 0);

    return (
        <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-2">
                <div className="bg-muted/50 rounded-md p-2 text-center">
                    <p className="text-xs text-muted-foreground">Estimated</p>
                    <p className="font-mono font-semibold text-sm">{money(totalEstimated)}</p>
                </div>
                <div className="bg-muted/50 rounded-md p-2 text-center">
                    <p className="text-xs text-muted-foreground">Invoiced</p>
                    <p className="font-mono font-semibold text-sm">{money(totalInvoiced)}</p>
                </div>
                <div className="bg-muted/50 rounded-md p-2 text-center">
                    <p className="text-xs text-muted-foreground">Paid</p>
                    <p className="font-mono font-semibold text-sm text-green-600">{money(totalPaid)}</p>
                </div>
            </div>

            {loading && (
                <div className="flex items-center justify-center py-2 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin mr-2" />Loading...
                </div>
            )}

            {/* Estimates */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Estimates</p>
                    {estimates.length === 0 && (
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEditingEstimate(null); setShowEstimateEditor(true); }}>
                            <Plus className="size-3 mr-1" />New
                        </Button>
                    )}
                </div>
                {estimates.length === 0 && !loading && (
                    <p className="text-xs text-muted-foreground">No estimates</p>
                )}
                <div className="space-y-1">
                    {estimates.map(e => (
                        <button
                            key={e.id}
                            className="w-full flex items-center justify-between text-sm py-1.5 px-2 rounded hover:bg-muted/50 text-left"
                            onClick={() => openEstimate(e)}
                        >
                            <span className="font-mono text-xs text-muted-foreground mr-2">{e.estimate_number}</span>
                            <span className="flex-1 truncate">{e.summary || e.contact_name || 'Estimate'}</span>
                            <Badge variant={ESTIMATE_STATUS_VARIANT[e.status] || 'secondary'} className="capitalize text-xs ml-2 shrink-0">
                                {e.status}
                            </Badge>
                            <span className="font-mono text-xs ml-2 shrink-0">{money(e.total)}</span>
                        </button>
                    ))}
                </div>
            </div>

            <Separator />

            {/* Invoices */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Invoices</p>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowInvoiceEditor(true)}>
                        <Plus className="size-3 mr-1" />New
                    </Button>
                </div>
                {invoices.length === 0 && !loading && (
                    <p className="text-xs text-muted-foreground">No invoices</p>
                )}
                <div className="space-y-1">
                    {invoices.map(i => (
                        <button
                            key={i.id}
                            className="w-full flex items-center justify-between text-sm py-1.5 px-2 rounded hover:bg-muted/50 text-left"
                            onClick={() => openInvoice(i)}
                        >
                            <span className="font-mono text-xs text-muted-foreground mr-2">{i.invoice_number}</span>
                            <span className="flex-1 truncate">{i.title || 'Invoice'}</span>
                            <Badge variant={INVOICE_STATUS_VARIANT[i.status] || 'secondary'} className="capitalize text-xs ml-2 shrink-0">
                                {i.status}
                            </Badge>
                            <span className="font-mono text-xs ml-2 shrink-0">{money(i.total)}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Estimate editor dialog */}
            <EstimateEditorDialog
                open={showEstimateEditor}
                onOpenChange={(open) => { setShowEstimateEditor(open); if (!open) setEditingEstimate(null); }}
                estimate={editingEstimate}
                defaultLeadId={leadId}
                onSave={async (data) => {
                    if (editingEstimate) {
                        const updated = await updateEstimate(editingEstimate.id, data);
                        setSelectedEstimate(updated);
                    } else {
                        await handleCreateEstimate(data);
                    }
                    refresh();
                    setShowEstimateEditor(false);
                    setEditingEstimate(null);
                }}
            />

            {/* Invoice editor dialog */}
            <InvoiceEditorDialog
                open={showInvoiceEditor}
                onOpenChange={setShowInvoiceEditor}
                invoice={null}
                defaultLeadId={leadId}
                onSave={async (data) => {
                    await handleCreateInvoice(data);
                    setShowInvoiceEditor(false);
                }}
            />

            {/* Estimate detail panel — right-side slide-in (same UX as Job/Lead detail) */}
            {selectedEstimate && (
                <FloatingDetailPanel open={!!selectedEstimate} onClose={() => setSelectedEstimate(null)} wide>
                    <EstimateDetailPanel
                            estimate={selectedEstimate}
                            events={estimateEvents}
                            loading={detailLoading}
                            onClose={() => setSelectedEstimate(null)}
                            onEdit={() => {
                                setEditingEstimate(selectedEstimate);
                                setShowEstimateEditor(true);
                            }}
                            onSend={async (data) => {
                                try {
                                    await sendEstimate(selectedEstimate.id, data);
                                    toast.success('Send workflow opened');
                                    refresh();
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onApprove={async () => {
                                try {
                                    await approveEstimate(selectedEstimate.id);
                                    toast.success('Estimate approved');
                                    refresh();
                                    setSelectedEstimate(null);
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onDecline={async (reason: string) => {
                                try {
                                    await declineEstimate(selectedEstimate.id, reason);
                                    toast.success('Estimate declined');
                                    refresh();
                                    setSelectedEstimate(null);
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onArchive={async () => {
                                try {
                                    const updated = await archiveEstimate(selectedEstimate.id);
                                    toast.success('Estimate archived');
                                    refresh();
                                    setSelectedEstimate(updated);
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onRestore={async () => {
                                try {
                                    const updated = await restoreEstimate(selectedEstimate.id);
                                    toast.success('Estimate restored to draft');
                                    refresh();
                                    setSelectedEstimate(updated);
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onLinkJob={async (jId) => {
                                try {
                                    await linkJobToEstimate(selectedEstimate.id, jId);
                                    toast.success('Job linked');
                                    refresh();
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onInvoiceCreated={() => { refresh(); setSelectedEstimate(null); }}
                        />
                </FloatingDetailPanel>
            )}

            {/* Invoice detail dialog */}
            {selectedInvoice && (
                <Dialog open={!!selectedInvoice} onOpenChange={(o) => { if (!o) setSelectedInvoice(null); }}>
                    <DialogContent className="p-0 max-w-96 overflow-hidden">
                        <InvoiceDetailPanel
                            invoice={selectedInvoice}
                            events={invoiceEvents}
                            loading={detailLoading}
                            onClose={() => setSelectedInvoice(null)}
                            onEdit={() => {}}
                            onSend={() => setShowInvoiceSend(true)}
                            onVoid={async () => {
                                try {
                                    await voidInvoice(selectedInvoice.id);
                                    toast.success('Invoice voided');
                                    refresh();
                                    setSelectedInvoice(null);
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onRecordPayment={async (data: RecordPaymentData) => {
                                try {
                                    await recordPayment(selectedInvoice.id, data);
                                    toast.success('Payment recorded');
                                    refresh();
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onSyncEstimate={async () => {
                                try {
                                    const { syncItemsFromEstimate } = await import('../../services/invoicesApi');
                                    await syncItemsFromEstimate(selectedInvoice.id);
                                    toast.success('Synced from estimate');
                                    refresh();
                                } catch (err: any) { toast.error(err.message); }
                            }}
                            onDelete={async () => {
                                try {
                                    await deleteInvoice(selectedInvoice.id);
                                    toast.success('Invoice deleted');
                                    refresh();
                                    setSelectedInvoice(null);
                                } catch (err: any) { toast.error(err.message); }
                            }}
                        />
                    </DialogContent>
                </Dialog>
            )}

            {/* Invoice send dialog — operator confirms recipient/message (no empty-recipient sends) */}
            {selectedInvoice && (
                <InvoiceSendDialog
                    open={showInvoiceSend}
                    onOpenChange={setShowInvoiceSend}
                    invoiceId={selectedInvoice.id}
                    contactEmail={selectedInvoice.contact_email || ''}
                    contactPhone={selectedInvoice.contact_phone || ''}
                    contactName={selectedInvoice.contact_name || ''}
                    invoiceNumber={selectedInvoice.invoice_number}
                    balanceDue={selectedInvoice.balance_due}
                    total={selectedInvoice.total}
                    dueDate={selectedInvoice.due_date}
                    onSend={async (data) => {
                        try {
                            await sendInvoice(selectedInvoice.id, data);
                            toast.success('Invoice sent');
                            refresh();
                        } catch (err: any) {
                            toast.error(err.message);
                            throw err; // keep the dialog open on failure
                        }
                    }}
                />
            )}
        </div>
    );
}
