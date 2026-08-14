import { useEffect, useState } from 'react';
import { Loader2, Mail, MessageSquare, Send } from 'lucide-react';
import { useAuth } from '../../auth/AuthProvider';
import {
    ensureInvoicePublicLink,
    type Invoice,
    type InvoiceSendData,
} from '../../services/invoicesApi';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FloatingField } from '../ui/floating-field';
import { PhoneInput, isValidUSPhone, toE164 } from '../ui/PhoneInput';
import { formatCompanyTime, useCompanyTime } from '../../lib/companyTime';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** One object owns the ID and every prefill, preventing cross-invoice recipient pairing. */
    invoice: Invoice;
    onSend: (invoiceId: number, data: InvoiceSendData) => Promise<unknown>;
}

export function getInvoiceSendPrefill(invoice: Invoice) {
    return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        contactName: invoice.contact_name || '',
        emailRecipient: invoice.contact_email || '',
        phoneRecipient: invoice.contact_phone || '',
        balanceDue: Number(invoice.balance_due) || 0,
        total: Number(invoice.total) || 0,
        dueDate: invoice.due_date,
        channel: invoice.contact_email ? 'email' as const : invoice.contact_phone ? 'sms' as const : 'email' as const,
        includePaymentLink: Number(invoice.balance_due) > 0,
    };
}

function firstName(fullName?: string): string {
    if (!fullName) return 'there';
    return fullName.trim().split(/\s+/)[0] || 'there';
}

function fmtMoney(value: number | string | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function fmtDate(value: string | null | undefined, timeZone?: string): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return formatCompanyTime(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : date, { month: 'short', day: 'numeric', year: 'numeric' }, timeZone);
}

export function buildDefaultInvoiceMessage(
    channel: 'email' | 'sms',
    options: {
        invoiceNumber: string;
        name: string;
        url: string;
        balanceDue: number;
        total: number;
        dueDate: string | null;
        signOff: string;
        timeZone?: string;
    },
): string {
    const { invoiceNumber, name, url, balanceDue, total, dueDate, signOff, timeZone } = options;
    const shortNumber = invoiceNumber ? invoiceNumber.replace(/^INVOICE\s+/i, '') : '';
    const label = shortNumber || 'your invoice';
    const isPaid = balanceDue <= 0 && total > 0;
    const due = fmtDate(dueDate, timeZone);
    const signature = signOff ? `\n${signOff}` : '';

    if (channel === 'sms') {
        if (isPaid) {
            return url
                ? `Hi ${name}! Thanks for your payment on invoice ${label}. Here's your receipt: ${url}`
                : `Hi ${name}! Thanks for your payment on invoice ${label}.`;
        }
        const amount = fmtMoney(balanceDue || total);
        return url
            ? `Hi ${name}! Here's invoice ${label} for ${amount}. View and pay securely: ${url}`
            : `Hi ${name}! Invoice ${label} for ${amount} is ready.`;
    }

    if (isPaid) {
        return [
            `Hi ${name},`,
            '',
            `Thank you — your payment on invoice ${label} has been received.`,
            '',
            url ? `Your receipt is available here:\n${url}` : null,
            '',
            `Thanks,${signature}`,
        ].filter(line => line !== null).join('\n');
    }

    const amount = fmtMoney(balanceDue || total);
    const dueLine = due ? `The ${amount} balance is due by ${due}.` : `The balance due is ${amount}.`;
    return [
        `Hi ${name},`,
        '',
        `Here's invoice ${label} for the work we completed. ${dueLine}`,
        '',
        url ? `View and pay securely here:\n${url}` : null,
        '',
        'Reply if you have any questions.',
        '',
        `Thanks,${signature}`,
    ].filter(line => line !== null).join('\n');
}

export function InvoiceSendDialog({ open, onOpenChange, invoice, onSend }: Props) {
    const { user } = useAuth();
    const { timeZone } = useCompanyTime();
    const operatorSignOff = firstName(user?.name);
    const [channel, setChannel] = useState<'email' | 'sms'>('email');
    const [emailRecipient, setEmailRecipient] = useState('');
    const [phoneRecipient, setPhoneRecipient] = useState('');
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);
    const [publicUrl, setPublicUrl] = useState('');
    const [userEditedMessage, setUserEditedMessage] = useState(false);
    const [includePaymentLink, setIncludePaymentLink] = useState(false);

    // Key reset to the open cycle + invoice identity. A same-invoice refresh
    // must not erase recipient/message edits while this sheet is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!open) return;
        const prefill = getInvoiceSendPrefill(invoice);
        setChannel(prefill.channel);
        setEmailRecipient(prefill.emailRecipient);
        setPhoneRecipient(prefill.phoneRecipient);
        setUserEditedMessage(false);
        setIncludePaymentLink(prefill.includePaymentLink);
        setPublicUrl('');
    }, [invoice.id, open]);

    useEffect(() => {
        if (!open || !invoice.id) return;
        let cancelled = false;
        ensureInvoicePublicLink(invoice.id)
            .then(({ url }) => {
                if (!cancelled) setPublicUrl(url.replace('/i/', '/pay/'));
            })
            .catch(() => {
                if (!cancelled) setPublicUrl('');
            });
        return () => { cancelled = true; };
    }, [invoice.id, open]);

    useEffect(() => {
        if (!open || userEditedMessage) return;
        setMessage(buildDefaultInvoiceMessage(channel, {
            invoiceNumber: invoice.invoice_number,
            name: firstName(invoice.contact_name),
            url: includePaymentLink ? publicUrl : '',
            balanceDue: Number(invoice.balance_due) || 0,
            total: Number(invoice.total) || 0,
            dueDate: invoice.due_date,
            signOff: operatorSignOff,
            timeZone,
        }));
    }, [
        channel,
        includePaymentLink,
        invoice.balance_due,
        invoice.contact_name,
        invoice.due_date,
        invoice.invoice_number,
        invoice.total,
        open,
        operatorSignOff,
        timeZone,
        publicUrl,
        userEditedMessage,
    ]);

    const recipient = channel === 'email' ? emailRecipient.trim() : toE164(phoneRecipient);
    const recipientValid = channel === 'email'
        ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)
        : isValidUSPhone(phoneRecipient);

    const handleSend = async () => {
        if (!recipientValid || sending) return;
        setSending(true);
        try {
            await onSend(invoice.id, {
                channel,
                recipient,
                message: message.trim() || undefined,
                includePaymentLink,
            });
            onOpenChange(false);
        } finally {
            setSending(false);
        }
    };

    const actionButtons = (
        <div className="space-y-2.5">
            <Button
                type="button"
                className="h-[52px] w-full rounded-[15px] text-[16px] font-semibold"
                onClick={handleSend}
                disabled={sending || !recipientValid}
                data-testid="invoice-send-submit"
            >
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-5" />}
                {sending ? 'Sending…' : 'Send invoice'}
            </Button>
            <Button
                type="button"
                variant="outline"
                className="h-[46px] w-full rounded-[14px] text-[15px] font-semibold"
                onClick={() => onOpenChange(false)}
                disabled={sending}
            >
                Cancel
            </Button>
        </div>
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel" size="default" data-testid="invoice-send-dialog">
                <DialogPanelHeader className="max-md:hidden">
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight text-[var(--blanc-ink-1)]"
                        style={{ fontFamily: 'var(--blanc-font-heading)' }}
                    >
                        Send invoice
                    </DialogTitle>
                    <DialogDescription>
                        {invoice.invoice_number} · {fmtMoney(invoice.total)} · {invoice.contact_name || 'Customer'}
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="px-5 pb-6 pt-9 md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[520px]">
                        <div className="mb-5 md:hidden">
                            <h3
                                className="text-[20px] font-semibold leading-tight text-[var(--blanc-ink-1)]"
                                style={{ fontFamily: 'var(--blanc-font-heading)' }}
                            >
                                Send invoice
                            </h3>
                            <p className="mt-1 text-[12.5px] text-[var(--blanc-ink-3)]">
                                {invoice.invoice_number} · {fmtMoney(invoice.total)} · {invoice.contact_name || 'Customer'}
                            </p>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <button
                                type="button"
                                className={`min-h-[84px] rounded-[14px] border-[1.5px] p-3 text-center text-[14px] font-semibold ${channel === 'email'
                                    ? 'border-[var(--blanc-accent)] bg-[var(--blanc-accent-soft)] text-[var(--blanc-ink-1)]'
                                    : 'border-[var(--blanc-line)] text-[var(--blanc-ink-2)]'}`}
                                onClick={() => setChannel('email')}
                                aria-pressed={channel === 'email'}
                                data-testid="invoice-send-method-email"
                            >
                                <span className="mx-auto mb-1.5 flex size-[34px] items-center justify-center rounded-[10px] bg-[var(--blanc-panel-surface)] text-[var(--blanc-accent)]">
                                    <Mail className="size-[18px]" />
                                </span>
                                Email
                            </button>
                            <button
                                type="button"
                                className={`min-h-[84px] rounded-[14px] border-[1.5px] p-3 text-center text-[14px] font-semibold ${channel === 'sms'
                                    ? 'border-[var(--blanc-accent)] bg-[var(--blanc-accent-soft)] text-[var(--blanc-ink-1)]'
                                    : 'border-[var(--blanc-line)] text-[var(--blanc-ink-2)]'}`}
                                onClick={() => setChannel('sms')}
                                aria-pressed={channel === 'sms'}
                                data-testid="invoice-send-method-sms"
                            >
                                <span className="mx-auto mb-1.5 flex size-[34px] items-center justify-center rounded-[10px] bg-[var(--blanc-panel-surface)] text-[var(--blanc-accent)]">
                                    <MessageSquare className="size-[18px]" />
                                </span>
                                Text (SMS)
                            </button>
                        </div>

                        <div className="mt-3.5 space-y-3.5">
                            <div data-testid="invoice-send-recipient">
                                {channel === 'email' ? (
                                    <FloatingField
                                        label="To (email)"
                                        type="email"
                                        autoComplete="email"
                                        value={emailRecipient}
                                        onChange={event => setEmailRecipient(event.target.value)}
                                        disabled={sending}
                                    />
                                ) : (
                                    <PhoneInput
                                        label="To (phone)"
                                        autoComplete="tel"
                                        value={phoneRecipient}
                                        onChange={setPhoneRecipient}
                                        disabled={sending}
                                    />
                                )}
                            </div>
                            <FloatingField
                                label="Message (optional)"
                                textarea
                                rows={5}
                                value={message}
                                onChange={event => {
                                    setMessage(event.target.value);
                                    setUserEditedMessage(true);
                                }}
                                disabled={sending}
                            />
                        </div>

                        <label className="mt-3.5 flex min-h-10 cursor-pointer items-center gap-2 text-[13px] text-[var(--blanc-ink-2)]">
                            <Checkbox
                                checked={includePaymentLink}
                                onCheckedChange={checked => {
                                    setIncludePaymentLink(!!checked);
                                }}
                                disabled={sending}
                            />
                            {channel === 'email' ? 'Attach PDF + a secure pay link' : 'Include a secure pay link'}
                        </label>

                        <div className="mt-4 md:hidden">{actionButtons}</div>
                    </div>
                </DialogBody>

                <DialogPanelFooter className="max-md:hidden">
                    <div className="ml-auto w-full max-w-[360px]">{actionButtons}</div>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
