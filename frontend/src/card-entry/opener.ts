import {
    CARDFRAME_INIT_KIND,
    type CardframeCompletionMessage,
    type CardframeInitMessage,
    isCardframeReadyMessage,
    isCardframeCompletionMessage,
    resolveCardEntryTarget,
} from './protocol';

export class CardEntryPopupBlockedError extends Error {
    constructor() {
        super('The card-entry pop-up was blocked');
        this.name = 'CardEntryPopupBlockedError';
    }
}

export interface CardEntryPopupHandle {
    result: Promise<CardframeCompletionMessage>;
    cancel: () => void;
}

export type CardEntryPopupRequest =
    | {
        mode: 'collect';
        accountId: string;
        amount: number;
    }
    | {
        mode: 'authenticate';
        accountId: string;
        amount: number;
        clientSecret: string;
    };

export interface CardEntryPopupLaunchOptions {
    hostWindow?: Window;
    configuredOrigin?: string;
    closePollMs?: number;
}

export function launchCardEntryPopup(
    request: CardEntryPopupRequest,
    {
        hostWindow = window,
        configuredOrigin = import.meta.env.VITE_CARD_ENTRY_ORIGIN,
        closePollMs = 250,
    }: CardEntryPopupLaunchOptions = {},
): CardEntryPopupHandle {
    const target = resolveCardEntryTarget(hostWindow.location.origin, configuredOrigin);
    const popup = hostWindow.open(
        target.url,
        'albusto-card',
        'width=460,height=640',
    );
    if (!popup) throw new CardEntryPopupBlockedError();

    let initialized = false;
    let finished = false;
    let closePoll: number | null = null;
    let resolveResult!: (result: CardframeCompletionMessage) => void;
    const result = new Promise<CardframeCompletionMessage>(resolve => {
        resolveResult = resolve;
    });

    const cleanup = () => {
        hostWindow.removeEventListener('message', onMessage);
        if (closePoll != null) {
            hostWindow.clearInterval(closePoll);
            closePoll = null;
        }
    };

    const finish = (message: CardframeCompletionMessage) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolveResult(message);
    };

    const onMessage = (event: MessageEvent) => {
        if (finished || event.origin !== target.origin || event.source !== popup) return;
        if (isCardframeReadyMessage(event.data)) {
            if (initialized) return;
            initialized = true;
            const initMessage: CardframeInitMessage = {
                kind: CARDFRAME_INIT_KIND,
                mode: request.mode,
                accountId: request.accountId,
                amount: request.amount,
                ...(request.mode === 'authenticate'
                    ? { clientSecret: request.clientSecret }
                    : {}),
            } as CardframeInitMessage;
            popup.postMessage(initMessage, target.origin);
            return;
        }
        if (initialized && isCardframeCompletionMessage(event.data)) finish(event.data);
    };

    hostWindow.addEventListener('message', onMessage);
    closePoll = hostWindow.setInterval(() => {
        if (popup.closed) {
            finish({ kind: 'cardframe:result', status: 'canceled' });
        }
    }, closePollMs);

    return {
        result,
        cancel: () => {
            finish({ kind: 'cardframe:result', status: 'canceled' });
            if (!popup.closed) popup.close();
        },
    };
}
