/**
 * TXN-STATUS-VOID-001 — canonical transaction status presentation + void eligibility.
 * Single source of truth for how a payment_transactions row's status/type maps to a
 * user-visible label + chip, and for whether a row may be voided. Derived, never editable.
 */
import type { PaymentTransaction } from '../../services/paymentsCanonicalApi';

export interface PaymentStatusInfo {
    label: string;
    /** Chip surface + text classes — PALETTE-V2 tokens only, no hardcoded hex. */
    className: string;
}

const MUTED = 'bg-[var(--blanc-surface-muted)] border border-[var(--blanc-line)]';
const ACCENT = 'bg-[var(--blanc-accent-soft)] border border-transparent';

/**
 * Map (status, transaction_type) → label + chip classes (spec §2). `completed` payments
 * read as "Succeeded"; refund rows and refunded originals read as "Refunded".
 */
export function getPaymentStatusInfo(
    status: PaymentTransaction['status'],
    transactionType: PaymentTransaction['transaction_type'],
): PaymentStatusInfo {
    switch (status) {
        case 'pending':
            return { label: 'Pending', className: `${MUTED} text-[var(--blanc-ink-2)]` };
        case 'processing':
            return { label: 'Processing', className: `${ACCENT} text-[var(--blanc-accent)]` };
        case 'completed':
            return transactionType === 'refund'
                ? { label: 'Refunded', className: `${ACCENT} text-[var(--blanc-accent)]` }
                : { label: 'Succeeded', className: `${MUTED} text-[var(--blanc-success)]` };
        case 'failed':
            return { label: 'Failed', className: `${MUTED} text-[var(--blanc-danger)]` };
        case 'refunded':
            return { label: 'Refunded', className: `${ACCENT} text-[var(--blanc-accent)]` };
        case 'voided':
            return { label: 'Voided', className: `${MUTED} text-[var(--blanc-ink-3)]` };
        default:
            return { label: String(status), className: `${MUTED} text-[var(--blanc-ink-2)]` };
    }
}

type VoidableLike = Pick<PaymentTransaction, 'transaction_type' | 'status' | 'external_source'>;

/**
 * A payment is voidable only when it is a completed, manually-recorded payment
 * (source='manual' → cash / check / offline card / ACH). Stripe-captured rows reverse
 * via Refund; Zenbooker rows are master-owned; null/empty source is ambiguous (D4) and
 * therefore NOT voidable. Refund/adjustment rows are never voidable.
 */
export function isVoidablePayment(p: VoidableLike): boolean {
    return p.transaction_type === 'payment'
        && p.status === 'completed'
        && p.external_source === 'manual';
}

export function isVoidedPayment(p: Pick<PaymentTransaction, 'status'>): boolean {
    return p.status === 'voided';
}

/** Struck-through-but-readable amount treatment for a voided row (spec §7). */
export const VOIDED_AMOUNT_CLASS = 'line-through decoration-[var(--blanc-ink-3)] text-[var(--blanc-ink-2)]';

export function PaymentStatusChip({
    status,
    transactionType,
    className,
}: {
    status: PaymentTransaction['status'];
    transactionType: PaymentTransaction['transaction_type'];
    className?: string;
}) {
    const info = getPaymentStatusInfo(status, transactionType);
    return (
        <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none ${info.className}${className ? ` ${className}` : ''}`}
        >
            {info.label}
        </span>
    );
}
