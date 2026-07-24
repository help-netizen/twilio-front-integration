'use strict';

jest.mock('../backend/src/db/paymentsQueries');
jest.mock('../backend/src/db/invoicesQueries');
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/stripeConnectProvider', () => ({
    retrievePaymentIntent: jest.fn(),
    retrieveCharge: jest.fn(),
    updateChargeReceiptEmail: jest.fn(),
}));
jest.mock('../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: jest.fn(),
}));
jest.mock('../backend/src/services/emailService', () => ({
    sendEmail: jest.fn(),
}));
jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: jest.fn(),
}));
jest.mock('../backend/src/services/contactPropagationService', () => ({
    propagateContactDetails: jest.fn(),
}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    recordDocumentSendNote: jest.fn().mockResolvedValue(true),
}));

const paymentsQueries = require('../backend/src/db/paymentsQueries');
const stripeProvider = require('../backend/src/services/stripeConnectProvider');
const emailMailboxService = require('../backend/src/services/emailMailboxService');
const emailService = require('../backend/src/services/emailService');
const companyQueries = require('../backend/src/db/companyQueries');
const contactPropagationService = require('../backend/src/services/contactPropagationService');
const documentSendNoteService = require('../backend/src/services/documentSendNoteService');
const paymentsService = require('../backend/src/services/paymentsService');

const COMPANY = '00000000-0000-0000-0000-0000000000aa';
const ACTOR = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Agent',
    email: 'agent@example.com',
};

function receiptContext(overrides = {}) {
    return {
        id: 71,
        company_id: COMPANY,
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
        metadata: { payment_intent_id: 'pi_71' },
        processed_at: '2026-07-20T15:00:00.000Z',
        created_at: '2026-07-20T14:59:00.000Z',
        stripe_session_id: 11,
        stripe_payment_intent_id: 'pi_71',
        stripe_charge_id: 'ch_71',
        stripe_account_id: 'acct_71',
        stripe_livemode: false,
        receipt_contact_id: 5,
        receipt_contact_email: 'customer@example.com',
        customer_email: 'customer@example.com',
        customer_name: 'Customer Name',
        receipt_job_id: 9,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'connected' });
    companyQueries.getCompanyById.mockResolvedValue({ name: 'Repair Co' });
    contactPropagationService.propagateContactDetails.mockResolvedValue({ email: 'added' });
    documentSendNoteService.recordDocumentSendNote.mockResolvedValue(true);
});

describe('paymentsService.getTransactionReceiptView', () => {
    test('returns Stripe hosted receipt access for an owned card payment', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());
        stripeProvider.retrieveCharge.mockResolvedValue({
            id: 'ch_71',
            receipt_url: 'https://pay.stripe.com/receipts/71',
        });

        await expect(
            paymentsService.getTransactionReceiptView(COMPANY, 71)
        ).resolves.toEqual({
            receipt_type: 'stripe',
            receipt_url: 'https://pay.stripe.com/receipts/71',
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
        expect(paymentsQueries.getTransactionReceiptContext).toHaveBeenCalledWith(COMPANY, 71);
        expect(stripeProvider.retrieveCharge).toHaveBeenCalledWith('acct_71', 'ch_71');
    });

    test('resolves the Charge through the PaymentIntent when the session lacks a charge id', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            stripe_charge_id: null,
        }));
        stripeProvider.retrievePaymentIntent.mockResolvedValue({
            id: 'pi_71',
            status: 'succeeded',
            latest_charge: { id: 'ch_from_pi' },
        });
        stripeProvider.retrieveCharge.mockResolvedValue({
            receipt_url: 'https://pay.stripe.com/receipts/from-pi',
        });

        await paymentsService.getTransactionReceiptView(COMPANY, 71);

        expect(stripeProvider.retrievePaymentIntent).toHaveBeenCalledWith('acct_71', 'pi_71');
        expect(stripeProvider.retrieveCharge).toHaveBeenCalledWith('acct_71', 'ch_from_pi');
    });

    test('returns a recorded receipt model for cash even if malicious Stripe ids are present', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            payment_method: 'cash',
            external_source: 'manual',
            external_id: 'pi_should_not_escape',
            stripe_payment_intent_id: 'pi_should_not_escape',
            stripe_charge_id: 'ch_should_not_escape',
        }));

        const result = await paymentsService.getTransactionReceiptView(COMPANY, 71);

        expect(result.receipt_type).toBe('recorded');
        expect(result.receipt_url).toBeNull();
        expect(stripeProvider.retrieveCharge).not.toHaveBeenCalled();
        expect(stripeProvider.retrievePaymentIntent).not.toHaveBeenCalled();
    });

    test('foreign or missing transaction is 404 before any Stripe request', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(null);

        await expect(
            paymentsService.getTransactionReceiptView(COMPANY, 71)
        ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(stripeProvider.retrieveCharge).not.toHaveBeenCalled();
        expect(stripeProvider.retrievePaymentIntent).not.toHaveBeenCalled();
    });
});

describe('paymentsService.emailTransactionReceipt', () => {
    test('emails a Stripe-native receipt and records the job note', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext());
        stripeProvider.updateChargeReceiptEmail.mockResolvedValue({
            receipt_url: 'https://pay.stripe.com/receipts/71',
        });

        const result = await paymentsService.emailTransactionReceipt(
            COMPANY,
            71,
            undefined,
            ACTOR
        );

        expect(stripeProvider.updateChargeReceiptEmail).toHaveBeenCalledWith(
            'acct_71',
            'ch_71',
            'customer@example.com'
        );
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(documentSendNoteService.recordDocumentSendNote).toHaveBeenCalledWith({
            companyId: COMPANY,
            jobId: 9,
            actor: ACTOR,
            documentType: 'receipt',
            amount: '95.00',
            channel: 'email',
            recipient: 'customer@example.com',
        });
        expect(result).toEqual({
            sent: true,
            delivery: 'stripe',
            receipt_url: 'https://pay.stripe.com/receipts/71',
            contact_email_saved: false,
        });
    });

    test('uses the real company mailbox for a cash receipt, then records the job note', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            payment_method: 'cash',
            external_source: 'manual',
            external_id: null,
            metadata: {},
            stripe_session_id: null,
            stripe_payment_intent_id: null,
            stripe_charge_id: null,
            stripe_account_id: null,
        }));
        emailService.sendEmail.mockResolvedValue({ provider_message_id: 'gmail-1' });

        const result = await paymentsService.emailTransactionReceipt(
            COMPANY,
            71,
            ' Customer@Example.com ',
            ACTOR
        );

        expect(emailService.sendEmail).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({
                to: 'customer@example.com',
                subject: 'Payment receipt from Repair Co',
                body: expect.stringContaining('<strong>Amount:</strong> $95.00'),
                files: [],
                userId: ACTOR.id,
                userEmail: ACTOR.email,
            })
        );
        expect(stripeProvider.updateChargeReceiptEmail).not.toHaveBeenCalled();
        expect(documentSendNoteService.recordDocumentSendNote).toHaveBeenCalled();
        expect(emailService.sendEmail.mock.invocationCallOrder[0])
            .toBeLessThan(documentSendNoteService.recordDocumentSendNote.mock.invocationCallOrder[0]);
        expect(result).toEqual({
            sent: true,
            delivery: 'email',
            receipt_url: null,
            contact_email_saved: false,
        });
    });

    test('fills an empty owned contact before delivery', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            receipt_contact_email: null,
            customer_email: null,
        }));
        stripeProvider.updateChargeReceiptEmail.mockResolvedValue({ receipt_url: null });

        const result = await paymentsService.emailTransactionReceipt(
            COMPANY,
            71,
            'new@example.com',
            ACTOR
        );

        expect(contactPropagationService.propagateContactDetails).toHaveBeenCalledWith(
            COMPANY,
            5,
            { email: 'new@example.com' },
            { source: 'payment_receipt', logPrefix: '[PaymentReceipt]', redactEmail: true }
        );
        expect(contactPropagationService.propagateContactDetails.mock.invocationCallOrder[0])
            .toBeLessThan(stripeProvider.updateChargeReceiptEmail.mock.invocationCallOrder[0]);
        expect(result.contact_email_saved).toBe(true);
    });

    test('foreign transaction stays 404 before email validation or delivery', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(null);

        await expect(
            paymentsService.emailTransactionReceipt(COMPANY, 71, 'not-an-email', ACTOR)
        ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(stripeProvider.updateChargeReceiptEmail).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(documentSendNoteService.recordDocumentSendNote).not.toHaveBeenCalled();
    });

    test('returns a toast-safe NO_EMAIL error when no customer email is available', async () => {
        paymentsQueries.getTransactionReceiptContext.mockResolvedValue(receiptContext({
            receipt_contact_email: null,
            customer_email: null,
        }));

        await expect(
            paymentsService.emailTransactionReceipt(COMPANY, 71, undefined, ACTOR)
        ).rejects.toMatchObject({
            code: 'NO_EMAIL',
            httpStatus: 422,
            message: 'No customer email is available for this payment',
        });
        expect(stripeProvider.updateChargeReceiptEmail).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
    });
});
