import { useEffect, useState } from 'react';

/**
 * Geometry for a fixed layer that must cover exactly the VISIBLE viewport — the area
 * left between the top of the screen and the top edge of the on-screen keyboard.
 *
 * Two iOS facts drive this, and both have already cost us a bug:
 *  - the keyboard does NOT resize the layout viewport, so a layer pinned to `bottom: 0`
 *    keeps its footer underneath the keyboard;
 *  - when the keyboard opens iOS also SHIFTS the visual viewport down
 *    (`visualViewport.offsetTop > 0`), so a layer pinned to `top: 0` (a layout-viewport
 *    coordinate) has its header pushed above the visible area and "flies off-screen"
 *    (fixed once already in FullScreenSearchPicker, hotfix 60b3f033).
 *
 * Track both live: `top` follows the visual viewport, `bottom` is the keyboard height.
 * visualViewport events are unreliable on iOS, so a slow poll backs them up — the same
 * belt used by useKeyboardInset.
 */
export interface FullScreenViewport {
    /** Distance from the layout-viewport top to the visible area's top edge. */
    top: number;
    /** Height of the on-screen keyboard (0 when it is down). */
    bottom: number;
}

export function useFullScreenViewport(active: boolean): FullScreenViewport {
    const [viewport, setViewport] = useState<FullScreenViewport>({ top: 0, bottom: 0 });

    useEffect(() => {
        if (!active || typeof window === 'undefined' || !window.visualViewport) {
            setViewport({ top: 0, bottom: 0 });
            return;
        }
        const vv = window.visualViewport;
        const read = () => setViewport({
            top: Math.max(0, vv.offsetTop),
            bottom: Math.max(0, window.innerHeight - vv.height - vv.offsetTop),
        });
        read();
        vv.addEventListener('resize', read);
        vv.addEventListener('scroll', read);
        const poll = window.setInterval(read, 250); // belt — iOS drops vv events
        return () => {
            vv.removeEventListener('resize', read);
            vv.removeEventListener('scroll', read);
            window.clearInterval(poll);
        };
    }, [active]);

    return viewport;
}
