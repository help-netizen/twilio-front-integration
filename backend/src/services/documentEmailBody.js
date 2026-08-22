'use strict';

const K = require('./documentEmailLayout');
const { shortDocNumber } = require('../utils/docNumber');

const STRIPE_TRUST = 'Card or bank — payments secured by Stripe.';

/**
 * Compatibility wrapper for preformatted service email bodies that are not one
 * of the customer document templates below.
 */
function buildEmailBody(message, link, { preformatted = false } = {}) {
    const content = preformatted
        ? String(message || '')
        : String(message || '').replace(/\r\n|\r|\n/g, '<br>');
    const anchor = link ? `<p><a href="${K.escapeHtml(link)}">View &amp; pay your invoice online</a></p>` : '';
    return `<div>${content}</div>${anchor}`;
}

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function firstName(value) {
    return String(value || '').trim().split(/\s+/)[0] || '';
}

function brandDetails(brand, companyName) {
    const source = brand && typeof brand === 'object' ? brand : {};
    return {
        name: String(source.name || companyName || '').trim() || 'Albusto',
        phone: String(source.phone || '').trim(),
        email: String(source.email || '').trim(),
    };
}

function formatDate(value, timeZone = 'America/New_York', { year = true } = {}) {
    if (!value) return '';
    const raw = String(value);
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const options = {
        month: 'short',
        day: 'numeric',
        ...(year ? { year: 'numeric' } : {}),
    };

    if (dateOnly) {
        const [, dateYear, month, day] = dateOnly;
        return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
            .format(new Date(Date.UTC(Number(dateYear), Number(month) - 1, Number(day))));
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
        return new Intl.DateTimeFormat('en-US', {
            ...options,
            timeZone: timeZone || 'America/New_York',
        }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en-US', {
            ...options,
            timeZone: 'America/New_York',
        }).format(date);
    }
}

function removePaymentLink(message, paymentLink) {
    let cleaned = String(message || '');
    const link = String(paymentLink || '');
    if (!link) return cleaned;

    const variants = [link];
    try {
        const path = new URL(link).pathname;
        if (path && path !== '/') variants.push(path);
    } catch { /* relative payment links are already covered by `link` */ }

    for (const variant of variants.sort((a, b) => b.length - a.length)) {
        cleaned = cleaned.split(variant).join('');
    }
    return cleaned;
}

function emailItems(items) {
    return (Array.isArray(items) ? items : []).map(item => ({
        name: String(item?.name || 'Item'),
        description: String(item?.description || '').trim(),
        qty: item?.quantity,
        rate: item?.unit_price,
        amount: item?.amount,
    }));
}

function invoiceState(model, amountPaid) {
    if (model.status === 'overdue') return 'overdue';
    if (amountPaid > 0) return 'partly_paid';
    return 'due';
}

function invoiceHeading(state, balanceDue, dueDate) {
    if (state === 'overdue') {
        return `${K.money(balanceDue)} — past due${dueDate ? ` since ${K.escapeHtml(dueDate)}` : ''}`;
    }
    const qualifier = state === 'partly_paid' ? ' still due' : ' due';
    return `${K.money(balanceDue)}${qualifier}${dueDate ? ` by ${K.escapeHtml(dueDate)}` : ''}`;
}

function invoiceLead({ state, contactFirstName, shortNumber, amountPaid, balanceDue, dueDate }) {
    const greeting = `Hi ${K.escapeHtml(contactFirstName)} — `;
    const reference = `<b>${K.escapeHtml(shortNumber)}</b>`;
    const due = `<b>${K.escapeHtml(K.money(balanceDue))}</b>`;
    const date = dueDate ? `<b>${K.escapeHtml(dueDate)}</b>` : '';

    if (state === 'overdue') {
        return greeting + (dueDate
            ? `invoice ${reference} was due on ${date} and is still open. Please review it and pay ${due} today.`
            : `invoice ${reference} is past due and still open. Please review it and pay ${due} today.`);
    }
    if (state === 'partly_paid') {
        return greeting + `thanks for the ${K.escapeHtml(K.money(amountPaid))} already paid. Please review invoice ${reference} and settle the remaining ${due}${dueDate ? ` by ${date}` : ''}.`;
    }
    return greeting + `the work is finished. Please review invoice ${reference} and pay ${due}${dueDate ? ` by ${date}` : ''}.`;
}

/** Build the approved due / partly-paid / overdue invoice document email. */
function buildInvoiceEmailBody({
    message,
    paymentLink,
    includePaymentLink = Boolean(paymentLink),
    invoice,
    brand,
    companyName,
    senderName,
    timeZone = 'America/New_York',
} = {}) {
    const model = invoice || {};
    const emailBrand = brandDetails(brand, companyName);
    const contactFirstName = firstName(model.contact_name) || 'there';
    const signerFirstName = firstName(senderName);
    const shortNumber = shortDocNumber(model.invoice_number) || String(model.invoice_number || '').trim();
    const dueDate = formatDate(model.due_date, timeZone, { year: false });
    const amountPaid = Math.max(number(model.amount_paid), 0);
    const balanceDue = Math.max(number(model.balance_due), 0);
    const state = invoiceState(model, amountPaid);
    const canPayOnline = includePaymentLink && Boolean(paymentLink);
    const operatorMessage = (includePaymentLink
        ? String(message || '')
        : removePaymentLink(message, paymentLink)).trim();
    const itemList = emailItems(model.items);
    const discount = number(model.discount_amount);
    const tax = number(model.tax_amount);
    const totalRows = [
        ['Subtotal', K.money(model.subtotal)],
        discount !== 0 ? ['Discount', `−${K.money(Math.abs(discount))}`] : null,
        tax !== 0 ? ['Tax', K.money(tax)] : null,
        amountPaid > 0 ? ['Invoice total', K.money(model.total)] : null,
        amountPaid > 0 ? ['Paid so far', `−${K.money(amountPaid)}`] : null,
        ['Amount due', K.money(balanceDue), 'due'],
    ];
    const factRows = state === 'overdue'
        ? [
            ['Invoice date', formatDate(model.created_at, timeZone)],
            ['Due', formatDate(model.due_date, timeZone)],
        ]
        : [
            ['Service date', formatDate(model.service_date, timeZone)],
            ['Service address', String(model.service_address || '').trim()],
        ];
    const closingText = state === 'overdue'
        ? 'Already paid, or something looks wrong? Reply and we will check it right away. The PDF is attached.'
        : 'Something looks wrong? Reply to this email and we will sort it out. The PDF is attached.';

    return K.shell(
        invoiceHeading(state, balanceDue, dueDate),
        K.lead(invoiceLead({
            state,
            contactFirstName,
            shortNumber,
            amountPaid,
            balanceDue,
            dueDate,
        }))
        + (canPayOnline ? K.button(`Review & pay ${K.money(balanceDue)}`, paymentLink) : '')
        + (canPayOnline ? K.microcopy(STRIPE_TRUST) : '')
        + K.facts(factRows)
        + (itemList.length > 0 ? K.items(itemList) : '')
        + K.totals(totalRows)
        + (canPayOnline ? K.quietLink(`Review & pay ${K.money(balanceDue)}`, paymentLink) : '')
        + K.note(operatorMessage, signerFirstName)
        + K.closing(closingText)
        + K.signoff(signerFirstName, emailBrand.name),
        emailBrand
    );
}

/** Build the approved estimate document, including job-level credit after tax. */
function buildEstimateEmailBody({
    message,
    estimateLink,
    estimate,
    brand,
    companyName,
    senderName,
    timeZone = 'America/New_York',
} = {}) {
    const model = estimate || {};
    const emailBrand = brandDetails(brand, companyName);
    const contactFirstName = firstName(model.contact_name) || 'there';
    const signerFirstName = firstName(senderName);
    const shortNumber = shortDocNumber(model.estimate_number) || String(model.estimate_number || '').trim();
    const total = Math.max(number(model.total), 0);
    const paid = Math.max(number(model.deposit_paid), 0);
    const left = model.balance_due === null || model.balance_due === undefined
        ? Math.max(total - paid, 0)
        : Math.max(number(model.balance_due), 0);
    const validUntil = formatDate(model.valid_until, timeZone, { year: false });
    const reference = `<b>${K.escapeHtml(shortNumber)}</b>`;
    const paidLead = paid > 0
        ? `, less the <b>${K.escapeHtml(K.money(paid))}</b> you have paid so far on this job — <b>${K.escapeHtml(K.money(left))}</b> to go. Approve it and we will get you on the schedule.`
        : '. Approve it and we will get you on the schedule; nothing is charged until you do.';
    const leadText = `Hi ${K.escapeHtml(contactFirstName)} — here is estimate ${reference} for the work we discussed: <b>${K.escapeHtml(K.money(total))}</b>${paidLead}`;
    const itemList = emailItems(model.items);
    const discount = number(model.discount_amount);
    const tax = number(model.tax_amount);

    return K.shell(
        `Your estimate — ${K.escapeHtml(K.money(total))}`,
        K.lead(leadText)
        + K.button('Approve this estimate', estimateLink)
        + K.microcopy(`One tap, no account needed.${validUntil ? ` Valid until ${validUntil}.` : ''}`)
        + K.facts([
            ['Service address', String(model.billing_address || model.service_address || '').trim()],
        ])
        + (itemList.length > 0 ? K.items(itemList) : '')
        + K.totals([
            ['Subtotal', K.money(model.subtotal)],
            discount !== 0 ? ['Discount', `−${K.money(Math.abs(discount))}`] : null,
            tax !== 0 ? ['Tax', K.money(tax)] : null,
            ['Estimate total', K.money(total), paid > 0 ? undefined : 'due'],
            paid > 0 ? ['Paid so far', `−${K.money(paid)}`] : null,
            paid > 0 ? ['Left to pay', K.money(left), 'due'] : null,
        ])
        + K.quietLink('Approve this estimate', estimateLink)
        + K.note(message, signerFirstName)
        + K.closing('Want to change something first? Reply to this email. The PDF is attached.')
        + K.signoff(signerFirstName, emailBrand.name),
        emailBrand
    );
}

module.exports = {
    buildEmailBody,
    buildInvoiceEmailBody,
    buildEstimateEmailBody,
    formatDate,
    firstName,
};
