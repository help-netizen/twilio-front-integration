import { useEffect, useState } from 'react';
import { Copy, Loader2, Mail, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import {
    Dialog, DialogContent, DialogPanelHeader, DialogTitle, DialogDescription, DialogBody, DialogPanelFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import {
    RateLinkError, sendRateLink, type RateLinkChannel,
} from '../../services/jobsApi';

interface RateLinkModalProps {
    open: boolean;
    onClose: () => void;
    jobId: number;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    technicianName?: string;
    onSuccess: () => void | Promise<void>;
}

function rateLinkErrorMessage(error: unknown): string {
    const code = error instanceof RateLinkError ? error.code : null;
    if (code === 'NO_PHONE') return 'No phone number on file for this customer.';
    if (code === 'NO_EMAIL') return 'No email on file for this customer.';
    if (code === 'NO_PROXY') return 'No sending number configured for your company.';
    if (code === 'WALLET_BLOCKED') return 'Messaging is paused — top up your balance.';
    if (code === 'SMS_FAILED') return "Couldn't send the message. Please try again.";
    if (code === 'MAIL_DISCONNECTED') return 'Connect a mailbox to send email.';
    if (code === 'APP_NOT_INSTALLED') return 'Connect Rate Me in Integrations before sending a link.';
    return error instanceof RateLinkError && error.message
        ? error.message
        : "Couldn't send the rating link. Please try again.";
}

export function RateLinkModal({
    open, onClose, jobId, customerName, customerPhone, customerEmail, technicianName, onSuccess,
}: RateLinkModalProps) {
    const hasPhone = Boolean(customerPhone?.trim());
    const hasEmail = Boolean(customerEmail?.trim());
    const [channel, setChannel] = useState<RateLinkChannel>('copy');
    const [sending, setSending] = useState(false);

    useEffect(() => {
        if (!open) return;
        setChannel(hasPhone ? 'sms' : hasEmail ? 'email' : 'copy');
        setSending(false);
    }, [open, hasPhone, hasEmail]);

    const handleSend = async () => {
        if (sending) return;
        setSending(true);
        try {
            const result = await sendRateLink(jobId, channel);

            if (channel === 'copy') {
                try {
                    if (!result.url || !navigator.clipboard) throw new Error('Clipboard unavailable');
                    await navigator.clipboard.writeText(result.url);
                    toast.success('Rating link copied.');
                } catch {
                    toast.error("Rating link created, but it couldn't be copied. Please try again.");
                    await onSuccess();
                    return;
                }
            } else if (channel === 'sms') {
                toast.success('Rating link sent by SMS.');
            } else {
                toast.success('Rating link sent by email.');
            }

            await onSuccess();
            onClose();
        } catch (error) {
            toast.error(rateLinkErrorMessage(error));
        } finally {
            setSending(false);
        }
    };

    const optionStyle = (selected: boolean) => ({
        borderColor: selected ? 'var(--blanc-accent)' : 'var(--blanc-line)',
        backgroundColor: selected ? 'var(--blanc-accent-soft)' : 'transparent',
        color: 'var(--blanc-ink-1)',
    });

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !sending) onClose(); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Send rating link
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        Choose how to share this job's rating link with the customer
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                            Choose how to send the link{customerName ? ` to ${customerName}` : ''}.
                            {technicianName ? ` The response will be attributed to ${technicianName}'s visit.` : ''}
                        </p>

                        <div className="space-y-3.5">
                            <p className="blanc-eyebrow">Delivery method</p>

                            <button
                                type="button"
                                disabled={!hasPhone || sending}
                                aria-pressed={channel === 'sms'}
                                onClick={() => setChannel('sms')}
                                className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                style={optionStyle(channel === 'sms')}
                            >
                                <MessageSquare className="size-5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                                <span className="min-w-0">
                                    <span className="block text-sm font-semibold">SMS</span>
                                    <span className="block truncate text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                        {hasPhone ? customerPhone : 'No customer phone on file'}
                                    </span>
                                </span>
                            </button>

                            <button
                                type="button"
                                disabled={!hasEmail || sending}
                                aria-pressed={channel === 'email'}
                                onClick={() => setChannel('email')}
                                className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                style={optionStyle(channel === 'email')}
                            >
                                <Mail className="size-5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                                <span className="min-w-0">
                                    <span className="block text-sm font-semibold">Email</span>
                                    <span className="block truncate text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                        {hasEmail ? customerEmail : 'No customer email on file'}
                                    </span>
                                </span>
                            </button>

                            <button
                                type="button"
                                disabled={sending}
                                aria-pressed={channel === 'copy'}
                                onClick={() => setChannel('copy')}
                                className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                style={optionStyle(channel === 'copy')}
                            >
                                <Copy className="size-5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                                <span>
                                    <span className="block text-sm font-semibold">Copy link</span>
                                    <span className="block text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                        Copy a fresh link to your clipboard
                                    </span>
                                </span>
                            </button>
                        </div>
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={onClose} disabled={sending}>Cancel</Button>
                    <Button
                        onClick={handleSend}
                        disabled={sending}
                        style={{ backgroundColor: 'var(--blanc-accent)' }}
                    >
                        {sending && <Loader2 className="size-4 animate-spin" />}
                        {sending ? 'Sending…' : channel === 'copy' ? 'Copy rating link' : 'Send rating link'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
