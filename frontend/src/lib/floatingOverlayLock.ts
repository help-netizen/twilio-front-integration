import { useSyncExternalStore } from 'react';

/**
 * FLOATING-OVERLAY-LOCK (INPUT-KBD) — keeps the layer BEHIND a floating input overlay
 * (NoteComposerOverlay / FullScreenTextEditor) perfectly still while it's open on mobile.
 *
 * The owner's mental model for these overlays is "we're on another layer — nothing under it
 * moves." Two things otherwise move the instant the keyboard opens, and both are visible
 * through the overlay's translucent scrim (the "кипишь" the owner reported):
 *
 *   1. The PAGE scrolls. Our mobile form dialogs run `modal={!isMobile}` (non-modal) so the
 *      body-portalled overlay input keeps focus and can raise the keyboard — but non-modal turns
 *      OFF Radix's scroll-lock, so iOS is free to scroll the page under the keyboard, dragging
 *      the whole background (e.g. the Pulse timeline) into view. → we lock <body> with
 *      position:fixed here (the iOS-robust technique; plain `overflow:hidden` does NOT hold on iOS)
 *      and restore the exact scroll position on release.
 *
 *   2. The HOST bottom-sheet lifts/resizes. `useSheetViewport` reacts to the keyboard via
 *      VisualViewport and raises the sheet above it — correct when one of ITS OWN fields is
 *      focused, wrong when the keyboard belongs to the floating overlay (the sheet is hidden
 *      behind it and should not budge). → `useSheetViewport` subscribes to `useFloatingOverlayActive`
 *      and freezes (geometry:null, i.e. rest) while any overlay is open.
 *
 * Ref-counted so stacked/nested overlays are safe — the lock releases only when the last closes.
 * This is a no-op on desktop: every caller gates the overlay's `open` prop on `isMobile`, so
 * push/pop never fire there.
 */

type Listener = () => void;

interface SavedBodyStyle {
    position: string;
    top: string;
    left: string;
    right: string;
    width: string;
    overflow: string;
}

let count = 0;
let scrollY = 0;
let savedBody: SavedBodyStyle | null = null;
const listeners = new Set<Listener>();

function lockBodyScroll(): void {
    if (typeof document === 'undefined') return;
    scrollY = window.scrollY;
    const s = document.body.style;
    savedBody = {
        position: s.position,
        top: s.top,
        left: s.left,
        right: s.right,
        width: s.width,
        overflow: s.overflow,
    };
    s.position = 'fixed';
    s.top = `-${scrollY}px`;
    s.left = '0';
    s.right = '0';
    s.width = '100%';
    s.overflow = 'hidden';
}

function unlockBodyScroll(): void {
    if (typeof document === 'undefined' || !savedBody) return;
    const s = document.body.style;
    s.position = savedBody.position;
    s.top = savedBody.top;
    s.left = savedBody.left;
    s.right = savedBody.right;
    s.width = savedBody.width;
    s.overflow = savedBody.overflow;
    savedBody = null;
    // Restore the scroll the fixed-lock froze (the page visually stayed put via top:-scrollY).
    window.scrollTo(0, scrollY);
}

/** Call when a floating input overlay opens. Locks background scroll + signals subscribers. */
export function pushFloatingOverlay(): void {
    count += 1;
    if (count === 1) {
        lockBodyScroll();
        listeners.forEach(fn => fn());
    }
}

/** Call when a floating input overlay closes. Releases the lock once the last one is gone. */
export function popFloatingOverlay(): void {
    if (count === 0) return;
    count -= 1;
    if (count === 0) {
        unlockBodyScroll();
        listeners.forEach(fn => fn());
    }
}

function isFloatingOverlayActive(): boolean {
    return count > 0;
}

function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** True while any floating input overlay is open. Used by useSheetViewport to freeze the host sheet. */
export function useFloatingOverlayActive(): boolean {
    return useSyncExternalStore(subscribe, isFloatingOverlayActive, () => false);
}
