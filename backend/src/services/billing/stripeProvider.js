/**
 * stripeProvider.js — Stripe Billing via REST (no SDK dependency).
 *
 * Uses STRIPE_SECRET_KEY. Webhook signature verified with STRIPE_WEBHOOK_SECRET
 * (Stripe-Signature scheme v1). Dependency-free so the prod image
 * (`npm ci --only=production`) needs no extra package.
 */

const crypto = require('crypto');

const API = 'https://api.stripe.com/v1';
const KEY = () => process.env.STRIPE_SECRET_KEY;

function form(obj, prefix = '') {
    // Stripe form-encoding with nested keys: a[b]=c
    const parts = [];
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === undefined || v === null) continue;
        const key = prefix ? `${prefix}[${k}]` : k;
        if (typeof v === 'object' && !Array.isArray(v)) parts.push(form(v, key));
        else if (Array.isArray(v)) v.forEach((item, i) => parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`));
        else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
    return parts.filter(Boolean).join('&');
}

async function call(method, path, body) {
    if (!KEY()) throw new Error('STRIPE_SECRET_KEY is not configured');
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${KEY()}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
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

async function ensureCustomer(company) {
    const cust = await call('POST', '/customers', {
        name: company.name,
        email: company.contact_email || undefined,
        metadata: { albusto_company_id: company.id },
    });
    return { customerId: cust.id };
}

async function createSubscription(customerId, priceId, { trialDays } = {}) {
    const sub = await call('POST', '/subscriptions', {
        customer: customerId,
        items: [{ price: priceId }],
        trial_period_days: trialDays || undefined,
        payment_behavior: 'default_incomplete',
    });
    return {
        subscriptionId: sub.id,
        status: sub.status,
        periodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
        periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    };
}

async function createCheckoutSession(customerId, priceId, { successUrl, cancelUrl }) {
    const session = await call('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
    });
    return { url: session.url, sessionId: session.id };
}

async function reportUsage(subscriptionItemId, quantity, timestamp) {
    return call('POST', `/subscription_items/${subscriptionItemId}/usage_records`, {
        quantity: Math.round(quantity),
        timestamp: timestamp || Math.floor(Date.now() / 1000),
        action: 'increment',
    });
}

/** Verify Stripe-Signature (v1 HMAC-SHA256 over `${t}.${payload}`). */
function parseWebhook(rawBody, signatureHeader) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !signatureHeader) return null;
    const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.split('=')));
    if (!parts.t || !parts.v1) return null;
    const expected = crypto.createHmac('sha256', secret)
        .update(`${parts.t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    // timingSafeEqual throws on length mismatch — guard so a malformed
    // signature is a clean rejection, not an unhandled exception.
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let evt;
    try { evt = JSON.parse(rawBody); } catch { return null; }
    return { type: evt.type, data: evt.data?.object || {}, id: evt.id };
}

module.exports = {
    ensureCustomer, createSubscription, createCheckoutSession, reportUsage, parseWebhook,
};
