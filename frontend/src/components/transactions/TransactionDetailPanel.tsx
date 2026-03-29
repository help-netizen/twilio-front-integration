import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { ScrollArea } from '../ui/scroll-area';
import { X, Undo2, Ban, Send, Receipt, Loader2 } from 'lucide-react';
import type { PaymentTransaction, PaymentReceipt, SendReceiptData, RefundData } from '../../services/paymentsCanonicalApi';
import { RefundDialog } from './RefundDialog';

// -- Helpers ------------------------------------------------------------------

const TYPE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    payment: 'default',
    refund: 'destructive',
    adjustment: 'secondary',
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    pending: 'outline',
    processing: 'outline',
    completed: 'default',
    failed: 'destructive',
    refunded: 'secondary',
    voided: 'secondary',
};

const METHOD_LABELS: Record<string, string> = {
    credit_card: 'Credit Card',
    ach: 'ACH',
    check: 'Check',
    cash: 'Cash',
    other: 'Other',
    zenbooker_sync: 'Zenbooker',
};

function money(value: string | number | null | undefined): string {
    if (value == null) return '$0.00';
    return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateTime(value: string | null): string {
    if (!value) return '-';
    return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// -- Props --------------------------------------------------------------------

interface Props {
    transaction: PaymentTransaction;
    receipt: PaymentReceipt | null;
    onClose: () => void;
    onRefund: (id: number, data: RefundData) => Promise<any>;
    onVoid: (id: number) => Promise<any>;
    onSendReceipt: (id: number, data: SendReceiptData) => Promise<any>;
}

// -- Component ----------------------------------------------------------------

export function TransactionDetailPanel({ transaction, receipt, onClose, onRefund, onVoid, onSendReceipt }: Props) {
    const [refundOpen, setRefundOpen] = useState(false);
    const [sendingReceipt, setSendingReceipt] = useState(false);
    const [receiptChannel, setReceiptChannel] = useState<'email' | 'sms'>('email');
    const [receiptRecipient, setReceiptRecipient] = useState('');
    const [showReceiptForm, setShowReceiptForm] = useState(false);
    const [voiding, setVoiding] = useState(false);

    const canRefund = transaction.status === 'completed' && transaction.transaction_type === 'payment';
    const canVoid = transaction.status === 'pending' || transaction.status === 'processing';
    const canSendReceipt = transaction.status === 'completed';

    const handleVoid = async () => {
        setVoiding(true);
        try {
            await onVoid(transaction.id);
        } catch {
            // toast upstream
        } finally {
            setVoiding(false);
        }
    };

    const handleSendReceipt = async () => {
        if (!receiptRecipient.trim()) return;
        setSendingReceipt(true);
        try {
            await onSendReceipt(transaction.id, { channel: receiptChannel, recipient: receiptRecipient.trim() });
            setShowReceiptForm(false);
            setReceiptRecipient('');
        } catch {
            // toast upstream
        } finally {
            setSendingReceipt(false);
        }
    };

    return (
        <div className="w-96 border-l flex flex-col overflow-hidden">
            {/* Header */}
            <div className="border-b p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Transaction #{transaction.id}</span>
                    <Badge variant={TYPE_VARIANT[transaction.transaction_type] || 'secondary'} className="capitalize">
                        {transaction.transaction_type}
                    </Badge>
                    <Badge variant={STATUS_VARIANT[transaction.status] || 'secondary'} className="capitalize">
                        {transaction.status}
                    </Badge>
                </div>
                <Button variant="ghost" size="sm" className="size-7 p-0" onClick={onClose}>
                    <X className="size-4" />
                </Button>
            </div>

            <ScrollArea className="flex-1">
                <div className="p-4 space-y-4">
                    {/* Amount */}
                    <div>
                        <p className="text-3xl font-bold">{money(transaction.amount)}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                            {transaction.currency.toUpperCase()} via {METHOD_LABELS[transaction.payment_method] || transaction.payment_method}
                        </p>
                    </div>

                    <Separator />

                    {/* Linked Entities */}
                    <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Linked Entities</h4>
                        {transaction.invoice_id && (
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Invoice</span>
                                <span className="font-mono">#{transaction.invoice_id}</span>
                            </div>
                        )}
                        {transaction.contact_id && (
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Contact</span>
                                <span className="font-mono">#{transaction.contact_id}</span>
                            </div>
                        )}
                        {transaction.job_id && (
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Job</span>
                                <span className="font-mono">#{transaction.job_id}</span>
                            </div>
                        )}
                        {transaction.estimate_id && (
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Estimate</span>
                                <span className="font-mono">#{transaction.estimate_id}</span>
                            </div>
                        )}
                        {!transaction.invoice_id && !transaction.contact_id && !transaction.job_id && !transaction.estimate_id && (
                            <p className="text-sm text-muted-foreground">No linked entities</p>
                        )}
                    </div>

                    <Separator />

                    {/* Details */}
                    <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Details</h4>
                        {transaction.reference_number && (
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Reference #</span>
                                <span className="font-mono">{transaction.reference_number}</span>
                            </div>
                        )}
                        {transaction.external_id && (
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">External ID</span>
                                <span className="font-mono text-xs">{transaction.external_id}</span>
                            </div>
                        )}
                        {transaction.external_source && (
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Source</span>
                                <span>{transaction.external_source}</span>
                            </div>
                        )}
                        {transaction.memo && (
                            <div className="text-sm">
                                <span className="text-muted-foreground block mb-1">Memo</span>
                                <p className="text-sm bg-muted/50 rounded p-2">{transaction.memo}</p>
                            </div>
                        )}
                        {transaction.recorded_by && (
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Recorded by</span>
                                <span>{transaction.recorded_by}</span>
                            </div>
                        )}
                    </div>

                    <Separator />

                    {/* Dates */}
                    <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Dates</h4>
                        <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Created</span>
                            <span>{fmtDateTime(transaction.created_at)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Processed</span>
                            <span>{fmtDateTime(transaction.processed_at)}</span>
                        </div>
                    </div>

                    {/* Receipt Info */}
                    {receipt && (
                        <>
                            <Separator />
                            <div className="space-y-2">
                                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Receipt</h4>
                                <div className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">Receipt #</span>
                                    <span className="font-mono">{receipt.receipt_number}</span>
                                </div>
                                {receipt.sent_to_email && (
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">Sent to</span>
                                        <span>{receipt.sent_to_email}</span>
                                    </div>
                                )}
                                {receipt.sent_to_phone && (
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">Sent to</span>
                                        <span>{receipt.sent_to_phone}</span>
                                    </div>
                                )}
                                {receipt.sent_at && (
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">Sent at</span>
                                        <span>{fmtDateTime(receipt.sent_at)}</span>
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    <Separator />

                    {/* Actions */}
                    <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Actions</h4>
                        <div className="flex flex-wrap gap-2">
                            {canRefund && (
                                <Button variant="outline" size="sm" onClick={() => setRefundOpen(true)}>
                                    <Undo2 className="size-4 mr-1" />Refund
                                </Button>
                            )}
                            {canVoid && (
                                <Button variant="outline" size="sm" onClick={handleVoid} disabled={voiding}>
                                    <Ban className="size-4 mr-1" />{voiding ? 'Voiding...' : 'Void'}
                                </Button>
                            )}
                            {canSendReceipt && (
                                <Button variant="outline" size="sm" onClick={() => setShowReceiptForm(!showReceiptForm)}>
                                    <Receipt className="size-4 mr-1" />Send Receipt
                                </Button>
                            )}
                        </div>

                        {/* Send receipt inline form */}
                        {showReceiptForm && (
                            <div className="border rounded p-3 space-y-2 mt-2">
                                <div className="flex gap-2">
                                    <Button
                                        type="button"
                                        variant={receiptChannel === 'email' ? 'default' : 'outline'}
                                        size="sm"
                                        onClick={() => setReceiptChannel('email')}
                                    >
                                        Email
                                    </Button>
                                    <Button
                                        type="button"
                                        variant={receiptChannel === 'sms' ? 'default' : 'outline'}
                                        size="sm"
                                        onClick={() => setReceiptChannel('sms')}
                                    >
                                        SMS
                                    </Button>
                                </div>
                                <input
                                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    placeholder={receiptChannel === 'email' ? 'customer@example.com' : '+1234567890'}
                                    value={receiptRecipient}
                                    onChange={e => setReceiptRecipient(e.target.value)}
                                />
                                <Button size="sm" onClick={handleSendReceipt} disabled={sendingReceipt || !receiptRecipient.trim()}>
                                    <Send className="size-4 mr-1" />{sendingReceipt ? 'Sending...' : 'Send'}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            </ScrollArea>

            {/* Refund dialog */}
            <RefundDialog
                open={refundOpen}
                onOpenChange={setRefundOpen}
                transaction={transaction}
                onRefund={data => onRefund(transaction.id, data)}
            />
        </div>
    );
}
