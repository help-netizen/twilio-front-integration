'use strict';

jest.mock('../backend/src/db/paymentsQueries');
jest.mock('../backend/src/db/invoicesQueries');
jest.mock('../backend/src/services/stripeConnectProvider', () => ({
    retrievePaymentIntent: jest.fn(),
    retrieveCharge: jest.fn(),
}));
jest.mock('../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: jest.fn(),
}));
jest.mock('../backend/src/services/emailService', () => ({
    sendEmail: jest.fn(),
}));
jest.mock('../backend/src/services/contactPropagationService', () => ({
    propagateContactDetails: jest.fn(),
}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    recordDocumentSendNote: jest.fn().mockResolvedValue(true),
}));
jest.mock('../backend/src/services/documentTemplatesService', () => ({
    resolveTemplate: jest.fn(),
}));
jest.mock('../backend/src/services/documentTemplates/pdfLogo', () => ({
    fetchPdfLogo: jest.fn(),
}));
jest.mock('../backend/src/services/invoicesService', () => ({
    generatePdf: jest.fn(),
}));

const paymentsQueries = require('../backend/src/db/paymentsQueries');
const stripeProvider = require('../backend/src/services/stripeConnectProvider');
const emailMailboxService = require('../backend/src/services/emailMailboxService');
const emailService = require('../backend/src/services/emailService');
const contactPropagationService = require('../backend/src/services/contactPropagationService');
const documentSendNoteService = require('../backend/src/services/documentSendNoteService');
const documentTemplatesService = require('../backend/src/services/documentTemplatesService');
const pdfLogo = require('../backend/src/services/documentTemplates/pdfLogo');
const invoicesService = require('../backend/src/services/invoicesService');
const paymentsService = require('../backend/src/services/paymentsService');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';
const ACTOR = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Agent',
    email: 'agent@example.com',
};
const SENT_AT = '2026-07-28T16:00:00.000Z';

function receiptContext(overrides = {}) {
    return {
        id: 71,
        company_id: COMPANY_A,
        contact_id: 5,
        invoice_id: null,
        job_id: 9,
        transaction_type: 'payment',
        payment_method: 'credit_card',
        status: 'completed',
        amount: '95.00',
        currency: 'USD',
        reference_number: 'PAY-71',
        external_id: 'pi_71',
        external_source: 'stripe',
        memo: 'Deposit',
        metadata: { payment_intent_id: 'pi_71' },
        processed_at: '2026-07-20T15:00:00.000Z',
        created_at: '2026-07-20T14:59:00.000Z',
        stripe_session_id: 11,
        stripe_payment_id: 'ch_71',
        stripe_payment_intent_id: 'pi_71',
        stripe_charge_id: 'ch_71',
        stripe_account_id: 'acct_71',
        stripe_livemode: false,
        stripe_customer_id: null,
        receipt_contact_id: 5,
        receipt_contact_email: 'customer@example.com',
        customer_email: 'customer@example.com',
        customer_name: 'Customer Name',
        receipt_job_id: 9,
        receipt_invoice_id: null,
        invoice_number: null,
        job_number: 'JOB-9',
        service_name: 'Repair',
        territory: 'Boston',
        company_timezone: 'America/New_York',
        created_by_name: 'Agent Smith',
        voided_by_name: null,
        brand: null,
        last4: null,
        ...overrides,
    };
}

function successfulClaim(overrides = {}) {
    return {
        receipt: {
            id: 501,
            transaction_id: 71,
            sent_to_email: 'customer@example.com',
            sent_via: 'email',
            sent_at: null,
            ...overrides,
        },
        claimed: true,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'connected' });
    documentTemplatesService.resolveTemplate.mockResolvedValue({
        brand: { name: 'Repair Co', logo_url: null },
    });
    pdfLogo.fetchPdfLogo.mockResolvedValue(null);
    paymentsQueries.claimReceiptDelivery.mockResolvedValue(successfulClaim());
    paymentsQueries.completeReceiptDelivery.mockResolvedValue({
        id: 501,
        sent_to_email: 'customer@example.com',
        sent_via: 'email',
        sent_at: SENT_AT,
    });
    paymentsQueries.releaseReceiptDelivery.mockResolvedValue(true);
    paymentsQueries.listReceiptHistory.mockResolvedValue([]);
    emailService.sendEmail.mockResolvedValue({ provider_message_id: 'gmail-1' });
    contactPropagationService.propagateContactDetails.mockResolvedValue({ email: 'added' });
    documentSendNoteService.recordDocumentSendNote.mockResolvedValue(true);
});

describe('paymentsService.getTransactionReceiptView', () => {
    test('returns only the custom receipt model and never resolves a Stripe hosted receipt', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());

        await expect(
            paymentsService.getTransactionReceiptView(COMPANY_A, 71)
        ).resolves.toEqual({
            receipt_type: 'custom',
            receipt: {
                transaction_id: 71,
                amount: '95.00',
                currency: 'USD',
                payment_method: 'credit_card',
                processed_at: '2026-07-20T15:00:00.000Z',
                created_at: '2026-07-20T14:59:00.000Z',
                reference_number: 'PAY-71',
                customer_name: 'Customer Name',
                job_id: 9,
            },
        });
        expect(stripeProvider.retrieveCharge).not.toHaveBeenCalled();
        expect(stripeProvider.retrievePaymentIntent).not.toHaveBeenCalled();
    });

    test('foreign or missing transaction is 404 before any provider request', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(null);

        await expect(
            paymentsService.getTransactionReceiptView(COMPANY_B, 71)
        ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(stripeProvider.retrieveCharge).not.toHaveBeenCalled();
    });
});

describe('paymentsService.getTransactionDetail', () => {
    test('returns flat owned detail, newest-first history, and genuine Stripe card/customer data', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());
        paymentsQueries.listReceiptHistory.mockResolvedValue([
            { to: 'new@example.com', sent_at: '2026-07-28T17:00:00.000Z', channel: 'email' },
            { to: 'old@example.com', sent_at: '2026-07-27T17:00:00.000Z', channel: 'email' },
        ]);
        stripeProvider.retrieveCharge.mockResolvedValue({
            customer: 'cus_real',
            payment_method_details: { card: { brand: 'visa', last4: '4242' } },
        });

        const detail = await paymentsService.getTransactionDetail(COMPANY_A, 71);

        expect(detail).toMatchObject({
            id: 71,
            invoice_id: null,
            job_id: 9,
            invoice_number: null,
            customer_name: 'Customer Name',
            created_by_name: 'Agent Smith',
            territory: 'Boston',
            stripe_payment_id: 'ch_71',
            stripe_customer_id: 'cus_real',
            brand: 'visa',
            last4: '4242',
            voided_by_name: null,
            receipt_history: [
                { to: 'new@example.com', sent_at: '2026-07-28T17:00:00.000Z', channel: 'email' },
                { to: 'old@example.com', sent_at: '2026-07-27T17:00:00.000Z', channel: 'email' },
            ],
        });
        expect(detail).not.toHaveProperty('stripe_account_id');
        expect(detail).not.toHaveProperty('customer_email');
        expect(paymentsQueries.listReceiptHistory).toHaveBeenCalledWith(COMPANY_A, 71);
    });

    test('Stripe enrichment failure leaves nullable fields without failing owned detail', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());
        stripeProvider.retrieveCharge.mockRejectedValue(new Error('Stripe unavailable'));

        await expect(paymentsService.getTransactionDetail(COMPANY_A, 71))
            .resolves.toMatchObject({ brand: null, last4: null, stripe_customer_id: null });
    });

    test('manual rows never use malicious Stripe identifiers for enrichment', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            payment_method: 'cash',
            external_source: 'manual',
            stripe_charge_id: 'ch_foreign',
            stripe_payment_intent_id: 'pi_foreign',
        }));

        await paymentsService.getTransactionDetail(COMPANY_A, 71);

        expect(stripeProvider.retrieveCharge).not.toHaveBeenCalled();
        expect(stripeProvider.retrievePaymentIntent).not.toHaveBeenCalled();
    });

    test('foreign detail is 404 before history or Stripe enrichment (T-foreign)', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(null);

        await expect(paymentsService.getTransactionDetail(COMPANY_B, 71))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(paymentsQueries.getTransactionReceiptContext).toHaveBeenCalledWith(COMPANY_B, 71);
        expect(paymentsQueries.listReceiptHistory).not.toHaveBeenCalled();
        expect(stripeProvider.retrieveCharge).not.toHaveBeenCalled();
    });
});

describe('paymentsService.emailTransactionReceipt', () => {
    test('sends a standalone Stripe-card payment through Gmail with no PDF or hosted URL', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());
        stripeProvider.retrieveCharge.mockResolvedValue({
            payment_method_details: { card: { brand: 'visa', last4: '4242' } },
        });

        const result = await paymentsService.emailTransactionReceipt(
            COMPANY_A,
            71,
            undefined,
            ACTOR,
            null,
            null,
            'review-send-71'
        );

        expect(emailService.sendEmail).toHaveBeenCalledWith(
            COMPANY_A,
            expect.objectContaining({
                to: 'customer@example.com',
                subject: 'Payment receipt from Repair Co',
                body: expect.stringContaining('Your payment receipt from Repair Co'),
                textBody: expect.stringContaining('Amount: $95.00'),
                files: [],
                userId: ACTOR.id,
                userEmail: ACTOR.email,
            })
        );
        expect(stripeProvider.retrieveCharge).toHaveBeenCalledWith('acct_71', 'ch_71');
        expect(emailService.sendEmail.mock.calls[0][1].body).toContain('Visa ending in 4242');
        expect(paymentsQueries.completeReceiptDelivery.mock.invocationCallOrder[0])
            .toBeGreaterThan(emailService.sendEmail.mock.invocationCallOrder[0]);
        expect(result).toEqual({
            sent: true,
            delivery: 'email',
            contact_email_saved: false,
            idempotent: false,
            receipt_history_entry: {
                to: 'customer@example.com',
                sent_at: SENT_AT,
                channel: 'email',
            },
        });
        expect(result).not.toHaveProperty('receipt_url');
    });

    test('invoice-linked payment attaches canonical invoice PDF and keeps invoice total distinct', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            invoice_id: 88,
            receipt_invoice_id: 88,
            invoice_number: 'INV-88',
            amount: '75.00',
            metadata: { tip: 5 },
        }));
        invoicesService.generatePdf.mockResolvedValue({
            invoice: {
                id: 88,
                invoice_number: 'INV-88',
                currency: 'USD',
                subtotal: '190.00',
                discount_amount: '0',
                tax_amount: '10.00',
                total: '200.00',
                items: [{
                    name: '<script>Repair</script>',
                    description: '<img src=x onerror=alert(1)>',
                    quantity: 1,
                    unit_price: '190.00',
                    amount: '190.00',
                }],
            },
            buffer: Buffer.from('canonical invoice pdf'),
        });

        await paymentsService.emailTransactionReceipt(
            COMPANY_A,
            71,
            'customer@example.com',
            ACTOR,
            null,
            null,
            'review-send-invoice-88'
        );

        expect(invoicesService.generatePdf).toHaveBeenCalledWith(COMPANY_A, 88);
        const message = emailService.sendEmail.mock.calls[0][1];
        expect(message.body).toContain('Invoice total');
        expect(message.body).toContain('$200.00');
        expect(message.body).toContain('Amount</td><td');
        expect(message.body).toContain('$75.00');
        expect(message.body).toContain('&lt;script&gt;Repair&lt;/script&gt;');
        expect(message.body).not.toContain('<script>Repair</script>');
        expect(message.files).toEqual([
            {
                originalname: 'Invoice-INV-88.pdf',
                mimetype: 'application/pdf',
                buffer: Buffer.from('canonical invoice pdf'),
            },
        ]);
    });

    test('ad-hoc job payment attaches the job invoice PDF (RECEIPT-INVOICE-PDF-001)', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            invoice_id: null,
            receipt_invoice_id: null,
            job_invoice_id: 91,
            invoice_number: 'INVOICE J-1597-1',
            amount: '1.00',
        }));
        invoicesService.generatePdf.mockResolvedValue({
            invoice: {
                id: 91,
                invoice_number: 'INVOICE J-1597-1',
                currency: 'USD',
                subtotal: '120.00',
                discount_amount: '0',
                tax_amount: '0',
                total: '120.00',
                items: [],
            },
            buffer: Buffer.from('job invoice pdf'),
        });

        await paymentsService.emailTransactionReceipt(
            COMPANY_A, 71, 'customer@example.com', ACTOR, null, null, 'adhoc-job-invoice',
        );

        expect(invoicesService.generatePdf).toHaveBeenCalledWith(COMPANY_A, 91);
        const message = emailService.sendEmail.mock.calls[0][1];
        // The doc word is not repeated in the file name (Invoice-J-1597-1, not Invoice-INVOICE-…).
        expect(message.files).toEqual([
            {
                originalname: 'Invoice-J-1597-1.pdf',
                mimetype: 'application/pdf',
                buffer: Buffer.from('job invoice pdf'),
            },
        ]);
    });

    test('a failing invoice PDF never blocks the receipt itself', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            invoice_id: null,
            receipt_invoice_id: null,
            job_invoice_id: 92,
            amount: '1.00',
        }));
        invoicesService.generatePdf.mockRejectedValue(new Error('render exploded'));

        await paymentsService.emailTransactionReceipt(
            COMPANY_A, 71, 'customer@example.com', ACTOR, null, null, 'adhoc-pdf-failure',
        );

        expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
        expect(emailService.sendEmail.mock.calls[0][1].files).toEqual([]);
    });

    test('writes successful history only after Gmail accepts the email', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());

        await paymentsService.emailTransactionReceipt(
            COMPANY_A, 71, 'customer@example.com', ACTOR, null, null, 'history-order-71'
        );

        expect(paymentsQueries.claimReceiptDelivery.mock.invocationCallOrder[0])
            .toBeLessThan(emailService.sendEmail.mock.invocationCallOrder[0]);
        expect(emailService.sendEmail.mock.invocationCallOrder[0])
            .toBeLessThan(paymentsQueries.completeReceiptDelivery.mock.invocationCallOrder[0]);
        expect(paymentsQueries.completeReceiptDelivery).toHaveBeenCalledWith(
            COMPANY_A,
            501,
            'gmail-1',
            null
        );
    });

    test('releases a pending marker when Gmail fails and never marks it sent', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());
        emailService.sendEmail.mockRejectedValue(new Error('Gmail unavailable'));

        await expect(paymentsService.emailTransactionReceipt(
            COMPANY_A, 71, 'customer@example.com', ACTOR, null, null, 'gmail-fail-71'
        )).rejects.toThrow('Gmail unavailable');

        expect(paymentsQueries.completeReceiptDelivery).not.toHaveBeenCalled();
        expect(paymentsQueries.releaseReceiptDelivery).toHaveBeenCalledWith(COMPANY_A, 501, null);
    });

    test('keeps mailbox-not-connected 409 and does not claim or send', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'disconnected' });

        await expect(paymentsService.emailTransactionReceipt(
            COMPANY_A, 71, 'customer@example.com', ACTOR, null, null, 'mailbox-off-71'
        )).rejects.toMatchObject({ code: 'MAILBOX_NOT_CONNECTED', httpStatus: 409 });

        expect(paymentsQueries.claimReceiptDelivery).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    test('completed idempotency replay returns history without a second email', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());
        paymentsQueries.claimReceiptDelivery.mockResolvedValue(successfulClaim({
            sent_at: SENT_AT,
        }));
        paymentsQueries.claimReceiptDelivery.mockResolvedValue({
            ...successfulClaim({ sent_at: SENT_AT }),
            claimed: false,
        });

        const result = await paymentsService.emailTransactionReceipt(
            COMPANY_A, 71, 'customer@example.com', ACTOR, null, null, 'stable-review-key'
        );

        expect(result.idempotent).toBe(true);
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(paymentsQueries.completeReceiptDelivery).not.toHaveBeenCalled();
    });

    test('foreign transaction is 404 before validation, history writes, or email (T-blast guard)', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(null);

        await expect(paymentsService.emailTransactionReceipt(
            COMPANY_B, 71, 'not-an-email', ACTOR, null, null, 'same-key-across-tenants'
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(paymentsQueries.claimReceiptDelivery).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(contactPropagationService.propagateContactDetails).not.toHaveBeenCalled();
    });
});
