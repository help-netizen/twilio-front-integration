import type { Invoice } from '../../services/invoicesApi';
import { formatCompanyTime, useCompanyTime } from '../../lib/companyTime';

interface Props {
    invoice: Invoice;
    onOpen: () => void;
}

export function invoiceStatusLabel(status: Invoice['status']): string {
    if (status === 'viewed') return 'Sent';
    return status.charAt(0).toUpperCase() + status.slice(1);
}

export function invoiceStatusTone(status: Invoice['status']): string {
    if (status === 'paid') {
        return 'bg-[var(--blanc-task-soft)] text-[var(--blanc-success)]';
    }
    if (status === 'partial') {
        return 'bg-[var(--blanc-lead-soft)] text-[var(--blanc-warning)]';
    }
    if (status === 'overdue') {
        return 'bg-[var(--blanc-danger-soft)] text-[var(--blanc-danger)]';
    }
    if (status === 'sent' || status === 'viewed') {
        return 'bg-[var(--blanc-job-soft)] text-[var(--blanc-job)]';
    }
    return 'bg-[var(--blanc-field)] text-[var(--blanc-ink-2)]';
}

function shortDate(value: string | null | undefined, timeZone?: string): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return formatCompanyTime(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : date, { month: 'short', day: 'numeric' }, timeZone);
}

export function invoiceTimingLabel(invoice: Invoice, timeZone?: string): string {
    if (invoice.status === 'draft') return 'Not sent';
    if (invoice.status === 'paid') {
        const paid = shortDate(invoice.paid_at, timeZone);
        return paid ? `Paid ${paid}` : 'Paid';
    }
    if (invoice.status === 'void') return 'Voided';
    if (invoice.status === 'refunded') return 'Refunded';
    const due = shortDate(invoice.due_date, timeZone);
    return due ? `Due ${due}` : 'No due date';
}

export function invoiceBalanceTone(status: Invoice['status']): string {
    if (status === 'paid') return 'text-[var(--blanc-success)]';
    if (status === 'overdue') return 'text-[var(--blanc-danger)]';
    if (status === 'void' || status === 'refunded') return 'text-[var(--blanc-ink-3)]';
    return 'text-[var(--blanc-ink-1)]';
}

function money(value: string | number | null | undefined): string {
    const amount = Number(value || 0);
    const body = Math.abs(amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return (amount < 0 ? '−$' : '$') + body;
}

export function InvoiceMobileRow({ invoice, onOpen }: Props) {
    const { timeZone } = useCompanyTime();
    const balance = Number(invoice.balance_due) || 0;
    const total = Number(invoice.total) || 0;
    const showTotal = balance > 0 && total > 0 && balance !== total;
    const jobLabel = invoice.job_id ? `Job #${invoice.job_seq ?? invoice.job_number ?? '—'}` : '';
    const customerJob = [invoice.contact_name || invoice.title || 'Customer not linked', jobLabel]
        .filter(Boolean)
        .join(' · ');

    return (
        <button
            type="button"
            className="flex w-full items-start justify-between gap-3 border-b border-[var(--blanc-line)] px-1 py-3.5 text-left first:border-t"
            onClick={onOpen}
            aria-label={`Open ${invoice.invoice_number}`}
            data-testid="invoice-list-row"
        >
            <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                    <span
                        className="truncate text-[15px] font-semibold text-[var(--blanc-ink-1)]"
                        style={{ fontFamily: 'var(--blanc-font-heading)' }}
                    >
                        {invoice.invoice_number}
                    </span>
                    <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${invoiceStatusTone(invoice.status)}`}
                    >
                        {invoiceStatusLabel(invoice.status)}
                    </span>
                </span>
                <span className="mt-1 block truncate text-[12px] text-[var(--blanc-ink-2)]">
                    {customerJob}
                </span>
                <span className={`mt-0.5 block text-[12px] ${invoice.status === 'overdue' ? 'text-[var(--blanc-danger)]' : 'text-[var(--blanc-ink-3)]'}`}>
                    {invoiceTimingLabel(invoice, timeZone)}
                </span>
            </span>
            <span className="shrink-0 pt-0.5 text-right">
                <span className={`block font-mono text-[15px] font-semibold ${invoiceBalanceTone(invoice.status)}`}>
                    {money(invoice.balance_due)}
                </span>
                {showTotal ? (
                    <span className="mt-0.5 block text-[12px] text-[var(--blanc-ink-3)]">
                        of {money(invoice.total)}
                    </span>
                ) : null}
            </span>
        </button>
    );
}
