import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { pulseApi } from '../services/pulseApi';
import type { PulseTimelinePageResponse, TimelinePageItem } from '../types/pulse';
import { useCallback, useEffect, useMemo, useRef } from 'react';

const KIND_RANK = {
    call: 0,
    sms: 1,
    email: 2,
    estimate: 3,
    invoice: 4,
} as const;

type TimelineKind = keyof typeof KIND_RANK;

const DIGIT_ID_RE = /^\d+$/;

function kindAndId(item: TimelinePageItem): { kind: TimelineKind; id: string } {
    if (item.src !== 'financial') return { kind: item.src, id: item.id };
    if (item.id.startsWith('invoice-')) {
        return { kind: 'invoice', id: item.id.slice('invoice-'.length) };
    }
    return { kind: 'estimate', id: item.id.slice('estimate-'.length) };
}

function compareIdsDesc(left: string, right: string): number {
    if (DIGIT_ID_RE.test(left) && DIGIT_ID_RE.test(right)) {
        if (left.length !== right.length) return left.length > right.length ? -1 : 1;
        if (left === right) return 0;
        return left > right ? -1 : 1;
    }

    const normalizedLeft = left.toLowerCase();
    const normalizedRight = right.toLowerCase();
    if (normalizedLeft === normalizedRight) return 0;
    return normalizedLeft > normalizedRight ? -1 : 1;
}

function compareDesc(left: TimelinePageItem, right: TimelinePageItem): number {
    if (left.ts !== right.ts) return left.ts > right.ts ? -1 : 1;

    const leftKindAndId = kindAndId(left);
    const rightKindAndId = kindAndId(right);
    const rankDifference = KIND_RANK[leftKindAndId.kind] - KIND_RANK[rightKindAndId.kind];
    if (rankDifference !== 0) return rankDifference < 0 ? -1 : 1;

    return compareIdsDesc(leftKindAndId.id, rightKindAndId.id);
}

function unionByKey(freshItems: TimelinePageItem[], existingItems: TimelinePageItem[]): TimelinePageItem[] {
    const seen = new Set<string>();
    const items: TimelinePageItem[] = [];

    for (const item of [...freshItems, ...existingItems]) {
        const identity = `${item.src}:${item.id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        items.push(item);
    }

    return items.sort(compareDesc);
}

/**
 * Hook: combined timeline (calls + SMS) for a contact or timeline.
 * Supports both contactId (legacy) and timelineId (new).
 *
 * React Query passes an AbortSignal to queryFn — when the user switches
 * timelines rapidly, the previous in-flight request is automatically cancelled.
 */
export const usePulseTimeline = (contactId: number, timelineId?: number) => {
    const queryClient = useQueryClient();
    const mode = timelineId ? 'timeline' : 'contact';
    const key = timelineId || contactId;
    const refreshInFlightRef = useRef<Promise<void> | null>(null);

    const query = useInfiniteQuery({
        queryKey: ['pulse-timeline', mode, key],
        queryFn: ({ pageParam, signal }) =>
            pulseApi.getTimelinePage({ mode, key, before: pageParam ?? undefined, signal }),
        initialPageParam: null as string | null,
        getNextPageParam: (lastPage) => lastPage.page.has_more
            ? lastPage.page.next_cursor
            : undefined,
        enabled: !!key,
        staleTime: 30000,
    });

    useEffect(() => {
        refreshInFlightRef.current = null;
    }, [mode, key]);

    const items = useMemo(() => {
        const seen = new Set<string>();
        const loadedItems: TimelinePageItem[] = [];

        for (const page of query.data?.pages || []) {
            for (const item of page.page.items) {
                const identity = `${item.src}:${item.id}`;
                if (seen.has(identity)) continue;
                seen.add(identity);
                loadedItems.push(item);
            }
        }

        return loadedItems.sort(compareDesc).reverse();
    }, [query.data?.pages]);

    const calls = useMemo(
        () => items.filter(item => item.src === 'call').map(item => item.data),
        [items],
    );
    const messages = useMemo(
        () => items.filter(item => item.src === 'sms').map(item => item.data),
        [items],
    );
    const emailMessages = useMemo(
        () => items.filter(item => item.src === 'email').map(item => item.data),
        [items],
    );
    const financialEvents = useMemo(
        () => items.filter(item => item.src === 'financial').map(item => item.data),
        [items],
    );
    const meta = useMemo(() => query.data?.pages?.[0]?.meta, [query.data?.pages]);

    const refreshNewestPage = useCallback((): Promise<void> => {
        if (refreshInFlightRef.current) return refreshInFlightRef.current;

        let refreshPromise: Promise<void> | null = null;
        refreshPromise = (async () => {
            try {
                const fresh = await pulseApi.getTimelinePage({ mode, key });
                queryClient.setQueryData<InfiniteData<PulseTimelinePageResponse, string | null>>(
                    ['pulse-timeline', mode, key],
                    (old) => {
                        if (!old || old.pages.length === 0) {
                            return { pages: [fresh], pageParams: [null] };
                        }

                        const oldHead = old.pages[0];
                        const newHead: PulseTimelinePageResponse = {
                            page: {
                                items: unionByKey(fresh.page.items, oldHead.page.items),
                                next_cursor: oldHead.page.next_cursor,
                                has_more: oldHead.page.has_more,
                            },
                            meta: fresh.meta ?? oldHead.meta,
                        };

                        return { ...old, pages: [newHead, ...old.pages.slice(1)] };
                    },
                );
            } catch (error) {
                console.warn('[Pulse] Failed to refresh newest timeline page:', error);
            } finally {
                if (refreshInFlightRef.current === refreshPromise) {
                    refreshInFlightRef.current = null;
                }
            }
        })();

        refreshInFlightRef.current = refreshPromise;
        return refreshPromise;
    }, [queryClient, mode, key]);

    return {
        items,
        calls,
        messages,
        emailMessages,
        financialEvents,
        meta,
        isLoading: query.isLoading,
        isError: query.isError,
        fetchOlder: query.fetchNextPage,
        hasOlder: !!query.hasNextPage,
        isFetchingOlder: query.isFetchingNextPage,
        refreshNewestPage,
    };
};
