/**
 * useIsMobile — reactive viewport check.
 *
 * Returns true when the viewport is narrower than the given breakpoint
 * (default 768px = Tailwind `md`), and updates on resize / orientation change.
 * Use this for behaviour that must react to viewport changes; for pure styling
 * prefer Tailwind `md:` classes.
 */

import { useState, useEffect } from 'react';

const DEFAULT_BREAKPOINT = 768;

export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT): boolean {
    const [isMobile, setIsMobile] = useState<boolean>(
        () => typeof window !== 'undefined' && window.innerWidth < breakpoint,
    );

    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth < breakpoint);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, [breakpoint]);

    return isMobile;
}
