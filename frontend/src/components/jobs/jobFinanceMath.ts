type MoneyValue = string | number | null | undefined;

interface EstimateMoney {
    total?: MoneyValue;
}

interface InvoiceMoney {
    total?: MoneyValue;
    amount_paid?: MoneyValue;
}

interface JobPaymentMoney {
    amount?: MoneyValue;
    invoice_id?: number | null;
    transaction_type?: string;
    status?: string;
    external_source?: string | null;
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

export function completedStandalonePaid(payments: JobPaymentMoney[]): number {
    return payments
        .filter(payment => (
            payment.invoice_id == null
            && payment.transaction_type === 'payment'
            && payment.status === 'completed'
        ))
        .reduce((sum, payment) => sum + moneyNumber(payment.amount), 0);
}

export function completedStandaloneDueOffset(payments: JobPaymentMoney[]): number {
    return payments
        .filter(payment => (
            payment.invoice_id == null
            && payment.transaction_type === 'payment'
            && payment.status === 'completed'
            && payment.external_source !== 'zenbooker'
        ))
        .reduce((sum, payment) => sum + moneyNumber(payment.amount), 0);
}

export function calculateJobFinanceSummary(
    estimates: EstimateMoney[],
    invoices: InvoiceMoney[],
    jobPayments: JobPaymentMoney[],
): JobFinanceSummary {
    const estimated = estimates.reduce((sum, estimate) => sum + moneyNumber(estimate.total), 0);
    const invoiced = invoices.reduce((sum, invoice) => sum + moneyNumber(invoice.total), 0);
    const invoicePaid = invoices.reduce((sum, invoice) => sum + moneyNumber(invoice.amount_paid), 0);
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
    return `${normalized < 0 ? '\u2212' : ''}$${amount}`;
}
