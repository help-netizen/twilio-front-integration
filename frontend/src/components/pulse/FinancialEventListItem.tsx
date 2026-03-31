import { FileText, Receipt, CheckCircle, XCircle, Send, CreditCard } from 'lucide-react';
import { Badge } from '../ui/badge';
import type { FinancialEvent } from '../../types/pulse';

function money(v: string | number | null | undefined): string {
    if (v == null) return '$0.00';
    return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateTime(value: string): string {
    return new Date(value).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
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

function EventIcon({ type }: { type: FinancialEvent['type'] }) {
    if (type.startsWith('estimate')) {
        if (type === 'estimate_accepted') return <CheckCircle className="size-4 text-green-500 shrink-0" />;
        if (type === 'estimate_declined') return <XCircle className="size-4 text-red-400 shrink-0" />;
        if (type === 'estimate_sent') return <Send className="size-4 text-blue-400 shrink-0" />;
        return <FileText className="size-4 text-muted-foreground shrink-0" />;
    }
    if (type === 'invoice_paid' || type === 'invoice_partial_payment') {
        return <CreditCard className="size-4 text-green-500 shrink-0" />;
    }
    return <Receipt className="size-4 text-muted-foreground shrink-0" />;
}

interface Props { event: FinancialEvent; }

export function FinancialEventListItem({ event }: Props) {
    return (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
            <EventIcon type={event.type} />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{EVENT_LABELS[event.type]}</span>
                    <span className="font-mono text-xs text-muted-foreground">{event.reference}</span>
                    <Badge variant="secondary" className="text-xs capitalize">{event.status}</Badge>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                    <span className="font-mono text-sm font-semibold">{money(event.amount)}</span>
                    <span className="text-xs text-muted-foreground">{fmtDateTime(event.occurred_at)}</span>
                </div>
            </div>
        </div>
    );
}
