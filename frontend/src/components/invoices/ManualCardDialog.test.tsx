import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const authedFetch = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../services/apiClient', () => ({ authedFetch }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));
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
    createCardElementOptions,
    decideConfirmation,
    mountStripeCard,
} from '../../card-entry/stripeCard';
import {
    INITIAL_MANUAL_CARD_STATE,
    ManualCardSuccessView,
    canDismissManualCard,
    commitManualCardSuccess,
    completeManualCardDialog,
    createManualCardReceiptState,
    handleCardEntryPopupResult,
    manualCardReducer,
    manualCardReceiptReducer,
    openManualCardAuthenticationPopup,
    openManualCardEntryPopup,
    reconcileManualCardSession,
    resolveManualCardSameWindowResume,
    requestManualCardDismiss,
    runManualCardCharge,
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
    toastError.mockReset();
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
    it('creates only card with en locale, hidden ZIP, token-resolved style, and cleanup', () => {
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

        const mounted = mountStripeCard(stripe, null, mountNode, handlers);

        expect(stripe.elements).toHaveBeenCalledWith({ locale: 'en' });
        expect(elements.create).toHaveBeenCalledOnce();
        expect(elements.create).toHaveBeenCalledWith('card', expect.objectContaining({
            hidePostalCode: true,
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
            hidePostalCode: true,
            style: expect.any(Object),
        }));
        expect(createCardElementOptions()).not.toHaveProperty('appearance');
    });
});

describe('manual card state machine', () => {
    it('collects a card only after the session is ready and locks the server charge/3DS phases', () => {
        expect(manualCardReducer(INITIAL_MANUAL_CARD_STATE, { type: 'COLLECT' }).phase).toBe('loading');

        let state = manualCardReducer(INITIAL_MANUAL_CARD_STATE, { type: 'SESSION_READY' });
        state = manualCardReducer(state, { type: 'COLLECT' });
        expect(state.phase).toBe('collecting');
        expect(canDismissManualCard(state.phase)).toBe(false);
        expect(manualCardReducer(state, { type: 'CHARGE' })).toBe(state);

        state = manualCardReducer(state, { type: 'CARD_SELECTED' });
        state = manualCardReducer(state, { type: 'CHARGE' });
        expect(state.phase).toBe('charging');
        state = manualCardReducer(state, { type: 'AUTHENTICATE' });
        expect(state.phase).toBe('authenticating');
        expect(canDismissManualCard(state.phase)).toBe(false);
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

    it('shows and keeps success when the captured session succeeds after its live ref is cleared', () => {
        let state = manualCardReducer(INITIAL_MANUAL_CARD_STATE, { type: 'SESSION_READY' });
        state = manualCardReducer(state, { type: 'CHARGE' });
        const sessionRef: { current: { session_id: number } | null } = {
            current: { session_id: 11 },
        };
        const capturedSessionId = sessionRef.current!.session_id;

        // Reproduce the production race: an effect cleanup clears the live ref before
        // the server-confirmed Pay promise resumes.
        sessionRef.current = null;
        const confirmedSessionRef = { current: null as number | null };
        expect(commitManualCardSuccess(
            SUCCEEDED,
            capturedSessionId,
            confirmedSessionRef,
            result => {
                state = manualCardReducer(state, { type: 'SUCCEEDED', result });
            },
        )).toBe(true);
        expect(confirmedSessionRef.current).toBe(11);
        expect(state.phase).toBe('success');

        const renderSuccess = () => renderToStaticMarkup(
            <ManualCardSuccessView
                result={state.result!}
                cardLabel="Visa •••• 4242"
                receiptState={createManualCardReceiptState('customer@example.com')}
                receiptLocked={false}
                showContactSaveCaption={false}
                onReceiptEmailChange={() => {}}
                onSendReceipt={() => {}}
            />,
        );
        expect(renderSuccess()).toContain('Payment successful');
        expect(renderSuccess()).toContain('Paid $95.00');
        // The success screen is stripped to the essentials — no redundant eyebrow,
        // no finance-sync / "recorded on Job" copy.
        expect(renderSuccess()).not.toContain('Payment complete');
        expect(renderSuccess()).not.toContain('recorded on Job');
        expect(renderSuccess()).not.toContain('Finance updated');

        // A same-open-cycle effect RESET and a parent Finance rerender cannot leave
        // the terminal state or replace its success screen.
        state = manualCardReducer(state, { type: 'RESET' });
        expect(state.phase).toBe('success');
        expect(renderSuccess()).toContain('Payment successful');
        expect(commitManualCardSuccess(
            SUCCEEDED,
            capturedSessionId,
            confirmedSessionRef,
            () => {
                throw new Error('Duplicate success must not dispatch');
            },
        )).toBe(false);

        expect(manualCardReducer(state, { type: 'RESET', force: true })).toBe(INITIAL_MANUAL_CARD_STATE);
    });
});

describe('manual-card popup integration', () => {
    it('restores a same-window result only for the matching job and session', () => {
        const session = {
            session_id: 11,
            client_secret: 'pi_secret',
            payment_intent_id: 'pi_11',
            account_id: 'acct_11',
            amount: 95,
            save_for_future: true,
        };
        const result = {
            sessionId: 11,
            completion: {
                kind: 'cardframe:payment_method' as const,
                pmId: 'pm_card_11',
                brand: 'visa',
                last4: '4242',
            },
            resumeContext: {
                kind: 'manual-card',
                stage: 'collect',
                entityType: 'job',
                entityId: '1617',
                session,
            },
        };

        expect(resolveManualCardSameWindowResume(result, 'job', '1617')).toEqual({
            context: result.resumeContext,
            completion: result.completion,
        });
        expect(resolveManualCardSameWindowResume(result, 'job', '999')).toBeNull();
        expect(resolveManualCardSameWindowResume({ ...result, sessionId: 12 }, 'job', '1617')).toBeNull();
    });

    it('opens collect mode and accepts the popup PaymentMethod mask without charging', async () => {
        const popup = {
            closed: false,
            postMessage: vi.fn(),
            close: vi.fn(),
        };
        const messageListeners: Array<(event: MessageEvent) => void> = [];
        let ackTimeoutCallback: (() => void) | null = null;
        const clearTimeout = vi.fn();
        const assign = vi.fn();
        const hostWindow = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/jobs/1617',
                search: '',
                hash: '',
                assign,
            },
            open: vi.fn(() => popup),
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
                messageListeners.push(listener);
            }),
            removeEventListener: vi.fn(),
            setInterval: vi.fn(() => 17),
            clearInterval: vi.fn(),
            setTimeout: vi.fn((callback: () => void) => {
                ackTimeoutCallback = callback;
                return 23;
            }),
            clearTimeout,
        } as unknown as Window;
        const session = {
            session_id: 11,
            client_secret: 'pi_secret',
            payment_intent_id: 'pi_11',
            account_id: 'acct_11',
            amount: 95,
            save_for_future: true,
        };

        const handle = openManualCardEntryPopup(session, undefined, {
            hostWindow,
            configuredOrigin: 'https://cards.albusto.test',
        });
        expect(handle).not.toBeNull();
        expect(hostWindow.open).toHaveBeenCalledWith(
            'https://cards.albusto.test/card-entry.html',
            'albusto-card',
            'width=460,height=640',
        );
        expect(hostWindow.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1500);

        messageListeners[0]?.({
            origin: 'https://evil.test',
            source: popup,
            data: { kind: 'cardframe:ready' },
        } as unknown as MessageEvent);
        expect(popup.postMessage).not.toHaveBeenCalled();

        messageListeners[0]?.({
            origin: 'https://cards.albusto.test',
            source: popup,
            data: { kind: 'cardframe:ready' },
        } as unknown as MessageEvent);
        expect(popup.postMessage).toHaveBeenCalledWith({
            kind: 'cardframe:init',
            mode: 'collect',
            accountId: 'acct_11',
            amount: 95,
        }, 'https://cards.albusto.test');
        expect(clearTimeout).toHaveBeenCalledWith(23);
        ackTimeoutCallback!();
        expect(assign).not.toHaveBeenCalled();
        expect(popup.close).not.toHaveBeenCalled();

        messageListeners[0]?.({
            origin: 'https://cards.albusto.test',
            source: popup,
            data: {
                kind: 'cardframe:payment_method',
                pmId: 'pm_card_11',
                brand: 'visa',
                last4: '4242',
            },
        } as unknown as MessageEvent);
        const popupResult = await handle!.result;
        expect(popupResult).toEqual({
            kind: 'cardframe:payment_method',
            pmId: 'pm_card_11',
            brand: 'visa',
            last4: '4242',
        });
        expect(clearTimeout).toHaveBeenCalledTimes(1);
    });

    it('reuses the existing manual-card session when popup acknowledgement times out', () => {
        const popup = {
            closed: false,
            postMessage: vi.fn(),
            close: vi.fn(),
        };
        let ackTimeoutCallback: (() => void) | null = null;
        const setItem = vi.fn();
        const assign = vi.fn();
        const resumeContext = { kind: 'manual-card', stage: 'collect', entityId: '1617' };
        const hostWindow = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/jobs/1617',
                search: '',
                hash: '',
                assign,
            },
            navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 15)' },
            matchMedia: vi.fn(() => ({ matches: false })),
            open: vi.fn(() => popup),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            setInterval: vi.fn(() => 17),
            clearInterval: vi.fn(),
            setTimeout: vi.fn((callback: () => void) => {
                ackTimeoutCallback = callback;
                return 23;
            }),
            clearTimeout: vi.fn(),
            sessionStorage: { setItem },
            crypto: { randomUUID: () => 'manual-ack-timeout' },
        } as unknown as Window;
        const session = {
            session_id: 11,
            client_secret: 'pi_secret',
            payment_intent_id: 'pi_11',
            account_id: 'acct_11',
            amount: 95,
            save_for_future: true,
        };

        openManualCardEntryPopup(session, undefined, {
            hostWindow,
            ackTimeoutMs: 25,
            sameWindowResumeContext: resumeContext,
        });
        ackTimeoutCallback!();

        expect(popup.close).toHaveBeenCalledOnce();
        expect(assign).toHaveBeenCalledOnce();
        expect(setItem).toHaveBeenCalledOnce();
        expect(JSON.parse(String(setItem.mock.calls[0]?.[1]))).toMatchObject({
            sessionId: 11,
            resumeContext,
        });
        expect(authedFetch).not.toHaveBeenCalled();
    });

    it('opens authenticate mode after server requires_action, then finalizes', async () => {
        const session = {
            session_id: 11,
            client_secret: 'pi_secret',
            payment_intent_id: 'pi_11',
            account_id: 'acct_11',
            amount: 95,
            save_for_future: true,
        };
        const confirmSession = vi.fn().mockResolvedValue({
            status: 'requires_action',
            clientSecret: 'pi_action_secret',
        });
        const finalizeSession = vi.fn().mockResolvedValue({ status: 'succeeded' });
        const onAuthenticationStarted = vi.fn();
        const openAuthentication = vi.fn(() => ({
            result: Promise.resolve({ kind: 'cardframe:result' as const, status: 'succeeded' as const }),
            cancel: vi.fn(),
        }));

        await expect(runManualCardCharge({
            session,
            paymentMethodId: 'pm_card_11',
            confirmSession,
            finalizeSession,
            openAuthentication,
            onAuthenticationStarted,
        })).resolves.toEqual({ status: 'succeeded' });

        expect(confirmSession).toHaveBeenCalledWith(11, 'pm_card_11');
        expect(onAuthenticationStarted).toHaveBeenCalledOnce();
        expect(openAuthentication).toHaveBeenCalledWith('pi_action_secret');
        expect(finalizeSession).toHaveBeenCalledWith(11);
    });

    it('does not finalize a declined authentication result', async () => {
        const finalizeSession = vi.fn();
        await expect(runManualCardCharge({
            session: {
                session_id: 11,
                client_secret: 'pi_secret',
                payment_intent_id: 'pi_11',
                account_id: 'acct_11',
                amount: 95,
                save_for_future: true,
            },
            paymentMethodId: 'pm_declined',
            confirmSession: vi.fn().mockResolvedValue({
                status: 'requires_action',
                clientSecret: 'pi_action_secret',
            }),
            finalizeSession,
            openAuthentication: () => ({
                result: Promise.resolve({
                    kind: 'cardframe:result',
                    status: 'requires_payment_method',
                    message: 'Your card was declined.',
                }),
                cancel: vi.fn(),
            }),
        })).resolves.toEqual({ status: 'failed', message: 'Your card was declined.' });
        expect(finalizeSession).not.toHaveBeenCalled();
    });

    it('uses the same-window fallback when card entry popup is blocked', () => {
        const assign = vi.fn();
        const hostWindow = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/jobs/1617',
                search: '',
                hash: '',
                assign,
            },
            navigator: {},
            open: vi.fn(() => null),
            sessionStorage: {
                setItem: vi.fn(),
            },
            crypto: { randomUUID: () => 'blocked-collect' },
        } as unknown as Window;

        expect(openManualCardEntryPopup({
            session_id: 11,
            client_secret: 'pi_secret',
            payment_intent_id: 'pi_11',
            account_id: 'acct_11',
            amount: 95,
            save_for_future: true,
        }, undefined, { hostWindow })).not.toBeNull();
        expect(assign).toHaveBeenCalledWith(expect.stringContaining('/card-entry.html?handoff='));
        expect(toastError).not.toHaveBeenCalled();
    });

    it('uses the same-window fallback when authentication popup is blocked', () => {
        const assign = vi.fn();
        const hostWindow = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/jobs/1617',
                search: '',
                hash: '',
                assign,
            },
            navigator: {},
            open: vi.fn(() => null),
            sessionStorage: {
                setItem: vi.fn(),
            },
            crypto: { randomUUID: () => 'blocked-auth' },
        } as unknown as Window;

        expect(openManualCardAuthenticationPopup({
            session_id: 11,
            client_secret: 'pi_secret',
            payment_intent_id: 'pi_11',
            account_id: 'acct_11',
            amount: 95,
            save_for_future: true,
        }, 'pi_action_secret', undefined, { hostWindow })).not.toBeNull();
        expect(assign).toHaveBeenCalledWith(expect.stringContaining('/card-entry.html?handoff='));
        expect(toastError).not.toHaveBeenCalled();
    });
});

describe('ambiguous result reconciliation', () => {
    it.each([
        {
            label: 'throws',
            getResult: () => vi.fn().mockRejectedValue(new Error('offline')),
            delays: [0],
        },
        {
            label: 'returns null',
            getResult: () => vi.fn().mockResolvedValue(null),
            delays: [0],
        },
        {
            label: 'times out on non-final statuses',
            getResult: () => vi.fn().mockResolvedValue({ ...SUCCEEDED, status: 'processing' }),
            delays: [0, 1000, 2000],
        },
        {
            label: 'returns a stale declined status',
            getResult: () => vi.fn().mockResolvedValue({
                ...SUCCEEDED,
                status: 'requires_payment_method',
            }),
            delays: [0],
        },
    ])('keeps server-confirmed success authoritative when result enrichment $label', async ({
        getResult: createGetResult,
        delays,
    }) => {
        const getResult = createGetResult();
        const onPaymentConfirmed = vi.fn(async () => true);
        const onUnresolved = vi.fn();
        const onDeclined = vi.fn();
        let state = manualCardReducer(INITIAL_MANUAL_CARD_STATE, { type: 'SESSION_READY' });
        state = manualCardReducer(state, { type: 'CHARGE' });
        state = manualCardReducer(state, { type: 'NETWORK_CHECKING' });
        const outcome = await runManualCardCharge({
            session: {
                session_id: 11,
                client_secret: 'pi_secret',
                payment_intent_id: 'pi_11',
                account_id: 'acct_11',
                amount: 95,
                save_for_future: true,
            },
            paymentMethodId: 'pm_card_11',
            confirmSession: vi.fn().mockResolvedValue({ status: 'succeeded' }),
            finalizeSession: vi.fn(),
            openAuthentication: vi.fn(),
        });
        expect(outcome.status).toBe('succeeded');
        if (outcome.status !== 'succeeded') throw new Error('Expected confirmed success');

        await handleCardEntryPopupResult({
            popupResult: { kind: 'cardframe:result', status: outcome.status },
            sessionId: 11,
            succeededFallback: {
                amount: SUCCEEDED.amount,
                brand: SUCCEEDED.brand,
                last4: SUCCEEDED.last4,
            },
            getResult,
            wait: async () => {},
            delays,
            onSucceeded: async result => {
                state = manualCardReducer(state, { type: 'SUCCEEDED', result });
                await settleFinanceSync(result, onPaymentConfirmed);
            },
            onDeclined,
            onUnresolved,
        });

        expect(getResult).toHaveBeenCalledTimes(delays.length);
        expect(state.phase).toBe('success');
        expect(state.networkChecking).toBe(false);
        expect(onUnresolved).not.toHaveBeenCalled();
        expect(onDeclined).not.toHaveBeenCalled();
        expect(onPaymentConfirmed).toHaveBeenCalledOnce();
        expect(onPaymentConfirmed).toHaveBeenCalledWith(expect.objectContaining({
            status: 'succeeded',
            amount: 95,
        }));
    });

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

    it('confirms with the popup PaymentMethod and projects requires_action', async () => {
        authedFetch.mockResolvedValueOnce(jsonResponse({
            status: 'requires_action',
            clientSecret: 'pi_action_secret',
            payment_intent_id: 'must-not-project',
        }));

        await expect(stripePaymentsApi.confirmManualCardSession(11, 'pm_card_11')).resolves.toEqual({
            status: 'requires_action',
            clientSecret: 'pi_action_secret',
        });
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/payments/manual-card-sessions/11/confirm',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payment_method_id: 'pm_card_11' }),
            },
        );
    });

    it('finalizes after popup authentication without sending a PaymentMethod again', async () => {
        authedFetch.mockResolvedValueOnce(jsonResponse({ status: 'succeeded' }));

        await expect(stripePaymentsApi.finalizeManualCardSession(11)).resolves.toEqual({
            status: 'succeeded',
        });
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/payments/manual-card-sessions/11/finalize',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            },
        );
    });
});
