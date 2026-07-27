import {
    CARDFRAME_CARD_CHANGE_KIND,
    CARDFRAME_PAYMENT_METHOD_KIND,
    CARDFRAME_READY_KIND,
    CARDFRAME_RESULT_KIND,
    type CardframeCompletionMessage,
    type CardframeMode,
    isCardframeInitMessage,
} from './protocol';
import {
    decideConfirmation,
    decidePaymentMethod,
    type StripeCardHandlers,
} from './stripeCard';

export type CardEntryPhase = 'waiting' | 'loading' | 'idle' | 'submitting' | 'error';

export interface CardEntryState {
    phase: CardEntryPhase;
    mode: CardframeMode | null;
    amount: number | null;
    cardComplete: boolean;
    cardFocused: boolean;
    zip: string;
    message: string | null;
}

export const INITIAL_CARD_ENTRY_STATE: CardEntryState = {
    phase: 'waiting',
    mode: null,
    amount: null,
    cardComplete: false,
    cardFocused: false,
    zip: '',
    message: null,
};

export function isAddCardEnabled(state: CardEntryState): boolean {
    return state.mode === 'collect'
        && state.phase === 'idle'
        && state.cardComplete
        && Boolean(state.zip.trim());
}

export function focusZipInputIfNeeded(
    state: CardEntryState,
    input: Pick<HTMLInputElement, 'focus'> | null,
    alreadyFocused: boolean,
): boolean {
    if (
        alreadyFocused
        || state.mode !== 'collect'
        || state.phase !== 'idle'
        || !state.cardComplete
        || Boolean(state.zip.trim())
        || !input
    ) {
        return alreadyFocused;
    }
    input.focus();
    return true;
}

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
        clientSecret: string | null,
        mountNode: HTMLDivElement,
        handlers: StripeCardHandlers,
    ) => MountedCard;
    getMountNode: () => HTMLDivElement | null;
    closeWindow: () => void;
    onStateChange: (state: CardEntryState) => void;
}

export interface CardEntryController {
    start: () => void;
    setZip: (zip: string) => void;
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
    let mode: CardframeMode | null = null;

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

    const finish = (message: CardframeCompletionMessage) => {
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
        mode = event.data.mode;
        clientSecret = event.data.mode === 'authenticate'
            ? event.data.clientSecret
            : '';
        setState({
            phase: 'loading',
            mode,
            amount: event.data.amount,
            cardComplete: false,
            zip: '',
            message: null,
        });

        void options.loadStripe(event.data.accountId).then(loadedStripe => {
            if (disposed || finished) return;
            stripe = loadedStripe;
            if (mode === 'authenticate') {
                setState({ phase: 'submitting' });
                return loadedStripe.handleNextAction({ clientSecret }).then((response: any) => {
                    if (disposed || finished) return;
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
                            : 'Stripe did not return a final authentication result.',
                    });
                });
            }
            const mountNode = options.getMountNode();
            if (!mountNode) throw new Error('Secure card field could not be mounted');
            const mounted = options.mountCard(
                loadedStripe,
                null,
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
            return undefined;
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
        setZip: zip => {
            if (disposed || finished || mode !== 'collect') return;
            setState({ zip });
        },
        confirm: async () => {
            if (
                disposed
                || finished
                || !isAddCardEnabled(state)
                || !stripe
                || !mountedCard
            ) {
                return;
            }
            setState({ phase: 'submitting', message: null });
            try {
                const response = await stripe.createPaymentMethod({
                    type: 'card',
                    card: mountedCard.card,
                    billing_details: {
                        address: {
                            postal_code: state.zip.trim(),
                        },
                    },
                });
                const decision = decidePaymentMethod(response);
                if (decision.kind === 'created') {
                    finish({
                        kind: CARDFRAME_PAYMENT_METHOD_KIND,
                        pmId: decision.pmId,
                        brand: decision.brand,
                        last4: decision.last4,
                    });
                    return;
                }
                setState({ phase: 'idle', message: decision.message });
            } catch (error: any) {
                setState({
                    phase: 'idle',
                    message: String(error?.message || 'Could not collect the card'),
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
