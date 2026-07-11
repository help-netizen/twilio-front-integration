/**
 * Viewport / device hooks on a shared matchMedia mechanism.
 *
 * WHY matchMedia + belts instead of a bare `innerWidth` resize listener:
 * - iOS PWA cold start (standalone): the pre-paint viewport value can be
 *   wrong and NO `resize`/`change` event ever follows — a one-shot
 *   requestAnimationFrame re-check after the first painted frame snaps the
 *   hook to the true value.
 * - The `window` resize listener is kept as a belt: some engines (older iOS
 *   WebKit in standalone) have missed mql `change` on PWA viewport
 *   corrections.
 * - Landscape phones (e.g. iPhone at 932px) pass a width-only check;
 *   `useIsMobileDevice` adds a `(pointer: coarse)` OR-term so capability
 *   gating (softphone) still treats them as mobile.
 */

import { useState, useEffect } from 'react';

const DEFAULT_BREAKPOINT = 768;

/**
 * Module-private shared mechanism: reactive `matchMedia(query).matches`.
 * SSR-safe initializer (`false` on server), synchronous correction on mount,
 * `change` + `resize` listeners, and a one-shot rAF re-check (cancelled in
 * cleanup) for the iOS-standalone cold-start quirk.
 */
function useMediaQuery(query: string): boolean {
    const [isMobile, setIsMobile] = useState<boolean>(
        () => typeof window !== 'undefined' && window.matchMedia(query).matches,
    );

    useEffect(() => {
        const mql = window.matchMedia(query);
        const check = () => setIsMobile(mql.matches);
        check();
        mql.addEventListener('change', check);
        window.addEventListener('resize', check);
        // One-shot re-check after the first painted frame (never re-scheduled):
        // covers the iOS-PWA cold start where the settled viewport differs from
        // the pre-paint value and no event fires.
        const raf = requestAnimationFrame(check);
        return () => {
            mql.removeEventListener('change', check);
            window.removeEventListener('resize', check);
            cancelAnimationFrame(raf);
        };
    }, [query]);

    return isMobile;
}

/**
 * useIsMobile — reactive viewport check (width-only).
 *
 * Returns true when the viewport is narrower than the given breakpoint
 * (default 768px = Tailwind `md`), and updates on resize / orientation
 * change. Use this for behaviour that must react to viewport changes; for
 * pure styling prefer Tailwind `md:` classes. Carries NO pointer/touch term
 * — an iPad or touch laptop stays "desktop" for layout purposes.
 */
export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT): boolean {
    return useMediaQuery(`(max-width: ${breakpoint - 0.02}px)`);
}

/**
 * useIsMobileDevice — softphone capability gate ONLY.
 *
 * True when the viewport is narrow OR the primary pointer is coarse
 * (iPhone/iPad/Android — including landscape phones that pass a width-only
 * check). A touch-screen laptop with a mouse/trackpad as primary pointer
 * stays `false`, so the browser softphone keeps working there.
 *
 * GUARDRAIL: imported ONLY by `AppLayout.tsx`. Layout call-sites must keep
 * using `useIsMobile` (width-only) — do not adopt this hook for layout.
 */
export function useIsMobileDevice(): boolean {
    return useMediaQuery('(max-width: 767.98px), (pointer: coarse)');
}
