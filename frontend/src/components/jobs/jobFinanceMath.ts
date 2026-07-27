type MoneyValue = string | number | null | undefined;

interface EstimateMoney {
    total?: MoneyValue;
}

interface InvoiceMoney {
    total?: MoneyValue;
    amount_paid?: MoneyValue;
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
    metadata?: { original_transaction_id?: number | string | null } | null;
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

// TXN-STATUS-VOID-001 (T3) — mirrors the backend refund formula verbatim
// (backend/src/db/jobFinanceQueries.js + paymentsQueries.js): a standalone payment
// counts at full amount while it is completed OR refunded; a completed refund row
// offsets by its absolute amount; voided and invoice-linked rows contribute nothing.
function standaloneEffect(p: JobPaymentMoney): number {
    if (p.invoice_id != null || p.voided_at != null) return 0;
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

export function completedStandalonePaid(payments: JobPaymentMoney[]): number {
    return payments.reduce((sum, payment) => sum + standaloneEffect(payment), 0);
}

export function completedStandaloneDueOffset(payments: JobPaymentMoney[]): number {
    const byId = new Map(payments.map(payment => [String(payment.id), payment]));
    return payments.reduce((sum, payment) => (
        effectiveSource(payment, byId) !== 'zenbooker' ? sum + standaloneEffect(payment) : sum
    ), 0);
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
    const invoicePaid = activeInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.amount_paid), 0);
    const paid = invoicePaid + completedStandalonePaid(jobPayments);
    const standaloneDueOffset = completedStandaloneDueOffset(jobPayments);

    return {
        estimated,
        invoiced,
        paid,
        due: invoiced - invoicePaid - standaloneDueOffset,
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
