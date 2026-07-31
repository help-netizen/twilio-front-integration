/** STRIPE-PAYFORM-UX-001 — direct Stripe Connect provider body invariants. */

const provider = require('../backend/src/services/stripeConnectProvider');

const originalFetch = global.fetch;
const originalKey = process.env.STRIPE_SECRET_KEY;

function stripeResponse(body = { id: 'pi_test', client_secret: 'pi_test_secret' }) {
    return { ok: true, status: 200, json: jest.fn().mockResolvedValue(body) };
}

beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_provider';
    global.fetch = jest.fn().mockResolvedValue(stripeResponse());
});

afterAll(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
});

describe('Stripe Connect PaymentIntent provider split', () => {
    it('CTRL-PUBLIC-AUTOMATIC: public createPaymentIntent remains automatic-only', async () => {
        await provider.createPaymentIntent('acct_public', {
            amount: 95,
            currency: 'USD',
            metadata: { surface: 'public_pay' },
        }, { idempotencyKey: 'public-key' });

        const [url, options] = global.fetch.mock.calls[0];
        const body = new URLSearchParams(options.body);
        expect(url).toBe('https://api.stripe.com/v1/payment_intents');
        expect(options.method).toBe('POST');
        expect(options.headers['Stripe-Account']).toBe('acct_public');
        expect(options.headers['Idempotency-Key']).toBe('public-key');
        expect(body.get('amount')).toBe('9500');
        expect(body.get('currency')).toBe('usd');
        expect(body.get('automatic_payment_methods[enabled]')).toBe('true');
        expect(body.has('payment_method_types[0]')).toBe(false);
    });

    it('merchant createCardPaymentIntent is card-only with no automatic methods', async () => {
        await provider.createCardPaymentIntent('acct_merchant', {
            amount: 95,
            metadata: { surface: 'manual_card' },
        }, { idempotencyKey: 'merchant-key' });

        const [url, options] = global.fetch.mock.calls[0];
        const body = new URLSearchParams(options.body);
        expect(url).toBe('https://api.stripe.com/v1/payment_intents');
        expect(options.headers['Stripe-Account']).toBe('acct_merchant');
        expect(body.get('payment_method_types[0]')).toBe('card');
        expect(body.has('automatic_payment_methods[enabled]')).toBe(false);
    });

    it('confirms a one-off on-session card with Stripe.js next-action support', async () => {
        await provider.confirmPaymentIntent(
            'acct_merchant',
            'pi_merchant',
            { paymentMethodId: 'pm_card_11' },
            { idempotencyKey: 'manual-confirm-key' }
        );

        const [url, options] = global.fetch.mock.calls[0];
        const body = new URLSearchParams(options.body);
        expect(url).toBe(
            'https://api.stripe.com/v1/payment_intents/pi_merchant/confirm'
        );
        expect(options.method).toBe('POST');
        expect(options.headers['Stripe-Account']).toBe('acct_merchant');
        expect(options.headers['Idempotency-Key']).toBe('manual-confirm-key');
        expect(body.get('payment_method')).toBe('pm_card_11');
        expect(body.get('use_stripe_sdk')).toBe('true');
        expect(body.has('setup_future_usage')).toBe(false);
        expect(body.has('payment_method_options[card][moto]')).toBe(false);
    });
});

describe('Stripe Connect result retrieval', () => {
    it('retrieves the PaymentIntent on the stored connected account without a body', async () => {
        global.fetch.mockResolvedValueOnce(stripeResponse({ id: 'pi_1', status: 'succeeded' }));
        await provider.retrievePaymentIntent('acct_merchant', 'pi_1');

        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi_1');
        expect(options).toMatchObject({ method: 'GET', body: undefined });
        expect(options.headers['Stripe-Account']).toBe('acct_merchant');
    });

    it('retrieves the PaymentMethod on the stored connected account without a body', async () => {
        global.fetch.mockResolvedValueOnce(stripeResponse({ id: 'pm_1', card: { brand: 'visa', last4: '4242' } }));
        await provider.retrievePaymentMethod('acct_merchant', 'pm_1');

        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.stripe.com/v1/payment_methods/pm_1');
        expect(options).toMatchObject({ method: 'GET', body: undefined });
        expect(options.headers['Stripe-Account']).toBe('acct_merchant');
    });

    it('retrieves a Charge on the stored connected account without a body', async () => {
        global.fetch.mockResolvedValueOnce(stripeResponse({ id: 'ch_1' }));
        await provider.retrieveCharge('acct_merchant', 'ch_1');

        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.stripe.com/v1/charges/ch_1');
        expect(options).toMatchObject({ method: 'GET', body: undefined });
        expect(options.headers['Stripe-Account']).toBe('acct_merchant');
    });
});

test('STRIPE-NATIVE-RESURRECTION: provider exposes no native receipt-email mutation', () => {
    expect(provider.updateChargeReceiptEmail).toBeUndefined();
});

// STRIPE-STANDARD-001: tenants are Standard accounts — Stripe owns the merchant
// relationship (full dashboard, KYC/risk/fraud monitoring), the platform keeps
// minimal liability. Direct charges and the no-application-fee model unchanged.
describe('Stripe Connect account creation', () => {
    test('creates Standard accounts with direct-charge capabilities and no platform fee', async () => {
        await provider.createAccount({ email: 'o@x.com', companyName: 'ACME', companyId: 'c-1' });
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.stripe.com/v1/accounts');
        expect(options.body).toContain('type=standard');
        expect(options.body).not.toContain('express');
        expect(options.body).toContain(encodeURIComponent('capabilities[card_payments][requested]') + '=true');
        expect(options.body).not.toContain('application_fee');
    });

    test('maps the account type through for connection status readers', () => {
        const mapped = provider.mapAccount
            ? provider.mapAccount({ id: 'acct_1', type: 'standard' })
            : null;
        if (mapped) expect(mapped.type).toBe('standard');
    });
});
