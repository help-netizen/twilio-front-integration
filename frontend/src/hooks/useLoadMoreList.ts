import {
    useInfiniteQuery,
    useQueryClient,
    type InfiniteData,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    admitCursorRequest,
    completeCursorRequest,
    createCursorRequestGate,
    deriveLoadMoreState,
    failCursorRequest,
    mergeCursorPages,
    resetCursorRequestGate,
    type CursorPage,
    type LoadMoreErrorPhase,
    type LoadMoreState,
} from './loadMoreListCore';

export type {
    CursorPage,
    CursorPagination,
    LoadMoreErrorPhase,
    LoadMoreState,
} from './loadMoreListCore';

interface UseLoadMoreListOptions<T, TMeta> {
    queryKey: readonly unknown[];
    pageSize: number;
    enabled?: boolean;
    fetchPage(args: {
        cursor: string | null;
        limit: number;
        signal: AbortSignal;
    }): Promise<CursorPage<T, TMeta>>;
    getItemKey(item: T): string | number;
}

export interface UseLoadMoreListResult<T, TMeta> {
    items: T[];
    total: number | null;
    meta: TMeta | null;
    state: LoadMoreState | null;
    hasMore: boolean;
    error: Error | null;
    errorPhase: LoadMoreErrorPhase;
    isLoadingFirst: boolean;
    isFetching: boolean;
    loadMore(): Promise<void>;
    retry(): Promise<void>;
    reset(): Promise<void>;
    updateItem(key: string | number, update: (item: T) => T): void;
}

export function useLoadMoreList<T, TMeta = never>({
    queryKey,
    pageSize,
    enabled = true,
    fetchPage,
    getItemKey,
}: UseLoadMoreListOptions<T, TMeta>): UseLoadMoreListResult<T, TMeta> {
    const queryClient = useQueryClient();
    const keyFingerprint = JSON.stringify(queryKey);
    const stableQueryKey = useMemo(() => queryKey, [keyFingerprint]);
    const activeKeyRef = useRef(keyFingerprint);
    const generationRef = useRef(0);
    const requestGateRef = useRef(createCursorRequestGate());

    if (activeKeyRef.current !== keyFingerprint) {
        activeKeyRef.current = keyFingerprint;
        generationRef.current += 1;
        resetCursorRequestGate(requestGateRef.current);
    }

    const query = useInfiniteQuery<
        CursorPage<T, TMeta>,
        Error,
        InfiniteData<CursorPage<T, TMeta>, string | null>,
        readonly unknown[],
        string | null
    >({
        queryKey: stableQueryKey,
        initialPageParam: null,
        queryFn: async ({ pageParam, signal }) => {
            const requestGeneration = generationRef.current;
            const result = await fetchPage({
                cursor: pageParam,
                limit: pageSize,
                signal,
            });

            if (
                requestGeneration !== generationRef.current
                || activeKeyRef.current !== keyFingerprint
            ) {
                throw new DOMException('Stale list generation', 'AbortError');
            }

            return result;
        },
        getNextPageParam: lastPage => (
            lastPage.pagination.has_more && lastPage.pagination.next_cursor
                ? lastPage.pagination.next_cursor
                : undefined
        ),
        enabled,
        retry: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
    });

    useEffect(() => {
        const keyToCancel = stableQueryKey;
        return () => {
            void queryClient.cancelQueries({ queryKey: keyToCancel, exact: true });
        };
    }, [queryClient, stableQueryKey]);

    const pages = query.data?.pages ?? [];
    const items = useMemo(
        () => mergeCursorPages(pages, getItemKey),
        [pages, getItemKey],
    );
    const firstPage = pages[0];
    const lastPage = pages[pages.length - 1];
    const total = firstPage?.pagination.total ?? null;
    const meta = firstPage?.meta ?? null;
    const hasMore = !!(
        lastPage?.pagination.has_more
        && lastPage.pagination.next_cursor
    );
    const errorPhase: LoadMoreErrorPhase = query.isFetchNextPageError
        ? 'more'
        : query.isError
            ? 'first'
            : null;

    const loadMore = useCallback(async (): Promise<void> => {
        const currentPages = query.data?.pages ?? [];
        const currentLastPage = currentPages[currentPages.length - 1];
        const cursor = currentLastPage?.pagination.next_cursor;
        if (!currentLastPage?.pagination.has_more || !cursor) return;
        if (!admitCursorRequest(requestGateRef.current, cursor)) return;

        const requestGeneration = generationRef.current;
        try {
            const result = await query.fetchNextPage({ cancelRefetch: false });
            if (result.isError) throw result.error;
            if (requestGeneration !== generationRef.current) {
                failCursorRequest(requestGateRef.current, cursor);
                return;
            }
            completeCursorRequest(requestGateRef.current, cursor);
        } catch {
            failCursorRequest(requestGateRef.current, cursor);
        }
    }, [query]);

    const retry = useCallback(async (): Promise<void> => {
        if (errorPhase === 'more') {
            await loadMore();
            return;
        }
        await query.refetch({ cancelRefetch: false });
    }, [errorPhase, loadMore, query]);

    const reset = useCallback(async (): Promise<void> => {
        generationRef.current += 1;
        resetCursorRequestGate(requestGateRef.current);
        await queryClient.cancelQueries({ queryKey: stableQueryKey, exact: true });
        await queryClient.resetQueries({ queryKey: stableQueryKey, exact: true });
    }, [queryClient, stableQueryKey]);

    const updateItem = useCallback((
        key: string | number,
        update: (item: T) => T,
    ): void => {
        queryClient.setQueryData<InfiniteData<CursorPage<T, TMeta>, string | null>>(
            stableQueryKey,
            old => {
                if (!old) return old;
                return {
                    ...old,
                    pages: old.pages.map(page => ({
                        ...page,
                        items: page.items.map(item => (
                            getItemKey(item) === key ? update(item) : item
                        )),
                    })),
                };
            },
        );
    }, [getItemKey, queryClient, stableQueryKey]);

    const state: LoadMoreState | null = deriveLoadMoreState({
        hasFirstPage: pages.length > 0,
        loadedCount: items.length,
        total,
        hasMore,
        isLoadingMore: query.isFetchingNextPage,
        errorPhase,
    });

    return {
        items,
        total,
        meta,
        state,
        hasMore,
        error: query.error,
        errorPhase,
        isLoadingFirst: enabled && query.isLoading && pages.length === 0,
        isFetching: query.isFetching,
        loadMore,
        retry,
        reset,
        updateItem,
    };
}
