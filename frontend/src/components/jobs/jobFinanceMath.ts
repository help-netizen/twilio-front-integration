type MoneyValue = string | number | null | undefined;

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

/**
 * The job's four figures used to live here, computed from lists the panel had already
 * fetched. They are the server's now (OB-70 phase 2, `GET /api/jobs/:id/finance`): one
 * projector answers the jobs list, Inspector, the Unpaid filter and the panel, so they
 * cannot disagree — and this copy could not see past its own `limit: 100`. The rules it
 * encoded (Zenbooker money crediting Due, refunds netting, voided rows counting zero,
 * legacy `amount_paid` surviving without ledger rows) are asserted against a real
 * database in tests/invoicePaymentAbsorption.db.test.js. What stays here is what the UI
 * genuinely computes for itself.
 */

export function formatSignedCurrency(value: MoneyValue): string {
    const parsed = moneyNumber(value);
    const normalized = Math.abs(parsed) < 0.005 ? 0 : parsed;
    const amount = Math.abs(normalized).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `${normalized < 0 ? '−' : ''}$${amount}`;
}
