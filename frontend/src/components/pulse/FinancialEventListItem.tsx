import { FileText, Receipt, CheckCircle, XCircle, Send, CreditCard } from 'lucide-react';
import type { FinancialEvent } from '../../types/pulse';

function money(v: string | number | null | undefined): string {
    if (v == null) return '$0.00';
    return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(value: string): string {
    return new Date(value).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
    });
}

const EVENT_LABELS: Record<FinancialEvent['type'], string> = {
    estimate_created: 'Estimate created',
    estimate_sent: 'Estimate sent',
    estimate_accepted: 'Estimate accepted',
    estimate_declined: 'Estimate declined',
    invoice_created: 'Invoice created',
    invoice_sent: 'Invoice sent',
    invoice_paid: 'Invoice paid',
    invoice_partial_payment: 'Partial payment recorded',
};

const EVENT_COLORS: Record<string, string> = {
    estimate_accepted: '#16a34a',
    estimate_declined: '#dc2626',
    estimate_sent: '#2563eb',
    invoice_paid: '#16a34a',
    invoice_partial_payment: '#16a34a',
};

function EventIcon({ type }: { type: FinancialEvent['type'] }) {
    const color = EVENT_COLORS[type] || 'var(--blanc-ink-3)';
    if (type.startsWith('estimate')) {
        if (type === 'estimate_accepted') return <CheckCircle className="size-4 shrink-0" style={{ color }} />;
        if (type === 'estimate_declined') return <XCircle className="size-4 shrink-0" style={{ color }} />;
        if (type === 'estimate_sent') return <Send className="size-4 shrink-0" style={{ color }} />;
        return <FileText className="size-4 shrink-0" style={{ color }} />;
    }
    if (type === 'invoice_paid' || type === 'invoice_partial_payment') {
        return <CreditCard className="size-4 shrink-0" style={{ color }} />;
    }
    return <Receipt className="size-4 shrink-0" style={{ color }} />;
}

interface Props { event: FinancialEvent; }

export function FinancialEventListItem({ event }: Props) {
    return (
        <div
            className="flex items-center gap-3 px-4 py-3 rounded-xl transition-colors"
            style={{ border: '1px solid var(--blanc-line)' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(104,95,80,0.3)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--blanc-line)')}
        >
            <EventIcon type={event.type} />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>{EVENT_LABELS[event.type]}</span>
                    {event.reference && <span className="font-mono text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{event.reference}</span>}
                </div>
            </div>
            <span className="font-mono text-sm font-semibold shrink-0" style={{ color: 'var(--blanc-ink-1)' }}>{money(event.amount)}</span>
            <span className="text-xs shrink-0" style={{ color: 'var(--blanc-ink-3)' }}>{fmtTime(event.occurred_at)}</span>
        </div>
    );
}
