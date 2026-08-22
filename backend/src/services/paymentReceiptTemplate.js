'use strict';

const K = require('./documentEmailLayout');
const { firstName, formatDate } = require('./documentEmailBody');
const { shortDocNumber } = require('../utils/docNumber');

const STRIPE_TRUST = 'Card or bank — payments secured by Stripe.';

function escapeHtml(value) {
    return K.escapeHtml(value);
}

function headerText(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function currencyCode(value) {
    const code = String(value || 'USD').toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : 'USD';
}

function money(value, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currencyCode(currency),
    }).format(Number(value || 0));
}

function titleCase(value) {
    return String(value || '')
        .replaceAll('_', ' ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function paymentMethodLabel(context) {
    if (context.payment_method === 'credit_card') {
        const brand = context.brand ? titleCase(context.brand) : 'Card';
        return context.last4 ? `${brand} ending ${context.last4}` : brand;
    }
    return titleCase(context.payment_method || 'Payment');
}

function numeric(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
}

function receiptSignerName(context) {
    const creator = headerText(context.created_by_name);
    const customerPaidOnline = context.customer_paid_online === true
        || creator.toLowerCase() === 'customer (online)';
    if (customerPaidOnline) return firstName(context.invoice_sender_name);
    if (creator && !customerPaidOnline) return firstName(creator);
    return firstName(context.invoice_sender_name);
}

function standaloneTotals(context, currency) {
    const jobNumber = context.job_seq ?? context.job_number;
    const jobLabel = jobNumber !== null && jobNumber !== undefined && jobNumber !== ''
        ? `#${jobNumber}`
        : context.receipt_job_id || context.job_id;
    return [
        jobLabel ? ['Payment for job', jobLabel] : null,
        context.service_name ? ['Service', context.service_name] : null,
        ['Amount paid', money(context.amount, currency), 'due'],
    ];
}

/**
 * Render the customer-facing receipt from the same canonical invoice model as
 * the attached PDF. `invoice_sender_name` is the latest owned invoice sent-event
 * actor, used only when the customer made the payment themselves.
 */
function buildPaymentReceiptEmail({
    context,
    invoice = null,
    brand = {},
    paymentLink = null,
}) {
    const companyName = headerText(brand.name) || 'Albusto';
    const emailBrand = {
        name: companyName,
        phone: headerText(brand.phone),
        email: headerText(brand.email),
    };
    const currency = currencyCode(context.currency || invoice?.currency);
    const customerFirstName = firstName(context.customer_name) || 'there';
    const invoiceNumber = invoice?.invoice_number || context.invoice_number || '';
    const shortNumber = shortDocNumber(invoiceNumber) || String(invoiceNumber).trim();
    const currentPayment = Math.max(numeric(context.amount), 0);
    const tip = Math.max(0, numeric(context.metadata?.tip));
    const signerName = receiptSignerName(context);
    const invoiceTotal = Math.max(numeric(invoice?.total), 0);
    const amountPaid = invoice
        ? Math.max(numeric(invoice.amount_paid), 0)
        : currentPayment;
    const remainingBalance = invoice
        ? (invoice.balance_due === null || invoice.balance_due === undefined
            ? Math.max(invoiceTotal - amountPaid, 0)
            : Math.max(numeric(invoice.balance_due), 0))
        : 0;
    const settled = Boolean(invoice) && remainingBalance <= 0;
    const leadText = invoice
        ? (settled
            ? `Hi ${K.escapeHtml(customerFirstName)} — thank you. Invoice <b>${K.escapeHtml(shortNumber)}</b> is now paid in full.`
            : `Hi ${K.escapeHtml(customerFirstName)} — thank you. We have recorded your payment against invoice <b>${K.escapeHtml(shortNumber)}</b>.`)
        : `Hi ${K.escapeHtml(customerFirstName)} — thank you. We have recorded your payment.`;
    const totalRows = invoice
        ? [
            ['Invoice total', money(invoiceTotal, currency)],
            ['Paid so far', `−${money(amountPaid, currency)}`],
            settled
                ? ['Nothing further due', '', 'due']
                : ['Remaining balance', money(remainingBalance, currency), 'due'],
        ]
        : standaloneTotals(context, currency);
    const canPayBalance = Boolean(invoice && remainingBalance > 0 && paymentLink);

    const html = K.shell(
        `Payment received — ${K.escapeHtml(money(currentPayment, currency))}`,
        K.lead(leadText)
        + K.facts([
            ['Payment date', formatDate(
                context.processed_at || context.created_at,
                context.company_timezone
            )],
            ['Payment method', paymentMethodLabel(context)],
            tip > 0 ? ['Includes tip', money(tip, currency)] : null,
        ])
        + K.totals(totalRows)
        + (canPayBalance
            ? K.quietLink(`Review & pay the remaining ${money(remainingBalance, currency)}`, paymentLink)
            : '')
        + (canPayBalance ? K.microcopy(STRIPE_TRUST) : '')
        + K.closing(invoice ? 'Your receipt is attached as a PDF.' : 'Keep this email for your records.')
        + (signerName ? K.signoff(signerName, companyName) : ''),
        emailBrand
    );

    const textLines = [
        `Payment received — ${money(currentPayment, currency)}`,
        `Hi ${customerFirstName},`,
        invoice
            ? (settled
                ? `Invoice ${shortNumber} is now paid in full.`
                : `We recorded your payment against invoice ${shortNumber}.`)
            : 'We recorded your payment.',
        `Payment date: ${formatDate(
            context.processed_at || context.created_at,
            context.company_timezone
        )}`,
        `Payment method: ${paymentMethodLabel(context)}`,
        tip > 0 ? `Includes tip: ${money(tip, currency)}` : null,
        invoice ? `Invoice total: ${money(invoiceTotal, currency)}` : null,
        invoice ? `Paid so far: -${money(amountPaid, currency)}` : `Amount paid: ${money(currentPayment, currency)}`,
        invoice && settled ? 'Nothing further due' : null,
        invoice && !settled ? `Remaining balance: ${money(remainingBalance, currency)}` : null,
        signerName ? `Thanks,\n${signerName}\n${companyName}` : null,
    ].filter(Boolean);

    return {
        subject: `Payment receipt from ${companyName}`,
        html,
        text: textLines.join('\n'),
    };
}

module.exports = {
    buildPaymentReceiptEmail,
    escapeHtml,
    money,
    paymentMethodLabel,
    receiptSignerName,
};
