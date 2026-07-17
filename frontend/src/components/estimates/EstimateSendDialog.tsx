import { useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import type { EstimateSendData } from '../../services/estimatesApi';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    estimateId: number;
    contactEmail?: string;
    onSend: (data: EstimateSendData) => Promise<any>;
}

export function EstimateSendDialog({ open, onOpenChange, estimateId: _estimateId, contactEmail: _contactEmail, onSend }: Props) {
    const [channel, setChannel] = useState<'email' | 'text'>('email');
    const [sending, setSending] = useState(false);

    const handleSend = async () => {
        setSending(true);
        try {
            await onSend({ channel });
            onOpenChange(false);
        } finally {
            setSending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Send Estimate</DialogTitle>
                </DialogHeader>

                <div className="space-y-2 py-2">
                    <p className="text-sm text-muted-foreground">Choose delivery channel</p>
                    <div className="grid grid-cols-2 gap-2">
                        <Button type="button" variant={channel === 'email' ? 'default' : 'outline'} onClick={() => setChannel('email')}>
                            Email
                        </Button>
                        <Button type="button" variant={channel === 'text' ? 'default' : 'outline'} onClick={() => setChannel('text')}>
                            Text
                        </Button>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>Cancel</Button>
                    <Button onClick={handleSend} disabled={sending}>{sending ? 'Opening...' : 'Continue'}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
