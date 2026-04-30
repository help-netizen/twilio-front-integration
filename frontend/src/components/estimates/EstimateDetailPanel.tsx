import { useState } from 'react';
import { Archive, Check, Clock, Eye, FileText, Link2, Loader2, Pencil, RotateCcw, Send, X, XCircle } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Textarea } from '../ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { EstimatePreviewDialog } from './EstimatePreviewDialog';
import { EstimateSendDialog } from './EstimateSendDialog';
import type { Estimate, EstimateEvent, EstimateSendData } from '../../services/estimatesApi';
import { convertEstimateToInvoice } from '../../services/estimatesApi';
import { toast } from 'sonner';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary',
    sent: 'outline',
    viewed: 'outline',
    approved: 'default',
    declined: 'destructive',
};

function money(value: string | number | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(value: string | null | undefined): string {
    if (!value) return '-';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(value: string | null | undefined): string {
    if (!value) return '-';
    return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

interface Props {
    estimate: Estimate;
    events: EstimateEvent[];
    loading: boolean;
    onClose: () => void;
    onEdit: () => void;
    onSend: (data: EstimateSendData) => Promise<any> | void;
    onApprove: () => void;
    onDecline: (reason: string) => Promise<void> | void;
    onArchive: () => void;
    onRestore: () => void;
    onLinkJob: (jobId: number) => void;
    onInvoiceCreated?: () => void;
}

export function EstimateDetailPanel({ estimate, events, loading, onClose, onEdit, onSend, onApprove, onDecline, onArchive, onRestore, onLinkJob, onInvoiceCreated }: Props) {
    const [converting, setConverting] = useState(false);
    const [summaryOpen, setSummaryOpen] = useState(false);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [sendOpen, setSendOpen] = useState(false);
    const [declineOpen, setDeclineOpen] = useState(false);
    const [declineReason, setDeclineReason] = useState('');
    const archived = !!estimate.archived_at;
    const hasItems = !!estimate.items?.length;

    const handleConvertToInvoice = async () => {
        setConverting(true);
        try {
            await convertEstimateToInvoice(estimate.id);
            toast.success('Invoice created from estimate');
            onInvoiceCreated?.();
        } catch (err: any) {
            toast.error(err.message || 'Failed to create invoice');
        } finally {
            setConverting(false);
        }
    };

    const submitDecline = async () => {
        if (!declineReason.trim()) return;
        await onDecline(declineReason.trim());
        setDeclineOpen(false);
        setDeclineReason('');
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className={`flex h-full flex-col overflow-y-auto ${archived ? 'grayscale opacity-60' : ''}`}>
            <div className="flex items-center justify-between border-b p-4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{estimate.estimate_number}</span>
                    <Badge variant={STATUS_VARIANT[estimate.status] || 'secondary'} className="capitalize">{estimate.status}</Badge>
                    {archived && <Badge variant="outline">Archived</Badge>}
                    {estimate.invoice_number && <Badge variant="outline">Invoice #{estimate.invoice_number}</Badge>}
                </div>
                <Button variant="ghost" size="sm" className="size-7 p-0 md:hidden" onClick={onClose}>
                    <X className="size-4" />
                </Button>
            </div>

            <div className="space-y-4 p-4">
                <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Customer</p>
                    <p className="text-sm">{estimate.contact_name || 'No customer linked'}</p>
                </div>

                {estimate.summary && (
                    <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
                        <div className="rounded-md border">
                            <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium">
                                <span>Summary</span>
                                <Eye className="size-4 text-muted-foreground" />
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <div className="border-t px-3 py-3 text-sm whitespace-pre-wrap text-muted-foreground">{estimate.summary}</div>
                            </CollapsibleContent>
                        </div>
                    </Collapsible>
                )}

                <Separator />

                <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Items</p>
                    {hasItems ? (
                        <div className="space-y-2">
                            {estimate.items!.map(item => (
                                <div key={item.id} className="grid grid-cols-[1fr_auto] gap-3 rounded-md border p-3 text-sm">
                                    <div className="min-w-0">
                                        <p className="font-medium">{item.name}</p>
                                        {item.description && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{item.description}</p>}
                                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                            <span>{Number(item.quantity)} x {money(item.unit_price)}</span>
                                            <Badge variant="outline" className="text-[10px]">{item.taxable ? 'Taxable' : 'Non-taxable'}</Badge>
                                        </div>
                                    </div>
                                    <p className="font-mono font-semibold">{money(item.amount)}</p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">No items</p>
                    )}
                </div>

                <Separator />

                <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">Subtotal</span>
                        <span className="font-mono">{money(estimate.subtotal)}</span>
                    </div>
                    {Number(estimate.discount_amount || 0) > 0 && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Discount</span>
                            <span className="font-mono text-red-600">-{money(estimate.discount_amount)}</span>
                        </div>
                    )}
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">Tax</span>
                        <span className="font-mono">{money(estimate.tax_amount)}</span>
                    </div>
                    <div className="flex justify-between border-t pt-1 font-semibold">
                        <span>Total</span>
                        <span className="font-mono">{money(estimate.total)}</span>
                    </div>
                </div>

                <div className="grid gap-1 text-sm">
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">Require signature</span>
                        <span>{estimate.signature_required ? 'Yes' : 'No'}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">Deposit required</span>
                        <span>No</span>
                    </div>
                    {estimate.job_id && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Linked Job</span>
                            <span>{estimate.job_number || `#${estimate.job_id}`}</span>
                        </div>
                    )}
                </div>

                <Separator />

                <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Dates</p>
                    <div className="space-y-1 text-sm">
                        <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{fmtDate(estimate.created_at)}</span></div>
                        {estimate.sent_at && <div className="flex justify-between"><span className="text-muted-foreground">Sent</span><span>{fmtDateTime(estimate.sent_at)}</span></div>}
                        {estimate.accepted_at && <div className="flex justify-between"><span className="text-muted-foreground">Approved</span><span>{fmtDateTime(estimate.accepted_at)}</span></div>}
                        {estimate.declined_at && <div className="flex justify-between"><span className="text-muted-foreground">Declined</span><span>{fmtDateTime(estimate.declined_at)}</span></div>}
                        {estimate.archived_at && <div className="flex justify-between"><span className="text-muted-foreground">Archived</span><span>{fmtDateTime(estimate.archived_at)}</span></div>}
                    </div>
                </div>

                <Separator />

                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                        <Eye className="mr-1 size-3.5" />Preview
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => window.open(`/api/estimates/${estimate.id}/pdf`, '_blank', 'noopener,noreferrer')}>
                        <FileText className="mr-1 size-3.5" />PDF
                    </Button>
                    {!archived ? (
                        <>
                            <Button variant="outline" size="sm" onClick={onEdit}>
                                <Pencil className="mr-1 size-3.5" />Edit
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setSendOpen(true)}>
                                <Send className="mr-1 size-3.5" />Send
                            </Button>
                            {estimate.status !== 'approved' && (
                                <Button variant="outline" size="sm" onClick={onApprove} disabled={!hasItems}>
                                    <Check className="mr-1 size-3.5" />Approved
                                </Button>
                            )}
                            {estimate.status !== 'declined' && (
                                <Button variant="outline" size="sm" onClick={() => setDeclineOpen(true)}>
                                    <XCircle className="mr-1 size-3.5" />Decline
                                </Button>
                            )}
                            {estimate.status === 'approved' && (
                                <Button variant="outline" size="sm" onClick={handleConvertToInvoice} disabled={converting}>
                                    <FileText className="mr-1 size-3.5" />{converting ? 'Creating...' : 'Create Invoice'}
                                </Button>
                            )}
                            {!estimate.job_id && (
                                <Button variant="outline" size="sm" onClick={() => {
                                    const jobId = prompt('Enter Job ID to link:');
                                    if (jobId && !Number.isNaN(Number(jobId))) onLinkJob(Number(jobId));
                                }}>
                                    <Link2 className="mr-1 size-3.5" />Link Job
                                </Button>
                            )}
                            <Button variant="outline" size="sm" onClick={onArchive}>
                                <Archive className="mr-1 size-3.5" />Archive
                            </Button>
                        </>
                    ) : (
                        <Button variant="outline" size="sm" onClick={onRestore}>
                            <RotateCcw className="mr-1 size-3.5" />Restore to draft
                        </Button>
                    )}
                </div>

                {events.length > 0 && (
                    <>
                        <Separator />
                        <div>
                            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">History</p>
                            <div className="space-y-2">
                                {events.map(evt => (
                                    <div key={evt.id} className="flex items-start gap-2 text-xs">
                                        <Clock className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                                        <div>
                                            <span className="font-medium capitalize">{evt.event_type.replace(/_/g, ' ')}</span>
                                            <p className="text-muted-foreground">{fmtDateTime(evt.created_at)}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </div>

            <EstimatePreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} estimate={estimate} />
            <EstimateSendDialog
                open={sendOpen}
                onOpenChange={setSendOpen}
                estimateId={estimate.id}
                contactEmail={estimate.contact_email || ''}
                onSend={async data => {
                    await onSend(data);
                }}
            />

            <Dialog open={declineOpen} onOpenChange={setDeclineOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader><DialogTitle>Decline estimate</DialogTitle></DialogHeader>
                    <Textarea value={declineReason} onChange={event => setDeclineReason(event.target.value)} rows={4} placeholder="Reason or comment" />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeclineOpen(false)}>Cancel</Button>
                        <Button onClick={submitDecline} disabled={!declineReason.trim()}>Decline</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
