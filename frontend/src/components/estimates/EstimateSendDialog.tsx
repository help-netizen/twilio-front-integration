import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import type { EstimateSendData } from '../../services/estimatesApi';

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    estimateId: number;
    contactEmail?: string;
    onSend: (data: EstimateSendData) => Promise<any>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function EstimateSendDialog({ open, onOpenChange, estimateId, contactEmail, onSend }: Props) {
    const [channel, setChannel] = useState<'email' | 'sms'>('email');
    const [recipient, setRecipient] = useState(contactEmail || '');
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);

    const handleSend = async () => {
        if (!recipient.trim()) return;
        setSending(true);
        try {
            await onSend({ channel, recipient: recipient.trim(), message: message.trim() || undefined });
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

                    {/* Message */}
                    <div>
                        <Label className="text-xs">Message (optional)</Label>
                        <Textarea
                            value={message}
                            onChange={e => setMessage(e.target.value)}
                            placeholder="Add a personal message..."
                            rows={3}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
                        Cancel
                    </Button>
                    <Button onClick={handleSend} disabled={sending || !recipient.trim()}>
                        {sending ? 'Sending...' : 'Send Estimate'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
