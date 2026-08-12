import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { PaymentDetail } from './paymentTypes';
import { formatCurrency, formatPaymentDate } from './paymentTypes';

/**
 * The payment's own identity — everything this record IS, before any job context.
 *
 * A payment is a sum, so the sum is the title. Method, status and date sit under
 * it as one line, which is why the card carries no separate "payment details"
 * block: there would be nothing left to put in it.
 */

const TRANSACTION_TONES: Record<string, { background: string; color: string }> = {
    succeeded: { background: 'rgba(27,139,99,.10)', color: 'var(--blanc-success)' },
    completed: { background: 'rgba(27,139,99,.10)', color: 'var(--blanc-success)' },
    pending: { background: 'rgba(178,106,29,.12)', color: 'var(--blanc-warning)' },
    failed: { background: 'rgba(240,80,63,.10)', color: 'var(--blanc-danger)' },
    voided: { background: 'rgba(240,80,63,.10)', color: 'var(--blanc-danger)' },
    refunded: { background: 'rgba(25,25,25,.06)', color: 'var(--blanc-ink-2)' },
};

export function StatusPill({ label }: { label: string }) {
    const tone = TRANSACTION_TONES[label.toLowerCase()]
        || { background: 'rgba(25,25,25,.06)', color: 'var(--blanc-ink-2)' };
    return (
        <span
            className="inline-flex items-center px-2.5 text-[11.5px] font-semibold"
            style={{ ...tone, minHeight: 24, borderRadius: 8 }}
        >
            {label}
        </span>
    );
}

export function PaymentIdentity({
    detail, onToggleDeposited,
}: {
    detail: PaymentDetail;
    onToggleDeposited: (deposited: boolean) => void;
}) {
    const method = detail.display_payment_method || detail.payment_methods || '';
    const isCheck = method.toLowerCase() === 'check';

    return (
        <div>
            <p className="blanc-eyebrow">Payment</p>
            <h2
                className="mt-1.5 text-[32px] font-semibold leading-none tabular-nums"
                style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)', letterSpacing: '-0.025em' }}
            >
                {formatCurrency(detail.amount_paid)}
            </h2>

            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[13.5px]" style={{ color: 'var(--blanc-ink-2)' }}>
                {detail.transaction_status && <StatusPill label={detail.transaction_status} />}
                {method && <span>{method}</span>}
                {method && <span className="size-[3px] rounded-full" style={{ background: 'var(--blanc-ink-3)' }} />}
                <span>{formatPaymentDate(detail.payment_date)}</span>
                {isCheck && (
                    <Popover>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                className="inline-flex items-center px-2.5 text-[11.5px] font-semibold"
                                style={{
                                    background: detail.check_deposited ? 'rgba(27,139,99,.10)' : 'rgba(240,80,63,.10)',
                                    color: detail.check_deposited ? 'var(--blanc-success)' : 'var(--blanc-danger)',
                                    minHeight: 24, borderRadius: 8, border: 'none', cursor: 'pointer',
                                }}
                            >
                                {detail.check_deposited ? 'Deposited' : 'Not deposited'}
                            </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-1" align="start">
                            <button className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-muted" onClick={() => onToggleDeposited(true)}>
                                <span className="size-2 rounded-full" style={{ background: 'var(--blanc-success)' }} /> Deposited
                            </button>
                            <button className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-muted" onClick={() => onToggleDeposited(false)}>
                                <span className="size-2 rounded-full" style={{ background: 'var(--blanc-danger)' }} /> Not deposited
                            </button>
                        </PopoverContent>
                    </Popover>
                )}
            </div>

            {detail._warning && (
                <p className="mt-3 text-[12.5px]" style={{ color: 'var(--blanc-warning)' }}>{detail._warning}</p>
            )}
        </div>
    );
}

/**
 * Total / Paid / Due. Due carries the job card's colour rule rather than a new
 * one: amber while money is owed, green when the customer has overpaid — that is
 * a credit, not an alarm — and plain ink at zero.
 */
export function InvoiceFigures({ invoice }: { invoice: PaymentDetail['invoice'] }) {
    if (!invoice) return null;
    const due = Number(invoice.amount_due || 0);
    const dueColor = due > 0
        ? 'var(--blanc-warning)'
        : due < 0
            ? 'var(--blanc-success)'
            : 'var(--blanc-ink-1)';

    const figure = (label: string, value: string, color?: string) => (
        <div>
            <div
                className="text-[20px] font-semibold tabular-nums"
                style={{ color: color || 'var(--blanc-ink-1)', letterSpacing: '-0.01em' }}
            >
                {formatCurrency(value)}
            </div>
            <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--blanc-ink-3)' }}>{label}</div>
        </div>
    );

    return (
        <div>
            <p className="blanc-eyebrow mb-2.5">Invoice</p>
            <div className="flex flex-wrap gap-x-7 gap-y-3">
                {figure('Total', invoice.total)}
                {figure('Paid', invoice.amount_paid)}
                {figure('Due', invoice.amount_due, dueColor)}
            </div>
        </div>
    );
}
