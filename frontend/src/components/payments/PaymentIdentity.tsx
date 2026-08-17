import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { PaymentDetail } from './paymentTypes';
import { formatCurrency, formatPaymentDate } from './paymentTypes';
import { LEVEL_TWO_QUIET, LEVEL_TWO_HEADING } from '../../styles/levelTwo';
import { useJobFinancials } from '../../hooks/useJobFinancials';
import { calculateJobFinanceSummary, formatSignedCurrency } from '../jobs/jobFinanceMath';

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
            data-testid="payment-status"
            className="blanc-l2 inline-flex items-center px-2.5"
            style={{ ...tone, minHeight: 26, borderRadius: 8 }}
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
        <div data-testid="payment-identity">
            <p className="blanc-section-heading">Payment</p>
            <h2
                data-testid="payment-amount"
                className="mt-1.5 text-[32px] font-semibold leading-none tabular-nums"
                style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)', letterSpacing: '-0.025em' }}
            >
                {formatCurrency(detail.amount_paid)}
            </h2>

            <div className="blanc-l2 mt-2.5 flex flex-wrap items-center gap-2" style={{ color: 'var(--blanc-ink-3)' }}>
                {detail.transaction_status && <StatusPill label={detail.transaction_status} />}
                {method && <span>{method}</span>}
                {method && <span className="size-[3px] rounded-full" style={{ background: 'var(--blanc-ink-3)' }} />}
                <span>{formatPaymentDate(detail.payment_date)}</span>
                {isCheck && (
                    <Popover>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                className="blanc-l2 inline-flex items-center px-2.5"
                                style={{
                                    background: detail.check_deposited ? 'rgba(27,139,99,.10)' : 'rgba(240,80,63,.10)',
                                    color: detail.check_deposited ? 'var(--blanc-success)' : 'var(--blanc-danger)',
                                    minHeight: 26, borderRadius: 8, border: 'none', cursor: 'pointer',
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
                <p className="blanc-l2 mt-3" style={{ color: 'var(--blanc-warning)' }}>{detail._warning}</p>
            )}
        </div>
    );
}

/**
 * The JOB's finance, not the invoice's (owner, 2026-08-16). A payment does not
 * need an invoice — it can be taken against the job itself — but it always
 * belongs to a job, so the invoice trio was both narrower than the truth and,
 * when the invoice's stored aggregates drifted, wrong: payment 46348 paid its
 * invoice in full while the card read "Paid $0.00, Due $1,665.81".
 *
 * These are the same four figures the job card shows, from the same function,
 * so the two surfaces cannot disagree.
 *
 * Estimated, Invoiced, Paid and Due on ONE line. Stacked as rows they read as a list to work
 * through; side by side they are three numbers you compare at a glance, which
 * is the only reason to show all three.
 *
 * Emphasis without a size: the figures take the same 600 the group headings
 * take — the weight level two already has — so nothing new enters the scale.
 * Due then carries the job card's colour rule rather than a new one: amber
 * while money is owed, green when the customer has overpaid (a credit, not an
 * alarm), plain ink at zero.
 */
export function JobFinanceFigures({ jobId }: { jobId: number | null | undefined }) {
    const { estimates, invoices, jobPayments } = useJobFinancials(jobId ?? 0);
    if (!jobId) return null;
    const summary = calculateJobFinanceSummary(estimates, invoices, jobPayments);
    const due = summary.due;
    const dueColor = due > 0
        ? 'var(--blanc-warning)'
        : due < 0
            ? 'var(--blanc-success)'
            : 'var(--blanc-ink-1)';

    const figure = (label: string, value: number, color?: string) => (
        <div className="flex items-baseline gap-2">
            <span style={LEVEL_TWO_QUIET}>{label}</span>
            <span
                data-testid={`invoice-${label.toLowerCase()}`}
                className="blanc-l2 tabular-nums"
                style={{ ...LEVEL_TWO_HEADING, color: color || 'var(--blanc-ink-1)' }}
            >
                {formatSignedCurrency(value)}
            </span>
        </div>
    );

    return (
        <div>
            <p className="blanc-section-heading">Finance</p>
            <div className="flex flex-wrap gap-x-7 gap-y-1.5">
                {figure('Estimated', summary.estimated)}
                {figure('Invoiced', summary.invoiced)}
                {figure('Paid', summary.paid)}
                {figure('Due', summary.due, dueColor)}
            </div>
        </div>
    );
}
