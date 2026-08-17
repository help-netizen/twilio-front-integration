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

    /*
     * IN-PAGE, not a second window (owner, 2026-08-17: "супер неудобно").
     * The card form used to open as a real popup — on desktop that throws the
     * user into a bare 460×640 browser window somewhere else on the screen,
     * away from the invoice they were looking at.
     *
     * It stays a SEPARATE DOCUMENT, which is the whole point of the second Vite
     * entry: `js.stripe.com` is loaded by card-entry.html, never by the CRM
     * bundle, so the CRM's own graph keeps zero Stripe script (CARDFRAME-001).
     * An iframe preserves that exactly — same document boundary, same origin
     * check, same postMessage handshake — and simply puts the frame where the
     * user asked for it. `allow="payment"` is required for 3-D Secure to run
     * its challenge inside the frame.
     */
    const doc = hostWindow.document;
    // No document to mount into (a non-DOM host, or a document being torn down)
    // → the same-window hand-off, exactly as a blocked popup used to do.
    if (!doc?.body || typeof doc.createElement !== 'function') return launchSameWindow();
    const overlay = doc.createElement('div');
    overlay.setAttribute('data-testid', 'card-entry-overlay');
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:140',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:rgba(25,25,25,0.45)', 'padding:16px',
    ].join(';');

    const frame = doc.createElement('iframe');
    frame.src = target.url;
    frame.title = 'Card details';
    frame.allow = 'payment *';
    frame.style.cssText = [
        'width:min(460px,100%)', 'height:min(640px,100%)',
        'border:0', 'border-radius:22px',
        'background:var(--blanc-surface-strong,#fff)',
        'box-shadow:0 24px 60px rgba(25,25,25,0.22)',
    ].join(';');
    overlay.appendChild(frame);
    doc.body.appendChild(overlay);

    const teardownFrame = () => {
        overlay.remove();
    };

    const frameWindow = () => frame.contentWindow;

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
        hostWindow.removeEventListener('keydown', onKeyDown);
        teardownFrame();
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
        if (finished || event.origin !== target.origin || event.source !== frameWindow()) return;
        if (isCardframeReadyMessage(event.data)) {
            if (initialized) return;
            initialized = true;
            clearAckTimeout();
            frameWindow()?.postMessage(initMessage, target.origin);
            return;
        }
        if (initialized && isCardframeCompletionMessage(event.data)) finish(event.data);
    };

    hostWindow.addEventListener('message', onMessage);
    const cancelFromUser = () => finish({ kind: 'cardframe:result', status: 'canceled' });
    overlay.addEventListener('click', event => {
        if (event.target === overlay) cancelFromUser();
    });
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') cancelFromUser();
    };
    hostWindow.addEventListener('keydown', onKeyDown);
    void closePollMs;
    ackTimeout = hostWindow.setTimeout(() => {
        if (finished || initialized) return;
        finished = true;
        cleanup();
        launchSameWindow();
    }, ackTimeoutMs);

    return {
        result,
        cancel: () => {
            finish({ kind: 'cardframe:result', status: 'canceled' });
        },
    };
}
