'use strict';

const { buildInvoiceEmailBody } = require('../backend/src/services/documentEmailBody');

function invoice(overrides = {}) {
    return {
        invoice_number: 'INVOICE L-519-1',
        contact_name: 'Jordan Rivera',
        subtotal: '120.00',
        discount_amount: '10.00',
        tax_amount: '15.00',
        total: '125.00',
        amount_paid: '25.00',
        balance_due: '100.00',
        due_date: '2026-08-15',
        service_date: '2026-08-02T02:30:00.000Z',
        service_address: '123 Main St, Boston, MA 02110',
        items: [{
            name: 'Drain cleaning',
            description: 'Cleared the kitchen drain',
            amount: '125.00',
        }],
        ...overrides,
    };
}

test('renders total, paid, and canonical balance-due fields including the paid case', () => {
    const html = buildInvoiceEmailBody({
        invoice: invoice(),
        companyName: 'Boston Masters',
        senderName: 'Dana Scott',
        timeZone: 'America/New_York',
    });
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    expect(text).toContain('$100.00 still due by Aug 15');
    expect(text).toContain('Amount due $100.00');
    expect(text).toContain('Invoice total $125.00');
    expect(text).toContain('Paid so far −$25.00');
    expect(text).toContain('Thanks, Dana Boston Masters');
});

test('omits Total Paid when no payment has been made', () => {
    const html = buildInvoiceEmailBody({
        invoice: invoice({ amount_paid: '0.00', balance_due: '125.00' }),
        companyName: 'Boston Masters',
    });

    expect(html).not.toContain('Paid so far');
});

test('toggle on renders the Pay Invoice button with the existing public pay URL', () => {
    const html = buildInvoiceEmailBody({
        invoice: invoice(),
        companyName: 'Boston Masters',
        paymentLink: 'https://app.albusto.com/pay/tok_invABCDE',
    });

    expect(html).toContain('href="https://app.albusto.com/pay/tok_invABCDE"');
    expect(html).toContain('>Review &amp; pay $100.00</a>');
});

test('toggle off renders no button or payment link', () => {
    const html = buildInvoiceEmailBody({
        invoice: invoice(),
        companyName: 'Boston Masters',
        message: 'Please use https://app.albusto.com/pay/tok_invABCDE to pay.',
        paymentLink: 'https://app.albusto.com/pay/tok_invABCDE',
        includePaymentLink: false,
    });

    expect(html).not.toContain('Review &amp; pay');
    expect(html).not.toContain('/pay/');
    expect(html).not.toContain('tok_invABCDE');
});

test('omits missing due date and service address facts instead of rendering empty rows', () => {
    const html = buildInvoiceEmailBody({
        invoice: invoice({ due_date: null, service_address: null }),
        companyName: 'Boston Masters',
    });

    expect(html).not.toContain('Due by');
    expect(html).not.toContain('Service address');
    expect(html).toContain('Service date');
    expect(html).toContain('Aug 1, 2026');
});

test('HTML-escapes item names and descriptions', () => {
    const html = buildInvoiceEmailBody({
        invoice: invoice({
            items: [{
                name: '<img src=x onerror="alert(1)">',
                description: 'Repair & test <script>bad()</script>',
                amount: '125.00',
            }],
        }),
        companyName: 'Boston Masters',
    });

    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('Repair &amp; test &lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
});
