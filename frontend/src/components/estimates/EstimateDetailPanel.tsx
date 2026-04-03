import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { useState } from 'react';
import { X, Send, Check, XCircle, Link2, Pencil, Trash2, Loader2, Clock, FileText } from 'lucide-react';
import type { Estimate, EstimateEvent } from '../../services/estimatesApi';
import { convertEstimateToInvoice } from '../../services/estimatesApi';
import { toast } from 'sonner';

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary',
    sent: 'outline',
    viewed: 'outline',
    accepted: 'default',
    declined: 'destructive',
    expired: 'secondary',
    converted: 'default',
};

function money(value: string | number | null | undefined): string {
    if (value == null) return '$0.00';
    return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(value: string | null): string {
    if (!value) return '-';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(value: string | null): string {
    if (!value) return '-';
    return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    estimate: Estimate;
    events: EstimateEvent[];
    loading: boolean;
    onClose: () => void;
    onEdit: () => void;
    onSend: () => void;
    onApprove: () => void;
    onDecline: () => void;
    onDelete: () => void;
    onLinkJob: (jobId: number) => void;
    onInvoiceCreated?: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function EstimateDetailPanel({ estimate, events, loading, onClose, onEdit, onSend, onApprove, onDecline, onDelete, onLinkJob, onInvoiceCreated }: Props) {
    const [converting, setConverting] = useState(false);

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

    if (loading) {
        return (
            <div className="h-full flex items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const isDraft = estimate.status === 'draft';
    const isSent = estimate.status === 'sent' || estimate.status === 'viewed';
    const isAccepted = estimate.status === 'accepted';

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b">
                <div className="flex items-center gap-2">
                    <span className="font-semibold font-mono text-sm">{estimate.estimate_number}</span>
                    <Badge variant={STATUS_VARIANT[estimate.status] || 'secondary'} className="capitalize">
                        {estimate.status}
                    </Badge>
                </div>
                <Button variant="ghost" size="sm" className="size-7 p-0 md:hidden" onClick={onClose}>
                    <X className="size-4" />
                </Button>
            </div>

            <div>
                <div className="p-4 space-y-4">
                    {/* Title */}
                    {estimate.title && (
                        <div>
                            <h3 className="font-medium">{estimate.title}</h3>
                        </div>
                    )}

                    {/* Customer */}
                    <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Customer</p>
                        <p className="text-sm">{estimate.contact_name || 'No customer linked'}</p>
                    </div>

                    <Separator />

                    {/* Items */}
                    {estimate.items && estimate.items.length > 0 && (
                        <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Line Items</p>
                            <div className="space-y-1">
                                {estimate.items.map(item => (
                                    <div key={item.id} className="flex items-start justify-between text-sm py-1">
                                        <div className="flex-1 min-w-0">
                                            <p className="font-medium truncate">{item.name}</p>
                                            {item.description && (
                                                <p className="text-xs text-muted-foreground truncate">{item.description}</p>
                                            )}
                                            <p className="text-xs text-muted-foreground">
                                                {Number(item.quantity)} {item.unit || ''} x {money(item.unit_price)}
                                            </p>
                                        </div>
                                        <span className="font-mono text-sm ml-2 shrink-0">{money(item.amount)}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <Separator />

                    {/* Totals */}
                    <div className="space-y-1 text-sm">
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Subtotal</span>
                            <span className="font-mono">{money(estimate.subtotal)}</span>
                        </div>
                        {Number(estimate.discount_amount) > 0 && (
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Discount</span>
                                <span className="font-mono text-red-600">-{money(estimate.discount_amount)}</span>
                            </div>
                        )}
                        {Number(estimate.tax_amount) > 0 && (
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Tax ({Number(estimate.tax_rate)}%)</span>
                                <span className="font-mono">{money(estimate.tax_amount)}</span>
                            </div>
                        )}
                        <div className="flex justify-between font-semibold pt-1 border-t">
                            <span>Total</span>
                            <span className="font-mono">{money(estimate.total)}</span>
                        </div>
                    </div>

                    {/* Deposit */}
                    {estimate.deposit_required && (
                        <>
                            <Separator />
                            <div>
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Deposit</p>
                                <p className="text-sm">
                                    {estimate.deposit_type === 'percentage'
                                        ? `${Number(estimate.deposit_value)}% required`
                                        : `${money(estimate.deposit_value)} required`
                                    }
                                    {Number(estimate.deposit_paid) > 0 && (
                                        <span className="text-green-600 ml-1">({money(estimate.deposit_paid)} paid)</span>
                                    )}
                                </p>
                            </div>
                        </>
                    )}

                    {/* Notes */}
                    {estimate.notes && (
                        <>
                            <Separator />
                            <div>
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Notes</p>
                                <p className="text-sm whitespace-pre-wrap">{estimate.notes}</p>
                            </div>
                        </>
                    )}

                    {estimate.internal_note && (
                        <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Internal Note</p>
                            <p className="text-sm whitespace-pre-wrap text-muted-foreground">{estimate.internal_note}</p>
                        </div>
                    )}

                    <Separator />

                    {/* Dates */}
                    <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Dates</p>
                        <div className="space-y-1 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Created</span>
                                <span>{fmtDate(estimate.created_at)}</span>
                            </div>
                            {estimate.sent_at && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Sent</span>
                                    <span>{fmtDateTime(estimate.sent_at)}</span>
                                </div>
                            )}
                            {estimate.accepted_at && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Accepted</span>
                                    <span>{fmtDateTime(estimate.accepted_at)}</span>
                                </div>
                            )}
                            {estimate.declined_at && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Declined</span>
                                    <span>{fmtDateTime(estimate.declined_at)}</span>
                                </div>
                            )}
                            {estimate.valid_until && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Valid Until</span>
                                    <span>{fmtDate(estimate.valid_until)}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Linked job */}
                    {estimate.job_id && (
                        <>
                            <Separator />
                            <div>
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Linked Job</p>
                                <p className="text-sm">Job #{estimate.job_id}</p>
                            </div>
                        </>
                    )}

                    <Separator />

                    {/* Action buttons */}
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={onEdit}>
                            <Pencil className="size-3.5 mr-1" />Edit
                        </Button>
                        {isDraft && (
                            <Button variant="outline" size="sm" onClick={onSend}>
                                <Send className="size-3.5 mr-1" />Send
                            </Button>
                        )}
                        {isSent && (
                            <>
                                <Button variant="outline" size="sm" onClick={onApprove}>
                                    <Check className="size-3.5 mr-1" />Approve
                                </Button>
                                <Button variant="outline" size="sm" onClick={onDecline}>
                                    <XCircle className="size-3.5 mr-1" />Decline
                                </Button>
                            </>
                        )}
                        {isAccepted && (
                            <Button variant="outline" size="sm" onClick={handleConvertToInvoice} disabled={converting}>
                                <FileText className="size-3.5 mr-1" />{converting ? 'Creating...' : 'Create Invoice'}
                            </Button>
                        )}
                        {!estimate.job_id && (
                            <Button variant="outline" size="sm" onClick={() => {
                                const jobId = prompt('Enter Job ID to link:');
                                if (jobId && !isNaN(Number(jobId))) onLinkJob(Number(jobId));
                            }}>
                                <Link2 className="size-3.5 mr-1" />Link Job
                            </Button>
                        )}
                        <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700" onClick={onDelete}>
                            <Trash2 className="size-3.5 mr-1" />Delete
                        </Button>
                    </div>

                    {/* Events / History */}
                    {events.length > 0 && (
                        <>
                            <Separator />
                            <div>
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">History</p>
                                <div className="space-y-2">
                                    {events.map(evt => (
                                        <div key={evt.id} className="flex items-start gap-2 text-xs">
                                            <Clock className="size-3 mt-0.5 text-muted-foreground shrink-0" />
                                            <div>
                                                <span className="font-medium capitalize">{evt.event_type.replace(/_/g, ' ')}</span>
                                                {evt.actor_id && <span className="text-muted-foreground"> by {evt.actor_id}</span>}
                                                <p className="text-muted-foreground">{fmtDateTime(evt.created_at)}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
