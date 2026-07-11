import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent } from '../ui/dialog';
import { FloatingDetailPanel } from '../ui/FloatingDetailPanel';
import { Archive, ChevronRight, CreditCard, FileText, Loader2, Lock, Plus, Receipt } from 'lucide-react';
import { CloudBanner } from '../ui/CloudBanner';
import { useJobFinancials } from '../../hooks/useJobFinancials';
import { useAuthz } from '../../hooks/useAuthz';
import { stripePaymentsApi } from '../../services/stripePaymentsApi';
import { CollectPaymentDialog } from './CollectPaymentDialog';
import { EstimateEditorDialog } from '../estimates/EstimateEditorDialog';
import { InvoiceEditorDialog } from '../invoices/InvoiceEditorDialog';
import { EstimateDetailPanel } from '../estimates/EstimateDetailPanel';
import { InvoiceDetailPanel } from '../invoices/InvoiceDetailPanel';
import { InvoiceSendDialog } from '../invoices/InvoiceSendDialog';
import { fetchEstimate, fetchEstimateEvents } from '../../services/estimatesApi';
import { fetchInvoiceEvents } from '../../services/invoicesApi';
import type { EstimateEvent } from '../../services/estimatesApi';
import type { InvoiceEvent, RecordPaymentData } from '../../services/invoicesApi';
import { recordPayment, voidInvoice, sendInvoice } from '../../services/invoicesApi';
import { approveEstimate, archiveEstimate, declineEstimate, restoreEstimate, sendEstimate, linkJobToEstimate, updateEstimate } from '../../services/estimatesApi';
import { deleteInvoice } from '../../services/invoicesApi';
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

function MetricCell({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warning' }) {
    const valueClass = tone === 'warning' ? 'text-[var(--blanc-warning)]' : 'text-[var(--blanc-ink-1)]';
    return (
        <div className="min-w-0 bg-[var(--blanc-panel-surface,#fffdf9)] px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--blanc-ink-3)]">{label}</p>
            <p className={`mt-1 truncate font-mono text-lg font-semibold ${valueClass}`}>{value}</p>
        </div>
    );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
    jobId: number;
    leadSerialId?: number | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function JobFinancialsTab({ jobId, leadSerialId }: Props) {
    const {
        estimates, invoices, loading,
        selectedEstimate, selectedInvoice,
        setSelectedEstimate, setSelectedInvoice,
        refresh, handleCreateEstimate, handleCreateInvoice,
    } = useJobFinancials(jobId);

    const [showEstimateEditor, setShowEstimateEditor] = useState(false);
    const [editingEstimate, setEditingEstimate] = useState<typeof selectedEstimate>(null);
    const [showInvoiceEditor, setShowInvoiceEditor] = useState(false);
    const [estimateEvents, setEstimateEvents] = useState<EstimateEvent[]>([]);
    const [invoiceEvents, setInvoiceEvents] = useState<InvoiceEvent[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [showInvoiceSend, setShowInvoiceSend] = useState(false);
    const [showCollect, setShowCollect] = useState(false);

    // ── STRIPE-ADHOC-PAY-001: collect-payment button/CTA gating ─────────────────
    const navigate = useNavigate();
    const { hasAnyPermission, hasPermission } = useAuthz();
    const canCollect = hasAnyPermission('payments.collect_online', 'payments.collect_offline', 'payments.collect_keyed');
    // Only fetch Stripe readiness when the user could actually collect (FR-BTN-2: no perm → nothing).
    const { data: stripeStatus, isLoading: stripeLoading } = useQuery({
        queryKey: ['stripe-payments-status'],
        queryFn: () => stripePaymentsApi.getStatus().then(r => r.status),
        enabled: canCollect,
    });
    const canManageIntegrations = hasPermission('tenant.integrations.manage');

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
    const totalDue = Math.max(totalInvoiced - totalPaid, 0);

    // Collect-payment surface (STRIPE-ADHOC-PAY-001 §1). Perm-gate FIRST: no collect
    // perm → render nothing at all (no button, no CTA). Then split on Stripe readiness.
    const readiness = stripeStatus?.readiness;
    const stripeReady = !!stripeStatus?.configured && !!stripeStatus?.can_collect;
    // CTA copy per readiness (manage user). not_connected/disconnected → "Connect"; the
    // setup-incomplete states → "Finish setup". payouts_disabled never reaches here (can_collect=true).
    const isConnectState = readiness === 'not_connected' || readiness === 'disconnected';
    // Show the CTA card only for a permitted-but-not-ready company with a known readiness
    // state (loading / configured===false → nothing, matching the invoice silent-absence).
    const showCta = canCollect && !stripeLoading && !!stripeStatus?.configured && !stripeStatus?.can_collect && !!readiness;

    return (
        <div className="flex-1 overflow-y-auto bg-[var(--blanc-panel-surface,#fffdf9)] p-5 text-[var(--blanc-ink-1)]">
            <div className="mx-auto max-w-5xl space-y-5">
                <div className="overflow-hidden rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-line)]">
                    <div className="grid grid-cols-3 gap-px">
                        <MetricCell label="Estimated" value={money(totalEstimated)} />
                        <MetricCell label="Invoiced" value={money(totalInvoiced)} />
                        <MetricCell label="Due" value={money(totalDue)} tone={totalDue > 0 ? 'warning' : 'default'} />
                    </div>
                </div>

                {/* Collect payment — STRIPE-ADHOC-PAY-001 §1 (perm-gated, readiness-driven). */}
                {canCollect && stripeReady && (
                    <div className="flex justify-end">
                        <Button size="sm" onClick={() => setShowCollect(true)}>
                            <CreditCard className="mr-1 size-4" />Collect payment
                        </Button>
                    </div>
                )}
                {showCta && (
                    <CloudBanner variant="compact">
                        {canManageIntegrations ? (
                            <>
                                <h3
                                    className="text-base font-extrabold text-[var(--blanc-ink-1)] sm:text-lg"
                                    style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em' }}
                                >
                                    {isConnectState ? 'Get paid for this job today' : 'Almost there — finish your Stripe setup'}
                                </h3>
                                <p className="mt-1.5 max-w-prose text-sm text-[var(--blanc-ink-2)]">
                                    {isConnectState
                                        ? "Charge the card on the spot or text a secure payment link. No invoice needed — money hits your bank in days."
                                        : 'Stripe needs a few more business details before you can take payments.'}
                                </p>
                                <div className="mt-4 flex flex-wrap items-center gap-3">
                                    <Button
                                        className="h-11 px-5"
                                        onClick={() => navigate('/settings/integrations/stripe-payments')}
                                    >
                                        {isConnectState ? 'Connect Stripe' : 'Finish setup'}
                                    </Button>
                                    {isConnectState && (
                                        <span className="text-xs text-[var(--blanc-ink-3)]">One-time setup · ~5 min</span>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="flex items-start gap-3">
                                <Lock className="mt-0.5 size-4 shrink-0 text-[var(--blanc-ink-3)]" />
                                <p className="text-sm text-[var(--blanc-ink-2)]">
                                    Your company isn't set up for payments yet. Ask an account admin to connect Stripe in Settings → Integrations.
                                </p>
                            </div>
                        )}
                    </CloudBanner>
                )}


                {loading && (
                    <div className="flex items-center justify-center rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] py-6 text-sm text-[var(--blanc-ink-2)]">
                        <Loader2 className="mr-2 size-4 animate-spin" />Loading financials...
                    </div>
                )}

                <section className="rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)]">
                    <div className="flex items-start justify-between gap-3 border-b border-[var(--blanc-line)] px-4 py-3">
                        <div>
                            <h3 className="text-sm font-semibold">Estimate</h3>
                            <p className="mt-0.5 text-xs text-[var(--blanc-ink-2)]">Customer-facing repair proposal for this job.</p>
                        </div>
                    </div>
                    {estimates.length === 0 && !loading ? (
                        <div className="px-4 py-8">
                            <div className="rounded-md border border-dashed border-[var(--blanc-line)] bg-[rgba(25,25,25,0.03)] px-4 py-6 text-center">
                                <FileText className="mx-auto size-8 text-[var(--blanc-ink-3)]" />
                                <p className="mt-3 text-sm font-medium">No estimate yet</p>
                                <p className="mx-auto mt-1 max-w-md text-sm text-[var(--blanc-ink-2)]">
                                    Start with one custom item or Summary. The estimate is saved only after useful content is added.
                                </p>
                                <Button className="mt-4" size="sm" onClick={() => { setEditingEstimate(null); setShowEstimateEditor(true); }}>
                                    <Plus className="mr-1 size-4" />Create estimate
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="divide-y">
                            {estimates.map(e => {
                                const archived = !!e.archived_at;
                                return (
                                    <button
                                        key={e.id}
                                        className={`group grid w-full grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-[rgba(25,25,25,0.04)] ${archived ? 'grayscale opacity-60' : ''}`}
                                        onClick={() => openEstimate(e)}
                                    >
                                        <div className="flex min-w-0 items-start gap-3">
                                            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-[rgba(25,25,25,0.04)]">
                                                <FileText className="size-4 text-[var(--blanc-ink-3)]" />
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="font-mono text-xs font-semibold">{e.estimate_number}</span>
                                                    <Badge variant={ESTIMATE_STATUS_VARIANT[e.status] || 'secondary'} className="capitalize">
                                                        {e.status}
                                                    </Badge>
                                                    {archived && <Badge variant="outline"><Archive className="mr-1 size-3" />Archived</Badge>}
                                                </div>
                                                <p className="mt-1 truncate text-sm text-[var(--blanc-ink-2)]">
                                                    {e.summary || e.contact_name || 'Estimate'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="font-mono text-sm font-semibold">{money(e.total)}</span>
                                            <ChevronRight className="size-4 text-[var(--blanc-ink-3)] transition-transform group-hover:translate-x-0.5" />
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </section>


                <section className="rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)]">
                    <div className="flex items-start justify-between gap-3 border-b border-[var(--blanc-line)] px-4 py-3">
                        <div>
                            <h3 className="text-sm font-semibold">Invoices & payments</h3>
                            <p className="mt-0.5 text-xs text-[var(--blanc-ink-2)]">Billing documents created after approval.</p>
                        </div>
                        {invoices.length > 0 && (
                            <Button variant="outline" size="sm" onClick={() => setShowInvoiceEditor(true)}>
                                <Plus className="mr-1 size-4" />New invoice
                            </Button>
                        )}
                    </div>
                    {invoices.length === 0 && !loading ? (
                        <div className="px-4 py-8">
                            <div className="rounded-md border border-dashed border-[var(--blanc-line)] bg-[rgba(25,25,25,0.03)] px-4 py-6 text-center">
                                <Receipt className="mx-auto size-8 text-[var(--blanc-ink-3)]" />
                                <p className="mt-3 text-sm font-medium">No invoices yet</p>
                                <p className="mx-auto mt-1 max-w-md text-sm text-[var(--blanc-ink-2)]">
                                    Create an invoice once the work is ready to bill, or convert an approved estimate.
                                </p>
                                <Button className="mt-4" size="sm" onClick={() => setShowInvoiceEditor(true)}>
                                    <Plus className="mr-1 size-4" />Create invoice
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="divide-y">
                            {invoices.map(i => (
                                <button
                                    key={i.id}
                                    className="group grid w-full grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-[rgba(25,25,25,0.04)]"
                                    onClick={() => openInvoice(i)}
                                >
                                    <div className="flex min-w-0 items-start gap-3">
                                        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-[rgba(25,25,25,0.04)]">
                                            <Receipt className="size-4 text-[var(--blanc-ink-3)]" />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-mono text-xs font-semibold">{i.invoice_number}</span>
                                                <Badge variant={INVOICE_STATUS_VARIANT[i.status] || 'secondary'} className="capitalize">
                                                    {i.status}
                                                </Badge>
                                            </div>
                                            <p className="mt-1 truncate text-sm text-[var(--blanc-ink-2)]">{i.title || 'Invoice'}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className="font-mono text-sm font-semibold">{money(i.total)}</span>
                                        <ChevronRight className="size-4 text-[var(--blanc-ink-3)] transition-transform group-hover:translate-x-0.5" />
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </section>
            </div>

            {/* Estimate editor dialog */}
            <EstimateEditorDialog
                open={showEstimateEditor}
                onOpenChange={(open) => { setShowEstimateEditor(open); if (!open) setEditingEstimate(null); }}
                estimate={editingEstimate}
                defaultJobId={jobId}
                defaultEstimateNumber={leadSerialId ? `ESTIMATE L-${leadSerialId}-1` : undefined}
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
                defaultJobId={jobId}
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
                    <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden p-0 md:max-w-3xl">
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

            {/* Collect payment — arbitrary-amount card charge / link, no invoice (STRIPE-ADHOC-PAY-001) */}
            <CollectPaymentDialog
                open={showCollect}
                onOpenChange={setShowCollect}
                jobId={jobId}
                outstanding={totalDue}
                onSuccess={() => refresh()}
            />
        </div>
    );
}
