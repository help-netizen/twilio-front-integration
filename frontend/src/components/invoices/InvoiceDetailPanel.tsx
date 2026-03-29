import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { ScrollArea } from '../ui/scroll-area';
import { X, Send, Pencil, Trash2, Loader2, Clock, Ban, CreditCard, RefreshCw } from 'lucide-react';
import type { Invoice, InvoiceEvent, RecordPaymentData } from '../../services/invoicesApi';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    invoice: Invoice;
    events: InvoiceEvent[];
    loading: boolean;
    onClose: () => void;
    onEdit: () => void;
    onSend: () => void;
    onVoid: () => void;
    onRecordPayment: (data: RecordPaymentData) => void;
    onSyncEstimate: () => void;
    onDelete: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function InvoiceDetailPanel({ invoice, events, loading, onClose, onEdit, onSend, onVoid, onRecordPayment, onSyncEstimate, onDelete }: Props) {
    if (loading) {
        return (
            <div className="w-96 border-l flex items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const isDraft = invoice.status === 'draft';
    const canRecordPayment = invoice.status === 'sent' || invoice.status === 'partial' || invoice.status === 'overdue';
    const canVoid = invoice.status !== 'void' && invoice.status !== 'refunded';
    const totalNum = Number(invoice.total) || 0;
    const paidNum = Number(invoice.amount_paid) || 0;
    const paymentProgress = totalNum > 0 ? Math.min((paidNum / totalNum) * 100, 100) : 0;

    return (
        <div className="w-96 border-l flex flex-col bg-background">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b">
                <div className="flex items-center gap-2">
                    <span className="font-semibold font-mono text-sm">{invoice.invoice_number}</span>
                    <Badge variant={STATUS_VARIANT[invoice.status] || 'secondary'} className="capitalize">
                        {invoice.status}
                    </Badge>
                </div>
                <Button variant="ghost" size="sm" className="size-7 p-0" onClick={onClose}>
                    <X className="size-4" />
                </Button>
            </div>

            <ScrollArea className="flex-1">
                <div className="p-4 space-y-4">
                    {/* Title */}
                    {invoice.title && (
                        <div>
                            <h3 className="font-medium">{invoice.title}</h3>
                        </div>
                    )}

                    {/* Customer */}
                    <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Customer</p>
                        <p className="text-sm">{invoice.contact_name || 'No customer linked'}</p>
                    </div>

                    {/* Linked estimate */}
                    {invoice.estimate_id && (
                        <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Linked Estimate</p>
                            <p className="text-sm">Estimate #{invoice.estimate_id}</p>
                        </div>
                    )}

                    {/* Linked job / lead */}
                    {invoice.job_id && (
                        <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Linked Job</p>
                            <p className="text-sm">Job #{invoice.job_id}</p>
                        </div>
                    )}
                    {invoice.lead_id && (
                        <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Linked Lead</p>
                            <p className="text-sm">Lead #{invoice.lead_id}</p>
                        </div>
                    )}

                    <Separator />

                    {/* Items */}
                    {invoice.items && invoice.items.length > 0 && (
                        <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Line Items</p>
                            <div className="space-y-1">
                                {invoice.items.map(item => (
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
                            <span className="font-mono">{money(invoice.subtotal)}</span>
                        </div>
                        {Number(invoice.discount_amount) > 0 && (
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Discount</span>
                                <span className="font-mono text-red-600">-{money(invoice.discount_amount)}</span>
                            </div>
                        )}
                        {Number(invoice.tax_amount) > 0 && (
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Tax ({Number(invoice.tax_rate)}%)</span>
                                <span className="font-mono">{money(invoice.tax_amount)}</span>
                            </div>
                        )}
                        <div className="flex justify-between font-semibold pt-1 border-t">
                            <span>Total</span>
                            <span className="font-mono">{money(invoice.total)}</span>
                        </div>
                    </div>

                    <Separator />

                    {/* Payment info */}
                    <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Payment</p>
                        <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Amount Paid</span>
                                <span className="font-mono text-green-600">{money(invoice.amount_paid)}</span>
                            </div>
                            <div className="flex justify-between text-sm font-semibold">
                                <span>Balance Due</span>
                                <span className="font-mono">{money(invoice.balance_due)}</span>
                            </div>
                            {/* Progress bar */}
                            <div className="w-full bg-muted rounded-full h-2">
                                <div
                                    className="bg-green-500 h-2 rounded-full transition-all"
                                    style={{ width: `${paymentProgress}%` }}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground text-center">
                                {paymentProgress.toFixed(0)}% paid
                            </p>
                        </div>
                    </div>

                    {/* Notes */}
                    {invoice.notes && (
                        <>
                            <Separator />
                            <div>
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Notes</p>
                                <p className="text-sm whitespace-pre-wrap">{invoice.notes}</p>
                            </div>
                        </>
                    )}

                    {invoice.internal_note && (
                        <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Internal Note</p>
                            <p className="text-sm whitespace-pre-wrap text-muted-foreground">{invoice.internal_note}</p>
                        </div>
                    )}

                    <Separator />

                    {/* Dates */}
                    <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Dates</p>
                        <div className="space-y-1 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Created</span>
                                <span>{fmtDate(invoice.created_at)}</span>
                            </div>
                            {invoice.sent_at && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Sent</span>
                                    <span>{fmtDateTime(invoice.sent_at)}</span>
                                </div>
                            )}
                            {invoice.due_date && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Due Date</span>
                                    <span>{fmtDate(invoice.due_date)}</span>
                                </div>
                            )}
                            {invoice.paid_at && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Paid</span>
                                    <span>{fmtDateTime(invoice.paid_at)}</span>
                                </div>
                            )}
                            {invoice.voided_at && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Voided</span>
                                    <span>{fmtDateTime(invoice.voided_at)}</span>
                                </div>
                            )}
                        </div>
                    </div>

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
                        {canVoid && (
                            <Button variant="outline" size="sm" onClick={onVoid}>
                                <Ban className="size-3.5 mr-1" />Void
                            </Button>
                        )}
                        {canRecordPayment && (
                            <Button variant="outline" size="sm" onClick={() => {
                                const amount = prompt('Enter payment amount:');
                                if (amount && !isNaN(Number(amount))) {
                                    onRecordPayment({ amount });
                                }
                            }}>
                                <CreditCard className="size-3.5 mr-1" />Record Payment
                            </Button>
                        )}
                        {invoice.estimate_id && (
                            <Button variant="outline" size="sm" onClick={onSyncEstimate}>
                                <RefreshCw className="size-3.5 mr-1" />Sync from Estimate
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
            </ScrollArea>
        </div>
    );
}
