import { useEffect, useState } from 'react';

export function useDebouncedSearch(value: string, delayMs: number): string {
    const normalized = value.trim();
    const [debounced, setDebounced] = useState(normalized);

    useEffect(() => {
        if (!normalized) {
            setDebounced('');
            return;
        }

        const timer = window.setTimeout(() => setDebounced(normalized), delayMs);
        return () => window.clearTimeout(timer);
    }, [delayMs, normalized]);

    return debounced;
}
