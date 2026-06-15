/**
 * stripeConnectProvider.js — Stripe Connect (tenant customer payments) via REST.
 *
 * F018 / STRIPE-PAY-001. Zero-SDK (fetch + form-encoding), dependency-free like the
 * platform-billing stripeProvider.js — but kept SEPARATE: this drives per-tenant
 * connected accounts (direct charges, tenant = merchant of record, no application fee)
 * and a distinct webhook secret (STRIPE_CONNECT_WEBHOOK_SECRET).
 *
 * Uses STRIPE_SECRET_KEY (platform acts as the Connect platform). Connected-account
 * operations pass the `Stripe-Account` header so charges land on the tenant account.
 * No card data, PAN, CVC or bank data ever touches this module.
 */

const crypto = require('crypto');

const API = 'https://api.stripe.com/v1';
const KEY = () => process.env.STRIPE_SECRET_KEY;

function isConfigured() {
    return Boolean(KEY());
}

function form(obj, prefix = '') {
    const parts = [];
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === undefined || v === null) continue;
        const key = prefix ? `${prefix}[${k}]` : k;
        if (typeof v === 'object' && !Array.isArray(v)) parts.push(form(v, key));
        else if (Array.isArray(v)) v.forEach((item, i) => parts.push(form(item, `${key}[${i}]`)));
        else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
    return parts.filter(Boolean).join('&');
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @param {{ stripeAccount?: string, idempotencyKey?: string }} [opts]
 */
async function call(method, path, body, opts = {}) {
    if (!KEY()) throw new Error('STRIPE_SECRET_KEY is not configured');
    const headers = {
        Authorization: `Bearer ${KEY()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (opts.stripeAccount) headers['Stripe-Account'] = opts.stripeAccount;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body ? form(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) {
        const err = new Error(json.error?.message || `Stripe ${res.status}`);
        err.stripeCode = json.error?.code;
        err.httpStatus = res.status;
        throw err;
    }
    return json;
}

/**
 * Create a connected account (Express, direct-charge merchant of record).
 * No application fee / no platform-controlled pricing.
 */
async function createAccount({ email, companyName, companyId } = {}) {
    return call('POST', '/accounts', {
        type: 'express',
        email: email || undefined,
        business_profile: { name: companyName || undefined },
        capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
        },
        metadata: { albusto_company_id: companyId },
    });
}

/** Onboarding / resume link. type=account_onboarding. */
async function createAccountLink(accountId, { refreshUrl, returnUrl }) {
    return call('POST', '/account_links', {
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
    });
}

/** Login link to the Express dashboard for a connected account. */
async function createLoginLink(accountId) {
    return call('POST', `/accounts/${accountId}/login_links`, {});
}

/** Fetch account → normalized readiness fields. */
async function getAccount(accountId) {
    const acct = await call('GET', `/accounts/${accountId}`);
    return mapAccount(acct);
}

function mapAccount(acct) {
    return {
        id: acct.id,
        livemode: Boolean(acct.livemode),
        charges_enabled: Boolean(acct.charges_enabled),
        payouts_enabled: Boolean(acct.payouts_enabled),
        details_submitted: Boolean(acct.details_submitted),
        requirements_currently_due: acct.requirements?.currently_due || [],
        requirements_past_due: acct.requirements?.past_due || [],
        capabilities: acct.capabilities || {},
        raw: acct,
    };
}

/**
 * Create a Checkout Session as a DIRECT charge on the connected account.
 * @param {string} accountId connected account id (Stripe-Account header)
 */
async function createCheckoutSession(accountId, {
    amount, currency = 'usd', invoiceNumber, successUrl, cancelUrl, metadata = {}, expiresAt,
}, { idempotencyKey } = {}) {
    const body = {
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [{
            price_data: {
                currency: String(currency).toLowerCase(),
                product_data: { name: invoiceNumber ? `Invoice ${invoiceNumber}` : 'Invoice payment' },
                unit_amount: Math.round(Number(amount) * 100),
            },
            quantity: 1,
        }],
        payment_intent_data: { metadata },
        metadata,
    };
    if (expiresAt) body.expires_at = Math.floor(new Date(expiresAt).getTime() / 1000);
    return call('POST', '/checkout/sessions', body, { stripeAccount: accountId, idempotencyKey });
}

async function retrieveCheckoutSession(accountId, sessionId) {
    return call('GET', `/checkout/sessions/${sessionId}`, undefined, { stripeAccount: accountId });
}

/**
 * Create a PaymentIntent as a DIRECT charge on the connected account.
 * Used for manual/keyed card entry (Payment Element) — automatic payment methods.
 * The client confirms with the platform publishable key + { stripeAccount } option.
 */
async function createPaymentIntent(accountId, { amount, currency = 'usd', metadata = {} }, { idempotencyKey } = {}) {
    return call('POST', '/payment_intents', {
        amount: Math.round(Number(amount) * 100),
        currency: String(currency).toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata,
    }, { stripeAccount: accountId, idempotencyKey });
}

/** Terminal connection token (scoped to the connected account). */
async function createConnectionToken(accountId, { locationId } = {}) {
    return call('POST', '/terminal/connection_tokens', locationId ? { location: locationId } : {}, { stripeAccount: accountId });
}

/** Create a Terminal Location on the connected account. */
async function createTerminalLocation(accountId, { displayName, address }) {
    return call('POST', '/terminal/locations', {
        display_name: displayName,
        address: address || { country: 'US' },
    }, { stripeAccount: accountId });
}

/**
 * Create a card_present PaymentIntent for Tap to Pay (manual capture by default so
 * the reader flow can capture after collection).
 */
async function createTerminalPaymentIntent(accountId, { amount, currency = 'usd', metadata = {} }, { idempotencyKey } = {}) {
    return call('POST', '/payment_intents', {
        amount: Math.round(Number(amount) * 100),
        currency: String(currency).toLowerCase(),
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        metadata,
    }, { stripeAccount: accountId, idempotencyKey });
}

async function cancelPaymentIntent(accountId, paymentIntentId) {
    return call('POST', `/payment_intents/${paymentIntentId}/cancel`, {}, { stripeAccount: accountId });
}

/** Refund a charge/payment_intent on the connected account. */
async function createRefund(accountId, { paymentIntent, charge, amount, reason }, { idempotencyKey } = {}) {
    const body = {};
    if (paymentIntent) body.payment_intent = paymentIntent;
    if (charge) body.charge = charge;
    if (amount != null) body.amount = Math.round(Number(amount) * 100);
    if (reason) body.reason = reason;
    return call('POST', '/refunds', body, { stripeAccount: accountId, idempotencyKey });
}

/**
 * Verify a Connect webhook signature using STRIPE_CONNECT_WEBHOOK_SECRET.
 * Returns { type, data, id, account, livemode } or null on bad/missing signature.
 * `account` is the connected account id (present on Connect events).
 */
function parseConnectWebhook(rawBody, signatureHeader) {
    const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (!secret || !signatureHeader) return null;
    const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.split('=')));
    if (!parts.t || !parts.v1) return null;
    const expected = crypto.createHmac('sha256', secret)
        .update(`${parts.t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let evt;
    try { evt = JSON.parse(rawBody); } catch { return null; }
    return {
        type: evt.type,
        data: evt.data?.object || {},
        id: evt.id,
        account: evt.account || null,
        livemode: Boolean(evt.livemode),
    };
}

module.exports = {
    isConfigured,
    createAccount,
    createAccountLink,
    createLoginLink,
    getAccount,
    mapAccount,
    createCheckoutSession,
    retrieveCheckoutSession,
    createPaymentIntent,
    createConnectionToken,
    createTerminalLocation,
    createTerminalPaymentIntent,
    cancelPaymentIntent,
    createRefund,
    parseConnectWebhook,
};
