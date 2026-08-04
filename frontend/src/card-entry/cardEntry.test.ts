import { describe, expect, it, vi } from 'vitest';
import {
    createCardEntryController,
    focusZipInputIfNeeded,
    INITIAL_CARD_ENTRY_STATE,
    isAddCardEnabled,
    type CardEntryState,
} from './controller';
import {
    resolveCardEntryTarget,
    resolveExpectedAppOrigin,
} from './protocol';
import {
    completeCardEntrySameWindow,
    consumeCardEntryHandoff,
    consumeCardEntrySameWindowResult,
} from './handoff';
import { isStandalonePwa, launchCardEntryPopup } from './opener';
import { createCardElementOptions } from './stripeCard';

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        clear: () => values.clear(),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() { return values.size; },
    } as Storage;
}

describe('same-window card-entry handoff', () => {
    it('uses same-window mode immediately in an Android standalone PWA', () => {
        const storage = memoryStorage();
        const assign = vi.fn();
        const open = vi.fn();
        const hostWindow = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/jobs/1617',
                search: '',
                hash: '',
                assign,
            },
            navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 15)' },
            matchMedia: vi.fn(() => ({ matches: true })),
            open,
            sessionStorage: storage,
            crypto: { randomUUID: () => 'handoff-key' },
        } as unknown as Window;

        expect(isStandalonePwa(hostWindow)).toBe(true);
        launchCardEntryPopup({
            mode: 'authenticate',
            accountId: 'acct_secret',
            amount: 95,
            clientSecret: 'pi_secret_value',
        }, { hostWindow, sessionId: 11 });

        expect(open).not.toHaveBeenCalled();
        const assignedUrl = String(assign.mock.calls[0]?.[0]);
        expect(assignedUrl).toContain('/card-entry.html?handoff=');
        expect(assignedUrl).toContain('return_to=%2Fjobs%2F1617');
        expect(assignedUrl).not.toContain('pi_secret_value');
        expect(assignedUrl).not.toContain('acct_secret');

        const cardWindow = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/card-entry.html',
                search: new URL(assignedUrl, 'https://app.albusto.test').search,
                hash: '',
            },
            sessionStorage: storage,
        };
        const key = new URLSearchParams(cardWindow.location.search).get('handoff')!;
        expect(storage.getItem(key)).not.toBeNull();
        const consumed = consumeCardEntryHandoff(cardWindow, Date.now());
        expect(consumed.handoff?.initMessage).toEqual({
            kind: 'cardframe:init',
            mode: 'authenticate',
            accountId: 'acct_secret',
            amount: 95,
            clientSecret: 'pi_secret_value',
        });
        expect(storage.getItem(key)).toBeNull();
    });

    it('falls back with the same session when an opened popup never acknowledges', () => {
        const storage = memoryStorage();
        const assign = vi.fn();
        const popup = {
            closed: false,
            postMessage: vi.fn(),
            close: vi.fn(),
        };
        let ackTimeoutCallback: (() => void) | null = null;
        const clearTimeout = vi.fn();
        const resumeContext = { kind: 'manual-card', entityId: '1617' };
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
            clearTimeout,
            sessionStorage: storage,
            crypto: { randomUUID: () => 'ack-timeout-key' },
        } as unknown as Window;

        launchCardEntryPopup({
            mode: 'collect',
            accountId: 'acct_11',
            amount: 95,
        }, {
            hostWindow,
            ackTimeoutMs: 25,
            sessionId: 11,
            sameWindowResumeContext: resumeContext,
        });
        expect(hostWindow.setTimeout).toHaveBeenCalledWith(expect.any(Function), 25);

        ackTimeoutCallback!();

        expect(popup.close).toHaveBeenCalledOnce();
        expect(clearTimeout).toHaveBeenCalledWith(23);
        expect(assign).toHaveBeenCalledOnce();
        const assignedUrl = String(assign.mock.calls[0]?.[0]);
        const consumed = consumeCardEntryHandoff({
            location: {
                origin: 'https://app.albusto.test',
                search: new URL(assignedUrl, 'https://app.albusto.test').search,
            },
            sessionStorage: storage,
        });
        expect(consumed.handoff?.sessionId).toBe(11);
        expect(consumed.handoff?.resumeContext).toEqual(resumeContext);
        expect(popup.postMessage).not.toHaveBeenCalled();
    });

    it('falls back to same-window mode when the popup is blocked', () => {
        const storage = memoryStorage();
        const assign = vi.fn();
        const open = vi.fn(() => null);
        const hostWindow = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/jobs/1617',
                search: '',
                hash: '',
                assign,
            },
            navigator: {},
            matchMedia: vi.fn(() => ({ matches: false })),
            open,
            sessionStorage: storage,
            crypto: { randomUUID: () => 'blocked-key' },
        } as unknown as Window;

        expect(() => launchCardEntryPopup({
            mode: 'collect',
            accountId: 'acct_11',
            amount: 95,
        }, { hostWindow, sessionId: 11 })).not.toThrow();
        expect(open).toHaveBeenCalledOnce();
        expect(assign).toHaveBeenCalledOnce();
    });

    it('deletes an expired handoff and reports it as unavailable', () => {
        const storage = memoryStorage();
        const assign = vi.fn();
        const host = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/jobs/1617',
                search: '',
                hash: '',
                assign,
            },
            sessionStorage: storage,
            crypto: { randomUUID: () => 'expired-key' },
        };
        launchCardEntryPopup({
            mode: 'collect',
            accountId: 'acct_11',
            amount: 95,
        }, {
            hostWindow: {
                ...host,
                navigator: { standalone: true },
                matchMedia: vi.fn(() => ({ matches: false })),
                open: vi.fn(),
            } as unknown as Window,
            sessionId: 11,
        });
        const assignedUrl = String(assign.mock.calls[0]?.[0]);
        const search = new URL(assignedUrl, host.location.origin).search;
        const key = new URLSearchParams(search).get('handoff')!;
        expect(consumeCardEntryHandoff({
            location: { origin: host.location.origin, search },
            sessionStorage: storage,
        }, Date.now() + 11 * 60 * 1000)).toEqual({
            handoff: null,
            returnTo: '/jobs/1617',
            requested: true,
        });
        expect(storage.getItem(key)).toBeNull();
    });

    it('returns to the same job and consumes the completion result only once', () => {
        const storage = memoryStorage();
        const replace = vi.fn();
        const cardWindow = {
            location: {
                origin: 'https://app.albusto.test',
                pathname: '/card-entry.html',
                search: '',
                hash: '',
                replace,
            },
            sessionStorage: storage,
            crypto: { randomUUID: () => 'result-key' },
        };
        completeCardEntrySameWindow(cardWindow, {
            sessionId: 11,
            initMessage: {
                kind: 'cardframe:init',
                mode: 'collect',
                accountId: 'acct_11',
                amount: 95,
            },
            returnTo: '/jobs/1617',
        }, {
            kind: 'cardframe:result',
            status: 'succeeded',
        });

        expect(replace).toHaveBeenCalledWith('/jobs/1617?cardResult=cardframe%3Aresult-key');
        const crmLocation = {
            origin: 'https://app.albusto.test',
            pathname: '/jobs/1617',
            search: '?cardResult=cardframe%3Aresult-key',
            hash: '',
        };
        const history = {
            replaceState: vi.fn((_data: unknown, _unused: string, url?: string | URL | null) => {
                crmLocation.search = new URL(String(url), crmLocation.origin).search;
            }),
        };
        const crmWindow = { location: crmLocation, sessionStorage: storage, history };

        expect(consumeCardEntrySameWindowResult(crmWindow)).toEqual({
            sessionId: 11,
            completion: { kind: 'cardframe:result', status: 'succeeded' },
        });
        expect(crmLocation.pathname).toBe('/jobs/1617');
        expect(crmLocation.search).toBe('');
        expect(consumeCardEntrySameWindowResult(crmWindow)).toBeNull();
    });
});

describe('card-entry origin resolution', () => {
    it('defaults to same-origin and prefers the opener referrer for popup validation', () => {
        expect(resolveCardEntryTarget('https://app.albusto.test')).toEqual({
            origin: 'https://app.albusto.test',
            url: 'https://app.albusto.test/card-entry.html',
        });
        expect(resolveExpectedAppOrigin(
            'https://app.albusto.test/invoices',
            'https://cards.albusto.test',
            'https://cards.albusto.test',
        )).toBe('https://app.albusto.test');
    });
});

describe('standalone card-entry controller', () => {
    it('requires a complete card and ZIP, then returns only masked card details', async () => {
        const opener = { postMessage: vi.fn() } as unknown as Window;
        const messageListeners: Array<(event: MessageEvent) => void> = [];
        const cardHandlers: Array<{
            onChange: (event: { complete: boolean; error?: { message?: string } }) => void;
            onFocus: () => void;
            onBlur: () => void;
        }> = [];
        const card = {};
        const stripe = {
            createPaymentMethod: vi.fn().mockResolvedValue({
                paymentMethod: {
                    id: 'pm_card_11',
                    card: { brand: 'visa', last4: '4242' },
                },
            }),
        };
        const loadStripe = vi.fn().mockResolvedValue(stripe);
        const destroy = vi.fn();
        const closeWindow = vi.fn();
        let latestState: CardEntryState = INITIAL_CARD_ENTRY_STATE;
        const controller = createCardEntryController({
            opener,
            expectedAppOrigin: 'https://app.albusto.test',
            addMessageListener: listener => { messageListeners.push(listener); },
            removeMessageListener: vi.fn(),
            loadStripe,
            mountCard: (_stripe, _clientSecret, _mountNode, handlers) => {
                cardHandlers.push(handlers);
                return { card, destroy };
            },
            getMountNode: () => ({} as HTMLDivElement),
            closeWindow,
            onStateChange: state => { latestState = state; },
        });

        controller.start();
        expect(opener.postMessage).toHaveBeenCalledWith(
            { kind: 'cardframe:ready' },
            'https://app.albusto.test',
        );

        messageListeners[0]?.({
            origin: 'https://evil.test',
            source: opener,
            data: {
                kind: 'cardframe:init',
                mode: 'collect',
                accountId: 'acct_11',
                amount: 95,
            },
        } as unknown as MessageEvent);
        expect(loadStripe).not.toHaveBeenCalled();

        messageListeners[0]?.({
            origin: 'https://app.albusto.test',
            source: opener,
            data: {
                kind: 'cardframe:init',
                mode: 'collect',
                accountId: 'acct_11',
                amount: 95,
            },
        } as unknown as MessageEvent);
        await vi.waitFor(() => expect(loadStripe).toHaveBeenCalledWith('acct_11'));

        controller.setZip('10001');
        expect(isAddCardEnabled(latestState)).toBe(false);
        await controller.confirm();
        expect(stripe.createPaymentMethod).not.toHaveBeenCalled();

        controller.setZip('');
        cardHandlers[0]?.onChange({ complete: true });
        expect(isAddCardEnabled(latestState)).toBe(false);
        await controller.confirm();
        expect(stripe.createPaymentMethod).not.toHaveBeenCalled();

        controller.setZip('   ');
        expect(isAddCardEnabled(latestState)).toBe(false);
        await controller.confirm();
        expect(stripe.createPaymentMethod).not.toHaveBeenCalled();

        controller.setZip(' 10001 ');
        expect(isAddCardEnabled(latestState)).toBe(true);
        await controller.confirm();

        expect(stripe.createPaymentMethod).toHaveBeenCalledWith({
            type: 'card',
            card,
            billing_details: {
                address: {
                    postal_code: '10001',
                },
            },
        });
        expect(opener.postMessage).toHaveBeenLastCalledWith(
            {
                kind: 'cardframe:payment_method',
                pmId: 'pm_card_11',
                brand: 'visa',
                last4: '4242',
            },
            'https://app.albusto.test',
        );
        expect(destroy).toHaveBeenCalledOnce();
        expect(closeWindow).toHaveBeenCalledOnce();
    });

    it('focuses ZIP once only after the card is complete with ZIP empty', () => {
        const focus = vi.fn();
        const readyState: CardEntryState = {
            ...INITIAL_CARD_ENTRY_STATE,
            phase: 'idle',
            mode: 'collect',
        };

        let alreadyFocused = focusZipInputIfNeeded(
            { ...readyState, cardComplete: false },
            { focus },
            false,
        );
        expect(alreadyFocused).toBe(false);
        expect(focus).not.toHaveBeenCalled();

        alreadyFocused = focusZipInputIfNeeded(
            { ...readyState, cardComplete: true },
            { focus },
            alreadyFocused,
        );
        expect(alreadyFocused).toBe(true);
        expect(focus).toHaveBeenCalledOnce();

        alreadyFocused = focusZipInputIfNeeded(
            { ...readyState, cardComplete: true },
            { focus },
            alreadyFocused,
        );
        expect(alreadyFocused).toBe(true);
        expect(focus).toHaveBeenCalledOnce();
    });

    it('hides postal code inside the combined Stripe card Element', () => {
        expect(createCardElementOptions()).toMatchObject({
            hidePostalCode: true,
        });
    });

    it('runs authenticate mode with handleNextAction and never mounts a card field', async () => {
        const opener = { postMessage: vi.fn() } as unknown as Window;
        const messageListeners: Array<(event: MessageEvent) => void> = [];
        const stripe = {
            handleNextAction: vi.fn().mockResolvedValue({
                paymentIntent: { status: 'succeeded' },
            }),
        };
        const mountCard = vi.fn();
        const closeWindow = vi.fn();
        const controller = createCardEntryController({
            opener,
            expectedAppOrigin: 'https://app.albusto.test',
            addMessageListener: listener => { messageListeners.push(listener); },
            removeMessageListener: vi.fn(),
            loadStripe: vi.fn().mockResolvedValue(stripe),
            mountCard,
            getMountNode: () => null,
            closeWindow,
            onStateChange: vi.fn(),
        });

        controller.start();
        messageListeners[0]?.({
            origin: 'https://app.albusto.test',
            source: opener,
            data: {
                kind: 'cardframe:init',
                mode: 'authenticate',
                clientSecret: 'pi_secret',
                accountId: 'acct_11',
                amount: 95,
            },
        } as unknown as MessageEvent);

        await vi.waitFor(() => expect(stripe.handleNextAction).toHaveBeenCalledWith({
            clientSecret: 'pi_secret',
        }));
        expect(mountCard).not.toHaveBeenCalled();
        expect(opener.postMessage).toHaveBeenLastCalledWith(
            { kind: 'cardframe:result', status: 'succeeded' },
            'https://app.albusto.test',
        );
        expect(closeWindow).toHaveBeenCalledOnce();
    });
});
