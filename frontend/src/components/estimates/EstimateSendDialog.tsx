import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Send, Mail } from 'lucide-react';
import { toast } from 'sonner';
import type { EstimateSendData } from '../../services/estimatesApi';
import { ensureEstimatePublicLink } from '../../services/estimatesApi';
import * as emailApi from '../../services/emailApi';
import { useAuth } from '../../auth/AuthProvider';

// The Google Email marketplace app setup path (created by C2). The connect CTA and
// the 409 toast both point here — never the retired /settings/email page.
const GOOGLE_EMAIL_SETUP_PATH = '/settings/integrations/google-email';

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    estimateId: number;
    contactEmail?: string;
    contactPhone?: string;
    /** Used in the default message body — e.g. "ESTIMATE L-53-1". */
    estimateNumber?: string;
    /** Used to address the customer in the default message body. */
    contactName?: string;
    onSend: (data: EstimateSendData) => Promise<any>;
}

function firstName(fullName?: string): string {
    if (!fullName) return 'there';
    const first = fullName.trim().split(/\s+/)[0];
    return first || 'there';
}

function buildDefaultMessage(
    channel: 'email' | 'sms',
    opts: {
        estimateNumber: string;
        name: string;
        url: string;
        /** First name (or full name) of the currently logged-in user — appended after the sign-off. */
        signOff: string;
    }
): string {
    const { estimateNumber, name, url, signOff } = opts;
    // Numbers like "ESTIMATE L-53-1" already start with the word "ESTIMATE"; trim the
    // prefix so "estimate ESTIMATE L-53-1" doesn't read doubled in the body.
    const shortNumber = estimateNumber ? estimateNumber.replace(/^ESTIMATE\s+/i, '') : '';
    const label = shortNumber || 'your estimate';
    const signature = signOff ? `\n${signOff}` : '';

    if (channel === 'sms') {
        return url
            ? `Hi ${name}! Here's your estimate ${label}. You can review it anytime: ${url} — let us know if you'd like to move forward. Thanks!`
            : `Hi ${name}! Your estimate ${label} is ready. Thanks!`;
    }

    // Email — longer, friendly, with a link to view the estimate online.
    return [
        `Hi ${name},`,
        '',
        `Thanks so much for the opportunity — here's estimate ${label} for the work we discussed.`,
        '',
        url ? `You can review the full details online here:\n${url}` : null,
        '',
        'Take a look whenever you have a moment, and if anything looks off or you have a question, just hit reply and we will sort it out.',
        '',
        `Thanks,${signature}`,
    ].filter(s => s !== null).join('\n');
}

// ── Component ────────────────────────────────────────────────────────────────

export function EstimateSendDialog({ open, onOpenChange, estimateId, contactEmail, contactPhone, estimateNumber, contactName, onSend }: Props) {
    const { user } = useAuth();
    const navigate = useNavigate();
    const operatorSignOff = firstName(user?.name);

    const [channel, setChannel] = useState<'email' | 'sms'>('email');
    const [emailRecipient, setEmailRecipient] = useState(contactEmail || '');
    const [phoneRecipient, setPhoneRecipient] = useState(contactPhone || '');
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);
    const [publicUrl, setPublicUrl] = useState<string>('');
    const [userEditedMessage, setUserEditedMessage] = useState(false);

    // Company Gmail mailbox status — drives whether email Send is allowed or a connect-CTA shows.
    // Only fetch while the dialog is open on the email channel (mirrors usePulsePage).
    const { data: mailboxStatus } = useQuery({
        queryKey: ['timeline-mailbox-status'],
        queryFn: () => emailApi.getTimelineMailboxStatus(),
        enabled: open && channel === 'email',
    });
    const emailConnected = mailboxStatus?.connected === true;

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
        if (!open || !estimateId) return;
        let cancelled = false;
        ensureEstimatePublicLink(estimateId)
            .then(({ url }) => { if (!cancelled) setPublicUrl(url); })
            .catch(() => { if (!cancelled) setPublicUrl(''); });
        return () => { cancelled = true; };
    }, [open, estimateId]);

    // Re-build the default message whenever the channel or link changes — unless the
    // user has already edited the textarea (we don't want to clobber their typing).
    useEffect(() => {
        if (!open || userEditedMessage) return;
        setMessage(buildDefaultMessage(channel, {
            estimateNumber: estimateNumber || '',
            name: firstName(contactName),
            url: publicUrl,
            signOff: operatorSignOff,
        }));
    }, [open, channel, publicUrl, estimateNumber, contactName, operatorSignOff, userEditedMessage]);

    const recipient = channel === 'email' ? emailRecipient : phoneRecipient;
    const setRecipient = (v: string) => {
        if (channel === 'email') setEmailRecipient(v);
        else setPhoneRecipient(v);
    };

    // Email send is gated on a connected mailbox (else the backend 409s).
    const emailBlocked = channel === 'email' && !emailConnected;
    const canSubmit = recipient.trim().length > 0 && message.trim().length > 0 && !emailBlocked;

    const handleSend = async () => {
        if (!canSubmit) return;
        setSending(true);
        try {
            await onSend({ channel, recipient: recipient.trim(), message: message.trim() });
            onOpenChange(false);
        } catch (err: any) {
            // Map the server code (carried by EstimateApiError) to a specific toast.
            const code: string | undefined = err?.code;
            switch (code) {
                case 'MAILBOX_NOT_CONNECTED':
                    toast.error('Connect Google Email to send.', {
                        action: { label: 'Connect', onClick: () => navigate(GOOGLE_EMAIL_SETUP_PATH) },
                    });
                    break;
                case 'WALLET_BLOCKED':
                    toast.error('Messaging is paused — top up your balance to send by SMS.');
                    break;
                case 'NO_PROXY':
                    toast.error('No SMS number is configured for your company.');
                    break;
                case 'NO_PHONE':
                    toast.error('This contact has no valid phone number.');
                    break;
                default:
                    toast.error(err?.message || 'Failed to send estimate.');
            }
        } finally {
            setSending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Send Estimate</DialogTitle>
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

                    {/* Mailbox-not-connected notice + CTA (email channel only) */}
                    {emailBlocked && (
                        <div
                            className="rounded-2xl px-3 py-3 text-sm"
                            style={{ background: 'rgba(117, 106, 89, 0.04)', color: 'var(--blanc-ink-2)' }}
                        >
                            <p className="mb-2">Connect Google Email to send estimates by email.</p>
                            <Button type="button" variant="outline" size="sm" onClick={() => navigate(GOOGLE_EMAIL_SETUP_PATH)}>
                                <Mail className="mr-1 size-3.5" />
                                Connect Google email
                            </Button>
                        </div>
                    )}

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
                        {sending ? 'Sending...' : 'Send Estimate'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
