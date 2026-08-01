import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
    realtimeOptions: null as {
        onMessageAdded?: () => void;
        onConversationUpdated?: () => void;
        onMessageDelivery?: () => void;
    } | null,
}));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    };
});

vi.mock('../hooks/useRealtimeEvents', () => ({
    useRealtimeEvents: (options: typeof hookState.realtimeOptions) => {
        hookState.realtimeOptions = options;
    },
}));

import { useMessagesRealtime } from './useMessagesRealtime';

beforeEach(() => {
    hookState.realtimeOptions = null;
});

describe('useMessagesRealtime invalidation refetch contract', () => {
    it.each(['onMessageAdded', 'onConversationUpdated', 'onMessageDelivery'] as const)(
        '%s refetches the scoped list and currently selected conversation',
        async (callbackName) => {
            const refetchConversations = vi.fn().mockResolvedValue(undefined);
            const refetchMessages = vi.fn().mockResolvedValue(undefined);

            useMessagesRealtime('conversation-own', refetchConversations, refetchMessages);
            hookState.realtimeOptions?.[callbackName]?.();

            expect(refetchConversations).toHaveBeenCalledTimes(1);
            expect(refetchMessages).toHaveBeenCalledWith('conversation-own');
        },
    );

    it('does not derive a conversation id from the stripped event payload', () => {
        const refetchConversations = vi.fn().mockResolvedValue(undefined);
        const refetchMessages = vi.fn().mockResolvedValue(undefined);

        useMessagesRealtime(null, refetchConversations, refetchMessages);
        hookState.realtimeOptions?.onMessageAdded?.();

        expect(refetchConversations).toHaveBeenCalledTimes(1);
        expect(refetchMessages).not.toHaveBeenCalled();
    });
});
