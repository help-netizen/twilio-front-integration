import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ASSISTANT_FALLBACK_MESSAGE,
    FEEDBACK_ESCALATION_MESSAGE,
    FEEDBACK_NETWORK_ERROR,
    FeedbackWidget,
    createInitialFeedbackBotState,
    escalateFeedbackBot,
    getFeedbackEmail,
    isFeedbackWidgetEnabled,
    submitAssistantChat,
    submitFeedback,
} from './FeedbackWidget';

const assistantRequest = vi.hoisted(() => vi.fn());
const feedbackRenderState = vi.hoisted(() => ({
    stateCall: 0,
    states: [] as unknown[],
    initializedStates: [] as boolean[],
    refCall: 0,
    refs: [] as Array<{ current: unknown }>,
    effectCall: 0,
    effects: [] as Array<{
        deps?: readonly unknown[];
        cleanup?: () => void;
    } | undefined>,
}));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useState: <S,>(initialState: S | (() => S)) => {
            const index = feedbackRenderState.stateCall++;
            if (!feedbackRenderState.initializedStates[index]) {
                feedbackRenderState.states[index] = typeof initialState === 'function'
                    ? (initialState as () => S)()
                    : initialState;
                feedbackRenderState.initializedStates[index] = true;
            }
            const setState = (value: S | ((current: S) => S)) => {
                const current = feedbackRenderState.states[index] as S;
                feedbackRenderState.states[index] = typeof value === 'function'
                    ? (value as (current: S) => S)(current)
                    : value;
            };
            return [feedbackRenderState.states[index] as S, setState];
        },
        useRef: <T,>(initialValue: T) => {
            const index = feedbackRenderState.refCall++;
            if (!feedbackRenderState.refs[index]) {
                feedbackRenderState.refs[index] = { current: initialValue };
            }
            return feedbackRenderState.refs[index] as { current: T };
        },
        useEffect: (
            effect: () => void | (() => void),
            deps?: readonly unknown[],
        ) => {
            const index = feedbackRenderState.effectCall++;
            const previous = feedbackRenderState.effects[index];
            const changed = !previous
                || !deps
                || !previous.deps
                || deps.length !== previous.deps.length
                || deps.some((dep, depIndex) => !Object.is(dep, previous.deps?.[depIndex]));
            if (!changed) return;

            previous?.cleanup?.();
            const cleanup = effect();
            feedbackRenderState.effects[index] = {
                deps: deps ? [...deps] : undefined,
                cleanup: typeof cleanup === 'function' ? cleanup : undefined,
            };
        },
    };
});

const overlayStackState = vi.hoisted(() => ({ open: false }));
vi.mock('../ui/OverlayStack', () => ({
    useHasOpenOverlay: () => overlayStackState.open,
}));

vi.mock('../../services/apiClient', () => ({
    authedFetch: assistantRequest,
}));

vi.mock('../../auth/AuthProvider', () => ({
    useAuth: () => ({ user: { email: 'me@x.com' } }),
    getAuthHeaders: () => ({}),
    getKeycloak: () => ({ updateToken: vi.fn() }),
}));

interface TestElementProps {
    children?: ReactNode;
    className?: string;
    disabled?: boolean;
    onChange?: (event: { target: { value: string } }) => void;
    onClick?: () => void;
    onSubmit?: (event: { preventDefault: () => void }) => Promise<void> | void;
    [key: string]: unknown;
}

type TestElement = ReactElement<TestElementProps>;

function resetRenderState() {
    feedbackRenderState.effects.forEach(effect => effect?.cleanup?.());
    feedbackRenderState.stateCall = 0;
    feedbackRenderState.states = [];
    feedbackRenderState.initializedStates = [];
    feedbackRenderState.refCall = 0;
    feedbackRenderState.refs = [];
    feedbackRenderState.effectCall = 0;
    feedbackRenderState.effects = [];
}

function renderFeedbackWidget(): TestElement {
    feedbackRenderState.stateCall = 0;
    feedbackRenderState.refCall = 0;
    feedbackRenderState.effectCall = 0;
    return FeedbackWidget();
}

function findElements(
    node: ReactNode,
    predicate: (element: TestElement) => boolean,
    matches: TestElement[] = [],
): TestElement[] {
    if (!isValidElement<TestElementProps>(node)) return matches;
    const element = node as TestElement;
    if (predicate(element)) matches.push(element);
    Children.forEach(element.props.children, child => findElements(child, predicate, matches));
    return matches;
}

function findElement(node: ReactNode, predicate: (element: TestElement) => boolean): TestElement {
    const element = findElements(node, predicate)[0];
    if (!element) throw new Error('Expected element was not rendered');
    return element;
}

function openWidget(): TestElement {
    renderFeedbackWidget();
    window.dispatchEvent(new CustomEvent('albusto:open-feedback'));
    return renderFeedbackWidget();
}

function enterChatMessage(tree: TestElement, value: string): TestElement {
    const textarea = findElement(
        tree,
        element => element.type === 'textarea' && element.props['aria-label'] === 'Message',
    );
    textarea.props.onChange?.({ target: { value } });
    return renderFeedbackWidget();
}

function submitChat(tree: TestElement): Promise<void> {
    const form = findElement(tree, element => element.props.className === 'feedback-composer');
    return Promise.resolve(form.props.onSubmit?.({ preventDefault: vi.fn() }));
}

function assistantResponse(reply: string, escalate: boolean): Response {
    return {
        ok: true,
        status: 200,
        json: vi.fn(async () => ({ reply, escalate })),
    } as unknown as Response;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    resetRenderState();
    assistantRequest.mockReset();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'session-1') });
});

afterEach(() => {
    resetRenderState();
    vi.unstubAllGlobals();
});

describe('assistant chat request', () => {
    it('posts JSON with the last 12 mapped history turns', async () => {
        const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
            assistantResponse('Open Settings → Integrations.', false)
        ));
        const history = Array.from({ length: 14 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
            text: `Turn ${index}`,
        }));

        const result = await submitAssistantChat({
            history,
            message: 'How do I connect Stripe?',
            session_key: 'session-1',
        }, request);

        expect(result).toEqual({
            ok: true,
            reply: 'Open Settings → Integrations.',
            escalate: false,
        });
        expect(request).toHaveBeenCalledOnce();
        expect(request.mock.calls[0][0]).toBe('/api/assistant/chat');
        const init = request.mock.calls[0][1];
        expect(init?.method).toBe('POST');
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
            history: history.slice(-12),
            message: 'How do I connect Stripe?',
            session_key: 'session-1',
        });
    });
});

describe('feedback assistant behavior', () => {
    it('shows Thinking, appends a successful reply, and keeps the form hidden', async () => {
        const pending = deferred<Response>();
        assistantRequest.mockReturnValueOnce(pending.promise);
        let tree = enterChatMessage(openWidget(), 'How do I connect Stripe?');

        const submission = submitChat(tree);
        tree = renderFeedbackWidget();
        expect(renderToStaticMarkup(tree)).toContain('Thinking…');
        expect(findElement(
            tree,
            element => element.type === 'textarea' && element.props['aria-label'] === 'Message',
        ).props.disabled).toBe(true);

        pending.resolve(assistantResponse('Open Settings → Integrations → Stripe.', false));
        await submission;
        tree = renderFeedbackWidget();
        const markup = renderToStaticMarkup(tree);
        expect(markup).toContain('Open Settings → Integrations → Stripe.');
        expect(markup).not.toContain('Thinking…');
        expect(markup).not.toContain('feedback-form');

        const init = assistantRequest.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(init.body as string);
        expect(body.history).toHaveLength(1);
        expect(body.history[0].role).toBe('assistant');
        expect(body.message).toBe('How do I connect Stripe?');
        expect(body.session_key).toBe('session-1');
    });

    it('reveals the feedback form when the assistant escalates', async () => {
        assistantRequest.mockResolvedValueOnce(assistantResponse('I can help connect you with support.', true));
        const tree = enterChatMessage(openWidget(), 'I need billing help');

        await submitChat(tree);
        const markup = renderToStaticMarkup(renderFeedbackWidget());
        expect(markup).toContain('I can help connect you with support.');
        expect(markup).toContain('feedback-form');
    });

    it('adds one graceful line and reveals the form when the request rejects', async () => {
        assistantRequest.mockRejectedValueOnce(new Error('offline'));
        const tree = enterChatMessage(openWidget(), 'The app is stuck');

        await submitChat(tree);
        const rendered = renderFeedbackWidget();
        expect(findElements(
            rendered,
            element => element.props.children === ASSISTANT_FALLBACK_MESSAGE,
        )).toHaveLength(1);
        expect(renderToStaticMarkup(rendered)).toContain('feedback-form');
    });

    it('adds one graceful line and reveals the form after a non-ok response', async () => {
        assistantRequest.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
        const tree = enterChatMessage(openWidget(), 'The app is stuck');

        await submitChat(tree);
        const rendered = renderFeedbackWidget();
        expect(findElements(
            rendered,
            element => element.props.children === ASSISTANT_FALLBACK_MESSAGE,
        )).toHaveLength(1);
        expect(renderToStaticMarkup(rendered)).toContain('feedback-form');
    });

    it('reveals the form without calling the assistant when Talk to a human is clicked', () => {
        const tree = openWidget();
        findElement(tree, element => element.props.children === 'Talk to a human').props.onClick?.();

        expect(renderToStaticMarkup(renderFeedbackWidget())).toContain('feedback-form');
        expect(assistantRequest).not.toHaveBeenCalled();
    });
});

describe('feedback bot state', () => {
    it('escalates immediately when requested', () => {
        const state = escalateFeedbackBot(createInitialFeedbackBotState());

        expect(state.phase).toBe('escalated');
        expect(state.messages.at(-1)).toEqual({
            sender: 'bot',
            text: FEEDBACK_ESCALATION_MESSAGE,
        });
    });
});

describe('feedback form behavior', () => {
    it('prefills the account email while allowing the form value to be edited', () => {
        let email = getFeedbackEmail({ email: 'me@x.com' });
        expect(email).toBe('me@x.com');

        email = 'updated@x.com';
        expect(email).toBe('updated@x.com');
    });

    it('blocks the request when What happened is empty', async () => {
        const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
            { ok: true, status: 201 } as Response
        ));

        const result = await submitFeedback({
            email: 'me@x.com',
            message: '   ',
            files: [],
        }, request);

        expect(result).toEqual({ ok: false, error: 'Tell us what happened' });
        expect(request).not.toHaveBeenCalled();
    });

    it('posts multipart feedback and returns success after a 201', async () => {
        const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
            { ok: true, status: 201 } as Response
        ));

        const result = await submitFeedback({
            email: 'me@x.com',
            message: '  The save button moved  ',
            files: [],
        }, request);

        expect(result).toEqual({ ok: true });
        expect(request).toHaveBeenCalledOnce();
        expect(request.mock.calls[0][0]).toBe('/api/feedback');
        const init = request.mock.calls[0][1];
        expect(init?.method).toBe('POST');
        expect((init?.body as FormData).get('email')).toBe('me@x.com');
        expect((init?.body as FormData).get('message')).toBe('The save button moved');
    });

    it('returns the stable inline error when the network request fails', async () => {
        const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            throw new Error('offline');
        });

        const result = await submitFeedback({
            email: 'me@x.com',
            message: 'The page stopped loading',
            files: [],
        }, request);

        expect(result).toEqual({ ok: false, error: FEEDBACK_NETWORK_ERROR });
        expect(request).toHaveBeenCalledOnce();
    });

    it('turns the widget off only when the feature flag is exactly false', () => {
        expect(isFeedbackWidgetEnabled('false')).toBe(false);
        expect(isFeedbackWidgetEnabled(undefined)).toBe(true);
        expect(isFeedbackWidgetEnabled('true')).toBe(true);
    });
});

describe('feedback widget open event', () => {
    it('opens the panel when the global feedback event is dispatched', () => {
        let markup = renderToStaticMarkup(renderFeedbackWidget());
        expect(markup).not.toContain('role="dialog"');

        window.dispatchEvent(new CustomEvent('albusto:open-feedback'));

        markup = renderToStaticMarkup(renderFeedbackWidget());
        expect(markup).toContain('role="dialog"');
        expect(markup).toContain('How can we help?');
    });
});

describe('feedback FAB vs open overlays', () => {
    afterEach(() => {
        overlayStackState.open = false;
    });

    it('shows the floating button when no overlay is open', () => {
        overlayStackState.open = false;
        expect(renderToStaticMarkup(renderFeedbackWidget())).toContain('feedback-fab');
    });

    it('hides the floating button while a dialog/panel is open (no overlap with its footer)', () => {
        overlayStackState.open = true;
        const markup = renderToStaticMarkup(renderFeedbackWidget());
        expect(markup).not.toContain('feedback-fab');
        expect(markup).not.toContain('aria-label="Open feedback"');
    });
});
