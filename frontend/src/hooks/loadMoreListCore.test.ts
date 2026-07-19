import { describe, expect, it } from 'vitest';
import {
    admitCursorRequest,
    completeCursorRequest,
    createCursorRequestGate,
    deriveLoadMoreState,
    failCursorRequest,
    mergeCursorPages,
    resetCursorRequestGate,
    type CursorPage,
} from './loadMoreListCore';

interface Item {
    id: number;
    value: string;
}

function page(items: Item[]): CursorPage<Item, { source: string }> {
    return {
        items,
        pagination: {
            mode: 'cursor',
            limit: 2,
            returned: items.length,
            has_more: true,
            next_cursor: 'next',
            total: 4,
        },
        meta: { source: 'first' },
    };
}

describe('loadMoreListCore', () => {
    it('derives the five manual footer states and leaves first loading page-owned', () => {
        const base = {
            hasFirstPage: true,
            loadedCount: 2,
            total: 4,
            hasMore: true,
            isLoadingMore: false,
            errorPhase: null,
        } as const;

        expect(deriveLoadMoreState({ ...base, hasFirstPage: false })).toBeNull();
        expect(deriveLoadMoreState(base)).toBe('idle-with-more');
        expect(deriveLoadMoreState({ ...base, isLoadingMore: true })).toBe('loading-more');
        expect(deriveLoadMoreState({ ...base, isLoadingMore: true, errorPhase: 'more' })).toBe('loading-more');
        expect(deriveLoadMoreState({ ...base, hasMore: false })).toBe('all-loaded');
        expect(deriveLoadMoreState({ ...base, errorPhase: 'more' })).toBe('error+retry');
        expect(deriveLoadMoreState({
            ...base,
            loadedCount: 0,
            total: 0,
            hasMore: false,
        })).toBe('empty');
    });

    it('keeps first-seen order while replacing duplicate values in place', () => {
        const result = mergeCursorPages([
            page([{ id: 1, value: 'old' }, { id: 2, value: 'two' }]),
            page([{ id: 2, value: 'new' }, { id: 3, value: 'three' }]),
        ], item => item.id);

        expect(result).toEqual([
            { id: 1, value: 'old' },
            { id: 2, value: 'new' },
            { id: 3, value: 'three' },
        ]);
    });

    it('admits one request per cursor, releases failures, and clears generations', () => {
        const gate = createCursorRequestGate();

        expect(admitCursorRequest(gate, 'cursor-a')).toBe(true);
        expect(admitCursorRequest(gate, 'cursor-a')).toBe(false);
        failCursorRequest(gate, 'cursor-a');
        expect(admitCursorRequest(gate, 'cursor-a')).toBe(true);
        completeCursorRequest(gate, 'cursor-a');
        expect(admitCursorRequest(gate, 'cursor-a')).toBe(false);

        resetCursorRequestGate(gate);
        expect(admitCursorRequest(gate, 'cursor-a')).toBe(true);
    });
});
