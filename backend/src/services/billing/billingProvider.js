/**
 * billingProvider.js — provider-agnostic billing interface (ADR-001 §2.4).
 *
 * Resolves the active provider implementation (Stripe now; Square later).
 * All billing code depends on this interface, never on a concrete SDK.
 *
 * Interface:
 *   ensureCustomer(company)            → { customerId }
 *   createSubscription(company, plan)  → { subscriptionId, status, periodEnd }
 *   reportUsage(subscription, metric, qty)
 *   createCheckoutSession(company, plan, urls) → { url }
 *   parseWebhook(rawBody, signature)   → { type, data } | null
 */

const PROVIDER = (process.env.BILLING_PROVIDER || 'stripe').toLowerCase();

function getProvider() {
    if (PROVIDER === 'stripe') return require('./stripeProvider');
    if (PROVIDER === 'square') {
        try { return require('./squareProvider'); }
        catch { throw new Error('Square billing provider not implemented yet'); }
    }
    throw new Error(`Unknown BILLING_PROVIDER: ${PROVIDER}`);
}

module.exports = { getProvider, PROVIDER };
