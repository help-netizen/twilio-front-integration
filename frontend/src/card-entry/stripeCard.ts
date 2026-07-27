function tokenValue(name: string): string {
    if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return '';
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function createCardElementOptions() {
    const ink = tokenValue('--blanc-ink-1');
    const muted = tokenValue('--blanc-ink-3');
    const danger = tokenValue('--blanc-danger');
    const fontFamily = tokenValue('--blanc-font-body');
    const base: Record<string, unknown> = {
        fontSize: '16px',
        fontSmoothing: 'antialiased',
        ...(ink ? { color: ink } : {}),
        ...(fontFamily ? { fontFamily } : {}),
        ...(muted ? { '::placeholder': { color: muted } } : {}),
    };

    return {
        hidePostalCode: true,
        style: {
            base,
            invalid: danger ? { color: danger } : {},
        },
    };
}

export interface StripeCardChangeEvent {
    complete: boolean;
    error?: { message?: string };
}

export interface StripeCardHandlers {
    onChange: (event: StripeCardChangeEvent) => void;
    onFocus: () => void;
    onBlur: () => void;
}

export function mountStripeCard(
    stripe: any,
    clientSecret: string | null,
    mountNode: HTMLDivElement,
    handlers: StripeCardHandlers,
) {
    const elements = stripe.elements({
        ...(clientSecret ? { clientSecret } : {}),
        locale: 'en',
    });
    const card = elements.create('card', createCardElementOptions());
    card.on('change', handlers.onChange);
    card.on('focus', handlers.onFocus);
    card.on('blur', handlers.onBlur);
    card.mount(mountNode);

    let destroyed = false;
    return {
        card,
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            card.off?.('change', handlers.onChange);
            card.off?.('focus', handlers.onFocus);
            card.off?.('blur', handlers.onBlur);
            if (card.destroy) card.destroy();
            else card.unmount?.();
        },
    };
}

export type ConfirmationDecision =
    | { kind: 'succeeded' }
    | { kind: 'declined'; message: string | null }
    | { kind: 'validation'; message: string }
    | { kind: 'unknown' };

export function decideConfirmation(response: any): ConfirmationDecision {
    const status = response?.paymentIntent?.status || response?.error?.payment_intent?.status;
    if (status === 'succeeded') return { kind: 'succeeded' };
    if (status === 'requires_payment_method') {
        return { kind: 'declined', message: response?.error?.message || null };
    }
    if (response?.error?.type === 'validation_error') {
        return { kind: 'validation', message: response.error.message || 'Check the card details and try again.' };
    }
    return { kind: 'unknown' };
}

export type PaymentMethodDecision =
    | { kind: 'created'; pmId: string; brand: string; last4: string }
    | { kind: 'validation'; message: string };

export function decidePaymentMethod(response: any): PaymentMethodDecision {
    const paymentMethod = response?.paymentMethod;
    if (
        /^pm_[A-Za-z0-9_]+$/.test(String(paymentMethod?.id || ''))
        && typeof paymentMethod?.card?.brand === 'string'
        && /^\d{4}$/.test(String(paymentMethod?.card?.last4 || ''))
    ) {
        return {
            kind: 'created',
            pmId: paymentMethod.id,
            brand: paymentMethod.card.brand,
            last4: paymentMethod.card.last4,
        };
    }
    return {
        kind: 'validation',
        message: response?.error?.message || 'Check the card details and try again.',
    };
}
