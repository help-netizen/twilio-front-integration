'use strict';

const {
    buildPaymentReceiptEmail,
} = require('../backend/src/services/paymentReceiptTemplate');

function context(overrides = {}) {
    return {
        amount: '75.00',
        currency: 'USD',
        payment_method: 'credit_card',
        brand: 'visa',
        last4: '4242',
        customer_name: '<Owner & Co>',
        processed_at: '2026-07-28T16:00:00.000Z',
        company_timezone: 'America/New_York',
        metadata: { tip: 5 },
        job_number: 'JOB-9',
        service_name: 'Repair',
        ...overrides,
    };
}

test('RECEIPT-TOTAL-SWAP: invoice HTML uses canonical invoice totals, not payment amount', () => {
    const receipt = buildPaymentReceiptEmail({
        context: context(),
        brand: { name: 'Repair Co' },
        invoice: {
            invoice_number: 'INV-88',
            subtotal: '190.00',
            discount_amount: '0',
            tax_amount: '10.00',
            total: '200.00',
            currency: 'USD',
            items: [{
                name: 'Repair',
                quantity: 1,
                unit_price: '190.00',
                amount: '190.00',
            }],
        },
    });

    expect(receipt.html).toContain('Invoice total');
    expect(receipt.html).toContain('$200.00');
    expect(receipt.html).toContain('$75.00');
    expect(receipt.html).toContain('Includes tip');
    expect(receipt.html).toContain('$5.00');
});

test('RECEIPT-HTML-INJECT: escapes every customer, brand, job, and item string', () => {
    const receipt = buildPaymentReceiptEmail({
        context: context({
            customer_name: '<img src=x onerror=alert(1)>',
            service_name: '<script>service()</script>',
        }),
        brand: { name: 'Co <script>brand()</script>' },
        invoice: {
            invoice_number: '<INV>',
            subtotal: 1,
            tax_amount: 0,
            discount_amount: 0,
            total: 1,
            items: [{
                name: '<script>item()</script>',
                description: '<img src=x>',
                quantity: 1,
                unit_price: 1,
                amount: 1,
            }],
        },
    });

    expect(receipt.html).toContain('&lt;script&gt;item()&lt;/script&gt;');
    expect(receipt.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(receipt.html).not.toContain('<script>');
    expect(receipt.html).not.toContain('<img src=x');
});

test('standalone job receipt has a payment summary and no invented invoice lines', () => {
    const receipt = buildPaymentReceiptEmail({
        context: context(),
        brand: { name: 'Repair Co' },
    });

    expect(receipt.html).toContain('Payment summary');
    expect(receipt.html).toContain('#JOB-9');
    expect(receipt.html).toContain('Repair');
    expect(receipt.html).not.toContain('Invoice total');
    expect(receipt.html).not.toContain('<thead>');
});

test('standalone job receipt prefers job_seq over the legacy number and internal id', () => {
    const receipt = buildPaymentReceiptEmail({
        context: context({
            job_seq: 171,
            job_number: 'ZB-9',
            receipt_job_id: 9,
        }),
        brand: { name: 'Repair Co' },
    });

    expect(receipt.html).toContain('>Payment for job</td>');
    expect(receipt.html).toContain('>#171</td>');
    expect(receipt.html).not.toContain('#ZB-9');
});
