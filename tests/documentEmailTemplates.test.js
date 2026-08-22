'use strict';

const { parseHTML } = require('linkedom');
const {
    buildEstimateEmailBody,
    buildInvoiceEmailBody,
} = require('../backend/src/services/documentEmailBody');
const {
    buildPaymentReceiptEmail,
} = require('../backend/src/services/paymentReceiptTemplate');

const BRAND = {
    name: 'ABC Homes',
    phone: '(617) 555-0134',
    email: 'help@abchomes.com',
};

function invoice(overrides = {}) {
    return {
        invoice_number: 'INVOICE J-1516-1',
        status: 'sent',
        contact_name: 'Dana Customer',
        subtotal: '100.00',
        discount_amount: '10.00',
        tax_amount: '5.00',
        total: '95.00',
        amount_paid: '0.00',
        balance_due: '95.00',
        due_date: '2026-08-23',
        created_at: '2026-08-18T16:00:00.000Z',
        service_date: '2026-08-18T16:00:00.000Z',
        service_address: '18 Marlborough St, Boston, MA 02116',
        items: [
            {
                name: 'Service call fee',
                description: 'Trip and diagnostic included.',
                quantity: 1,
                unit_price: '50.00',
                amount: '50.00',
            },
            {
                name: 'Door seal',
                quantity: 2,
                unit_price: '25.00',
                amount: '50.00',
            },
        ],
        ...overrides,
    };
}

function estimate(overrides = {}) {
    return {
        estimate_number: 'ESTIMATE L-1516-3',
        contact_name: 'Dana Customer',
        subtotal: '280.00',
        discount_amount: '0.00',
        tax_amount: '20.00',
        total: '300.00',
        deposit_paid: '95.00',
        balance_due: '205.00',
        valid_until: '2026-09-01',
        billing_address: '18 Marlborough St, Boston, MA 02116',
        items: [
            {
                name: 'Dishwasher repair — labour',
                quantity: 1,
                unit_price: '210.00',
                amount: '210.00',
            },
            {
                name: 'Parts',
                quantity: 2,
                unit_price: '35.00',
                amount: '70.00',
            },
        ],
        ...overrides,
    };
}

function receiptContext(overrides = {}) {
    return {
        amount: '60.00',
        currency: 'USD',
        payment_method: 'credit_card',
        brand: 'visa',
        last4: '6208',
        customer_name: 'Dana Customer',
        processed_at: '2026-08-18T16:00:00.000Z',
        company_timezone: 'America/New_York',
        metadata: {},
        created_by_name: 'Mike Operator',
        invoice_sender_name: 'Dana Sender',
        ...overrides,
    };
}

function documentFor(html) {
    return parseHTML(html).document;
}

function renderedText(html) {
    const document = documentFor(html);
    for (const node of document.querySelectorAll('style, script')) node.remove();
    for (const node of document.querySelectorAll('br')) node.replaceWith(' ');
    return document.body.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderedRows(html) {
    const rows = new Map();
    for (const row of documentFor(html).querySelectorAll('tr')) {
        const cells = Array.from(row.children).filter(node => node.localName === 'td');
        if (cells.length !== 2) continue;
        const label = cells[0].textContent.replace(/\s+/g, ' ').trim();
        const value = cells[1].textContent.replace(/\s+/g, ' ').trim();
        if (label) rows.set(label, value);
    }
    return rows;
}

function amount(value) {
    const normalized = String(value || '').replace(/[$,\s]/g, '');
    const sign = /^[−-]/.test(normalized) ? -1 : 1;
    return sign * Number(normalized.replace(/^[−-]/, ''));
}

function expectApprovedShell(html) {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('@media only screen and (max-width: 600px)');
    expect(html).toContain('max-width:600px');
    expect(html).not.toMatch(/<table[^>]+width="(?:600|640)"/i);

    const inlineStyles = Array.from(html.matchAll(/style="([^"]*)"/g), match => match[1]);
    const sizes = new Set();
    const families = new Set();
    for (const style of inlineStyles) {
        for (const match of style.matchAll(/font-size:(\d+)px/g)) {
            if (match[1] !== '0') sizes.add(Number(match[1]));
        }
        for (const match of style.matchAll(/font-family:([^;]+)/g)) {
            families.add(match[1].trim());
        }
    }
    expect([...sizes].sort((a, b) => a - b)).toEqual([13, 15, 24]);
    expect([...families]).toEqual(['Arial, Helvetica, sans-serif']);
}

function expectNoDoubledNumber(text) {
    expect(text).not.toMatch(/invoice\s+#?\s*INVOICE\b/i);
    expect(text).not.toMatch(/estimate\s+#?\s*ESTIMATE\b/i);
    expect(text).not.toMatch(/#(?:INVOICE|ESTIMATE)\b/i);
}

test('invoice renders due, partly-paid, and overdue states with CTA above items', () => {
    const dueHtml = buildInvoiceEmailBody({
        invoice: invoice(),
        paymentLink: 'https://app.albusto.com/pay/token',
        brand: BRAND,
        senderName: 'Dana Scott',
    });
    const partlyHtml = buildInvoiceEmailBody({
        invoice: invoice({ amount_paid: '20.00', balance_due: '75.00' }),
        paymentLink: 'https://app.albusto.com/pay/token',
        brand: BRAND,
        senderName: 'Dana Scott',
    });
    const overdueHtml = buildInvoiceEmailBody({
        invoice: invoice({ status: 'overdue' }),
        paymentLink: 'https://app.albusto.com/pay/token',
        brand: BRAND,
        senderName: 'Dana Scott',
    });
    const dueText = renderedText(dueHtml);
    const partlyText = renderedText(partlyHtml);
    const partlyRows = renderedRows(partlyHtml);

    expect(dueText).toContain('$95.00 due by Aug 23');
    expect(dueText).not.toContain('Paid so far');
    expect(partlyText).toContain('$75.00 still due by Aug 23');
    expect(partlyText).toContain('Card or bank — payments secured by Stripe.');
    expect(renderedText(overdueHtml)).toContain('$95.00 — past due since Aug 23');
    expect(partlyHtml.indexOf('Review &amp; pay $75.00'))
        .toBeLessThan(partlyHtml.indexOf('>Summary</td>'));

    expect(amount(partlyRows.get('Subtotal'))
        + amount(partlyRows.get('Discount'))
        + amount(partlyRows.get('Tax')))
        .toBe(amount(partlyRows.get('Invoice total')));
    expect(amount(partlyRows.get('Invoice total')) + amount(partlyRows.get('Paid so far')))
        .toBe(amount(partlyRows.get('Amount due')));
    expect(dueText).not.toContain('1 ×');
    expect(dueText).toContain('2 × $25.00');
    expectNoDoubledNumber(partlyText);
});

test('estimate renders the full document and deducts job credit after tax', () => {
    const creditHtml = buildEstimateEmailBody({
        estimate: estimate(),
        estimateLink: 'https://app.albusto.com/e/token',
        brand: BRAND,
        senderName: 'Dana Scott',
        message: 'The pump is on order.',
    });
    const unpaidHtml = buildEstimateEmailBody({
        estimate: estimate({ deposit_paid: '0.00', balance_due: '300.00' }),
        estimateLink: 'https://app.albusto.com/e/token',
        brand: BRAND,
        senderName: 'Dana Scott',
    });
    const text = renderedText(creditHtml);
    const rows = renderedRows(creditHtml);

    expect(text).toContain('Your estimate — $300.00');
    expect(text).toContain('Approve this estimate');
    expect(text).toContain('A note from Dana The pump is on order.');
    expect(amount(rows.get('Subtotal')) + amount(rows.get('Tax')))
        .toBe(amount(rows.get('Estimate total')));
    expect(amount(rows.get('Estimate total')) + amount(rows.get('Paid so far')))
        .toBe(amount(rows.get('Left to pay')));
    expect(text).not.toContain('1 ×');
    expect(text).toContain('2 × $35.00');
    expect(renderedText(unpaidHtml)).not.toContain('Paid so far');
    expect(renderedText(unpaidHtml)).not.toContain('Left to pay');
    expectNoDoubledNumber(text);
});

test('receipt renders remaining and settled balances and resolves the required person', () => {
    const remainingReceipt = buildPaymentReceiptEmail({
        context: receiptContext(),
        invoice: {
            invoice_number: 'INVOICE J-1516-1',
            total: '210.70',
            amount_paid: '60.00',
            balance_due: '150.70',
            currency: 'USD',
        },
        brand: BRAND,
        paymentLink: 'https://app.albusto.com/pay/token',
    });
    const settledReceipt = buildPaymentReceiptEmail({
        context: receiptContext({
            amount: '150.70',
            created_by_name: 'Link Maker',
            customer_paid_online: true,
        }),
        invoice: {
            invoice_number: 'INVOICE J-1516-1',
            total: '210.70',
            amount_paid: '210.70',
            balance_due: '0.00',
            currency: 'USD',
        },
        brand: BRAND,
    });
    const remainingText = renderedText(remainingReceipt.html);
    const remainingRows = renderedRows(remainingReceipt.html);
    const settledText = renderedText(settledReceipt.html);

    expect(remainingText).toContain('Remaining balance $150.70');
    expect(amount(remainingRows.get('Invoice total')) + amount(remainingRows.get('Paid so far')))
        .toBe(amount(remainingRows.get('Remaining balance')));
    expect(remainingText).toContain('Thanks, Mike ABC Homes');
    expect(settledText).toContain('Nothing further due');
    expect(settledText).not.toContain('Remaining balance');
    expect(settledText).toContain('Thanks, Dana ABC Homes');
    expectNoDoubledNumber(remainingText);
    expectNoDoubledNumber(settledText);
});

test('all three rendered email documents keep the approved fluid shell and type system', () => {
    const documents = [
        buildInvoiceEmailBody({
            invoice: invoice(),
            paymentLink: '/pay/token',
            brand: BRAND,
            senderName: 'Dana',
        }),
        buildEstimateEmailBody({
            estimate: estimate(),
            estimateLink: '/e/token',
            brand: BRAND,
            senderName: 'Dana',
        }),
        buildPaymentReceiptEmail({
            context: receiptContext(),
            invoice: {
                invoice_number: 'INVOICE J-1516-1',
                total: '210.70',
                amount_paid: '60.00',
                balance_due: '150.70',
            },
            brand: BRAND,
            paymentLink: '/pay/token',
        }).html,
    ];

    for (const html of documents) expectApprovedShell(html);
});
