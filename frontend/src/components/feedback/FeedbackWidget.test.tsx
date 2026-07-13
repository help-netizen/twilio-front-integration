import { describe, expect, it, vi } from 'vitest';
import {
    FEEDBACK_ESCALATION_MESSAGE,
    FEEDBACK_NETWORK_ERROR,
    advanceFeedbackBot,
    createInitialFeedbackBotState,
    escalateFeedbackBot,
    getFeedbackEmail,
    isFeedbackWidgetEnabled,
    submitFeedback,
} from './FeedbackWidget';

describe('feedback bot state machine', () => {
    it('escalates immediately when the user asks to talk to a human', () => {
        const state = escalateFeedbackBot(createInitialFeedbackBotState());

        expect(state.phase).toBe('escalated');
        expect(state.messages.at(-1)).toEqual({
            sender: 'bot',
            text: FEEDBACK_ESCALATION_MESSAGE,
        });
    });

    it('moves from greeting to chatting and escalates after two bot replies', () => {
        const firstReply = advanceFeedbackBot(createInitialFeedbackBotState(), 'The schedule is confusing');
        const secondReply = advanceFeedbackBot(firstReply, 'It happens when I switch days');

        expect(firstReply.phase).toBe('chatting');
        expect(firstReply.botReplies).toBe(1);
        expect(secondReply.phase).toBe('escalated');
        expect(secondReply.botReplies).toBe(2);
        expect(secondReply.messages.at(-1)?.text).toBe(FEEDBACK_ESCALATION_MESSAGE);
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
