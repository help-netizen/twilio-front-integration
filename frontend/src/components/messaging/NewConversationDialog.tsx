import { useState } from 'react';

interface NewConversationDialogProps {
    onSubmit: (customerE164: string, proxyE164: string, initialMessage?: string) => Promise<void>;
    onClose: () => void;
}

const DEFAULT_PROXY_NUMBERS = [
    { label: '(877) 419-4983', value: '+18774194983' },
    { label: '(617) 500-6181', value: '+16175006181' },
    { label: '(617) 992-7291', value: '+16179927291' },
];

export function NewConversationDialog({ onSubmit, onClose }: NewConversationDialogProps) {
    const [customerPhone, setCustomerPhone] = useState('');
    const [proxyNumber, setProxyNumber] = useState(DEFAULT_PROXY_NUMBERS[1].value);
    const [initialMessage, setInitialMessage] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async () => {
        let phone = customerPhone.replace(/[^\d+]/g, '');
        if (!phone.startsWith('+')) {
            if (phone.length === 10) phone = `+1${phone}`;
            else if (phone.length === 11 && phone.startsWith('1')) phone = `+${phone}`;
            else phone = `+${phone}`;
        }
        if (phone.length < 11) { setError('Please enter a valid phone number'); return; }

        setSubmitting(true);
        setError(null);
        try {
            await onSubmit(phone, proxyNumber, initialMessage || undefined);
        } catch (err: any) {
            setError(err.message || 'Failed to start conversation');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="new-conv-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="new-conv-dialog">
                <div className="new-conv-dialog__header">
                    <h3>New Conversation</h3>
                    <button className="new-conv-dialog__close" onClick={onClose}>×</button>
                </div>
                <div className="new-conv-dialog__body">
                    <div className="new-conv-dialog__field">
                        <label>Customer Phone Number</label>
                        <input type="tel" placeholder="+1 (555) 123-4567" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} autoComplete="off" autoFocus />
                    </div>
                    <div className="new-conv-dialog__field">
                        <label>Send From</label>
                        <select value={proxyNumber} onChange={(e) => setProxyNumber(e.target.value)}
                            style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--input-background)', fontSize: '14px', color: 'var(--foreground)', outline: 'none', fontFamily: 'inherit' }}>
                            {DEFAULT_PROXY_NUMBERS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
                        </select>
                    </div>
                    <div className="new-conv-dialog__field">
                        <label>Initial Message (optional)</label>
                        <textarea placeholder="Hello! How can we help you today?" value={initialMessage} onChange={(e) => setInitialMessage(e.target.value)} rows={3} />
                    </div>
                    {error && <div className="new-conv-dialog__error">{error}</div>}
                </div>
                <div className="new-conv-dialog__footer">
                    <button className="new-conv-dialog__cancel" onClick={onClose}>Cancel</button>
                    <button className="new-conv-dialog__submit" onClick={handleSubmit} disabled={!customerPhone.trim() || submitting}>
                        {submitting ? 'Creating...' : 'Start Conversation'}
                    </button>
                </div>
            </div>
        </div>
    );
}
