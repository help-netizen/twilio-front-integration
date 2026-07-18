import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authedFetch = vi.hoisted(() => vi.fn());

vi.mock('../../services/apiClient', () => ({ authedFetch }));
vi.mock('../ui/button', () => ({ Button: () => null }));
vi.mock('../ui/dialog', () => ({
    Dialog: () => null,
    DialogContent: () => null,
    DialogDescription: () => null,
    DialogPanelHeader: () => null,
    DialogBody: () => null,
    DialogPanelFooter: () => null,
    DialogTitle: () => null,
}));

import { stripePaymentsApi, type ManualCardSessionResult } from '../../services/stripePaymentsApi';
import {
    INITIAL_MANUAL_CARD_STATE,
    canDismissManualCard,
    completeManualCardDialog,
    createCardElementOptions,
    createManualCardReceiptState,
    decideConfirmation,
    manualCardReducer,
    manualCardReceiptReducer,
    mountStripeCard,
    reconcileManualCardSession,
    requestManualCardDismiss,
    settleFinanceSync,
    shouldShowReceiptContactSaveCaption,
    validateReceiptEmail,
} from './ManualCardDialog';

const SUCCEEDED: ManualCardSessionResult = {
    status: 'succeeded',
    amount: 95,
    brand: 'visa',
    last4: '4242',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return { ok, status, json: vi.fn(async () => body) } as unknown as Response;
}

beforeEach(() => {
    authedFetch.mockReset();
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({
        getPropertyValue: (name: string) => ({
            '--blanc-ink-1': '#191919',
            '--blanc-ink-3': '#8A8A8A',
            '--blanc-danger': '#F0503F',
            '--blanc-font-body': 'IBM Plex Sans',
        })[name] || '',
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Stripe-hosted composite Card Element', () => {
    it('creates only card with en locale, visible ZIP, token-resolved style, and cleanup', () => {
        const card = {
            on: vi.fn(),
            off: vi.fn(),
            mount: vi.fn(),
            destroy: vi.fn(),
        };
        const elements = { create: vi.fn(() => card) };
        const stripe = { elements: vi.fn(() => elements) };
        const handlers = { onChange: vi.fn(), onFocus: vi.fn(), onBlur: vi.fn() };
        const mountNode = {} as HTMLDivElement;

        const mounted = mountStripeCard(stripe, 'pi_secret', mountNode, handlers);

        expect(stripe.elements).toHaveBeenCalledWith({ clientSecret: 'pi_secret', locale: 'en' });
        expect(elements.create).toHaveBeenCalledOnce();
        expect(elements.create).toHaveBeenCalledWith('card', expect.objectContaining({
            hidePostalCode: false,
            style: expect.objectContaining({
                base: expect.objectContaining({ color: '#191919', fontFamily: 'IBM Plex Sans' }),
                invalid: { color: '#F0503F' },
            }),
        }));
        expect(card.mount).toHaveBeenCalledWith(mountNode);

        mounted.destroy();
        mounted.destroy();
        expect(card.off).toHaveBeenCalledTimes(3);
        expect(card.destroy).toHaveBeenCalledOnce();
    });

    it('keeps the supported legacy Card Element style contract', () => {
        expect(createCardElementOptions()).toEqual(expect.objectContaining({
            hidePostalCode: false,
            style: expect.any(Object),
        }));
        expect(createCardElementOptions()).not.toHaveProperty('appearance');
    });
});

describe('manual card state machine', () => {
    it('gates idle submission on Card Element completeness and locks duplicate/3DS-pending submits', () => {
        let state = manualCardReducer(INITIAL_MANUAL_CARD_STATE, { type: 'SESSION_READY' });
        expect(manualCardReducer(state, { type: 'SUBMIT' }).phase).toBe('idle');

        state = manualCardReducer(state, { type: 'CARD_CHANGE', complete: true, error: null });
        state = manualCardReducer(state, { type: 'SUBMIT' });
        expect(state.phase).toBe('submitting');
        expect(canDismissManualCard(state.phase)).toBe(false);
        expect(manualCardReducer(state, { type: 'SUBMIT' })).toBe(state);
    });

    it('enters success only for exact succeeded and gates retry on requires_payment_method', () => {
        expect(decideConfirmation({ paymentIntent: { status: 'succeeded' } })).toEqual({ kind: 'succeeded' });
        expect(decideConfirmation({ paymentIntent: { status: 'processing' } })).toEqual({ kind: 'unknown' });
        expect(decideConfirmation({ paymentIntent: { status: 'requires_action' } })).toEqual({ kind: 'unknown' });
        expect(decideConfirmation({ error: { message: 'Declined', payment_intent: { status: 'requires_payment_method' } } }))
            .toEqual({ kind: 'declined', message: 'Declined' });
        expect(decideConfirmation({ error: { type: 'validation_error', message: 'Incomplete number' } }))
            .toEqual({ kind: 'validation', message: 'Incomplete number' });
    });

    it('keeps Stripe-confirmed success while Finance is late', () => {
        let state = manualCardReducer(INITIAL_MANUAL_CARD_STATE, { type: 'SUCCEEDED', result: SUCCEEDED });
        state = manualCardReducer(state, { type: 'FINANCE_SYNCED', sync: 'delayed' });
        expect(state.phase).toBe('success');
        expect(state.result).toEqual(SUCCEEDED);
        expect(state.financeSync).toBe('delayed');
    });
});

describe('ambiguous result reconciliation', () => {
    it('keeps non-final statuses locked until the same PI succeeds', async () => {
        const getResult = vi.fn()
            .mockResolvedValueOnce({ ...SUCCEEDED, status: 'processing' })
            .mockResolvedValueOnce({ ...SUCCEEDED, status: 'requires_action' })
            .mockResolvedValueOnce(SUCCEEDED);
        const wait = vi.fn(async (_milliseconds: number) => {});

        await expect(reconcileManualCardSession({
            sessionId: 11,
            getResult,
            wait,
            delays: [0, 1000, 2000],
        })).resolves.toEqual(SUCCEEDED);
        expect(getResult).toHaveBeenCalledTimes(3);
        expect(wait.mock.calls.map(call => call[0])).toEqual([1000, 2000]);
    });

    it('returns retryable only for requires_payment_method, including after a network failure', async () => {
        const retryable = { ...SUCCEEDED, status: 'requires_payment_method', brand: null, last4: null };
        const getResult = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(retryable);

        await expect(reconcileManualCardSession({
            sessionId: 11,
            getResult,
            wait: async () => {},
            delays: [0, 1000],
        })).resolves.toEqual(retryable);
    });

    it('stays unresolved after the bounded attempts and honors cancellation', async () => {
        const getResult = vi.fn().mockResolvedValue({ ...SUCCEEDED, status: 'processing' });
        await expect(reconcileManualCardSession({
            sessionId: 11,
            getResult,
            wait: async () => {},
            delays: [0, 1000, 2000],
        })).resolves.toBeNull();
        expect(getResult).toHaveBeenCalledTimes(3);

        const cancelledFetch = vi.fn();
        await expect(reconcileManualCardSession({
            sessionId: 11,
            getResult: cancelledFetch,
            wait: async () => {},
            isCancelled: () => true,
            delays: [0, 1000],
        })).resolves.toBeNull();
        expect(cancelledFetch).not.toHaveBeenCalled();
    });
});

describe('confirmed and Done callback split', () => {
    it('does not dismiss success until Done and fires callbacks at distinct times', async () => {
        const onOpenChange = vi.fn();
        const onPaymentConfirmed = vi.fn(async () => true);
        const onDone = vi.fn();

        await expect(settleFinanceSync(SUCCEEDED, onPaymentConfirmed)).resolves.toBe('updated');
        expect(onPaymentConfirmed).toHaveBeenCalledWith(SUCCEEDED);
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(onDone).not.toHaveBeenCalled();

        requestManualCardDismiss('success', onOpenChange);
        expect(onOpenChange).not.toHaveBeenCalled();

        completeManualCardDialog(onOpenChange, onDone);
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onDone).toHaveBeenCalledOnce();
    });

    it('keeps Done independent while an optional receipt request is sending', () => {
        const onOpenChange = vi.fn();
        const onDone = vi.fn();
        const sending = manualCardReceiptReducer(
            createManualCardReceiptState('customer@example.com'),
            { type: 'SEND' },
        );

        expect(sending.phase).toBe('sending');
        completeManualCardDialog(onOpenChange, onDone);
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onDone).toHaveBeenCalledOnce();
    });
});

describe('optional Stripe-native receipt state', () => {
    it('prefills from contact, stays editable, and does not replace a technician edit', () => {
        let receipt = createManualCardReceiptState(' contact@example.com ');
        expect(receipt.email).toBe('contact@example.com');

        receipt = manualCardReceiptReducer(receipt, { type: 'EDIT', email: 'edited@example.com' });
        receipt = manualCardReceiptReducer(receipt, { type: 'PREFILL', email: 'late@example.com' });
        expect(receipt).toMatchObject({ phase: 'idle', email: 'edited@example.com', dirty: true });
    });

    it('shows the save caption only for a bound contact whose known email is empty', () => {
        expect(shouldShowReceiptContactSaveCaption(true, '', 'idle')).toBe(true);
        expect(shouldShowReceiptContactSaveCaption(true, null, 'sending')).toBe(true);
        expect(shouldShowReceiptContactSaveCaption(true, 'known@example.com', 'idle')).toBe(false);
        expect(shouldShowReceiptContactSaveCaption(true, undefined, 'idle')).toBe(false);
        expect(shouldShowReceiptContactSaveCaption(false, '', 'idle')).toBe(false);
        expect(shouldShowReceiptContactSaveCaption(true, '', 'sent')).toBe(false);
    });

    it('locks the sent field/button state and records the exact recipient', () => {
        let receipt = createManualCardReceiptState('customer@example.com');
        receipt = manualCardReceiptReducer(receipt, { type: 'SEND' });
        expect(receipt.phase).toBe('sending');
        receipt = manualCardReceiptReducer(receipt, { type: 'SENT', email: 'customer@example.com' });
        const sent = receipt;
        expect(sent).toMatchObject({
            phase: 'sent',
            email: 'customer@example.com',
            sentEmail: 'customer@example.com',
            error: null,
        });
        expect(manualCardReceiptReducer(sent, { type: 'EDIT', email: 'other@example.com' })).toBe(sent);
    });

    it('validates email locally while leaving the server authoritative', () => {
        expect(validateReceiptEmail('customer@example.com')).toBeNull();
        expect(validateReceiptEmail('not-an-email')).toBe('Enter a valid customer email.');
        expect(validateReceiptEmail('two words@example.com')).toBe('Enter a valid customer email.');
    });
});

describe('manual card result API', () => {
    it('calls the tenant-authenticated result route and projects exactly four keys', async () => {
        authedFetch.mockResolvedValueOnce(jsonResponse({ ...SUCCEEDED, client_secret: 'must-not-leak' }));

        const result = await stripePaymentsApi.getManualCardSessionResult(11);
        expect(result).toEqual(SUCCEEDED);
        expect(authedFetch).toHaveBeenCalledWith('/api/payments/manual-card-sessions/11/result');
        expect(Object.keys(result).sort()).toEqual(['amount', 'brand', 'last4', 'status']);
    });

    it('posts the receipt email and projects the native receipt result', async () => {
        authedFetch.mockResolvedValueOnce(jsonResponse({
            sent: true,
            receipt_url: 'https://pay.stripe.com/receipts/test',
            contact_email_saved: true,
            email: 'must-not-project@example.com',
        }));

        const result = await stripePaymentsApi.sendManualCardReceipt(11, 'customer@example.com');

        expect(result).toEqual({
            sent: true,
            receipt_url: 'https://pay.stripe.com/receipts/test',
            contact_email_saved: true,
        });
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/payments/manual-card-sessions/11/receipt',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'customer@example.com' }),
            },
        );
    });
});
