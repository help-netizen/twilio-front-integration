import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Send } from 'lucide-react';
import type { InvoiceSendData } from '../../services/invoicesApi';
import { ensureInvoicePublicLink } from '../../services/invoicesApi';
import { useAuth } from '../../auth/AuthProvider';

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoiceId: number;
    contactEmail?: string;
    contactPhone?: string;
    /** Used in the default message body — e.g. "INVOICE L-53-5". */
    invoiceNumber?: string;
    /** Used to address the customer in the default message body. */
    contactName?: string;
    /** Remaining balance. Drives the "please pay" vs. "thanks for the payment" tone. */
    balanceDue?: number | string;
    /** Invoice total — included in the friendly message body. */
    total?: number | string;
    /** Due date — appended to the message when present and the invoice is unpaid. */
    dueDate?: string | null;
    onSend: (data: InvoiceSendData) => Promise<any>;
}

function firstName(fullName?: string): string {
    if (!fullName) return 'there';
    const first = fullName.trim().split(/\s+/)[0];
    return first || 'there';
}

function fmtMoney(value: number | string | null | undefined): string {
    const n = Number(value || 0);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(value: string | null | undefined): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildDefaultMessage(
    channel: 'email' | 'sms',
    opts: {
        invoiceNumber: string;
        name: string;
        url: string;
        balanceDue: number;
        total: number;
        dueDate: string | null;
        /** First name (or full name) of the currently logged-in user — appended after "Thanks,". */
        signOff: string;
    }
): string {
    const { invoiceNumber, name, url, balanceDue, total, dueDate, signOff } = opts;
    // Numbers like "INVOICE L-53-5" already start with the word "INVOICE"; trim the
    // prefix so "invoice INVOICE L-53-5" doesn't read doubled in the message body.
    const shortNumber = invoiceNumber ? invoiceNumber.replace(/^INVOICE\s+/i, '') : '';
    const label = shortNumber || 'your invoice';
    const isPaid = balanceDue <= 0 && total > 0;
    const dueStr = fmtDate(dueDate);
    const signature = signOff ? `\n${signOff}` : '';

    if (channel === 'sms') {
        if (isPaid) {
            return url
                ? `Hi ${name}! Thanks so much for your payment on invoice ${label}. Here's your receipt: ${url} 🙌`
                : `Hi ${name}! Thanks so much for your payment on invoice ${label} 🙌`;
        }
        const amountStr = fmtMoney(balanceDue || total);
        return url
            ? `Hi ${name}! Here's your invoice ${label} for ${amountStr}. You can view & pay it anytime: ${url} — let us know if anything looks off. Thanks!`
            : `Hi ${name}! Your invoice ${label} for ${amountStr} is ready. Thanks!`;
    }

    // Email — longer, friendly, with a payment CTA when unpaid.
    if (isPaid) {
        return [
            `Hi ${name},`,
            '',
            `Thank you so much — your payment on invoice ${label} has been received! 🙌`,
            '',
            url ? `Your receipt is saved here whenever you need it:\n${url}` : null,
            '',
            'It was a pleasure working with you. If anything else comes up, just reply to this email — we are always happy to help.',
            '',
            `Warm regards,${signature}`,
        ].filter(s => s !== null).join('\n');
    }
    const amount = fmtMoney(balanceDue || total);
    const dueLine = dueStr ? `The balance of ${amount} is due by ${dueStr}.` : `The balance due is ${amount}.`;
    return [
        `Hi ${name},`,
        '',
        `Thanks so much for letting us take care of the job — here's invoice ${label} for the work we wrapped up. ${dueLine}`,
        '',
        url ? `Whenever you're ready, you can view and pay it online here:\n${url}` : null,
        '',
        'No rush at all — if anything looks off or you have a question, just hit reply and we will sort it out.',
        '',
        `Thanks,${signature}`,
    ].filter(s => s !== null).join('\n');
}

// ── Component ────────────────────────────────────────────────────────────────

export function InvoiceSendDialog({ open, onOpenChange, invoiceId, contactEmail, contactPhone, invoiceNumber, contactName, balanceDue, total, dueDate, onSend }: Props) {
    const { user } = useAuth();
    const operatorSignOff = firstName(user?.name);

    const [channel, setChannel] = useState<'email' | 'sms'>('email');
    const [emailRecipient, setEmailRecipient] = useState(contactEmail || '');
    const [phoneRecipient, setPhoneRecipient] = useState(contactPhone || '');
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);
    const [publicUrl, setPublicUrl] = useState<string>('');
    const [userEditedMessage, setUserEditedMessage] = useState(false);

    // Re-sync prefills when the dialog opens (or when the underlying contact changes).
    useEffect(() => {
        if (open) {
            setEmailRecipient(contactEmail || '');
            setPhoneRecipient(contactPhone || '');
            setUserEditedMessage(false);
        }
    }, [open, contactEmail, contactPhone]);

    // Mint (or fetch) a tokenized public link when the dialog opens so the default
    // message body can reference it. Idempotent on the backend.
    useEffect(() => {
        if (!open || !invoiceId) return;
        let cancelled = false;
        ensureInvoicePublicLink(invoiceId)
            .then(({ url }) => { if (!cancelled) setPublicUrl(url); })
            .catch(() => { if (!cancelled) setPublicUrl(''); });
        return () => { cancelled = true; };
    }, [open, invoiceId]);

    // Re-build the default message whenever the channel, link, or contact name changes
    // — unless the user has already edited the textarea (we don't want to clobber their typing).
    useEffect(() => {
        if (!open || userEditedMessage) return;
        setMessage(buildDefaultMessage(channel, {
            invoiceNumber: invoiceNumber || '',
            name: firstName(contactName),
            url: publicUrl,
            balanceDue: Number(balanceDue) || 0,
            total: Number(total) || 0,
            dueDate: dueDate || null,
            signOff: operatorSignOff,
        }));
    }, [open, channel, publicUrl, invoiceNumber, contactName, balanceDue, total, dueDate, operatorSignOff, userEditedMessage]);

    const recipient = channel === 'email' ? emailRecipient : phoneRecipient;
    const setRecipient = (v: string) => {
        if (channel === 'email') setEmailRecipient(v);
        else setPhoneRecipient(v);
    };

    const canSubmit = recipient.trim().length > 0 && message.trim().length > 0;

    const handleSend = async () => {
        if (!canSubmit) return;
        setSending(true);
        try {
            await onSend({ channel, recipient: recipient.trim(), message: message.trim() });
            onOpenChange(false);
        } catch {
            // error toast handled upstream
        } finally {
            setSending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Send Invoice</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    {/* Channel */}
                    <div>
                        <Label className="text-xs mb-2 block">Channel</Label>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant={channel === 'email' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setChannel('email')}
                            >
                                Email
                            </Button>
                            <Button
                                type="button"
                                variant={channel === 'sms' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setChannel('sms')}
                            >
                                SMS
                            </Button>
                        </div>
                    </div>

                    {/* Recipient */}
                    <div>
                        <Label className="text-xs">
                            {channel === 'email' ? 'Email Address' : 'Phone Number'}
                        </Label>
                        <Input
                            value={recipient}
                            onChange={e => setRecipient(e.target.value)}
                            placeholder={channel === 'email' ? 'customer@example.com' : '+1234567890'}
                            type={channel === 'email' ? 'email' : 'tel'}
                        />
                    </div>

                    {/* Message — required */}
                    <div>
                        <Label className="text-xs">Message <span className="text-red-600">*</span></Label>
                        <Textarea
                            value={message}
                            onChange={e => { setMessage(e.target.value); setUserEditedMessage(true); }}
                            placeholder="Add a personal message..."
                            rows={5}
                        />
                        {!message.trim() && (
                            <p className="mt-1 text-xs text-red-600">Message is required.</p>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
                        Cancel
                    </Button>
                    <Button onClick={handleSend} disabled={sending || !canSubmit}>
                        <Send className="mr-1 size-3.5" />
                        {sending ? 'Sending...' : 'Send Invoice'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
