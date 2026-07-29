'use strict';

const { shortDocNumber } = require('../utils/docNumber');

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
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

function formatDate(value, timezone) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
        return new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: timezone || 'America/New_York',
        }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'America/New_York',
        }).format(date);
    }
}

function titleCase(value) {
    return String(value || '')
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function paymentMethodLabel(context) {
    if (context.payment_method === 'credit_card') {
        const brand = context.brand ? titleCase(context.brand) : 'Card';
        return context.last4 ? `${brand} ending in ${context.last4}` : brand;
    }
    return titleCase(context.payment_method || 'Payment');
}

function detailRow(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<tr><td style="padding:3px 16px 3px 0;color:#667085;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(label)}</td>`
        + `<td style="padding:3px 0;color:#101828;font-size:14px;text-align:right">${escapeHtml(value)}</td></tr>`;
}

function totalRow(label, value, { strong = false } = {}) {
    return `<tr><td style="padding:5px 12px;color:#475467;${strong ? 'font-weight:700;' : ''}">${escapeHtml(label)}</td>`
        + `<td style="padding:5px 12px;text-align:right;color:#101828;${strong ? 'font-weight:700;' : ''}">${escapeHtml(value)}</td></tr>`;
}

function renderInvoiceSummary(invoice, currency) {
    const items = Array.isArray(invoice?.items) ? invoice.items : [];
    const itemRows = items.map((item) => {
        const description = item.description
            ? `<div style="margin-top:3px;color:#667085;font-size:12px">${escapeHtml(item.description)}</div>`
            : '';
        const quantity = Number(item.quantity || 0);
        const unitPrice = money(item.unit_price, currency);
        return `<tr>`
            + `<td style="padding:12px;border-bottom:1px solid #eaecf0;color:#101828"><strong>${escapeHtml(item.name)}</strong>${description}</td>`
            + `<td style="padding:12px;border-bottom:1px solid #eaecf0;color:#475467;text-align:right;white-space:nowrap">${escapeHtml(`${quantity} × ${unitPrice}`)}</td>`
            + `<td style="padding:12px;border-bottom:1px solid #eaecf0;color:#101828;text-align:right;white-space:nowrap">${escapeHtml(money(item.amount, currency))}</td>`
            + `</tr>`;
    }).join('');
    const discount = Number(invoice.discount_amount || 0);
    const tax = Number(invoice.tax_amount || 0);

    return `<h2 style="margin:32px 0 12px;color:#101828;font-size:14px;letter-spacing:.08em;text-transform:uppercase">Summary</h2>`
        + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eaecf0;border-radius:8px">`
        + `<thead><tr style="background:#f9fafb"><th style="padding:10px 12px;text-align:left;color:#475467;font-size:12px">Item</th>`
        + `<th style="padding:10px 12px;text-align:right;color:#475467;font-size:12px">Quantity / rate</th>`
        + `<th style="padding:10px 12px;text-align:right;color:#475467;font-size:12px">Amount</th></tr></thead>`
        + `<tbody>${itemRows}</tbody>`
        + `<tfoot>${totalRow('Subtotal', money(invoice.subtotal, currency))}`
        + `${discount ? totalRow('Discount', `-${money(discount, currency)}`) : ''}`
        + `${tax ? totalRow('Tax', money(tax, currency)) : ''}`
        + `${totalRow('Invoice total', money(invoice.total, currency), { strong: true })}</tfoot></table>`;
}

function renderStandaloneSummary(context, currency) {
    const jobLabel = context.job_number ? `#${context.job_number}` : context.receipt_job_id || context.job_id;
    return `<h2 style="margin:32px 0 12px;color:#101828;font-size:14px;letter-spacing:.08em;text-transform:uppercase">Payment summary</h2>`
        + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eaecf0;border-radius:8px">`
        + `${jobLabel ? totalRow('Payment for job', jobLabel) : ''}`
        + `${context.service_name ? totalRow('Service', context.service_name) : ''}`
        + `${totalRow('Amount paid', money(context.amount, currency), { strong: true })}</table>`;
}

/**
 * Render the customer-facing receipt. The invoice object comes directly from
 * invoicesService.generatePdf, keeping HTML totals and the attached PDF on the
 * same canonical invoice/item data.
 */
function buildPaymentReceiptEmail({
    context,
    invoice = null,
    brand = {},
    logoContentId = null,
}) {
    const companyName = headerText(brand.name) || 'Albusto';
    const currency = currencyCode(context.currency || invoice?.currency);
    const customerName = context.customer_name ? ` ${escapeHtml(context.customer_name)}` : '';
    const invoiceNumber = invoice?.invoice_number || context.invoice_number || null;
    const tip = Math.max(0, Number(context.metadata?.tip || 0) || 0);
    const logo = logoContentId
        ? `<img src="cid:${escapeHtml(logoContentId)}" alt="${escapeHtml(companyName)}" style="display:block;max-height:56px;max-width:180px;margin-bottom:16px">`
        : `<div style="margin-bottom:16px;color:#101828;font-size:20px;font-weight:700">${escapeHtml(companyName)}</div>`;
    const intro = invoice
        ? `Your copy of Invoice ${escapeHtml(shortDocNumber(invoiceNumber) || invoiceNumber)} is attached.`
        : 'Here is the summary of your recent payment.';

    const html = `<div style="margin:0;padding:24px;background:#f2f4f7;font-family:Arial,sans-serif;color:#344054">`
        + `<div style="max-width:680px;margin:0 auto;padding:32px;background:#ffffff;border-radius:12px">`
        + logo
        + `<h1 style="margin:0 0 20px;color:#101828;font-size:26px">Your payment receipt from ${escapeHtml(companyName)}</h1>`
        + `<p style="margin:0 0 8px">Hi${customerName},</p>`
        + `<p style="margin:0 0 24px;line-height:1.6">Thank you for your recent payment. ${intro}</p>`
        + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>`
        + `<td style="vertical-align:top"></td><td style="vertical-align:top;text-align:right">`
        + `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-left:auto">`
        + `${detailRow('Invoice', invoiceNumber ? `#${invoiceNumber}` : null)}`
        + `${detailRow('Payment date', formatDate(context.processed_at || context.created_at, context.company_timezone))}`
        + `${detailRow('Payment method', paymentMethodLabel(context))}`
        + `${detailRow('Amount', money(context.amount, currency))}`
        + `${tip ? detailRow('Includes tip', money(tip, currency)) : ''}`
        + `</table></td></tr></table>`
        + `${invoice ? renderInvoiceSummary(invoice, currency) : renderStandaloneSummary(context, currency)}`
        + `<p style="margin:28px 0 0;color:#667085;font-size:13px">Thank you for choosing ${escapeHtml(companyName)}.</p>`
        + `</div></div>`;

    const textLines = [
        `Your payment receipt from ${companyName}`,
        `Hi${context.customer_name ? ` ${headerText(context.customer_name)}` : ''},`,
        'Thank you for your recent payment.',
        invoice ? `Invoice ${headerText(shortDocNumber(invoiceNumber) || invoiceNumber)} is attached.` : 'Payment summary:',
        `Payment date: ${formatDate(context.processed_at || context.created_at, context.company_timezone)}`,
        `Payment method: ${paymentMethodLabel(context)}`,
        `Amount: ${money(context.amount, currency)}`,
        tip ? `Includes tip: ${money(tip, currency)}` : null,
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
};
