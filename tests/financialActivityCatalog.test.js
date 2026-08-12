'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'backend', 'src');
const financialSources = [
    'services/eventService.js',
    'services/estimatesService.js',
    'services/invoicesService.js',
    'services/paymentsService.js',
    'services/paymentLedgerService.js',
    'services/zenbookerPaymentsSyncService.js',
    'services/portalService.js',
    'services/stripePaymentsService.js',
    'services/chatgptMcpWriteService.js',
].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');

test('the Phase 2 financial action catalog is wired with exact canonical keys', () => {
    const expected = [
        'estimate.created',
        'estimate.updated',
        'estimate.sent',
        'estimate.approved',
        'estimate.declined',
        'estimate.client_accepted',
        'estimate.client_declined',
        'estimate.converted',
        'estimate.linked_job',
        'estimate.link_created',
        'estimate.archived',
        'estimate.restored',
        'estimate.viewed',
        'invoice.created',
        'invoice.updated',
        'invoice.sent',
        'invoice.voided',
        'invoice.deleted',
        'invoice.payment_recorded',
        'invoice.payment_voided',
        'invoice.link_created',
        'invoice.link_sent',
        'invoice.card_session_started',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
        'invoice.refunded',
        'invoice.items_synced',
        'invoice.viewed',
        'payment.recorded',
        'payment.succeeded',
        'payment.failed',
        'payment.refunded',
        'payment.voided',
        'payment.disputed',
        'payment.receipt_sent',
        'payment.portal_submitted',
        'payment.session_started',
        'payment.session_canceled',
        'payment.check_deposited',
        'payment.check_deposit_reopened',
        'estimate.send_failed',
        'invoice.send_failed',
        'payment.receipt_send_failed',
        'refund.failed',
    ];

    for (const action of expected) {
        expect(financialSources).toContain(`'${action}'`);
    }
});

test('financial human routes never use Keycloak sub as an activity actor id', () => {
    for (const file of [
        'routes/estimates.js',
        'routes/invoices.js',
        'routes/payments.js',
    ]) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        expect(source).not.toMatch(/user\?\.\s*sub|user\.sub/);
    }
});
