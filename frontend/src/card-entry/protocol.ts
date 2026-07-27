export const CARDFRAME_READY_KIND = 'cardframe:ready' as const;
export const CARDFRAME_INIT_KIND = 'cardframe:init' as const;
export const CARDFRAME_CARD_CHANGE_KIND = 'cardframe:card_change' as const;
export const CARDFRAME_RESULT_KIND = 'cardframe:result' as const;
export const CARDFRAME_PAYMENT_METHOD_KIND = 'cardframe:payment_method' as const;

export type CardframeMode = 'collect' | 'authenticate';

export type CardframeResultStatus =
    | 'succeeded'
    | 'requires_payment_method'
    | 'failed'
    | 'canceled';

export interface CardframeReadyMessage {
    kind: typeof CARDFRAME_READY_KIND;
}

interface CardframeInitBase {
    kind: typeof CARDFRAME_INIT_KIND;
    accountId: string;
    amount: number;
}

export type CardframeInitMessage =
    | (CardframeInitBase & { mode: 'collect' })
    | (CardframeInitBase & { mode: 'authenticate'; clientSecret: string });

export interface CardframeCardChangeMessage {
    kind: typeof CARDFRAME_CARD_CHANGE_KIND;
    complete: boolean;
}

export interface CardframeResultMessage {
    kind: typeof CARDFRAME_RESULT_KIND;
    status: CardframeResultStatus;
    message?: string;
}

export interface CardframePaymentMethodMessage {
    kind: typeof CARDFRAME_PAYMENT_METHOD_KIND;
    pmId: string;
    brand: string;
    last4: string;
}

export type CardframeCompletionMessage =
    | CardframeResultMessage
    | CardframePaymentMethodMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function isCardframeReadyMessage(value: unknown): value is CardframeReadyMessage {
    return isRecord(value) && value.kind === CARDFRAME_READY_KIND;
}

export function isCardframeInitMessage(value: unknown): value is CardframeInitMessage {
    if (!isRecord(value)) return false;
    if (
        value.kind !== CARDFRAME_INIT_KIND
        || !isNonEmptyString(value.accountId)
        || typeof value.amount !== 'number'
        || !Number.isFinite(value.amount)
        || value.amount <= 0
    ) {
        return false;
    }
    if (value.mode === 'collect') return true;
    return value.mode === 'authenticate' && isNonEmptyString(value.clientSecret);
}

export function isCardframeResultMessage(value: unknown): value is CardframeResultMessage {
    if (!isRecord(value) || value.kind !== CARDFRAME_RESULT_KIND) return false;
    if (
        value.status !== 'succeeded'
        && value.status !== 'requires_payment_method'
        && value.status !== 'failed'
        && value.status !== 'canceled'
    ) {
        return false;
    }
    return value.message === undefined || typeof value.message === 'string';
}

export function isCardframePaymentMethodMessage(
    value: unknown,
): value is CardframePaymentMethodMessage {
    return isRecord(value)
        && value.kind === CARDFRAME_PAYMENT_METHOD_KIND
        && isNonEmptyString(value.pmId)
        && /^pm_[A-Za-z0-9_]+$/.test(value.pmId)
        && isNonEmptyString(value.brand)
        && typeof value.last4 === 'string'
        && /^\d{4}$/.test(value.last4);
}

export function isCardframeCompletionMessage(
    value: unknown,
): value is CardframeCompletionMessage {
    return isCardframeResultMessage(value) || isCardframePaymentMethodMessage(value);
}

function httpOrigin(value: string, baseOrigin: string): string | null {
    if (!value.trim()) return null;
    try {
        const url = new URL(value, baseOrigin);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
    } catch {
        return null;
    }
}

export function resolveCardEntryTarget(
    currentOrigin: string,
    configuredOrigin?: string,
): { origin: string; url: string } {
    const origin = httpOrigin(configuredOrigin || currentOrigin, currentOrigin);
    if (!origin) throw new Error('VITE_CARD_ENTRY_ORIGIN must be an HTTP(S) origin');
    return {
        origin,
        url: new URL('/card-entry.html', origin).toString(),
    };
}

export function resolveExpectedAppOrigin(
    referrer: string,
    currentOrigin: string,
    configuredOrigin?: string,
): string {
    return httpOrigin(referrer, currentOrigin)
        || httpOrigin(configuredOrigin || '', currentOrigin)
        || currentOrigin;
}
