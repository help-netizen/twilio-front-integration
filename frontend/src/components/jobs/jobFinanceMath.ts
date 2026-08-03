type MoneyValue = string | number | null | undefined;

interface EstimateMoney {
    total?: MoneyValue;
}

interface InvoiceMoney {
    total?: MoneyValue;
    amount_paid?: MoneyValue;
    job_payment_allocated?: MoneyValue;
    status?: string | null;
}

interface JobPaymentMoney {
    id?: number | string;
    amount?: MoneyValue;
    invoice_id?: number | null;
    transaction_type?: string;
    status?: string;
    external_source?: string | null;
    voided_at?: string | null;
    metadata?: { original_transaction_id?: number | string | null; tip?: MoneyValue } | null;
}

export interface JobFinanceSummary {
    estimated: number;
    invoiced: number;
    paid: number;
    due: number;
}

function moneyNumber(value: MoneyValue): number {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

// A completed/refunded payment stays gross while a completed refund row offsets it.
// Invoice references are receipt metadata only and never remove a native payment from
// the Job pool.
function transactionEffect(p: JobPaymentMoney): number {
    if (p.voided_at != null) return 0;
    if (p.transaction_type === 'payment' && (p.status === 'completed' || p.status === 'refunded')) {
        return moneyNumber(p.amount);
    }
    if (p.transaction_type === 'refund' && p.status === 'completed') {
        return -Math.abs(moneyNumber(p.amount));
    }
    return 0;
}

// A refund row carries no source of its own; resolve it from the original payment so
// a refund of a Zenbooker payment is still treated as Zenbooker (no Due credit).
function effectiveSource(p: JobPaymentMoney, byId: Map<string, JobPaymentMoney>): string | null {
    const own = p.external_source?.trim();
    if (own) return own;
    const originalId = p.metadata?.original_transaction_id;
    const original = originalId != null ? byId.get(String(originalId)) : undefined;
    return original?.external_source?.trim() || null;
}

export function completedJobPoolPaid(payments: JobPaymentMoney[]): number {
    const byId = new Map(payments.map(payment => [String(payment.id), payment]));
    return payments.reduce((sum, payment) => {
        const source = effectiveSource(payment, byId);
        // Zenbooker-linked money remains materialized on its invoice. Only its
        // unlinked rows use the historical Job-paid fallback.
        if (source === 'zenbooker' && payment.invoice_id != null) return sum;
        return sum + transactionEffect(payment);
    }, 0);
}

export function completedJobPoolDueOffset(payments: JobPaymentMoney[]): number {
    const byId = new Map(payments.map(payment => [String(payment.id), payment]));
    return payments.reduce((sum, payment) => {
        if (effectiveSource(payment, byId) === 'zenbooker') return sum;
        let effect = transactionEffect(payment);
        if (payment.transaction_type === 'payment' && effect > 0) {
            effect = Math.max(effect - Math.max(moneyNumber(payment.metadata?.tip), 0), 0);
        } else if (payment.transaction_type === 'refund' && effect < 0) {
            const originalId = payment.metadata?.original_transaction_id;
            const original = originalId != null ? byId.get(String(originalId)) : undefined;
            const originalAmount = Math.abs(moneyNumber(original?.amount));
            const originalTip = Math.max(moneyNumber(original?.metadata?.tip), 0);
            if (originalAmount > 0) {
                effect *= Math.max(originalAmount - originalTip, 0) / originalAmount;
            }
        }
        return sum + effect;
    }, 0);
}

const INACTIVE_INVOICE_STATUSES = new Set(['void', 'voided', 'refunded']);

export function calculateJobFinanceSummary(
    estimates: EstimateMoney[],
    invoices: InvoiceMoney[],
    jobPayments: JobPaymentMoney[],
): JobFinanceSummary {
    const estimated = estimates.reduce((sum, estimate) => sum + moneyNumber(estimate.total), 0);
    // Voided / refunded invoices are cancelled — they drop out of Invoiced/Paid/Due
    // together so the tiles stay internally consistent with the backend rollup.
    const activeInvoices = invoices.filter(invoice => !INACTIVE_INVOICE_STATUSES.has(String(invoice.status ?? '')));
    const invoiced = activeInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.total), 0);
    const legacyInvoicePaid = activeInvoices.reduce((sum, invoice) => (
        sum + Math.max(
            moneyNumber(invoice.amount_paid) - moneyNumber(invoice.job_payment_allocated),
            0
        )
    ), 0);
    const paid = legacyInvoicePaid + completedJobPoolPaid(jobPayments);
    const jobPoolDueOffset = completedJobPoolDueOffset(jobPayments);

    return {
        estimated,
        invoiced,
        paid,
        due: invoiced - legacyInvoicePaid - jobPoolDueOffset,
    };
}

export function formatSignedCurrency(value: MoneyValue): string {
    const parsed = moneyNumber(value);
    const normalized = Math.abs(parsed) < 0.005 ? 0 : parsed;
    const amount = Math.abs(normalized).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `${normalized < 0 ? '−' : ''}$${amount}`;
}
