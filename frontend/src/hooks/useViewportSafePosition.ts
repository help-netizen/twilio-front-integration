/**
 * Viewport-safe positioning utilities for custom dropdowns.
 * Clamps dropdown positions within the viewport on desktop,
 * and provides a mobile check for bottom-sheet rendering.
 */

const MOBILE_BREAKPOINT = 768;
const VIEWPORT_PADDING = 8;

/** Check if the current viewport is mobile-sized */
export function isMobileViewport(): boolean {
    return window.innerWidth < MOBILE_BREAKPOINT;
}

/** Clamp a fixed-position dropdown so it doesn't overflow the viewport */
export function clampToViewport(
    triggerRect: DOMRect,
    dropdownWidth: number,
    dropdownHeight: number,
    preferBelow = true,
): { left: number; top: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: prefer aligned to trigger left, clamp to viewport
    let left = triggerRect.left;
    if (left + dropdownWidth > vw - VIEWPORT_PADDING) {
        left = vw - dropdownWidth - VIEWPORT_PADDING;
    }
    if (left < VIEWPORT_PADDING) {
        left = VIEWPORT_PADDING;
    }

    // Vertical: prefer below trigger, flip above if no room
    let top: number;
    const spaceBelow = vh - triggerRect.bottom - VIEWPORT_PADDING;
    const spaceAbove = triggerRect.top - VIEWPORT_PADDING;

    if (preferBelow && spaceBelow >= dropdownHeight) {
        top = triggerRect.bottom + 4;
    } else if (!preferBelow && spaceAbove >= dropdownHeight) {
        top = triggerRect.top - dropdownHeight - 4;
    } else if (spaceBelow >= dropdownHeight) {
        top = triggerRect.bottom + 4;
    } else if (spaceAbove >= dropdownHeight) {
        top = triggerRect.top - dropdownHeight - 4;
    } else {
        // Not enough room either way — pin to bottom of viewport
        top = vh - dropdownHeight - VIEWPORT_PADDING;
    }

    if (top < VIEWPORT_PADDING) {
        top = VIEWPORT_PADDING;
    }

    return { left, top };
}
