import { describe, expect, it, vi } from 'vitest';
import { createCardEntryController } from './controller';
import {
    resolveCardEntryTarget,
    resolveExpectedAppOrigin,
} from './protocol';

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
    it('posts ready, ignores the wrong origin, accepts init from the opener, and posts confirm success', async () => {
        const opener = { postMessage: vi.fn() } as unknown as Window;
        const messageListeners: Array<(event: MessageEvent) => void> = [];
        const cardHandlers: Array<{
            onChange: (event: { complete: boolean; error?: { message?: string } }) => void;
            onFocus: () => void;
            onBlur: () => void;
        }> = [];
        const card = {};
        const stripe = {
            confirmCardPayment: vi.fn().mockResolvedValue({
                paymentIntent: { status: 'succeeded' },
            }),
        };
        const loadStripe = vi.fn().mockResolvedValue(stripe);
        const destroy = vi.fn();
        const closeWindow = vi.fn();
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
            onStateChange: vi.fn(),
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
                clientSecret: 'pi_secret',
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
                clientSecret: 'pi_secret',
                accountId: 'acct_11',
                amount: 95,
            },
        } as unknown as MessageEvent);
        await vi.waitFor(() => expect(loadStripe).toHaveBeenCalledWith('acct_11'));

        cardHandlers[0]?.onChange({ complete: true });
        await controller.confirm();

        expect(stripe.confirmCardPayment).toHaveBeenCalledWith('pi_secret', {
            payment_method: { card },
        });
        expect(opener.postMessage).toHaveBeenLastCalledWith(
            { kind: 'cardframe:result', status: 'succeeded' },
            'https://app.albusto.test',
        );
        expect(destroy).toHaveBeenCalledOnce();
        expect(closeWindow).toHaveBeenCalledOnce();
    });
});
