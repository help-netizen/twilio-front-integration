import {
    CARDFRAME_INIT_KIND,
    type CardframeCompletionMessage,
    type CardframeInitMessage,
    isCardframeReadyMessage,
    isCardframeCompletionMessage,
    resolveCardEntryTarget,
} from './protocol';
import { beginCardEntrySameWindow } from './handoff';

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
    ackTimeoutMs?: number;
    sessionId?: number;
    sameWindowResumeContext?: unknown;
}

export function isStandalonePwa(hostWindow: Window = window): boolean {
    return hostWindow.matchMedia?.('(display-mode: standalone)').matches === true
        || (hostWindow.navigator as (Navigator & { standalone?: boolean }) | undefined)?.standalone === true;
}

export function launchCardEntryPopup(
    request: CardEntryPopupRequest,
    {
        hostWindow = window,
        configuredOrigin = import.meta.env.VITE_CARD_ENTRY_ORIGIN,
        closePollMs = 250,
        ackTimeoutMs = 1500,
        sessionId,
        sameWindowResumeContext,
    }: CardEntryPopupLaunchOptions = {},
): CardEntryPopupHandle {
    const initMessage: CardframeInitMessage = {
        kind: CARDFRAME_INIT_KIND,
        mode: request.mode,
        accountId: request.accountId,
        amount: request.amount,
        ...(request.mode === 'authenticate'
            ? { clientSecret: request.clientSecret }
            : {}),
    } as CardframeInitMessage;

    const launchSameWindow = () => {
        if (sessionId == null) {
            throw new Error('Card-entry session id is required for same-window mode');
        }
        beginCardEntrySameWindow(hostWindow, {
            sessionId,
            initMessage,
            ...(sameWindowResumeContext === undefined
                ? {}
                : { resumeContext: sameWindowResumeContext }),
        });
        return {
            result: new Promise<CardframeCompletionMessage>(() => {}),
            cancel: () => {},
        };
    };

    if (isStandalonePwa(hostWindow)) return launchSameWindow();

    const target = resolveCardEntryTarget(hostWindow.location.origin, configuredOrigin);
    const popup = hostWindow.open(
        target.url,
        'albusto-card',
        'width=460,height=640',
    );
    if (!popup) return launchSameWindow();

    let initialized = false;
    let finished = false;
    let closePoll: number | null = null;
    let ackTimeout: number | null = null;
    let resolveResult!: (result: CardframeCompletionMessage) => void;
    const result = new Promise<CardframeCompletionMessage>(resolve => {
        resolveResult = resolve;
    });

    const clearAckTimeout = () => {
        if (ackTimeout == null) return;
        hostWindow.clearTimeout(ackTimeout);
        ackTimeout = null;
    };

    const cleanup = () => {
        hostWindow.removeEventListener('message', onMessage);
        clearAckTimeout();
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
            clearAckTimeout();
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
    ackTimeout = hostWindow.setTimeout(() => {
        if (finished || initialized) return;
        finished = true;
        cleanup();
        try {
            popup.close();
        } catch {
            // Some embedded/cross-origin contexts deny access to the orphan window.
        }
        launchSameWindow();
    }, ackTimeoutMs);

    return {
        result,
        cancel: () => {
            finish({ kind: 'cardframe:result', status: 'canceled' });
            if (!popup.closed) popup.close();
        },
    };
}
