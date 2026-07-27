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
import { createCardElementOptions } from './stripeCard';

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
