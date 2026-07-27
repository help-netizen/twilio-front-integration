import type { ManualCardSession } from '../services/stripePaymentsApi';
import {
    CARDFRAME_INIT_KIND,
    type CardframeResultMessage,
    isCardframeReadyMessage,
    isCardframeResultMessage,
    resolveCardEntryTarget,
} from './protocol';

export class CardEntryPopupBlockedError extends Error {
    constructor() {
        super('The card-entry pop-up was blocked');
        this.name = 'CardEntryPopupBlockedError';
    }
}

export interface CardEntryPopupHandle {
    result: Promise<CardframeResultMessage>;
    cancel: () => void;
}

export interface CardEntryPopupLaunchOptions {
    hostWindow?: Window;
    configuredOrigin?: string;
    closePollMs?: number;
}

export function launchCardEntryPopup(
    session: ManualCardSession,
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
    let resolveResult!: (result: CardframeResultMessage) => void;
    const result = new Promise<CardframeResultMessage>(resolve => {
        resolveResult = resolve;
    });

    const cleanup = () => {
        hostWindow.removeEventListener('message', onMessage);
        if (closePoll != null) {
            hostWindow.clearInterval(closePoll);
            closePoll = null;
        }
    };

    const finish = (message: CardframeResultMessage) => {
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
            popup.postMessage({
                kind: CARDFRAME_INIT_KIND,
                clientSecret: session.client_secret,
                accountId: session.account_id,
                amount: session.amount,
            }, target.origin);
            return;
        }
        if (initialized && isCardframeResultMessage(event.data)) finish(event.data);
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
