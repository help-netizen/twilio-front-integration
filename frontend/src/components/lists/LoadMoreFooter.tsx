import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LoadMoreErrorPhase, LoadMoreState } from '@/hooks/useLoadMoreList';

export interface LoadMoreFooterProps {
    state: LoadMoreState | null;
    loadedCount: number;
    totalCount: number | null;
    singularLabel: string;
    pluralLabel: string;
    errorPhase: LoadMoreErrorPhase;
    onLoadMore(): void;
    onRetry(): void;
}

function labelFor(count: number, singularLabel: string, pluralLabel: string): string {
    return count === 1 ? singularLabel : pluralLabel;
}

export function LoadMoreFooter({
    state,
    loadedCount,
    totalCount,
    singularLabel,
    pluralLabel,
    errorPhase,
    onLoadMore,
    onRetry,
}: LoadMoreFooterProps) {
    if (state === null || state === 'empty') return null;

    const knownTotal = totalCount ?? loadedCount;
    const noun = labelFor(knownTotal, singularLabel, pluralLabel);
    const countCopy = state === 'all-loaded'
        ? `All ${knownTotal} ${noun} loaded`
        : `${loadedCount} of ${knownTotal} ${noun} loaded`;
    const isLoading = state === 'loading-more';
    const isError = state === 'error+retry';

    return (
        <div className="flex flex-wrap items-center justify-center gap-3 py-4 text-sm text-[var(--blanc-ink-2)]">
            {!(isError && errorPhase === 'first') && <span>{countCopy}</span>}
            {isError && (
                <span role="alert" className="text-[var(--blanc-danger)]">
                    {errorPhase === 'more'
                        ? `Couldn't load more ${pluralLabel}.`
                        : `Couldn't load ${pluralLabel}.`}
                </span>
            )}
            {state === 'idle-with-more' || isLoading ? (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isLoading}
                    onClick={onLoadMore}
                >
                    {isLoading && <Loader2 className="animate-spin" />}
                    {isLoading ? 'Loading…' : 'Load more'}
                </Button>
            ) : isError ? (
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                    {errorPhase === 'more' ? 'Retry load more' : 'Retry'}
                </Button>
            ) : null}
        </div>
    );
}
