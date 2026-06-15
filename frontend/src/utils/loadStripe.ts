/**
 * Dynamic Stripe.js loader (no @stripe/stripe-js dependency).
 *
 * Loads https://js.stripe.com/v3 once, then constructs a Stripe instance bound to
 * the platform publishable key (VITE_STRIPE_PUBLISHABLE_KEY) and the tenant's
 * connected account — required for direct-charge Payment Elements.
 *
 *   const stripe = await loadStripe(connectedAccountId);
 *   const elements = stripe.elements({ clientSecret });
 */

// Stripe.js attaches a global `Stripe` factory; we type it loosely to avoid a dep.
declare global {
    interface Window { Stripe?: (key: string, opts?: { stripeAccount?: string }) => any }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
    if (scriptPromise) return scriptPromise;
    if (typeof window !== 'undefined' && window.Stripe) {
        scriptPromise = Promise.resolve();
        return scriptPromise;
    }
    scriptPromise = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://js.stripe.com/v3';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Stripe.js'));
        document.head.appendChild(script);
    });
    return scriptPromise;
}

export async function loadStripe(connectedAccountId?: string): Promise<any> {
    const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    if (!key) throw new Error('VITE_STRIPE_PUBLISHABLE_KEY is not configured');
    await loadScript();
    if (!window.Stripe) throw new Error('Stripe.js failed to initialize');
    return window.Stripe(key, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined);
}
