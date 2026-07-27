import {
    CARDFRAME_CARD_CHANGE_KIND,
    CARDFRAME_READY_KIND,
    CARDFRAME_RESULT_KIND,
    type CardframeResultMessage,
    isCardframeInitMessage,
} from './protocol';
import { decideConfirmation, type StripeCardHandlers } from './stripeCard';

export type CardEntryPhase = 'waiting' | 'loading' | 'idle' | 'submitting' | 'error';

export interface CardEntryState {
    phase: CardEntryPhase;
    amount: number | null;
    cardComplete: boolean;
    cardFocused: boolean;
    message: string | null;
}

export const INITIAL_CARD_ENTRY_STATE: CardEntryState = {
    phase: 'waiting',
    amount: null,
    cardComplete: false,
    cardFocused: false,
    message: null,
};

interface MountedCard {
    card: any;
    destroy: () => void;
}

interface CardEntryControllerOptions {
    opener: Window | null;
    expectedAppOrigin: string;
    addMessageListener: (listener: (event: MessageEvent) => void) => void;
    removeMessageListener: (listener: (event: MessageEvent) => void) => void;
    loadStripe: (accountId: string) => Promise<any>;
    mountCard: (
        stripe: any,
        clientSecret: string,
        mountNode: HTMLDivElement,
        handlers: StripeCardHandlers,
    ) => MountedCard;
    getMountNode: () => HTMLDivElement | null;
    closeWindow: () => void;
    onStateChange: (state: CardEntryState) => void;
}

export interface CardEntryController {
    start: () => void;
    confirm: () => Promise<void>;
    cancel: () => void;
    dispose: () => void;
}

export function createCardEntryController(options: CardEntryControllerOptions): CardEntryController {
    let state = INITIAL_CARD_ENTRY_STATE;
    let started = false;
    let initialized = false;
    let finished = false;
    let disposed = false;
    let stripe: any = null;
    let mountedCard: MountedCard | null = null;
    let clientSecret = '';

    const setState = (patch: Partial<CardEntryState>) => {
        state = { ...state, ...patch };
        options.onStateChange(state);
    };

    const postToOpener = (message: unknown) => {
        options.opener?.postMessage(message, options.expectedAppOrigin);
    };

    const cleanup = () => {
        options.removeMessageListener(onMessage);
        mountedCard?.destroy();
        mountedCard = null;
    };

    const finish = (message: CardframeResultMessage) => {
        if (finished || disposed) return;
        finished = true;
        postToOpener(message);
        cleanup();
        options.closeWindow();
    };

    const onMessage = (event: MessageEvent) => {
        if (
            disposed
            || finished
            || initialized
            || event.origin !== options.expectedAppOrigin
            || event.source !== options.opener
            || !isCardframeInitMessage(event.data)
        ) {
            return;
        }
        initialized = true;
        clientSecret = event.data.clientSecret;
        setState({
            phase: 'loading',
            amount: event.data.amount,
            cardComplete: false,
            message: null,
        });

        void options.loadStripe(event.data.accountId).then(loadedStripe => {
            if (disposed || finished) return;
            const mountNode = options.getMountNode();
            if (!mountNode) throw new Error('Secure card field could not be mounted');
            stripe = loadedStripe;
            const mounted = options.mountCard(
                loadedStripe,
                clientSecret,
                mountNode,
                {
                    onChange: change => {
                        if (disposed || finished) return;
                        setState({
                            cardComplete: change.complete,
                            message: change.error?.message || null,
                        });
                        postToOpener({
                            kind: CARDFRAME_CARD_CHANGE_KIND,
                            complete: change.complete,
                        });
                    },
                    onFocus: () => setState({ cardFocused: true }),
                    onBlur: () => setState({ cardFocused: false }),
                },
            );
            if (disposed || finished) {
                mounted.destroy();
                return;
            }
            mountedCard = mounted;
            setState({ phase: 'idle' });
        }).catch(error => {
            finish({
                kind: CARDFRAME_RESULT_KIND,
                status: 'failed',
                message: String(error?.message || 'Could not start secure card entry'),
            });
        });
    };

    return {
        start: () => {
            if (started || disposed) return;
            started = true;
            options.addMessageListener(onMessage);
            if (!options.opener) {
                setState({
                    phase: 'error',
                    message: 'Open card entry from Albusto to continue.',
                });
                return;
            }
            postToOpener({ kind: CARDFRAME_READY_KIND });
        },
        confirm: async () => {
            if (
                disposed
                || finished
                || state.phase !== 'idle'
                || !state.cardComplete
                || !stripe
                || !mountedCard
            ) {
                return;
            }
            setState({ phase: 'submitting', message: null });
            try {
                const response = await stripe.confirmCardPayment(clientSecret, {
                    payment_method: { card: mountedCard.card },
                });
                const decision = decideConfirmation(response);
                if (decision.kind === 'succeeded') {
                    finish({ kind: CARDFRAME_RESULT_KIND, status: 'succeeded' });
                    return;
                }
                if (decision.kind === 'declined') {
                    finish({
                        kind: CARDFRAME_RESULT_KIND,
                        status: 'requires_payment_method',
                        ...(decision.message ? { message: decision.message } : {}),
                    });
                    return;
                }
                finish({
                    kind: CARDFRAME_RESULT_KIND,
                    status: 'failed',
                    message: decision.kind === 'validation'
                        ? decision.message
                        : 'Stripe did not return a final payment result.',
                });
            } catch (error: any) {
                finish({
                    kind: CARDFRAME_RESULT_KIND,
                    status: 'failed',
                    message: String(error?.message || 'Could not confirm the payment'),
                });
            }
        },
        cancel: () => finish({ kind: CARDFRAME_RESULT_KIND, status: 'canceled' }),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            cleanup();
        },
    };
}
