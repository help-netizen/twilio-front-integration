export interface CursorPagination {
    mode: 'cursor';
    limit: number;
    returned: number;
    has_more: boolean;
    next_cursor: string | null;
    total: number | null;
}

export interface CursorPage<T, TMeta = never> {
    items: T[];
    pagination: CursorPagination;
    meta: TMeta | null;
}

export type LoadMoreState =
    | 'idle-with-more'
    | 'loading-more'
    | 'all-loaded'
    | 'error+retry'
    | 'empty';

export type LoadMoreErrorPhase = 'first' | 'more' | null;

export interface CursorRequestGate {
    inFlight: Set<string>;
    succeeded: Set<string>;
}

export function createCursorRequestGate(): CursorRequestGate {
    return {
        inFlight: new Set<string>(),
        succeeded: new Set<string>(),
    };
}

export function admitCursorRequest(gate: CursorRequestGate, cursor: string): boolean {
    if (gate.inFlight.has(cursor) || gate.succeeded.has(cursor)) return false;
    gate.inFlight.add(cursor);
    return true;
}

export function completeCursorRequest(gate: CursorRequestGate, cursor: string): void {
    gate.inFlight.delete(cursor);
    gate.succeeded.add(cursor);
}

export function failCursorRequest(gate: CursorRequestGate, cursor: string): void {
    gate.inFlight.delete(cursor);
}

export function resetCursorRequestGate(gate: CursorRequestGate): void {
    gate.inFlight.clear();
    gate.succeeded.clear();
}

export function mergeCursorPages<T, TMeta>(
    pages: CursorPage<T, TMeta>[],
    getItemKey: (item: T) => string | number,
): T[] {
    const merged: T[] = [];
    const indexByKey = new Map<string | number, number>();

    for (const page of pages) {
        for (const item of page.items) {
            const key = getItemKey(item);
            const existingIndex = indexByKey.get(key);
            if (existingIndex === undefined) {
                indexByKey.set(key, merged.length);
                merged.push(item);
            } else {
                merged[existingIndex] = item;
            }
        }
    }

    return merged;
}

interface DeriveLoadMoreStateInput {
    hasFirstPage: boolean;
    loadedCount: number;
    total: number | null;
    hasMore: boolean;
    isLoadingMore: boolean;
    errorPhase: LoadMoreErrorPhase;
}

export function deriveLoadMoreState({
    hasFirstPage,
    loadedCount,
    total,
    hasMore,
    isLoadingMore,
    errorPhase,
}: DeriveLoadMoreStateInput): LoadMoreState | null {
    if (isLoadingMore) return 'loading-more';
    if (errorPhase) return 'error+retry';
    if (!hasFirstPage) return null;
    if (total === 0 || (loadedCount === 0 && !hasMore)) return 'empty';
    if (hasMore) return 'idle-with-more';
    return 'all-loaded';
}
